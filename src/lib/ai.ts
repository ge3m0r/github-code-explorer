import { GoogleGenAI, Type } from '@google/genai';
import { getSettings } from './settings';

const geminiModel = 'gemini-3-flash-preview';

function getAiRuntimeConfig() {
  const settings = getSettings();
  const aiApiKey = settings.aiApiKey;
  const aiBaseUrl = settings.aiBaseUrl?.trim();
  const isOpenAI = !!aiBaseUrl;
  const openAIModel = (settings.aiModel || 'deepseek-chat').trim();
  return { aiApiKey, aiBaseUrl, isOpenAI, openAIModel };
}

function createAiClient() {
  const { aiApiKey, aiBaseUrl } = getAiRuntimeConfig();
  return new GoogleGenAI({
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
}

async function openAIChatCompletion(
  prompt: string,
): Promise<{ text: string; request: unknown; response: unknown }> {
  const { aiBaseUrl, aiApiKey, openAIModel } = getAiRuntimeConfig();
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
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  if (!res.ok) {
    const errMsg = data?.error?.message || res.statusText || String(res.status);
    throw new Error(`OpenAI API error: ${errMsg}`);
  }

  return {
    text: data?.choices?.[0]?.message?.content ?? '{}',
    request: body,
    response: data,
  };
}

export interface AiAnalysisResult {
  projectSummary: string;
  mainLanguage: string;
  techStack: string[];
  entryFiles: string[];
  verifiedEntryFile?: string;
  verifiedEntryReason?: string;
}

export interface AiUsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiCallDetails {
  request: unknown;
  response: unknown;
  usage?: AiUsageStats;
  provider?: 'openai' | 'gemini';
  model?: string;
}

export interface EntryFileVerificationResult {
  isEntryFile: boolean;
  reason: string;
}

export interface NodeAttribute {
  label: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning';
}

export interface BridgeAnalysisInfo {
  strategyId: string;
  label: string;
  framework: string;
  reason?: string;
}

export interface SubFunction {
  name: string;
  description: string;
  file: string;
  drillDown: number;
  children?: SubFunction[];
  stopReason?: string;
  startLine?: number;
  endLine?: number;
  kind?: string;
  attributes?: NodeAttribute[];
  routeLabels?: string[];
}

export interface SubFunctionAnalysisResult {
  entryFunctionName: string;
  subFunctions: SubFunction[];
  entryFile?: string;
  entryStartLine?: number;
  entryEndLine?: number;
  entryDescription?: string;
  entryAttributes?: NodeAttribute[];
  analysisMode?: 'entry' | 'bridge';
  bridge?: BridgeAnalysisInfo;
}

export interface RawFunctionModule {
  name: string;
  description: string;
  functions: Array<{
    name: string;
    file: string;
  }>;
}

export interface FunctionModule {
  id: string;
  name: string;
  description: string;
  color: string;
  functions: Array<{
    name: string;
    file: string;
    description: string;
  }>;
}

export interface ModuleAnalysisResult {
  modules: FunctionModule[];
}

export interface ModuleAssignmentCandidate {
  name: string;
  file: string;
  description: string;
  snippet?: string;
  parentName?: string;
  parentFile?: string;
}

export interface IncrementalModuleAssignmentResult {
  existingAssignments: Array<{
    name: string;
    file: string;
    moduleId: string;
  }>;
  newModules: RawFunctionModule[];
}

export interface PickBestEntryResult {
  bestEntryFile: string;
  reason: string;
}

function truncateLargeContent(content: string, maxLines = 4000) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }

  const headSize = Math.floor(maxLines / 2);
  const tailSize = maxLines - headSize;
  const first = lines.slice(0, headSize).join('\n');
  const last = lines.slice(-tailSize).join('\n');
  return `${first}\n\n... [中间省略 ${lines.length - maxLines} 行] ...\n\n${last}`;
}

function normalizeUsageStats(inputTokens: number, outputTokens: number, totalTokens?: number): AiUsageStats {
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
  };
}

