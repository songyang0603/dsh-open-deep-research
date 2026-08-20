# 🔬 DSH Open Deep Research

[English](./README.md)

DSH Open Deep Research 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Deep Research Agent 与 TypeScript 框架。它接收研究问题，生成带引用链接的 Markdown 报告，并通过 CLI、DSH Tool 和程序化 API 提供同一项研究服务。

> **项目状态：** `0.1.0-alpha.5` 开发候选版本，已使用正式发布的 DSH `0.1.0-rc.8` 完成测试。Alpha.5 尚未创建 Release，也未发布到 npm。

## 核心能力

- 规划一到三个研究单元，通过 DSH 子 Agent 执行，并综合各单元的结果。
- 两个专用 Profile 都支持网页搜索，`research-jina` 还可读取选定网页或 PDF。
- 输出带引用链接的 Markdown 报告、去重后的链接、终止状态与运行元数据。
- 通过可替换的 `ResearchEngine` 提供 CLI、DSH Tool 和 TypeScript 三种入口。

## 🏗️ 架构

```mermaid
flowchart TD
  USER["用户或应用"] --> ENTRY{"调用入口"}

  ENTRY --> CLI["专用 Research CLI"]
  ENTRY --> TOOL["open_deep_research Tool"]
  ENTRY --> API["createResearchClient()"]

  CLI --> ENGINE["ResearchEngine"]
  TOOL --> ENGINE
  API --> ENGINE

  ENGINE --> PLAN["Planning Agent<br/>生成 brief 和一到三个单元"]
  PLAN --> RESEARCH["Research Agents<br/>受限并发研究"]
  RESEARCH --> SYNTHESIS["Synthesis Agent<br/>生成带引用报告"]
  SYNTHESIS --> RESULT["Markdown 报告<br/>ResearchResult"]

  RESEARCH --> SEARCH["DSH web_search"]
  RESEARCH -. "仅 research-jina" .-> JINA["Jina MCP read_url"]

  DSH["DeepSeek Harness<br/>模型、工具、Preset、Session、子 Agent、取消"]
  DSH -. "运行和管理" .-> PLAN
  DSH -. "运行和管理" .-> RESEARCH
  DSH -. "运行和管理" .-> SYNTHESIS
```

三个入口调用同一个 `ResearchEngine`，当前 Profile 决定研究子 Agent 可以调用哪些来源工具。生命周期、Profile 组合、配置与结果语义见[架构说明](./docs/architecture.md)。

## 🚀 快速开始

请从源码构建当前开发安装包。下方命令使用构建生成的 `dsh-open-deep-research-0.1.0-alpha.5.tgz`。

| Profile         | 来源能力                | 凭证                     | 网络要求                      |
| --------------- | ----------------------- | ------------------------ | ----------------------------- |
| `research-jina` | 网页搜索和网页/PDF 阅读 | DeepSeek Key 与 Jina Key | DeepSeek API 和 `mcp.jina.ai` |
| `research`      | 仅网页搜索              | DeepSeek Key             | DeepSeek API                  |

环境要求：Node.js `^22.19.0` 或 `>=24.0.0`、PATH 中可用的 pnpm `10.x`、DeepSeek Harness `0.1.0-rc.8`。

DSH 管理 Profile 插件时还会调用 `pnpm`。安装前请确认 `npx` 和 `pnpm` 均可用：

```bash
node --version
pnpm --version
```

