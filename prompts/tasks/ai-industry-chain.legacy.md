# OpenClaw AI 产业链日报（已迁移）

来源：`workspace-invest/ai-industry-chain-prompt.md`

任务覆盖上游算力与芯片、中游模型与平台、下游应用与终端，以及政策与投融资，重点关注对 A/H 股的影响。

迁移落点：`src/briefings/`。已完成：

- 带发布时间、来源 URL、检索时间的数据结构
- 上中下游、政策与投融资的分领域检索
- 事实/推断分类与来源引用约束
- 早盘/收盘模式与 JSON 离线回放入口

独立标的映射和实时行情源尚未接入；缺失时必须明确披露。原 prompt 不直接加载，避免 Agent 调用旧的 OpenClaw 工具。
