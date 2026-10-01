# 版本变更记录（changelog）

> 本文档承载版本演进历史。**AI 执行任务时不需要读它** ——
> 只在需要追溯「某个口径为什么是这样」时查阅。
>
> **版本口径**：本技能**当前版本为 V3.27**，`SKILL.md` 的 `version` 字段与此一致。
>
> ⚠️ 同日存在**多个会话并发编辑本技能**的情况：V3.24 / V3.24.1 由总结工作线写入，
> V3.25 由「时长口径」工作线写入，V3.26 由「Turn / Skill Receipt」工作线写入，
> V3.27 由「日报过期检测」工作线写入。
> **早期两条线曾撞号（都用了 V3.24），已统一改号。** 后续再并发编辑时建议先约定版本段，避免重号。
> 条目次序为**日期为主序（新→旧）、同日内按版本号降序**；合并自另一条开发线的条目
> （如 `V3.5.0`、`V3.6`）**沿用其原编号**，不改写历史。

---

## V3.27 —— 日报过期检测（2026-09-28）

**用户决定**：给 `daily-summary.js` 增加过期检测 —— 当已存在日报的时间戳早于最后结算时间、
且期间新增 Conversation 超过阈值时，输出 ⚠ 提示，避免任何人（包括 AI）误用旧版日报。

**起因（真实事故）**：2026-09-28，`summaries/2026-09-28.md` 生成于 14:36，
而当天 Conversation 从 10 个涨到 25 个。文件本身没有任何过期标记，
读取者据此得出了不完整的当日结论 —— 下午的 PRD、需求分析、原型等工作全部缺席而不自知。

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 `detectSummaryStaleness()` | 判定口径：日报已存在 ∧ `generated_at` < 最后结算时间 ∧ 其后新增 Conversation ≥ 阈值 |
| 2 | 新增 `staleThresholdOf()` | 读 `config.summary.stale_conversation_threshold`，缺省 3，非法值回退 |
| 3 | `normalizeConfig` 登记新配置键 | ⚠️ 白名单机制会静默丢弃未登记键，不登记则用户写了也不生效 |
| 4 | `today` / `draft` 输出过期提示 | 文本置首行；`--json` 增加 `summary_staleness` 字段 |
| 5 | `summaries/<date>.md` 头部增加「数据截止」 | 只写静态的截止时刻，**不写**动态的「是否过期」——后者写进文件即开始说谎 |
| 6 | 新增 `--no-stale` | 脚本级关闭检测，不写配置 |
| 7 | 新增 `scripts/test-summary-staleness.js` | 25 项断言：识别 / 不误报 / 阈值 / 非法值回退 / 只读性 / 头部渲染 |
| 8 | `daily-summary.js` 导出纯函数 | 配合 `C.runMain(fn, module)` 守卫，支持进程内测试 |

**设计约束**：

- **只报不改**：检测不触发重新生成、不写任何文件（测试钉住「前后字节一致」）。
- **宁可漏报，不可误报**：缺时间戳、文件缺失、读取失败一律 `stale:false`。
  误报会让用户对所有 ⚠ 脱敏，比漏报更糟。
- **静态文件不写动态结论**：过期随时间变化，只存在于读取时的计算结果中。

**为什么不做成自动重新生成**：日报的撰写需要 AI 参与且涉及「待判断事项非空时不得下排他性结论」，
自动重生成会绕过这一闸门。本版本只做「让过期可被发现」，是否重生成仍由用户决定。

**兼容性**：纯增量。既有日报、既有命令输出结构、日志字段均不变；
新增的 `summary_staleness` 字段对旧调用方无影响（不解析即忽略）。

---

## V3.26.1 —— 文档结构轻量化（2026-09-28）

**用户决定**：按检查结果重构技能文档，降低每次调用时的常驻上下文成本，但不改变任何运行能力、日志字段或用户命令。

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | 压缩 `SKILL.md` | 从 573 行 / 38.3 KB 精简为常驻决策层，只保留定位、输入输出、主干、路由、12 组核心规则、常用命令、首次安装与规范索引 |
| 2 | 缩短 description | 从 738 字符缩减为精准能力、适用场景、主要触发语与不适用边界 |
| 3 | 新增 `references/script-index.md` | 承载脚本职责与 Script / AI 路由细节，按需读取 |
| 4 | 新增 `references/testing.md` | 承载自检命令、回归测试矩阵、改动到测试映射与隔离要求，按需读取 |
| 5 | 合并重复规则 | 原“核心原则”和“执行纪律”中的重复条款统一为常驻决策表，并由既有领域 references 保留权威细节 |
| 6 | GUIDE 同步 | 修正版本号，补充“使用前需要准备什么”；未重构或复制技术正文 |
| 7 | 目录清理 | 删除已被现行 `automation.md` 和 `test-egress-guard.js` 取代的历史 `.bak` 文件 |

**兼容性**：纯文档结构优化，脚本、配置、日志格式、命令、同步契约和总结口径均不变。

---

## V3.26 —— Turn 与 Skill Receipt：从会话级扩展到轮次级（2026-09-28）

**用户决定**：会话中的 `turn` 要独立记录；Skill 回执要与持久化日志对齐。

**为什么不能把 Message 当 Turn**：

```text
Conversation = 一次连续上下文会话
Turn         = 一次用户请求 + 后续全部 Agent 工作
Item/Message = Turn 内的单条消息/动作
Model Request = Turn 内的一次模型调用；一个 Turn 可有多次请求
```

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 `turns.jsonl` | 业务键 `turn_id`；记录 provider_turn_id、ordinal、请求数、每轮 Token、状态 |
| 2 | Codex 解析 `turn_token_usage` | 按 `token_usage_record.turn_id` 归并，取最后一个 `turn_token_usage` 绝对值 |
| 3 | Skill Usage 增加 Turn 关联 | 新增 `turn_id` / `provider_turn_id` / `turn_ordinal` / `event_ordinal` |
| 4 | 新增计数拆分 | `skill_invocation_count` = 事件数；`distinct_skill_count` = 去重 Skill 数 |
| 5 | 新增 `skill-receipt.js` | 只读派生视图：中间回执按事件累计，最终回执按 `skill_id` 去重 |
| 6 | 结算与校验 | `settle-conversation.js` 写 Turn；`validate-log.js` 校验 Turn 引用和数量一致性 |
| 7 | 回归测试 | 新增 `test-skill-receipt.js`；扩展 `test-codex-conversation.js` 覆盖 Turn 与关联 |

**不变量**：

```text
✓ Turn 总量精确，但不按 Skill 摊派
✓ Skill 日志保留每次 invocation；Receipt 只做展示去重
✓ 无 turn_id 的历史数据保持兼容，不猜测归属
✗ 不用 Message / 请求代替 Turn
✗ 不让模型凭记忆生成回执；回执必须由事件派生
```

## V3.25 —— AI 生成记录不产出时长（2026-09-28）

**用户决定**：**AI 生成记录不产出时长**。AI 会话推导出的时刻（首个相关消息、会话收尾、
批量封段时刻）都不代表真实工作时长，因此不应产出「时长」这个指标。

**为什么必须按「来源」分档，而不是按「有没有 end_time」**：实测 09-20~09-24 的 112 条记录，
有 `end_time` 的 36 条中 **28 条是 AI 推导**，其中 7 条的 `end` 全是当天同步时刻 `18:56`
（批量封段）。按「有无 end」分档会把 2,164 分的假时长当成事实。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 `duration_source` 枚举 | `segments` / `segments_partial` / `open_segment` / `unknown` / `not_applicable_ai_session` / `live`。**`null` 的时长从此可解释** |
| 2 | `recalc()` 重写 | 非 `manual` 来源 → `actual_duration = null` + `not_applicable_ai_session`（即便带 `end_time` 也不计时）；`manual` 只累计**闭合时段** |
| 3 | **落盘禁止使用 `now`** | 旧实现用 `now − start` 给开放段定价：同一份历史数据换个时刻重算结果就变，且实质是编造结束时间（§13）。现改为 `null` + `open_segment` |
| 4 | `live` 只进展示 | `live=true` 才允许把开放段算到 now，标 `live`；`validate-log` 会拒绝落盘出现的 `live` |
| 5 | `unionMinutes()` 排除开放段 | 否则 `wall_clock_minutes` 随查询时刻漂移、越晚查越大 |
| 6 | 修 `0` 与「不可获取」混淆 | `Number.isFinite(Number(null)) === true` 把「取不到」写成 `0` —— 与 V3.22 修的 `load_chars` 同类。`toActivity` 与 `normalizeWorkActivity` 两处都修 |
| 7 | `validate-log.js` 可进程内调用 | 抽出并导出 `runValidate(dir, strict)`，并补上 `runMain(fn, module)` 守卫（此前未传 module，require 即执行 CLI） |

**新增不变量（`validate-log` 强制）**：