function extractOpenAIUsage(response: any): AiUsageStats | undefined {
  const usage = response?.usage;
  if (!usage) {
    return undefined;
  }

  return normalizeUsageStats(
    Number(usage.prompt_tokens) || 0,
    Number(usage.completion_tokens) || 0,
    Number(usage.total_tokens) || undefined,
  );
}

function extractGeminiUsage(response: any): AiUsageStats | undefined {
  const usage = response?.usageMetadata;
  if (!usage) {
    return undefined;
  }

  return normalizeUsageStats(
    Number(usage.promptTokenCount) || 0,
    Number(usage.candidatesTokenCount) || 0,
    Number(usage.totalTokenCount) || undefined,
  );
}

function buildAiDetails(
  request: unknown,
  response: unknown,
  provider: 'openai' | 'gemini',
  usage?: AiUsageStats,
): AiCallDetails {
  const { openAIModel } = getAiRuntimeConfig();
  return {
    request,
    response,
    usage,
    provider,
    model: provider === 'openai' ? openAIModel : geminiModel,
  };
}

async function runStructuredJsonPrompt<T>(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<{ parsedResult: T; details: AiCallDetails }> {
  const { isOpenAI } = getAiRuntimeConfig();
  let text = '{}';
  let requestPayload: unknown;
  let rawResponse: unknown;

  if (isOpenAI) {
    const out = await openAIChatCompletion(prompt);
    text = out.text;
    requestPayload = out.request;
    rawResponse = out.response;
  } else {
    const ai = createAiClient();
    const request = {
      model: geminiModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    };
    const response = await ai.models.generateContent(request);
    text = response.text || '{}';
    requestPayload = request;
    rawResponse = response;
  }

  let parsedResult = {} as T;
  try {
    parsedResult = JSON.parse(text) as T;
  } catch (error) {
    console.error('Failed to parse AI response', error);
  }

  return {
    parsedResult,
    details: buildAiDetails(
      requestPayload,
      parsedResult,
      isOpenAI ? 'openai' : 'gemini',
      isOpenAI ? extractOpenAIUsage(rawResponse) : extractGeminiUsage(rawResponse),
    ),
  };
}

function buildKeySubFunctionRules(maxCount: number) {
  return `
分析要求：
1. 只返回真正影响主流程的关键调用，例如核心业务决策、跨模块协作、数据库或缓存访问、消息队列、网络请求、文件读写、任务编排、权限校验、事务控制、重要状态变更。
2. 不要返回常规数据结构操作、字符串操作、序列化或反序列化、日志打印、简单判空、类型转换、格式化、getter/setter、构造函数、工具函数、标准库调用、集合遍历、map/filter/reduce/sort 等非关键调用。
3. 如果某个调用只是为了准备参数、转换字段、组装字符串、遍历数组、读写局部变量或做简单封装，不要返回。
4. 只返回当前函数直接调用的关键子函数，不要返回间接推断的调用。
5. 对面向对象语言，如果函数或方法定义在类中，name 和 entryFunctionName 都必须返回 "ClassName::methodName"；普通函数才返回 "functionName"。
6. drillDown 仅用于判断是否值得继续分析：1 表示关键且值得下钻，0 表示不确定，-1 表示无需下钻。
7. 最多返回 ${maxCount} 个关键子函数；如果没有明显关键调用，返回空数组。
`.trim();
}

function normalizeNodeAttributes(value: unknown): NodeAttribute[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = item as Record<string, unknown>;
      if (typeof record.label !== 'string' || !record.label.trim()) {
        return null;
      }

      const normalizedTone =
        record.tone === 'neutral' || record.tone === 'info' || record.tone === 'success' || record.tone === 'warning'
          ? record.tone
          : undefined;

      return {
        label: record.label.trim(),
        ...(normalizedTone ? { tone: normalizedTone } : {}),
      } as NodeAttribute;
    })
    .filter((item): item is NodeAttribute => item !== null);
}

