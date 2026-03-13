import { GoogleGenAI, Type } from '@google/genai';

// 统一从环境变量读取 AI 配置：api_key 必填，base_url 可选（不填则用 Gemini 默认端点）
const aiApiKey = process.env.AI_API_KEY || process.env.GEMINI_API_KEY;
const aiBaseUrl = process.env.AI_BASE_URL?.trim();
// 设置了 base_url 时走 OpenAI 兼容格式（如 DeepSeek）；未设置时走 Gemini
const isOpenAI = !!aiBaseUrl;
const openAIModel = (process.env.AI_MODEL || 'deepseek-chat').trim();

const ai = new GoogleGenAI({
  apiKey: aiApiKey,
  ...(aiBaseUrl
    ? {
        httpOptions: {
          baseUrl: aiBaseUrl,
          ...(aiApiKey ? { headers: { Authorization: `Bearer ${aiApiKey}` } } : {}),
        },
      }
    : {}),
});

/** OpenAI 兼容接口：POST /chat/completions，返回 content 与原始 request/response 供 details 使用 */
async function openAIChatCompletion(
  prompt: string
): Promise<{ text: string; request: unknown; response: unknown }> {
  const url = `${aiBaseUrl!.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: openAIModel,
    messages: [{ role: 'user' as const, content: prompt }],
    response_format: { type: 'json_object' as const },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aiApiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    const errMsg = data?.error?.message || res.statusText || String(res.status);
    throw new Error(`OpenAI API error: ${errMsg}`);
  }
  const text = data?.choices?.[0]?.message?.content ?? '{}';
  return { text, request: body, response: data };
}

export interface AiAnalysisResult {
  projectSummary: string;
  mainLanguage: string;
  techStack: string[];
  entryFiles: string[];
  verifiedEntryFile?: string;
  verifiedEntryReason?: string;
}

export interface AiCallDetails {
  request: any;
  response: any;
}

export interface EntryFileVerificationResult {
  isEntryFile: boolean;
  reason: string;
}

export async function verifyEntryFile(
  repoUrl: string,
  projectSummary: string,
  mainLanguage: string,
  filePath: string,
  fileContent: string,
  allFiles: string[]
): Promise<{ result: EntryFileVerificationResult, details: AiCallDetails }> {
  const lines = fileContent.split('\n');
  let contentToSend = fileContent;
  if (lines.length > 4000) {
    const first2000 = lines.slice(0, 2000).join('\n');
    const last2000 = lines.slice(-2000).join('\n');
    contentToSend = `${first2000}\n\n... [中间省略 ${lines.length - 4000} 行] ...\n\n${last2000}`;
  }

  const prompt = `请研判以下文件是否是该项目的真实入口文件。

项目信息：
- GitHub 链接: ${repoUrl}
- 项目简介: ${projectSummary}
- 编程语言: ${mainLanguage}
- 当前研判文件路径: ${filePath}
- 项目包含的文件列表（部分）:
${allFiles.slice(0, 1000).join('\n')}

文件内容：
\`\`\`
${contentToSend}
\`\`\`

请根据以上信息，判断该文件是否是项目的入口文件，并给出理由。请以 JSON 格式返回。`;

  let text: string;
  let requestPayload: unknown;
  let parsedResponse: unknown;

  if (isOpenAI) {
    const out = await openAIChatCompletion(prompt);
    text = out.text;
    requestPayload = out.request;
    parsedResponse = out.response;
  } else {
    const request = {
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isEntryFile: {
              type: Type.BOOLEAN,
              description: "Whether the file is the main entry file of the project."
            },
            reason: {
              type: Type.STRING,
              description: "The reason for the judgment."
            }
          },
          required: ["isEntryFile", "reason"]
        }
      }
    };
    const response = await ai.models.generateContent(request);
    text = response.text || '{}';
    requestPayload = request;
    parsedResponse = response;
  }

  let parsedResult: Record<string, unknown> = {};
  try {
    parsedResult = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    console.error("Failed to parse AI response", e);
  }

  const result: EntryFileVerificationResult = {
    isEntryFile: !!parsedResult.isEntryFile,
    reason: (parsedResult.reason as string) || '解析失败'
  };

  return {
    result,
    details: {
      request: requestPayload,
      response: parsedResult
    }
  };
}

