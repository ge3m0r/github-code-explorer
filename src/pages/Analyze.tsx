import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { parseGithubUrl, fetchRepoTree, fetchFileContent, FileNode, extractCodeFiles } from '../lib/github';
import { analyzeProject, verifyEntryFile, analyzeSubFunctions, pickBestEntryFile, suggestFilesForFunction, analyzeFunctionSnippet, AiAnalysisResult, SubFunctionAnalysisResult, SubFunction } from '../lib/ai';
import { locateFunctionInProject, looksLikeSystemOrLibrary } from '../lib/functionLocator';
import { truncateJson } from '../lib/utils';
import FileTree from '../components/FileTree';
import CodeViewer from '../components/CodeViewer';
import Panorama from '../components/Panorama';
import { ArrowLeft, Github, Loader2, ChevronDown, ChevronRight, Activity, Maximize2, X, PanelLeftClose, PanelLeftOpen, FileCode2, Network, FolderTree } from 'lucide-react';
import { clsx } from 'clsx';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';

interface LogEntry {
  id: string;
  time: string;
  title: string;
  message: string;
  details?: any;
}

function LogItem({ log, defaultExpanded = false }: { log: LogEntry, defaultExpanded?: boolean }) {
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
  const url = searchParams.get('url') || '';
  
  const [repoInfo, setRepoInfo] = useState<{owner: string, repo: string} | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [error, setError] = useState('');
  
  const [aiResult, setAiResult] = useState<AiAnalysisResult | null>(null);
  const [loadingAi, setLoadingAi] = useState(false);
  
  const [subFunctionResult, setSubFunctionResult] = useState<SubFunctionAnalysisResult | null>(null);
  const [loadingSubFunctions, setLoadingSubFunctions] = useState(false);
  
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const analyzedUrlRef = useRef<string | null>(null);

  const [showPanel1, setShowPanel1] = useState(true);
  const [showPanel2, setShowPanel2] = useState(true);
  const [showPanel3, setShowPanel3] = useState(true);
  const [showPanel4, setShowPanel4] = useState(true);

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

  const maxDrillDepth = Math.max(0, parseInt(process.env.AI_DRILL_DOWN_MAX_DEPTH || '3', 10) || 3);

  /** 对单个子函数进行下钻：定位 -> 提取片段 -> AI 分析子函数 -> 递归处理 drillDown 0/1 的子孙。depth 从入口算起：1=入口的第一层子函数，2=再下一层 */
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
      addLog('下钻停止', `[${sub.name}] 已达最大下钻层数 ${maxDrillDepth}（从入口算起），停止下钻`);
      return { ...sub, stopReason: 'max_depth' };
    }
    const fetchContent = (path: string) => fetchFileContent(owner, repo, path);
    let suggestedFiles: string[] = [];
    try {
      const { result } = await suggestFilesForFunction(projectSummary, parentFilePath, sub.name, files);
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
      const { result } = await analyzeFunctionSnippet(
        projectSummary,
        sub.name,
        loc.snippet,
        loc.resolvedFile,
        files
      );
      childResult = result;
    } catch (e: any) {
      addLog('下钻失败', `[${sub.name}] 分析片段失败：${e.message}`);
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

  /** 对第一层子函数中 drillDown 为 0 或 1 的项进行下钻，每完成一个立即更新全景图，避免长时间无反馈 */
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

  useEffect(() => {
    if (logsEndRef.current && !isLogModalOpen) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isLogModalOpen]);

  useEffect(() => {
    if (!url || url === analyzedUrlRef.current) return;
    analyzedUrlRef.current = url;

    setLogs([]); // Reset logs on new URL
    const info = parseGithubUrl(url);
    if (!info) {
      setError('无效的项目地址');
      addLog('校验失败', `提供的 URL (${url}) 无法解析为有效的 GitHub 仓库地址。`);
      return;
    }
    setRepoInfo(info);
    addLog('校验成功', `成功解析 GitHub 地址：${info.owner}/${info.repo}`);
    loadTree(info.owner, info.repo);
  }, [url]);

  const loadTree = async (owner: string, repo: string) => {
    setLoadingTree(true);
    setError('');
    setAiResult(null);
    addLog('获取文件树', `正在请求 ${owner}/${repo} 的文件结构...`);
    try {
      const data = await fetchRepoTree(owner, repo);
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
      addLog('获取成功', `成功拉取项目结构，共包含 ${totalFiles} 个文件。`);
      
      const codeFiles = extractCodeFiles(data);
      addLog('过滤文件', `过滤非代码文件后，剩余 ${codeFiles.length} 个代码/配置文件。`);

      if (codeFiles.length > 0) {
        analyzeProjectFiles(codeFiles.slice(0, 1000), owner, repo);
      } else {
        addLog('分析跳过', '未找到可分析的代码文件。');
      }
    } catch (err: any) {
      setError(err.message || '获取项目结构失败');
      addLog('获取失败', `拉取项目结构时发生错误：${err.message}`);
    } finally {
      setLoadingTree(false);
    }
  };

  const analyzeProjectFiles = async (files: string[], owner: string, repo: string) => {
    setLoadingAi(true);
    addLog('AI 分析', `开始调用 AI 分析项目技术栈和入口文件...`);
    try {
      const { result, details } = await analyzeProject(files);
      setAiResult(result);
      addLog('AI 分析完成', `成功识别主要语言：${result.mainLanguage}，技术栈：${result.techStack.join(', ') || '无'}`, details);

      // Verify entry files
      if (result.entryFiles && result.entryFiles.length > 0) {
        addLog('入口研判', `AI 提供了 ${result.entryFiles.length} 个可能的入口文件，开始逐个研判...`);
        let foundEntry = false;
        const candidateContents: Array<{ filePath: string; content: string }> = [];
        for (const filePath of result.entryFiles) {
          addLog('读取文件', `正在获取可能的入口文件内容：${filePath}`);
          try {
            const fileContent = await fetchFileContent(owner, repo, filePath);
            candidateContents.push({ filePath, content: fileContent });
            addLog('研判文件', `开始调用 AI 研判文件：${filePath}`);
            const { result: verificationResult, details: verificationDetails } = await verifyEntryFile(
              `https://github.com/${owner}/${repo}`,
              result.projectSummary,
              result.mainLanguage,
              filePath,
              fileContent,
              files
            );
            
            if (verificationResult.isEntryFile) {
              addLog('研判成功', `确认 ${filePath} 是项目入口文件。理由：${verificationResult.reason}`, verificationDetails);
              setAiResult(prev => prev ? { ...prev, verifiedEntryFile: filePath, verifiedEntryReason: verificationResult.reason } : null);
              foundEntry = true;
              
              // Set initial subFunctionResult so Panorama can draw the entry node immediately
              setSubFunctionResult({
                entryFunctionName: 'Analyzing...', // Placeholder until we know the real name
                subFunctions: []
              });
              
              // Analyze sub-functions
              setLoadingSubFunctions(true);
              addLog('分析子函数', `开始分析入口文件 ${filePath} 的关键子函数，并传送了 ${files.length} 个项目文件路径作为上下文...`);
              try {
                const { result: subResult, details: subDetails } = await analyzeSubFunctions(
                  result.projectSummary,
                  filePath,
                  fileContent,
                  files
                );
                setSubFunctionResult(subResult);
                addLog('分析子函数完成', `成功识别 ${subResult.subFunctions.length} 个关键子函数。`, subDetails);
                const toDrill = subResult.subFunctions.filter(s => s.drillDown === 0 || s.drillDown === 1);
                if (toDrill.length > 0 && maxDrillDepth > 0) {
                  addLog('下钻分析', `将对 ${toDrill.length} 个关键子函数进行下钻（最大深度 ${maxDrillDepth}）...`);
                  runDrillDown(subResult, filePath, owner, repo, files, result.projectSummary).catch((err: any) => {
                    addLog('下钻异常', `下钻过程出错：${err.message}`);
                  }).finally(() => setLoadingSubFunctions(false));
                } else {
                  setLoadingSubFunctions(false);
                }
              } catch (err: any) {
                addLog('分析子函数失败', `分析子函数时发生错误：${err.message}`);
                setLoadingSubFunctions(false);
              }
              
              break; // Stop checking other files
            } else {
              addLog('研判失败', `${filePath} 不是项目入口文件。理由：${verificationResult.reason}`, verificationDetails);
            }
          } catch (err: any) {
            addLog('研判出错', `处理文件 ${filePath} 时发生错误：${err.message}`);
          }
        }
        if (!foundEntry && candidateContents.length > 0) {
          addLog('兜底研判', '所有候选均未单独确认，正在由 AI 对比所有候选文件并选出最可能的入口...');
          try {
            const { result: pickResult, details: pickDetails } = await pickBestEntryFile(
              `https://github.com/${owner}/${repo}`,
              result.projectSummary,
              result.mainLanguage,
              candidateContents,
              files
            );
            const bestPath = pickResult.bestEntryFile;
            const bestContent = candidateContents.find(c => c.filePath === bestPath)?.content ?? candidateContents[0].content;
            addLog('兜底结果', `AI 选出入口文件：${bestPath}。理由：${pickResult.reason}`, pickDetails);
            setAiResult(prev => prev ? { ...prev, verifiedEntryFile: bestPath, verifiedEntryReason: `[兜底] ${pickResult.reason}` } : null);
            setSubFunctionResult({
              entryFunctionName: 'Analyzing...',
              subFunctions: []
            });
            setLoadingSubFunctions(true);
            addLog('分析子函数', `开始分析兜底入口文件 ${bestPath} 的关键子函数...`);
            try {
              const { result: subResult, details: subDetails } = await analyzeSubFunctions(
                result.projectSummary,
                bestPath,
                bestContent,
                files
              );
              setSubFunctionResult(subResult);
              addLog('分析子函数完成', `成功识别 ${subResult.subFunctions.length} 个关键子函数。`, subDetails);
              const toDrill = subResult.subFunctions.filter(s => s.drillDown === 0 || s.drillDown === 1);
              if (toDrill.length > 0 && maxDrillDepth > 0) {
                addLog('下钻分析', `将对 ${toDrill.length} 个关键子函数进行下钻（最大深度 ${maxDrillDepth}）...`);
                runDrillDown(subResult, bestPath, owner, repo, files, result.projectSummary).catch((err: any) => {
                  addLog('下钻异常', `下钻过程出错：${err.message}`);
                }).finally(() => setLoadingSubFunctions(false));
              } else {
                setLoadingSubFunctions(false);
              }
            } catch (err: any) {
              addLog('分析子函数失败', `分析子函数时发生错误：${err.message}`);
              setLoadingSubFunctions(false);
            }
          } catch (err: any) {
            addLog('兜底研判失败', `对比选出入口时发生错误：${err.message}`);
          }
        } else if (!foundEntry) {
          addLog('研判结束', '所有可能的入口文件均已研判，未能确认最终入口。');
        }
      }

    } catch (err: any) {
      console.error('AI Analysis failed:', err);
      addLog('AI 分析失败', `调用 AI 时发生错误：${err.message}`);
    } finally {
      setLoadingAi(false);
    }
  };

  const handleSelectFile = async (node: FileNode) => {
    if (node.type !== 'blob') return;
    setSelectedFile(node);
    setLoadingFile(true);
    try {
      if (!repoInfo) return;
      const content = await fetchFileContent(repoInfo.owner, repoInfo.repo, node.path);
      setFileContent(content);
    } catch (err) {
      setFileContent('// 无法加载文件内容或文件为二进制格式');
    } finally {
      setLoadingFile(false);
    }
  };

  const handleUrlChange = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newUrl = formData.get('url') as string;
    if (newUrl) {
      navigate(`/analyze?url=${encodeURIComponent(newUrl)}`);
    }
  };

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
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">分析目标</label>
            <input
              type="text"
              name="url"
              defaultValue={url}
              placeholder="GitHub URL"
              className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
            />
          </form>

          <div className="mb-8 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center">
              <Activity className="w-4 h-4 mr-2 text-indigo-500" />
              项目概述
            </h2>
            {loadingAi ? (
              <div className="flex flex-col items-center justify-center text-gray-400 space-y-3 py-6 bg-white rounded-xl border border-gray-100 shadow-sm">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                <span className="text-sm">正在生成概述...</span>
              </div>
            ) : aiResult ? (
              <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-[13px] text-gray-600 leading-relaxed">
                <p className="m-0">{aiResult.projectSummary}</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm text-sm text-gray-400 italic text-center">
                等待分析完成...
              </div>
            )}
          </div>

          <div className="mb-8 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">工作日志</h2>
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

          <div className="flex-1 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">技术栈分析</h2>
            
            {loadingAi ? (
              <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm flex flex-col items-center justify-center text-gray-400 space-y-3">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                <span className="text-sm">AI 正在分析...</span>
              </div>
            ) : aiResult ? (
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
                  <div className="space-y-2">
                    {aiResult.entryFiles.map((file, i) => (
                      <div key={i} className={`text-xs font-mono p-2.5 rounded-md border truncate ${aiResult.verifiedEntryFile === file ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold' : 'text-gray-600 bg-gray-50 border-gray-200'}`} title={file}>
                        {file}
                        {aiResult.verifiedEntryFile === file && <span className="ml-2 text-[10px] uppercase tracking-wider bg-emerald-100 px-1.5 py-0.5 rounded text-emerald-600">已确认</span>}
                      </div>
                    ))}
                    {aiResult.entryFiles.length === 0 && <span className="text-sm text-gray-400">未识别到入口文件</span>}
                  </div>
                  {aiResult.verifiedEntryReason && (
                    <div className="mt-3 p-3 bg-emerald-50/50 border border-emerald-100 rounded-lg text-xs text-emerald-700 leading-relaxed">
                      <span className="font-semibold block mb-1">研判理由：</span>
                      {aiResult.verifiedEntryReason}
                    </div>
                  )}
                </div>
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
                <CodeViewer code={fileContent} filename={selectedFile.name} />
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
              <Panorama data={subFunctionResult} entryFile={aiResult?.verifiedEntryFile || ''} />
            </div>
          </Panel>
        )}
      </PanelGroup>

      {/* Log Modal Overlay */}
      {isLogModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-100 bg-gray-50/80">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                <Activity className="w-5 h-5 mr-2 text-indigo-500" />
                完整工作日志
              </h2>
              <button 
                onClick={() => setIsLogModalOpen(false)} 
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-200/50 p-1.5 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
              {logs.length === 0 ? (
                <div className="text-center text-gray-400 py-10">暂无日志</div>
              ) : (
                <div className="space-y-2">
                  {logs.map(log => (
                    <div key={log.id} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                      <LogItem log={log} defaultExpanded={true} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