function normalizeSubFunctions(value: unknown): SubFunction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : '',
      description: typeof record.description === 'string' ? record.description : '',
      file: typeof record.file === 'string' ? record.file : '',
      drillDown: typeof record.drillDown === 'number' ? record.drillDown : 0,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      attributes: normalizeNodeAttributes(record.attributes),
    } satisfies SubFunction;
  });
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: Type.OBJECT,
    properties,
    required,
  };
}

export async function verifyEntryFile(
  repoUrl: string,
  projectSummary: string,
  mainLanguage: string,
  filePath: string,
  fileContent: string,
  allFiles: string[],
): Promise<{ result: EntryFileVerificationResult; details: AiCallDetails }> {
  const prompt = `请判断下面文件是否是该项目的真实入口文件。
项目信息：
- GitHub 链接: ${repoUrl}
- 项目简介: ${projectSummary}
- 编程语言: ${mainLanguage}
- 当前研判文件路径: ${filePath}
- 项目文件列表（部分）:
${allFiles.slice(0, 1000).join('\n')}

文件内容：
\`\`\`
${truncateLargeContent(fileContent)}
\`\`\`

请只返回 JSON，字段如下：
- isEntryFile: boolean，表示它是否是入口文件
- reason: string，简短说明原因`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        isEntryFile: {
          type: Type.BOOLEAN,
          description: 'Whether the file is the main entry file of the project.',
        },
        reason: {
          type: Type.STRING,
          description: 'The reason for the judgment.',
        },
      },
      ['isEntryFile', 'reason'],
    ),
  );

  return {
    result: {
      isEntryFile: !!parsedResult.isEntryFile,
      reason: (parsedResult.reason as string) || '解析失败',
    },
    details,
  };
}

export async function analyzeProject(
  files: string[],
): Promise<{ result: AiAnalysisResult; details: AiCallDetails }> {
  const prompt = `以下是一个 GitHub 仓库的代码和配置文件列表：

${files.join('\n')}

请基于这些文件路径和名称，使用中文分析并只返回 JSON：
1. projectSummary: 简要概述这个项目的主要功能和用途。
2. mainLanguage: 项目使用的主要编程语言。
3. techStack: 技术栈标签列表，例如 React、Express、Spring Boot、Webpack、Docker。
4. entryFiles: 最可能的入口文件列表，例如 src/index.ts、main.go、App.tsx、cmd/main.go。`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        projectSummary: {
          type: Type.STRING,
          description: "A brief summary of the project's purpose and main features.",
        },
        mainLanguage: {
          type: Type.STRING,
          description: 'The primary programming language used in the project.',
        },
        techStack: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of technology stack tags.',
        },
        entryFiles: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of possible main entry files.',
        },
      },
      ['projectSummary', 'mainLanguage', 'techStack', 'entryFiles'],
    ),
  );

  return {
    result: {
      projectSummary: (parsedResult.projectSummary as string) || '未知',
      mainLanguage: (parsedResult.mainLanguage as string) || 'Unknown',
      techStack: Array.isArray(parsedResult.techStack) ? (parsedResult.techStack as string[]) : [],
      entryFiles: Array.isArray(parsedResult.entryFiles) ? (parsedResult.entryFiles as string[]) : [],
    },
    details,
  };
}

