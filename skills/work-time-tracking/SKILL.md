---
name: work-time-tracking
description: 工作活动记录、AI 用量归因与日/周/月/项目复盘 Skill。适用于通过 Codex、WorkBuddy 等宿主 Hook/Event 或手动输入记录工作事项，结算 Conversation、Turn、Skill 用量，查询历史与成本洞察，生成总结，并可选同步 TickTick 或 GitHub。用户说“记录/补录/暂停/继续/今天做了什么/生成日周月或项目总结/这次花了多少 Token/同步到滴答清单/查看自动记录与安全状态”时使用。只想管理滴答清单普通任务时使用 ticktick-work-review；纯灵感记录不使用本技能。
agent_created: true
version: "3.27"
---

# 工作时间自动记录（work-time-tracking）

## 定位

> 个人 AI 工作活动记录、AI 成本归因、周期复盘与日志持久化。

Skill 负责理解与决策，包括提取工作事项、总结内容、判断项目与工作类型、撰写复盘。Script 负责计算与执行，包括解析、统计、写入、去重、同步、清理、日期计算与校验。

## 输入与输出

- 输入：自然语言记录或查询、宿主 Hook / Event、已有结构化日志、可选的日志目录配置。
- 输出：`current.json` 工作事项、`logs/<date>/*.jsonl` 结构化日志、`summaries/<date>.md` 总结、成本与洞察结果、可选的 TickTick 同步交接与 GitHub 归档。
- 首次使用缺少日志目录时必须询问用户；不得自行猜测目录。后续宿主必须复用同一日志目录。

## 执行主干

```text
宿主 Hook / Event 或用户输入
  → WorkItem 采集与分类
  → Conversation 结束时结算 Conversation / Turn / Skill Usage / Segment / AI Usage
  → 导出 Work Activity
  → Structured Logs（本地事实源，永久保存）
  → 日 / 周 / 月 / 项目总结与 AI 使用洞察
  → 可选：TickTick 同步、GitHub 私有归档
```

三条硬约束：

```text
✗ Conversation 结算不能等到复盘时才执行
✗ 日 / 周 / 月 / 项目总结不能重新解析历史对话
✗ GitHub 只能作为归档出口，不能成为复盘数据源
```

## 执行路由

| 工作 | 归谁 | 入口 |
|---|---|---|
| 解析、统计、写入、去重、同步、清理、校验 | Script | 见 `references/script-index.md` |
| 分类、过滤、合并与确定性输出格式 | Script + 本地规则 | `collect-activity.js` / `daily-summary.js` |
| 工作事项提取、成果提炼、项目与工作类型判断、复盘撰写 | AI | 使用本 Skill 流程 |
| 用户补录、修正、查询、暂停、继续、完成 | 用户命令 | 本文件“命令” |

## 核心决策规则

| 领域 | 常驻决策规则 | 按需规范 |
|---|---|---|
| 事实源 | Structured Logs 是本地事实源；`logs/` 与 `summaries/` 永久保存，Raw 默认保留 7 天且只有 Raw 可清理；GitHub 本地覆盖远端 | `references/data-model.md` / `references/data-schema.md` |
| 数据模型 | Conversation、Turn、Skill Usage、Work Segment、Work Activity、AI Usage 独立记录，各有业务键；`conversation_id` 只作关联键；Skill Receipt 是只读派生视图 | `references/data-schema.md` |
| 结算 | Conversation 结束立即结算；幂等写入；不得重新解析已完成的历史对话；新日期到达时非破坏性跨日，不丢记录 | `references/settlement.md` |
| 成本 | Token 与积分独立呈现、互不换算；取不到真实值记 `null`，禁止估算或摊派 | `references/cost-statistics.md` |
| 归属 | AI 成本只按已有 `conversation_id` 精确归属；缺失、歧义和未归属不得按比例拆分 | `references/cost-statistics.md` / `references/work-segments-and-usage.md` |
| 证据 | `session_id` 从 Hook 到 Work Activity 全程保留；`conversation_id` 必须查证，不能按日期、项目或时间推断 | `references/settlement.md` / `references/data-schema.md` |
| 时间 | AI 生成记录不产出时长；`manual` 只累计闭合时段；开放段不得用 `now` 落盘；时长必须带 `duration_source` | `references/data-model.md` |
| 分类 | 工作、探索沉淀、生活等分类必须分开；PM 视角只用于工作；枚举以 `config.work.*` 为准；`output` 不得虚构 | `references/data-schema.md` / `references/project-inference.md` |
| 总结 | 按用户成果组织，不按操作过程组织；同工作意图可合并，不同项目或明确主题切换不得合并；待判断事项非空时不得对当日产出下排他性结论；已落盘日报必须先看过期检测结论，⚠ 存在时不得当作当日全貌 | `references/daily-summary.md` |
| 安全 | 所有 Activity 落盘前必须脱敏；不得使用不可靠管道处理 JSONL；`git` 只允许出现在 `sync-github.js` | `references/security.md` / `references/github-sync.md` |
| Hook | Skill 不是后台服务；Hook 失败必须可发现；Codex Hook 必须幂等自愈；PowerShell launcher 保持纯 ASCII | `references/automation.md` / `references/status-and-collectors.md` |
| 失败隔离 | GitHub、TickTick 或 AI 分析失败不得影响本地日志与复盘；部分结算失败写 `partial` 与缺失字段 | `references/settlement.md` / `references/ticktick-sync-contract.md` |

