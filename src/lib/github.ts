export interface RepoInfo {
  owner: string;
  repo: string;
}

export function parseGithubUrl(url: string): RepoInfo | null {
  try {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const urlObj = new URL(cleanUrl);
    if (urlObj.hostname !== 'github.com' && urlObj.hostname !== 'www.github.com') {
      return null;
    }
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/, ''),
    };
  } catch (e) {
    return null;
  }
}

export interface FileNode {
  path: string;
  name: string;
  type: 'tree' | 'blob';
  url: string;
  children?: FileNode[];
}

const ANALYZABLE_CODE_EXTENSIONS =
  /\.(js|jsx|ts|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|cs|swift|kt|json|xml|yaml|yml|toml|mod|sum|gradle|sh|bat)$/i;
const SOURCE_CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|cs|swift|kt|sh|bat)$/i;
const SPECIAL_CODE_FILENAMES = /(^|\/)(Dockerfile|Makefile|CMakeLists\.txt)$/i;
const EXCLUDE_PATTERNS =
  /(^|\/)(node_modules|dist|build|out|\.git|\.next|\.nuxt|coverage|vendor|public|assets|docs|test|tests|__tests__|__mocks__)(\/|$)/i;

/** 获取请求 GitHub API 时的 headers（若配置了 GITHUB_TOKEN 则带认证） */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = (process.env as Record<string, string | undefined>).GITHUB_TOKEN?.trim();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export async function fetchRepoTree(owner: string, repo: string): Promise<FileNode[]> {
  const headers = githubHeaders();
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error('Repository not found');
  const repoData = await repoRes.json();
  const defaultBranch = repoData.default_branch;

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error('Failed to fetch repository tree');
  const treeData = await treeRes.json();

  return buildTree(treeData.tree);
}

function buildTree(items: any[]): FileNode[] {
  const root: FileNode[] = [];
  const map = new Map<string, FileNode>();

  // Sort items: trees first, then blobs
  items.sort((a, b) => {
    if (a.type === b.type) return a.path.localeCompare(b.path);
    return a.type === 'tree' ? -1 : 1;
  });

  for (const item of items) {
    const parts = item.path.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    const node: FileNode = {
      path: item.path,
      name,
      type: item.type,
      url: item.url,
      ...(item.type === 'tree' ? { children: [] } : {}),
    };

    map.set(item.path, node);

    if (parentPath === '') {
      root.push(node);
    } else {
      const parent = map.get(parentPath);
      if (parent && parent.children) {
        parent.children.push(node);
      }
    }
  }

  return root;
}

export async function fetchFileContent(owner: string, repo: string, path: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers: githubHeaders() });
  if (!res.ok) throw new Error('Failed to fetch file content');
  const data = await res.json();
  if (data.encoding === 'base64') {
    try {
      const binString = atob(data.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(binString.length);
      for (let i = 0; i < binString.length; i++) {
        bytes[i] = binString.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return '// 无法解析文件内容或文件为二进制格式';
    }
  }
  return data.content || '';
}

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