```text
✗ 非 manual 来源 且 actual_duration ≠ null      → problem
✗ duration_source 不在枚举内                    → problem
✗ duration_source === 'live' 出现在落盘日志      → problem
```

**历史数据重算（一次性）**：09-20~09-24 的 `logs/<date>/work-activities.jsonl` 与
`pending/2026-09-24.json` 按新口径重算 —— **9,390 分 → 692 分**（只保留人工明确闭合时段）。
只改时长字段，`start_time` / `end_time` / `time_segments` 全部保留（结束时间仍作记录收尾留痕）。

**验证**：新增 `scripts/test-duration-policy.js`（42 项全通过，进程内）；
真实目录 `validate-log` 恢复 `ok: true / problems: 0`。

**遗留（待用户决定）**：是否在报表中单列「跨度上界」（`≤ min(同会话下一条事项开始, 当日最后活动)`，
不计入合计）。注意 AI 会话可能**跨天续接**（实测 09-24 的一条会话延伸到 09-28），上界必须同日截断。

---

## V3.24.1 —— TickTick 同步契约：AI 推导结束时间不得进备注（2026-09-28）

**背景**：滴答清单里同步出的事项备注出现了
`本地区间：11:30-11:42；结束时间为会话收尾，非真实结束` 一行 ——
把 AI 推导的（不可信的）会话收尾时间写进了人读的备注，还额外配了一句免责声明。

**问题定位**：根因在 `ticktick-work-review` 侧（其 `content` 模板此前只给示例、未给禁写清单，
且「完整区间写 `content`」与「AI 推导结束时间仅保留本地时间线」两条口径互斥），
但本技能的同步契约 §5.3 只封了 `dueDate` 一个出口，**没封备注** —— 同一处漂移可以从这里重新长回来。

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | `ticktick-sync-contract.md` §5.3 | 「AI 推导事项不得把该 `end_time` 写 `dueDate`」追加「**也不得写进备注（`content`）**」，并注明备注写什么由 `ticktick-work-review` 的 `content` 模板定义 |

**跨技能对应记录**：`ticktick-work-review/references/changelog.md` V1.1（模板与禁写清单补全、
三处互斥口径修正、`scripts/validate-content.js` 校验落地）。

**兼容性**：纯口径澄清，不改变本技能的采集、计算、交接 JSON 与 `sync.status` 状态机；
交接侧**仍然必须**完整交出 `start_time` / `end_time`（时间不许在提取环节丢），
本变更只约束对方「不许把这不可信的时间写进备注」。

---

## V3.24 —— 总结按用户成果组织：能力变化、过程维护与正式素材统一（2026-09-28）

**背景（用户原话）**：产品经理关心「今天完成了什么、Skill 更新了什么功能」；
「修复了什么问题」偏开发描述，查看日志、修复网络、自动化任务结果也不是用户完成的成果。

**问题定位**：

1. 日报草稿已按「工作 / 探索沉淀」分家，但 `/summary` 正式链路仍使用旧的项目 × 类型汇总，
   会忽略显式 `category`，并把探索沉淀时长算进工作小计。
2. 旧规则把非工作分类的 `output` 一律清空，导致探索沉淀无法保存 Skill 能力变化。
3. 自动采集的查看日志、环境恢复、任务重跑等仍可能因带项目名进入主总结。

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | 正式素材统一口径 | `material` 改用 `work_board + exploration_updates`；删除旧 `project_rollup`，不再存在两套分类逻辑 |
| 2 | 素材补全分类字段 | 每条 `work_item` 带 `category` / `project_stage` / `classification_status` / `ai_role` / `detail` / `skills` / `models` |
| 3 | 探索沉淀成果可保存 | `output` 允许用于 `工作` 与 `探索沉淀`；`project_stage` 仍只允许工作 |
| 4 | 过程 / 维护活动分流 | 自动采集的查看日志、环境恢复、任务重跑、自动化结果默认不进主总结；手动记录与有明确 output 的事项保留 |
| 5 | 能力变化优先 | 探索沉淀按「新增能力 / 行为调整 / 能力移除 / 稳定性维护」分类；纯维护折叠计数 |
| 6 | 总结纪律增强 | 禁止在探索沉淀写文件名、函数名、报错堆栈；过程操作不得占成果主位 |
| 7 | 回归测试 | `test-role-profile`（97 项）覆盖分类与维护；新增 `test-summary-material-v324`（18 项）覆盖正式素材、能力变化与折叠计数 |

**兼容性**：日志字段与既有分类不变；新增只是允许探索沉淀保存 `output`，旧记录无需迁移。
已有 `output` 为空的历史探索事项仍按原样展示。

---

## V3.23 —— 补齐「已跨日事项」的通路：taskId 不再失传（2026-09-28）

**背景（用户实测发现）**：`state.pending_sync_dates` 里的历史日期无法收口。手工补做时暴露
三个只能靠一次性补丁脚本绕过的缺口 —— 根因是同一个：**凡涉及 `pending/<date>.json` 的读写都没有通路**。

| # | 缺口 | 后果 | 修复 |
|---|---|---|---|
| 1 | `update-work-item.js link` / `unlink` 只读 `current.json` | 已跨日事项**永远无法回写 taskId**，报「未找到匹配的工作事项」 | 新增 `resolveWorkItemAnywhere()`：先 current 再 pending，命中 pending 时用 `patchPendingWorkItem()` 就地写回 |
| 2 | `init-log.js sync` 只写 `current.json` | 历史日期的 `sync` 状态无法置为成功，`state.pending_sync_dates` **清不掉** | 新增 `--date`：写进 `pending/<date>.json` 并同步维护 `pending_sync_dates`（规则与 `syncState()` 对齐） |
| 3 | `export-work-activities.js` 的 `toActivity()` 不映射 `ticktick`；`normalizeWorkActivity()` 是白名单式，字段会被丢弃 | 永久活动日志**永远不带 taskId**；某日不再保留在 `pending/` 后映射彻底失传 | 两处都补 `ticktick`（`{taskId, projectId, syncedAt}`，无值置 `null`） |

**新增库函数（`lib/log-core.js`，CLI 与测试共用）**：

```text
listPendingLogDates(dir)                    列出 pending/ 下合法日期日志（排除 last-hook.json / 子目录）
readPendingLog / writePendingLog             读写 + 原子写回
resolveWorkItemAnywhere(dir,id,match,open)  跨 current / pending 定位；歧义**报错不猜**
patchPendingWorkItem(dir,date,id,set,opts)  就地改 pending 事项（Object.assign → normalizeItem → recalc）
setPendingSyncStatus(dir,date,status,det)   写 pending 同步状态 + 维护 state.pending_sync_dates
```

**顺带修正**：
- `init-log.js sync` 成功提示此前判断 `status === 'synced'`，而合法值是 `success` —— 成功分支
  永远不打印，且 usage 文本把 `synced` 写成合法值。两处均已改正（`synced` 会被 `VALID_SYNC_STATUS` 拒绝）。
- 跨 pending 的歧义报错**区分**「同一份日志内多条」与「跨多个日期命中」，否则用户无法判断该改用 `--id` 还是缩小范围。

**验证**：

```text
· 新增 scripts/test-pending-link.js：41 项全通过（**进程内调用库函数，不依赖子进程** ——
  受限沙箱禁止 node 派生 node（spawnSync → EBUSY），依赖子进程的测试在这种环境会整体假失败）
· CLI 端到端（宿主 shell 实测）：link 返回 where:"pending" 并落盘；sync --date 后
  pending.sync.status=success 且 state.pending_sync_dates 已移除该日期
· 真实数据：09-24 的 6 条事项 taskId 已进入永久活动日志
```

**历史数据补救（一次性，非工具能力）**：从 TickTick 任务 `content` 的
`来源：WorkTimeLog WI-xxx` 标记回收映射 —— 注意存在**归并形态**
（`来源：WorkTimeLog 归并自 WI-a、WI-b…`，一个任务对应多条事项），必须全局提取全部 WI id。
共回收 46 条映射，回填 `logs/2026-09-20 ~ 09-23` 中**有证据**的 40 行（09-23 全覆盖）；
归并任务未列出的 WI 保持 `null` —— **不按「同一天/同项目/时间接近」推断关联**。

**兼容性**：日志格式只新增可选字段，不改变既有字段语义；`usage_id` / `activity_id` 幂等键不变；
无 taskId 时写 `null` 而非省略；旧日志重新导出即自动带上该字段。

---

## V3.22 —— Codex 侧 Skill 识别改为「真实证据」（2026-09-26）

