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

export async function fetchRepoTree(owner: string, repo: string): Promise<FileNode[]> {
  // First get default branch
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!repoRes.ok) throw new Error('Repository not found');
  const repoData = await repoRes.json();
  const defaultBranch = repoData.default_branch;

  // Get tree
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`);
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
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
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

export function extractCodeFiles(nodes: FileNode[]): string[] {
  const codeExtensions = /\.(js|jsx|ts|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|cs|swift|kt|json|xml|yaml|yml|toml|mod|sum|gradle|sh|bat)$/i;
  const excludePatterns = /(^|\/)(node_modules|dist|build|out|\.git|\.next|\.nuxt|coverage|vendor|public|assets|docs|test|tests|__tests__|__mocks__)(\/|$)/i;
  const result: string[] = [];

  function traverse(nodeList: FileNode[]) {
    for (const node of nodeList) {
      if (excludePatterns.test(node.path)) {
        continue;
      }
      
      if (node.type === 'blob') {
        if (codeExtensions.test(node.name) || node.name === 'Dockerfile' || node.name === 'Makefile' || node.name === 'CMakeLists.txt') {
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
