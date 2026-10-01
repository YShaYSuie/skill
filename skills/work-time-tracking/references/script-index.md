# 脚本职责索引

> 本文件用于按需查询脚本职责与执行入口，不属于每次调用都必须加载的常驻规则。

## 执行路由

| 工作 | 归谁 | 入口 |
|---|---|---|
| Conversation 数据解析，Model / Token / Score 解析 | Script | `parse-workbuddy.js` / `parse-codex.js` / `settle-conversation.js` |
| Skill 使用与 Skill Token 解析、日志写入与去重 | Script | `settle-conversation.js` |
| Conversation / Turn / Token / Score / Skill / Model / 时间 / 四维归因统计 | Script | `aggregate-logs.js` |
| AI 使用洞察 | Script | `daily-summary.js insights` / `lib/insights-engine.js` / `lib/skill-inventory.js` |
| 文件比较、GitHub 同步、Raw 清理、日期计算、数据校验 | Script | `sync-github.js` / `cleanup-raw-logs.js` / `validate-log.js` |
| 分类、项目阶段、内容过滤、合并与输出格式 | Script + 本地规则 | `collect-activity.js` / `daily-summary.js` |
| 工作事项提取、内容总结、项目与工作类型判断、成果判断 | AI | 无独立脚本 |
| 日 / 周 / 月 / 项目复盘撰写、成果提炼、自然语言输入理解 | AI | 无独立脚本 |

不得让 AI 重新计算脚本可以确定性算出的数据；脚本无法提供的数据不得估算补齐。

## 核心脚本

| 脚本 | 职责 |
|---|---|
| `scripts/parse-workbuddy.js` | 读取 WorkBuddy 原始数据，提取 Conversation / Model / Token / Score / Skill / Skill Token；只读，支持 `--doctor` |
| `scripts/parse-codex.js` | 读取 Codex rollout，提取 Conversation / Model / Token / 用户输入；只读，支持 `--doctor` |
| `scripts/settle-conversation.js` | Conversation 结束结算：调用解析、写 Conversation Log 与 Skill Usage Log、去重、标记 `settlement_status`、自动回链事项；支持 `--relink` |
| `scripts/lib/conversation-store.js` | 六类结构化日志的归一化、确定性 ID、幂等 upsert；含 Turn |
| `scripts/lib/codex-conversation-parser.js` | Codex rollout 解析：`session_meta` / `token_usage_record` / 用户输入归一为 Conversation 载荷 |
| `scripts/lib/skill-receipt.js` | 只读派生视图：按 Turn 对 Skill 事件去重，生成中间或最终回执，不写事实日志 |
| `scripts/aggregate-logs.js` | Structured Logs 的唯一统计入口，支持单日、区间与 `--days`，零 AI 调用 |
| `scripts/sync-github.js` | 检查或创建仓库、Private 设置、文件比较、上传覆盖、Commit；唯一允许执行 git 的文件 |
| `scripts/cleanup-raw-logs.js` | 按 `retention_days` 清理 Raw，默认 dry-run |
| `scripts/export-work-activities.js` | 把已归类 WorkItem 导出为永久 Work Activity 日志，幂等 |
| `scripts/collect-activity.js` | Activity 采集入口：`ingest` / `pending` / `analyze` / `apply` / `project`；校验分类枚举 |
| `scripts/write-work-item.js` / `update-work-item.js` | WorkItem 新增与状态流转；支持自动跨日、分类、项目阶段、成果和 TickTick 关联 |
| `scripts/daily-summary.js` | 今日记录、总结素材、日 / 周 / 月 / 项目草稿、保存总结、`metrics`、`insights` |
| `scripts/lib/insights-engine.js` | 洞察报告取数与渲染：Skill 盘点、模型对比、成本分布、项目阶段侧重；只读、零 Token |
| `scripts/lib/skill-inventory.js` | 已安装 / 已部署 / 已使用 / 已装未用 Skill 对账；识别显式引用与 SKILL.md 真实载入 |
| `scripts/hook-bridge.js` | 宿主 Hook 入口：事件 JSON 转 Activity 与结算触发 |
| `scripts/ensure-codex-hooks.js` | Codex Hook 幂等自检、自动修复、信任校准；固定使用 PowerShell 安全 launcher |
| `scripts/lib/project-resolver.js` | 项目归属唯一解析入口：WorkBuddy 空间项目 / Codex 本地项目 / `cwd` 转项目名与溯源 |
| `scripts/lib/codex-project-resolver.js` | 读取 Codex `state_5.sqlite` 的 `projects` / `project_roots`，解析本地项目 |
| `scripts/lib/activity-link.js` | 事项与会话回链：建立 `session_id` 到 `conversation_id` 索引，补 WorkItem 与 Work Activity |
| `scripts/status.js` / `validate-log.js` / `lock-log.js` / `init-log.js` | 状态查询、自检、加锁、初始化与跨日 |
| `scripts/auto-maintenance.js` | 宿主定时任务兜底入口：补算会话、导出事项、检查采集与结算链路，零 AI |

完整参数以各脚本 `--help` 与 `references/settlement.md` 为准。
