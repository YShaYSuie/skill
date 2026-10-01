# 滴答清单 MCP 能力与调用契约

本文件是 `ticktick-work-review` 技能的执行层参考。Skill 负责决策逻辑，MCP 负责数据与执行：

```text
Skill（理解 / 判断 / 规划） → TickTick MCP（查询 / 创建 / 完成 / 更新）
```

## 工具调用契约

以下参数名以实际 MCP 工具 schema 为准，调用前应以工具返回的 schema 校验。

### 读取类

| 工具 | 用途 | 关键参数 | 要点 |
|---|---|---|---|
| `list_undone_tasks_by_time_query` | 按预设时间窗查询未完成任务 | `query_command`: `today` \| `last24hour` \| `last7day` \| `tomorrow` \| `next24hour` \| `next7day` | 日复盘与今日计划的首选入口，成本最低 |
| `list_undone_tasks_by_date` | 按日期区间查询未完成任务 | `search.startDate`, `search.endDate`, `search.projectIds` | **单次区间上限 14 天**，超长周期必须分段查询后合并 |
| `list_completed_tasks_by_date` | 按日期区间查询已完成任务 | `search.startDate`, `search.endDate`, `search.projectIds` | 对应「今日已完成任务」「本周完成任务」，是复盘的完成数据来源 |
| `filter_tasks` | 多条件过滤 | **所有条件须包裹在 `filter` 对象内**：`{"filter": {"projectIds": [...], "status": [0], "startDate": ..., "endDate": ..., "priority": [...], "tag": [...], "kind": [...]}}` | 用于「已安排时间的任务」「高优先级任务」筛选。**直接传平铺参数会校验失败**（`must have required property 'filter'`）——与 `list_undone_tasks_by_date` 用 `search` 包裹的模式一致 |
| `list_projects` | 列出所有清单 / 项目 | `offset`, `limit` | 不加分页参数时返回结果包含虚拟的 `inbox`（收集箱）。整理收集箱前必调 |
| `get_project_with_undone_tasks` | 取某项目下全部未完成任务 | `project_id` | 整理任务时按清单逐项拉取 |
| `get_task_by_id` | 按 taskId 取完整详情 | `task_id` | 用于补录前的重复判断与范围覆盖判断 |
| `get_task_in_project` | 按 projectId + taskId 取任务 | `project_id`, `task_id` | 与上者等价，视上下文选用 |
| `search_task` / `search` | 关键词搜索任务 | `query` | 返回 taskId、title、url。**补录前查重的强制步骤** |
| `list_tags` | 列出标签 | — | 辅助工作类型归类 |

### 写入类

| 工具 | 用途 | 关键参数 | 要点 |
|---|---|---|---|
| `create_task` | 创建任务 | `task.title`, `task.projectId`, `task.content`, `task.dueDate`, `task.priority`, `task.status`, `task.kind` 等 | 补录新工作用。`status`: 0 active / -1 abandoned / 2 completed |
| `complete_task` | 标记任务完成 | `project_id`, `task_id` | **必须同时提供 project_id 与 task_id**，缺一不可 |
| `update_task` | 更新任务 | `task_id`, `task.*` | 仅限用户明确授权的场景 |
| `update_task`（勾选子项） | 更新清单型任务的子项 | `task.items` 传**完整数组**，每项含 `id`/`title`/`status`（1=已完成）/`sortOrder` | 只改目标项的 `status`，其余项原样回传。**传 items 会重新生成全部子项 id**，见下方「常见失败」 |
| `create_project` | 创建新清单 | `name`, `color`, `view_mode`, `kind` | 仅在用户明确要求新建项目时使用 |

## 任务字段语义要点

