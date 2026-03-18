import type { AiAnalysisResult, ModuleAnalysisResult, SubFunction, SubFunctionAnalysisResult } from './ai';
import { normalizeDataSourceLocation } from './dataSource';
import type { DataSourceDescriptor, DataSourceType, FileNode } from './dataSource';

const STORAGE_KEY = 'github-code-explorer:project-history';
const LEGACY_MARKDOWN_STORAGE_KEY = 'github-code-explorer:markdown-files';
const MARKDOWN_FILE_KEY_PREFIX = 'github-code-explorer:markdown-file:';
const MAX_HISTORY_ITEMS = 12;

export interface AnalysisLogEntry {
  id: string;
  time: string;
  title: string;
  message: string;
  details?: unknown;
}

export interface WorkflowSnapshot {
  overallStatus: 'idle' | 'running' | 'completed' | 'failed';
  currentStepId: string | null;
  currentStepLabel: string;
}

export interface WorkflowStepSnapshot {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

export interface ProjectAnalysisRecord {
  id: string;
  sourceType: DataSourceType;
  sourceId: string;
  sourceLabel: string;
  sourceOrigin?: 'directory' | 'archive' | 'remote';
  url: string;
  projectName: string;
  owner: string;
  repo: string;
  repoKey: string;
  analyzedAt: string;
  projectSummary: string;
  mainLanguage: string;
  techStack: string[];
  entryFiles: string[];
  verifiedEntryFile?: string;
  verifiedEntryReason?: string;
  fileList: string[];
  repoTree: FileNode[];
  aiResult: AiAnalysisResult | null;
  callStack: SubFunctionAnalysisResult | null;
  moduleAnalysis: ModuleAnalysisResult | null;
  workflow: WorkflowSnapshot | null;
  workflowSteps: WorkflowStepSnapshot[];
  agentLogs: AnalysisLogEntry[];
  markdownPath: string;
  markdown: string;
}

interface BuildRecordInput {
  source: DataSourceDescriptor | null;
  tree: FileNode[];
  aiResult: AiAnalysisResult | null;
  subFunctionResult: SubFunctionAnalysisResult | null;
  moduleAnalysis: ModuleAnalysisResult | null;
  workflow: WorkflowSnapshot | null;
  workflowSteps: WorkflowStepSnapshot[];
  logs: AnalysisLogEntry[];
  analyzedAt?: string;
}

type MarkdownFileStore = Record<string, string>;
type StoredProjectAnalysisRecord = Omit<ProjectAnalysisRecord, 'markdown'> & { markdown?: string };

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function normalizeGithubUrl(url: string) {
  return normalizeDataSourceLocation('github', url);
}

function makeRecordId(sourceType: DataSourceType, sourceId: string) {
  return `${sourceType}__${sourceId}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function makeLegacyRecordId(owner: string, repo: string) {
  return `${owner}__${repo}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function makeMarkdownPath(recordId: string) {
  return `localstorage://markdown/${recordId}.md`;
}

function readJsonStorage<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonStorage<T>(key: string, value: T) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

function readStorageString(key: string) {
  if (!canUseStorage()) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageString(key: string, value: string) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(key, value);
}

function makeMarkdownStorageKey(markdownPath: string) {
  return `${MARKDOWN_FILE_KEY_PREFIX}${encodeURIComponent(markdownPath)}`;
}

function saveMarkdownFile(markdownPath: string, markdown: string) {
  writeStorageString(makeMarkdownStorageKey(markdownPath), markdown);
}

export function getMarkdownFile(markdownPath: string) {
  const direct = readStorageString(makeMarkdownStorageKey(markdownPath));
  if (direct !== null) {
    return direct;
  }

  const legacyStore = readJsonStorage<MarkdownFileStore>(LEGACY_MARKDOWN_STORAGE_KEY, {});
  return legacyStore[markdownPath] || '';
}

function hydrateRecord(record: StoredProjectAnalysisRecord): ProjectAnalysisRecord {
  const normalizedUrl = normalizeGithubUrl(record.url || '');
  const fallbackSourceId =
    record.sourceId ||
    (record.sourceType === 'local'
      ? normalizeDataSourceLocation('local', record.url || record.projectName || '')
      : `github:${normalizedUrl.replace(/^https?:\/\/github\.com\//i, '').toLowerCase()}`);
  const sourceType = (record.sourceType || 'github') as DataSourceType;
  const sourceLabel = record.sourceLabel || (record.owner && record.repo ? `${record.owner}/${record.repo}` : record.projectName || 'unknown');
  const recordId = record.id || makeRecordId(sourceType, fallbackSourceId);
  const markdownPath = record.markdownPath || makeMarkdownPath(recordId || makeLegacyRecordId(record.owner, record.repo));
  const markdown = getMarkdownFile(markdownPath) || record.markdown || '';
  const owner = record.owner || (sourceType === 'github' ? sourceLabel.split('/')[0] || 'unknown' : 'local');
  const repo = record.repo || (sourceType === 'github' ? sourceLabel.split('/')[1] || 'unknown' : sourceLabel);

  return {
    ...record,
    id: recordId,
    sourceType,
    sourceId: fallbackSourceId,
    sourceLabel,
    owner,
    repo,
    repoKey: record.repoKey || `${owner}/${repo}`,
    markdownPath,
    markdown,
  };
}

function flattenFileList(nodes: FileNode[]) {
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

function formatRepoTree(nodes: FileNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const indent = '  '.repeat(depth);
    const current = `${indent}${node.type === 'tree' ? '[DIR]' : '[FILE]'} ${node.name}`;
    if (!node.children?.length) {
      return [current];
    }
    return [current, ...formatRepoTree(node.children, depth + 1)];
  });
}

function formatCallStackNode(sub: SubFunction, depth = 1): string[] {
  const indent = '  '.repeat(depth);
  const lines = [
    `${indent}- ${sub.name} (${sub.file || '未知'})`,
    `${indent}  说明: ${sub.description || '暂无'}`,
    `${indent}  下钻标记: ${sub.drillDown}`,
  ];

  if (sub.stopReason) {
    lines.push(`${indent}  停止原因: ${sub.stopReason}`);
  }

  if (sub.children?.length) {
    lines.push(...sub.children.flatMap((child) => formatCallStackNode(child, depth + 1)));
  }

  return lines;
}

function formatCallStack(callStack: SubFunctionAnalysisResult | null) {
  if (!callStack) {
    return ['暂无调用栈分析结果。'];
  }

  return [
    `入口函数: ${callStack.entryFunctionName}`,
    '子函数列表:',
    ...(callStack.subFunctions.length ? callStack.subFunctions.flatMap((sub) => formatCallStackNode(sub)) : ['  - none']),
  ];
}

function formatModules(moduleAnalysis: ModuleAnalysisResult | null) {
  if (!moduleAnalysis?.modules.length) {
    return ['暂无模块划分结果。'];
  }

  return moduleAnalysis.modules.flatMap((module) => [
    `### ${module.name}`,
    '',
    `- 颜色: ${module.color}`,
    `- 说明: ${module.description}`,
    `- 函数数: ${module.functions.length}`,
    '',
    ...module.functions.map((fn) => `  - ${fn.name} (${fn.file})`),
    '',
  ]);
}

function isEntryCandidateFilterLog(log: AnalysisLogEntry) {
  return log.title === '入口候选过滤' || log.title === 'Entry candidate filter';
}

function formatEntryCandidateFilters(logs: AnalysisLogEntry[]) {
  const filterLogs = logs.filter(isEntryCandidateFilterLog);
  if (!filterLogs.length) {
    return ['暂无入口候选过滤记录。'];
  }

  return filterLogs.flatMap((log) => {
    const lines = [`### [${log.time}] ${log.title}`, '', log.message];
    if (Array.isArray(log.details) && log.details.length > 0) {
      lines.push(
        '',
        ...log.details.map((item) => {
          if (!item || typeof item !== 'object') {
            return `- ${JSON.stringify(item)}`;
          }

          const record = item as Record<string, unknown>;
          const filePath = typeof record.filePath === 'string' ? record.filePath : '未知文件';
          const reason = typeof record.reason === 'string' ? record.reason : '未知原因';
          return `- ${filePath}: ${reason}`;
        }),
      );
    }
    lines.push('');
    return lines;
  });
}

function isBridgeAnalysisLog(log: AnalysisLogEntry) {
  return log.title === '桥接分析' || log.title === '桥接兜底' || log.title === 'Bridge analysis' || log.title === 'Bridge fallback';
}

function formatBridgeAnalysis(callStack: SubFunctionAnalysisResult | null, logs: AnalysisLogEntry[]) {
  if (!callStack?.bridge && !logs.some(isBridgeAnalysisLog)) {
    return ['暂无桥接分析记录。'];
  }

  const lines: string[] = [];

  if (callStack?.bridge) {
    lines.push(`- 分析模式: ${callStack.analysisMode || 'bridge'}`);
    lines.push(`- 策略名称: ${callStack.bridge.label}`);
    lines.push(`- 框架: ${callStack.bridge.framework}`);
    lines.push(`- 原因: ${callStack.bridge.reason || '暂无'}`);
    lines.push(`- 根节点数: ${callStack.subFunctions.length}`);
    lines.push('');
  }

  const bridgeLogs = logs.filter(isBridgeAnalysisLog);
  if (bridgeLogs.length > 0) {
    lines.push('### 桥接分析日志', '');
    for (const log of bridgeLogs) {
      lines.push(`- [${log.time}] ${log.title}: ${log.message}`);
      if (log.details !== undefined) {
        lines.push('```json', JSON.stringify(log.details, null, 2), '```');
      }
    }
  }

  return lines.length ? lines : ['暂无桥接分析记录。'];
}

function formatLogs(logs: AnalysisLogEntry[]) {
  if (!logs.length) {
    return ['暂无 Agent 工作日志。'];
  }

  return logs.flatMap((log) => {
    const lines = [`### [${log.time}] ${log.title}`, '', log.message];
    if (log.details !== undefined) {
      lines.push('', '```json', JSON.stringify(log.details, null, 2), '```');
    }
    lines.push('');
    return lines;
  });
}

function formatWorkflowStatus(status?: WorkflowSnapshot['overallStatus'] | null) {
  if (status === 'running') return '进行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'idle') return '待开始';
  return '未知';
}

function buildMarkdown(record: Omit<ProjectAnalysisRecord, 'markdown'>) {
  return [
    `# 项目工程文件：${record.projectName}`,
    '',
    '## 项目地址',
    record.url,
    '',
    '## 基本信息',
    `- 项目名称: ${record.projectName}`,
    `- 仓库标识: ${record.repoKey}`,
    `- 分析时间: ${record.analyzedAt}`,
    `- Markdown 路径: ${record.markdownPath}`,
    `- 主要语言: ${record.mainLanguage || '未知'}`,
    `- 技术栈: ${record.techStack.length ? record.techStack.join('、') : '未知'}`,
    `- 候选入口文件: ${record.entryFiles.length ? record.entryFiles.join('、') : '无'}`,
    `- 已确认入口文件: ${record.verifiedEntryFile || '无'}`,
    `- 入口判断依据: ${record.verifiedEntryReason || '无'}`,
    `- 工作流状态: ${formatWorkflowStatus(record.workflow?.overallStatus)}`,
    `- 当前步骤: ${record.workflow?.currentStepLabel || '未知'}`,
    '',
    '## 项目概述',
    record.projectSummary || '暂无项目简介。',
    '',
    '## 文件列表',
    '```text',
    ...(record.fileList.length ? record.fileList : ['暂无文件列表。']),
    '```',
    '',
    '## 仓库树',
    '```text',
    ...formatRepoTree(record.repoTree),
    '```',
    '',
    '## 调用栈',
    '```text',
    ...formatCallStack(record.callStack),
    '```',
    '',
    '## 模块划分',
    ...formatModules(record.moduleAnalysis),
    '',
    '## 技术快照',
    '```json',
    JSON.stringify(
      {
        projectSummary: record.projectSummary,
        mainLanguage: record.mainLanguage,
        techStack: record.techStack,
        entryFiles: record.entryFiles,
        verifiedEntryFile: record.verifiedEntryFile,
        verifiedEntryReason: record.verifiedEntryReason,
        markdownPath: record.markdownPath,
        workflow: record.workflow,
        workflowSteps: record.workflowSteps,
      },
      null,
      2,
    ),
    '```',
    '',
    '## 入口候选过滤',
    '## 桥接分析',
    ...formatBridgeAnalysis(record.callStack, record.agentLogs),
    '',
    ...formatEntryCandidateFilters(record.agentLogs),
    '',
    '## Agent 工作日志',
    ...formatLogs(record.agentLogs),
  ].join('\n');
}

function buildProjectMarkdown(record: Omit<ProjectAnalysisRecord, 'markdown'>) {
  return [
    `# 项目工程文件：${record.projectName}`,
    '',
    '## 项目地址',
    record.url,
    '',
    '## 基本信息',
    `- 项目名称: ${record.projectName}`,
    `- 仓库标识: ${record.repoKey}`,
    `- 分析时间: ${record.analyzedAt}`,
    `- Markdown 路径: ${record.markdownPath}`,
    `- 主要语言: ${record.mainLanguage || '未知'}`,
    `- 技术栈: ${record.techStack.length ? record.techStack.join('、') : '未知'}`,
    `- 候选入口文件: ${record.entryFiles.length ? record.entryFiles.join('、') : '无'}`,
    `- 已确认入口文件: ${record.verifiedEntryFile || '无'}`,
    `- 入口判断依据: ${record.verifiedEntryReason || '无'}`,
    `- 工作流状态: ${formatWorkflowStatus(record.workflow?.overallStatus)}`,
    `- 当前步骤: ${record.workflow?.currentStepLabel || '未知'}`,
    '',
    '## 项目概述',
    record.projectSummary || '暂无项目概述。',
    '',
    '## 文件列表',
    '```text',
    ...(record.fileList.length ? record.fileList : ['暂无文件列表。']),
    '```',
    '',
    '## 仓库树',
    '```text',
    ...formatRepoTree(record.repoTree),
    '```',
    '',
    '## 调用栈',
    '```text',
    ...formatCallStack(record.callStack),
    '```',
    '',
    '## 模块划分',
    ...formatModules(record.moduleAnalysis),
    '',
    '## 技术快照',
    '```json',
    JSON.stringify(
      {
        projectSummary: record.projectSummary,
        mainLanguage: record.mainLanguage,
        techStack: record.techStack,
        entryFiles: record.entryFiles,
        verifiedEntryFile: record.verifiedEntryFile,
        verifiedEntryReason: record.verifiedEntryReason,
        markdownPath: record.markdownPath,
        workflow: record.workflow,
        workflowSteps: record.workflowSteps,
      },
      null,
      2,
    ),
    '```',
    '',
    '## 桥接分析',
    ...formatBridgeAnalysis(record.callStack, record.agentLogs),
    '',
    '## 入口候选过滤',
    ...formatEntryCandidateFilters(record.agentLogs),
    '',
    '## Agent 工作日志',
    ...formatLogs(record.agentLogs),
  ].join('\n');
}

export function buildProjectAnalysisRecord(input: BuildRecordInput): ProjectAnalysisRecord | null {
  if (!input.source) {
    return null;
  }

  const source = input.source;
  const sourceType = source.type;
  const sourceId = source.id || normalizeDataSourceLocation(source.type, source.location);
  const owner = source.owner || (sourceType === 'github' ? source.label.split('/')[0] || 'unknown' : 'local');
  const repo = source.repo || (sourceType === 'github' ? source.label.split('/')[1] || 'unknown' : source.label);
  const recordId = makeRecordId(sourceType, sourceId);
  const markdownPath = makeMarkdownPath(recordId);
  const normalizedUrl = normalizeDataSourceLocation(sourceType, source.location);
  const recordWithoutMarkdown: Omit<ProjectAnalysisRecord, 'markdown'> = {
    id: recordId,
    sourceType,
    sourceId,
    sourceLabel: source.label,
    sourceOrigin: source.origin,
    url: normalizedUrl,
    projectName: sourceType === 'github' ? `${owner}/${repo}` : source.label,
    owner,
    repo,
    repoKey: `${owner}/${repo}`,
    analyzedAt: input.analyzedAt || new Date().toISOString(),
    projectSummary: input.aiResult?.projectSummary || '',
    mainLanguage: input.aiResult?.mainLanguage || '',
    techStack: input.aiResult?.techStack || [],
    entryFiles: input.aiResult?.entryFiles || [],
    verifiedEntryFile: input.aiResult?.verifiedEntryFile,
    verifiedEntryReason: input.aiResult?.verifiedEntryReason,
    fileList: flattenFileList(input.tree),
    repoTree: input.tree,
    aiResult: input.aiResult,
    callStack: input.subFunctionResult,
    moduleAnalysis: input.moduleAnalysis,
    workflow: input.workflow,
    workflowSteps: input.workflowSteps,
    agentLogs: input.logs,
    markdownPath,
  };

  return {
    ...recordWithoutMarkdown,
    markdown: buildProjectMarkdown(recordWithoutMarkdown),
  };
}

function readStoredProjectHistory() {
  const records = readJsonStorage<StoredProjectAnalysisRecord[]>(STORAGE_KEY, []);
  return Array.isArray(records) ? records : [];
}

export function getProjectHistory() {
  return readStoredProjectHistory().map(hydrateRecord);
}

export function getProjectHistoryRecord(id: string) {
  return getProjectHistory().find((item) => item.id === id) || null;
}

export function getProjectHistoryRecordByUrl(url: string) {
  const normalizedUrl = normalizeGithubUrl(url);
  return (
    getProjectHistory().find(
      (item) => (item.sourceType || 'github') === 'github' && normalizeGithubUrl(item.url) === normalizedUrl,
    ) || null
  );
}

export function getProjectHistoryRecordBySource(sourceType: DataSourceType, sourceId: string) {
  return (
    getProjectHistory().find((item) => {
      if ((item.sourceType || 'github') !== sourceType) {
        return false;
      }
      if (item.sourceId) {
        return item.sourceId === sourceId;
      }
      if (sourceType === 'github') {
        return normalizeGithubUrl(item.url) === normalizeGithubUrl(sourceId);
      }
      return normalizeDataSourceLocation('local', item.url) === normalizeDataSourceLocation('local', sourceId);
    }) || null
  );
}

export function saveProjectHistory(record: ProjectAnalysisRecord) {
  if (!canUseStorage()) {
    return [] as ProjectAnalysisRecord[];
  }

  saveMarkdownFile(record.markdownPath, record.markdown);

  const { markdown: _markdown, ...recordWithoutMarkdown } = record;
  const next = [recordWithoutMarkdown, ...readStoredProjectHistory().filter((item) => item.id !== record.id)]
    .map((item) => ({
      ...item,
      markdownPath: item.markdownPath || makeMarkdownPath(item.id || makeLegacyRecordId(item.owner, item.repo)),
    }))
    .sort((a, b) => new Date(b.analyzedAt).getTime() - new Date(a.analyzedAt).getTime())
    .slice(0, MAX_HISTORY_ITEMS);

  writeJsonStorage(STORAGE_KEY, next);
  return next.map(hydrateRecord);
}
