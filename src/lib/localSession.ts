import { DataSourceDescriptor } from './dataSource';

export type LocalSessionMode = 'directory' | 'archive';

export interface LocalDirectorySessionInput {
  mode: 'directory';
  files: File[];
}

export interface LocalArchiveSessionInput {
  mode: 'archive';
  archive: File;
}

export type LocalSessionInput = LocalDirectorySessionInput | LocalArchiveSessionInput;

export interface LocalSessionRecord {
  sessionId: string;
  descriptor: DataSourceDescriptor;
  input: LocalSessionInput;
  createdAt: number;
}

const SESSION_STORE = new Map<string, LocalSessionRecord>();

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function shortHash(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function getDirectoryDisplayName(files: File[]) {
  const firstRelative = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || files[0]?.name || 'local-project';
  const firstSeg = normalizePath(firstRelative).split('/')[0] || 'local-project';
  return firstSeg;
}

function buildDirectorySourceId(files: File[]) {
  const fingerprint = files
    .map((file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return `${normalizePath(relativePath)}:${file.size}:${file.lastModified}`;
    })
    .sort()
    .join('|');
  return `local:dir:${shortHash(fingerprint)}`;
}

function buildArchiveSourceId(archive: File) {
  return `local:archive:${shortHash(`${archive.name}:${archive.size}:${archive.lastModified}`)}`;
}

function makeSessionId() {
  return `local-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerLocalSession(input: LocalSessionInput): LocalSessionRecord {
  const sessionId = makeSessionId();
  const createdAt = Date.now();

  const descriptor: DataSourceDescriptor =
    input.mode === 'directory'
      ? {
          type: 'local',
          id: buildDirectorySourceId(input.files),
          label: getDirectoryDisplayName(input.files),
          location: `local://directory/${getDirectoryDisplayName(input.files)}`,
          origin: 'directory',
        }
      : {
          type: 'local',
          id: buildArchiveSourceId(input.archive),
          label: input.archive.name,
          location: `local://archive/${input.archive.name}`,
          origin: 'archive',
        };

  const record: LocalSessionRecord = {
    sessionId,
    descriptor,
    input,
    createdAt,
  };

  SESSION_STORE.set(sessionId, record);
  return record;
}

export function getLocalSession(sessionId: string) {
  return SESSION_STORE.get(sessionId) || null;
}

export function hasLocalSession(sessionId: string) {
  return SESSION_STORE.has(sessionId);
}