export async function analyzeSubFunctions(
  projectSummary: string,
  filePath: string,
  fileContent: string,
  allFiles: string[],
): Promise<{ result: SubFunctionAnalysisResult; details: AiCallDetails }> {
  const settings = getSettings();
  const maxCount = settings.maxKeySubFunctionsPerLayer || 10;
  const prompt = `请分析以下项目入口文件，识别其中的主入口函数，以及它调用的关键子函数。
项目简介: ${projectSummary}
当前文件路径: ${filePath}
项目文件列表（部分）:
${allFiles.slice(0, 1000).join('\n')}

文件内容：
\`\`\`
${truncateLargeContent(fileContent)}
\`\`\`

${buildKeySubFunctionRules(maxCount)}

请只返回 JSON，结构如下：
{
  "entryFunctionName": "入口函数名，若是类方法则返回 ClassName::methodName",
  "subFunctions": [
    {
      "name": "关键子函数名，若是类方法则返回 ClassName::methodName",
      "description": "函数作用简介",
      "file": "可能定义所在文件；无法确定可填 未知 或当前文件",
      "drillDown": -1 | 0 | 1
    }
  ]
}`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        entryFunctionName: {
          type: Type.STRING,
          description: 'The name of the main entry function in the file.',
        },
        subFunctions: {
          type: Type.ARRAY,
          items: objectSchema(
            {
              name: { type: Type.STRING, description: 'Sub-function name' },
              description: { type: Type.STRING, description: 'Brief description of the sub-function' },
              file: { type: Type.STRING, description: 'The file where this sub-function is likely defined' },
              drillDown: {
                type: Type.INTEGER,
                description: 'Whether it is worth drilling down (-1: no, 0: unsure, 1: yes)',
              },
            },
            ['name', 'description', 'file', 'drillDown'],
          ),
          description: 'List of key sub-functions called by the entry function.',
        },
      },
      ['entryFunctionName', 'subFunctions'],
    ),
  );

  return {
    result: {
      entryFunctionName: (parsedResult.entryFunctionName as string) || '未知入口函数',
      subFunctions: normalizeSubFunctions(parsedResult.subFunctions).slice(0, maxCount),
    },
    details,
  };
}

export async function pickBestEntryFile(
  repoUrl: string,
  projectSummary: string,
  mainLanguage: string,
  candidates: Array<{ filePath: string; content: string }>,
  allFiles: string[],
): Promise<{ result: PickBestEntryResult; details: AiCallDetails }> {
  const candidateBlocks = candidates
    .map(
      ({ filePath, content }) =>
        `## 候选文件路径: ${filePath}\n\`\`\`\n${truncateLargeContent(content)}\n\`\`\``,
    )
    .join('\n\n');

  const prompt = `请从以下多个候选文件中，对比后选出最可能是项目入口的一个文件，并说明原因。
项目信息：
- GitHub 链接: ${repoUrl}
- 项目简介: ${projectSummary}
- 编程语言: ${mainLanguage}
- 项目文件列表（部分）:
${allFiles.slice(0, 1000).join('\n')}

以下是候选入口文件及其内容：
${candidateBlocks}

请只返回 JSON：
- bestEntryFile: 你选中的文件路径，必须来自上面的候选路径
- reason: 简短说明原因`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        bestEntryFile: { type: Type.STRING, description: 'The chosen entry file path.' },
        reason: { type: Type.STRING, description: 'Why this file is the best entry candidate.' },
      },
      ['bestEntryFile', 'reason'],
    ),
  );

  return {
    result: {
      bestEntryFile: (parsedResult.bestEntryFile as string) || candidates[0]?.filePath || '',
      reason: (parsedResult.reason as string) || '对比后选出的最可能入口',
    },
    details,
  };
}

export async function suggestFilesForFunction(
  projectSummary: string,
  callerFilePath: string,
  functionName: string,
  allFiles: string[],
): Promise<{ result: { possibleFiles: string[] }; details: AiCallDetails }> {
  const prompt = `请根据项目文件列表和函数名，推测该函数最可能定义在哪些文件中。
项目简介: ${projectSummary}
调用该函数的文件路径: ${callerFilePath}
待查找的函数名: ${functionName}

项目文件列表（部分）:
${allFiles.slice(0, 800).join('\n')}

请只返回 JSON：
- possibleFiles: 字符串数组，最多 5 个，必须从上面的文件列表中选择，按可能性从高到低排序。`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        possibleFiles: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Possible file paths where the function is defined.',
        },
      },
      ['possibleFiles'],
    ),
  );

  return {
    result: {
      possibleFiles: Array.isArray(parsedResult.possibleFiles)
        ? (parsedResult.possibleFiles as string[]).filter((item): item is string => typeof item === 'string')
        : [],
    },
    details,
  };
}

