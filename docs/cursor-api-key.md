# Cursor API Key 获取与配置

本文用于全新拉取项目后的第一次配置。完成 Cursor 鉴权后，Bridge 才能读取当前账号的模型目录、创建本地 Cursor Agent 并执行任务。

## 先区分两个凭据

项目会使用两个完全不同的凭据，请不要混用。

| 凭据 | 用途 | 本机位置 | 是否需要在页面输入 |
| --- | --- | --- | --- |
| Cursor API Key | 让本机程序调用 Cursor SDK 和 Cursor 云端 | `~/.cursor/sdk/auth.json` 或 `data/cursor-api-key.txt` | 不需要 |
| Bridge API Token | 保护 Bridge 的 `/v1/*` 接口和控制页访问 | `data/api-token.txt` | 本地访问自动读取，远程访问需要输入 |

安装首次启动 Bridge 时会自动生成 Bridge API Token。不要把 Cursor API Key 写入 `data/api-token.txt`。

## 准备工作

- Windows 10 或 Windows 11。
- Node.js 22.13 或更高版本。
- Git。
- 一个可以登录 Cursor Dashboard 的 Cursor 账号。
- 如果使用团队账号，需要管理员允许创建或使用 API Key。

检查本机环境。

```powershell
node --version
npm --version
git --version
```

## 全新拉取后的基础初始化

在 PowerShell 中克隆仓库并安装依赖。

```powershell
git clone https://github.com/ziwen-dev/cursor_remote_control.git D:\projects\cursor-remote-bridge
cd D:\projects\cursor-remote-bridge
npm ci
```

先生成本机配置并打开检查：

```powershell
Copy-Item .\config\bridge.config.example.json .\config\bridge.config.json
```

`config\bridge.config.json` 已被 `.gitignore` 排除，可以填写当前电脑的真实路径而不提交到仓库。

```text
config\bridge.config.json
```

至少确认这些字段适合当前电脑。

```json
{
  "allowedWorkspaces": [
    "D:\\projects\\cursor-remote-bridge",
    "D:\\projects\\example"
  ],
  "runner": {
    "mode": "cursor-sdk",
    "model": "composer-2",
    "apiKeyFile": "data/cursor-api-key.txt",
    "allowStoredAuth": true
  }
}
```

`allowedWorkspaces` 必须是本机存在的绝对路径。Cursor 只允许操作这些目录及其子目录。

## 获取并配置 Cursor API Key

项目支持两种方式。第一次配置优先使用方式一，凭据获取、保存和过期时间都由 Cursor SDK 处理。

### 方式一，推荐，使用 Cursor SDK 交互登录

在项目目录执行：

```powershell
cd D:\projects\cursor-remote-bridge
npm run cursor-login
```

命令会打开系统浏览器并进入 Cursor 登录页面。完成登录和授权后，终端会显示当前账号、Key 到期时间和凭据文件位置。

默认保存位置：

```text
C:\Users\<Windows用户名>\.cursor\sdk\auth.json
```

交互登录默认签发有效期为 90 天的用户 API Key。命令不会打印 Key 明文。

检查登录状态：

```powershell
node --input-type=module -e "import { Cursor } from '@cursor/sdk'; console.log(await Cursor.auth.status())"
```

正常结果包含：

```text
status: 'logged-in'
backendUrl: 'https://api2.cursor.sh'
email: '你的 Cursor 账号'
apiKeyExpiresAtMs: 到期时间戳
```

如果没有打开浏览器，终端会输出一个登录 URL。手动打开该 URL 完成授权后，命令会继续等待并保存凭据。

### 方式二，使用 Dashboard 手动获取 API Key

