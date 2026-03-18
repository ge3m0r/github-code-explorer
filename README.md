## GitHub Code Explorer

Github Code Explorer 是一个用于分析 GitHub 仓库或本地工程代码结构的可视化工具，可以自动：

- **解析项目文件树**，区分代码文件与非代码文件
- **调用 AI 分析技术栈与入口文件**
- **生成函数调用全景图**，支持点击节点跳转并高亮对应代码范围
- **对项目函数进行模块划分**，帮助你从“架构视角”理解工程
- **导出工程 Markdown 报告** 和 全景图截图，方便归档与分享

### 本地运行

**前置条件：** 已安装 Node.js（建议 18+）

1. 安装依赖  
   ```bash
   npm install
   ```
2. 配置环境变量  
   参考 `.env.example` 创建 `.env` 文件，并至少设置：
   - `AI_API_KEY`：用于调用 AI 接口的密钥  
   其他可选变量如 `AI_BASE_URL`、`AI_MODEL`、`AI_DRILL_DOWN_MAX_DEPTH`、`AI_KEY_SUB_FUNCTIONS_PER_LAYER`、`GITHUB_TOKEN` 等，可根据需要调整。
3. 启动开发服务器  
   ```bash
   npm run dev
   ```
4. 在浏览器中访问终端输出的本地地址（默认 `http://localhost:3000`），即可使用：
   - 在首页输入 GitHub 仓库地址或选择本地项目
   - 等待分析完成后查看函数调用全景图和工程报告