export async function analyzeFunctionSnippet(
  projectSummary: string,
  functionName: string,
  snippet: string,
  resolvedFilePath: string,
  allFiles: string[],
): Promise<{ result: SubFunctionAnalysisResult; details: AiCallDetails }> {
  const settings = getSettings();
  const maxCount = settings.maxKeySubFunctionsPerLayer || 10;
  const prompt = `请分析以下函数代码片段，识别该函数调用的关键子函数。
项目简介: ${projectSummary}
当前函数名: ${functionName}
该函数所在文件路径: ${resolvedFilePath}
项目文件列表（部分）:
${allFiles.slice(0, 500).join('\n')}

函数代码片段：
\`\`\`
${snippet.slice(0, 12000)}
\`\`\`

${buildKeySubFunctionRules(maxCount)}

请只返回 JSON：
- entryFunctionName: 当前函数名，保持 ${functionName} 的命名格式
- subFunctions: 数组，每项包含 name、description、file、drillDown`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        entryFunctionName: { type: Type.STRING },
        subFunctions: {
          type: Type.ARRAY,
          items: objectSchema(
            {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              file: { type: Type.STRING },
              drillDown: { type: Type.INTEGER },
            },
            ['name', 'description', 'file', 'drillDown'],
          ),
        },
      },
      ['entryFunctionName', 'subFunctions'],
    ),
  );

  return {
    result: {
      entryFunctionName: (parsedResult.entryFunctionName as string) || functionName,
      subFunctions: normalizeSubFunctions(parsedResult.subFunctions).slice(0, maxCount),
    },
    details,
  };
}

export async function analyzeFunctionModules(
  projectSummary: string,
  mainLanguage: string,
  techStack: string[],
  functions: Array<{ name: string; file: string; description: string }>,
): Promise<{ result: { modules: RawFunctionModule[] }; details: AiCallDetails }> {
  const prompt = `你需要基于一个项目的整体信息和完整函数清单，对函数进行功能模块划分。
项目简介: ${projectSummary}
主要语言: ${mainLanguage}
技术栈: ${techStack.join(', ') || 'unknown'}

函数列表(JSON)：
\`\`\`json
${JSON.stringify(functions, null, 2)}
\`\`\`

要求：
1. 从整体功能出发划分模块，模块数量不超过 9 个。
2. 每个函数必须且只能归入一个模块。
3. 模块名称简洁明确，模块说明使用中文。
4. 只能使用上面函数列表里已有的 name 和 file，不能编造。
5. 只返回 JSON，结构如下：
{
  "modules": [
    {
      "name": "模块名称",
      "description": "模块说明",
      "functions": [
        { "name": "函数名", "file": "文件路径" }
      ]
    }
  ]
}`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        modules: {
          type: Type.ARRAY,
          items: objectSchema(
            {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              functions: {
                type: Type.ARRAY,
                items: objectSchema(
                  {
                    name: { type: Type.STRING },
                    file: { type: Type.STRING },
                  },
                  ['name', 'file'],
                ),
              },
            },
            ['name', 'description', 'functions'],
          ),
        },
      },
      ['modules'],
    ),
  );

  return {
    result: {
      modules: Array.isArray(parsedResult.modules)
        ? (parsedResult.modules as Array<Record<string, unknown>>).map((module) => ({
            name: (module.name as string) ?? '',
            description: (module.description as string) ?? '',
            functions: Array.isArray(module.functions)
              ? (module.functions as Array<Record<string, unknown>>).map((item) => ({
                  name: (item.name as string) ?? '',
                  file: (item.file as string) ?? '',
                }))
              : [],
          }))
        : [],
    },
    details,
  };
}

