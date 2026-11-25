# 项目名称与 GitHub 发布文案

## 正式名称

| 场景 | 名称 |
| --- | --- |
| 英文名称 | Cursor Remote Bridge |
| 中文名称 | Cursor 远程桥接 |
| GitHub 仓库名 | `cursor_remote_control` |
| npm 包名 | `cursor-remote-bridge` |

## 一句话介绍

**中文**

通过浏览器远程驱动本机 Cursor，在锁屏状态下继续执行代码任务，并流式查看输出、文件和代码改动。

**英文**

Drive a local Cursor coding agent from any browser, keep tasks running while the PC is locked, and inspect streamed output, source files, and code changes.

## GitHub About

建议填写以下简介。

```text
通过浏览器远程驱动本机 Cursor，在锁屏状态下继续执行代码任务，并流式查看输出、文件和代码改动。
```

英文简介候选。

```text
A browser-based remote console for driving local Cursor agents, with streaming output, workspace management, file browsing, model controls, and code change review.
```

## GitHub Topics

```text
cursor
cursor-sdk
ai-agent
remote-development
developer-tools
code-review
frp
sse
nodejs
windows
self-hosted
web-console
```

## README 标题

```markdown
# Cursor Remote Bridge

### Cursor 远程桥接

通过浏览器远程驱动本机 Cursor，在锁屏状态下继续执行代码任务，并流式查看输出、文件和代码改动。
```

## Release 标题

```text
Cursor Remote Bridge v0.1.0 - 本地 Cursor 远程控制
```

## 项目定位

Cursor Remote Bridge 是一个自托管的 Cursor 本机任务入口。它把 Cursor SDK Agent 的任务提交、流式输出、会话上下文、模型参数、Workspace 管理、文件浏览和代码变更检查集中到一个适配桌面端与移动端的浏览器控制页。

项目重点解决三个场景。

1. 离开电脑后仍能从手机或另一台电脑查看任务进度并继续发出指令。
2. Windows 锁屏后继续执行耗时任务，不必保持 Cursor 桌面窗口可见。
3. 从浏览器检查 Agent 修改过的文件、Git diff 和最终报告。
