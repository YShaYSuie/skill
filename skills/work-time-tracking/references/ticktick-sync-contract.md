# 每日总结与 TickTick 同步契约

## 1. 三个层级（§47/§48/§49）

```text
WorkItem              = 同步单位
DailyLog              = 触发检查单位
手动/宿主定时任务      = 触发单位
```

```text
DailyLog
 ├── WorkItem A → TickTick Task
 ├── WorkItem B → TickTick Task
 └── WorkItem C → TickTick Task
```

**但不会在 WorkItem A 创建时立即同步。**

---

## 2. 禁止实时同步（§30）

以下行为禁止：

```text
创建 WorkItem → 立即创建 TickTick Task
修改 WorkItem → 立即修改 TickTick Task
```

必须先保存本地 `WorkTimeLog`，然后等待：

```text
手动同步        或        宿主定时同步
```

即使 `auto_tracking = true`，也**不意味着** `auto_ticktick_sync = true`（§21）。

---

## 3. 两种触发方式（§29）

### 用户手动

```text
/sync → 准备今日 WorkItem → ticktick-work-review → TickTick/Dida365
```

### 宿主定时任务

```text
宿主每天 18:40 触发 /sync
        ↓
Work-Time-Tracking 准备 DailyLog
        ↓
调用 ticktick-work-review
        ↓
同步 TickTick
```

> 自动同步来自**宿主工具的自动任务配置**，不是 Skill 自己主动推送（§22）。
> Skill 不创建定时器（§2.2/§61）。

---

## 4. 职责边界（§27/§31）

### 4.1 一句话分界

```text
事项的生成与提取  → work-time-tracking（本技能）
滴答清单的同步逻辑 → ticktick-work-review
```

| 归属 | 内容 | 落点 |
|---|---|---|
| **本技能** | 事项的**生成与提取**：采集活动、推断项目/工作类型（`references/project-inference.md`）、合并归类与输出格式（`references/daily-summary.md`）、生成 `display_content`、计算 `start_time`/`end_time`/`actual_duration`、时间未知判定（`time_unknown`）、产出交接 JSON | 本文件 §5.1/§5.2/§5.5 |
| **本技能** | 本地侧的同步**状态与流程**：`sync.status` 状态机、`pending`/`syncing`/`success`/`partial`/`failed`、失败保留策略、`/sync` 触发与阶段流转、同步结果落地 | 本文件 §7/§8 |
| **ticktick-work-review** | 一切 TickTick 侧行为：Task 创建 / 更新 / 完成、**字段映射**（本地字段 → TickTick 字段）、幂等、**外部任务 ID（taskId）产生与回写**、按 id 或标题定位任务 | `ticktick-work-review/references/mcp-capabilities.md` |
| **ticktick-work-review** | 写入的**授权分界**（哪些写操作自动执行、哪些需用户授权） | 同上 `SKILL.md` §6 + `ticktick-work-review/references/decision-rules.md` §10 |

### 4.2 判断口诀

```text
「这个数据/事项从哪来、怎么算出来」        → 本技能
「拿这个数据去滴答里怎么落、落到哪个字段」  → ticktick-work-review
```

自检问句：**删掉 TickTick 这个词之后，这条规则还成立吗？**
- 成立（如「`end_time` 为 null 时保留 `start_time`」）→ 属于事项提取，**留在本技能**。
- 不成立（如「有具体时间段时 `isAllDay` 必须为 false」）→ 属于同步逻辑，**归 ticktick-work-review**。

### 4.3 旧口径说明

本文件此前写的是「`ticktick-work-review` 已有规则优先，本 Skill 不重复定义 TickTick API 行为」。
该口径保留，并按上方 §4.1 具体化为**按「字段映射」归口**：