如果第二条命令不可用，请参考 [pnpm 安装说明](https://pnpm.io/installation)。

### 1. 构建安装包

```bash
git clone https://github.com/songyang0603/dsh-open-deep-research.git
cd dsh-open-deep-research
pnpm install --frozen-lockfile
pnpm pack
```

完成后，仓库根目录中会出现 `dsh-open-deep-research-0.1.0-alpha.5.tgz`。Alpha.5 发布后，这里会改为直接下载 Release 安装包。

`plugin add` 可能显示 host peer warning。命令退出码为 `0` 时，可以继续初始化。

### 2. 完整研究：搜索并读取正文（推荐）

`research-jina` 提供网页搜索和正文阅读。它会把选定的公开 URL 发送给 Jina，不会发送浏览器 Cookie。请使用公开且不含敏感信息的 URL，避免签名 URL、依赖登录态的 URL、私有网络 URL 和内网 URL。

设置两把 Key：

```bash
export DEEPSEEK_API_KEY='<your-deepseek-key>'
export JINA_API_KEY='<your-jina-key>'
```

```bash
npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile research-jina add \
  ./dsh-open-deep-research-0.1.0-alpha.5.tgz

npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile research-jina exec \
  dsh-open-deep-research-init --reader jina

npx @deepseek-ai/dsh@0.1.0-rc.8 --profile research-jina \
  --breadth balanced \
  --language zh-CN \
  "调研 DeepSeek Harness rc.8 的主要变化，搜索相关材料，阅读重要来源正文，并生成带引用链接的报告。"
```

研究子 Agent 会根据任务选择来源工具，Profile 不会规定固定调用次数。Reader 每次最多返回 8,000 tokens，长文档可能被截断。Jina 初始化长时间未完成时，请先检查当前网络能否访问 `mcp.jina.ai`，或使用下方的仅搜索 Profile。

### 3. 仅搜索：只需 DeepSeek Key

没有 Jina Key 或 Jina 网络不可达时，可以使用独立的 `research` Profile。它仍会执行规划、网页搜索、多个研究单元、综合和报告生成，但无法稳定读取网页或 PDF 的完整正文。

```bash
export DEEPSEEK_API_KEY='<your-deepseek-key>'

npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile research add \
  ./dsh-open-deep-research-0.1.0-alpha.5.tgz

npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile research exec \
  dsh-open-deep-research-init

npx @deepseek-ai/dsh@0.1.0-rc.8 --profile research \
  --language zh-CN \
  "调研 DeepSeek Harness rc.8 的主要变化并生成报告。"
```

### 4. 保存输出

Markdown 模式会把报告写入 stdout，可以直接重定向到文件：

```bash
npx @deepseek-ai/dsh@0.1.0-rc.8 --profile research-jina \
  "比较两种研究方法" > report.md
```

干净环境首次执行 `npx @deepseek-ai/dsh` 时，下载和构建依赖可能需要数分钟，期间输出较少。请等待命令退出后再重试。两个 Profile 相互独立，不会覆盖对方，也不会自动降级。

## ⚙️ 配置

| 参数         | 取值                                                  | 默认值         |
| ------------ | ----------------------------------------------------- | -------------- |
| `--purpose`  | 自由文本                                              | 不设置         |
| `--context`  | 自由文本                                              | 不设置         |
| `--breadth`  | `focused`、`balanced`、`broad`                        | `balanced`     |
| `--format`   | `report`、`brief`、`memo`                             | `report`       |
| `--language` | 语言名称或 locale                                     | 问题使用的语言 |
| `--json`     | 对 `completed` 或 `partial` 输出完整 `ResearchResult` | 关闭           |

`breadth` 决定研究单元上限，分别为一个、两个或三个，Planning 可以选择更少的单元。模型路由、Preset、工作目录、来源工具允许列表和最大研究并发等 Provider 配置见[架构说明](./docs/architecture.md#provider-configuration)。

`completed` 和 `partial` 的退出码为 `0`，`partial` 还会向 stderr 写入简短提示。执行失败使用 `1`，参数错误使用 `2`，用户中断使用 `130`。失败或取消时 stdout 为空。

## 在 DSH 与 TypeScript 中使用

将同一个 tarball 安装到 stock DSH Profile，可以把 `open_deep_research` 作为 Tool 使用：

```bash
npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile headless add \
  ./dsh-open-deep-research-0.1.0-alpha.5.tgz

npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add \
  ./dsh-open-deep-research-0.1.0-alpha.5.tgz
```

stock `headless` 和 `web` 只会获得 Provider 与 Tool，其来源能力由配置的 `allowedTools` 决定。

普通 Agent 调用中，Tool 会使用当前轮对话的直接用户文本作为研究问题。Tool 不接收模型补写的 `purpose` 或 `context`。需要显式传入这些字段时，请使用专用 CLI 或 TypeScript API。当前消息存在未说明的历史指代时，应先请用户补充上下文。

TypeScript API 可以直接调用当前 `ResearchEngine`：

```ts
import { createResearchClient } from 'dsh-open-deep-research'

const result = await createResearchClient(ctx).run({
  question: 'DeepSeek Harness 如何组合 Agent Preset？',
  purpose: '为插件作者准备架构说明。',
  breadth: 'balanced',
  output: { format: 'report', language: '简体中文' },
})

console.log(result.status)
console.log(result.report)
```

需要取消任务时，可用 `createResearchClient(ctx).start()` 获取 `ResearchRun`。完整 API 行为见[领域契约](./docs/architecture.md#domain-contract)。

### 在本地 Web UI 中测试

将安装包加入 DSH `web` Profile：

```bash
export DEEPSEEK_API_KEY='<your-deepseek-key>'

npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add \
  ./dsh-open-deep-research-0.1.0-alpha.5.tgz

npx @deepseek-ai/dsh@0.1.0-rc.8 web
```

DSH 会在 `http://127.0.0.1:3080` 启动 Web UI。新建对话后可以输入：

> 请调用 `open_deep_research` 工具，调研 DeepSeek Harness rc.8 的主要变化，并生成带引用链接的中文报告。

这条 stock Web 安装路径默认提供仅搜索能力。推荐的搜索加正文阅读组合目前通过专用 `research-jina` CLI Profile 提供。

## 兼容性与当前限制

| 范围                     | 当前状态                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| DSH `0.1.0-rc.8`         | 当前开发与兼容线。                                                                 |
| Jina Reader              | 已完成真实运行测试，可用性仍取决于部署网络。                                       |
| 文档与工具调用           | 已测试短网页和短 PDF。长输入可能被截断，来源调用次数属于 Prompt 约束。             |
| `ResearchResult.sources` | 最终报告中的 HTTP 链接去重结果。仅有链接不能证明已经读取正文，也不能证明来源质量。 |
| MCP 启动                 | 网络无响应时可能经历多个 SDK timeout。`plugin add` 还可能显示 host peer warning。  |

项目文档：[架构说明](./docs/architecture.md) · [Changelog](./CHANGELOG.md) · [贡献指南](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

## License

[MIT](./LICENSE)