- `priority`：`0` 无 / `1` 低 / `3` 中 / `5` 高。**无优先级不要臆测为高。**
- `status`：`0` 进行中 / `-1` 已放弃 / `2` 已完成。
- `isAllDay`：是否全天任务。判断「是否安排了具体时间」时看此字段与 `startDate` 组合。
- `kind`：`TEXT`（用 `content` 存正文）/ `NOTE` / `CHECKLIST`（用 `desc` + `items`）。
- `repeatFlag`：`RRULE:` 或 `ERULE:` 前缀，二者不可混用。
- `dueDate` vs `startDate`：`dueDate` 是**截止时间**，`startDate` 是**开始时间**。判断逾期以 `dueDate` 为准。
- **`end_time` 必须按来源判断**：
  - AI 对话推导事项的 `end_time` 是会话收尾，不是实际结束 → 不写 `dueDate`。
  - 手动录入且明确给出的 `end_time` 是事实 → 可写 `dueDate`。

## 时间段写入规范（强制）

> **职责分界**：本规范属于**同步逻辑**（把数据落到 TickTick 字段），归本技能。
> 事项时间本身「怎么采集、怎么算出 `start_time`/`end_time`、合并后为什么可能没有结束时间」，
> 属于**事项的生成与提取**，归 `work-time-tracking`（见其 `references/ticktick-sync-contract.md` §4/§5）。
> 本技能不重复定义提取规则，只负责**把交接来的时间落到字段**。

### 时间字段默认映射

WorkTimeLog 保留完整时间段；TickTick 默认只承载开始时间：

| 本地来源 | TickTick 字段 | 写法 |
|---|---|---|
| `start_time` | `startDate` | `<date>T<HH:MM>:00+0800` |
| AI 推导的 `end_time` | 不映射到 `dueDate` | 不宣称为实际结束；只保留在本地日志，**不写 `dueDate`，也不写备注** |
| 手动明确 `end_time` | `dueDate` | 写入明确结束时间，完整区间同时留 `content` |
| 独立真实截止时间 | `dueDate` | 如与手动结束时间冲突，需用户确认 |
| — | `isAllDay` | **有具体开始时间时必须为 `false`** |
| — | `timeZone` | `Asia/Shanghai` |

```jsonc
// AI 推导：只落开始时间；dueDate 为空
{
  "startDate": "2026-09-20T11:30:00+0800",
  "isAllDay": false,
  "timeZone": "Asia/Shanghai",
  "content": "开始时间：11:30\n来源：WorkTimeLog WI-xxx（AI 推导）"
}

// 手动录入：开始和明确结束都落位
{
  "startDate": "2026-09-20T12:15:00+0800",
  "dueDate": "2026-09-20T13:00:00+0800",
  "isAllDay": false,
  "timeZone": "Asia/Shanghai",
  "content": "实际时间：12:15-13:00\n来源：WorkTimeLog WI-xxx（手动录入）"
}
```

分支规则：

```text
AI 推导 start+end  → 只写 startDate；dueDate 留空；end_time 不视为真实结束
手动录入 start+end → startDate + dueDate 都写；完整区间写 content
仅 start           → 只写 startDate，dueDate 留空
独立真实截止时间   → dueDate 写真实截止；与手动结束冲突时先确认
无时间          → 保持全天态（isAllDay: true），不得凭空造时刻
```

### `content`（备注）模板（强制）

`content` 是**给人读的备注**，不是日志转储、也不是同步过程的自证材料。
它只承载两类信息：

```text
① 字段装不下、且可信的时间信息
② 溯源锚点「来源：WorkTimeLog <WorkItem id>」
```

四种来源各有**唯一模板**，逐字照写，不加行、不改措辞、不加标签：

| 来源 | 模板 | 说明 |
|---|---|---|
| AI 推导 | `开始时间：HH:MM` ↵ `来源：WorkTimeLog <id>（AI 推导）` | 只写开始时间，**不写区间** |
| 手动明确 | `实际时间：HH:MM-HH:MM` ↵ `来源：WorkTimeLog <id>（手动录入）` | 区间是事实，与 `dueDate` 一致 |
| **手动录入但结束未记录** | `开始时间：HH:MM` ↵ `来源：WorkTimeLog <id>（手动录入）` | **V1.2 补**：开始是用户给出的事实，结束未知 → 与 AI 推导同形但来源标签如实写「手动录入」，**不写区间、不加免责说明** |
| 无时间依据 | `来源：WorkTimeLog <id>（时间未记录）` | 不造时刻 |

