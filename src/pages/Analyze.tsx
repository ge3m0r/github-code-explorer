import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { toPng } from 'html-to-image';
import {
  DataSource,
  DataSourceDescriptor,
  createGithubDataSourceFromUrl,
  extractCodeFiles,
  isLikelySourceCodePath,
} from '../lib/github';
import type { FileNode } from '../lib/dataSource';
import { analyzeProject, verifyEntryFile, analyzeSubFunctions, pickBestEntryFile, suggestFilesForFunction, analyzeFunctionSnippet, analyzeFunctionModules, assignFunctionsToExistingOrNewModules, AiAnalysisResult, AiCallDetails, ModuleAnalysisResult, ModuleAssignmentCandidate, SubFunctionAnalysisResult, SubFunction } from '../lib/ai';
import { buildProjectAnalysisRecord, saveProjectHistory, getProjectHistoryRecord, AnalysisLogEntry, ProjectAnalysisRecord, WorkflowSnapshot, WorkflowStepSnapshot } from '../lib/history';
import { buildBridgeAnalysis } from '../lib/bridge';
import { locateFunctionInProject, locateInFile, looksLikeSystemOrLibrary } from '../lib/functionLocator';
import { buildFunctionModuleMap, flattenProjectFunctions, makeFunctionKey, mergeIncrementalModuleAssignments, normalizeFunctionModules } from '../lib/moduleGrouping';
import { getLocalSession } from '../lib/localSession';
import { createLocalDataSourceFromSession } from '../lib/localDataSource';
import { truncateJson } from '../lib/utils';
import FileTree from '../components/FileTree';
import CodeViewer from '../components/CodeViewer';
import Panorama, { PanoramaDrillTarget, PanoramaNodeRef } from '../components/Panorama';
import { ArrowLeft, Github, Loader2, ChevronDown, ChevronRight, Activity, Maximize2, X, FileCode2, Network, FolderTree, FileText, Copy, Download, ImageDown, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';

const WORKFLOW_STEP_DEFS = [
  { id: 'load_tree', label: '获取文件树' },
  { id: 'project_summary', label: '分析项目概览' },
  { id: 'verify_entry', label: '验证入口文件' },
  { id: 'call_graph', label: '分析函数调用图' },
  { id: 'module_analysis', label: '划分功能模块' },
] as const;

type WorkflowStepId = (typeof WORKFLOW_STEP_DEFS)[number]['id'];

function createInitialWorkflowSteps(): WorkflowStepSnapshot[] {
  return WORKFLOW_STEP_DEFS.map((step) => ({
    id: step.id,
    label: step.label,
    status: 'pending',
  }));
}

function getWorkflowStepLabel(stepId: WorkflowStepId | null) {
  return WORKFLOW_STEP_DEFS.find((step) => step.id === stepId)?.label || '未知步骤';
}

function LogItem({ log, defaultExpanded = false }: { log: AnalysisLogEntry, defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="mb-4 text-sm border-l-2 border-indigo-200 pl-3 py-1">
      <div className="flex items-center justify-between text-gray-600 mb-1">
        <span className="font-semibold text-gray-800">{log.title}</span>
        <span className="text-xs text-gray-400">{log.time}</span>
      </div>
      <div className="text-gray-600 text-xs leading-relaxed">{log.message}</div>
      {log.details && (
        <div className="mt-2">
          <button 
            onClick={() => setExpanded(!expanded)} 
            className="text-indigo-600 hover:text-indigo-700 text-xs flex items-center font-medium transition-colors"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5 mr-1"/> : <ChevronRight className="w-3.5 h-3.5 mr-1"/>}
            {expanded ? '收起详情' : '查看详情 (JSON)'}
          </button>
          {expanded && (
            <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto font-mono shadow-inner">
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(truncateJson(log.details), null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Analyze() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sourceType = (searchParams.get('source') || 'github') as 'github' | 'local';
  const url = searchParams.get('url') || '';
  const localSessionId = searchParams.get('session') || '';
  const historyId = searchParams.get('history');
  const runToken = searchParams.get('run') || '';
  
  const [dataSource, setDataSource] = useState<DataSource | null>(null);
  const dataSourceRef = useRef<DataSource | null>(null);
  const [sourceDescriptor, setSourceDescriptor] = useState<DataSourceDescriptor | null>(null);
  const [repoInfo, setRepoInfo] = useState<{owner: string, repo: string} | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [error, setError] = useState('');
  
  const [aiResult, setAiResult] = useState<AiAnalysisResult | null>(null);
  const [loadingAi, setLoadingAi] = useState(false);
  const [moduleAnalysis, setModuleAnalysis] = useState<ModuleAnalysisResult | null>(null);
  const [loadingModules, setLoadingModules] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  
  const [subFunctionResult, setSubFunctionResult] = useState<SubFunctionAnalysisResult | null>(null);
  const [loadingSubFunctions, setLoadingSubFunctions] = useState(false);
  const [manualDrillNodeId, setManualDrillNodeId] = useState<string | null>(null);
  
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [codeFocusRange, setCodeFocusRange] = useState<{ startLine: number; endLine: number } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const [logs, setLogs] = useState<AnalysisLogEntry[]>([]);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isProjectFileOpen, setIsProjectFileOpen] = useState(false);
  const [projectRecord, setProjectRecord] = useState<ProjectAnalysisRecord | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [workflow, setWorkflow] = useState<WorkflowSnapshot>({
    overallStatus: 'idle',
    currentStepId: null,
    currentStepLabel: '等待开始',
  });
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStepSnapshot[]>(() => createInitialWorkflowSteps());
  const [aiStats, setAiStats] = useState({
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  const logsEndRef = useRef<HTMLDivElement>(null);
  const panoramaViewportRef = useRef<HTMLDivElement>(null);
  const workflowStepsRef = useRef<WorkflowStepSnapshot[]>(createInitialWorkflowSteps());
  const analyzedUrlRef = useRef<string | null>(null);
  const analyzedAtRef = useRef<string | null>(null);
  const loadRequestKeyRef = useRef<string | null>(null);
  const [allowAutoModuleAnalysis, setAllowAutoModuleAnalysis] = useState(true);

  const [showPanel1, setShowPanel1] = useState(true);
  const [showPanel2, setShowPanel2] = useState(true);
  const [showPanel3, setShowPanel3] = useState(true);
  const [showPanel4, setShowPanel4] = useState(true);

  useEffect(() => {
    workflowStepsRef.current = workflowSteps;
  }, [workflowSteps]);

  const moduleMap = useMemo(
    () => buildFunctionModuleMap(moduleAnalysis?.modules || []),
    [moduleAnalysis],
  );

  const addLog = (title: string, message: string, details?: any) => {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(2, 9),
      time,
      title,
      message,
      details
    }]);
  };

  const setActiveDataSource = (source: DataSource | null) => {
    dataSourceRef.current = source;
    setDataSource(source);
  };

  const readDataSourceFile = async (filePath: string) => {
    const activeSource = dataSourceRef.current;
    if (!activeSource) {
      throw new Error('Data source is not ready');
    }
    return activeSource.readFile(filePath);
  };

  const triggerFileDownload = (filename: string, blob: Blob) => {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  };

  const applyWorkflowState = (nextSteps: WorkflowStepSnapshot[], nextWorkflow: WorkflowSnapshot) => {
    workflowStepsRef.current = nextSteps;
    setWorkflowSteps(nextSteps);
    setWorkflow(nextWorkflow);
  };

  const resetWorkflow = () => {
    applyWorkflowState(createInitialWorkflowSteps(), {
      overallStatus: 'idle',
      currentStepId: null,
      currentStepLabel: '等待开始',
    });
  };

  const startWorkflowStep = (stepId: WorkflowStepId) => {
    const nextSteps = workflowStepsRef.current.map((step) =>
      step.id === stepId
        ? { ...step, status: 'running' }
        : step.status === 'running'
          ? { ...step, status: 'pending' }
          : step,
    ) as WorkflowStepSnapshot[];

    applyWorkflowState(nextSteps, {
      overallStatus: 'running',
      currentStepId: stepId,
      currentStepLabel: getWorkflowStepLabel(stepId),
    });
  };

  const finishWorkflowStep = (stepId: WorkflowStepId, status: WorkflowStepSnapshot['status']) => {
    const nextSteps = workflowStepsRef.current.map((step) =>
      step.id === stepId ? { ...step, status } : step,
    ) as WorkflowStepSnapshot[];
    const nextPending = nextSteps.find((step) => step.status === 'pending');
    const nextRunning = nextSteps.find((step) => step.status === 'running');
    const failedStep = nextSteps.find((step) => step.status === 'failed') || null;
    const allDone = nextSteps.every((step) => step.status === 'completed' || step.status === 'skipped');

    applyWorkflowState(nextSteps, {
      overallStatus: failedStep ? 'failed' : allDone ? 'completed' : 'running',
      currentStepId: failedStep
        ? failedStep.id
        : nextRunning?.id || nextPending?.id || null,
      currentStepLabel: failedStep
        ? failedStep.label
        : allDone
          ? '分析已完成'
          : nextRunning?.label || nextPending?.label || '进行中',
    });
  };

  const completeWorkflowStep = (stepId: WorkflowStepId) => {
    finishWorkflowStep(stepId, 'completed');
  };

  const skipWorkflowStep = (stepId: WorkflowStepId) => {
    finishWorkflowStep(stepId, 'skipped');
  };

  const failWorkflowStep = (stepId: WorkflowStepId) => {
    finishWorkflowStep(stepId, 'failed');
  };

  const skipWorkflowSteps = (stepIds: WorkflowStepId[]) => {
    stepIds.forEach((stepId) => skipWorkflowStep(stepId));
  };

  const recordAiUsage = (details?: AiCallDetails) => {
    if (!details) {
      return;
    }

    setAiStats((prev) => ({
      callCount: prev.callCount + 1,
      inputTokens: prev.inputTokens + (details.usage?.inputTokens || 0),
      outputTokens: prev.outputTokens + (details.usage?.outputTokens || 0),
      totalTokens: prev.totalTokens + (details.usage?.totalTokens || 0),
    }));
  };

  const restoreHistoryRecord = (record: ProjectAnalysisRecord) => {
    const restoredSteps = record.workflowSteps?.length ? record.workflowSteps : createInitialWorkflowSteps();
    const restoredWorkflow =
      record.workflow ||
      ({
        overallStatus: record.aiResult || record.callStack || record.moduleAnalysis ? 'completed' : 'idle',
        currentStepId: null,
        currentStepLabel: record.aiResult || record.callStack || record.moduleAnalysis ? '已恢复历史快照' : '等待开始',
      } satisfies WorkflowSnapshot);

    analyzedUrlRef.current = record.url;
    analyzedAtRef.current = record.analyzedAt;
    applyWorkflowState(restoredSteps, restoredWorkflow);
    setSourceDescriptor({
      type: record.sourceType || 'github',
      id: record.sourceId || `${record.sourceType || 'github'}:${record.url}`,
      label: record.sourceLabel || record.projectName,
      location: record.url,
      owner: record.owner,
      repo: record.repo,
      origin: record.sourceOrigin,
    });
    setActiveDataSource(null);
    setRepoInfo({ owner: record.owner, repo: record.repo });
    setTree(record.repoTree || []);
    setError('');
    setAiResult(record.aiResult);
    setSubFunctionResult(record.callStack);
    setModuleAnalysis(record.moduleAnalysis);
    setSelectedModuleId(null);
    setLogs(record.agentLogs || []);
    setProjectRecord(record);
    setLoadingTree(false);
    setLoadingAi(false);
    setLoadingSubFunctions(false);
    setLoadingModules(false);
    setManualDrillNodeId(null);
    setSelectedFile(null);
    setFileContent('');
    setCodeFocusRange(null);
    setIsProjectFileOpen(false);
    setCopyStatus('');
    setAiStats({
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    setAllowAutoModuleAnalysis(false);
  };

  const isUsableProjectFilePath = (filePath?: string) =>
    !!filePath && !/^(unknown|\u672a\u77e5)$/i.test(filePath.trim());

  const findFileNodeByPath = (nodes: FileNode[], targetPath: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === targetPath) {
        return node;
      }
      if (node.children?.length) {
        const nested = findFileNodeByPath(node.children, targetPath);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  };

  const loadFileAtLocation = async (filePath: string, range?: { startLine: number; endLine: number }) => {
    if (!repoInfo || !dataSourceRef.current) return;

    const resolvedNode =
      findFileNodeByPath(tree, filePath) ||
      ({
        path: filePath,
        name: filePath.split('/').pop() || filePath,
        type: 'blob',
        url: '',
      } satisfies FileNode);

    setSelectedFile(resolvedNode);
    setCodeFocusRange(range || null);
    setLoadingFile(true);
    try {
      const content = await readDataSourceFile(filePath);
      setFileContent(content);
    } catch {
      setFileContent('// Unable to load file content or file is binary.');
    } finally {
      setLoadingFile(false);
    }
  };

  const locateSubFunctionTarget = (
    subs: SubFunction[],
    targetId: string,
    parentFilePath: string,
    prefix = 'sub',
  ): { node: SubFunction; parentFilePath: string } | null => {
    for (let index = 0; index < subs.length; index += 1) {
      const sub = subs[index];
      const nodeId = `${prefix}-${index}`;
      if (nodeId === targetId) {
        return { node: sub, parentFilePath };
      }
      if (sub.children?.length) {
        const childParentFilePath = isUsableProjectFilePath(sub.file) ? sub.file : parentFilePath;
        const nested = locateSubFunctionTarget(sub.children, targetId, childParentFilePath, nodeId);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  };

  const replaceSubFunctionById = (
    subs: SubFunction[],
    targetId: string,
    replacement: SubFunction,
    prefix = 'sub',
  ): SubFunction[] =>
    subs.map((sub, index) => {
      const nodeId = `${prefix}-${index}`;
      if (nodeId === targetId) {
        return replacement;
      }
      if (sub.children?.length && targetId.startsWith(`${nodeId}-`)) {
        return {
          ...sub,
          children: replaceSubFunctionById(sub.children, targetId, replacement, nodeId),
        };
      }
      return sub;
    });

  const resolveDrillDownTarget = async (
    sub: SubFunction,
    parentFilePath: string,
    owner: string,
    repo: string,
    files: string[],
    projectSummary: string
  ): Promise<{
    resolvedFile?: string;
    startLine?: number;
    endLine?: number;
    analyzedResult?: SubFunctionAnalysisResult;
    stopReason?: string;
  }> => {
    const fallbackParentFilePath = isUsableProjectFilePath(parentFilePath)
      ? parentFilePath
      : isUsableProjectFilePath(sub.file)
        ? sub.file
        : '';
    const fetchContent = (path: string) => readDataSourceFile(path);
    let suggestedFiles: string[] = [];
    try {
      const { result, details } = await suggestFilesForFunction(projectSummary, fallbackParentFilePath, sub.name, files);
      recordAiUsage(details);
      suggestedFiles = result.possibleFiles || [];
    } catch {
      addLog('下钻定位', `[${sub.name}] AI 推测文件失败，将使用项目搜索`);
    }

    const loc = await locateFunctionInProject(sub.name, fallbackParentFilePath, suggestedFiles, files, fetchContent);
    if (!loc.found || !loc.resolvedFile) {
      return {
        resolvedFile: isUsableProjectFilePath(sub.file) ? sub.file : undefined,
        stopReason: 'not_found',
      };
    }
    if (looksLikeSystemOrLibrary(sub.name, loc.resolvedFile)) {
      return {
        resolvedFile: loc.resolvedFile,
        startLine: loc.startLine,
        endLine: loc.endLine,
        stopReason: 'system_function',
      };
    }

    try {
      const { result, details } = await analyzeFunctionSnippet(projectSummary, sub.name, loc.snippet, loc.resolvedFile, files);
      recordAiUsage(details);
      return {
        resolvedFile: loc.resolvedFile,
        startLine: loc.startLine,
        endLine: loc.endLine,
        analyzedResult: result,
      };
    } catch (err: any) {
      addLog('下钻失败', `[${sub.name}] 分析代码片段失败：${err.message}`);
      return {
        resolvedFile: loc.resolvedFile,
        startLine: loc.startLine,
        endLine: loc.endLine,
        stopReason: 'analysis_failed',
      };
    }
  };

  const buildIncrementalModuleCandidates = async (
    parentNode: SubFunction,
    parentFilePath: string,
    newChildren: SubFunction[],
    owner: string,
    repo: string,
    files: string[],
  ): Promise<ModuleAssignmentCandidate[]> => {
    const fetchContent = (filePath: string) => readDataSourceFile(filePath);
    const candidates: ModuleAssignmentCandidate[] = [];

    for (const child of newChildren) {
      const resolvedFilePath = isUsableProjectFilePath(child.file) ? child.file : parentFilePath;
      const functionKey = makeFunctionKey(child.name, resolvedFilePath);
      if (moduleMap.has(functionKey)) {
        continue;
      }

      let snippet = '';
      try {
        const located = await locateFunctionInProject(
          child.name,
          resolvedFilePath,
          isUsableProjectFilePath(child.file) ? [child.file] : [],
          files,
          fetchContent,
        );
        if (located.found) {
          snippet = located.snippet.slice(0, 4000);
        }
      } catch {
        snippet = '';
      }

      candidates.push({
        name: child.name,
        file: resolvedFilePath,
        description: child.description || '暂无说明',
        snippet,
        parentName: parentNode.name,
        parentFile: parentFilePath,
      });
    }

    return candidates;
  };

  const maxDrillDepth = Math.max(0, parseInt(process.env.AI_DRILL_DOWN_MAX_DEPTH || '3', 10) || 3);

  /** 对单个子函数进行下钻：定位 -> 提取片段 -> AI 分析子函数 -> 递归处理 drillDown 0/1 的子孙。depth 从入口算起：1=入口的第一层子函数，2=再下一层。*/
  const drillDownOne = async (
    sub: SubFunction,
    parentFilePath: string,
    depth: number,
    owner: string,
    repo: string,
    files: string[],
    projectSummary: string
  ): Promise<SubFunction> => {
    if (depth >= maxDrillDepth) {
      addLog('下钻停止', `[${sub.name}] 已达到最大下钻层数 ${maxDrillDepth}（从入口算起），停止下钻`);
      return { ...sub, stopReason: 'max_depth' };
    }
    const fetchContent = (path: string) => readDataSourceFile(path);
    let suggestedFiles: string[] = [];
    try {
      const { result, details } = await suggestFilesForFunction(projectSummary, parentFilePath, sub.name, files);
      recordAiUsage(details);
      suggestedFiles = result.possibleFiles || [];
    } catch (e: any) {
      addLog('下钻定位', `[${sub.name}] AI 推测文件失败，将使用项目搜索`);
    }
    const loc = await locateFunctionInProject(
      sub.name,
      parentFilePath,
      suggestedFiles,
      files,
      fetchContent
    );
    if (!loc.found || !loc.resolvedFile) {
      addLog('下钻停止', `[${sub.name}] 未找到函数定义，停止下钻`);
      return { ...sub, stopReason: 'not_found' };
    }
    if (looksLikeSystemOrLibrary(sub.name, loc.resolvedFile)) {
      addLog('下钻停止', `[${sub.name}] 判定为系统/库函数，停止下钻`);
      return { ...sub, file: loc.resolvedFile, stopReason: 'system_function' };
    }
    addLog('下钻定位', `[${sub.name}] 已定位到 ${loc.resolvedFile}，开始分析子函数`);
    let childResult: SubFunctionAnalysisResult;
    try {
      const { result, details } = await analyzeFunctionSnippet(
        projectSummary,
        sub.name,
        loc.snippet,
        loc.resolvedFile,
        files
      );
      recordAiUsage(details);
      childResult = result;
    } catch (e: any) {
      addLog('下钻失败', `[${sub.name}] 分析代码片段失败：${e.message}`);
      return { ...sub, file: loc.resolvedFile, stopReason: 'not_found' };
    }
    const children: SubFunction[] = [];
    for (const child of childResult.subFunctions) {
      if (child.drillDown !== 0 && child.drillDown !== 1) continue;
      const processed = await drillDownOne(
        child,
        loc.resolvedFile,
        depth + 1,
        owner,
        repo,
        files,
        projectSummary
      );
      children.push(processed);
    }
    return {
      ...sub,
      file: loc.resolvedFile,
      children: children.length ? children : undefined,
    };
  };

  /** 对第一层子函数中 drillDown 为 0 或 1 的项进行下钻，每完成一个即更新全景图，避免长时间无反馈。*/
  const runDrillDown = async (
    subResult: SubFunctionAnalysisResult,
    entryFilePath: string,
    owner: string,
    repo: string,
    files: string[],
    projectSummary: string
  ) => {
    const subs = subResult.subFunctions;
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      if (sub.drillDown !== 0 && sub.drillDown !== 1) continue;
      addLog('下钻分析', `开始下钻分析子函数 ${i + 1}/${subs.length}: ${sub.name}`);
      const processed = await drillDownOne(sub, entryFilePath, 1, owner, repo, files, projectSummary);
      setSubFunctionResult((prev) => {
        if (!prev || prev.entryFunctionName !== subResult.entryFunctionName) return prev;
        const next = prev.subFunctions.map((s, j) => (j === i ? processed : s));
        return { ...prev, subFunctions: next };
      });
    }
    addLog('下钻完成', `已对 ${subs.filter(s => s.drillDown === 0 || s.drillDown === 1).length} 个关键子函数完成下钻`);
  };

  const runModuleAnalysis = async ({
    mode = 'manual',
    isCancelled,
  }: {
    mode?: 'auto' | 'manual';
    isCancelled?: () => boolean;
  } = {}) => {
    if (!aiResult || !subFunctionResult || subFunctionResult.entryFunctionName === 'Analyzing...') {
      if (mode === 'manual') {
        addLog('模块划分', '当前缺少可用的调用图结果，无法执行模块分析。');
      }
      return;
    }

    const entryFilePath = aiResult.verifiedEntryFile || aiResult.entryFiles[0] || subFunctionResult.entryFile || '';
    const functions = flattenProjectFunctions(subFunctionResult, entryFilePath);
    if (!functions.length) {
      setLoadingModules(false);
      setModuleAnalysis(null);
      setSelectedModuleId(null);
      if (mode === 'manual') {
        addLog('模块划分', '当前调用图中没有可用于模块划分的函数节点。');
      }
      return;
    }

    startWorkflowStep('module_analysis');
    setLoadingModules(true);

    try {
      const { result, details } = await analyzeFunctionModules(
        aiResult.projectSummary,
        aiResult.mainLanguage,
        aiResult.techStack,
        functions,
      );

      if (isCancelled?.()) {
        return;
      }

      const normalizedModules = normalizeFunctionModules(result.modules, functions);
      recordAiUsage(details);
      setModuleAnalysis({ modules: normalizedModules });
      completeWorkflowStep('module_analysis');
      addLog(mode === 'manual' ? '模块重新分析' : '模块划分', `已完成 ${normalizedModules.length} 个功能模块划分。`, details);
    } catch (err: any) {
      if (isCancelled?.()) {
        return;
      }

      const fallbackModules = normalizeFunctionModules([], functions);
      setModuleAnalysis({ modules: fallbackModules });
      completeWorkflowStep('module_analysis');
      addLog(mode === 'manual' ? '模块重新分析失败' : '模块划分失败', `AI 模块划分失败，已使用兜底分组：${err.message}`);
    } finally {
      if (!isCancelled?.()) {
        setLoadingModules(false);
      }
    }
  };

  const filterEntryCandidates = (entryFiles: string[], availableFiles: string[]) => {
    const availableFileSet = new Set(availableFiles);
    const seen = new Set<string>();
    const accepted: string[] = [];
    const rejected: Array<{ filePath: string; reason: string }> = [];

    for (const rawPath of entryFiles) {
      const filePath = rawPath.trim();
      if (!filePath || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);

      if (!availableFileSet.has(filePath)) {
        rejected.push({ filePath, reason: '该文件不在当前项目的可分析文件列表中。' });
        continue;
      }

      if (!isLikelySourceCodePath(filePath)) {
        rejected.push({ filePath, reason: '该文件是配置或数据文件，不是可执行源码入口。' });
        continue;
      }

      accepted.push(filePath);
    }

    return { accepted, rejected };
  };

  useEffect(() => {
    if (logsEndRef.current && !isLogModalOpen) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isLogModalOpen]);

  useEffect(() => {
    if (!copyStatus) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopyStatus('');
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  useEffect(() => {
    if (
      !allowAutoModuleAnalysis ||
      !aiResult ||
      !subFunctionResult ||
      subFunctionResult.entryFunctionName === 'Analyzing...' ||
      loadingSubFunctions ||
      moduleAnalysis
    ) {
      if (!aiResult || !subFunctionResult || subFunctionResult.entryFunctionName === 'Analyzing...') {
        setLoadingModules(false);
        setModuleAnalysis(null);
        setSelectedModuleId(null);
      }
      return;
    }

    const entryFilePath = aiResult.verifiedEntryFile || aiResult.entryFiles[0] || subFunctionResult.entryFile || '';
    const functions = flattenProjectFunctions(subFunctionResult, entryFilePath);
    if (!functions.length) {
      setLoadingModules(false);
      setModuleAnalysis(null);
      setSelectedModuleId(null);
      return;
    }

    let cancelled = false;

    void runModuleAnalysis({
      mode: 'auto',
      isCancelled: () => cancelled,
    });

    return () => {
      cancelled = true;
    };
  }, [allowAutoModuleAnalysis, aiResult, subFunctionResult, loadingSubFunctions, moduleAnalysis]);

  useEffect(() => {
    if (selectedModuleId && !moduleAnalysis?.modules.some((module) => module.id === selectedModuleId)) {
      setSelectedModuleId(null);
    }
  }, [moduleAnalysis, selectedModuleId]);

  useEffect(() => {
    if (!sourceDescriptor || !repoInfo) return;

    const record = buildProjectAnalysisRecord({
      source: sourceDescriptor,
      tree,
      aiResult,
      subFunctionResult,
      moduleAnalysis,
      workflow,
      workflowSteps,
      logs,
      analyzedAt: analyzedAtRef.current || new Date().toISOString(),
    });

    if (!record) return;

    setProjectRecord(record);
    const timer = window.setTimeout(() => {
      saveProjectHistory(record);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [sourceDescriptor, repoInfo, tree, aiResult, subFunctionResult, moduleAnalysis, workflow, workflowSteps, logs]);

  useEffect(() => {
    const targetToken = sourceType === 'github' ? url : localSessionId;
    const loadRequestKey = `${sourceType}::${targetToken}::${historyId || ''}::${runToken}`;
    if ((!historyId && !targetToken) || loadRequestKey === loadRequestKeyRef.current) return;
    loadRequestKeyRef.current = loadRequestKey;
    analyzedAtRef.current = new Date().toISOString();

    setLogs([]);
    resetWorkflow();
    setAllowAutoModuleAnalysis(true);
    setAiStats({
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    setModuleAnalysis(null);
    setLoadingModules(false);
    setLoadingTree(false);
    setLoadingAi(false);
    setLoadingSubFunctions(false);
    setSelectedModuleId(null);
    setProjectRecord(null);
    setManualDrillNodeId(null);
    setSelectedFile(null);
    setFileContent('');
    setCodeFocusRange(null);
    setIsProjectFileOpen(false);
    setCopyStatus('');
    setError('');
    setSourceDescriptor(null);
    setRepoInfo(null);
    setActiveDataSource(null);

    const bootstrap = async () => {
      if (historyId) {
        const record = getProjectHistoryRecord(historyId);
        if (record) {
          restoreHistoryRecord(record);
          return;
        }
        addLog('历史恢复失败', `未找到历史记录 ${historyId}，将重新执行完整分析。`);
      }

      if (sourceType === 'github') {
        const githubSource = createGithubDataSourceFromUrl(url);
        if (!githubSource) {
          setError('无效的项目地址');
          addLog('校验失败', `提供的 URL (${url}) 无法解析为有效的 GitHub 仓库地址。`);
          return;
        }

        analyzedUrlRef.current = githubSource.descriptor.location;
        setActiveDataSource(githubSource);
        setSourceDescriptor(githubSource.descriptor);
        setRepoInfo({ owner: githubSource.owner, repo: githubSource.repo });
        addLog('校验成功', `成功解析 GitHub 地址：${githubSource.owner}/${githubSource.repo}`);
        await loadTree(githubSource, githubSource.owner, githubSource.repo);
        return;
      }

      const localSession = getLocalSession(localSessionId);
      if (!localSession) {
        setError('本地会话已失效，请返回首页重新选择本地目录或压缩包。');
        addLog('本地会话失效', '未找到本地项目会话数据，请返回首页重新选择本地路径。');
        return;
      }

      try {
        const localSource = await createLocalDataSourceFromSession(localSession);
        const localOwner = localSource.descriptor.owner || 'local';
        const localRepo = localSource.descriptor.repo || localSource.descriptor.label;

        analyzedUrlRef.current = localSource.descriptor.location;
        setActiveDataSource(localSource);
        setSourceDescriptor(localSource.descriptor);
        setRepoInfo({ owner: localOwner, repo: localRepo });
        addLog('本地项目就绪', `已加载本地数据源：${localSource.descriptor.label}`);
        await loadTree(localSource, localOwner, localRepo);
      } catch (err: any) {
        setError(err.message || '加载本地项目失败');
        addLog('本地加载失败', `加载本地目录/压缩包时发生错误：${err.message || '未知错误'}`);
      }
    };

    void bootstrap();
  }, [sourceType, url, localSessionId, historyId, runToken]);
  const loadTree = async (source: DataSource, owner: string, repo: string) => {
    startWorkflowStep('load_tree');
    setLoadingTree(true);
    setError('');
    setAiResult(null);
    addLog('获取文件树', `正在读取 ${source.descriptor.label} 的文件结构...`);
    try {
      const data = await source.getTree();
      setTree(data);
      
      // Count total files (blobs)
      let totalFiles = 0;
      const countBlobs = (nodes: FileNode[]) => {
        for (const node of nodes) {
          if (node.type === 'blob') totalFiles++;
          if (node.children) countBlobs(node.children);
        }
      };
      countBlobs(data);
      completeWorkflowStep('load_tree');
      addLog('获取成功', `成功读取项目结构，共包含 ${totalFiles} 个文件。`);
      
      const codeFiles = extractCodeFiles(data);
      addLog('过滤文件', `过滤非代码文件后，剩余 ${codeFiles.length} 个代码/配置文件。`);

      if (codeFiles.length > 0) {
        void analyzeProjectFiles(codeFiles.slice(0, 1000), owner, repo);
      } else {
        skipWorkflowSteps(['project_summary', 'verify_entry', 'call_graph', 'module_analysis']);
        addLog('分析跳过', '未找到可分析的代码文件。');
      }
    } catch (err: any) {
      failWorkflowStep('load_tree');
      skipWorkflowSteps(['project_summary', 'verify_entry', 'call_graph', 'module_analysis']);
      setError(err.message || '获取项目结构失败');
      addLog('获取失败', `读取项目结构时发生错误：${err.message}`);
    } finally {
      setLoadingTree(false);
    }
  };

  const analyzeEntryCallGraph = async (
    owner: string,
    repo: string,
    files: string[],
    analysisResult: AiAnalysisResult,
    entryFilePath: string,
    entryFileContent: string,
  ) => {
    startWorkflowStep('call_graph');
    setSubFunctionResult({
      entryFunctionName: 'Analyzing...',
      subFunctions: [],
    });
    setLoadingSubFunctions(true);

    try {
      const bridgeMatch = await buildBridgeAnalysis({
        owner,
        repo,
        aiResult: {
          projectSummary: analysisResult.projectSummary,
          mainLanguage: analysisResult.mainLanguage,
          techStack: analysisResult.techStack,
          entryFiles: analysisResult.entryFiles,
          verifiedEntryFile: entryFilePath,
          verifiedEntryReason: analysisResult.verifiedEntryReason,
        },
        entryFilePath,
        entryFileContent,
        sourceFiles: files,
        fetchContent: (filePath: string) => readDataSourceFile(filePath),
      });

      if (bridgeMatch) {
        setSubFunctionResult(bridgeMatch.result);
        addLog(
          '桥接分析',
          `识别到 ${bridgeMatch.details.framework} 框架，采用 ${bridgeMatch.details.label} 策略生成桥接节点。`,
          bridgeMatch.details,
        );

        const toDrill = bridgeMatch.result.subFunctions.filter((item) => item.drillDown === 0 || item.drillDown === 1);
        if (toDrill.length > 0 && maxDrillDepth > 0) {
          addLog('下钻分析', `将对 ${toDrill.length} 个桥接节点继续自动下钻（最大深度 ${maxDrillDepth}）。`);
          await runDrillDown(bridgeMatch.result, entryFilePath, owner, repo, files, analysisResult.projectSummary);
        }

        completeWorkflowStep('call_graph');
        return;
      }

      addLog('桥接兜底', '未匹配到可用的框架桥接策略，转入通用函数调用分析。');
      const { result: subResult, details: subDetails } = await analyzeSubFunctions(
        analysisResult.projectSummary,
        entryFilePath,
        entryFileContent,
        files,
      );
      recordAiUsage(subDetails);
      setSubFunctionResult(subResult);
      addLog('分析子函数完成', `成功识别 ${subResult.subFunctions.length} 个关键子函数。`, subDetails);

      const toDrill = subResult.subFunctions.filter((item) => item.drillDown === 0 || item.drillDown === 1);
      if (toDrill.length > 0 && maxDrillDepth > 0) {
        addLog('下钻分析', `将对 ${toDrill.length} 个关键子函数进行下钻（最大深度 ${maxDrillDepth}）。`);
        await runDrillDown(subResult, entryFilePath, owner, repo, files, analysisResult.projectSummary);
      }

      completeWorkflowStep('call_graph');
    } catch (err: any) {
      failWorkflowStep('call_graph');
      skipWorkflowStep('module_analysis');
      addLog('分析子函数失败', `分析函数调用图时发生错误：${err.message}`);
    } finally {
      setLoadingSubFunctions(false);
    }
  };

  const analyzeProjectFiles = async (files: string[], owner: string, repo: string) => {
    startWorkflowStep('project_summary');
    setLoadingAi(true);
    addLog('AI 分析', `开始调用 AI 分析项目技术栈和入口文件...`);
    try {
      const { result, details } = await analyzeProject(files);
      recordAiUsage(details);
      completeWorkflowStep('project_summary');
      const { accepted: filteredEntryFiles, rejected: rejectedEntryFiles } = filterEntryCandidates(result.entryFiles || [], files);
      const normalizedResult: AiAnalysisResult = {
        ...result,
        entryFiles: filteredEntryFiles,
      };
      setAiResult(normalizedResult);
      addLog('AI 分析完成', `成功识别主要语言：${result.mainLanguage}，技术栈：${result.techStack.join(', ') || '无'}`, details);

      if (rejectedEntryFiles.length > 0) {
        addLog(
          '入口候选过滤',
          `已过滤 ${rejectedEntryFiles.length} 个非源码入口候选，保留 ${filteredEntryFiles.length} 个可验证入口文件。`,
          rejectedEntryFiles,
        );
      }

      if (!filteredEntryFiles.length) {
        failWorkflowStep('verify_entry');
        skipWorkflowSteps(['call_graph', 'module_analysis']);
        addLog('入口研判失败', '过滤非源码文件后，没有可验证的入口候选，无法继续函数调用图分析。');
        return;
      }

      startWorkflowStep('verify_entry');
      addLog('入口研判', `当前保留了 ${filteredEntryFiles.length} 个源码入口候选，开始逐个研判...`);

      const candidateContents: Array<{ filePath: string; content: string }> = [];
      for (const filePath of filteredEntryFiles) {
        addLog('读取文件', `正在获取可能的入口文件内容：${filePath}`);
        try {
          const fileContent = await readDataSourceFile(filePath);
          candidateContents.push({ filePath, content: fileContent });
          addLog('研判文件', `开始调用 AI 研判文件：${filePath}`);
          const { result: verificationResult, details: verificationDetails } = await verifyEntryFile(
            `https://github.com/${owner}/${repo}`,
            result.projectSummary,
            result.mainLanguage,
            filePath,
            fileContent,
            files,
          );
          recordAiUsage(verificationDetails);

          if (!verificationResult.isEntryFile) {
            addLog('研判失败', `${filePath} 不是项目入口文件。理由：${verificationResult.reason}`, verificationDetails);
            continue;
          }

          addLog('研判成功', `确认 ${filePath} 是项目入口文件。理由：${verificationResult.reason}`, verificationDetails);
          setAiResult((prev) =>
            prev ? { ...prev, verifiedEntryFile: filePath, verifiedEntryReason: verificationResult.reason } : null,
          );
          completeWorkflowStep('verify_entry');
          await analyzeEntryCallGraph(
            owner,
            repo,
            files,
            { ...normalizedResult, verifiedEntryFile: filePath, verifiedEntryReason: verificationResult.reason },
            filePath,
            fileContent,
          );
          return;
        } catch (err: any) {
          addLog('研判出错', `处理文件 ${filePath} 时发生错误：${err.message}`);
        }
      }

      if (candidateContents.length > 0) {
        addLog('兜底研判', '所有候选均未单独确认，正在使用 AI 对比全部候选文件并选出最可能的入口...');
        try {
          const { result: pickResult, details: pickDetails } = await pickBestEntryFile(
            `https://github.com/${owner}/${repo}`,
            result.projectSummary,
            result.mainLanguage,
            candidateContents,
            files,
          );
          recordAiUsage(pickDetails);
          const bestPath = pickResult.bestEntryFile;
          const bestContent = candidateContents.find((candidate) => candidate.filePath === bestPath)?.content ?? candidateContents[0].content;
          addLog('兜底结果', `AI 选出入口文件：${bestPath}。理由：${pickResult.reason}`, pickDetails);
          setAiResult((prev) =>
            prev ? { ...prev, verifiedEntryFile: bestPath, verifiedEntryReason: `[兜底] ${pickResult.reason}` } : null,
          );
          completeWorkflowStep('verify_entry');
          await analyzeEntryCallGraph(
            owner,
            repo,
            files,
            { ...normalizedResult, verifiedEntryFile: bestPath, verifiedEntryReason: `[兜底] ${pickResult.reason}` },
            bestPath,
            bestContent,
          );
          return;
        } catch (err: any) {
          addLog('兜底研判失败', `对比选出入口时发生错误：${err.message}`);
        }
      }

      failWorkflowStep('verify_entry');
      skipWorkflowSteps(['call_graph', 'module_analysis']);
      addLog(
        '研判结束',
        candidateContents.length > 0
          ? '所有可能的入口文件均已研判，但仍未能确认最终入口。'
          : '入口候选文件均无法读取，未能继续入口研判。',
      );
    } catch (err: any) {
      console.error('AI Analysis failed:', err);
      failWorkflowStep('project_summary');
      skipWorkflowSteps(['verify_entry', 'call_graph', 'module_analysis']);
      addLog('AI 分析失败', `调用 AI 时发生错误：${err.message}`);
    } finally {
      setLoadingAi(false);
    }
  };

  const handleSelectFile = async (node: FileNode) => {
    if (node.type !== 'blob') return;
    try {
    await loadFileAtLocation(node.path);
    } catch (err) {
      setFileContent('// Unable to load file content or file is binary.');
    } finally {
      setLoadingFile(false);
    }
  };

  const handlePanoramaNodeSelect = async (node: PanoramaNodeRef) => {
    if (!repoInfo || !dataSourceRef.current || !isUsableProjectFilePath(node.file)) {
      return;
    }

    if (node.startLine) {
      await loadFileAtLocation(node.file, {
        startLine: node.startLine,
        endLine: node.endLine || node.startLine,
      });
      return;
    }

    try {
      const content = await readDataSourceFile(node.file);
      const located = locateInFile(content, node.name, node.file);
      if (located.found) {
        await loadFileAtLocation(node.file, {
          startLine: located.startLine,
          endLine: located.endLine,
        });
        return;
      }
    } catch {
      addLog('代码定位', `[${node.name}] 直接在文件中定位失败，改用项目级搜索。`);
    }

    const files = extractCodeFiles(tree);
    const fetchContent = (filePath: string) => readDataSourceFile(filePath);
    const located = await locateFunctionInProject(node.name, node.file, [node.file], files, fetchContent);

    if (located.found && located.resolvedFile) {
      await loadFileAtLocation(located.resolvedFile, {
        startLine: located.startLine,
        endLine: located.endLine,
      });
      return;
    }

    await loadFileAtLocation(node.file);
  };

  const handlePanoramaNodeDrillDown = async (node: PanoramaDrillTarget) => {
    if (!repoInfo || !dataSourceRef.current || !aiResult || !subFunctionResult || manualDrillNodeId || loadingSubFunctions) {
      return;
    }

    const entryFilePath = aiResult.verifiedEntryFile || aiResult.entryFiles[0] || '';
    const target = locateSubFunctionTarget(subFunctionResult.subFunctions, node.id, entryFilePath);
    if (!target) {
      addLog('手动下钻', `[${node.name}] 未找到对应节点，无法继续下钻。`);
      return;
    }

    const files = extractCodeFiles(tree);
    setManualDrillNodeId(node.id);
    setLoadingSubFunctions(true);
    addLog('手动下钻', `开始对节点 ${node.name} 执行单层下钻分析。`);

    try {
      const resolved = await resolveDrillDownTarget(
        target.node,
        target.parentFilePath,
        repoInfo.owner,
        repoInfo.repo,
        files,
        aiResult.projectSummary,
      );

      const drilledChildren = resolved.analyzedResult?.subFunctions || [];
      const replacement: SubFunction = {
        ...target.node,
        file: resolved.resolvedFile || target.node.file || target.parentFilePath,
        startLine: resolved.startLine ?? target.node.startLine,
        endLine: resolved.endLine ?? target.node.endLine,
        children: drilledChildren.length ? drilledChildren : undefined,
        stopReason:
          resolved.stopReason ||
          (resolved.analyzedResult ? (drilledChildren.length ? undefined : 'no_children') : target.node.stopReason),
      };

      setSubFunctionResult((prev) =>
        prev
          ? {
              ...prev,
              subFunctions: replaceSubFunctionById(prev.subFunctions, node.id, replacement),
            }
          : prev,
      );

      if (resolved.resolvedFile) {
        await loadFileAtLocation(
          resolved.resolvedFile,
          resolved.startLine
            ? {
                startLine: resolved.startLine,
                endLine: resolved.endLine || resolved.startLine,
              }
            : undefined,
        );
      }

      if (resolved.analyzedResult) {
        addLog(
          '手动下钻',
          `[${node.name}] 已加载 ${drilledChildren.length} 个子函数节点。`,
          resolved.analyzedResult,
        );
      } else {
        addLog('手动下钻', `[${node.name}] 下钻结束，停止原因：${replacement.stopReason || '未知'}`);
      }

      if (resolved.analyzedResult && moduleAnalysis?.modules.length && drilledChildren.length) {
        const candidateParentFile = resolved.resolvedFile || target.parentFilePath;
        const newCandidates = await buildIncrementalModuleCandidates(
          target.node,
          candidateParentFile,
          drilledChildren,
          repoInfo.owner,
          repoInfo.repo,
          files,
        );

        if (newCandidates.length) {
          setLoadingModules(true);
          try {
            const { result: assignmentResult, details } = await assignFunctionsToExistingOrNewModules(
              aiResult.projectSummary,
              aiResult.mainLanguage,
              aiResult.techStack,
              moduleAnalysis.modules,
              newCandidates,
            );
            recordAiUsage(details);

            const mergedModules = mergeIncrementalModuleAssignments(
              moduleAnalysis.modules,
              newCandidates.map((item) => ({
                name: item.name,
                file: item.file,
                description: item.description,
              })),
              assignmentResult,
            );

            setModuleAnalysis({ modules: mergedModules });
            addLog('模块增量归类', `已完成 ${newCandidates.length} 个新增节点的增量模块归类。`, details);
          } catch (err: any) {
            const mergedModules = mergeIncrementalModuleAssignments(
              moduleAnalysis.modules,
              newCandidates.map((item) => ({
                name: item.name,
                file: item.file,
                description: item.description,
              })),
              { existingAssignments: [], newModules: [] },
            );

            setModuleAnalysis({ modules: mergedModules });
            addLog('模块增量归类失败', `AI 增量归类失败，新节点已暂存到未分类模块：${err.message}`);
          } finally {
            setLoadingModules(false);
          }
        }
      }
    } catch (err: any) {
      addLog('手动下钻失败', `[${node.name}] ${err.message}`);
    } finally {
      setLoadingSubFunctions(false);
      setManualDrillNodeId(null);
    }
  };

  const handleCopyProjectFile = async () => {
    if (!projectRecord?.markdown) {
      return;
    }

    try {
      await navigator.clipboard.writeText(projectRecord.markdown);
      setCopyStatus('已复制');
    } catch {
      setCopyStatus('复制失败');
    }
  };

  const sanitizeFilename = (input: string) => input.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_');

  const handleDownloadProjectFile = () => {
    if (!projectRecord?.markdown) {
      return;
    }

    const baseName = sanitizeFilename(projectRecord.projectName || sourceDescriptor?.label || 'project');
    const filename = `${baseName}-project.md`;
    triggerFileDownload(filename, new Blob([projectRecord.markdown], { type: 'text/markdown;charset=utf-8' }));
  };

  const handleDownloadPanoramaImage = async () => {
    if (!panoramaViewportRef.current) {
      addLog('全景图下载失败', '当前未找到全景图视口，请先展开全景图再尝试下载。');
      return;
    }

    const viewportWidth = panoramaViewportRef.current.clientWidth;
    const viewportHeight = panoramaViewportRef.current.clientHeight;
    if (!viewportWidth || !viewportHeight) {
      addLog('全景图下载失败', '当前全景图视口尺寸异常，请调整布局后重试。');
      return;
    }

    try {
      const dataUrl = await toPng(panoramaViewportRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        width: viewportWidth,
        height: viewportHeight,
        canvasWidth: viewportWidth * 2,
        canvasHeight: viewportHeight * 2,
        style: {
          width: `${viewportWidth}px`,
          height: `${viewportHeight}px`,
          overflow: 'hidden',
        },
      });
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const baseName = sanitizeFilename(projectRecord?.projectName || sourceDescriptor?.label || 'project');
      triggerFileDownload(`${baseName}-panorama.png`, blob);
    } catch (err: any) {
      addLog('全景图下载失败', `导出全景图图片失败：${err.message || '未知错误'}`);
    }
  };

  const handleReanalyzeProject = () => {
    if (sourceType === 'local' && !localSessionId && !dataSourceRef.current) {
      addLog('重新分析不可用', '当前本地会话不可用，请返回首页重新选择本地目录或压缩包。');
      return;
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete('history');
    next.set('run', Date.now().toString());
    if (!next.get('source')) {
      next.set('source', sourceType);
    }
    navigate(`/analyze?${next.toString()}`);
  };

  const handleUrlChange = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sourceType !== 'github') {
      return;
    }
    const formData = new FormData(e.currentTarget);
    const newUrl = formData.get('url') as string;
    if (newUrl) {
      navigate(`/analyze?source=github&url=${encodeURIComponent(newUrl)}&run=${Date.now()}`);
    }
  };

  const verifyEntryStepStatus = workflowSteps.find((step) => step.id === 'verify_entry')?.status || 'pending';
  const candidateEntryFiles = aiResult
    ? Array.from(new Set([...(aiResult.entryFiles || []), ...(aiResult.verifiedEntryFile ? [aiResult.verifiedEntryFile] : [])]))
    : [];
  const canRunModuleAnalysis =
    !!aiResult &&
    !!subFunctionResult &&
    subFunctionResult.entryFunctionName !== 'Analyzing...' &&
    !loadingSubFunctions;
  const canReanalyze = sourceType === 'github' ? !!url : !!localSessionId || !!dataSourceRef.current;

  const renderWorkflowStatusCard = () => (
    <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
      <div
        className={clsx(
          'inline-flex rounded-full px-3 py-1 text-xs font-semibold',
          workflow.overallStatus === 'completed' && 'bg-emerald-50 text-emerald-700',
          workflow.overallStatus === 'running' && 'bg-blue-50 text-blue-700',
          workflow.overallStatus === 'failed' && 'bg-red-50 text-red-700',
          workflow.overallStatus === 'idle' && 'bg-gray-100 text-gray-600',
        )}
      >
        {workflow.overallStatus === 'completed'
          ? '已完成'
          : workflow.overallStatus === 'running'
            ? '进行中'
            : workflow.overallStatus === 'failed'
              ? '失败'
              : '待开始'}
      </div>
      <div className="mt-4 text-sm font-medium text-gray-800">{workflow.currentStepLabel || '等待开始'}</div>
      <div className="mt-4 space-y-3">
        {workflowSteps.map((step) => (
          <div key={step.id} className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-600">{step.label}</span>
            <span
              className={clsx(
                'rounded-full px-2.5 py-1 text-xs font-semibold',
                step.status === 'completed' && 'bg-emerald-50 text-emerald-700',
                step.status === 'running' && 'bg-blue-50 text-blue-700',
                step.status === 'failed' && 'bg-red-50 text-red-700',
                step.status === 'skipped' && 'bg-amber-50 text-amber-700',
                step.status === 'pending' && 'bg-gray-100 text-gray-500',
              )}
            >
              {step.status === 'completed'
                ? '已完成'
                : step.status === 'running'
                  ? '进行中'
                  : step.status === 'failed'
                    ? '失败'
                    : step.status === 'skipped'
                      ? '已跳过'
                      : '待处理'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  const renderAiStatsCard = () => (
    <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 min-w-0">
          <div className="text-[11px] font-medium text-gray-400 whitespace-nowrap tracking-tight">调用次数</div>
          <div className="mt-3 text-[1rem] leading-none font-semibold text-gray-800 tabular-nums">{aiStats.callCount}</div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 min-w-0">
          <div className="text-[11px] font-medium text-gray-400 whitespace-nowrap tracking-tight">输入 Tokens</div>
          <div className="mt-3 text-[1rem] leading-none font-semibold text-gray-800 tabular-nums">{aiStats.inputTokens}</div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 min-w-0">
          <div className="text-[11px] font-medium text-gray-400 whitespace-nowrap tracking-tight">输出 Tokens</div>
          <div className="mt-3 text-[1rem] leading-none font-semibold text-gray-800 tabular-nums">{aiStats.outputTokens}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-gray-400">总 Tokens: {aiStats.totalTokens}</div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-[#f5f5f5] font-sans overflow-hidden">
      {/* Header */}
      <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-sm z-10">
        <div className="flex items-center">
          <button 
            onClick={() => navigate('/')}
            className="flex items-center text-gray-500 hover:text-gray-900 transition-colors mr-6 font-medium"
          >
            <ArrowLeft className="w-5 h-5 mr-2" />
            返回
          </button>
          <div className="flex items-center font-semibold text-gray-900 text-lg">
            <Github className="w-6 h-6 mr-3" />
            {repoInfo ? `${repoInfo.owner} / ${repoInfo.repo}` : '代码分析'}
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={handleDownloadPanoramaImage}
            disabled={!subFunctionResult}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="下载全景图图片"
          >
            <ImageDown className="w-4 h-4" />
            下载全景图
          </button>
          <button
            type="button"
            onClick={handleDownloadProjectFile}
            disabled={!projectRecord?.markdown}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="下载项目工程文件"
          >
            <Download className="w-4 h-4" />
            下载工程文件
          </button>
          <button
            onClick={() => setShowPanel1(!showPanel1)}
            className={`p-2 rounded-md transition-colors ${showPanel1 ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'}`}
            title="切换信息面板"
          >
            <Activity className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowPanel2(!showPanel2)}
            className={`p-2 rounded-md transition-colors ${showPanel2 ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'}`}
            title="切换文件树"
          >
            <FolderTree className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowPanel3(!showPanel3)}
            className={`p-2 rounded-md transition-colors ${showPanel3 ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'}`}
            title="切换代码视图"
          >
            <FileCode2 className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowPanel4(!showPanel4)}
            className={`p-2 rounded-md transition-colors ${showPanel4 ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'}`}
            title="切换全景图"
          >
            <Network className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content - 4 Columns */}
      <PanelGroup orientation="horizontal" className="flex-1 overflow-hidden">
        
        {/* Column 1: Info & Controls (Left) */}
        {showPanel1 && (
          <>
            <Panel defaultSize={25} minSize={15} className="bg-gray-50/50 flex flex-col p-6 overflow-y-auto">
              <form onSubmit={handleUrlChange} className="mb-8 shrink-0">
            <div className="flex items-center justify-between mb-2 gap-3">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">分析目标</label>
              <button
                type="button"
                onClick={handleReanalyzeProject}
                disabled={!canReanalyze || loadingTree || loadingAi || loadingSubFunctions}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:text-gray-300"
                title="重新执行整个项目分析"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                重新分析
              </button>
            </div>
            <input
              type="text"
              name="url"
              defaultValue={sourceType === 'github' ? url : sourceDescriptor?.location || ''}
              placeholder={sourceType === 'github' ? 'GitHub URL' : '本地项目来源由首页选择'}
              disabled={sourceType !== 'github'}
              className={`w-full px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm transition-all shadow-sm ${
                sourceType === 'github'
                  ? 'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500'
                  : 'text-gray-400 cursor-not-allowed'
              }`}
            />
          </form>

          <div className="mb-8 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center">
              <Activity className="w-4 h-4 mr-2 text-indigo-500" />
              项目概览
            </h2>
            {aiResult ? (
              <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-[13px] text-gray-600 leading-relaxed">
                <p className="m-0">{aiResult.projectSummary}</p>
              </div>
            ) : loadingAi ? (
              <div className="flex flex-col items-center justify-center text-gray-400 space-y-3 py-6 bg-white rounded-xl border border-gray-100 shadow-sm">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                <span className="text-sm">正在生成概览...</span>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm text-sm text-gray-400 italic text-center">
                等待分析完成...
              </div>
            )}
          </div>

          <div className="mb-8 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xs font-semibold text-gray-700 flex items-center">
                <FileText className="w-4 h-4 mr-2 text-indigo-500" />
                项目工程文件
              </h2>
              <button
                type="button"
                onClick={() => setIsProjectFileOpen(true)}
                disabled={!projectRecord}
                className="text-xs font-medium text-gray-400 hover:text-indigo-600 disabled:text-gray-300 transition-colors"
                title="查看项目工程文件"
              >
                查看
              </button>
            </div>
            <div className="rounded-[24px] border border-gray-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
              {projectRecord ? (
                <div className="space-y-5">
                  <p className="text-[13px] leading-7 text-gray-600">
                    Markdown 工程文件包含仓库信息、文件列表、调用栈、模块划分和 Agent 工作日志。
                  </p>
                  <div className="text-xs font-mono text-gray-400 break-all">{projectRecord.markdownPath}</div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setIsProjectFileOpen(true)}
                      className="inline-flex items-center rounded-2xl bg-[#111827] px-5 py-3 text-xs font-semibold text-white hover:bg-black transition-colors"
                    >
                      查看 Markdown
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyProjectFile}
                      className="inline-flex items-center rounded-2xl bg-gray-100 px-4 py-3 text-xs font-medium text-gray-700 hover:bg-gray-200 transition-colors"
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      复制
                    </button>
                    {copyStatus ? <span className="text-xs font-medium text-emerald-600">{copyStatus}</span> : null}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-[13px] leading-7 text-gray-400">
                    Markdown 工程文件会在分析完成后生成，包含仓库信息、文件列表、调用栈、模块划分和 Agent 工作日志。
                  </p>
                  <div className="text-xs font-mono text-gray-300 break-all">localstorage://markdown/待生成.md</div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center rounded-2xl bg-gray-200 px-5 py-3 text-xs font-semibold text-gray-400"
                    >
                      查看 Markdown
                    </button>
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center rounded-2xl bg-gray-100 px-4 py-3 text-xs font-medium text-gray-300"
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      复制
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mb-8 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">AI 调用统计</h2>
            {renderAiStatsCard()}
          </div>

          <div className="mb-8 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">工作流状态</h2>
              <button
                type="button"
                onClick={() => setIsLogModalOpen(true)}
                className="text-gray-400 hover:text-indigo-600 transition-colors flex items-center text-xs font-medium"
                title="查看日志"
              >
                <Maximize2 className="w-3.5 h-3.5 mr-1" />
                查看日志
              </button>
            </div>
            {renderWorkflowStatusCard()}
          </div>

          <div className="mb-8 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">AGENT 日志</h2>
              <button 
                onClick={() => setIsLogModalOpen(true)}
                className="text-gray-400 hover:text-indigo-600 transition-colors flex items-center text-xs font-medium"
                title="全屏查看日志"
              >
                <Maximize2 className="w-3.5 h-3.5 mr-1" />
                展开
              </button>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm max-h-[250px] overflow-y-auto">
              {logs.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-4">暂无日志</div>
              ) : (
                <div className="space-y-1">
                  {logs.map(log => (
                    <LogItem key={log.id} log={log} />
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </div>
          </div>

          <div className="mb-8 shrink-0">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">模块划分</h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void runModuleAnalysis({ mode: 'manual' })}
                  disabled={!canRunModuleAnalysis || loadingModules}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:text-gray-300"
                >
                  {loadingModules ? '分析中...' : '重新分析'}
                </button>
                {selectedModuleId ? (
                  <button
                    type="button"
                    onClick={() => setSelectedModuleId(null)}
                    className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
                  >
                    清除筛选
                  </button>
                ) : null}
              </div>
            </div>

            {loadingModules ? (
              <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm flex items-center justify-center gap-2 text-sm text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
                正在生成模块划分...
              </div>
            ) : moduleAnalysis?.modules.length ? (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setSelectedModuleId(null)}
                  className={clsx(
                    'w-full rounded-xl border px-4 py-3 text-left transition-colors',
                    selectedModuleId === null
                      ? 'border-gray-900 bg-gray-900 text-white'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300',
                  )}
                >
                  <div className="text-sm font-semibold">全部模块</div>
                  <div className={clsx('mt-1 text-xs', selectedModuleId === null ? 'text-gray-200' : 'text-gray-500')}>
                    显示全部函数节点，不做模块筛选。
                  </div>
                </button>

                <div className="space-y-2">
                  {moduleAnalysis.modules.map((module) => {
                    const selected = selectedModuleId === module.id;
                    return (
                      <button
                        key={module.id}
                        type="button"
                        onClick={() => setSelectedModuleId((prev) => (prev === module.id ? null : module.id))}
                        className={clsx(
                          'w-full rounded-xl border px-4 py-3 text-left transition-all',
                          selected
                            ? 'border-gray-900 bg-gray-900 text-white shadow-sm'
                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:shadow-sm',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="h-2.5 w-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: module.color }}
                            />
                            <span className="truncate text-sm font-semibold">{module.name}</span>
                          </div>
                          <span className={clsx('shrink-0 text-xs font-medium', selected ? 'text-gray-200' : 'text-gray-400')}>
                            {module.functions.length} 个函数
                          </span>
                        </div>
                        <div className={clsx('mt-2 text-xs leading-relaxed', selected ? 'text-gray-200' : 'text-gray-500')}>
                          {module.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-sm text-gray-400 text-center">
                {canRunModuleAnalysis ? '当前快照尚未生成模块划分，可点击右上角“重新分析”补跑模块分析。' : '等待生成模块划分...'}
              </div>
            )}
          </div>

          <div className="flex-1 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">技术栈分析</h2>
            
            {aiResult ? (
              <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm space-y-6">
                <div>
                  <h3 className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">主要编程语言</h3>
                  <div className="inline-flex items-center px-3 py-1 rounded-md bg-indigo-50 text-indigo-700 text-sm font-semibold">
                    {aiResult.mainLanguage}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">技术栈</h3>
                  <div className="flex flex-wrap gap-2">
                    {aiResult.techStack.map((tech, i) => (
                      <span key={i} className="px-2.5 py-1 bg-gray-50 text-gray-700 rounded-md text-xs font-medium border border-gray-200">
                        {tech}
                      </span>
                    ))}
                    {aiResult.techStack.length === 0 && <span className="text-sm text-gray-400">未识别到明显技术栈</span>}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">可能的主入口文件</h3>
                  {aiResult.verifiedEntryFile && aiResult.verifiedEntryReason ? (
                    <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
                      <div className="text-xs font-semibold text-emerald-700">已确认入口文件</div>
                      <div className="mt-1 text-xs font-mono break-all text-emerald-800">{aiResult.verifiedEntryFile}</div>
                      <div className="mt-2 text-xs leading-relaxed text-emerald-700">
                        <span className="font-semibold">研判理由：</span>
                        {aiResult.verifiedEntryReason}
                      </div>
                    </div>
                  ) : verifyEntryStepStatus === 'running' ? (
                    <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-xs leading-relaxed text-blue-700">
                      正在验证入口文件，确认后会在这里标记最终入口并显示研判理由。
                    </div>
                  ) : verifyEntryStepStatus === 'failed' ? (
                    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs leading-relaxed text-amber-700">
                      暂未确认最终入口文件，请结合候选入口和日志继续查看分析过程。
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {candidateEntryFiles.map((file, i) => (
                      <div key={`${file}-${i}`} className={`text-xs font-mono p-2.5 rounded-md border truncate ${aiResult.verifiedEntryFile === file ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold' : 'text-gray-600 bg-gray-50 border-gray-200'}`} title={file}>
                        {file}
                        {aiResult.verifiedEntryFile === file && <span className="ml-2 text-[10px] uppercase tracking-wider bg-emerald-100 px-1.5 py-0.5 rounded text-emerald-600">已确认</span>}
                      </div>
                    ))}
                    {candidateEntryFiles.length === 0 && <span className="text-sm text-gray-400">未识别到入口文件</span>}
                  </div>
                </div>
              </div>
            ) : loadingAi ? (
              <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm flex flex-col items-center justify-center text-gray-400 space-y-3">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                <span className="text-sm">AI 正在分析...</span>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm h-32 flex items-center justify-center text-gray-400 text-sm">
                等待分析...
              </div>
            )}
            </div>
            </Panel>
            {(showPanel2 || showPanel3 || showPanel4) && <PanelResizeHandle className="w-1 bg-gray-200 hover:bg-indigo-400 transition-colors cursor-col-resize" />}
          </>
        )}

        {/* Column 2: File Tree (Middle) */}
        {showPanel2 && (
          <>
            <Panel defaultSize={25} minSize={10} className="bg-white flex flex-col">
              <div className="p-4 border-b border-gray-100 bg-gray-50/50 shrink-0">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">文件结构</h2>
              </div>
          <div className="flex-1 overflow-y-auto p-3">
            {loadingTree ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              </div>
            ) : error ? (
              <div className="p-4 text-red-500 text-sm bg-red-50 rounded-lg">{error}</div>
            ) : (
              <FileTree nodes={tree} onSelect={handleSelectFile} selectedPath={selectedFile?.path} />
            )}
          </div>
            </Panel>
            {(showPanel3 || showPanel4) && <PanelResizeHandle className="w-1 bg-gray-200 hover:bg-indigo-400 transition-colors cursor-col-resize" />}
          </>
        )}

        {/* Column 3: Code Viewer (Right) */}
        {showPanel3 && (
          <>
            <Panel defaultSize={25} minSize={20} className="bg-white flex flex-col min-w-0">
              {selectedFile ? (
            <>
              <div className="h-12 border-b border-gray-100 flex items-center px-4 bg-gray-50/50 shrink-0">
                <span className="text-sm font-mono text-gray-600 truncate">{selectedFile.path}</span>
              </div>
              <div className="flex-1 overflow-hidden relative">
                {loadingFile ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                    <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                  </div>
                ) : null}
                <CodeViewer
                  code={fileContent}
                  filename={selectedFile.name}
                  highlightedStartLine={codeFocusRange?.startLine}
                  highlightedEndLine={codeFocusRange?.endLine}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 bg-gray-50/30">
              <div className="text-center">
                <div className="w-16 h-16 bg-white rounded-2xl border border-gray-100 shadow-sm flex items-center justify-center mx-auto mb-4">
                  <Github className="w-8 h-8 text-gray-300" />
                </div>
                <p className="text-sm">在左侧选择一个文件以查看代码</p>
              </div>
            </div>
          )}
            </Panel>
            {showPanel4 && <PanelResizeHandle className="w-1 bg-gray-200 hover:bg-indigo-400 transition-colors cursor-col-resize" />}
          </>
        )}

        {/* Column 4: Panorama (Far Right) */}
        {showPanel4 && (
          <Panel defaultSize={25} minSize={20} className="bg-white flex flex-col min-w-0">
            <div className="h-12 border-b border-gray-100 flex items-center px-4 bg-gray-50/50 shrink-0">
              <span className="text-sm font-semibold text-gray-600 truncate">函数调用全景图</span>
              {loadingSubFunctions && <Loader2 className="w-4 h-4 ml-2 animate-spin text-indigo-500" />}
            </div>
            <div className="flex-1 overflow-hidden relative">
              <Panorama
                data={subFunctionResult}
                entryFile={aiResult?.verifiedEntryFile || ''}
                moduleMap={moduleMap}
                selectedModuleId={selectedModuleId}
                drillingNodeId={manualDrillNodeId || (loadingSubFunctions ? '__loading__' : null)}
                viewportRef={panoramaViewportRef}
                onNodeSelect={handlePanoramaNodeSelect}
                onNodeDrillDown={handlePanoramaNodeDrillDown}
              />
            </div>
          </Panel>
        )}
      </PanelGroup>

      {/* Log Modal Overlay */}
      {isLogModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-100 bg-gray-50/80">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                <Activity className="w-5 h-5 mr-2 text-indigo-500" />
                完整 AGENT 日志
              </h2>
              <button 
                onClick={() => setIsLogModalOpen(false)} 
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-200/50 p-1.5 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
              <div className="space-y-6">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">工作流状态</h3>
                    {renderWorkflowStatusCard()}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">AI 调用统计</h3>
                    {renderAiStatsCard()}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">调用过程日志</h3>
                  {logs.length === 0 ? (
                    <div className="text-center text-gray-400 py-10 bg-white rounded-xl border border-gray-100 shadow-sm">暂无日志</div>
                  ) : (
                    <div className="space-y-2">
                      {logs.map((log) => (
                        <div key={log.id} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                          <LogItem log={log} defaultExpanded={true} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isProjectFileOpen && projectRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-100 bg-gray-50/80">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                  <FileText className="w-5 h-5 mr-2 text-indigo-500" />
                  项目工程文件
                </h2>
                <div className="mt-1 text-xs font-mono text-gray-400 truncate">{projectRecord.markdownPath}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyProjectFile}
                  className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  复制
                </button>
                <button
                  onClick={() => setIsProjectFileOpen(false)}
                  className="text-gray-400 hover:text-gray-700 hover:bg-gray-200/50 p-1.5 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
              <pre className="m-0 rounded-2xl border border-gray-800 bg-gray-950 p-5 text-sm leading-6 text-gray-100 whitespace-pre-wrap break-words shadow-sm">
                {projectRecord.markdown}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
