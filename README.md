# Livermore Investment Agent

Livermore 是运行在个人电脑上的长期投资研究 Agent。它定时采集市场和 AI 产业链信息，使用 DeepSeek 生成研究日报，将任务状态、来源、报告、评估和告警保存在本地，并通过飞书或企业微信群机器人汇报结果。

项目只提供研究和报警能力，不连接券商或执行交易。Agent 编排、业务数据库和 Trace 数据均在本机；模型与公开数据源仍需要网络。

完整设计见[架构说明](docs/ARCHITECTURE.md)。

## 当前任务

- 每日市场简报：工作日 08:30、12:00、16:10。
- AI 产业链日报：工作日 08:45、17:00。
- 持仓风险巡检：由用户维护持仓，工作日上午与下午收盘前半小时各检查一次（11:00、14:30）。
- 弹性数据采集：优先使用 Tavily Remote MCP，失败时使用公开网页来源。
- 确定性评估：检查来源编号、核心主题覆盖和研究免责声明。
- 运行可追踪：每次任务生成 `run_id` 和 OpenTelemetry `trace_id`。

## 快速开始

要求 Node.js 22 或更新版本，并安装 `uv`。Phoenix 与 Futu SDK 分别使用项目内独立 Python 3.12 环境，不需要 Docker Desktop，也不会污染系统 Python。持仓行情还要求本机已启动并登录 Futu OpenD。

一键安装依赖、系统命令、Phoenix、后台服务和定时任务，并打开 Web 界面：

```bash
node bin/install.mjs
```

安装完成后，在任意终端直接运行：

```bash
livermore
```

它会打开 `http://127.0.0.1:4310` 的 Agent Web：主区域是基于 Pi 的持续对话，右侧展示三个定时任务、最近运行、报告质量、能力账本和 Trace 入口。顶部“持仓”入口用于手工维护股票代码、持仓数量、买入时间和买入成本，并查看最近一次风险巡检结果。能力账本只展示 Livermore 实际可用的项目 Skills、MCP、数据连接和内置工具，不混入 Codex 的全局能力。

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
livermore run portfolio
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
MODEL_COST_INPUT_PER_MILLION=0.025
MODEL_COST_OUTPUT_PER_MILLION=3
MODEL_COST_CURRENCY=CNY
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
npm run portfolio:risk
```

同一任务、日期和运行模式成功后会阻止重复执行。需要明确重跑时使用：

```bash
npm run briefing -- --task market-briefing --force
```

安装 macOS 本地服务和定时任务：

```bash
npm run scheduler -- install
```

该命令会让 `launchd` 在登录后自动启动并保持 Agent Web 与 Phoenix 运行，同时安装五个日报触发器和一个持仓巡检触发器；不需要手工保持终端窗口。

持仓巡检在工作日 11:00、14:30 执行，对应 A 股上午与下午收盘前半小时。当前由 `launchd` 按周一至周五触发，法定休市日不执行交易，但仍可能产生一次行情新鲜度不足的检查记录。

## 持仓风险规则

持仓完全由用户在 Agent Web 中手工维护，Livermore 不读取券商账户，也不会下单。每次巡检启动一个短生命周期 Pi Agent：Agent 先读取 `futuapi` Skill，通过 `query_futu_market` 获取全部 A 股/港股持仓的最新价、当日涨跌与日 K 线 RSI/MACD，再通过 `query_futu_news` 获取持仓相关的最新新闻、公告与评级。只有存在 A 股持仓时，才读取 `hithink-market-query` 并调用 `query_a_share_main_fund_flow` 获取主力净流入；港股不查询、展示或推断主力净流入。确定性适配层统一证券代码并实施严格字段归属：Futu 独占名称、价格、涨跌和技术指标，同花顺只补充 A 股主力资金，问财意外返回的价格或指标不会覆盖 Futu。随后代码计算相对买入成本的盈亏并执行硬风险规则，模型不能覆盖最终等级。标准化结果仍保留 Futu 快照、查询错误、问财原始行、查询语句和 Trace ID，便于审计。

Futu SDK 位于项目的 `.venv-futu/`，本地 `.env` 通过以下配置连接 OpenD：

```env
FUTU_PYTHON=/absolute/path/to/livermore/.venv-futu/bin/python
FUTU_OPEND_HOST=127.0.0.1
FUTU_OPEND_PORT=11111
```

- 警告：持仓亏损达到 5%、当日跌幅达到 4%、下跌且主力净流出、RSI 达到 80，或行情查询失败。
- 严重：持仓亏损达到 10%，或当日跌幅达到 7%。
- 报警抑制：风险首次出现或升级时立即通知；同等级风险最多每 4 小时重复一次。

巡检结果写入 SQLite、Markdown 报告和 Trace；风险通过消息中心投递到已配置的飞书或企业微信。规则只用于提示人工复核，不构成自动止损建议。持仓为空时不会产生无意义的模型调用。

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

## 消息中心与飞书 Agent

飞书应用机器人同时承担定时报告投递和 Agent 对话：

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
WECHAT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
NOTIFY_ON_SUCCESS=true
```