export async function assignFunctionsToExistingOrNewModules(
  projectSummary: string,
  mainLanguage: string,
  techStack: string[],
  existingModules: FunctionModule[],
  newFunctions: ModuleAssignmentCandidate[],
): Promise<{ result: IncrementalModuleAssignmentResult; details: AiCallDetails }> {
  const existingModuleBlocks = existingModules
    .map(
      (module) => `## Existing Module
- moduleId: ${module.id}
- name: ${module.name}
- description: ${module.description}
- functions:
${module.functions.map((fn) => `  - ${fn.name} (${fn.file})`).join('\n') || '  - none'}`,
    )
    .join('\n\n');

  const newFunctionBlocks = newFunctions
    .map(
      (fn) => `## New Function
- name: ${fn.name}
- file: ${fn.file}
- description: ${fn.description}
- parentName: ${fn.parentName || 'unknown'}
- parentFile: ${fn.parentFile || 'unknown'}
- snippet:
\`\`\`
${(fn.snippet || 'No snippet available').slice(0, 4000)}
\`\`\``,
    )
    .join('\n\n');

  const prompt = `你需要基于一个项目当前已有的模块划分结果，将“手动下钻新增”的函数节点做增量归类。

项目摘要: ${projectSummary}
主要语言: ${mainLanguage}
技术栈: ${techStack.join(', ') || 'unknown'}

要求：
1. 不要重排或重命名已有模块。
2. 每个新增函数必须且只能归类一次。
3. 如果某个新增函数明显属于已有模块，请放入 existingAssignments。
4. 只有当所有已有模块都不合适时，才创建 newModules。
5. newModules 只包含真正需要新增的模块。
6. moduleId 必须来自已有模块列表。
7. 只返回 JSON。

已有模块如下：
${existingModuleBlocks || 'none'}

新增函数如下：
${newFunctionBlocks}

JSON 结构如下：
{
  "existingAssignments": [
    {
      "name": "函数名",
      "file": "文件路径",
      "moduleId": "已有模块ID"
    }
  ],
  "newModules": [
    {
      "name": "新模块名称",
      "description": "新模块说明",
      "functions": [
        {
          "name": "函数名",
          "file": "文件路径"
        }
      ]
    }
  ]
}`;

  const { parsedResult, details } = await runStructuredJsonPrompt<Record<string, unknown>>(
    prompt,
    objectSchema(
      {
        existingAssignments: {
          type: Type.ARRAY,
          items: objectSchema(
            {
              name: { type: Type.STRING },
              file: { type: Type.STRING },
              moduleId: { type: Type.STRING },
            },
            ['name', 'file', 'moduleId'],
          ),
        },
        newModules: {
          type: Type.ARRAY,
          items: objectSchema(
            {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              functions: {
                type: Type.ARRAY,
                items: objectSchema(
                  {
                    name: { type: Type.STRING },
                    file: { type: Type.STRING },
                  },
                  ['name', 'file'],
                ),
              },
            },
            ['name', 'description', 'functions'],
          ),
        },
      },
      ['existingAssignments', 'newModules'],
    ),
  );

  return {
    result: {
      existingAssignments: Array.isArray(parsedResult.existingAssignments)
        ? (parsedResult.existingAssignments as Array<Record<string, unknown>>).map((item) => ({
            name: (item.name as string) ?? '',
            file: (item.file as string) ?? '',
            moduleId: (item.moduleId as string) ?? '',
          }))
        : [],
      newModules: Array.isArray(parsedResult.newModules)
        ? (parsedResult.newModules as Array<Record<string, unknown>>).map((module) => ({
            name: (module.name as string) ?? '',
            description: (module.description as string) ?? '',
            functions: Array.isArray(module.functions)
              ? (module.functions as Array<Record<string, unknown>>).map((item) => ({
                  name: (item.name as string) ?? '',
                  file: (item.file as string) ?? '',
                }))
              : [],
          }))
        : [],
    },
    details,
  };
}