## 命令

```text
/start <content>            → 开始或新增 WorkItem
/pause · /resume · /done    → 更新 WorkItem 状态
/log <time range> <content> → 补录人工工作
/edit <work_id>             → 修改事项
/link <work_id> <task_id>   → 关联 TickTick taskId
/today                      → 查看今日记录
/summary                    → 生成并保存每日总结
/summary week|month|project → 生成周期或项目总结
/insights [scope]           → AI 使用洞察
/sync                       → 按 TickTick 契约同步
/status [today|security]    → 查看记录或安全状态
/analyze                    → 分析待归类事项
/settle [<session_id>]      → 结算 Conversation 并自动回链
/relink                     → 补事项到 Conversation 的关联
/metrics [<date>|--days N]  → 查询成本与统计
/sync-github [--apply]      → GitHub 归档，默认 dry-run
/cleanup-raw [--apply]      → 清理 Raw，默认 dry-run
/export                     → 导出 Work Activity
```

完整参数见 `references/settlement.md` 与各脚本 `--help`。

## 首次安装

1. 运行 `node scripts/status.js`。
2. 询问用户日志目录，不得自行猜测。
3. 检查读写权限与已有日志，再决定是否复用。
4. 初始化：`node scripts/init-log.js init --dir "<路径>" --create`。
5. 登记宿主触发能力：`node scripts/status.js host ...`。
6. 再次运行 `status.js` 确认。

第二个工具安装时，必须复用已有 `config.json` 与 `.log-manifest.json`，不得创建第二个日志目录。宿主配置见 `references/automation.md`。

## 按需规范

| 需求 | 读取 |
|---|---|
| 脚本职责与执行入口 | `references/script-index.md` |
| 自检、回归测试与隔离要求 | `references/testing.md` |
| 结构化日志字段、Turn、分类与归属字段 | `references/data-schema.md` |
| WorkItem、Activity、DailyLog、并发与生命周期 | `references/data-model.md` |
| Token、积分、模型、四维归因与占比 | `references/cost-statistics.md` |
| Work Segment、AI Usage、partial 与 unallocated | `references/work-segments-and-usage.md` |
| 结算、幂等、异常三态与重新解析 | `references/settlement.md` |
| 日报、周报、月报、项目报告与 AI 使用洞察 | `references/daily-summary.md` |
| 项目、工作类型与探索沉淀判定 | `references/project-inference.md` |
| GitHub 仓库创建、比较、冲突与归档 | `references/github-sync.md` |
| Hook、定时任务、触发配置与故障排查 | `references/automation.md` |
| 配置项、默认值与 fail-closed 规则 | `references/config-reference.md` |
| 宿主适配与 AI 调用策略 | `references/trigger-adapters.md` |
| TickTick 同步契约与 taskId 回写 | `references/ticktick-sync-contract.md` |
| 采集边界、脱敏与超长内容 | `references/security.md` |
| 状态三态与宿主触发状态 | `references/status-and-collectors.md` |
| 版本变更史 | `references/changelog.md` |

## 与其他技能的关系

| 技能 | 负责 |
|---|---|
| `work-time-tracking` | 工作事项、结构化日志、成本归因与复盘 |
| `ticktick-work-review` | 滴答清单任务管理与同步 |
