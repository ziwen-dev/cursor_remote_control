# Cursor 官方 SDK 功能梳理

> 核验日期 2026-11-24
>
> 本文依据 Cursor 官方 TypeScript SDK、Python SDK、SDK Bridge 文档以及 `@cursor/sdk` 1.4.2 的公开类型与包说明整理。官方文档会持续更新，接入前应以对应版本的 SDK Release Notes 和类型定义为准。

## 结论

Cursor 官方 SDK 是一套可编程的 Cursor Agent 运行时。它把 Cursor IDE、CLI 和 Web App 背后的 Agent 能力提供给应用代码，主要覆盖 Agent 生命周期、本地或云端执行、对话上下文、工具调用、流式事件、模型选择、MCP、子代理、权限控制、产物和用量统计。

它不是一个普通的大模型聊天补全 API。官方文档明确说明，Cursor SDK 是 Agent SDK，不是 standalone model-inference 或 chat-completions API。应用获得的是能够读取工作区、调用工具、执行命令和修改文件的 Agent。

官方 SDK 也不提供现成的远程控制页面。Cursor Remote Bridge 的 Web UI、远程鉴权、会话持久化、文件 Explorer 和 frp 接入都属于项目自身实现。SDK 提供执行层能力。

官方资料

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor Python SDK](https://cursor.com/docs/sdk/python)
- [Cursor SDK Bridge](https://cursor.com/docs/sdk/bridge)
- [Cursor SDK Release Notes](https://cursor.com/docs/release-notes/sdk)

## 接入方式

官方目前提供三条基本路径。

| 路径 | 适用语言 | 主要能力 | 是否一等支持 |
| --- | --- | --- | --- |
| TypeScript SDK | TypeScript、JavaScript、Node.js | 本地和云端 Agent 的全部主要能力 | 是 |
| Python SDK | Python 3.10 及以上 | 同步与异步 Agent、云端执行、流、模型、MCP 和工具 | 是 |
| SDK Bridge | Go、Rust、Java、C# 等其他语言 | 通过 Connect/protobuf 调用 `sdk.v1` 本地桥接服务 | 协议和二进制受支持，语言适配器需自行实现 |

TypeScript SDK 的 npm 包名是 `@cursor/sdk`。当前项目安装的是 1.4.2，2026-11-24 核对时 npm 的最新正式版为 1.4.2。TypeScript SDK 要求 Node.js 22.13 或更高版本。

Python SDK 的 pip 包名是 `cursor-sdk`，同时提供同步和异步客户端。Python SDK 通过随包附带的 `cursor-sdk-bridge` 与本机 Agent 能力通信。

官方资料

- [TypeScript 安装与运行时支持](https://cursor.com/docs/sdk/typescript#installation)
- [Python 安装与客户端](https://cursor.com/docs/sdk/python#installation)
- [SDK Bridge 适用场景](https://cursor.com/docs/sdk/bridge#when-to-use-it)

## 功能矩阵

| 功能 | TypeScript | Python | 说明 |
| --- | --- | --- | --- |
| 本地 Agent | 支持 | 支持 | Agent loop 在本机进程运行，文件来自本机磁盘 |
| 云端 Agent | 支持 | 支持 | 在 Cursor 隔离 VM 或自托管执行环境中运行 |
| 持久 Agent | 支持 | 支持 | Agent 保存对话、工作区、模型和设置 |
| 创建与恢复 | 支持 | 支持 | `create`、`resume`，通过 `agentId` 重新接入 |
| 单次 Prompt | 支持 | 支持 | 一次完成创建、执行和释放 |
| 流式事件 | 支持 | 支持 | 文本、思考、工具、状态、用量、总结等事件 |
| 等待最终结果 | 支持 | 支持 | 取得最终文本、状态、错误、耗时、模型和用量 |
| 停止 Run | 支持 | 支持 | 终止当前运行和进行中的工具调用 |
| 运行中转向 | 当前 TS 官方 Run 接口支持，依赖运行器和账号能力 | 当前 Python 官方 Run 接口未列出独立转向方法 | 转向失败时应退化为后续消息 |
| 模型目录 | 支持 | 支持 | 按账号和团队读取模型、参数和预设变体 |
| 模型参数 | 支持 | 支持 | Fast、Strength 等参数由模型目录动态定义 |
| Cursor Router | 支持 | 支持 | `auto-smart` 配合 `optimize_for` |
| Plan/Agent 模式 | 支持 | 支持 | 可按会话或单次 Run 切换 |
| 图片输入 | 支持 | 支持 | 文本与远程 URL 或 base64 图片一起提交 |
| 原生音频输入 | 无公开接口 | 无公开接口 | 语音指令可先转成文字，再调用 `agent.send()` |
| MCP | 支持 | 支持 | stdio、HTTP 和 SSE，支持认证配置 |
| 子代理 | 支持 | 支持 | 内联定义、项目文件和嵌套调用 |
| 自定义工具 | 支持 | 支持 | 主要面向本地 Agent |
| 工具允许与禁用 | 支持 | 支持 | 限制内置工具集合 |
| Hooks | 支持 | 支持 | 使用 `.cursor/hooks.json` 的基于文件配置 |
| Sandbox | 支持 | 支持 | 本地 Agent 可启用沙箱 |
| Auto-review | 支持 | 支持 | 使工具调用经过自动审查 |
| 云端产物 | 支持 | 支持 | 云端枚举和下载文件 |
| 本地产物 | 不支持 | 不支持 | 本地 Agent 返回空产物列表 |
| 本地自定义 Store | 支持 | 支持 | SQLite、JSONL 或自定义持久层 |
| 用量和费用 | 支持 | 支持 | Token 用量和计费信息，能力受账号灰度影响 |
| 结构化错误 | 支持 | 支持 | 错误码、HTTP 状态、请求 ID 和重试提示 |
| 内存或自定义 FileSystem | TypeScript 包提供 | 当前 Python 文档未提供 | 用于不直接挂载宿主磁盘的本地 Agent |
| 对话总结 | TypeScript 包提供 `summarize()` | 当前 Python 官方接口未列出同名方法 | 用于压缩本地 Agent 上下文 |

## 运行时

### 本地 Agent

本地运行时在调用方 Node.js 或 Python 进程中执行 Agent loop。工作区、文件读写、搜索、Shell 和持久化都在本机环境中完成。

本地模式不等于本地模型。官方说明中，本地和云端模式的模型推理都通过 Cursor 托管模型完成，本地模式主要意味着 Agent loop 和文件系统位于调用方机器。因此断网时不能把本地 SDK 当作离线模型使用。

适用场景包括开发脚本、代码检查、CI 对工作树执行任务、需要访问本机文件和当前用户环境的 Agent。

### 云端 Agent

云端运行时在隔离 VM 中执行。Cursor 托管环境会克隆仓库，也支持不提供仓库的空工作区。应用可以创建多个并行云端 Agent，Run 也可以继续执行而不要求调用方一直保持连接。

云端 Agent 的执行环境可以指向 Cursor 托管云环境、自托管 pool 或 self-hosted machine。云端配置支持指定仓库、起始分支、当前分支、现有 PR、自动创建 PR 和 Agent metadata。

### TypeScript 与 Python

TypeScript SDK 提供类型化 `Agent`、`Run`、`SDKMessage` 和错误类型。它支持 Node.js、Bun，以及单文件打包和编译可执行文件。部分原生二进制仍需随发行包提供。

Python SDK 提供同步与异步两套接口。服务端、机器人和并发编排优先使用 `AsyncClient`、`AsyncAgent` 和 `AsyncRun`。Python 客户端还支持自定义 `httpx`、超时和重试选项。

官方资料

- [运行时选择](https://cursor.com/docs/sdk/typescript#overview)
- [云端 Agent 配置](https://cursor.com/docs/sdk/typescript#cloudagentoptions)
- [Python 异步客户端](https://cursor.com/docs/sdk/python#async-usage)
- [单文件打包](https://cursor.com/docs/sdk/typescript#single-file-bundles-and-compiled-executables)

## Agent 与上下文

### Agent 生命周期

`Agent.create()` 创建持久 Agent handle。Agent 保存对话状态、工作区配置、模型选择和设置，可以连续接收多个 Prompt。

`Agent.resume(agentId)` 重新接入已有 Agent。本地 Agent 从本地 checkpoint store 恢复，云端 Agent 从 Cursor 服务端恢复。流程重启后仍可继续原对话。

`Agent.prompt()` 是一次性便捷接口，内部创建 Agent、发送一个 Prompt、等待完成并释放资源，只提供一轮。

### 本地持久化

本地 Agent 默认把 Agent 元数据、对话 checkpoint、Run 和事件保存到磁盘 SQLite。SDK 还提供可检查的 `JsonlLocalAgentStore`，也允许实现自定义 `LocalAgentStore`，把状态保存到 Redis、Postgres 或其他数据库。

### 对话检查与总结

可以按 Agent 和 Run 查询元数据、运行列表、消息历史、结构化 conversation 和终态状态。云端 Agent 还支持 archive、unarchive 和永久 delete。

TypeScript SDK 1.4.2 的包文档还提供 `agent.summarize()`，效果类似 Cursor CLI 的 `/summarize`。它把本地对话压缩为摘要，后续消息使用摘要恢复上下文空间。

官方资料

- [Agent 核心概念](https://cursor.com/docs/sdk/typescript#core-concepts)
- [恢复 Agent](https://cursor.com/docs/sdk/typescript#resuming-agents)
- [检查 Agent 与 Run](https://cursor.com/docs/sdk/typescript#inspecting-agents-and-runs)
- [本地 Agent Store](https://cursor.com/docs/sdk/typescript#local-agent-stores)

## Run 控制与流式事件

每次 `agent.send()` 返回一个 `Run`。Run 是一次 Prompt 提交，拥有独立的状态、事件流、最终结果、耗时、模型、Git 信息和取消入口。

### 流式消息

`run.stream()` 产生统一的 `SDKMessage`。常见类型包括 `assistant`、`thinking`、`tool_call`、`status`、`usage`、`summary` 和 task 相关消息。

需要更低层 UI 状态时可以监听 raw delta 和 step。TypeScript 使用 `onDelta`、`onStep`，Python 使用 `on_delta`、`on_step`。这些回调适合实时显示文本增量、思考增量、工具开始与完成、Shell 输出和轮次结束。

### 终态与检查

`run.wait()` 返回终态结果。主要字段包括 `status`、`result`、`error`、`model`、`durationMs`、`usage` 和 `git`。`requestId` 可用于后端日志关联。

Run 状态包括 `running`、`finished`、`error`、`cancelled`。Python 接口还文档化了 `expired`。

### 停止与转向

`run.cancel()` 请求取消当前 Run。官方 Python 文档说明，取消后事件流停止，进行中的工具调用停止，`wait()` 返回 `cancelled`，已经产生的文本仍保留。

TypeScript Run 接口提供可选的 `run.steer(text)`。它允许向正在执行的 Run 插入新指令，并返回是否已送达、是否需要转为后续消息或已经排队。该能力依赖运行器、账号能力和当前执行阶段。

官方资料

- [Run 接口](https://cursor.com/docs/sdk/typescript#run)
- [流式输出](https://cursor.com/docs/sdk/typescript#streaming)
- [取消 Run](https://cursor.com/docs/sdk/typescript#cancelling-a-run)
- [运行中转向](https://cursor.com/docs/sdk/typescript#steering-a-run-in-flight)
- [交互增量更新](https://cursor.com/docs/sdk/typescript#interaction-updates)

## 模型、参数与 Router

### 模型目录

`Cursor.models.list()` 返回当前 API Key 对应账号和团队可用模型的完整目录。每个模型可包含显示名称、描述、参数定义和预设 variants。

模型参数不是固定枚举。Fast、Speed、Turbo、Strength 等控件需要从目录的 `parameters` 和 `variants` 动态生成。这样可以避免把某个账号的模型和参数组合写死。

### 模型选择

`ModelSelection` 由模型 ID 和参数数组组成，例如 `{ id: "composer-2.5", params: [{ id: "fast", value: "true" }] }`。

单次 `send()` 可以覆盖模型。官方说明该覆盖是粘性的，后续不传模型时继续使用最后成功选择的模型。

`agent.model` 保存当前模型选择，成功执行带模型的 `send()` 后会更新。恢复 Agent 时如果没有再次传入模型，官方文档说明该字段可能为 `undefined`。`run.model` 和最终结果中的模型字段表示当前 Run 实际使用的选择。

页面读取 Fast 或 Strength 状态时，应组合三个来源。`agent.model` 给出已经选中的参数，模型目录给出参数定义和允许值，Run 终态给出本次执行使用的模型选择。不要根据模型名称猜造未公开参数。

### Cursor Router

Teams 和 Enterprise 可以使用 Cursor Router。SDK 中的模型 ID 是 `auto-smart`，必须配合 `optimize_for` 参数。

| 产品选择 | SDK 值 |
| --- | --- |
| Cost | `cost` |
| Balance | `balanced` |
| Intelligence | `intelligence` |

Router 必须根据 `Cursor.models.list()` 的结果确认可用性。Enterprise 模型 allowlist 会影响路由池。

### Composer 版本迁移

官方文档明确说明，`composer-2` 和 `composer-2-fast` 请求会在鉴权时重定向到 Composer 2.5，以保持旧脚本兼容。旧的 Fast 变体行为应重新确认。

### 能力边界

SDK 可以读取模型目录、参数定义和套餐可用性，但不提供脱离 Agent 的任意模型调用接口。模型的主观“强度评分”或未公开的训练信息不在 API 中。应用能可靠读取的是模型 ID、展示字段、参数、可选值和账号是否可访问。

官方资料

- [模型参数](https://cursor.com/docs/sdk/typescript#model-parameters)
- [Cursor Router](https://cursor.com/docs/sdk/typescript#cursor-router)
- [单次模型覆盖](https://cursor.com/docs/sdk/typescript#per-run-model-override)
- [模型目录 API](https://cursor.com/docs/sdk/typescript#cursormodelslist)

## 代码工具、MCP 与扩展

Agent 可以使用 Cursor 提供的内置编码工具，包括文件读取、写入、编辑、目录浏览、Grep、Glob、Shell、任务和工具调用状态等。具体工具集还取决于模型、运行时和 SDK 版本。

### MCP

SDK 支持内联 MCP server 配置和基于文件的配置。本地 Agent 可以从项目、用户、插件和 Dashboard 管理配置中加载 MCP。云端 Agent 会加载项目、团队和插件配置。

支持 stdio、HTTP 和 SSE。云端 HTTP MCP 的 `headers` 和 OAuth `auth` 由 Cursor 后端处理，敏感字段不会直接进入 VM。stdio MCP 的 `env` 会进入云端 VM，需要按运行时密钥处理。

内联 MCP 配置不会在 `Agent.resume()` 时自动持久化，恢复时需要再次传入，或改用文件配置。

### 子代理

主 Agent 可以调用命名子代理处理代码审查、测试编写、调研或其他分解任务。子代理支持内联定义和 `.cursor/agents/*.md` 文件定义。

子代理可以继续创建下一级子代理，官方文档描述了嵌套限制。后台子代理的结果会作为同一 Run 的后续轮次返回，该后台子代理能力目前主要面向本地 Agent。

### 自定义工具

TypeScript 和 Python 都可以向本地 Agent 暴露自有函数，并声明输入 schema、描述和结构化输出。这样可以访问内部 API、部署系统或业务服务，而不必单独建立 MCP server。

### 工具限制

`tools` 用于只开放指定内置工具，`disallowedTools` 用于移出指定工具。拒绝规则优先。例如可以创建只读 Agent，或移除 Shell。`tools: []` 表示不提供任何内置工具。

### 自定义 FileSystem

TypeScript 包的 1.4.2 文档提供 `tempFs`、`unionFs`、`overlayFs`、`readOnlyFs` 和自定义 `FileSystem`。本地 Agent 的 Read、Write、StrReplace、Grep、Glob、LS、Delete 和 Task 可以改用应用提供的内存或远程文件树。

使用自定义 FileSystem 时，宿主 Shell、Git 状态、Hooks、语义搜索和部分宿主工具不可用。适合远程文件服务、沙箱隔离和测试环境。

官方资料

- [MCP 配置](https://cursor.com/docs/sdk/typescript#mcp-servers)
- [子代理](https://cursor.com/docs/sdk/typescript#subagents)
- [工具限制](https://cursor.com/docs/sdk/typescript#restricting-the-toolset)
- [自定义工具](https://cursor.com/docs/sdk/typescript#custom-tools)
- [自定义 FileSystem](https://www.npmjs.com/package/@cursor/sdk)

## 规则、Hooks、沙箱与审查

### Rules、Skills 和设置来源

本地 Agent 可以通过 `settingSources` 加载 `project`、`user`、`team`、`mdm`、`plugins` 或 `all`。项目规则和 Skills 是否加载取决于这些来源。

云端 Agent 固定加载项目、团队和插件设置，不使用本地 `settingSources`。

### Hooks

官方 SDK 的 Hooks 是基于文件的配置，当前没有任意程序化 Hook 回调。本地 Agent 读取工作区或用户目录的 `.cursor/hooks.json`。云端 Agent 读取仓库中提交的 Hooks，并可能叠加团队和 Enterprise 管理的 Hooks。

适合的边界包括 `beforeShellExecution`、`preToolUse` 等。具体事件和配置以 Cursor Hooks 文档为准。

### Sandbox

本地 Agent 可以启用 `sandboxOptions.enabled`。官方文档同时提醒，默认本地 Agent 在 headless 环境中会自动执行 Shell、Edit、Write 等工具，不会像交互式 IDE 一样等待人工确认。需要限制副作用时必须主动配置 Hooks、工具 allowlist 或 Sandbox。

### Auto-review

`autoReview` 可以让本地工具调用经过 Cursor Auto-review。它是自动化审批辅助层，不能替代工作区白名单、Token 权限隔离和宿主操作系统权限。

官方资料

- [配置来源](https://cursor.com/docs/sdk/typescript#configuration-sources-at-a-glance)
- [Hooks](https://cursor.com/docs/sdk/typescript#hooks)
- [Sandbox](https://cursor.com/docs/sdk/typescript#sandbox-options)
- [Auto-review](https://cursor.com/docs/sdk/typescript#auto-review)

## 图片、产物与仓库接口

### 图片输入

`agent.send()` 除字符串外还接受带文本和图片的结构化消息。图片可以来自远程 URL，也可以使用 base64 data 与 MIME 类型。Python 提供 `SDKImage.from_file()` 等辅助方法。

### 语音输入与客户端听写

2026-11-25 核对了本项目使用的 `@cursor/sdk 1.4.2` 和核对时 npm 的最新版 `1.5.0`。两个版本的 `SDKUserMessage` 都只有必填的 `text` 和可选的 `images`。Python 的 `UserMessage` 也只列出这两项。公开的 Agent 消息接口没有接收麦克风音频流、WAV 或 MP3 的字段。[TypeScript 消息类型](https://cursor.com/docs/sdk/typescript#sdkusermessage) · [Python 消息类型](https://cursor.com/docs/sdk/python#usermessage)

Cursor 客户端的**话筒按钮**用于听写，转录结果出现在输入框，用户可以修改后发送。**波形按钮**启动实时双向语音，语音 Agent 可以口头回复，并将编码任务交给当前会话。官方要求使用已登录的 Cursor 账号启动实时通话，API Key 鉴权的会话无法启动 Voice Chat。[客户端听写](https://cursor.com/docs/agent/prompting#voice-input) · [语音对话及使用条件](https://cursor.com/docs/agent/voice-chat#requirements)

在 Cursor Remote Bridge 里，可以直接用手机输入法或 Windows 语音输入把指令填进现有输入框。若要在网页上提供专用话筒按钮，网页需要采集音频、调用语音转文字服务，再将可编辑的转录结果通过现有 `prompt` 发送。用手机远程访问时，网页调用麦克风通常需要 HTTPS 和用户授权，操作系统输入法听写不依赖网页的麦克风权限。[浏览器麦克风权限](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security)

### 云端产物

云端 Agent 可以通过 `listArtifacts()` 和 `downloadArtifact()` 枚举并下载 Agent 产生的文件。本地 Agent 返回空列表，下载会抛错。本机文件检查应直接访问本地工作区。

### 仓库发现

`Cursor.repositories.list()` 返回当前账号或团队可用的已连接 SCM 仓库，可用于填充云端 Agent 的 `repos` 配置。支持哪些 GitHub、GitLab、Azure DevOps 或 Bitbucket 仓库取决于集成和团队配置。

### 身份查询

`Cursor.me()` 返回 API Key 名称、创建时间和可用的用户信息。Team 或 service account Key 可能没有绑定具体用户。

官方资料

- [图片消息](https://cursor.com/docs/sdk/typescript#sdkusermessage)
- [Artifacts](https://cursor.com/docs/sdk/typescript#artifacts)
- [Cursor 命名空间](https://cursor.com/docs/sdk/typescript#the-cursor-namespace)
- [仓库列表](https://cursor.com/docs/sdk/typescript#cursorrepositorieslist)

## 认证、计费与可观测性

### 认证

SDK 接受用户 API Key 和 service account API Key。Team Admin API Key 目前不受支持。

TypeScript SDK 可以通过 `Cursor.auth.login()` 进行浏览器登录并保存凭据。也可以显式传入 `apiKey` 或设置 `CURSOR_API_KEY`。SDK 不会自动复用 Cursor 桌面应用的登录凭据。

### 用量与费用

每个 Run 可以返回累计 token usage，包括输入、输出、缓存读取、缓存写入和 reasoning tokens。

`agent.getUsage()` 返回账单视角的 Agent 总用量、按 Run 或轮次的明细以及可用的美元成本。本地 Agent 的计费查询仍按账号逐步开放，可能返回 feature unavailable。未开放时可以继续读取 Run 级 token 用量。

云端用量可能包含 Task 子代理和 side chat。费用在 Run 结束后可能需要一段时间结算。

### 错误

SDK 提供类型化错误，包括认证失败、限流、配置错误、Agent busy、网络错误、仓库集成未连接和 Run 操作不支持。错误对象可以带 `code`、HTTP status、`requestId`、`isRetryable` 和 `helpUrl`。

云端同一 Agent 同时只能有一个活动 Run。`send()` 遇到活动 Run 会抛 `AgentBusyError`，此时应等待、取消现有 Run，或使用转向能力。

官方资料

- [认证](https://cursor.com/docs/sdk/typescript#authentication)
- [用量与计费](https://cursor.com/docs/sdk/typescript#usage-and-billing)
- [Token 用量](https://cursor.com/docs/sdk/typescript#token-usage)
- [Agent 用量](https://cursor.com/docs/sdk/typescript#agentgetusage)
- [错误处理](https://cursor.com/docs/sdk/typescript#errors)

## 官方当前限制

- SDK 不是通用模型推理 API，不能直接提交任意 chat completion。
- Team Admin API Key 当前不支持。
- 默认本地 Agent 自动执行工具，没有交互式的人机确认步骤。
- Hooks 只能通过文件配置，当前不提供程序化 Hook 回调。
- 内联 MCP 配置不会自动跨 `Agent.resume()` 持久化。
- `tools`、`disallowedTools`、自定义工具和 `systemPrompt` 主要面向本地 Agent，部分设置不会跨 resume 持久化。
- 本地 Agent 不支持云端 Artifact 枚举和下载。
- 云端 Agent 不使用本地 `settingSources`，固定加载项目、团队和插件设置。
- 后台子代理当前主要面向本地 Agent。
- Python SDK 不提供 TypeScript 版本的自定义 FileSystem。
- TypeScript 本地 Store 默认需要 `node:sqlite`。缺少该模块时需要配置 JSONL 或自定义 Store。
- 云端执行仍受团队权限、模型 allowlist、仓库集成和套餐限制。
- 真实能力以 API Key 所属账号和团队的模型目录为准，不能只按公开模型名推断。

官方资料

- [已知限制](https://cursor.com/docs/sdk/typescript#known-limitations)
- [Python 已知限制](https://cursor.com/docs/sdk/python#known-limitations)
- [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)

## 对 Cursor Remote Bridge 的影响

### 已经对应的能力

| 官方 SDK 能力 | 当前项目中的使用 |
| --- | --- |
| 本地 Agent | 本机 Node 进程执行 Cursor Agent |
| `agent.send()` | 浏览器任务提交 |
| `run.stream()` | SSE 流式输出 |
| `run.cancel()` | 停止任务 |
| `run.steer()` | 中断并插入新指令，失败时转为后续任务 |
| `Agent.resume()` | 相同会话继续上下文 |
| `Cursor.models.list()` | 模型和动态参数列表 |
| 单次模型覆盖 | 页面切换模型与 Fast 等参数 |
| `settingSources` | 可控加载项目规则 |
| `autoReview`、Agent Retry | 后台任务的审查与重试配置 |

### 可以继续接入的能力

| 官方能力 | 对项目的价值 |
| --- | --- |
| Plan/Agent 模式切换 | 在远程页面增加先规划再执行的操作 |
| Tool allowlist 与 Sandbox | 为只读任务或无人值守任务增加强约束 |
| Hooks 配置检查 | 在页面显示当前工作区的工具拦截策略 |
| Usage 与费用 | 显示每轮 token、缓存命中和可用费用明细 |
| `agent.summarize()` | 长会话达到上下文压力时压缩本地上下文 |
| Raw delta 回调 | 让思考和工具输出呈现更细粒度的实时流 |
| Agent/Run 查询 | 统一恢复 Bridge 自身状态与 SDK checkpoint |
| MCP/子代理配置视图 | 远程查看当前项目加载了哪些扩展能力 |
| Router 参数 | Teams/Enterprise 账号下增加 Cost、Balance、Intelligence 选项 |

### 不适合直接照搬的部分

- 不允许调用方直接传 SDK 对象或原始配置。Bridge 应继续只接收经过校验的模型 ID、参数白名单、工作区和 Prompt。
- 不应默认开放 `tools: []` 以外的无限工具集给低信任远程调用方。
- 不要把 Cursor SDK 的 Bridge Token 机制与本项目的 Browser Bridge Token 混为一谈。
- 本项目依赖 SDK Agent 运行，不依赖 Cursor 桌面窗口。因此“锁屏可执行”取决于 Windows 用户会话和 Node 进程，不取决于 Cursor UI 是否可见。

## 版本核对

| 项目 | 核验结果 |
| --- | --- |
| 当前项目 `@cursor/sdk` | 1.4.2 |
| npm registry latest（2026-11-24） | 1.4.2 |
| TypeScript SDK Node.js 要求 | 22.13 或更高 |
| Python SDK 要求 | Python 3.10 或更高 |
| 官方 SDK 文档核验日期 | 2026-11-24 |

官方资料

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor Python SDK](https://cursor.com/docs/sdk/python)
- [Cursor SDK Bridge](https://cursor.com/docs/sdk/bridge)
- [Cursor SDK Release Notes](https://cursor.com/docs/release-notes/sdk)
