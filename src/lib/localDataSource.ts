import JSZip from 'jszip';
import { ungzip } from 'pako';
import {
  DataSource,
  DataSourceDescriptor,
  FileNode,
  SearchFileContentOptions,
  buildTreeFromFlatItems,
  extractCodeFiles,
  searchTextInPaths,
} from './dataSource';
import { LocalSessionRecord } from './localSession';

const BINARY_PLACEHOLDER = '// Unable to load file content or file is binary.';

interface ArchiveEntry {
  path: string;
  data: Uint8Array;
}

function normalizeLocalPath(path: string) {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => !!segment && segment !== '.');

  const stack: string[] = [];
  for (const segment of parts) {
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.join('/');
}

function decodeAscii(bytes: Uint8Array) {
  return new TextDecoder('ascii').decode(bytes);
}

function readTarString(header: Uint8Array, offset: number, length: number) {
  return decodeAscii(header.subarray(offset, offset + length)).replace(/\0.*$/, '').trim();
}

function parseTarOctal(header: Uint8Array, offset: number, length: number) {
  const raw = readTarString(header, offset, length).replace(/\0/g, '').trim();
  if (!raw) {
    return 0;
  }
  const value = parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function parsePaxPath(content: string) {
  const lines = content.split('\n');
  for (const line of lines) {
    const marker = line.indexOf(' path=');
    if (marker >= 0) {
      return line.slice(marker + ' path='.length).trim();
    }
  }
  return '';
}

function parseTarEntries(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingLongPath = '';

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const isEmpty = header.every((value) => value === 0);
    if (isEmpty) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = parseTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    offset += 512;

    const content = bytes.subarray(offset, offset + size);
    const nextOffset = offset + Math.ceil(size / 512) * 512;

    if (typeFlag === 'L' || typeFlag === 'x') {
      const extra = new TextDecoder('utf-8').decode(content).replace(/\0.*$/, '').trim();
      pendingLongPath = typeFlag === 'x' ? parsePaxPath(extra) || pendingLongPath : extra;
      offset = nextOffset;
      continue;
    }

    const pathFromHeader = prefix ? `${prefix}/${name}` : name;
    const rawPath = pendingLongPath || pathFromHeader;
    pendingLongPath = '';
    const normalizedPath = normalizeLocalPath(rawPath);

    if (normalizedPath && typeFlag !== '5' && !normalizedPath.endsWith('/')) {
      entries.push({
        path: normalizedPath,
        data: content.slice(),
      });
    }

    offset = nextOffset;
  }

  return entries;
}

function likelyBinaryContent(bytes: Uint8Array) {
  if (!bytes.length) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let controlChars = 0;
  for (const value of sample) {
    if (value === 0) {
      return true;
    }
    if (value < 7 || (value > 13 && value < 32)) {
      controlChars += 1;
    }
  }
  return controlChars / sample.length > 0.2;
}

function decodeArchiveBytes(bytes: Uint8Array) {
  if (likelyBinaryContent(bytes)) {
    return BINARY_PLACEHOLDER;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function ensureLocalDescriptor(descriptor: DataSourceDescriptor): DataSourceDescriptor {
  return {
    ...descriptor,
    type: 'local',
    owner: descriptor.owner || 'local',
    repo: descriptor.repo || descriptor.label,
  };
}

class LocalDataSource implements DataSource {
  readonly descriptor: DataSourceDescriptor;
  private readonly tree: FileNode[];
  private readonly readFileImpl: (path: string) => Promise<string>;

  constructor(descriptor: DataSourceDescriptor, tree: FileNode[], readFileImpl: (path: string) => Promise<string>) {
    this.descriptor = ensureLocalDescriptor(descriptor);
    this.tree = tree;
    this.readFileImpl = readFileImpl;
  }

  async getTree() {
    return this.tree;
  }

  async readFile(path: string) {
    const normalized = normalizeLocalPath(path);
    return this.readFileImpl(normalized);
  }

  async searchFileContent(query: string, options?: SearchFileContentOptions) {
    const paths = options?.paths?.length ? options.paths.map(normalizeLocalPath) : extractCodeFiles(this.tree);
    return searchTextInPaths(query, paths, (path) => this.readFile(path), options);
  }
}

function buildTreeFromPaths(paths: string[]) {
  return buildTreeFromFlatItems(paths.map((path) => ({ path, type: 'blob' as const })));
}

async function createDirectoryDataSource(record: LocalSessionRecord, files: File[]) {
  const fileMap = new Map<string, File>();
  const contentCache = new Map<string, string>();

  const paths = files
    .map((file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const normalized = normalizeLocalPath(relativePath);
      if (normalized) {
        fileMap.set(normalized, file);
      }
      return normalized;
    })
    .filter(Boolean);

  const tree = buildTreeFromPaths(paths);

  return new LocalDataSource(record.descriptor, tree, async (path: string) => {
    if (contentCache.has(path)) {
      return contentCache.get(path)!;
    }

    const file = fileMap.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    const text = await file.text();
    const output = text.includes('\u0000') ? BINARY_PLACEHOLDER : text;
    contentCache.set(path, output);
    return output;
  });
}

async function parseZipEntries(archive: File): Promise<ArchiveEntry[]> {
  const zip = await JSZip.loadAsync(archive);
  const entries: ArchiveEntry[] = [];

  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) {
      continue;
    }
    const normalizedPath = normalizeLocalPath(zipEntry.name);
    if (!normalizedPath) {
      continue;
    }
    const data = await zipEntry.async('uint8array');
    entries.push({
      path: normalizedPath,
      data,
    });
  }

  return entries;
}

