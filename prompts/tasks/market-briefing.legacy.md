# OpenClaw 每日投资快报（已迁移）

来源：`workspace-invest/market-briefing-cron-prompt.md`

该任务按北京时间区分早盘、盘中增量和收盘模式，覆盖 A 股、港股、美股、宏观政策和地缘信息，并用当日已报道记录去重。

迁移落点：`src/briefings/`。已完成：

- Tavily MCP 检索，以及配额不可用时的公开财经页面直抓与 Defuddle 正文提取
- 基于稳定 URL ID 的按日去重存储
- 自动模式选择、报告落盘和可选 HTTP 上报
- JSON 离线回放入口与核心单元测试

独立实时行情源、外部定时调度与飞书投递不在本次闭环内。原 prompt 不直接加载，避免 Agent 误认为旧的 OpenClaw 工具和绝对路径仍然可用。