- 本技能**不过问**具体写哪个 TickTick 字段、以什么格式写、写之前要不要授权 —— 这是 `ticktick-work-review` 的事。
- 本技能**只保证**交接数据的完整与真实（§5.1 / §5.2 / §5.3），并保存对方回传的 `taskId`（§5.6）。
- 需要了解字段映射细节时，**去读 `ticktick-work-review/references/mcp-capabilities.md`**，本文件不再复制。

---

## 5. 交接数据（§30/§31）

### 5.1 同步标题

同步给 TickTick 的事项名称**优先使用 `display_content`**（§31）：

```text
【异构算力平台】【需求梳理】完善GPU调度需求
```

而不是：

```text
完善GPU调度需求
```

这样进入 TickTick 后仍保留 **项目 + 工作类型 + 事项内容**。

### 5.2 交接 JSON

```json
{
  "date": "2026-09-20",
  "work_items": [
    {
      "id": "WI-20260920-A8F2C1D3",
      "display_content": "【异构算力平台】【需求梳理】完善GPU调度细粒度需求",
      "project_name": "异构算力平台",
      "work_type": "需求梳理",
      "content": "完善GPU细粒度调度需求",
      "start_time": "10:10",
      "end_time": "11:20",
      "actual_duration": 70,
      "estimated_duration": null,
      "status": "completed",
      "source": "auto",
      "notes": ""
    },
    {
      "id": "WI-20260920-B1C2D3E4",
      "display_content": "【云浮门户】【需求文档】需求文档梳理",
      "project_name": "云浮门户",
      "work_type": "需求梳理",
      "content": "需求文档梳理",
      "start_time": "15:20",
      "end_time": null,
      "actual_duration": null,
      "estimated_duration": null,
      "status": "completed",
      "source": "workbuddy",
      "time_unknown": false,
      "notes": ""
    }
  ]
}
```

完整材料用 `daily-summary.js material --json` 获取（只含 WorkItem，不含完整 Activity，§34）。

**交接契约只约束「给出什么」，不约束「对方怎么写进 TickTick」。** 字段怎么落位见
`ticktick-work-review/references/mcp-capabilities.md`。

### 5.3 时间字段必须完整交出（本技能的义务）

**本技能的义务止于「把时间完整、真实地交出去」。** 只要 WorkItem 有 `start_time` 就必须放进交接 JSON；
有 `end_time` 一并放入 —— **不得在提取/合并环节丢掉时间**。

| 字段 | 要求 | 说明 |
|---|---|---|
| `start_time` | **有值即必须交出** | 事项开始时间，`HH:MM` |
| `end_time` | 有值即必须交出 | 结束时间；合并后无法确定时为 `null` |
| `actual_duration` | 有值即交出 | 分钟数；无依据时为 `null` |

三条约束：

1. **顺序优先用 `start_time` / `end_time`** —— 不要只给 `actual_duration`。时长无法还原「几点到几点」。
2. **`end_time` 为 `null` 是合法状态，不得阻断交接** —— 保留 `start_time` 照常交出，记为「仅开始时间」。
3. **不得为凑齐时间段而编造 `end_time`**（§13）；无法确定就留空。

> **本技能内部必须保证时间不丢**（这是提取环节的责任，与 TickTick 无关）：
> - **采集/手动记录**：`/log 14:00-14:40 开会` 只写 `start_time`/`end_time`、不写 `time_segments`。
> - **总结合并**：`lib/summary-engine.js` 的 `mergeGroup()` 必须让 `start_time`/`end_time` 与
>   `time_segments` **相互补全**（`fallbackSegments()`）—— 否则「只有 start/end、无片段」的记录
>   合并后 `end_time` 会被丢弃、`actual_duration` 归零。