**背景**：用户的 Skill 主要用在 Codex，而 Codex 侧此前**只认用户输入里的显式引用**
（`$skill` / 技能路径），结果是「实际用了技能却记成 0」——本机实测：一场
156 次请求、真正读了 4 个技能定义的会话，`skill_count = 0`。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增证据 `skill_md_loaded` | 会话中**真实载入过该技能的 SKILL.md**（工具调用参数命中路径）即记一次调用；这是 Codex 侧最接近「实际执行」的客观证据 |
| 2 | 显式引用改标签 `explicit_invocation` | 用户输入里的 `$skill` / 技能路径引用仍记，但 `trigger_type = user`、`evidence = explicit_invocation` |
| 3 | 新增字段 `evidence` | Skill Usage 记录「凭什么认定用了这个技能」；取不到写 `null`（WorkBuddy 由宿主 `callId` 判定，无需证据类型） |
| 4 | 只认 SKILL.md，不认技能目录 | `skills/<name>/scripts/x.js` 属于开发 / 排查，不算「使用了技能」 |
| 5 | `apply_patch` 不计入 | 改技能源码 ≠ 使用技能（正在修技能时最容易误报的场景） |
| 6 | 修 `load_chars` 的 0 值 bug | 旧写法 `Number.isFinite(Number(null))` 为真（`Number(null) === 0`），把「取不到」写成 `0`；现统一为 `null` |
| 7 | `skill_count` 口径对齐 | 此前 Codex 侧写的是「去重后的技能数」，与 WorkBuddy 侧、`data-schema` §1 的「调用次数」不一致，被 `validate-log` 交叉核对持续报警；现统一为调用次数（= Skill Usage 条数） |

**扫描范围（硬约束）**：只扫**用户输入**与**工具调用参数**。
绝不能扫整份 rollout —— 每轮请求都会注入技能目录（本机 25 条），全文扫描会把所有技能记成用过。

**踩坑记录（真实数据里发现的）**：工具调用参数是 JSON 字符串，Windows 路径里的 `\`
是**双写**的（`skills\\name\\SKILL.md`），正则只允许单个分隔符会一条都匹配不到；
现已统一用 `[\\/]+`（`extractSkillRefs` 的路径模式同步放宽）。

**验证**：

```text
· 自检：test-skill-inventory 25 项 / test-codex-conversation 20 项（新增 6 项）
        / test-conversation-settlement 78 项 / test-insights 21 项 全通过
· 真实数据：修复后重算，09-24 的技能开发会话由 0 → 多个 skill_md_loaded；
        09-26 本机会话 156 次请求 → skill_count 4，重算为 unchanged（幂等）
```

**兼容性**：日志格式只新增一个可选字段；usage_id 幂等键不变；
WorkBuddy 侧识别、Token / 积分口径、禁止摊派规则全部不变。

---

## V3.21 —— 修复「每天第一条记录都失效、每天手动排查」（2026-09-26）

**用户原话**：work-time-tracking skill 每天第一条记录都失效，每天都需要再手动排查。

**根因（两个缺陷叠加，均已实测复现）**：

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | Codex 的 `config.toml` hooks 段被应用重写时整段丢失，且没有任何自愈 | 备份 `config.toml.bak-wb-rescue-20260923`（09-23 23:15）含 5 个 Hook；当日 09-24 22:18:43 重写后的 config.toml 一个都没有；`~/.codex/automations` 不存在、无任何计划任务 |
| 2 | `codex-hook-launcher.ps1` 找不到 node 时**静默 exit 0** | 只认 WTT_NODE_BIN / Codex 托管 runtime / PATH，本机三者全空（`~/.cache/codex-runtimes` 是空目录、node 不在 PATH、变量未设）；手工喂 SessionStart → 退出码 0、`current.json` 未创建 |

**后果**：用户的真实工作主要在 Codex，而 Codex 侧从未成功采集过一条记录
（`state.json.hosts` 里只有 workbuddy，codex 恒为 unconfigured），
`/status` 却只显示「已开启但暂无活动」。

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | launcher 候选清单解析 node | WTT_NODE_BIN → 缓存 → Codex 托管 runtime → Codex 应用 runtime → **WorkBuddy 自带 node** → PATH → 常见位置；命中后缓存到 `~/.work-time-tracking/node-path.txt` |
| 2 | 失败留痕 | 找不到 node 时写 `<log_dir>/pending/launcher-trace.jsonl`（有界，只记失败），不再无声空转 |
| 3 | 自愈看门狗 | `hook-bridge.js` 在每次 SessionStart 幂等重装 Codex hooks（WorkBuddy 的 Hook 在 settings.json 里，不会被 Codex 重写，故作为看门狗） |
| 4 | 会话开始对账 | SessionStart 顺带 `auto-maintenance.js --days 3`（零 AI、1 小时冷却、跨天必跑）：用会话原文补回 Hook 没覆盖的窗口；`auto-maintenance.js` 新增 `--days N` |
| 5 | 自检显式报错 | `ensure-codex-hooks.js` 输出 `node.resolved`；解析不到 node 时列为 issue（不再绿灯）；`status.js` 在「部分宿主未接入」时点名宿主与修复命令 |
| 6 | 防抖动 | 已在用 launcher 且 PowerShell 安全的命令行不再被重写（否则每次会话都会重写 config.toml 并多出备份） |
| 7 | 清理排查残留 | 移除 WorkBuddy hooks 里 3 个「临时诊断探针」（原先每次 Hook 都写 `probe-trace.jsonl`） |
| 8 | 编码硬约束 | `codex-hook-launcher.ps1` 保持纯 ASCII：PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会让脚本报 `Unexpected token '}'` |
| 9 | 自检 | `test-codex-hooks.js` 增加 4 组断言：launcher 纯 ASCII、候选清单含 WorkBuddy/Codex runtime、`node.resolved` 有效、等价命令不重写 |

**验证**：

```text
· 真机 Codex 执行路径复现：修前 SessionStart → 退出码 0 且 current.json 未创建；
  修后按 config.toml 里的命令原文执行 → 退出码 0 且 hosts.codex 登记成功。
· 恢复能力：把真实日志目录复制到隔离目录后跑 auto-maintenance --days 7，
  09-22 / 09-23 / 09-24 均由会话原文补出 work-activities.jsonl，
  且 Skill 建设类事项被正确标为「探索沉淀 / AI Skill 探索」。
