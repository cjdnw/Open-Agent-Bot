# Open-Agent-Bot

**多机器人桌面 Agent 工作台 — 从 XinyunOpenBot / OpenMausBot 迁移的 MIT 开源项目。**

Open-Agent-Bot 基于 Electron、React 和 TypeScript。你可以像聊天联系人一样管理多个机器人，为每个机器人选择不同模型、独立任务和云端电脑，并统一接入 Claude、Codex、GPT、Grok、Gemini 以及 OpenAI 兼容中转站。

> 本项目自 [XinyunOpenBot](https://github.com/dongpen-max/XinyunOpenBot) 迁移，并保留对 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 的 MIT 版权声明。详见 [NOTICE](./NOTICE)。本项目与 Grok Bot、xAI、OpenAI、Anthropic 或 Google 没有官方隶属关系。

版本规划见 [ROADMAP.md](./ROADMAP.md)。

## 主要功能（v0.1.0 起保留）

- **多机器人管理**：独立名称、角色、模型、任务和对话历史。
- **多模型接入**：Claude CLI、Codex CLI、Grok CLI、Gemini/Antigravity、xAI API、OpenAI-compatible API。
- **API 中转站**：自定义 Base URL / API Key，可发现 `/v1/models`。
- **简体中文默认**：界面、设置、错误提示与模型配置。
- **云端 / 本机电脑控制**：Box 云桌面与 CUA 本机桌面。
- **聊天房间与对话分支**、语音聊天、应用内更新。
- **本地数据**：默认 `~/.openmausbot/`。

## 快速开始

需要 Node.js 24+ 与 pnpm 10。

```bash
pnpm install
pnpm dev
pnpm dev:server
```

桌面模式：

```bash
pnpm dev:desktop
```

Windows 打包：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
pnpm package:win
```

## 数据与隐私

```text
~/.openmausbot/
```

请勿提交 `.env`、个人 `config.json` 或含密钥的日志。额度 MCP 与配额脚本不得返回 API Key、Token 或 Cookie。

## 开发检查

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 文档

- [ROADMAP.md](./ROADMAP.md)
- [Momo → Worker → Judge Workflow](./docs/workflow-momo-worker-judge.md)
- [Quota routing & persistence](./docs/quota-routing-and-persistence.md)
- [API 配置说明](./API配置说明.md)
- [使用指南](./使用指南.md)

## 许可证

[MIT License](./LICENSE)

见 [NOTICE](./NOTICE) 了解上游归属。