> **`end_time` 的含义按来源区分：**
> - AI 对话推导事项：`end_time` 是会话结束或记录收尾时间，不是实际结束。
>   TickTick 只写 `start_time → startDate`，不得把该 `end_time` 写 `dueDate`，
>   也不得写进备注（`content`）—— 备注写什么由 `ticktick-work-review` 的
>   `content` 模板定义，本技能不定义、也不建议对方把不可信的时间写进去。
> - 手动录入且明确填写结束时间：`end_time` 是事实，可映射为
>   `start_time → startDate`、`end_time → dueDate`，完整区间同时写 `content`。
> - AI 推导事项只有在用户后续明确确认真实结束时间后，才可按手动明确时间处理。
>
> 交接 JSON 无论哪种来源都必须完整交出 `start_time` / `end_time`；
> 字段如何落位由 `ticktick-work-review` 按上述来源规则执行。

**至于这些时间最终写进 TickTick 的哪个字段、`isAllDay` 取什么值 —— 不属于本文件，见 §4.1。**

### 5.4 时间缺失时的展示

总结与同步输出中，时间列按实际情况展示，不留空、不臆造：

```text
10:10-11:20   完整时间段
15:20-        仅有开始时间（结束时间未知）
（未记录）     无任何时间
```

展示格式属于「提取结果的呈现」，与写进 TickTick 无关，因此留在本技能。

### 5.5 时间未知的判定（`time_unknown`）

`completed + time_unknown: true + 时间字段全空` 表示「归属已确认、时间未知」（§14 扩展）。

判定发生在提取阶段：本技能判定「这条事项确实没有时间依据」后，才交出全空的 `start_time`/`end_time`。
**对方不得据此补造时间**（呼应 §5.3 约束 3）。

### 5.6 `taskId` 回写：本地侧保存义务

滴答任务 ID（`taskId`）由 `ticktick-work-review` **产生**（它才知道 taskId），
但**保存进本地 WorkItem 是本地日志的事**。本技能的义务是：

1. **接收**对方在同步回报中给出的「事项 ↔ taskId」对照（见其 `SKILL.md` §6 输出模板）；
2. **落库**到该 WorkItem：字段名 `ticktick`，结构 `{ taskId, projectId, syncedAt }`；
3. **后续交接优先带上 `ticktick.taskId`**，让对方可按 id 精确定位，不必依赖标题搜索；
4. **不改写 `id`**（§6 幂等）——`ticktick` 是新增字段，不与既有 `id` 冲突。

写入命令（已实现，2026-09-21）：

```bash
# 保存对应关系（值来自 ticktick-work-review 的同步回报）
node scripts/update-work-item.js link --id <WorkItem id> \
     --task-id <ticktick taskId> [--project-id <清单 id>] [--synced-at <ISO 8601>]

# 清除对应关系
node scripts/update-work-item.js unlink --id <WorkItem id>
```

> **V3.23 起 target 会自动跨 current / pending 查找**：事项若已跨日转入
> `pending/<date>.json`，`link` 会就地写回该文件，返回体带 `where:"pending"` 与文件名。
> 此前该命令只读 `current.json`，历史事项的 taskId 因此完全写不进去
> （这也解释了为什么 09-20~09-23 的 taskId 长期缺失）。

字段形态由 `normalizeItem()` 归一化、`validate-log.js` 校验：**无 `taskId` 时整个 `ticktick` 置 null**
（不保留半截对象），有 `taskId` 时只保留白名单三字段。详见 `references/data-model.md` §7.1。

> **回退路径仍然有效**：若某条 WorkItem 尚未回写 `taskId`（历史数据），
> 仍按标题搜索匹配，并回读 `content` 中的 `来源：WorkTimeLog WI-xxxx` 与本地 `id` 核对，
> **宁可不动，不可改错**。回写后即可切换为按 id 精确定位。

---

## 6. 幂等（§50）

```text
同一 WorkItem 重复触发同步 → 不得产生多个 TickTick Task
```

任务创建、更新、完成、外部任务 ID、重试、幂等全部遵循 `ticktick-work-review`。