飞书开发者后台需要完成：

1. 开启“机器人”应用能力。
2. 开通 `im:message:send_as_bot`、`im:message.p2p_msg:readonly`；需要群聊时再开通 `im:message.group_at_msg:readonly`。
3. 在“事件与回调”中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
4. 创建并发布应用版本，将应用安装到当前企业。

`com.livermore.feishu` 使用官方 Node SDK WebSocket 长连接，无需公网域名。用户首次在飞书中与 Livermore 单聊后，该会话自动接收后续定时报告；群聊默认只响应 @机器人，发送“订阅日报”后才接收报告。支持命令：`订阅日报`、`取消订阅`、`订阅状态`、`帮助`。

旧的飞书群自定义机器人 Webhook 仍可作为仅发送通道：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
```

测试消息通道：

```bash
npm run notify:test
```

成功任务会使用飞书 `interactive` 卡片中的原生 `markdown` 组件发送运行摘要、评估结果和报告正文，标题、列表、链接与加粗会正常渲染。长日报会优先按二级标题拆分，并同时限制单卡字符数和可视行数；多张卡片会标记“第 N/M 部分”。每次持仓巡检都会推送一张精简卡片，内容为 2-4 句巡检总结（含最重要的持仓最新消息）和按 P0/P1/P2 排序的风险优先级表格；完整分析只保存在本地报告和 Agent Web 中。

持仓巡检把用户录入的成本价统一视为复权后单位成本，可直接与 Futu 最新价比较。Agent 不再要求确认除权或复权口径，并且必须为每只持仓给出“买入 / 持有 / 卖出”三选一建议，同时说明理由、执行条件或参考区间以及建议失效条件。建议只供研究参考，Livermore 不执行交易。

失败任务会发送 critical 告警。所有告警和投递结果同时写入 SQLite。个人微信没有稳定的官方通用机器人 Webhook，因此当前 `WECHAT_WEBHOOK_URL` 指企业微信机器人。

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
| `MODEL_COST_INPUT_PER_MILLION` | 未设置 | 每 100 万输入 Token 的成本；缓存读写 Token 也按输入价格计算 |
| `MODEL_COST_OUTPUT_PER_MILLION` | 未设置 | 每 100 万输出 Token 的成本 |
| `MODEL_COST_CURRENCY` | `USD` | 成本币种，例如 `CNY` 或 `USD` |
| `APP_TIMEZONE` | `Asia/Shanghai` | 日报模式与日期时区 |
| `TAVILY_MCP_ENABLED` | `true` | 是否启用 Tavily MCP |
| `TAVILY_MCP_URL` | Tavily Remote MCP | MCP 地址 |
| `TAVILY_API_KEY` | 空 | Tavily API 密钥 |
| `SEARCH_MAX_RESULTS` | `5` | 单次搜索结果数，范围 5–20 |
| `TRACING_ENABLED` | `true` | 是否采集 OpenTelemetry Trace |
| `TRACE_CONTENT_ENABLED` | `true` | 是否把 Prompt、Response、工具参数和结果写入本机 Phoenix |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Phoenix 本地端点 | OTLP HTTP Trace 地址 |
| `PHOENIX_UI_URL` | `http://localhost:6006` | 运行查询提示地址 |
| `LIVERMORE_WEB_PORT` | `4310` | 本地 Agent Web 监听端口 |
| `LIVERMORE_WEB_UI_URL` | `http://127.0.0.1:4310` | 系统命令打开的 Agent Web 地址 |
| `FEISHU_APP_ID` | 空 | 飞书企业自建应用 ID |
| `FEISHU_APP_SECRET` | 空 | 飞书企业自建应用密钥，仅保存于本地 `.env` |
| `FEISHU_WEBHOOK_URL` | 空 | 可选的旧式飞书群机器人 Webhook |
| `WECHAT_WEBHOOK_URL` | 空 | 企业微信群机器人 Webhook |
| `NOTIFY_ON_SUCCESS` | `true` | 是否汇报成功任务 |

配置始终从项目根目录 `.env` 加载，不依赖启动目录。
当输入、输出价格均有配置时，运行成本按
`(输入 Token（含缓存）× 输入单价 + 输出 Token × 输出单价) / 1,000,000`
计算；未配置时沿用 Pi 模型注册表返回的成本。

## 数据目录

```text
data/livermore.db       任务、持仓、风险快照、来源、报告、评估与告警账本
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
