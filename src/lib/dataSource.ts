export type DataSourceType = 'github' | 'local';

export interface FileNode {
  path: string;
  name: string;
  type: 'tree' | 'blob';
  url?: string;
  size?: number;
  children?: FileNode[];
}

export interface DataSourceDescriptor {
  type: DataSourceType;
  id: string;
  label: string;
  location: string;
  owner?: string;
  repo?: string;
  origin?: 'directory' | 'archive' | 'remote';
}

export interface SearchFileContentOptions {
  paths?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface FileContentMatch {
  path: string;
  line: number;
  lineText: string;
}

export interface DataSource {
  descriptor: DataSourceDescriptor;
  getTree(): Promise<FileNode[]>;
  readFile(path: string): Promise<string>;
  searchFileContent(query: string, options?: SearchFileContentOptions): Promise<FileContentMatch[]>;
}

export const ANALYZABLE_CODE_EXTENSIONS =
  /\.(js|jsx|ts|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|cs|swift|kt|json|xml|yaml|yml|toml|mod|sum|gradle|sh|bat)$/i;
export const SOURCE_CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|cs|swift|kt|sh|bat)$/i;
export const SPECIAL_CODE_FILENAMES = /(^|\/)(Dockerfile|Makefile|CMakeLists\.txt)$/i;
export const EXCLUDE_PATTERNS =
  /(^|\/)(node_modules|dist|build|out|\.git|\.next|\.nuxt|coverage|vendor|public|assets|docs|test|tests|__tests__|__mocks__)(\/|$)/i;