**因此本技能不会重写既有 WorkItem 的 id** —— 即使旧版本 id 格式不同，
迁移时也只提示、不改写。新增 `ticktick` 字段是**追加**，不是改写既有数据。

---

## 7. `/sync` 流程与状态（§51）

```text
读取 DailyLog → 检查 WorkItem → 准备同步数据
        ↓
ticktick-work-review
        ↓
init-log.js sync --status <结果>
        ↓
反馈用户
```

```bash
node scripts/init-log.js sync --status syncing
node scripts/init-log.js sync --status success --detail "8 成功 / 0 失败"
node scripts/init-log.js sync --status partial --detail "7 成功 / 1 失败"
node scripts/init-log.js sync --status failed --detail "<失败原因>"

# V3.23：目标日期已跨日（转入 pending/）时，显式带上 --date
node scripts/init-log.js sync --date 2026-09-24 --status success --detail "6 成功 / 0 失败"
```

> `success` 是合法值，**`synced` 不是**（会被 `VALID_SYNC_STATUS` 拒绝）。
> 带 `--date` 且该日期非当天时，状态写进 `pending/<date>.json`，
> 同时按 `syncState()` 的同一规则维护 `state.pending_sync_dates`（`success` 即移出）。
> 不带 `--date` 时行为不变，仍写 `current.json`。

部分成功时 `success` / `partial` / `failed` 分别记录：

| 状态 | 含义 |
|---|---|
| `pending` | 待同步（默认） |
| `syncing` | 同步中 |
| `success` | 成功 |
| `partial` | 部分成功 |
| `failed` | 失败 |

**未成功的 WorkItem 保留，等待下次同步。**

---

## 8. 自动任务失败处理（§4.3）

如果宿主定时任务执行失败：

- 不删除本地日志
- 不改变 WorkItem 原始记录
- 不标记为已同步
- 下次仍允许重新同步
- 必要时提示用户

外部不可用时必须如实报告，**禁止假装同步成功**：

```text
本次同步未完成。

TickTick 当前无法连接，因此：
- 未创建新任务
- 未修改已有任务

本地工作记录已完整保留，可稍后重新执行 /sync。
```

数量以 `ticktick-work-review` 返回结果为准，不得自行估算。

---

## 9. 与 DailySummary 的关系

**日报本身的规格不在这里** —— 数据源、统计维度、过滤与合并规则、输出格式、
角色维度，全部定义在 `references/daily-summary.md`。

> 本节曾自行复述一遍日报格式与合并条件，其中合并条件还是**旧版**
> （要求「同 project_name + 同 work_type + 内容相关」，与实际实现的
> **「同模块即可合并」**不一致）—— 属于典型的双写漂移，已由本次重构消除。

本技能与 TickTick 相关的只有两件事：

```text
① 把事项与时间**完整交出** —— 含「有 start 无 end」的情况（§5.3）
② 保存对方回传的 `taskId`（§5.6）
```

### 9.1 触发方式

```text
宿主定时任务（建议 18:30） → /summary → 读日志 → 汇总 → 生成 DailySummary → TickTick 同步
用户随时                    → /summary → 同上
```

- 每日**自动**总结最多执行一次。
- 手动 `/summary` 不受次数限制，也不受 `safety_max_calls_per_day` 限制。
- `--trigger auto_scheduled` = 宿主定时任务触发；`--trigger manual`（默认）= 用户触发。
- 宿主侧任务配置见 `references/automation.md` §7。

### 9.2 失败处理

TickTick 同步失败**不得影响**本地日志、结构化日志与日报产出。
本地侧的同步状态机见 §7、§8。

---

## 10. 与 `/today` 的区别

| 命令 | 回答 |
|---|---|
| `/today` | 今天**具体记录了什么** —— 直接读 `current.json`，不重新调用 AI |
| `/summary` | 今天**主要完成了什么** —— 分析层，可调用一次 AI |

二者不能混淆，也不能互相替代。