export async function analyzeProject(files: string[]): Promise<{ result: AiAnalysisResult, details: AiCallDetails }> {
  const prompt = `以下是一个 GitHub 仓库的代码和配置文件列表：\n\n${files.join('\n')}\n\n基于这些文件路径和名称，请分析该项目并提供以下信息（请务必使用中文回答）：\n1. 简要概述这个项目的主要功能和用途 (projectSummary)。\n2. 项目使用的主要编程语言。\n3. 技术栈标签列表（例如：React, Express, Spring Boot, Webpack, Docker 等）。\n4. 可能的主入口文件列表（例如：src/index.js, main.c, App.tsx, cmd/main.go）。\n请以 JSON 格式返回，包含字段：projectSummary, mainLanguage, techStack, entryFiles。`;

  let text: string;
  let requestPayload: unknown;
  let parsedResponse: unknown;

  if (isOpenAI) {
    const out = await openAIChatCompletion(prompt);
    text = out.text;
    requestPayload = out.request;
    parsedResponse = out.response;
  } else {
    const request = {
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            projectSummary: {
              type: Type.STRING,
              description: "A brief summary of the project's purpose and main features."
            },
            mainLanguage: {
              type: Type.STRING,
              description: "The primary programming language used in the project."
            },
            techStack: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "List of technology stack tags."
            },
            entryFiles: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "List of possible main entry files."
            }
          },
          required: ["projectSummary", "mainLanguage", "techStack", "entryFiles"]
        }
      }
    };
    const response = await ai.models.generateContent(request);
    text = response.text || '{}';
    requestPayload = request;
    parsedResponse = response;
  }

  let parsedResult: Record<string, unknown> = {};
  try {
    parsedResult = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    console.error("Failed to parse AI response", e);
  }

  const result: AiAnalysisResult = {
    projectSummary: (parsedResult.projectSummary as string) || '未知',
    mainLanguage: (parsedResult.mainLanguage as string) || 'Unknown',
    techStack: Array.isArray(parsedResult.techStack) ? (parsedResult.techStack as string[]) : [],
    entryFiles: Array.isArray(parsedResult.entryFiles) ? (parsedResult.entryFiles as string[]) : []
  };

  return {
    result,
    details: {
      request: requestPayload,
      response: parsedResult
    }
  };
}

export interface SubFunction {
  name: string;
  description: string;
  file: string;
  drillDown: number;
}

export interface SubFunctionAnalysisResult {
  entryFunctionName: string;
  subFunctions: SubFunction[];
}

export async function analyzeSubFunctions(
  projectSummary: string,
  filePath: string,
  fileContent: string,
  allFiles: string[]
): Promise<{ result: SubFunctionAnalysisResult, details: AiCallDetails }> {
  const lines = fileContent.split('\n');
  let contentToSend = fileContent;
  if (lines.length > 4000) {
    const first2000 = lines.slice(0, 2000).join('\n');
    const last2000 = lines.slice(-2000).join('\n');
    contentToSend = `${first2000}\n\n... [中间省略 ${lines.length - 4000} 行] ...\n\n${last2000}`;
  }

  const prompt = `请分析以下项目入口文件，识别其中的主入口函数，以及它调用的关键子函数（数量不超过20个）。

项目简介: ${projectSummary}
当前文件路径: ${filePath}
项目包含的文件列表（部分）:
${allFiles.slice(0, 1000).join('\n')}

文件内容：
\`\`\`
${contentToSend}
\`\`\`

请根据以上信息，识别：
1. 主入口函数的名称 (entryFunctionName)。
2. 该入口函数调用的关键子函数列表 (subFunctions)。对于每个子函数，请提供：
   - name: 函数名
   - description: 函数功能简介
   - file: 根据项目文件列表和上下文，推测该函数可能定义在哪个文件中（如果无法确定，可以填 "未知" 或当前文件名）。
   - drillDown: 是否值得进一步下钻分析（-1表示不需要，0表示不确定，1表示需要）。

请以 JSON 格式返回。返回结构为：{ "entryFunctionName": "函数名", "subFunctions": [ { "name", "description", "file", "drillDown" } ] }。`;

  let text: string;
  let requestPayload: unknown;
  let parsedResponse: unknown;

  if (isOpenAI) {
    const out = await openAIChatCompletion(prompt);
    text = out.text;
    requestPayload = out.request;
    parsedResponse = out.response;
  } else {
    const request = {
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            entryFunctionName: {
              type: Type.STRING,
              description: "The name of the main entry function in the file."
            },
            subFunctions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Sub-function name" },
                  description: { type: Type.STRING, description: "Brief description of the sub-function" },
                  file: { type: Type.STRING, description: "The file where this sub-function is likely defined" },
                  drillDown: { type: Type.INTEGER, description: "Whether it is worth drilling down (-1: no, 0: unsure, 1: yes)" }
                },
                required: ["name", "description", "file", "drillDown"]
              },
              description: "List of key sub-functions called by the entry function (max 20)."
            }
          },
          required: ["entryFunctionName", "subFunctions"]
        }
      }
    };
    const response = await ai.models.generateContent(request);
    text = response.text || '{}';
    requestPayload = request;
    parsedResponse = response;
  }

  let parsedResult: Record<string, unknown> = {};
  try {
    parsedResult = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    console.error("Failed to parse AI response", e);
  }

  const rawSub = parsedResult.subFunctions;
  const subFunctions: SubFunction[] = Array.isArray(rawSub)
    ? (rawSub as Record<string, unknown>[]).map((s) => ({
        name: (s.name as string) ?? '',
        description: (s.description as string) ?? '',
        file: (s.file as string) ?? '',
        drillDown: typeof s.drillDown === 'number' ? s.drillDown : 0,
      }))
    : [];

  const result: SubFunctionAnalysisResult = {
    entryFunctionName: (parsedResult.entryFunctionName as string) || '未知入口函数',
    subFunctions,
  };

  return {
    result,
    details: {
      request: requestPayload,
      response: parsedResult
    }
  };
}
