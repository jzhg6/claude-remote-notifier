# Claude Remote Notifier

[English](README.md)

一个面向 **Windows + VS Code Remote-SSH** 的可靠 Claude Code 本地通知扩展。它通过 workspace 事件 spool 传递事件，不开放端口，不运行本地 daemon，也不需要 SSH `RemoteForward`。

> [!IMPORTANT]
> 本项目不是首个 Claude Code 通知工具。它是一个刻意收窄范围的 Windows Remote-SSH 实现，重点是可靠事件传递、有界持久化、精确安装/卸载和较小的安全边界。详见[与其他工具的区别](#与其他工具的区别)。

本项目是独立社区项目，与 Anthropic 没有关联，也未获得其认可或赞助。“Claude”和“Claude Code”是 Anthropic PBC 的商标。

## 为什么需要它

Claude Code hooks 在远端 Linux 主机执行。远端发出的桌面通知通常无法到达运行 VS Code UI 的 Windows 电脑。Claude Remote Notifier 复用 VS Code 已经维护的 Remote-SSH 文件系统通道：

```text
远端主机                                         Windows 本地
Claude Code hook                                 Local UI extension
      │                                                  │
      ├─ 每个事件原子写入独立 JSON                        │
      ▼                                                  │
.claude/claude-remote-notifier/spool/v2/pending/          │
      │                                                  │
      └────── vscode.workspace.fs / Remote-SSH ──────────┤
                                                         ├─ claim + validate + ack
                                                         └─ PowerShell NotifyIcon 通知
```

## 主要特色

- **Remote-SSH 到 Windows 本地通知**：`extensionKind: ["ui"]` 强制扩展运行在本地 UI Extension Host。
- **每事件独立文件**：并发事件不会覆盖同一个 signal 文件。
- **原子发布与 claim**：hook 先写私有临时文件再 rename；消费者用原子 rename 抢占事件。
- **跨窗口 single-owner**：本地 Windows named pipe 为同一远端 workspace 选出唯一消费者，并汇总多个窗口的焦点状态。
- **远端 ack**：处理终态先持久化，再删除 inflight；明确提供 at-least-once 而非虚假的 exactly-once 语义。
- **资源有界**：限制输入、事件大小、队列长度、事件年龄、ack 数量和单次扫描工作量。
- **最小事件数据**：只写事件类型、安装 ID、事件 ID、时间戳、session hash，以及受限的工具名或错误类别；不落盘 transcript、命令、问题正文或 assistant 回复。
- **Workspace Trust**：Restricted Mode 下不安装、不消费远端事件。
- **精确 JSONC 修改**：只管理自己的 `.claude/settings.local.json` hooks，保留注释、permissions、env 和其他 hooks。
- **可回滚安装**：卸载先移除 hook 引用；只有 manifest 和 hook hash 匹配时才删除 runtime。
- **符合事件语义的焦点策略**：完成事件在相关窗口前台时抑制；权限、问题和 API 失败始终提醒。

## 要求

- 本地为 Windows 10 或 Windows 11。
- VS Code 1.96+ 与 Remote-SSH。
- 已信任的 Remote-SSH workspace。
- 支持 command hooks、`PermissionRequest`、`StopFailure` 和 exec-form args 的较新 Claude Code。
- 远端 Node.js 18+。
- Windows PowerShell，且可加载 `System.Windows.Forms` 和 `System.Drawing`。

## 安装

### 下载并校验 VSIX

从最新 [GitHub Release](https://github.com/jzhg6/claude-remote-notifier/releases/latest) 下载：

```text
claude-remote-notifier-0.2.0.vsix
claude-remote-notifier-0.2.0.vsix.sha256
```

在 Windows PowerShell 中可选校验：

```powershell
(Get-FileHash .\claude-remote-notifier-0.2.0.vsix -Algorithm SHA256).Hash.ToLower()
Get-Content .\claude-remote-notifier-0.2.0.vsix.sha256
```

### 安装到 Windows 本地

1. 在 Windows 本地 VS Code 中运行 **Extensions: Install from VSIX...**。
2. 选择 VSIX。
3. 确认扩展显示在 **Local - Installed**，不能只安装到 `SSH: <host>`。
4. 执行 **Developer: Reload Window**。

### 配置远端 workspace

打开已信任的 Remote-SSH workspace，执行：

```text
Claude Remote Notifier: Set Up Current Workspace
```

Setup 会：

- 将 standalone hook 安装到 `.claude/claude-remote-notifier/runtime/`；
- 创建带版本的事件 spool 和 install manifest；
- 向 `.claude/settings.local.json` 精确合并四个 hooks；
- 将 runtime 目录加入根 `.gitignore`；
- 验证 hook hash、hook 数量和远端文件读写/rename/delete。

它不会修改用户级 Claude settings、permissions、env 或其他工具的 hooks。

Setup 后新开 Claude Code 会话，让 Claude Code 重新加载 hooks。

### 测试

依次执行：

```text
Claude Remote Notifier: Test Windows Notification
Claude Remote Notifier: Test Remote Bridge
Claude Remote Notifier: Verify Setup
```

第一个命令只测试 Windows 本地通知后端；第二个命令通过真实 Remote-SSH spool 发送合成事件。

## 支持的事件

| Claude Code hook              | 提示             | 焦点策略                 | 默认 |
| ----------------------------- | ---------------- | ------------------------ | ---- |
| `Stop`                        | 当前 turn 已停止 | 任一相关窗口在前台时抑制 | 开启 |
| `StopFailure`                 | API 错误导致停止 | 始终提醒                 | 开启 |
| `PermissionRequest`           | 等待权限决定     | 始终提醒                 | 开启 |
| `PreToolUse: AskUserQuestion` | 等待回答         | 始终提醒                 | 开启 |
| `SubagentStop`                | subagent 已停止  | 完成事件策略             | 关闭 |

`Stop` 只是 Claude Code 主 Agent 停止一次 turn，不一定等于用户定义的整个长期任务最终完成。若 payload 显示仍有 background tasks 或 session crons，hook 会抑制该次 Stop，等待后续事件。

## 命令

- **Set Up Current Workspace**：安装或升级远端 bridge。
- **Verify Setup**：验证运行位置、Trust、hook hash、settings 签名和 spool 操作。
- **Remove From Current Workspace**：只移除受管 hooks 与未修改的 runtime。
- **Test Windows Notification**：测试本地 PowerShell/NotifyIcon。
- **Test Remote Bridge**：经 Remote-SSH 事件 spool 做端到端测试。
- **Diagnose**：输出不含事件正文的诊断信息。
- **Clean Event Spool**：清理 pending、inflight 与 ack。

## 与其他工具的区别

下表基于 **2026-09-30** 可见的公开文档。项目会持续演进，请同时查看各项目最新说明。

| 项目                                                                          | 主要范围                                       | 远端传递方式                                     | 与本项目的取舍差异                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Claude Remote Notifier**                                                    | Windows + VS Code Remote-SSH 生命周期通知      | 无端口的 per-event workspace spool               | 平台范围较窄；提供原子 claim/ack、跨窗口 owner、有界最小事件、精确 setup/uninstall 和 `StopFailure` |
| [Agent Idle Notifier](https://github.com/Global-Step-Inc/agent-idle-notifier) | Remote-SSH、WSL、container 的跨平台本地通知    | 本地 UI extension 监听 workspace JSON signal     | 最接近的先行架构，代码更轻量；本项目侧重多事件 spool、崩溃恢复、远端持久 ack 和更严格管理边界       |
| [Claude Notifier](https://github.com/ashmitb95/claude-notifier)               | Claude Code/Codex、声音、label、session 上下文 | 远端音频可用本地 daemon + SSH reverse forwarding | 功能更广、更成熟；本项目刻意不使用端口、daemon、反向转发、transcript 读取和详细正文持久化           |
| [Claude Code Notifier](https://github.com/kdush/Claude-Code-Notifier)         | Python 多渠道通知、webhook 和消息平台          | hook 进程和外部渠道                              | 更适合团队/webhook 路由；不是本项目这种本地 UI extension 文件桥                                     |
| [SSH Bridge MCP](https://github.com/k-l-lambda/vscode-ssh-bridge-mcp)         | MCP 消息、声音、TTS、浏览器工具                | 本地 SSE 服务 + SSH 反向隧道                     | 能力更多；需要 listener 和 reverse forwarding，本项目只处理自动生命周期通知                         |
| [WSL Claude Toast](https://github.com/sebastienheyd/wsl-claude-toast)         | WSL2 到 Windows 通知，不依赖 VS Code           | WSL binary 调用 Windows WinRT Toast              | 提供现代独立 Windows Toast；本项目支持通用 Remote-SSH，但依赖已打开的 VS Code                       |

### 本项目真正的特色

特色不是“hook 可以触发通知”或“本地 UI extension 可以读取远端 workspace”，这些思路已有先例。本项目组合的是一套偏可靠性和安全边界的实现：

- 每事件不可变文件，而非共享覆盖槽；
- publish、claim、ack、delete 的原子阶段；
- 明确的 at-least-once 崩溃语义；
- 有界留存与有界扫描；
- 本地多窗口 single-owner；
- 不落盘事件正文或 transcript；
- 无监听端口、daemon、webhook 或 SSH tunnel；
- 保留无关 JSONC 配置的 setup/uninstall。

## 安全与隐私

- 不实现 telemetry 或出站网络请求。
- 远端事件不含 transcript、命令、问题正文和 assistant 回复。
- Setup 拒绝受管路径中的 symbolic link，并只使用由 workspace 派生的固定路径。
- hook 写事件前会验证自身 SHA-256 与 install manifest。
- consumer 在通知前验证 schema、installation ID、文件名、大小、时间戳和字段上限。
- 能修改已信任远端 workspace 的恶意进程仍可能在 Remote-SSH 检查之间篡改文件。Workspace Trust 是主要安全边界，symlink 检查和原子 rename 是纵深防御，不承诺抵抗已信任 workspace 内的恶意本地进程。
- Windows 后端使用 `System.Windows.Forms.NotifyIcon.ShowBalloonTip`。这是 Windows 原生 NotifyIcon balloon，**不是**注册了 AppUserModelID 的现代 WinRT Action Center Toast。Focus Assist 或系统策略可能抑制它。

详见 [SECURITY.md](SECURITY.md)。

## 限制

- VS Code 和 Remote-SSH 连接必须保持打开；关闭任何一端都无法实时通知。
- 当前只正式支持 Windows 本地平台。
- 通知显示后、ack 提交前若进程崩溃，恢复时可能重复通知。这是公开说明的 at-least-once 窗口。
- 不同 Windows 用户会话或不同客户端电脑不共享本地 named-pipe owner；远端 atomic claim 在一般情况下仍会阻止并发处理。
- hook 始终以成功退出，确保通知故障不会阻塞 Claude Code。

## 卸载

对每个已配置 workspace 运行：

```text
Claude Remote Notifier: Remove From Current Workspace
```

卸载先移除受管 hook，再删除 runtime。若 hook 被手动修改，则保留文件并报告，不会强制删除。完成 workspace 卸载后再卸载 Windows 本地扩展。

## 开发

```bash
npm ci
npm run check
npm run package
```

Release workflow 会校验 tag、`package.json` 版本、VSIX 文件名和 SHA-256 一致。本项目支持 GitHub Releases，暂不配置 VS Code Marketplace 发布。

## 相关项目与致谢

[Agent Idle Notifier](https://github.com/Global-Step-Inc/agent-idle-notifier) 是最接近的公开先行文件桥实现，直接影响了本项目的问题定义。其 MIT notice 已保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不包含 GPL 许可证的 Claude Notifier 源码。

## 许可证

MIT，见 [LICENSE](LICENSE)。
