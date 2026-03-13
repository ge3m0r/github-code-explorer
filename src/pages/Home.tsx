import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Github } from 'lucide-react';
import { parseGithubUrl } from '../lib/github';

export default function Home() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const repoInfo = parseGithubUrl(url);
    if (!repoInfo) {
      setError('请输入有效的 GitHub 项目地址，例如：https://github.com/facebook/react');
      return;
    }
    navigate(`/analyze?url=${encodeURIComponent(url)}`);
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-3xl flex flex-col items-center text-center space-y-8">
        <div className="flex items-center justify-center w-20 h-20 bg-white rounded-3xl shadow-sm border border-gray-100 mb-4">
          <Github className="w-10 h-10 text-gray-800" />
        </div>
        
        <h1 className="text-5xl md:text-6xl font-medium text-gray-900 tracking-tight">
          探索代码的艺术
        </h1>
        <p className="text-lg md:text-xl text-gray-500 max-w-2xl font-light">
          输入 GitHub 项目地址，以直观的树形结构和优雅的代码视图，深入分析任何开源项目。
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
    </div>
  );
}