1. 登录 Cursor。
2. 打开 [Cursor Dashboard Integrations](https://cursor.com/dashboard/integrations)。
3. 找到 API Keys 相关区域，创建一个新的 Key。
4. 名称可以填写 `Cursor Remote Bridge`。
5. 创建完成后立即复制 Key。页面通常只展示一次完整内容。
6. 不要通过聊天、截图或代码仓库传递这个 Key。

回到项目目录，通过脚本安全写入本机 Key 文件。

```powershell
cd D:\projects\cursor-remote-bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\set-cursor-key.ps1
```

脚本使用安全输入提示，不会把 Key 回显到终端。写入位置：

```text
D:\projects\cursor-remote-bridge\data\cursor-api-key.txt
```

脚本会把文件访问权限限制为当前 Windows 用户。建议通过脚本写入，不要直接复制粘贴创建该文件，否则文件 ACL 可能过宽。

Dashboard 页面名称或位置可能随 Cursor 版本调整。只要 Key 属于当前登录账号并有 SDK 或 Agent 调用权限，项目读取方式不变。

## Cursor 凭据读取顺序

项目按下面的顺序选择 Cursor 凭据。

1. 环境变量 `CURSOR_API_KEY`。
2. `runner.apiKeyFile` 指向的文件，默认是 `data/cursor-api-key.txt`。
3. `allowStoredAuth` 为 `true` 时，使用 `~/.cursor/sdk/auth.json`。

前面的来源存在时，后面的来源不会覆盖它。

如果本机设置了旧的 `CURSOR_API_KEY`，它会优先于交互登录。排查登录问题时执行：

```powershell
if ($env:CURSOR_API_KEY) { "CURSOR_API_KEY is set" } else { "CURSOR_API_KEY is not set" }
```

不要在标准 Cursor 环境中随意设置 `CURSOR_BACKEND_URL`。只有连接兼容的自建后端时才需要覆盖它。

## 验证 Cursor Key

从项目自身的配置和凭据读取路径验证模型目录：

```powershell
cd D:\projects\cursor-remote-bridge
node --input-type=module -e "import { loadConfig } from './src/config.js'; import { listCursorModels } from './src/cursor-sdk-runner.js'; const config = await loadConfig(); const models = await listCursorModels(config.runner); console.log('models:', models.length)"
```

成功时会输出类似：

```text
models: 50
```

模型数量会随账号、套餐和 Cursor 版本变化，大于零即可说明鉴权与云端模型目录连接成功。

## 启动 Bridge

先以前台方式启动，便于观察首次配置错误：

```powershell
cd D:\projects\cursor-remote-bridge
npm start
```

另开一个 PowerShell 窗口检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:7419/health
```

通过 Bridge 检查 Cursor 模型：

```powershell
$token = (Get-Content D:\projects\cursor-remote-bridge\data\api-token.txt -Raw).Trim()
$models = (Invoke-RestMethod `
  -Uri http://127.0.0.1:7419/v1/models `
  -Headers @{ Authorization = "Bearer $token" }).models
$models.Count
```

前台验证完成后，停止当前的 `npm start`，再安装登录后自启动任务：

```powershell
cd D:\projects\cursor-remote-bridge
npm run autostart:install
```

以后可以运行 `start-bridge.cmd` 或 `npm run start:ui` 打开控制页。

## Key 过期或失效

交互登录签发的 Key 默认 90 天到期，Dashboard 手动创建的 Key 以创建时设置的期限为准。

重新获取并更新 Key：

```powershell
cd D:\projects\cursor-remote-bridge
npm run cursor-login
```

或者重新执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\set-cursor-key.ps1
```

更新后重启 Bridge：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -CreateTasks
```

Dashboard 中撤销旧 Key 后，本机保存的旧凭据也会停止工作。

## 常见错误

### `Cursor SDK is not authenticated`

没有找到环境变量、Key 文件或交互登录凭据。重新执行 `npm run cursor-login`，或使用 `scripts\set-cursor-key.ps1` 写入 Key。

### `Route GET:/v1/models not found`

先检查是否设置了 `CURSOR_BACKEND_URL`。标准 Cursor 账号应使用 SDK 默认后端。删除错误的后端覆盖后重启 Bridge。

```powershell
Remove-Item Env:CURSOR_BACKEND_URL -ErrorAction SilentlyContinue
```

### `fetch failed` 或 `API key exchange endpoint`

这类错误通常是本机网络问题。检查能否访问 `https://api2.cursor.sh`，并检查代理、VPN、DNS 和系统时间。

### `model_catalog_unavailable`

查看 Bridge 日志和任务事件中的底层错误。先验证 Key，再确认账号是否有模型访问权限。

```powershell
Get-Content D:\projects\cursor-remote-bridge\data\logs\bridge.log -Tail 100
```

### 团队账号无法创建 API Key

需要团队管理员允许用户创建 API Key，或者由管理员签发可用 Key。企业策略也可能限制模型或云端 Agent 功能。

## 安全要求

- 不要把 `data/cursor-api-key.txt`、`~/.cursor/sdk/auth.json` 或 `data/api-token.txt` 提交到 Git。
- 当前项目通过 `.gitignore` 忽略整个 `data/` 目录。
- 不要把 Cursor API Key 交给 Bridge 的远程调用方。
- 远程调用方只需要 Bridge API Token。
- 怀疑 Key 泄露时，立即在 Cursor Dashboard 撤销并重新生成。

