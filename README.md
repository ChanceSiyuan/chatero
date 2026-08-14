# Chatero

Chatero 是一个面向研究工作的 Code-OSS/Electron 桌面工作台：它把 Zotero
文献管理与 PDF 阅读、Cursor 风格的源码编辑和原生 Codex Agent、基于系统
OpenSSH 的远程开发，以及 Obsidian 风格的 QMD Live Preview 放在同一个应用中。

当前 macOS 开发版安装位置为 `/Applications/Chatero.app`，应用标识为
`io.github.chancesiyuan.chatero`。双击应用即可启动。

## 主要功能

- **完整 Zotero 能力**：Chatero Core 继续使用 Zotero 的 Gecko 实现和原有数据
  模型，负责文献库、集合、搜索、附件、PDF/EPUB、笔记、标注、同步、翻译器、
  引文、参考文献和文字处理器集成。命令面板中的
  `Chatero: Open Complete Zotero Compatibility Mode` 可打开完整兼容界面。
- **Cursor 风格编辑与 Agent**：Code-OSS 提供 Monaco 编辑器、Git、终端、搜索、
  调试、扩展和工作区；`Cmd/Ctrl+K` 打开行内 Agent，`Cmd/Ctrl+L` 打开聊天，
  `Cmd/Ctrl+Shift+L` 将当前代码或文本选区加入上下文。PDF 证据和 Zotero 条目也
  可以作为带来源标识的上下文加入同一个原生 Codex 会话。
- **Remote SSH**：读取用户现有的 `~/.ssh/config`，通过系统 OpenSSH 连接 Linux
  x86_64 或 arm64 主机，并安装经过 Ed25519 清单签名验证的 Chatero Remote
  Agent。远程文件、终端、Git、调试、语言服务和远程 Codex 都使用同一个 SSH
  authority，不依赖 Microsoft Remote-SSH。
- **QMD / Documentation**：`.qmd` 支持标准源码编辑、增量 Live Preview、公式、
  形式化块、表格、图片、精确 Quarto Preview、Agent 变更审阅和恢复。
  `Cmd/Ctrl+E` 在 Live Preview 与源码视图之间切换。

## 首次使用

1. 启动 Chatero，打开命令面板（`Cmd/Ctrl+Shift+P`）。
2. 运行 `Chatero: Select Zotero Profile…` 选择交给 Chatero Core 使用的 Zotero
   profile。不要让 Zotero 与 Chatero 同时写入同一个 profile；需要完整官方界面时
   使用 Chatero 内置的兼容模式。
3. 打开本地文件夹即可使用编辑器、终端、Git 与 Agent。
4. 编辑 QMD 时运行 `Chatero: Open Documentation`，或使用 `Cmd/Ctrl+E` 切换
   Live Preview；需要完整渲染时运行
   `Chatero: Open Exact Quarto Preview Beside Source`。

### 连接远程服务器

先在 `~/.ssh/config` 中配置一个普通 OpenSSH Host，例如：

```sshconfig
Host research-server
  HostName 203.0.113.10
  User researcher
  Port 22
```

确认终端中的 `ssh research-server` 可以连接后，在 Chatero 中运行
`Chatero: Connect to SSH…` 或 `Chatero: Open Remote Folder…`。远程主机尚未登录
Codex 时，运行 `Chatero: Sign In to Codex with Device Authentication`。连接失败可用
`Chatero: Show Remote Log` 查看不含私钥的诊断信息。

## 数据与安全边界

- Zotero profile 只由 Chatero Core 打开；Electron renderer、webview、扩展、Agent
  和 Remote Agent 都不能直接读取或写入 `zotero.sqlite`。
- 工作区文件只由本地或远程工作区文件服务管理。Agent 只能读取明确附加的有界
  上下文，写入必须经过可审阅的变更或一次性 capability。
- QMD 的人工编辑走 TextDocument/revision guard；Agent 编辑先进入私有工作副本，
  只有 Keep/Review/Promote 操作才能写入正式 Documentation。
- Chatero Workbench 用户状态位于
  `~/Library/Application Support/Chatero Research Workbench`，不会复用旧的
  `~/Library/Application Support/Chatero` 目录。
- 仓库不得包含个人 Zotero profile、论文、笔记、SSH 凭据、Codex 凭据或研究输出。

## 开发环境

构建使用固定版本，不能用近似版本替代：

- Code-OSS `1.132.0`，commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`
- Node.js `24.18.0`
- Electron `42.7.1`
- macOS 与 Xcode Command Line Tools
- Open VSX（不使用 Microsoft Marketplace）

从仓库根目录运行：

```bash
git submodule update --init --recursive
npm ci
npm run workbench:bootstrap
npm run workbench:install
npm run workbench:compile
npm run workbench:dev
```

`vendor/code-oss/` 是按固定 commit 和 digest-pinned patch series 生成的可再生
checkout，不应提交到 Git。更完整的构建说明见
[`products/workbench/README.md`](products/workbench/README.md)。

## 验收

基础回归和七阶段验收入口如下：

```bash
npm run test:chatero
npm run test:workbench-bootstrap
npm run workbench:verify
npm run verify:stage-1
npm run verify:stage-2
npm run verify:stage-3
npm run verify:stage-4
npm run verify:stage-5
npm run verify:stage-6
npm run verify:stage-7
```

各阶段会在忽略目录 `products/workbench/.cache/acceptance/` 写入带源码 digest 的
机器可读证据。Stage 5/6 的完整验收还要求真实 Linux x86_64/arm64 SSH runner 和
签名 Remote Agent；Stage 7 的正式发布验收要求 Apple Developer ID 与 notarization
凭据，缺少外部凭据时不得把 ad-hoc 本地包标记为正式公证版本。

## macOS 本地发布

完成固定环境的构建后运行：

```bash
npm run release:local:macos
```

该命令生成供本机测试的 ad-hoc 签名 DMG，并验证外层 Chatero 应用、内嵌 Chatero
Core、Remote Agent 签名清单和冷启动。正式发行必须使用 Stage 7 Developer ID
签名、公证和 Gatekeeper 流程。

## 架构与计划

- [Code-OSS/Zotero Workbench 设计](docs/superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md)
- [七阶段完成标准](docs/superpowers/specs/2026-08-13-seven-stage-completion-design.md)
- [当前实现计划](docs/superpowers/plans/2026-08-13-stage-1-workbench-closure.md)
- [上游同步流程](docs/chatero/upstream-workflow.md)

Chatero 保留 Zotero 的上游许可证与第三方 notices；新增组件的许可证信息随源码和
构建产物一并维护。
