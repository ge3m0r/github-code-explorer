export interface LocateResult {
  found: boolean;
  startLine: number;
  endLine: number;
  snippet: string;
  resolvedFile?: string;
}

export type FetchContentFn = (filePath: string) => Promise<string>;

interface QualifiedFunctionName {
  className?: string;
  functionName: string;
}

const METHOD_MODIFIERS =
  '(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|export|default|readonly|get|set|sealed|partial|extern|inline|constexpr|mutating|nonmutating|open|suspend|class)\\s+)*';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitQualifiedFunctionName(input: string): QualifiedFunctionName {
  const trimmed = input.trim();
  const parts = trimmed.split('::').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      className: parts.slice(0, -1).join('::'),
      functionName: parts[parts.length - 1],
    };
  }

  return { functionName: trimmed };
}

function getFileStyle(filePath: string): 'brace' | 'indent' {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return ['py', 'rb', 'yml', 'yaml'].includes(ext) ? 'indent' : 'brace';
}

function buildDefinitionRegex(functionName: string): RegExp {
  const escaped = escapeRegex(functionName);
  const patterns = [
    `^\\s*(?:export\\s+default\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`,
    `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*[:=].*(?:=>|function\\b)`,
    `^\\s*${escaped}\\s*[:=].*(?:=>|function\\b)`,
    `^\\s*def\\s+${escaped}\\s*\\(`,
    `^\\s*func\\s+(?:\\([^)]+\\)\\s+)?${escaped}\\s*\\(`,
    `^\\s*fn\\s+${escaped}\\s*\\(`,
    `^\\s*fun\\s+${escaped}\\s*\\(`,
    `^\\s*function\\s+${escaped}\\s*\\(`,
    `^\\s*${METHOD_MODIFIERS}${escaped}\\s*\\(`,
    `^\\s*${METHOD_MODIFIERS}(?:[A-Za-z_][\\w:<>,\\[\\]\\?\\.&*\\s]+\\s+)+${escaped}\\s*\\(`,
  ];

  return new RegExp(patterns.join('|'), 'i');
}

function buildQualifiedDefinitionRegex(className: string, functionName: string): RegExp {
  return new RegExp(`\\b${escapeRegex(className)}\\s*::\\s*${escapeRegex(functionName)}\\s*\\(`, 'i');
}

function buildClassRegex(className: string): RegExp {
  const escaped = escapeRegex(className);
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:abstract\\s+|final\\s+)?(?:class|struct|interface|trait|object)\\s+${escaped}\\b`,
    'i',
  );
}

function findBodyEnd(lines: string[], startLine: number, filePath: string): number {
  const style = getFileStyle(filePath);

  if (style === 'brace') {
    let depth = 0;
    let started = false;

    for (let i = startLine; i < lines.length; i += 1) {
      const line = lines[i];
      const opens = (line.match(/{/g) || []).length;
      const closes = (line.match(/}/g) || []).length;
      if (opens > 0) {
        started = true;
      }
      depth += opens - closes;
      if (started && depth <= 0 && i > startLine) {
        return i;
      }
    }

    return Math.min(startLine + 500, lines.length - 1);
  }

  const baseIndent = (lines[startLine].match(/^(\s*)/)?.[1] || '').length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || '').length;
    if (indent <= baseIndent) {
      return i - 1;
    }
  }

  return Math.min(startLine + 500, lines.length - 1);
}

function locateInLineRange(
  lines: string[],
  startIndex: number,
  endIndex: number,
  functionName: string,
  filePath: string,
): LocateResult {
  const definitionRegex = buildDefinitionRegex(functionName);

  for (let i = startIndex; i <= endIndex; i += 1) {
    if (!definitionRegex.test(lines[i])) {
      continue;
    }

    const endLine = findBodyEnd(lines, i, filePath);
    return {
      found: true,
      startLine: i + 1,
      endLine: endLine + 1,
      snippet: lines.slice(i, endLine + 1).join('\n'),
    };
  }

  return {
    found: false,
    startLine: 0,
    endLine: 0,
    snippet: '',
  };
}

function findClassRanges(lines: string[], className: string, filePath: string) {
  const classRegex = buildClassRegex(className);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!classRegex.test(lines[i])) {
      continue;
    }

    const end = findBodyEnd(lines, i, filePath);
    ranges.push({ start: i, end });
  }

  return ranges;
}

export function locateInFile(content: string, requestedFunctionName: string, filePath = ''): LocateResult {
  const lines = content.split(/\r?\n/);
  const { className, functionName } = splitQualifiedFunctionName(requestedFunctionName);

  if (className) {
    const qualifiedRegex = buildQualifiedDefinitionRegex(className, functionName);
    for (let i = 0; i < lines.length; i += 1) {
      if (!qualifiedRegex.test(lines[i])) {
        continue;
      }

      const endLine = findBodyEnd(lines, i, filePath);
      return {
        found: true,
        startLine: i + 1,
        endLine: endLine + 1,
        snippet: lines.slice(i, endLine + 1).join('\n'),
      };
    }

    for (const range of findClassRanges(lines, className, filePath)) {
      const result = locateInLineRange(lines, range.start, range.end, functionName, filePath);
      if (result.found) {
        return result;
      }
    }
  }

  return locateInLineRange(lines, 0, lines.length - 1, functionName, filePath);
}

export function looksLikeSystemOrLibrary(functionName: string, resolvedFile: string): boolean {
  const normalizedName = splitQualifiedFunctionName(functionName).functionName.toLowerCase();
  const sysPrefixes = [
    'console.',
    'log',
    'print',
    'printf',
    'malloc',
    'free',
    'require',
    'import',
    'window.',
    'document.',
    'fetch',
    'settimeout',
    'setinterval',
    'parseint',
    'parsefloat',
    'json.',
    'array.',
    'object.',
    'string.',
    'number.',
    'math.',
    'date.',
    'promise.',
    'map',
    'filter',
    'reduce',
    'foreach',
    'then',
    'catch',
  ];

  if (sysPrefixes.some((prefix) => normalizedName === prefix || normalizedName.startsWith(`${prefix}.`))) {
    return true;
  }

  if (/^(node_modules|vendor|\.venv)\//.test(resolvedFile) || resolvedFile === '未知') {
    return true;
  }

  return false;
}

export async function locateFunctionInProject(
  functionName: string,
  parentFilePath: string,
  suggestedFiles: string[],
  allCodeFiles: string[],
  fetchContent: FetchContentFn,
): Promise<LocateResult & { resolvedFile?: string }> {
  const tried = new Set<string>();

  const tryFile = async (filePath: string): Promise<(LocateResult & { resolvedFile?: string }) | null> => {
    if (!filePath || tried.has(filePath)) {
      return null;
    }

    tried.add(filePath);

    try {
      const content = await fetchContent(filePath);
      const located = locateInFile(content, functionName, filePath);
      if (located.found) {
        return { ...located, resolvedFile: filePath };
      }
    } catch {
      return null;
    }

    return null;
  };

  const inParent = await tryFile(parentFilePath);
  if (inParent) {
    return inParent;
  }

  for (const filePath of suggestedFiles.map((item) => item.trim()).filter(Boolean)) {
    const located = await tryFile(filePath);
    if (located) {
      return located;
    }
  }

  for (const filePath of allCodeFiles) {
    const located = await tryFile(filePath);
    if (located) {
      return located;
    }
  }

  return {
    found: false,
    startLine: 0,
    endLine: 0,
    snippet: '',
  };
}
