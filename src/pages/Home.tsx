import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Github, History, ArrowUpRight, FileCode2 } from 'lucide-react';
import { parseGithubUrl } from '../lib/github';
import { getProjectHistory, getProjectHistoryRecordByUrl, normalizeGithubUrl, ProjectAnalysisRecord } from '../lib/history';

export default function Home() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ProjectAnalysisRecord[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    setHistory(getProjectHistory());
  }, []);

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const repoInfo = parseGithubUrl(url);
    if (!repoInfo) {
      setError('请输入有效的 GitHub 项目地址，例如：https://github.com/facebook/react');
      return;
    }

    const normalizedUrl = normalizeGithubUrl(url);
    const existingRecord = getProjectHistoryRecordByUrl(normalizedUrl);

    if (existingRecord) {
      navigate(`/analyze?url=${encodeURIComponent(existingRecord.url)}&history=${encodeURIComponent(existingRecord.id)}`);
      return;
    }

    navigate(`/analyze?url=${encodeURIComponent(normalizedUrl)}&run=${Date.now()}`);
  };

  const handleOpenHistory = (record: ProjectAnalysisRecord) => {
    navigate(`/analyze?url=${encodeURIComponent(record.url)}&history=${encodeURIComponent(record.id)}`);
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col items-center p-4 font-sans">
      <div className="w-full max-w-5xl py-12 md:py-16">
        <div className="max-w-3xl mx-auto flex flex-col items-center text-center space-y-8">
          <div className="flex items-center justify-center w-20 h-20 bg-white rounded-3xl shadow-sm border border-gray-100 mb-4">
            <Github className="w-10 h-10 text-gray-800" />
          </div>

          <h1 className="text-5xl md:text-6xl font-medium text-gray-900 tracking-tight">
            探索代码全景
          </h1>
          <p className="text-lg md:text-xl text-gray-500 max-w-2xl font-light">
            输入 GitHub 项目地址，分析仓库结构、技术栈、入口文件和函数调用关系，并生成可复用的项目工程文件。
          </p>

          <form onSubmit={handleAnalyze} className="w-full max-w-xl mt-8 relative">
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
            {error && (
              <p className="absolute -bottom-8 left-0 w-full text-red-500 text-sm">{error}</p>
            )}
          </form>
        </div>

        {history.length > 0 && (
          <section className="mt-20">
            <div className="flex items-center justify-between mb-6 gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                  <History className="w-5 h-5 text-gray-700" />
                  历史分析记录
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  已保存的工程文件和历史分析快照会显示在这里。
                </p>
              </div>
              <div className="text-xs text-gray-400 shrink-0">共 {history.length} 条</div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {history.map((record) => (
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
                      <h3 className="mt-2 text-lg font-semibold text-gray-900 truncate">
                        {record.projectName}
                      </h3>
                    </div>
                    <ArrowUpRight className="w-4 h-4 text-gray-300 group-hover:text-gray-700 transition-colors shrink-0 mt-1" />
                  </div>

                  <p className="mt-3 text-sm text-gray-500 line-clamp-2 min-h-10">
                    {record.projectSummary || '暂无项目简介'}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2 min-h-[72px] content-start">
                    <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                      {record.mainLanguage || '待识别语言'}
                    </span>
                    {record.techStack.slice(0, 3).map((tech) => (
                      <span key={tech} className="px-2.5 py-1 rounded-full bg-[#f5f1e8] text-[#7d5c2f] text-xs font-medium">
                        {tech}
                      </span>
                    ))}
                  </div>

                  <div className="mt-auto pt-4 space-y-2 text-xs text-gray-500">
                    <div className="truncate">地址：{record.url}</div>
                    <div>时间：{new Date(record.analyzedAt).toLocaleString('zh-CN', { hour12: false })}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