async function parseTarEntriesFromFile(archive: File): Promise<ArchiveEntry[]> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  return parseTarEntries(bytes);
}

async function parseTarGzEntriesFromFile(archive: File): Promise<ArchiveEntry[]> {
  const gzBytes = new Uint8Array(await archive.arrayBuffer());
  const tarBytes = ungzip(gzBytes);
  return parseTarEntries(tarBytes);
}

async function parseRarEntriesFromFile(archive: File): Promise<ArchiveEntry[]> {
  const [{ createExtractorFromData }, wasmUrlModule] = await Promise.all([
    import('node-unrar-js/esm/index.esm.js'),
    import('node-unrar-js/esm/js/unrar.wasm?url'),
  ]);

  const wasmBinary = await fetch(wasmUrlModule.default).then((res) => res.arrayBuffer());
  const extractor = await createExtractorFromData({
    data: await archive.arrayBuffer(),
    wasmBinary,
  });
  const extracted = extractor.extract();

  const entries: ArchiveEntry[] = [];
  for (const item of extracted.files as Iterable<any>) {
    const fileHeader = item.fileHeader;
    const rawName = String(fileHeader?.name || '');
    const normalizedPath = normalizeLocalPath(rawName);
    if (!normalizedPath || fileHeader?.flags?.directory || !item.extraction) {
      continue;
    }
    entries.push({
      path: normalizedPath,
      data: item.extraction as Uint8Array,
    });
  }

  return entries;
}

async function parseArchiveEntries(archive: File): Promise<ArchiveEntry[]> {
  const name = archive.name.toLowerCase();
  if (name.endsWith('.zip')) {
    return parseZipEntries(archive);
  }
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
    return parseTarGzEntriesFromFile(archive);
  }
  if (name.endsWith('.tar')) {
    return parseTarEntriesFromFile(archive);
  }
  if (name.endsWith('.rar')) {
    return parseRarEntriesFromFile(archive);
  }
  throw new Error('Unsupported archive format. Please choose zip / tar / tar.gz / tgz / rar.');
}

async function createArchiveDataSource(record: LocalSessionRecord, archive: File) {
  const entries = await parseArchiveEntries(archive);
  const fileMap = new Map(entries.map((entry) => [entry.path, entry.data]));
  const textCache = new Map<string, string>();
  const tree = buildTreeFromPaths(entries.map((entry) => entry.path));

  return new LocalDataSource(record.descriptor, tree, async (path: string) => {
    if (textCache.has(path)) {
      return textCache.get(path)!;
    }

    const bytes = fileMap.get(path);
    if (!bytes) {
      throw new Error(`File not found: ${path}`);
    }

    const content = decodeArchiveBytes(bytes);
    textCache.set(path, content);
    return content;
  });
}

export async function createLocalDataSourceFromSession(record: LocalSessionRecord): Promise<DataSource> {
  if (record.input.mode === 'directory') {
    return createDirectoryDataSource(record, record.input.files);
  }
  return createArchiveDataSource(record, record.input.archive);
}