function getSourceSignals(filePath: string): RegExp[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() || normalizedPath;
  const extension = normalizedPath.includes('.') ? normalizedPath.split('.').pop()!.toLowerCase() : '';

  if (['js', 'jsx', 'ts', 'tsx'].includes(extension)) {
    return [
      /^\s*(import|export)\s/m,
      /\b(function|class|interface|type|enum|const|let|var|async|await|return)\b/,
      /=>/,
      /\bnew\s+[A-Za-z_$][\w$]*/,
      /\b[A-Za-z_$][\w$]*\s*\(/,
      /[;{}]/,
      /<[A-Z][A-Za-z0-9]*/m,
    ];
  }

  if (['py'].includes(extension)) {
    return [
      /^\s*(from\s+\S+\s+import|import\s+\S+)\b/m,
      /^\s*(def|class)\s+\w+/m,
      /if __name__ == ['"]__main__['"]/,
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*.+/m,
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/m,
    ];
  }

  if (['java', 'kt', 'cs', 'swift'].includes(extension)) {
    return [
      /\b(class|interface|enum|object|record|protocol)\b/,
      /\b(public|private|protected|internal|static|final|override|abstract|open|sealed)\b/,
      /\b(fun|func|void|Task|async|suspend)\s+\w+\s*\(/,
    ];
  }

  if (['go'].includes(extension)) {
    return [/^\s*package\s+\w+/m, /^\s*func\s+\w+\s*\(/m, /^\s*import\s+\(/m];
  }

  if (['rs'].includes(extension)) {
    return [/^\s*(pub\s+)?fn\s+\w+\s*\(/m, /^\s*use\s+\S+/m, /^\s*impl\b/m];
  }

  if (['c', 'cpp', 'h', 'hpp'].includes(extension)) {
    return [/^\s*#include\s+[<"]/m, /\b(class|struct|typedef|namespace)\b/, /\b[A-Za-z_]\w*\s+\**\w+\s*\(/];
  }

  if (['rb'].includes(extension)) {
    return [/^\s*(def|class|module)\s+\w+/m, /^\s*require\s+['"]/m];
  }

  if (['php'].includes(extension)) {
    return [/<\?php/, /\b(function|class|namespace|use)\b/];
  }

  if (['sh', 'bat'].includes(extension)) {
    return [
      /^#!/m,
      /^\s*(if|for|while|case|function)\b/m,
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/m,
      /^\s*(echo|export|set|call|cd|npm|node|python|bash|sh)\b/m,
    ];
  }

  if (fileName === 'Dockerfile') {
    return [/^\s*(FROM|RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|ENV|EXPOSE|ARG|USER|LABEL)\b/m];
  }

  if (fileName === 'Makefile') {
    return [/^[A-Za-z0-9_.-]+:\s*(?:$|[^=])/m, /^\t\S/m];
  }

  if (fileName === 'CMakeLists.txt') {
    return [/^\s*(cmake_minimum_required|project|add_executable|add_library|target_link_libraries|set)\s*\(/im];
  }

  return [/\b(function|class|def|func|fn|import|package|return)\b/, /[{}();]/];
}

export function isLikelySourceCodePath(filePath: string): boolean {
  return SOURCE_CODE_EXTENSIONS.test(filePath) || SPECIAL_CODE_FILENAMES.test(filePath);
}

export function looksLikeSourceCodeContent(filePath: string, content: string): boolean {
  if (!isLikelySourceCodePath(filePath)) {
    return false;
  }

  const normalized = content.replace(/^\uFEFF/, '').trim();
  if (!normalized || normalized.length < 4) {
    return false;
  }

  if (normalized.includes('\u0000')) {
    return false;
  }

  if (normalized.startsWith('// Unable to load file content or file is binary.')) {
    return false;
  }

  return getSourceSignals(filePath).some((pattern) => pattern.test(normalized));
}

export function extractCodeFiles(nodes: FileNode[]): string[] {
  const result: string[] = [];

  function traverse(nodeList: FileNode[]) {
    for (const node of nodeList) {
      if (EXCLUDE_PATTERNS.test(node.path)) {
        continue;
      }

      if (node.type === 'blob') {
        if (ANALYZABLE_CODE_EXTENSIONS.test(node.name) || SPECIAL_CODE_FILENAMES.test(node.path)) {
          result.push(node.path);
        }
      } else if (node.children) {
        traverse(node.children);
      }
    }
  }

  traverse(nodes);
  return result;
}

export function flattenFileList(nodes: FileNode[]) {
  const files: string[] = [];

  const walk = (items: FileNode[]) => {
    for (const item of items) {
      if (item.type === 'blob') {
        files.push(item.path);
      }
      if (item.children?.length) {
        walk(item.children);
      }
    }
  };

  walk(nodes);
  return files;
}

export function buildTreeFromFlatItems(
  items: Array<{ path: string; type: 'tree' | 'blob'; url?: string; size?: number }>,
): FileNode[] {
  const root: FileNode[] = [];
  const map = new Map<string, FileNode>();

  items.sort((a, b) => {
    if (a.type === b.type) {
      return a.path.localeCompare(b.path);
    }
    return a.type === 'tree' ? -1 : 1;
  });

  for (const item of items) {
    const normalizedPath = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath) {
      continue;
    }

    const parts = normalizedPath.split('/').filter(Boolean);
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    const node: FileNode = {
      path: normalizedPath,
      name,
      type: item.type,
      ...(item.url ? { url: item.url } : {}),
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
      ...(item.type === 'tree' ? { children: [] as FileNode[] } : {}),
    };

    map.set(normalizedPath, node);

    if (!parentPath) {
      root.push(node);
      continue;
    }

    const parent = map.get(parentPath);
    if (parent && parent.children) {
      parent.children.push(node);
      continue;
    }

    // Ensure intermediate directories exist.
    let parentCursor = '';
    let parentNode: FileNode | null = null;
    for (const segment of parts) {
      parentCursor = parentCursor ? `${parentCursor}/${segment}` : segment;
      let maybe = map.get(parentCursor);
      if (!maybe) {
        maybe = {
          path: parentCursor,
          name: segment,
          type: 'tree',
          children: [],
        };
        map.set(parentCursor, maybe);
        if (parentNode?.children) {
          parentNode.children.push(maybe);
        } else {
          root.push(maybe);
        }
      }
      parentNode = maybe;
    }

    if (parentNode?.children) {
      parentNode.children.push(node);
    } else {
      root.push(node);
    }
  }

  return root;
}

export function normalizeDataSourceLocation(type: DataSourceType, value: string) {
  const trimmed = value.trim();
  if (type === 'github') {
    try {
      let nextUrl = trimmed;
      if (!nextUrl.startsWith('http')) {
        nextUrl = `https://${nextUrl}`;
      }

      const parsed = new URL(nextUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        return trimmed;
      }

      return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function sanitizeQueryLine(line: string) {
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

export async function searchTextInPaths(
  query: string,
  paths: string[],
  readFile: (path: string) => Promise<string>,
  options?: SearchFileContentOptions,
): Promise<FileContentMatch[]> {
  const needle = options?.caseSensitive ? query : query.toLowerCase();
  const matches: FileContentMatch[] = [];
  const maxResults = Math.max(1, options?.maxResults || 200);

  for (const path of paths) {
    if (matches.length >= maxResults) {
      break;
    }

    let content = '';
    try {
      content = await readFile(path);
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const haystack = options?.caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }

      matches.push({
        path,
        line: index + 1,
        lineText: sanitizeQueryLine(line.trim()),
      });

      if (matches.length >= maxResults) {
        break;
      }
    }
  }

  return matches;
}

