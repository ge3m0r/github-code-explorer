import {
  DataSource,
  DataSourceDescriptor,
  FileNode,
  SearchFileContentOptions,
  buildTreeFromFlatItems,
  extractCodeFiles,
  isLikelySourceCodePath,
  looksLikeSourceCodeContent,
  searchTextInPaths,
} from './dataSource';
import { getSettings } from './settings';

export type {
  DataSource,
  DataSourceDescriptor,
  FileNode,
  SearchFileContentOptions,
} from './dataSource';
export { extractCodeFiles, isLikelySourceCodePath, looksLikeSourceCodeContent } from './dataSource';

export interface RepoInfo {
  owner: string;
  repo: string;
}

export function parseGithubUrl(url: string): RepoInfo | null {
  try {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) {
      cleanUrl = `https://${cleanUrl}`;
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
  } catch {
    return null;
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = getSettings().githubToken?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function decodeBase64Utf8(base64Text: string) {
  const binString = atob(base64Text.replace(/\n/g, ''));
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i += 1) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export class GithubDataSource implements DataSource {
  readonly descriptor: DataSourceDescriptor;
  readonly owner: string;
  readonly repo: string;

  private treePromise: Promise<FileNode[]> | null = null;
  private fileCache = new Map<string, string>();

  constructor(owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
    this.descriptor = {
      type: 'github',
      id: `github:${owner}/${repo}`.toLowerCase(),
      label: `${owner}/${repo}`,
      location: `https://github.com/${owner}/${repo}`,
      owner,
      repo,
      origin: 'remote',
    };
  }

  async getTree(): Promise<FileNode[]> {
    if (this.treePromise) {
      return this.treePromise;
    }

    this.treePromise = (async () => {
      const headers = githubHeaders();
      const repoRes = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}`, { headers });
      if (!repoRes.ok) {
        throw new Error('Repository not found');
      }
      const repoData = await repoRes.json();
      const defaultBranch = repoData.default_branch;

      const treeRes = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${defaultBranch}?recursive=1`, {
        headers,
      });
      if (!treeRes.ok) {
        throw new Error('Failed to fetch repository tree');
      }
      const treeData = await treeRes.json();

      return buildTreeFromFlatItems(
        (treeData.tree || [])
          .filter((item: { path?: string; type?: string }) => typeof item.path === 'string' && (item.type === 'tree' || item.type === 'blob'))
          .map((item: { path: string; type: 'tree' | 'blob'; url?: string; size?: number }) => ({
            path: item.path,
            type: item.type,
            url: item.url,
            size: item.size,
          })),
      );
    })();

    return this.treePromise;
  }

  async readFile(path: string): Promise<string> {
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.fileCache.has(normalizedPath)) {
      return this.fileCache.get(normalizedPath)!;
    }

    const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/contents/${normalizedPath}`, {
      headers: githubHeaders(),
    });
    if (!res.ok) {
      throw new Error('Failed to fetch file content');
    }
    const data = await res.json();
    if (data.encoding === 'base64' && typeof data.content === 'string') {
      try {
        const decoded = decodeBase64Utf8(data.content);
        this.fileCache.set(normalizedPath, decoded);
        return decoded;
      } catch {
        return '// Unable to load file content or file is binary.';
      }
    }

    const text = typeof data.content === 'string' ? data.content : '';
    this.fileCache.set(normalizedPath, text);
    return text;
  }

  async searchFileContent(query: string, options?: SearchFileContentOptions) {
    const tree = await this.getTree();
    const paths = options?.paths?.length ? options.paths : extractCodeFiles(tree);
    return searchTextInPaths(query, paths, (path) => this.readFile(path), options);
  }
}

export function createGithubDataSource(owner: string, repo: string) {
  return new GithubDataSource(owner, repo);
}

export function createGithubDataSourceFromUrl(url: string) {
  const info = parseGithubUrl(url);
  if (!info) {
    return null;
  }
  return new GithubDataSource(info.owner, info.repo);
}

// Backward-compatible exports used by existing modules.
export async function fetchRepoTree(owner: string, repo: string): Promise<FileNode[]> {
  return new GithubDataSource(owner, repo).getTree();
}

export async function fetchFileContent(owner: string, repo: string, path: string): Promise<string> {
  return new GithubDataSource(owner, repo).readFile(path);
}