> 第 3 种（`--source manual_open`）是 V1.2 补上的缺口：此前「手动录入 + 仅开始时间」无模板可依 ——
> 按 `manual` 会因缺区间行必然违规，按 `none` 又会谎称「时间未记录」（明明有开始时刻）。

```jsonc
// AI 推导：有开始时刻，但没有真实结束时刻
"content": "开始时间：11:30\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）"

// 手动录入：开始与结束都是用户给出的事实
"content": "实际时间：12:15-13:00\n来源：WorkTimeLog WI-20260928-B1C2D3E4（手动录入）"

// 手动录入但结束未记录：只有开始时刻是事实（V1.2）
"content": "开始时间：10:00\n来源：WorkTimeLog WI-20260928-D1E2F3A4（手动录入）"

// 无时间依据
"content": "来源：WorkTimeLog WI-20260928-C9D8E7F6（时间未记录）"
```

**禁写清单（以下内容一律不得出现在 `content` 中）：**

| 禁写 | 反例 | 原因 |
|---|---|---|
| AI 推导事项的时间区间 | `11:30-11:42` | 区间里的结束时间是会话收尾，不是真实结束；写出来就是误导 |
| 免责声明 / 自我解释 | `结束时间为会话收尾，非真实结束` | 需要靠一句免责声明才能成立的数据，本就不该展示；解释成本高于信息价值 |
| 内部术语 | `本地区间`、`本地时间线`、`本地日志` | 「本地 vs 滴答」是实现视角，读备注的人无从理解 |
| TickTick 字段名 | `startDate`、`dueDate`、`isAllDay` | 字段映射是实现细节，人读的备注里不需要 |
| 箭头 / 映射记号 | `11:30 → startDate` | 同属实现记号 |
| 实现过程说明 | `由会话活动推导`、`本次未采集到结束活动` | 属于日志与同步回报，不属于备注 |

> 判断标尺：**「这条信息，读者需要吗？可信吗？」** 两者缺一 → 不写进 `content`。

> 实测教训（2026-09-28）：此前 `content` 模板只给了示例、没有禁写清单，
> 结果同步时模型自行「补全信息」，写出了模板中不存在的
> `本地区间：11:30-11:42；结束时间为会话收尾，非真实结束` 一行 —— 既不可信、也无人需要。
> **模板欠定义时，模型一定会即兴发挥**，因此本节必须同时给出「允许什么」和「禁止什么」。

### `content` 校验（写入前与回读后各做一次）

`content` 是同步流程中最容易被即兴发挥的字段，必须显式校验。

**方式一：跑脚本（首选）**

```bash
node scripts/validate-content.js --source ai \
     --content "开始时间：11:30\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）" \
     --workitem-id WI-20260928-A8F2C1D3
```

- `--source` 取 `ai` / `manual` / `none`，对应上表三种模板；
- 退出码 `0` = 通过；`1` = 有违规（输出违规清单与命中的原文）；`2` = 参数错误；
- 加 `--json` 取结构化结果；`--selftest` 自查脚本本身（11 个内置用例）。
- 脚本内检查项与本节规则**同源**：改模板必须同步改 `scripts/validate-content.js`。

**方式二：逐条核对（脚本不可用时）**

| # | 检查项 | 判定 |
|---|---|---|
| 1 | 含且仅含一行 `来源：WorkTimeLog <本地 WorkItem id>`，id 与本地一致 | 缺失或不一致 → 不通过（这是按 id 定位任务的唯一锚点） |
| 2 | 行数与模板一致（AI/手动 2 行，无时间 1 行），无多余行 | 多行 → 不通过 |
| 3 | 未命中禁写清单任一项 | 命中 → 不通过 |
| 4 | `ai` 来源不含时间区间；`manual` 来源区间与 `dueDate` 一致；`none` 来源不含任何时刻 | 不一致 → 不通过 |

**违规处置：**

