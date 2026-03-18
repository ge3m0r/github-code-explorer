import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Github,
  History,
  ArrowUpRight,
  FileCode2,
  FolderOpen,
  Archive,
  HardDrive,
  Settings as SettingsIcon,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import { parseGithubUrl } from '../lib/github';
import {
  getProjectHistory,
  getProjectHistoryRecordBySource,
  getProjectHistoryRecordByUrl,
  normalizeGithubUrl,
  ProjectAnalysisRecord,
} from '../lib/history';
import { registerLocalSession } from '../lib/localSession';
import { getSettings, getSettingsEnvSnapshot, saveSettings, subscribeSettings, type AppSettings } from '../lib/settings';

type HomeMode = 'github' | 'local';

function getSourceBadge(record: ProjectAnalysisRecord) {
  if (record.sourceType === 'local') {
    return {
      label: '本地分析',
      className: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    };
  }
  return {
    label: 'GitHub 分析',
    className: 'bg-sky-50 text-sky-700 border border-sky-200',
  };
}

export default function Home() {
  const [mode, setMode] = useState<HomeMode>('github');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ProjectAnalysisRecord[]>([]);
  const navigate = useNavigate();
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showAiApiKeyEditor, setShowAiApiKeyEditor] = useState(false);
  const [showGithubTokenEditor, setShowGithubTokenEditor] = useState(false);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(() => getSettings());

  useEffect(() => {
    setHistory(getProjectHistory());
  }, []);

  useEffect(() => {
    return subscribeSettings((next) => {
      setSettings(next);
    });
  }, []);

  const isSameSettings = (a: AppSettings, b: AppSettings) => {
    return (
      a.aiBaseUrl === b.aiBaseUrl &&
      a.aiApiKey === b.aiApiKey &&
      a.aiModel === b.aiModel &&
      a.githubToken === b.githubToken &&
      a.maxDrillDepth === b.maxDrillDepth &&
      a.maxKeySubFunctionsPerLayer === b.maxKeySubFunctionsPerLayer
    );
  };

  const handleAnalyzeGithub = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const env = getSettingsEnvSnapshot();
    if (!settings.aiApiKey && !env.aiApiKeyConfigured) {
      setShowAiApiKeyEditor(true);
      setDraftSettings(getSettings());
      setIsSettingsOpen(true);
      setError('开始分析前请先在设置中配置 AI_API_KEY。');
      return;
    }

    const repoInfo = parseGithubUrl(url);
    if (!repoInfo) {
      setError('请输入有效的 GitHub 项目地址，例如：https://github.com/facebook/react');
      return;
    }

    const normalizedUrl = normalizeGithubUrl(url);
    const existingRecord = getProjectHistoryRecordByUrl(normalizedUrl);

    if (existingRecord) {
      navigate(
        `/analyze?source=github&url=${encodeURIComponent(existingRecord.url)}&history=${encodeURIComponent(existingRecord.id)}`,
      );
      return;
    }

    navigate(`/analyze?source=github&url=${encodeURIComponent(normalizedUrl)}&run=${Date.now()}`);
  };

  const handleAnalyzeLocalDirectory = () => {
    setError('');
    directoryInputRef.current?.click();
  };

  const handleAnalyzeLocalArchive = () => {
    setError('');
    archiveInputRef.current?.click();
  };

  const handleDirectorySelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selectedFiles.length) {
      return;
    }

    const env = getSettingsEnvSnapshot();
    if (!settings.aiApiKey && !env.aiApiKeyConfigured) {
      setShowAiApiKeyEditor(true);
      setDraftSettings(getSettings());
      setIsSettingsOpen(true);
      setError('开始分析前请先在设置中配置 AI_API_KEY。');
      return;
    }

    const session = registerLocalSession({
      mode: 'directory',
      files: selectedFiles,
    });
    const existingRecord = getProjectHistoryRecordBySource('local', session.descriptor.id);
    if (existingRecord) {
      navigate(`/analyze?source=local&history=${encodeURIComponent(existingRecord.id)}`);
      return;
    }

    navigate(`/analyze?source=local&session=${encodeURIComponent(session.sessionId)}&run=${Date.now()}`);
  };

  const handleArchiveSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const archive = event.target.files?.[0];
    event.target.value = '';
    if (!archive) {
      return;
    }

    const env = getSettingsEnvSnapshot();
    if (!settings.aiApiKey && !env.aiApiKeyConfigured) {
      setShowAiApiKeyEditor(true);
      setDraftSettings(getSettings());
      setIsSettingsOpen(true);
      setError('开始分析前请先在设置中配置 AI_API_KEY。');
      return;
    }

    const lower = archive.name.toLowerCase();
    if (!/(\.zip|\.tar|\.tar\.gz|\.tgz|\.rar)$/.test(lower)) {
      setError('仅支持 zip、tar、tar.gz、tgz、rar 压缩包。');
      return;
    }

    const session = registerLocalSession({
      mode: 'archive',
      archive,
    });
    const existingRecord = getProjectHistoryRecordBySource('local', session.descriptor.id);
    if (existingRecord) {
      navigate(`/analyze?source=local&history=${encodeURIComponent(existingRecord.id)}`);
      return;
    }

    navigate(`/analyze?source=local&session=${encodeURIComponent(session.sessionId)}&run=${Date.now()}`);
  };

  const handleOpenHistory = (record: ProjectAnalysisRecord) => {
    if (record.sourceType === 'local') {
      navigate(`/analyze?source=local&history=${encodeURIComponent(record.id)}`);
      return;
    }
    navigate(
      `/analyze?source=github&url=${encodeURIComponent(record.url)}&history=${encodeURIComponent(record.id)}`,
    );
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col items-center p-4 font-sans">
      <div className="w-full max-w-5xl flex justify-end pt-2">
        <button
          type="button"
          onClick={() => {
            setShowAiApiKeyEditor(false);
            setShowGithubTokenEditor(false);
            setDraftSettings(getSettings());
            setIsSettingsOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 shadow-sm"
          title="设置"
        >
          <SettingsIcon className="w-4 h-4" />
          设置
        </button>
      </div>

      <input
        ref={directoryInputRef}
        type="file"
        multiple
        className="hidden"
        {...({ webkitdirectory: 'true', directory: 'true' } as any)}
        onChange={handleDirectorySelected}
      />
      <input
        ref={archiveInputRef}
        type="file"
        className="hidden"
        accept=".zip,.tar,.tar.gz,.tgz,.rar"
        onChange={handleArchiveSelected}
      />

      <div className="w-full max-w-5xl py-12 md:py-16">
        <div className="max-w-3xl mx-auto flex flex-col items-center text-center space-y-8">
          <div className="flex items-center justify-center w-20 h-20 bg-white rounded-3xl shadow-sm border border-gray-100 mb-4">
            {mode === 'github' ? (
              <Github className="w-10 h-10 text-gray-800" />
            ) : (
              <HardDrive className="w-10 h-10 text-gray-800" />
            )}
          </div>

          <h1 className="text-5xl md:text-6xl font-medium text-gray-900 tracking-tight">代码全景分析</h1>
          <p className="text-lg md:text-xl text-gray-500 max-w-2xl font-light">
            支持 GitHub 仓库和本地工程分析，自动生成函数调用全景图与项目工程文件。
          </p>

          <div className="mt-2 inline-flex rounded-full border border-gray-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => {
                setMode('github');
                setError('');
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                mode === 'github' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              GitHub 项目
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('local');
                setError('');
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                mode === 'local' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              本地项目
            </button>
          </div>

          {mode === 'github' ? (
            <form onSubmit={handleAnalyzeGithub} className="w-full max-w-xl mt-8 relative">
              <div className="mb-3 text-xs text-gray-500 flex items-center justify-between gap-3">
                <div className="truncate">
                  AI_KEY：{settings.aiApiKey || getSettingsEnvSnapshot().aiApiKeyConfigured ? '已配置（不显示）' : '未配置'}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAiApiKeyEditor(true);
                    setDraftSettings(getSettings());
                    setIsSettingsOpen(true);
                  }}
                  className="text-gray-700 hover:text-gray-900 underline underline-offset-2"
                >
                  去设置
                </button>
              </div>
              <div className="relative flex items-center">
                <div className="absolute left-4 text-gray-400">
                  <Search className="w-5 h-5" />
                </div>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className="w-full pl-12 pr-32 py-4 rounded-full bg-white border border-gray-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-200 focus:border-transparent text-lg transition-all"
                />
                <button
                  type="submit"
                  className="absolute right-2 top-2 bottom-2 px-6 bg-gray-900 text-white rounded-full font-medium hover:bg-gray-800 transition-colors"
                >
                  开始分析
                </button>
              </div>
              {error && <p className="absolute -bottom-8 left-0 w-full text-red-500 text-sm">{error}</p>}
            </form>
          ) : (
            <div className="w-full max-w-xl mt-8 space-y-3">
              <div className="text-xs text-gray-500 flex items-center justify-between gap-3">
                <div className="truncate">
                  AI_KEY：{settings.aiApiKey || getSettingsEnvSnapshot().aiApiKeyConfigured ? '已配置（不显示）' : '未配置'}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAiApiKeyEditor(true);
                    setDraftSettings(getSettings());
                    setIsSettingsOpen(true);
                  }}
                  className="text-gray-700 hover:text-gray-900 underline underline-offset-2"
                >
                  去设置
                </button>
              </div>
              <button
                type="button"
                onClick={handleAnalyzeLocalDirectory}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-4 text-gray-700 font-medium hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <FolderOpen className="w-5 h-5" />
                选择本地项目目录并分析
              </button>
              <button
                type="button"
                onClick={handleAnalyzeLocalArchive}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-4 text-gray-700 font-medium hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <Archive className="w-5 h-5" />
                选择压缩包并分析（zip / tar / tar.gz / tgz / rar）
              </button>
              {error ? <p className="text-red-500 text-sm text-center">{error}</p> : null}
            </div>
          )}
        </div>

        {history.length > 0 && (
          <section className="mt-20">
            <div className="flex items-center justify-between mb-6 gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                  <History className="w-5 h-5 text-gray-700" />
                  历史分析记录
                </h2>
                <p className="text-sm text-gray-500 mt-1">已保存的工程文件和历史分析快照会显示在这里。</p>
              </div>
              <div className="text-xs text-gray-400 shrink-0">共 {history.length} 条</div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {history.map((record) => {
                const sourceBadge = getSourceBadge(record);
                return (
                  <button
                    key={record.id}
                    type="button"
                    onClick={() => handleOpenHistory(record)}
                    className="group h-full text-left bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-gray-300 transition-all flex flex-col"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-gray-400">
                          <FileCode2 className="w-3.5 h-3.5" />
                          历史快照
                        </div>
                        <h3 className="mt-2 text-lg font-semibold text-gray-900 truncate">{record.projectName}</h3>
                      </div>
                      <ArrowUpRight className="w-4 h-4 text-gray-300 group-hover:text-gray-700 transition-colors shrink-0 mt-1" />
                    </div>

                    <p className="mt-3 text-sm text-gray-500 line-clamp-2 min-h-10">
                      {record.projectSummary || '暂无项目简介'}
                    </p>

                    <div className="mt-4 flex flex-wrap gap-2 min-h-[72px] content-start">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${sourceBadge.className}`}>
                        {sourceBadge.label}
                      </span>
                      <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                        {record.mainLanguage || '待识别语言'}
                      </span>
                      {record.techStack.slice(0, 2).map((tech) => (
                        <span
                          key={tech}
                          className="px-2.5 py-1 rounded-full bg-[#f5f1e8] text-[#7d5c2f] text-xs font-medium"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>

                    <div className="mt-auto pt-4 space-y-2 text-xs text-gray-500">
                      <div className="truncate">地址：{record.url}</div>
                      <div>时间：{new Date(record.analyzedAt).toLocaleString('zh-CN', { hour12: false })}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-100 bg-gray-50/80">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                  <SettingsIcon className="w-5 h-5 mr-2 text-indigo-500" />
                  设置
                </h2>
                <div className="mt-1 text-xs text-gray-500">
                  启动时若检测到环境变量与本地存储不一致，将以环境变量为准。
                </div>
              </div>
              <button
                onClick={() => {
                  setIsSettingsOpen(false);
                  setDraftSettings(getSettings());
                  setShowAiApiKeyEditor(false);
                  setShowGithubTokenEditor(false);
                }}
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-200/50 p-1.5 rounded-lg transition-colors"
                title="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">AI 配置</h3>

                  <label className="block text-xs font-semibold text-gray-600 mb-1">AI_BASE_URL</label>
                  <input
                    type="text"
                    value={draftSettings.aiBaseUrl}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraftSettings((prev) => ({ ...prev, aiBaseUrl: value }));
                    }}
                    placeholder="例如 https://api.deepseek.com/v1（留空则使用 Gemini）"
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <label className="block text-xs font-semibold text-gray-600 mb-1">AI_API_KEY（保密）</label>
                      <div className="text-xs text-gray-400">{draftSettings.aiApiKey ? '已配置（不回显）' : '未配置'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAiApiKeyEditor((v) => !v)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300"
                      title={showAiApiKeyEditor ? '隐藏输入框' : '显示输入框'}
                    >
                      {showAiApiKeyEditor ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      {showAiApiKeyEditor ? '隐藏' : '编辑'}
                    </button>
                  </div>

                  {showAiApiKeyEditor && (
                    <input
                      type="password"
                      value={draftSettings.aiApiKey}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraftSettings((prev) => ({ ...prev, aiApiKey: value }));
                      }}
                      placeholder="输入后将持久化保存，本页面默认不回显"
                      className="mt-2 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  )}

                  <label className="block text-xs font-semibold text-gray-600 mb-1 mt-4">AI 模型名称（AI_MODEL）</label>
                  <input
                    type="text"
                    value={draftSettings.aiModel}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraftSettings((prev) => ({ ...prev, aiModel: value }));
                    }}
                    placeholder="例如 deepseek-chat"
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">GitHub 与分析参数</h3>

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-gray-600">Github token（保密）</div>
                      <div className="mt-1 text-xs text-gray-400">用途：提升 GitHub API 访问额度/访问需要鉴权的仓库。</div>
                      <div className="mt-1 text-xs text-gray-400">{draftSettings.githubToken ? '已配置（不回显）' : '未配置'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowGithubTokenEditor((v) => !v)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300"
                      title={showGithubTokenEditor ? '隐藏输入框' : '显示输入框'}
                    >
                      {showGithubTokenEditor ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      {showGithubTokenEditor ? '隐藏' : '编辑'}
                    </button>
                  </div>

                  {showGithubTokenEditor && (
                    <input
                      type="password"
                      value={draftSettings.githubToken}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraftSettings((prev) => ({ ...prev, githubToken: value }));
                      }}
                      placeholder="输入后将持久化保存，本页面默认不回显"
                      className="mt-2 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  )}

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1">最大下钻层数</label>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        value={draftSettings.maxDrillDepth}
                        onChange={(e) => {
                          const value = Number(e.target.value || 0);
                          setDraftSettings((prev) => ({ ...prev, maxDrillDepth: value }));
                        }}
                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                      <div className="mt-1 text-[11px] text-gray-400">默认 2</div>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1">每层关键调用子函数数量上限</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={draftSettings.maxKeySubFunctionsPerLayer}
                        onChange={(e) => {
                          const value = Number(e.target.value || 10);
                          setDraftSettings((prev) => ({ ...prev, maxKeySubFunctionsPerLayer: value }));
                        }}
                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                      <div className="mt-1 text-[11px] text-gray-400">默认 10</div>
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl border border-gray-100 bg-gray-50 p-4">
                    <div className="text-xs font-semibold text-gray-600 mb-2">环境变量检测</div>
                    {(() => {
                      const env = getSettingsEnvSnapshot();
                      return (
                        <div className="space-y-1 text-xs text-gray-500">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono">AI_BASE_URL</span>
                            <span className="truncate">{env.aiBaseUrl || '(未设置)'}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono">AI_MODEL</span>
                            <span className="truncate">{env.aiModel || '(未设置)'}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono">AI_DRILL_DOWN_MAX_DEPTH</span>
                            <span className="truncate">{String(env.maxDrillDepth)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono">AI_API_KEY</span>
                            <span>{env.aiApiKeyConfigured ? '已设置（不显示）' : '未设置'}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono">GITHUB_TOKEN</span>
                            <span>{env.githubTokenConfigured ? '已设置（不显示）' : '未设置'}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-gray-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-gray-400">
                  {isSameSettings(draftSettings, settings) ? '未修改' : '有未保存的修改'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraftSettings(getSettings());
                      setShowAiApiKeyEditor(false);
                      setShowGithubTokenEditor(false);
                    }}
                    className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                  >
                    取消修改
                  </button>
                  <button
                    type="button"
                    disabled={isSameSettings(draftSettings, settings)}
                    onClick={() => {
                      saveSettings(draftSettings);
                      setShowAiApiKeyEditor(false);
                      setShowGithubTokenEditor(false);
                    }}
                    className="inline-flex items-center rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