· ensure-codex-hooks.js 由 needs_repair 转为 ok，node.resolved 指向可用 node。
```

**兼容性**：日志格式、结算口径、归因规则均不变；新增的只有自愈、对账与诊断可见性。
对已存在的日志目录，下一次会话开始即自动完成一次对账。

---

## V3.20 —— 工作/探索沉淀分层 + AI 使用洞察（2026-09-24）

**背景（用户原话）**：

> 「我是一个产品经理……我希望在总结中区别工作上、探索沉淀或者生活上，
>  但现在的总结都是我解决了什么问题，这个是我在 ai 方面对自己的探索沉淀，
>  但在工作上面，没有很体现我的实际工作内容。同时在 ai 使用情况的总结，
>  我想要知道我的 skill 使用情况、各个模型的使用情况，我在各个 skill、
>  各项工作阶段或者各个项目上的 token/积分的使用分布。」

**问题定位（复核实际数据后确认）**：

| # | 问题 | 证据 |
|---|---|---|
| 1 | 「工作」块按内容叙述，没有 PM 交付物主轴 | 七段草稿第 2 段按工作类型分组列标题，无阶段/交付物视图 |
| 2 | AI 能力建设混进「工作」 | `AI Skill 探索` 项目下的事项按内容关键词判成工作 |
| 3 | `工作类型 / 项目 / 项目阶段` 三张成本表全空 | `capture_work_activities=off`，无带 `conversation_id` 的 Work Activity |
| 4 | 模型维度只有会话计数 | 无 Token / 缓存 / 单请求口径，且模型名有 3 种写法 |
| 5 | Codex 侧 Skill 调用完全未记录 | 用户的 Skill 主要用在 Codex，`skill-usage.jsonl` 只有 WorkBuddy |

**变更**：

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增分类「探索沉淀」 | 与工作并列；归属优先级固定为「显式 category > 生活类强信号 > 项目归属 > 内容关键词」 |
| 2 | 工作块换主轴 | 日报第 2 段改为 **产品线/项目 → 项目阶段 → 交付物**；项目进展并入该段 |
| 3 | 新增 `/insights` | 洞察报告：高频 Skill / 装了没用过 / 消耗偏高 / 模型对比 / 项目与项目阶段成本分布 |
| 4 | 模型维度 | `config.ai.model_aliases` + 去 provider 前缀归一；给出 Token / 占比 / 缓存命中率 / 平均单请求 / 积分 |
| 5 | 已装未用盘点 | 新增 `lib/skill-inventory.js`，只读中央库与各 Agent 技能目录 |
| 6 | Codex Skill 识别 | 从用户输入识别 `$skill` 与 `skills/<name>/SKILL.md`；**次数可计，载入体积仍为 null** |
| 7 | 工作口径成本表 | 新增 `by_*_work` / `project_stages_work`，剔除探索沉淀与生活类 |
| 8 | 归属二次确认 | Work Activity 新增 `classification_status`；确认后默认不再重复验证，`--recheck` 才重验 |
| 9 | 自检 | 新增 `test-insights.js`（21 项）与 `test-skill-inventory.js`（19 项） |

**兼容性**：

- 本地日志、Conversation 字段、结算与「禁止摊派」口径**全部不变**；
- 旧的 `by_project` / `by_project_stage` / `by_work_type` 保留原语义，新增的是并排的工作口径表；
- `config.work.categories` 与 `role.focus` 为加法扩展；`capture_work_activities` 模板默认仍为 `off`；
- Work Activity 新字段缺省时归一为 `pending_review`，历史记录无需迁移。

---

## V3.14 —— Codex Hook 自愈式维护（2026-09-24）

**目标**：修复 Codex Hook 在 Windows PowerShell 下因引号解析失败而不执行的问题，
并把“命令/信任状态自检与修复”纳入现有定时维护，避免用户每天人工检查。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 稳定 launcher | Hook 固定调用 `codex-hook-launcher.ps1`，runtime 路径变化无需改 Hook 配置 |
| 2 | 幂等修复 | `ensure-codex-hooks.js` 检查/补齐 5 个 Hook、修正 PowerShell 命令、校准信任哈希 |
| 3 | 维护接入 | `auto-maintenance.js` 先修复 Hook，再补算会话、导出事项与健康检查 |
| 4 | 状态防伪绿 | `status.js` 识别缺少 `&` 的 Codex Hook 命令并报未配置，而不是继续显示绿灯 |
| 5 | 自检 | 新增 `test-codex-hooks.js`，覆盖坏命令、自动修复、launcher 与幂等检查 |

**兼容性**：本地日志、Conversation / Work Activity 字段、结算和归因口径不变；
只调整 Codex 宿主 Hook 的安装与维护方式。

**目标**：保留完整问答与原始时间事实，但在今日总结中把同一工作流的多条记录归并为
一个可读事项，解决“同类型事项仍逐条铺陈”“同会话上下文已经关联却无法合并”的问题。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 同一工作意图优先 | 同 Conversation 上下文续接、同 `segment_id`、同项目同模块优先于纯关键词相似度 |
| 2 | 上下文归并 | 同会话内的继续、补充、改成、统一、短承接回答可结合前后事项判断是否同一目标 |
| 3 | 硬边界 | 已确认不同项目、明确主题切换、`category` 冲突不合并；仅同工作类型不构成合并理由 |
| 4 | 首个时间锚点 | 合并后 `start_time` 取组内第一个/最早时间；全部 `time_segments` 保留，不丢后续片段 |
| 5 | 内容提炼 | 不再机械取最长句；优先排除“怎么解决”等无独立信息短句，并可提炼工作流摘要 |
| 6 | 合并可审计 | 新增派生字段 `merge_evidence`；`merged_titles` / `merged_from` 继续保留完整来源 |
| 7 | 总结素材增强 | `material` 输出合并来源，供 AI 撰写日报时理解上下文 |
| 8 | 回归测试 | 覆盖同会话短承接、项目冲突拆分、跨会话强相关合并、首个时间与无时间排序 |

**兼容性**：不修改 `current.json` 原始记录、Structured Logs、结算、Token / Credit 归因、
TickTick 字段映射或历史日志；归并只发生在今日总结的只读派生视图中。

---

## V3.12 —— 结束时间按事项来源区分（2026-09-23）

**目标**：修正「所有 `end_time` 都不可信」与「所有 `end_time` 都可同步」两种极端口径。

| # | 变更 | 说明 |
|---|---|---|
| 1 | AI 推导事项 | `end_time` 视为会话结束/记录收尾，不是真实结束；TickTick 只同步 `start_time -> startDate` |
| 2 | 手动录入事项 | 明确填写的 `start_time` / `end_time` 是事实，可同步为 `startDate` / `dueDate` |
| 3 | 完整时间线保留 | 无论来源，WorkTimeLog 都完整保留 `start_time` / `end_time` 和实际时长 |
| 4 | 共享契约更新 | `ticktick-sync-contract.md` 明确 AI 推导与手动录入两种映射 |

**兼容性**：历史日志不迁移；重新同步时按 WorkItem `source` 和明确时间字段执行新规则。

---

## V3.11 —— Credit 适用性、Skill 分布与会话级项目 AI 使用（2026-09-23）

**目标**：让日报口径与最终日报一致：Credit 只属于积分类 Agent；API 不产生积分；
AI 使用章节明确展示 Skill 分布，并新增 Conversation 级项目 AI 使用汇总。

| # | 变更 | 说明 |
|---|---|---|
| 1 | Codex Credit 语义修正 | Codex / API 会话从 `unavailable` 改为 `0 + score_source=not_applicable` |
| 2 | 下界只统计适用请求 | `score_is_lower_bound` 只在积分类适用请求内判断，不把 API 误算成积分缺口 |
| 3 | Skill 分布补全 | 输出有 Skill 的 Conversation 数、未记录 Skill 的 Conversation 数、失败与载入 Token |
| 4 | Conversation 项目分布 | `cost.conversation_projects[]` 按 Conversation `project` 汇总 Conversation / 请求 / Token / Credit，标记范围口径 |
| 5 | 项目表展示修正 | `not_applicable` 或不可获取的项目 Credit 显示为空 |
| 6 | 日报结构更新 | AI 使用章节拆为汇总、Credit 口径、Skill 分布、项目 AI 使用、事项级项目归因 |
| 7 | 回归测试 | 更新 Codex Credit 断言，新增项目分布、未记录 Skill 与 not_applicable 下界测试 |

**兼容性**：现有 Token、Skill 载入体积、Work Activity 项目归因、AI Usage 精确归属、
日 / 周 / 月总结全部保留；旧记录重新 `--backfill` 后会按新 Credit 语义覆盖修正。

---

## V3.10 —— Codex 多 rollout 会话归一（2026-09-23）

**目标**：Codex 同一逻辑会话可能由多个 rollout 分片组成，旧解析器只取文件名匹配的
第一个分片，导致续写后的用户输入、结束时间和 Token 总账停留在半路，也会把
`guardian_review` 审批线程误识别成重复会话。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 主分片改由 SQLite 确定 | 优先使用 `state_5.sqlite.threads.rollout_path`，不再仅按文件名猜测 |
| 2 | 历史前缀合并 | 依据 `history_base.end_ordinal_exclusive` 合并主分片之前的用户输入 |
| 3 | 分片去重 | 按 `ordinal + 文本` 去重问题，按 `response_id` 去重请求；重复回放不重复计数 |
| 4 | 总账口径修正 | Token 取主分片绝对值，不再累加分支；起止时间覆盖完整会话 |
| 5 | 内部子线程隔离 | `thread_source != user`（含 `guardian_review`）不进入用户问答和 Conversation 总账 |
| 6 | 最近会话去重 | `parse-codex --latest` 按 `session_id` 只返回一个用户会话，不再被多个 rollout 分片重复占位 |
| 7 | 审计信息 | Raw Snapshot 增加主分片、历史分片、忽略分片、内部子线程与归因来源 |
| 8 | 回归测试 | `test-codex-conversation.js` 覆盖续写、重复回放、审批线程、Token / 请求数 / 时间口径 |

**兼容性**：WorkBuddy 解析、结算幂等、`conversation_id` 回链、四维成本归因与日志格式
全部保留；旧记录无需迁移，重新执行 `--backfill` 会按主分片绝对值覆盖修正。

---

## V3.9 —— Codex 本地项目归属兼容（2026-09-23）

**目标**：Codex 的项目数据保存在本地 `state_5.sqlite`，但旧实现只读取
`~/.codex/config.toml` 并从目录名推导项目，导致“物联管控”被记成 `scut`、
“学习探索类”被记成 `ai素材`，Codex WorkItem 也没有稳定继承 `session_id` 与项目证据。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 Codex 本地项目解析器 | `scripts/lib/codex-project-resolver.js` 只读读取 `projects`、`project_roots` 与 `threads` |
| 2 | 项目 ID 类型隔离 | Codex UUID `project_id` 不再交给 WorkBuddy 的 `p_<hex>` 空间项目解析器 |
| 3 | 双路径解析 | 优先 `threads.project_id -> projects.name`；无 ID 时用 `cwd` 对项目根目录做最长前缀匹配 |
| 4 | Hook 项目传承 | `collect-activity.js ingest --host codex` 将正式项目名、`project_id`、`session_id` 写入 Pending / WorkItem |
| 5 | 结算兼容 | `codex-conversation-parser.js` 在写 Conversation 时使用同一套 Codex 本地项目解析与溯源字段 |
| 6 | 离线保留 | 项目解析只读本地 SQLite，不联网；SQLite 不可用时回退 `config.toml` 目录清单 |
| 7 | 回归测试 | 扩展 `test-codex-conversation.js`，覆盖项目 ID、项目根目录、Pending 与 WorkItem 传承 |

**兼容性**：WorkBuddy 空间项目、在线缓存、既有 `config.project_map`、会话结算、
回链、日 / 周 / 月总结与 TickTick 同步全部保留。旧记录无需迁移。

---

## V3.8 —— 修正宿主 Hook 记账口径的误判（2026-09-23）

**目标**：更正 `scripts/hook-bridge.js` 头部一条**已被实证推翻**的结论，避免后续排查
继续往「压缩脚本自身耗时」这个已经没有收益的方向走。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 记账口径修正 | 旧注释断言宿主 `elapsed` = 「bash 包装进程的存活时长」。实证推翻：同一时刻另一个**与本技能无关**的 Hook（tencent-docx 插件 SessionStart 的 `setup.sh`）命令里**已显式写 `& ... </dev/null >/dev/null 2>&1` 后台化**，宿主仍记 `elapsed=38799ms timedOut=true` → **后台化并不能让 Hook 提前结账，记账口径覆盖 Hook 派生的子进程树** |
| 2 | 补实测数据 | 2026-09-23 同机同 Hook：空闲 `elapsed=3010/3158/5253ms timedOut=false`；会话启动 + 插件 setup 抢资源时 `elapsed=29598/31187/38907ms timedOut=true`。基线成本：Git Bash 冷启动 1.2~3.9s、node 冷启动 ~0.6s、脚本自身 0.16s |
| 3 | 明确后续方向 | 注释写明：要让 Hook 稳定落在预算内，应**改为只落盘 spool、不派生子进程**（由下次会话或定时任务消费），或调大 `settings.json` 里该 Hook 的 `timeout`（单位：秒）；继续压缩脚本自身已无收益 |
| 4 | 澄清与数据完整性的关系 | 超时是**环境负载的函数**，与采集成败无关 —— 产物 `current.json` / `state.json` / `conversations.jsonl` 均在用户消息后 ~1.3s 内落盘，零丢数据；宿主报 `Hook blocked operation` 属噪音 |
| 5 | 环境缺陷备注（未修） | 本机 Git Bash 的 PATH 缺自身 `/usr/bin`，致 shim 每次启动报 `dirname: command not found` / `cd: null directory` |

**兼容性**：**纯文档修正，无任何行为变更** —— 不涉及脚本逻辑、数据格式、配置 schema
与日志口径，无需迁移、无需重跑、无需回填。

---

## V3.7 —— Codex 会话结算与沙箱写权限说明（2026-09-23）

**目标**：补齐 Codex 侧的两个真实缺口：会话结算只认 WorkBuddy，
以及 Codex Hook 因任务沙箱无日志目录写权限而静默失败。

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 Codex rollout 解析器 | `scripts/lib/codex-conversation-parser.js` 读取 `sessions/**/rollout-*.jsonl` 的 `session_meta`、`token_usage_record`、用户输入与任务状态 |
| 2 | 新增 Codex 数据源体检 | `scripts/parse-codex.js --doctor`，只读列出 rollout 与最近会话 |
| 3 | 结算统一入口 | `settle-conversation.js` 对显式 `--session`、`--latest`、`--backfill` 同时选择 WorkBuddy 与 Codex 会话 |
| 4 | Codex Token 口径 | 使用最后一条 `thread_token_usage`；Credit 当前不可得，记 `null` + `score_source: unavailable` |
| 5 | Codex Skill 口径 | rollout 当前不提供可归因 Skill 载入体积，不写估算记录，`skill_count: 0` |
| 6 | Raw 目录分宿主 | `raw/workbuddy/**` 与 `raw/codex/**` 分离；`findRawSnapshot` 跨宿主查，清理脚本同时处理 |
| 7 | 沙箱权限文档 | `references/automation.md` 新增 Codex Desktop per-thread managed sandbox 的写入判据与修复步骤 |
| 8 | 回归测试 | 新增 `scripts/test-codex-conversation.js`，覆盖显式会话 / backfill / latest / 幂等 / raw / prompt 候选 |

**兼容性**：WorkBuddy 原有解析、Skill Usage、Score 下界、幂等写入、回链与汇总全部保留。

---

## V3.5.0 —— Work Segment、AI Usage 与结构化 detail（2026-09-23）

**目标**：把「Conversation 花了多少」细化到可审计的 Work Segment / Work Activity，
同时保留 V3.4.1 的精确归属纪律：**没有精确数据就保持未归属，不按比例拆分。**

| # | 变更 | 说明 |
|---|---|---|
| 1 | 新增 Work Segment Log | `logs/<date>/work-segments.jsonl`，业务键 `segment_id`；支持确定性 `SEG-YYYYMMDD-...` ID |
| 2 | 新增 AI Usage Log | `logs/<date>/ai-usage.jsonl`，业务键 `ai_usage_id`；记录 Token、Credit、模型、Agent、Skill 与目标事项 |
| 3 | Work Activity 扩展 | 新增 `segment_id`、`ai_role`、`detail`、`log`、`log_length`、`skills[]`、`models[]`；原有字段与来源不变 |
| 4 | Attribution Status | 支持 `exact` / `partial` / `unallocated`；未归属部分单独统计，禁止估算拆分 |
| 5 | Conversation 总账不变 | Conversation 继续保存平台完整 Token / Credit；AI Usage 只做精确归属视图 |
| 6 | 200 字语义修正 | `content` / `log` 继续控制为 200 字展示；`detail` 保存脱敏后的结构化说明，独立安全上限默认 4000 字 |
| 7 | 工作类型与项目阶段扩展 | 默认清单并入方案设计、PRD 编写、技术沟通、开发协作、测试验证、资料查询、问题排查、运营维护等新值，旧值继续兼容 |
| 8 | 结算入口扩展 | `settle-conversation.js` 支持 `--segments-file`、`--segment`、`--ai-usage-file`，并做关联完整性校验 |
| 9 | 汇总扩展 | 输出 AI Usage 精确归属、未归属 Token / Credit、AI Role 分布、项目 / 阶段 / 工作类型精确归属 |
| 10 | 安全与幂等保留 | 所有新文本仍过 Security Filter；新日志按确定性 ID upsert，重复结算不新增、不累加 |
| 11 | 回归测试 | 新增 `scripts/test-segment-usage.js`，覆盖 Segment / Usage / 未归属 / 自检上限 |

**兼容性**：

```text
旧三类日志无需迁移
旧 config.json 继续可读，新枚举自动并入
旧会话级 attributeDimension() 继续可用
日 / 周 / 月 / 项目总结、TickTick、GitHub、Hook、跨日、并发锁全部保留
```

**新增文件**：

```text
references/work-segments-and-usage.md
```

## V3.4.1 —— 新日期记录自动跨日（2026-09-23）

**起因**：`current.json` 停留在前一天时，新一天的首条 Codex / WorkBuddy
活动会被跨日闸门拒绝；Hook 输出被重定向丢弃，人工确认无人应答，导致当天记录为空。

| # | 变更 | 说明 |
|---|---|---|
| 1 | **统一自动跨日入口** | `lib/log-core.js` 新增 `ensureCurrentDate()`：旧 WorkItem 先永久导出；未同步旧日志转 `pending/<date>.json`，已同步日志按既定策略处理；随后创建当日 `current.json` |
| 2 | **采集路径自动生效** | `collect-activity.js ingest` 默认调用自动跨日，不再依赖 Hook 显式传入 `--rollover keep`；旧参数保留兼容 |
| 3 | **手工新增事项自动生效** | `write-work-item.js` 遇到新日期时先自动跨日，再写入本次事项；`dry-run` 仍无副作用 |
| 4 | **Codex 主机归属修复** | `hook-bridge.js` 读取 `--host codex|workbuddy`；此前忽略该参数、把所有活动都登记成 WorkBuddy |
| 5 | **回归测试** | 新增 `scripts/test-auto-rollover.js`，覆盖采集、手工新增、未同步 `pending/`、已同步导出与 `dry-run` |

**保留行为**：手工执行 `init-log.js rollover` 时，未同步且未给 `--decision` 仍会中止并提示；
自动记录路径使用非破坏性的 `keep` 语义，不删除未同步记录。

---

## V3.6 —— Hook 超时第三次复发：按宿主日志定位，压掉最后一段自耗（2026-09-22）

**起因**：用户再次遇到 `UserPromptSubmit` 被挡：
`Hook timed out after 10000ms: node …/hook-bridge.js >/dev/null 2>&1`。

### 先取证，再改代码

| 证据 | 来源 | 结论 |
|---|---|---|
| `[HookExecutor] spawn pid=… shell=<PortableGit>/bash.exe timeout=10000ms cmd="node" "hook-bridge.js" >/dev/null 2>&1` | 宿主日志 `~/.workbuddy/logs/<date>/<workspace>__*.log` | 宿主**用 bash 包装**执行本脚本（`>/dev/null 2>&1` 强制走 shell），预算 10s |
| `[HookExecutor] abnormal exit pid=… code=0 elapsed=12413ms timedOut=true` | 同上 | 宿主按**bash 包装进程的存活时长**记账并强杀；超时的那次实测 12.4s |
| `elapsed` 分布：1020 / 1080 / 1330 / 1536 / 2103 / 2882 / 4206 / 12413 ms | 同上，同日多次调用 | 本机 Git Bash + node 冷启动本身就有 1.0~3.2s 抖动；**并发高/机器忙时会冲到 10s+** |
| `stdin_mode:"early"`, `stdin_ms:8`, `elapsed_ms:130` | 本脚本写入的 `pending/last-hook.json`（新加字段） | 宿主**立刻**把完整载荷写进管道（attached 后 8ms 到齐）；**脚本自身只有 130ms** ⇒ 3s 的 stdin 截止纯属白等，超时的大头在进程启动 |

> 归因（诚实版）：**脚本自身的逻辑早就不是瓶颈**（130ms），12.4s 那次是
> 「bash 启动 + node 冷启动 × 机器高负载（应用重启 / 杀软扫描 / 多会话并发）」叠加。
> 脚本可控的部分只剩「别白等 stdin」，其余要靠降低 Hook 触发频率或换调用方式。

### 变更清单（`scripts/hook-bridge.js`）

| # | 变更 | 说明 |
|---|---|---|
| 1 | **首字节截止 300ms** | 管道数据通常在 node 起来前就已缓冲；300ms 内一个字节都收不到 ⇒ 本次无载荷，直接返回，不再空等 |
| 2 | **整体截止 3000ms → 1000ms** | 一旦开始收数据，留 1s 收尾（含 chunked 慢速到达） |
| 3 | **`lenientParse()` 兜底** | 载荷被截断导致 `JSON.parse` 失败时，用正则取 `hook_event_name` / `session_id` / `cwd` / `prompt` / `tool_name`，**不静默丢事件** |
| 4 | **trace 增加 `stdin_mode` / `stdin_ms` / `elapsed_ms` / `lenient_parse`** | 下次复发读一个文件即可判断「宿主没写 stdin / 载荷截断 / 脚本慢」 |
| 5 | 未收到载荷时不写 trace，改记 `action:"unparsable"` | 保留「宿主有触发但格式变了」的证据 |

**实测（本机，冷启动已包含在内）**：`node --check` 通过；三种 stdin 场景
0.91s / 0.81s / 1.03s（原本最坏 3.2s+），**stdout 始终为空**（不能污染会话上下文），
`--self-test` 事件映射输出不变。脚本自身最坏耗时 ≈ 冷启动 + 1s。

### 仍未解决（需用户决策，属宿主配置层）

- **`PostToolUse` 按每次工具调用触发**（同日日志显示每分钟数十次 spawn）：
  每次都要付一遍 bash + node 冷启动。可选项：收窄 `matcher`（如只匹配 `Write`/`Edit`）、
  或直接去掉该事件（刷新型数据本来就会在 `UserPromptSubmit` / `Stop` 时补上）。
- **`>/dev/null 2>&1` 会强制宿主走 shell**：脚本已实测 stdout/stderr 全静默，
  去掉重定向或许能让宿主直接 exec node，省掉 Git Bash 启动（含本机那个报错的
  `shell-runtime-bash-env.sh` shim）。未擅自改动用户全局配置。

---

## V3.5 —— 会话结算接入 Hook（任务1 真正跑起来）（2026-09-22）

**起因**：用户反馈「这一轮对话没有被记进对话日志」。排查发现**会话结算从未被自动触发过** ——
不是脚本坏了，是**触发链路从来没有接上**。

### 症状与根因

| 症状 | 真正的原因 | 修在哪 |
|---|---|---|
| 对话结束了，`logs/<date>/conversations.jsonl` 里没有它 | 宿主 5 个 Hook（`SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Stop` / `SessionEnd`）**全部只指向 `hook-bridge.js`**，而它的 `EVENT_PLAN` 只有 `register-host` / `ingest` / `ignore` —— **没有任何动作调用 `settle-conversation.js`**。`config.settlement.auto_on_conversation_end: true` 只是一句声明 | `scripts/hook-bridge.js` |
| 有记录，但内容停在一半（Token / 时长偏小） | 记录来自**人工补算**，且补算一次后再没人重算。会话结算没有替代路径会去刷新它 | 同上 + 定时任务改 `--backfill` |
| `/status` 一直显示「🟢 已结算」，看不出问题 | 该状态由「今天有几条 conversation 记录」推出，**用数据存在性代替了触发配置校验**。只要历史上有人手动补算过一次就永远绿灯 | `scripts/status.js` 新增 `detectSettleTrigger()` |
| 单日 10 个会话只结算到 5 个 | 定时任务用的是 `--latest`，默认 `--limit 1`：**一次只结算 1 个会话** | 定时任务改 `--backfill --limit 200` |

> 归根到底是同一类错误：**把「能力存在」当成「能力已运行」**（§57）。
> 文档 §4 的现状核对表当年也用同一套证据把任务1 判成「已配且已运行」，属同一个坑。

### 变更清单

| # | 变更 | 说明 |
|---|---|---|
| 1 | **`hook-bridge.js` 接入结算** | `EVENT_PLAN` 给 `UserPromptSubmit` / `Stop` / `SessionEnd` 加 `settle: true`；三个事件各触发一次，**有意的冗余**（宿主事件可用性未知，多给几次机会） |
| 2 | **用 `--session`，不用 `--latest`** | 从 hook payload 取 `session_id` 传给 `settle-conversation.js --session <id>`。`--latest` 在多会话并发时会**结算错对象**（实测：某会话的 Hook 触发，结算落在另一个会话上） |
| 3 | **结算先于 `refreshOnly` 闸门** | 早期把结算放在「有没有进行中事项」闸门后面，导致无进行中事项时连结算也被跳过。会话结算与该闸门**无关**，已提前到 ⓪ 段独立执行 |
| 4 | **沿用 fire-and-forget** | `spawn(detached) + unref`，父进程几十毫秒返回，不占 Hook 10s 预算（与 V3.4 的超时修复同一纪律） |
| 5 | **`status.js` 新增「宿主触发」信号** | `detectSettleTrigger()` 检查宿主配置能否**可达**结算：① 直连 `settle-conversation.js`，或 ② 指向 `hook-bridge.js` 且其 `EVENT_PLAN` 含 `settle`。查不到宿主配置时返回 `null`（不知道，不猜，不报警） |
| 6 | **渲染层区分「数据存在」与「触发已配」** | 有记录但触发未配 → 由 🟢 降为 🟡 并给出修复指引；无记录且触发未配 → 🔴 |
| 7 | **`references/automation.md` §5 重写** | 推荐接法改为「经 hook-bridge」（无需改宿主配置），新增 §5.3 backfill 兜底、§5.4 写锁僵死盲区、§5.5 双信号自查；§4 那张误判的现状核对表加了实测更正 |

### 已知盲区（未修，记录在案）

- **写锁僵死约 90 秒**：结算子进程若被宿主 / 沙箱杀掉，`logs/.write.lock` 会残留；结算的等待超时短于陈旧阈值（90s），该次结算失败。90 秒后自动回收，且三事件冗余下总有一次成功 —— 影响可控，未改等待策略。
- **自愈判据**：`session_row.last_activity_at` 与日志 `end_time` 应同步推进；若 `end_time` 长期落后，即为回归。

---

---

## V3.4 —— 项目归属与「事项 ↔ 会话」关联修复（2026-09-22）

**起因**：V3.3 口径下的项目级成本汇总跑出来是空的 ——
8 个会话的 `project` 全是 `null`，62 条工作事项的 `conversation_id` 也全是 `null`，
于是「这个项目花了多少 Token」只能回答「不可获取」。

**结论：不是口径问题，是两条数据链断在写入侧。**

### 症状与根因

| 症状 | 真正的原因 | 修在哪 |
|---|---|---|
| `Conversation.project` 恒为 `null` | `conversation-parser.js` **把该字段写死成 `null`** —— `sessions.project_id` 明明读出来了却没用；而 `space-projects-cache.json` 里的 id→名称映射也从未被会话侧查询 | `conversation-parser.js` + 新增 `lib/project-resolver.js` |
| `Work Activity.conversation_id` 恒为 `null` | 队列（`pending_items`）里**有** `session_id`，但「批量判定回写」建 WorkItem 时**没往下传** → 导出时无据可依，只能写 `null` | `collect-activity.js` + `export-work-activities.js` + 新增 `lib/activity-link.js` |

> 两处都不是「算错了」，而是**证据在管道中途被丢弃**。
> 因此修复的着力点是「让证据一路带到终点」，而不是事后补救。

### 变更清单

| # | 变更 | 说明 |
|---|---|---|
| 1 | **`lib/project-resolver.js`（新）** | 项目归属的**唯一**解析入口。顺序：`config.project_map` → 空间项目在线缓存 → （无 project_id 时才）宿主项目目录 → `null`。热路径只读缓存，不联网 |
| 2 | **会话项目归属落地** | `Conversation` 新增 `project_id` / `project_source` / `project_confidence` 三个溯源字段。`project` 拿不到名称时**保留 `project_id`**，不用目录名顶替（§4.1） |
| 3 | **WorkItem 携带关联证据** | 「批量判定回写」把 `session_id`（及 `project_id`）写到 WorkItem 上；已有事项缺证据时顺带补齐，**不覆盖**已有值 |
| 4 | **Work Activity 携带关联证据** | 新增 `session_id` 字段。它是**证据**不是关联 —— 有了它，关联可以在结算之后被重新解析，而不是永久留 `null` |
| 5 | **导出时按证据挂 `conversation_id`** | 用 `session_id` 去 Conversation Log 里**查**（不是按日期派生 —— 会话归档日未必等于事项发生日，派生会造出不存在的 ID） |
| 6 | **`lib/activity-link.js`（新）** | 回链能力：`buildSessionConversationIndex` / `relinkActivities` / `linkWorkItems`。幂等（内容没变不动时间戳） |
| 7 | **结算即回链** | `settle-conversation.js` 写完三类日志后，自动把「本次会话 → `conversation_id`」补到已有事项与已导出日志上。解决「事项先导出、会话后结算」的时序问题。可用 `--no-relink` 关闭 |
| 8 | **`--relink` 子命令** | 单独跑回链（历史数据修复 / 事后确认覆盖率），不解析会话、不写 Conversation Log。支持 `--session` 限定与 `--dry-run` |
| 9 | **导出报告披露关联覆盖率** | `link_coverage: { with_conversation, no_session_evidence, session_not_settled }` —— 把 `null` **分成两类**：没证据 vs 会话还没结算，并给出对应动作 |
| 10 | **不推断关联（重申）** | 没有 `session_id`、或会话日志里查不到 → `conversation_id` 保持 `null`。**禁止**按时间重叠、项目名相同之类的方式凑合 |

### 已知边界（如实记录，不是缺陷）

```text
· WorkBuddy 自身的时间戳工作区（D:\workBuddy\<时间戳>）在 sessions 表里 project_id 就是 null
  → 这类会话的 project 只能是 null，并且 project_source = 'cwd_unregistered'（说明原因）
· 历史批量导入的事项（source=agent 但从未经过 Hook 队列）没有 session_id 证据
  → conversation_id 只能是 null。这是事实，不做推断补齐
· 人工事项（source=manual）天然没有对话可挂 —— null 是合法常态
```

**判据**：`--relink` 报告里的 `no_evidence` 与 `unresolved` 两个计数，
就是「有多少条真的挂不上」以及「为什么」。

### 新增 / 改动文件

| 文件 | 变更 |
|---|---|
| `scripts/lib/project-resolver.js` | 新增 |
| `scripts/lib/activity-link.js` | 新增 |
| `scripts/test-activity-link.js` | 新增（50 项：解析 / 落盘 / 索引 / 导出 / 回链 / 幂等 / 端到端） |
| `scripts/lib/conversation-parser.js` | `project` 由写死 `null` 改为真实解析；接受 `opts.dir` |
| `scripts/lib/conversation-store.js` | `Conversation` 增 3 个溯源字段；`Work Activity` 增 `session_id` |
| `scripts/lib/log-core.js` | `normalizeItem` 保留 `session_id` / `project_id` |
| `scripts/collect-activity.js` | 回写时带 `session_id` / `project_id`（新建与补齐两条路径） |
| `scripts/export-work-activities.js` | 按证据解析 `conversation_id`；报告输出 `link_coverage` |
| `scripts/settle-conversation.js` | 结算后自动回链；新增 `--relink` / `--no-relink` |
| `scripts/parse-workbuddy.js` | 预演时传入日志目录，使 `project` 可见 |

### 数据兼容

```text
· 旧记录没有 project_id / project_source / session_id → 读取时按 null 处理，不影响任何既有统计
· 重新解析即可回填：settle-conversation.js --backfill --since <起始> --until <结束>
· 已有事项的回链：settle-conversation.js --relink（幂等，可反复执行）
· 无需迁移 logs/ 与 summaries/
```

---

## V3.3 —— 归因维度、AI 成本口径与周期总结（2026-09-22）

**目标**：把「AI 花了多少」从一笔糊涂账变成**可归因、可解释、不估算**的账；
同时把总结从「只有日报」扩到日报 / 周报 / 月报 / 项目报告。

**这是一次增量优化，不是重写** —— 既有能力、既有数据、既有 CLI 全部保留。

### 概念对齐

| 概念 | 明确后的定义 |
|---|---|
| **Conversation** | 一次**有连续上下文的 AI 会话**（一个 `session_id`），不是「一问一答」的 Message |
| **Message / 请求** | 会话内的一次往返；只作明细量（`request_count`），**不是统计维度** |
| **Work Activity** | 会话或人工操作**产出的工作事项**，0~N 条 |

### 变更清单

| # | 变更 | 说明 |
|---|---|---|
| 1 | **三个归因维度** | 新增 `project` / `work_type` / `project_stage` 三个可写入字段（**均不强制**）。留空归「（未标注）」，不参与 Token/积分分摊 |
| 2 | **六分类 `category`** | `工作` / `生活` / `个人成长` / `健康运动` / `休闲娱乐` / `其他`；**非工作分类强制清空 `project_stage` 与 `output`**（杜绝「普拉提｜需求阶段」） |
| 3 | **新增 `output`（成果）** | 只有确实产出才写；没有就 `null`，**绝不虚构** |
| 4 | **Skill 维度成本指标补全** | 调用次数 / 累计 Token / 平均单次 / 最大 / 最小 / 最近一次 / 涉及对话数 / 占比 + **同 Skill 多版本平均 Token 对比** |
| 5 | **Skill 级积分一律 `null`** | 宿主只提供会话级 credit → `total_score: null` + `score_source: 'unavailable'` + `unavailable_reason`。**禁止按 Skill 数或 Token 占比摊派** |
| 6 | **Token 三口径写清** | A（Skill 载入体积，可跨 Skill 相加）/ B（请求用量，禁止相加）/ C（会话总量）；**A 与 C 不得相加** |
| 7 | **归因铁律落地** | 只用记录中**已存在**的 `conversation_id`；同一维度多值引用 → 计入 `ambiguous`，**不计入任何一方**；每会话每维度最多计一次 |
| 8 | **项目 × 阶段歧义修正** | 原实现漏判歧义 → 同一会话被两个项目各计一次，合计虚高。改为按 `(项目, 阶段)` 格子判唯一归属 |
| 9 | **归因覆盖率诊断** | 输出「N 条事项中 M 条带 conversation_id」，把「不可获取」的原因讲清楚，而不是让人以为是 bug |
| 10 | **产品经理工作视角** | 工作类型按「需求 / 产品设计 / 项目推进 / 研发协作 / 项目管理 / 数据分析 / 其他」分组；**只覆盖 `category = 工作`**，生活/运动永不进入 |
| 11 | **日总结改七段结构** | 今日概览 / 产品工作 / 今日成果 / 项目进展 / 生活与个人事项 / 时间结构 / AI 使用情况。原十一章式明细草稿保留在 `draft --verbose` |
| 12 | **新增周 / 月 / 项目总结** | `daily-summary.js week｜month｜project`；数据源为已归档的 `logs/<date>/*.jsonl` |
| 13 | **枚举 fail-fast** | `--category` / `--project-stage` 写了非法值直接报错并列出合法取值；`auto` 取本地建议，命中不到留 `null`（不猜） |
| 14 | **定位器保护（安全修复）** | `saveLocator()` 拒绝把**真实**全局定位器指向临时目录，也拒绝被 `WORK_TIME_TRACKING_DIR` 这类临时覆盖改写。此前一次沙箱 `init` 就会把用户日志目录永久指到 `%TEMP%`（真实事故，已回滚） |

### 数据兼容

```text
· 旧记录没有 category / project_stage / output → 读取时按关键词推导分类，字段保持 null
· config 里旧的顶层 work_types（V3.1/V3.2 写法）仍生效，与 work.work_types 合并去重
· 旧 work_type 取值（UI设计 / 学习研究 / 运动健身 …）全部保留为合法值
· logs/ 与 summaries/ 无需迁移
```

### 新增文件

| 文件 | 内容 |
|---|---|
| `references/cost-statistics.md` | **AI 成本口径**：三个 Token 口径、四个归因维度、占比、歧义、什么必须记 `null` |

### 未改动

结算链路（`settle-conversation.js` / `parse-workbuddy.js`）、幂等机制、脱敏与出网守卫、
TickTick 同步契约、存储分层（`logs/` 与 `summaries/` 仍永久保留）。

---

## V3.2.1 —— Hook 超时修复与跨日自动 rollover（2026-09-22）

**背景**：每天第一条消息时宿主报
`UserPromptSubmit operation blocked by hook ... Hook timed out after 10000ms`。
排查确认两个叠加根因：

1. **Hook 链路串行阻塞**：`hook-bridge.js` 用 `spawnSync` 同步等待子进程（最长 7s）。
   每天第一条消息时 SessionStart 与 UserPromptSubmit 几乎同时触发，
   两个 node 进程串行冷启动 + 写锁排队，叠加后撞上宿主 10s 预算被杀。
2. **跨日 rollover 死锁（归档/覆盖逻辑缺陷）**：跨日闸门要求「人工决策」，
   但 Hook 输出被 `>/dev/null` 丢弃，`needs_rollover` 的提问永远没人回答，
   `init-log.js rollover` 从未被触发 → **跨日后所有活动被闸门静默丢弃、全天不记录**
   （实证：current.json 长期停留在旧日期 2026-09-21）。

| # | 变更 | 从 → 到 |
|---|---|---|
| 1 | **Hook 改为 fire-and-forget** | `spawnSync`（阻塞最长 7s）→ `spawn(detached) + unref`（几十毫秒返回）；子进程独立完成写入，写失败仍进 spool 待重放。最坏情形（宿主杀死进程树）也不劣于旧行为（子进程同样会被 7s 超时杀死） |
| 2 | **Hook 路径跨日自动 rollover** | `needs_rollover` 人工决策（Hook 场景无人应答）→ `collect-activity.js ingest --rollover keep`：旧日志转 `pending/<date>.json`（未同步时）或按「已同步→丢弃」分支处理，工作事项先永久导出 `logs/<date>/work-activities.jsonl`，然后新建当日日志并继续采集。**手动 CLI 不传 `--rollover`，行为不变（仍人工决策，§49）** |
| 3 | **keep 的非破坏性说明** | `keep` 是 §39 允许的显式出路之一（`--decision keep`）；它不删除任何数据，只是把「是否同步」的决策推迟到 pending/ 中等待后续处理 |

**未改动**：`log-core.js`、`init-log.js`、结算/总结/同步链路、数据契约。

---

## V3.2 —— 架构优化与轻量化重构（2026-09-21）

**目标**：`Skill 负责理解与决策，Script 负责计算与执行`。
降低每次调用本技能时的上下文与 Token 消耗，同时**完整保留既有能力**。

| # | 变更 | 从 → 到 |
|---|---|---|
| 1 | **`SKILL.md` 大幅瘦身** | 89.5 KB / 1,699 行 → 约 200 行；只保留 AI 执行真正需要的核心规则 |
| 2 | **详细规范下沉 references** | 数据结构 → `data-schema.md`；结算 → `settlement.md`；日报 → `daily-summary.md`；项目判定 → `project-inference.md`；配置 → `config-reference.md`；自动化 → `automation.md` |
| 3 | **消除双写重复** | `SKILL.md` 与 `data-model.md §13-§14` 曾各自定义三类日志字段 → 收敛为 `data-schema.md` 单一定义 |
| 4 | **references 更名对齐语义** | `conversation-settlement.md` → `settlement.md`；`host-automation-setup.md` → `automation.md` |
| 5 | **配置文档独立** | 配置项散落在 `SKILL.md` 说明文字 → `config-reference.md` 统一定义（**仍为 JSON，未引入 YAML**，理由见该文 §1） |
| 6 | **任务路由显性化** | 新增「什么交给脚本 / 什么留给 AI」路由表，避免 AI 重复做脚本能确定性完成的计算 |
| 7 | **变更史外置** | 本文件 |

**未改动**：全部 `scripts/`（零回归）、`templates/config.json`、
`TickTick` 同步能力、工作事项记录能力、Conversation 记录能力、Skill 使用记录能力。

> **量化动机**：瘦身前，`SKILL.md` 单次载入约 3 万字符（≈ 8,600 Token）。
> 2026-09-21 的日报显示 `work-time-tracking` 当日被调用 2 次、载入合计 17,256 Token
> （61,627 字符），是当日载入量最大的 Skill。瘦身直接降低这项固定成本。

---

## V3.1 —— 日志持久化、存储生命周期与 GitHub 归档（2026-09-21）

V3.0（同日早些时候）已确立「对话结束即结算 + 三类结构化日志」的主干；
V3.1 在此基础上补齐**日志持久化、存储生命周期与 GitHub 归档**，
并把字段口径统一到最终确认的命名。

| # | 变更 | 从 → 到 |
|---|---|---|
| 1 | **目录布局按日期组织** | `structured/<kind>/<date>.jsonl` → `logs/<date>/<kind>.jsonl`，与 GitHub 远端 1:1 对齐（旧布局仍可读取） |
| 2 | **取不到的值统一 `null`** | 字符串哨兵 `'unavailable'` → `null` + 配套 `*_source` 标签说明原因（读旧数据仍兼容哨兵） |
| 3 | **字段口径统一** | `usage_score` → `total_score`；`skill_token_source` → `token_source`；`duration_minutes` → `duration_seconds`；Work Activity 的 `project` → `project_name` |
| 4 | **`status` 与 `settlement_status` 分离** | 单个 `status` → `status`（对话在宿主侧的结果）+ `settlement_status`（本次结算结果）+ `settled_at` |
| 5 | **三层存储生命周期** | 无 → Raw 默认留 7 天自动清理；**Structured Logs 永久保留**；Summaries 永久保留 |
| 6 | **GitHub 日志持久化** | 无 → 新增 `sync-github.js`：按天归档到 private 仓库，Local 是 Source of Truth，**默认关闭** |
| 7 | **自动化拆成三个任务** | 任务A/B 两个 → 任务1 对话结算 / 任务2 GitHub 同步 / 任务3 每日复盘 + TickTick |
| 8 | **脚本职责对齐** | 新增 `parse-workbuddy.js`（解析体检）、`aggregate-logs.js`（统计入口）、`cleanup-raw-logs.js`（Raw 清理） |
| 9 | **新增离线行为测试** | 无 → `test-github-sync.js`：用本地裸仓库当远端，无网络验证上传/幂等/覆盖方向/敏感拦截 |
| 10 | **工作事项永久导出** | 「已同步即直接覆盖」会让当天 WorkItem 跨日消失 → 新增 `export-work-activities.js`，跨日前导出到 `logs/<date>/work-activities.jsonl`；同时**废弃 `archive/`** |

**新增文件（V3.1）**

```text
scripts/sync-github.js               GitHub 日志归档（本技能唯一允许执行 git 的地方）
scripts/aggregate-logs.js            Structured Logs 统计入口（只读，零 AI 调用）
scripts/parse-workbuddy.js           WorkBuddy 数据源解析与体检（只读）
scripts/cleanup-raw-logs.js          Raw 快照保留期清理（默认 dry-run）
scripts/export-work-activities.js    把已归类 WorkItem 导出为永久 Work Activity 日志
scripts/test-github-sync.js          离线行为测试（本地裸仓库当远端）
references/github-sync.md            GitHub 归档的完整规范
```

---

## V3.0 —— 对话结束结算与三类结构化日志（2026-09-21）

本次为**增量更新**：已有的记录能力、数据结构、工作事项规则、每日复盘、TickTick 同步
**全部保留**，只调整「对话数据的记录与结算机制」。

| # | 变更 | 从 → 到 |
|---|---|---|
| 1 | **数据模型拆分为三个独立日志** | 对话元数据混在 WorkItem 里 → `Conversation Log` / `Skill Usage Log` / `Work Activity Log` 三者职责分离、各有业务键 |
| 2 | **对话结束立即结算** | 等到每日复盘时集中处理 → 对话一结束就由脚本结算并落盘（任务1） |
| 3 | **脚本优先** | 曾考虑让 LLM 在复盘时分析对话 → **全部确定性字段改由脚本解析**，零 token、可复现 |
| 4 | **每日复盘改为只读** | 重扫历史对话、重算 Token/Score → 只 `sum / group / join` 结构化日志 |
| 5 | **新增幂等与防重复** | 无 → 确定性业务键 + 按键替换（绝对值覆盖，非累加） |
| 6 | **新增异常处理** | 无 → `settled` / `partial` / `failed` 三态，部分失败不丢记录，原始快照支持重新解析 |
| 7 | **明确 Skill Token 口径** | 无 → 只承认 A 口径（载入体积）与 `null`；**明令禁止**摊派估算 |
| 8 | **区分 Token 与 Score** | 无 → `total_score` 独立字段，**禁止**建立换算关系 |
| 9 | **自动化拆分** | 单个「每日总结」 → 实时结算与每日分析不得合并 |
| 10 | **新增目录** | 无 → `structured/`（V3.1 起为 `logs/`）、`raw/`、`summaries/`（**不改动** `current.json` 既有结构） |

**新增文件（V3.0）**

```text
scripts/lib/conversation-store.js       三类结构化日志的存储层（幂等 upsert）
scripts/lib/conversation-parser.js      WorkBuddy 本地数据的确定性解析器
scripts/lib/metrics-engine.js           每日复盘/周期分析的只读汇总层
scripts/settle-conversation.js          任务1：对话结束结算 CLI
scripts/test-conversation-settlement.js 回归测试
scripts/test-egress-guard.js            出网守卫（git 只允许出现在 sync-github.js）
```
