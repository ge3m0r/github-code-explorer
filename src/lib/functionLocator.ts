/**
 * 在源码中定位函数定义并提取代码片段。
 * 使用多语言常见的函数定义正则，支持三阶段定位策略中的同文件搜索与项目搜索。
 */

export interface LocateResult {
  found: boolean;
  startLine: number;
  endLine: number;
  snippet: string;
  resolvedFile?: string;
}

/** 常见编程语言中“函数名”定义形式的正则片段（不含函数名本身）。用于拼接 \b<name>\b 得到完整正则 */
const FUNCTION_DEF_PATTERNS: string[] = [
  // JavaScript/TypeScript: function name(, name = (/, name(, async name(, name: function(
  '(?:async\\s+)?function\\s+',  // function name(, async function name(
  '(?:async\\s+)?(?:const|let|var)\\s+',  // const name = ( or = async (
  '(?:public|private|protected|static|async)\\s+',  // modifiers then name(
  '\\s*[:=]\\s*(?:async\\s*)?\\(',  // : function( or = (
  '\\s*\\(\\s*\\)\\s*=>',  // () =>
  '\\s*\\([^)]*\\)\\s*=>',  // (x) =>
  // Python: def name(
  'def\\s+',
  // Java/C#/C++/C: name(  (name 前可能有修饰符，已在上面)
  '(?:void|int|string|bool|char|double|float|long|short)\\s+',
  // Go: func name( or func (r *T) name(
  'func\\s+(?:\\([^)]+\\)\\s+)?',
  // Rust: fn name(
  'fn\\s+',
  // Ruby: def name
  'def\\s+',
  // PHP: function name(
  'function\\s+',
  // Kotlin: fun name(
  'fun\\s+',
  // Swift: func name(
  'func\\s+',
];

/** 构建用于匹配“某函数名”定义的正则（单词边界 + 名称 + 可选空白 + 左括号或 =） */
function buildDefinitionRegex(functionName: string): RegExp {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePart = `\\b${escaped}\\b`;
  const prefixAlternatives = FUNCTION_DEF_PATTERNS.join('|');
  const re = new RegExp(
    `(?:${prefixAlternatives})${namePart}\\s*[\\(=]|${namePart}\\s*\\(`,
    'gi'
  );
  return re;
}

/** 根据扩展名选择块结束策略：大括号匹配或缩进（Python 等） */
function getFileStyle(filePath: string): 'brace' | 'indent' {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (['py', 'rb', 'yml', 'yaml'].includes(ext)) return 'indent';
  return 'brace';
}

/** 从 startLine 起找函数体结束行（0-based）。大括号语言：匹配 { }；缩进语言：找下一行缩进小于等于起始行 */
function findBodyEnd(lines: string[], startLine: number, filePath: string): number {
  const style = getFileStyle(filePath);
  const startContent = lines[startLine];
  if (style === 'brace') {
    const openBraces = (startContent.match(/{/g) || []).length - (startContent.match(/}/g) || []).length;
    let depth = openBraces;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/{/g) || []).length;
      const closes = (line.match(/}/g) || []).length;
      depth += opens - closes;
      if (depth <= 0) return i;
    }
    return Math.min(startLine + 500, lines.length - 1);
  }
  const baseIndent = (startContent.match(/^(\s*)/)?.[1] || '').length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = (line.match(/^(\s*)/)?.[1] || '').length;
    if (indent <= baseIndent) return i - 1;
  }
  return Math.min(startLine + 500, lines.length - 1);
}

/**
 * 在给定文件内容中定位函数定义并提取片段。
 * @param content 文件全文
 * @param functionName 函数名
 * @param filePath 文件路径（用于选择 brace/indent 策略）
 */
export function locateInFile(
  content: string,
  functionName: string,
  filePath: string = ''
): LocateResult {
  const lines = content.split(/\r?\n/);
  const re = buildDefinitionRegex(functionName);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (match) {
      const endLine = findBodyEnd(lines, i, filePath);
      const snippet = lines.slice(i, endLine + 1).join('\n');
      return {
        found: true,
        startLine: i + 1,
        endLine: endLine + 1,
        snippet,
      };
    }
  }
  return {
    found: false,
    startLine: 0,
    endLine: 0,
    snippet: '',
  };
}

/** 判断函数名是否像系统/库函数（简单启发式：常见前缀或无项目路径） */
export function looksLikeSystemOrLibrary(functionName: string, resolvedFile: string): boolean {
  const name = functionName.toLowerCase();
  const sysPrefixes = ['console.', 'log', 'print', 'printf', 'malloc', 'free', 'require', 'import', 'window.', 'document.', 'fetch', 'settimeout', 'setinterval', 'parseint', 'parsefloat', 'json.', 'array.', 'object.', 'string.', 'number.', 'math.', 'date.', 'promise.', 'map', 'filter', 'reduce', 'foreach', 'then', 'catch'];
  if (sysPrefixes.some(p => name === p || name.startsWith(p + '.'))) return true;
  if (/^(node_modules|vendor|\.venv)\//.test(resolvedFile) || resolvedFile === '未知') return true;
  return false;
}

export type FetchContentFn = (filePath: string) => Promise<string>;

/**
 * 三阶段定位：1) 同文件 2) AI 建议文件 3) 项目内正则搜索。
 * @param functionName 函数名
 * @param parentFilePath 上级调用所在文件
 * @param suggestedFiles AI 建议的可能文件列表
 * @param allCodeFiles 项目代码文件路径列表
 * @param fetchContent 根据路径拉取文件内容的异步函数
 */
export async function locateFunctionInProject(
  functionName: string,
  parentFilePath: string,
  suggestedFiles: string[],
  allCodeFiles: string[],
  fetchContent: FetchContentFn
): Promise<LocateResult & { resolvedFile?: string }> {
  const tried = new Set<string>();

  const tryFile = async (filePath: string): Promise<LocateResult | null> => {
    if (tried.has(filePath)) return null;
    tried.add(filePath);
    try {
      const content = await fetchContent(filePath);
      const loc = locateInFile(content, functionName, filePath);
      if (loc.found) return { ...loc, resolvedFile: filePath };
    } catch {
      // 忽略单文件拉取失败，继续下一阶段
    }
    return null;
  };

  // 阶段 1：同文件
  const phase1 = await tryFile(parentFilePath);
  if (phase1) return { ...phase1, resolvedFile: parentFilePath };

  // 阶段 2：AI 建议的文件（且需在 allCodeFiles 内或可访问）
  for (const p of suggestedFiles) {
    const path = p.trim();
    if (!path || path === '未知') continue;
    const r = await tryFile(path);
    if (r) return { ...r, resolvedFile: r.resolvedFile ?? path };
  }

  // 阶段 3：在项目代码文件中正则搜索
  for (const filePath of allCodeFiles) {
    if (tried.has(filePath)) continue;
    const r = await tryFile(filePath);
    if (r) return { ...r, resolvedFile: r.resolvedFile ?? filePath };
  }

  return {
    found: false,
    startLine: 0,
    endLine: 0,
    snippet: '',
  };
}