1. **写入前**发现 → 按模板重写后再落库，**不要**把违规文本写进 TickTick；
2. **回读后**发现 TickTick 里的 `content` 不符模板 → 用 `update_task` 重写 `content`
   （只改 `content`，不碰 `status` 与时间字段），重写后再次回读核对；
3. 若因接口或权限原因无法重写 → 在「本次 TickTick 同步」中如实列出「备注待修正」及原因，
   **不得宣称同步完全成功**。

> **已完成任务可安全补写时间**：实测（2026-09-21）对 `status: 2` 的任务写入时间字段后，
> `status` 与 `completedTime` **均不受影响**。补写后仍需回读核对；
> AI 推导事项的 `dueDate` 必须为空，手动明确时间段则应与结束时间一致。

同理，上面的「补录标准动作序列」中 `create_task` 示例的 `isAllDay: true` 只适用于**没有具体时间**的补录；
若交接数据给出了开始时间，必须写 `startDate`；AI 推导的 `end_time` 不得写 `dueDate`，
手动录入的明确 `end_time` 写入 `dueDate`。

## 补录标准动作序列

```text
1. search_task(<工作关键词>)          → 查重
2. 判断是否与已有任务重复              → 参见 decision-rules.md
3. 按「content（备注）模板」构造 content，并用 validate-content.js 校验（退出码须为 0）
4. 若无重复：
   create_task({
     task: {
       title: "<工作事件描述>",
       projectId: "<目标清单>",
       dueDate: "<当日 ISO 8601>",
       startDate: "<当日 ISO 8601>",
       isAllDay: true,
       timeZone: "Asia/Shanghai",
       kind: "TEXT",
       content: "<按 content 模板逐字构造>"
     }
   })
5. complete_task({ project_id, task_id })   ← 必须，create 时传 status 无效
6. 回读验证：时间字段（startDate/isAllDay/timeZone/dueDate）+ content 模板
```

**已验证行为（2026-09-16 实测）：`create_task` 传入 `status: 2` 不会生效**，返回结果仍为 `status: 0`。因此统一采用「创建 → `complete_task`」两步法，不要依赖单次传 `status: 2`。无论走哪条路径，创建后必须回读验证。

## 补录任务的时间留痕约定

`complete_task` **无法回填历史完成时间**——系统会把 `completedTime` 记为执行操作的那一刻，而非用户口述的实际完成时刻。

处理方式：

- AI 对话推导：只写 `startDate` / `isAllDay: false`，不把会话结束写入 `dueDate`。
- 手动明确录入：写入 `startDate` + `dueDate`，并把完整区间写入 `content`。
- 在给用户的回报中，同时说明：`completedTime` 会显示为操作当时的系统时间；
  AI 推导事项没有真实结束时间，手动事项以明确录入的结束时间为准。
- 若用户只给日期未给时刻，无需写入具体时刻，保持全天态。

目的：让工作账本的时间记录保留用户提供的真实事实，而非被系统时间戳覆盖。

## taskId 回写约定（幂等与防错的关键）

同步产生或更新 TickTick 任务后，**必须把 `taskId` 回写到本地 WorkItem**。这条约定用于消除「靠标题搜索匹配」的失手风险。

### 为什么必须回写

