# Livermore Investment Agent

Livermore 是运行在个人电脑上的长期投资研究 Agent。它定时采集市场和 AI 产业链信息，使用 DeepSeek 生成研究日报，将任务状态、来源、报告、评估和告警保存在本地，并通过飞书或企业微信群机器人汇报结果。

项目只提供研究和报警能力，不连接券商或执行交易。Agent 编排、业务数据库和 Trace 数据均在本机；模型与公开数据源仍需要网络。

完整设计见[架构说明](docs/ARCHITECTURE.md)。

## 当前任务

- 每日市场简报：工作日 08:30、12:00、16:10。
- AI 产业链日报：工作日 08:45、17:00。
- 弹性数据采集：优先使用 Tavily Remote MCP，失败时使用公开网页来源。
- 确定性评估：检查来源编号、核心主题覆盖和研究免责声明。
- 运行可追踪：每次任务生成 `run_id` 和 OpenTelemetry `trace_id`。

## 快速开始

要求 Node.js 22 或更新版本，并安装 `uv`。Phoenix 使用项目内独立 Python 3.12 环境，不需要 Docker Desktop，也不会污染系统 Python。

一键安装依赖、系统命令、Phoenix、后台服务和定时任务，并打开 Web 界面：

```bash
node bin/install.mjs
```

安装完成后，在任意终端直接运行：

```bash
livermore
```

它会打开 `http://127.0.0.1:4310` 的 Agent Web：主区域是基于 Pi 的持续对话，右侧展示两个定时任务、最近运行、报告质量、能力账本和 Trace 入口。能力账本只展示 Livermore 实际可用的项目 Skills、MCP、数据连接和内置工具，不混入 Codex 的全局能力。

Livermore 专属 Skill 安装在项目的 `skills/` 目录，并在对话中按需读取。例如：

```bash
livermore skill install hithink-market-query
```

系统命令安装在 `~/.local/bin/livermore`。安装器不会覆盖该位置已有的其他程序。

常用子命令：

```bash
livermore status
livermore run market
livermore run ai
livermore runs
livermore traces
livermore uninstall-services
```

以下是需要分步安装或排查问题时使用的手工方式。

```bash
npm install
test -f .env || cp .env.example .env
```

在 `.env` 中填写 DeepSeek 密钥：

```env
DEEPSEEK_API_KEY=your-key
PI_PROVIDER=deepseek
PI_MODEL=deepseek-v4-flash
```

安装本地 Phoenix：

```bash
npm run phoenix -- install
```

临时以前台方式启动：

```bash
npm run phoenix -- start
```

浏览器访问 `http://localhost:6006` 查看 Trace。Python 3.12 和 Phoenix 分别安装在 `.python/` 与 `.venv-phoenix/`，Trace 和评估数据保存在 `data/phoenix/`，默认保留 90 天，并关闭外部资源和产品遥测。

## 运行任务

手工执行：

```bash
npm run briefing -- --task market-briefing
npm run briefing -- --task ai-industry-chain
```

同一任务、日期和运行模式成功后会阻止重复执行。需要明确重跑时使用：

```bash
npm run briefing -- --task market-briefing --force
```

安装 macOS 本地服务和定时任务：

```bash
npm run scheduler -- install
```

该命令会让 `launchd` 在登录后自动启动并保持 Agent Web 与 Phoenix 运行，同时安装五个日报触发器；不需要手工保持终端窗口。

移除定时任务：

```bash
npm run scheduler -- uninstall
```

调度器使用安装命令运行时的 Node.js 和 Phoenix 绝对路径。Node.js、项目目录或 Phoenix 环境迁移后，需要卸载再重新安装。调度时间使用 macOS 系统时区，建议与 `APP_TIMEZONE` 保持一致。

## 查询运行和 Trace

```bash
npm run runs
npm run runs -- --task market-briefing --limit 50
npm run runs -- --run <完整运行ID>
```

任务详情包含状态、耗时、来源数、报告路径和 Trace ID。使用 Trace ID 可在 Phoenix 中查询采集、去重、Agent turn、模型调用、工具调用、评估和消息投递过程。

直接运行 `livermore` 打开 Agent 对话界面；`livermore traces` 打开 Phoenix Trace 观测台。

业务记录保存在 `data/livermore.db`。SQLite 是任务事实来源；Phoenix 未启动时，日报和消息中心仍可运行，只会出现 Trace flush 提示。

## 消息中心

支持飞书群机器人和企业微信群机器人：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
WECHAT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
NOTIFY_ON_SUCCESS=true
```

测试消息通道：

```bash
npm run notify:test
```

成功任务会发送运行摘要、评估结果和报告正文；失败任务会发送 critical 告警。所有告警和投递结果同时写入 SQLite。个人微信没有稳定的官方通用机器人 Webhook，因此当前 `WECHAT_WEBHOOK_URL` 指企业微信机器人。

## 离线回放

```bash
npm run briefing -- \
  --task market-briefing \
  --replay /absolute/path/replay.json \
  --at 2026-07-20T01:00:00Z \
  --force
```

回放文件格式：

```json
{
  "task": "market-briefing",
  "retrievedAt": "2026-07-20T01:00:00Z",
  "items": [
    {
      "category": "美股",
      "title": "来源标题",
      "url": "https://example.com/news/1",
      "summary": "来源摘要",
      "publishedAt": "2026-07-20T00:30:00Z"
    }
  ]
}
```

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API 密钥 |
| `PI_PROVIDER` | `deepseek` | Pi 模型 provider |
| `PI_MODEL` | `deepseek-v4-flash` | 模型 ID |
| `APP_TIMEZONE` | `Asia/Shanghai` | 日报模式与日期时区 |
| `TAVILY_MCP_ENABLED` | `true` | 是否启用 Tavily MCP |
| `TAVILY_MCP_URL` | Tavily Remote MCP | MCP 地址 |
| `TAVILY_API_KEY` | 空 | Tavily API 密钥 |
| `SEARCH_MAX_RESULTS` | `5` | 单次搜索结果数，范围 5–20 |
| `TRACING_ENABLED` | `true` | 是否采集 OpenTelemetry Trace |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Phoenix 本地端点 | OTLP HTTP Trace 地址 |
| `PHOENIX_UI_URL` | `http://localhost:6006` | 运行查询提示地址 |
| `LIVERMORE_WEB_PORT` | `4310` | 本地 Agent Web 监听端口 |
| `LIVERMORE_WEB_UI_URL` | `http://127.0.0.1:4310` | 系统命令打开的 Agent Web 地址 |
| `FEISHU_WEBHOOK_URL` | 空 | 飞书群机器人 Webhook |
| `WECHAT_WEBHOOK_URL` | 空 | 企业微信群机器人 Webhook |
| `NOTIFY_ON_SUCCESS` | `true` | 是否汇报成功任务 |

配置始终从项目根目录 `.env` 加载，不依赖启动目录。

## 数据目录

```text
data/livermore.db       任务、来源、报告、评估与告警账本
data/reports/           Markdown 研究报告
data/phoenix/           Phoenix Trace 数据
data/runtime/           launchd 标准输出和错误日志
.venv-phoenix/          Phoenix 独立 Python 3.12 环境
.python/                uv 管理的项目本地 Python 运行时
```

## 开发验证

```bash
npm run typecheck
npm test
```

测试不会调用真实模型、网页来源或消息 Webhook。
