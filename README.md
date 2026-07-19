# 玄弈 Investment Agent

一个以 Pi Agent Core 为运行内核、从 OpenClaw `workspace-invest` 逐步迁移而来的投资研究 Agent。

当前里程碑是 **M1：日报迁移闭环**。本阶段仍不包含 trace、token accounting、OpenTelemetry 或任何交易执行能力。

## 已具备

- 独立的 TypeScript 项目，不修改或复制 Pi 源码
- Pi `Agent` 最小运行循环
- 可切换 provider/model 的配置
- 从 OpenClaw 规则整理出的版本化 system prompt
- 可读取迁移清单和已纳入项目的旧版 prompt 资产
- 可将研究结果保存到本地 `data/reports/`
- 可运行“每日市场简报”和“AI 产业链日报”
- 通过 Tavily Remote MCP 检索，并在配额或网络不可用时自动直抓公开财经页面；同时提供结构化离线回放、内容级去重和可选 HTTP 上报
- 写文件工具限制在报告目录内，不提供 shell、券商或交易工具

## 启动

要求 Node.js 22 或更新版本。

```bash
npm install
test -f .env || cp .env.example .env
# 在本地且不入 Git 的 .env 中填写模型 API key
npm run dev -- "介绍你的职责，并列出当前可用能力"
```

配置统一从项目根目录的 `.env` 读取，不依赖命令启动时所在目录。默认模型为 `deepseek/deepseek-v4-flash`，使用 Pi 内置的 DeepSeek provider 访问 `https://api.deepseek.com`；在 `.env` 中填写 `DEEPSEEK_API_KEY` 即可。需要更强模型时，可将 `PI_MODEL` 改为 `deepseek-v4-pro`。

## 运行日报

实时收集优先通过 Tavily MCP 完成，默认连接 `https://mcp.tavily.com/mcp/`。如 Tavily 返回配额错误、网络失败或没有配置 `TAVILY_API_KEY`，工作流会自动改用财联社、金十、Yahoo Finance、东方财富、CNBC 等公开页面，并使用 Defuddle 提取正文。配额长期不可用时可设置 `TAVILY_MCP_ENABLED=false`，续费后再改回 `true`；`TAVILY_MCP_URL` 可切换 MCP 服务：

```bash
npm run briefing -- --task market-briefing
npm run briefing -- --task ai-industry-chain
```

执行模式按 `APP_TIMEZONE` 自动确定：市场简报分早盘、盘中增量、收盘；AI 产业链日报分早盘前瞻、收盘复盘。报告保存在 `data/reports/`，当日去重状态保存在 `data/runtime/reported-news/`。

如配置 `BRIEFING_REPORT_API_URL`，生成成功后会调用兼容 StockScope 的 `/api/briefings/report`；留空则只在本地保存。临时禁用上报可加 `--no-deliver`。

离线回放不调用搜索服务，适合回归测试和复盘：

```bash
npm run briefing -- --task market-briefing --replay /absolute/path/replay.json --at 2026-07-16T01:00:00Z --no-deliver
```

回放 JSON 格式：

```json
{
  "task": "market-briefing",
  "retrievedAt": "2026-07-16T01:00:00Z",
  "items": [
    {
      "category": "美股",
      "title": "来源标题",
      "url": "https://example.com/news/1",
      "summary": "来源摘要",
      "publishedAt": "2026-07-16T00:30:00Z"
    }
  ]
}
```

本地验证（不调用模型）：

```bash
npm run typecheck
npm test
```

## 当前边界

搜索与网页提取结果是公开资讯来源，不是交易所实时行情；页面抓取也可能受站点反爬、动态渲染或结构变化影响。这个版本还没有独立行情、持仓数据、内置定时任务、飞书投递和长期记忆；模型不能把自身知识当实时数据。调度应由部署环境触发 `npm run briefing`，投递目前只支持可选 HTTP 上报。

## 目录

```text
src/
  agent/       Agent 构造与模型配置
  briefings/   日报定义、检索、去重、生成和上报闭环
  tools/       明确授权的工具
  cli.ts       命令行入口
prompts/       版本化角色和任务 prompt
migration/     OpenClaw 资产清单与迁移记录
data/reports/  Agent 生成的本地研究报告（默认不入 Git）
tests/         不调用真实模型的单元测试
```

## 安全说明

- 不要把 OpenClaw 配置、API key、飞书标识或券商凭证复制进仓库。
- 当前 Agent 只做研究，不提供或执行交易动作。
- `save_research_report` 只能写入 `data/reports/`。