本地日志（`LOG_ROOT\` 下的 `current.json` / `archive/*.json`）此前**不保存 `taskId`**，导致：

- 每次同步或补写时间都要靠 `search_task` 标题匹配；
- 标题一旦不一致（如本地 `考核模块状态机设计` ↔ 滴答 `【粤企知】考核模块状态机设计`），匹配就会失手，存在**改错任务**的风险。

### 回写方式（本地侧已实现该字段）

本地 WorkItem 已有 `ticktick` 字段（2026-09-21 起，见 `work-time-tracking/references/data-model.md` §7.1）：

```jsonc
"ticktick": {
  "taskId": "6aaf6b5ee4b066c22040c33d",
  "projectId": "5a4329c34686f1f8e0f0f802",
  "syncedAt": "2026-09-21T11:57:44+08:00"
}
```

1. 任务创建 / 更新 / 完成后，取返回体或 `search_task` 结果中的 `id`（即 `taskId`）；
2. **在「本次 TickTick 同步」清单中输出「事项 ↔ taskId」对照**（见 `SKILL.md` §6 与 `output-templates.md`）；
3. 由 `work-time-tracking` 侧执行落库：

```bash
node scripts/update-work-item.js link --id <WorkItem id> \
     --task-id <ticktick taskId> [--project-id <清单 id>] [--synced-at <ISO 8601>]
```

4. 后续同步**优先按 `ticktick.taskId` 定位**（`get_task_by_id`），仅在无 `taskId` 时才退回标题搜索。

### 分界

- `work-time-tracking` **不操作 TickTick API**，只保存 `taskId`。
- `ticktick-work-review` 负责**产生与返回 `taskId`**，并在每次同步的清单中列出「事项 ↔ taskId」对照表。
- **本技能不直接改写对方的日志文件** —— 落库由对方命令完成，本技能保证「给出正确的 taskId」。

## 标题匹配的兜底核对（无 taskId 时）

按标题搜索命中后，**不得直接更新**，必须先核对来源标记：

1. `get_task_by_id` 回读候选任务的 `content`；
2. 确认其中含形如 `来源：WorkTimeLog WI-20260920-F3B37DA5` 的标记，且与本地 WorkItem 的 `id` 一致；
3. 一致才执行更新；不一致则继续搜索或列为「待确认」，**宁可不动，不可改错**。

> 工作账本补录必须在 `content` 中保留 `来源：WorkTimeLog <WorkItem id>` 标记 ——
> 这既是溯源证据，也是无 `taskId` 时唯一的匹配锚点。

## 参数包裹约定（重要）

多个查询类工具要求条件包裹在单一对象内，平铺传参会直接校验失败：

| 工具 | 包裹键 |
|---|---|
| `list_undone_tasks_by_date` | `search` |
| `list_completed_tasks_by_date` | `search` |
| `filter_tasks` | `filter` |

示例：

```json
// 正确
{"filter": {"projectIds": ["69eec009ebdf1b00000000ae"], "status": [0]}}
// 错误 —— 校验失败：must have required property 'filter'
{"projectIds": ["69eec009ebdf1b00000000ae"], "status": [0]}
```

## ISO 8601 时间格式

统一使用带时区的格式：`2026-09-16T00:00:00.000+0800`。

计算日期区间时，**不要手工推算时间戳**，使用 shell 获取当前日期：

```bash
date +%Y-%m-%d          # 今天
date -d "-6 days" +%Y-%m-%d   # 本周一（视周起始约定调整）
date +%Y-%m          # 本月
```

## 常见失败与处理

| 现象 | 处理 |
|---|---|
| 区间超过 14 天返回错误 | 拆分为多个 ≤14 天区间，分别查询后按 taskId 去重合并 |
| `complete_task` 报错 | 检查是否遗漏 `project_id`；用 `get_task_by_id` 确认 taskId 有效 |
| `search_task` 无结果 | 换同义词或更短关键词再搜一次，仍无结果才判定为「无重复」 |
| 分页导致清单不全 | `list_projects` 循环 offset 直到返回空 |
| 查询工具报「must have required property」 | 条件未包裹，按上方「参数包裹约定」改用 `search` / `filter` 键 |
| `create_task` 传 `status: 2` 未生效 | 预期行为，改用「创建 → `complete_task`」两步法 |
| `create_task` 未传 `dueDate` 却出现 `dueDate` | **实测（2026-09-28 补录）**：只传 `startDate` + `isAllDay: false` 时，返回体与回读均显示 `dueDate == startDate`（TickTick 自动镜像）。因此「AI 推导事项 `dueDate` 留空」在**落库层面往往做不到**，交接侧不要据此判定同步失败 |
| 更新 `items` 后子项 id 全部变更 | **预期行为**：`update_task` 传入 `items` 会重新生成所有子项 id（实测旧 id `6aaa402a...` → 新 id `6aaa5488...`）。因此**不要缓存子项 id**，每次修改前先 `get_task_in_project` 取最新 items 再整体回传 |
| `list_completed_tasks_by_date` 返回空但任务确已完成 | 该接口对本轮经 MCP 完成的任务可能存在索引延迟。改用 `list_undone_tasks_by_time_query` / `filter_tasks` 反向确认任务已移出待办，即可判定同步成功；勿据此判定「未完成」 |
| 刚创建的任务 `search_task` 搜不到 | 索引延迟**不止影响已完成任务，新建任务同样搜不到**（实测 2026-09-28：刚创建 4 条 `content` 含 `WI-20260924-xxxx` 的任务后，按 `WI-20260924` 搜索返回空）。查重与核对新建任务请用 `get_project_with_undone_tasks` / `get_task_in_project`，**不得因搜索为空就重复创建** |
| `list_undone_tasks_by_date` 遗漏区间内的未完成任务 | **实测发现（2026-09-18）**：查询 9/17 区间时，同日期格式的多条任务中，「【SCUT】【物联】调研计划细节修改」（dueDate 9/17、status 0）未出现在结果中，而其他同格式任务正常返回。**结论：该接口不可作为区间内任务的完整枚举依据**。复盘时对已知任务须用 `get_task_in_project` 逐个核对状态，不可仅凭区间查询结果判定任务不存在或已完成 |
| 开始时间写了但记录不到 | 开始时间只写进了 `content`，未落到 `startDate`。按「时间字段默认映射」重写 |
| AI 推导事项的 `dueDate` 被写成会话结束时间 | 这是语义错误。**但实测（2026-09-28）本 MCP 的 `update_task` 无法清空 `dueDate`** —— 传 `1970-01-01T00:00:00.000+0000`（工具说明所载的清除值）与传 `null` **均为 no-op**（`etag` / `modifiedTime` 不变），而同一接口改 `content` 可正常生效。可行做法：① 落库时不要宣称「`dueDate` 已留空」；② 若 `dueDate` 已被系统镜像为 `startDate`（见上一行），该值即开始时刻、并非会话结束时间，语义上不属于本条禁止的写法；③ 真正的会话结束时间**只保留在本地日志**（`start_time` / `end_time` / `time_segments`），既不写 TickTick 字段，也不写备注 |
| 备注不符模板（出现模板外的行 / 内部术语 / 字段名 / 免责声明） | 用 `scripts/validate-content.js` 复现违规清单，再 `update_task` **只改 `content`**（不碰 `status` 与时间字段），重写后回读核对；无法重写则在同步清单里列「备注待修正」 |
| 手动明确结束时间未落 `dueDate` | 补写 `dueDate`，并在 `content` 保留完整区间 |
| 任务显示为全天条 | 有具体开始时间但 `isAllDay` 仍为 `true`，须显式传 `false` |
| 更新已有任务时误改了别的任务 | 标题搜索命中 ≠ 就是目标任务。先回读 `content` 中的 `来源：WorkTimeLog WI-xxx` 与本地 id 核对；有 `ticktick.taskId` 时优先按 id 定位 |
| 完成的任务改完时间后担心状态被改 | 实测无影响：`status` 与 `completedTime` 不变。仍须回读按来源核对时间字段 |
| MCP 整体不可用 | 停止一切写操作，按 SKILL.md §6 输出「待同步内容」清单 |

## 回读验证的替代路径

当 `list_completed_tasks_by_date` 不可靠时，用以下任一方式确认写操作生效：

1. `list_undone_tasks_by_time_query`（`today` / `next7day`）——确认任务已**移出**待办列表
2. `filter_tasks`（按 projectIds + status）——确认目标状态
3. `get_task_in_project`（project_id + task_id）——确认单任务的 `status` 与 `completedTime` 字段

写操作返回体本身也含 `status`、`completedTime`、`etag`、`modifiedTime`，可直接作为第一手证据。

**时间字段的核对必须显式做**：回读后确认 `startDate` / `isAllDay` / `timeZone`；
AI 推导事项确认 `dueDate` 为空，手动事项确认 `dueDate` 与明确结束时间一致。
只看「任务存在」「status 正确」不算验证通过 —— 时间没落位是静默失败，不报错但日历上看不到。
