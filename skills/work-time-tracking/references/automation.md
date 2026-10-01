# 宿主自动化（Host Automation）

> **`work-time-tracking` 本身不是后台服务。** 所有「自动执行」都依赖宿主的
> Hook / Event / 定时任务。本文档给出可直接落地的配置清单与排查方法。

---

## 1. ⚠️ Skill 不是后台服务（最重要的约束）

- **不创建后台常驻进程**、**不自行创建系统定时器**、**不自行监听整个电脑**、
  **不自行推送 TickTick**、**不自行启动宿主工具**、**不执行未授权的系统任务**。
- **安装 Skill ≠ Skill 开始后台自动运行。**
- `batch_interval_minutes` / `cooldown_minutes` **不是**「Skill 每 N 分钟运行一次」，
  而是「宿主再次触发本技能时，如何控制 AI 分析频率」。
- 本技能的全部脚本中**没有任何定时器或自动化创建逻辑**；也不要主动为宿主创建定时任务
  —— 那是宿主侧的配置。

但也必须理解：

> **Skill 不是后台服务 ≠ 不能自动记录。**
> Skill 不负责自行监听，但可以被宿主的**事件机制**自动调用，从而实现用户无感的自动记录。

因此「对话结束」这个**时机**由宿主提供，**结算逻辑**由本技能提供。

---

## 2. 三种触发机制

| 触发 | 谁负责 | 本技能的动作 |
|---|---|---|
| **宿主事件 / Hook** | 宿主在 SessionStart、UserPromptSubmit、PostToolUse 等节点调用 | 采集 Activity → 匹配或新建 WorkItem → 写 DailyLog |
| **宿主事件 / Hook（对话结束）** | 宿主在 **Stop / SessionEnd** 调用 `settle-conversation.js`（任务1） | 解析对话 → 写结构化日志（可按需含 Segment / AI Usage） |
| **宿主定时任务** | 宿主按固定时间调用（任务2/3） | 归档日志 / 生成每日总结 / 准备同步数据 |
| **用户手动** | 用户输入命令 | 补录、修正、查询、总结、同步、补算结算 |

**实际可用哪些事件由宿主决定，Skill 不假设所有宿主都具备完整 Hook 能力。**
宿主能力不足时**不得声称已实现「完全自动记录」**。

---

## 3. 三个自动化任务（不得合并）

```text
任务1：Conversation End Handler   触发于「对话结束」       实时结算，零 token
        settle-conversation.js --latest --quiet --exit-zero
        ↓ 写入 Structured Logs（Conversation / Turn / Skill / Segment / Activity / AI Usage）
任务2：GitHub Sync                触发于「每天固定时间」   归档，默认关闭
        sync-github.js --apply
        ↓ 按天同步到 private 仓库（Local 覆盖远端）
任务3：Daily Summary              触发于「每天固定时间」   只读汇总 + 同步
        aggregate-logs.js / daily-summary.js material → 撰写 → save
        ↓ 生成每日复盘 + TickTick 同步
```

```text
✗ 任务1 绝不能等到复盘才跑
✗ 任务3 绝不能重新解析原始对话
✗ 任务2 绝不能成为复盘的数据源（它是归档出口，不是入口）
✗ 任一任务失败都不得影响其他两个（尤其不得删除本地日志）
```

---

## 4. 现状核对（实测，非推测）

| 能力 | 是否已配 | 证据 |
|---|---|---|
| 采集 Hook（UserPromptSubmit） | 🟢 **已配** | `/status` 显示宿主触发「Codex Hook / Event / WorkBuddy Hook / Event」已配置 |
| 对话结束结算（任务1） | 🟢 **已配且已运行** | `/status` 显示「对话结算：已结算」，今日 9 次 Conversation 已结算，最近结算 2026-09-21T20:52:45+08:00 |
| 每日复盘（任务3） | ⚠️ **存在但已暂停** | 自动化「每日工作总结」`status: PAUSED`；今日总结由 `manual` 触发 |
| GitHub 归档（任务2） | ⚪ **默认关闭** | `github.enabled = false` |
| Raw 清理 | ❌ **未配** | `raw/` 曾积压 10 个超期目录（已手工清理一次） |

**模式提醒**：未配的两项都属于「**能力存在但从未真正运行**」，且**静默无告警**。
新增任何需要外部触发的能力时，必须同时给出**触发配置**与**未触发的可见信号**。

---

> ⚠️ **2026-09-22 实测更正：任务1 并非「已配」，上表该行结论有误。**
>
> 上表把「对话结束结算（任务1）」判为 🟢 已配且已运行，用的是
> 「`/status` 显示已结算 + 今日有 N 次 Conversation」——这是**用数据存在性代替了触发配置校验**。
> 实测：`~/.workbuddy/settings.json` 中的 `SessionStart` / `UserPromptSubmit` /
> `PostToolUse` / `Stop` / `SessionEnd` **五个 Hook 全部指向 `hook-bridge.js`**，
> 而 `hook-bridge.js` 的 `EVENT_PLAN` 只有 `register-host` / `ingest` / `ignore`，
> **不存在任何调用 `settle-conversation.js` 的动作**。
> 那些「已结算」记录实际来自人工补算 / agent 会话内手动执行，与本 Hook 无关。
> 结论：**本文档 §5 给出的 Hook 配置至今未落地**。
>
> 正确的判定方式：不看 `/status` 的「已结算」，直接检查 hooks 配置里有没有
> `settle-conversation.js`；顺带看定时任务里跑的是 `--latest` 还是 `--backfill`。
>
> 另注两条结构性缺口（同日实测）：
> ① `--latest` 默认 `--limit 1`，**一次只结算 1 个会话** —— 单日多会话时必然漏；
> ② 定时任务若每天只跑一次（且跑的是 `--latest`），则白天任意时刻查 `/today` 都看不到当天会话。
>
> ✅ **同日已修复**（详见 §5）：
> ① `hook-bridge.js` 的 `EVENT_PLAN` 给 `UserPromptSubmit` / `Stop` / `SessionEnd`
>    加了 `settle: true`，按 `--session <id>` 发射 detached 子进程结算（不改宿主配置）；
> ② 定时任务改用 `--backfill --limit 200`，频率提升到每 4 小时；
> ③ `status.js` 新增「宿主触发」信号（`detectSettleTrigger()`），直接检查宿主配置是否
>    可达结算，**不再用数据存在性冒充触发配置**；
> ④ 近 7 天缺口已补算：存活会话缺口 0、冻结记录 0。
> 修复后 `session_row.last_activity_at` 与日志 `end_time` 应保持一致 —— 这是最直接的回归判据。

## 5. 任务1：对话结束结算（Hook，优先级最高）

**为什么最优先**：没有它，`logs/` 里的数据只能靠手工补算；
而对话内容一旦被宿主清理就**无法回溯**。

### 5.1 推荐接法（2026-09-22 起，已在本机落地）

**不要**再单独往 `Stop` 写一条直连 `settle-conversation.js` 的 Hook —— 直接复用已有的
`hook-bridge.js` 入口即可：宿主本来就把 `Stop` / `SessionEnd` / `UserPromptSubmit`
指向 `hook-bridge.js`，只要它的 `EVENT_PLAN` 里带上 `settle: true`，这三个事件就会各触发
一次结算（fire-and-forget 子进程，不占 Hook 的 10s 预算）。**无需改动宿主配置。**

两个必须这样做的理由：

| 理由 | 说明 |
|---|---|
| **必须拿到 `session_id`** | 直连只能写死 `--latest`，而它默认 `--limit 1`：多会话并发时会**结算错对象**，单日多会话必然漏。经 hook-bridge 可传 `--session <payload.session_id>`，永远只结算触发它的那个会话。 |
| **不能阻塞 Hook** | 结算需解析 JSONL + 拿写锁，耗时随会话长度增长。hook-bridge 用 `spawn(detached) + unref` 发射后立即返回（几十毫秒），彻底避开宿主 10s 预算。 |

三个事件都挂 `settle` 是**有意的冗余**：同一轮有三次机会；`settleOne` 无 skip 逻辑、
按**绝对值覆盖**写，重复触发只报 `already_settled`，不累加。

⚠️ 结算**必须在 `refreshOnly` 闸门之前**执行 —— 会话结算与「有没有进行中的工作事项」
毫无关系，早期把它放在闸门后面会导致「当前无进行中事项时连结算也被跳过」。

代码位置：`scripts/hook-bridge.js` 的 `EVENT_PLAN`（`settle: true`）与 `handle()` ⓪ 段。

### 5.2 备选接法（单事件直连）

若宿主只提供单一事件、或不便改 hook-bridge，也可直接挂一条命令：

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "matcher": "*",   // PreToolUse / PostToolUse / Stop 必须显式写 matcher
            "command": "\"<USER_HOME>/.workbuddy/binaries/node/versions/22.22.2-3/node.exe\" \"<USER_HOME>/.workbuddy/skills/work-time-tracking/scripts/settle-conversation.js\" --latest --quiet --exit-zero >/dev/null 2>&1",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

**关键点**

- `--quiet --exit-zero`：Hook 里任何输出与退出码异常都会干扰会话，这两个开关保证
  **绝不向 stdout 输出、永远退出码 0**。结算失败绝不能阻断或回滚用户会话。
- `timeout: 15`：单次结算在本机约 1–3 秒；给 15 秒足够，且不会卡住会话结束。
- **幂等**：重复触发只会 `already_settled`，不会重复累加 Token / Score。
- ⚠️ 这条路径的 `--latest` 缺陷依然存在，仅作兜底；**优先用 5.1**。

### 5.3 定时兜底：必须用 `--backfill`，不要用 `--latest`

Hook 会漏的场景：宿主异常退出、Hook 未触发、结算子进程被写锁挡住。
因此仍需一条定时任务兜底，但**命令必须是 `--backfill`**：

```bash
node scripts/settle-conversation.js --backfill --limit 200 --quiet --exit-zero
# 省略 --since/--until 时默认扫「今天」；怀疑跨日遗漏可显式加 --since <YYYY-MM-DD>
```

`--backfill` 遍历日期区间内的**全部**会话（`--latest` 只取 1 个）。纯脚本、零 AI 调用，
可放心提高频率（本机现为每 4 小时一次）。

### 5.4 已知盲区：写锁会被崩溃的子进程僵死约 90 秒

结算写盘前要拿 `logs/.write.lock`。若持锁进程**非正常退出**（被宿主 / 沙箱杀掉），
锁会残留；而结算的等待超时短于陈旧阈值（90 秒），于是**该次结算失败**：

```text
获取写锁超时（<log_dir>/logs/.write.lock）。可能有其他工具正在写入，请稍后重试。
```

后果可控（90 秒后被下一次写入自动回收，且三个 settle 事件里总有一次能成功）。
排查：`node scripts/lock-log.js status`；确有僵尸锁用 `lock-log.js stale --clean`。

### 5.5 如何确认它真的在跑（未触发的可见信号）

```bash
node scripts/status.js
# 必须同时看到两行，缺一不可：
#   对话结算：🟢 已结算
#   宿主触发：🟢 已配置（… 经 hook-bridge 接 settle 或 … 直连结算脚本）
```

- 只显示「🟢 已结算」而**没有**「宿主触发：」这一行 → 记录来自人工补算，**并没有**自动结算。
- 显示「🟡 已结算，但宿主触发未配置」→ 同上，属静默故障。
- 手工对照单个会话：`node scripts/settle-conversation.js --session <id> --dry-run`，
  它会提示日志里的 `total_token` 与本次解析值是否一致（**不一致 = 记录冻结在半路**）。

若 `logs/<今天>/conversations.jsonl` 长期没有新记录 → Hook 没生效。

#### 5.5.1 验证「没有漏结算」——用差集，别重跑 backfill

判断某个日期是否还有未结算会话时，**不要反复跑 `--backfill` 来"看一看"**：
它每次都要重新 `listRecentSessions` 读 `workbuddy.db`，宿主占用数据库时会长时间挂住
（2026-09-22 实测第三次重跑无输出挂死 5.5 分钟，挂点在写锁之前），且幂等重跑本身不提供任何新信息。

正确做法是**比对两个集合的差集**（纯只读、秒级）：

```bash
# raw 快照里的 session_id 集合  vs  conversations.jsonl 里的 session_id 集合
ls "D:/WorkTimeLog/raw/workbuddy/<YYYY-MM-DD>"
node scripts/…   # 或直接用 node -e 读两个目录做差集
```

- `UNMATCHED = 0` → 该日全部结算完毕，无需任何动作（可直接跳过 backfill）。
- 有残留 → 再针对该日跑一次 `--backfill --since <该日> --until <该日>`。

**跨日检查**：凌晨（00:00–06:00）运行时，"今天"已翻页，前一晚 23:00 之后的会话
归属**前一天**。跑完今日 backfill 后，顺手对**昨天**也做一次差集比对；只有昨天仍有残留，
才需要补 `--since <昨天>`。（2026-09-23 03:10 实测：09-22 raw 17 / settled 17，UNMATCHED = 0，
确认无跨日遗漏。）

#### 5.5.2 ⚠️ Codex Desktop 的沙箱写权限（2026-09-23 实测）

Codex Desktop 的 Hook **继承当前任务的 sandbox policy**。当前任务若没有把
`<log_dir>` 放进可写根，Hook 进程会被正常启动，但 `hook-bridge.js` / `settle-conversation.js`
对日志目录的写入会收到 `Access is denied`；Hook 必须静默，因此表现为
「日志里能看到 hook/started，但 `current.json` / `last-hook.json` 完全不更新」。

判定方法（零 Token）：

```powershell
[System.IO.File]::WriteAllText('<log_dir>\.codex-write-probe','ok')
# 失败 = 当前 Codex 任务不可写
```

修复：在 Codex 当前任务/项目的权限设置里把 `<log_dir>` 加入 writable roots，
然后重启或重开该任务。只改全局 `~/.codex/config.toml` 的
`[sandbox_workspace_write].writable_roots` **可能被 per-thread managed sandbox 覆盖**，
所以要以任务权限设置为准。

#### 5.5.3 Codex Desktop Hooks（2026-09-24 实测修正）

**Codex Desktop 支持官方 lifecycle hooks。** 配置可写在
`~/.codex/config.toml` 的 `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]`，
也可写在同一配置层的 `hooks.json`。是否可执行以 app-server `hooks/list` 返回的
`enabled` 与 `trustStatus` 为准。

Windows 下命令必须能被 PowerShell 解析。**不要**把裸路径写成：

```toml
command = '"C:/.../node.exe" "C:/.../hook-bridge.js" --host codex'
```

PowerShell 会报 `Unexpected token` / `ParserError`。表现为
`hook/started` 后立即出现 `hook/completed(status=failed)`，
`current.json` / `last-hook.json` 完全不更新。正确写法：

```toml
command = '& "C:/.../node.exe" "C:/.../hook-bridge.js" --host codex'
command_windows = '& "C:/.../node.exe" "C:/.../hook-bridge.js" --host codex'
```

注意：

- 修改 hook 定义会改变 `currentHash`；必须通过 `/hooks` 重新审核，
  或把 `[hooks.state]` 的 `trusted_hash` 更新为 `hooks/list` 返回的
  `currentHash`，否则状态是 `modified` 并被跳过。
- 复测不要只看“配置存在”：用 app-server 创建一次非临时 thread，
  确认出现 `hook/completed(status=completed)`；再看
  `pending/last-hook.json` 是否更新。
- 2026-09-23 旧记录曾误判为“Codex Desktop 不支持 hooks”；实际是
  PowerShell 引号解析事故，本段在 2026-09-24 修正。
- 自 V3.14 起，推荐入口固定为 `codex-hook-launcher.ps1`；
  `ensure-codex-hooks.js --repair` 会幂等修复命令、补齐事件并校准信任哈希。

#### 5.5.4 自动体检与修复（V3.14）

不再要求用户每天手动检查。维护入口为：

```bash
node scripts/ensure-codex-hooks.js            # 只读检查；异常退出码 2
node scripts/ensure-codex-hooks.js --repair   # 修复命令、事件与信任哈希
```

`auto-maintenance.js` 会在每次定时维护开始时先运行 `--repair`，再执行会话补算与事项导出。
日常维护使用 `--repair --no-trust-probe`，避免沙箱无法启动 app-server 时产生误报；
需要完整校准信任哈希时，单独运行不带 `--no-trust-probe` 的 `--repair`。
命令固定调用 `codex-hook-launcher.ps1`，因此 Codex runtime 路径变化时只需更新 launcher，
不会改变 Hook 配置哈希，也不会再次触发“每天检查一次”的人工操作。

---

## 6. 事件 Hook 接入（采集侧）

采集侧由技能自带的桥接脚本承担：

```bash
node scripts/hook-bridge.js              # 读 stdin 的事件 JSON，转成 Activity 后交给 ingest
node scripts/hook-bridge.js --self-test  # 查看事件映射与内容提取（不写日志）
```

### 6.1 三条硬约束（`hook-bridge.js` 内已实现）

```text
1. 绝不向 stdout 输出。SessionStart / UserPromptSubmit 的 stdout 会被宿主注入对话上下文。
2. 永远退出码 0。Hook 失败不得阻断用户会话。
3. 快速返回。单次等待上限 4 秒；refresh-only 事件在「无进行中事项」时直接返回，
   不启动子进程（PostToolUse 会在每次工具调用触发，这个前置判断很关键）。
```

### 6.2 事件映射

| 宿主事件 | 处理 |
|---|---|
| `SessionStart` | 登记宿主触发状态（触发来源的实证），不写记录 |
| `UserPromptSubmit` | 采集用户输入 → 本地规则匹配（含工作活动判定） |
| `PostToolUse` | **仅刷新**当前进行中事项；无匹配则忽略 |
| `Stop` | 仅刷新（**Stop 不等于事项完成**）；同时**用于触发对话结算** |
| `SessionEnd` | 仅刷新（不直接结束 WorkItem）；也可触发结算 |
| `PreToolUse` / `Notification` / `PreCompact` / `SubagentStop` | 忽略 |

Codex 的 `UserPromptSubmit` 载荷带 `session_id` 与 `cwd`。采集层会优先读取
`<CODEX_HOME>/state_5.sqlite` 的 `projects` / `project_roots`，把正式项目名、
`project_id` 与 `session_id` 一并写入 Pending / WorkItem；会话结算后再用
`session_id` 回链 `conversation_id`。该链路只读本地 SQLite，不访问线上项目接口。

> **`Stop` 的双重用途**：对 **WorkItem** 仍然只是「刷新」—— 不因为一次对话结束就把
> 工作事项结掉。但对**对话结算**，`Stop` 正是「Conversation 结束」的信号。
> 这两件事互不影响，因为它们写的是**不同的日志**。

### 6.3 配置位置与注意事项

WorkBuddy 的 Hook 配置写在 `~/.workbuddy/settings.json`。
Codex Desktop 使用官方 lifecycle hooks，本机写在 `~/.codex/config.toml`。
**采集**与**结算**是两个独立的 Hook 条目。

> 以下条目仅描述 WorkBuddy；Codex 使用 PowerShell 执行命令，配置与排查见 §5.5.3。

- **路径必须绝对**，且不依赖 `dirname`/`head`/`rm` 等 coreutils —— 本机 Git Bash
  的 shim 不完整。Hook 在 Windows 上强制走 Git Bash 执行。
- **stdout 必须重定向** `>/dev/null 2>&1`，否则会污染对话上下文。
- **PreToolUse / PostToolUse 必须显式写 `"matcher": "*"`**。文档说省略即匹配全部，
  但实测省略时该事件**完全不触发**。
- **配置是持久的**：重启电脑不会丢失，宿主自动加载，**无需任何手动启动操作**。
  本版本默认**热重载**（`ENV_KEY_CODEBUDDY_DISABLE_HOT_RELOAD` 可关闭），
  外部编辑 `settings.json` 也会自动生效。
- 技能**不自行创建** Hook 或定时任务 —— 配置由用户确认后写入。
- ⚠ **超大会话的替代方案**：若 `Stop` 频繁超时，改用宿主**定时任务**每分钟
  `settle-conversation.js --latest --limit 3 --quiet --exit-zero`，
  **不要**加大 Hook 超时（超时被强杀可能留下陈旧锁）。

### 6.4 验证 Hook 是否生效

不要假设已生效，用**行为证据**确认（技能自带痕迹文件）：

```bash
# Hook 每次被调用都会覆盖写这个文件（有界，不增长）
node -e "console.log(require('fs').readFileSync('D:/WorkTimeLog/pending/last-hook.json','utf8'))"
```

`result.action` 取值 `ingest`（已处理）/ `skipped`（含原因）/ `not-mapped`（未映射事件），
可区分「宿主没触发」与「触发了但处理失败」。

Codex 侧还应从 app-server 调用 `hooks/list`，确认 `enabled=true` 且
`trustStatus=trusted`。仅“配置存在但 modified/untrusted”时，Hook 会被静默跳过。

### 6.4b ⚠️ 故障排查：Codex 侧「Hook 触发了却没有记录」（V3.21）

**症状**：Codex 里当天的记录（尤其是每天第一条）不出现，用户只能每天手动排查；
WorkBuddy 侧却正常。`/status` 只显示「已开启但暂无活动」，看不出哪里坏了。

**真实成因（2026-09-26 实测确认，两个缺陷叠加）**：

```text
① ~/.codex/config.toml 里的 hooks 段被 Codex 应用重写时整段丢掉。
   证据：备份 config.toml.bak-wb-rescue-20260923（09-23 23:15）里有 5 个 Hook，
        当天的 config.toml（09-24 22:18:43 重写）里一个都没有。
   hooks 段一旦消失，Codex 侧再也不会触发任何事件 —— 也就没有任何机会自我修复。

② 即使 hooks 段在，codex-hook-launcher.ps1 也会静默空转：
   它只认三个 node 来源（WTT_NODE_BIN / Codex 托管 runtime / PATH），
   而本机这三处全都不存在 → 直接 `exit 0`，什么也不做。
   证据：手工喂一个 SessionStart 给它，退出码 0、current.json 未创建。
```

**定位（只读、零 Token）**：

```bash
node scripts/ensure-codex-hooks.js            # action=ok 才算装好；看 node.resolved 是否有值
node scripts/status.js --json                 # hosts[] 里 codex 是否 unconfigured
Get-Content ~/.work-time-tracking/node-path.txt   # launcher 上次解析到的 node
# 若 launcher 找不到 node，日志目录里会出现（有界、只记失败）：
Get-Content <log_dir>/pending/launcher-trace.jsonl
```

**修复与防线（V3.21 已内建）**：

```text
1. launcher 改为**候选清单**解析 node：WTT_NODE_BIN → 缓存路径 →
   Codex 托管 runtime → Codex 应用 runtime → WorkBuddy 自带 node →
   PATH → 常见安装位置；命中后缓存到 ~/.work-time-tracking/node-path.txt。
   全部落空时不再静默：写 <log_dir>/pending/launcher-trace.jsonl 留证。
2. launcher 必须保持**纯 ASCII** —— Windows PowerShell 5.1 会把无 BOM 的
   UTF-8 当 ANSI 读，中文注释会直接让脚本报 "Unexpected token '}'"。
3. 每次会话开始（SessionStart）由 hook-bridge 幂等重装 Codex hooks：
   WorkBuddy 的 Hook 在 settings.json 里、不会被 Codex 重写，
   因此它是最可靠的看门狗。
4. 同一时刻顺手对账（auto-maintenance.js，零 AI、1 小时冷却）：
   把 Hook 没覆盖到的窗口用会话原文补回来（见 §11.1）。
5. /status 在「部分宿主未接入」时会**点名**：
   「⚠ Codex 未接入宿主触发 —— 该工具当天的记录会静默丢失」。
```

> 设计原则：**Hook 的失败必须是可发现的**。允许静默跳过（Hook 不能阻塞宿主），
> 但不允许「坏了却没有任何痕迹」—— 那会把排查成本转嫁成用户每天的人工巡检。

### 6.5 ⚠️ 故障排查：`Hook timed out after 10000ms`

宿主侧报这个错时，先检查「跨日状态 + 陈旧锁」。
在 V3.4.1 以前，跨日闸门要求人工确认，会形成下面的死锁：

```text
日志日期 ≠ 今天
  → collect-activity.js 跨日闸门拦截（旧行为的 EXIT.NEED_DECISION=4）
  → 闸门只提示、不自动 rollover，也没有人能"确认" → 日志日期永远不变
  → 每次触发都白跑一遍，被宿主判为超时强杀
  → 进程被 kill，finally 里的解锁没执行 → 残留 .write.lock
  → 后续所有写操作拿不到锁（EXIT.CONFLICT=5），彻底写不进去
```

**定位三步**（全部只读，零 Token）：

```bash
# 1. 日志是否跨日（关键信号）
node -e "const c=require('D:/WorkTimeLog/current.json');console.log(c.date, new Date().toISOString().slice(0,10))"
# 2. 是否有残留锁（pid 已不存在即为死锁）
node -e "console.log(require('fs').readFileSync('D:/WorkTimeLog/.write.lock','utf8'))"
# 3. Hook 最近一次到底发生了什么
node -e "console.log(require('fs').readFileSync('D:/WorkTimeLog/pending/last-hook.json','utf8'))"
```

**修复**：

```bash
node scripts/init-log.js rollover                      # 已同步 → 直接换新日期（不备份）
node scripts/init-log.js rollover --decision keep      # 未同步 → 必须先决定：转入 pending/
```

> **锁是自愈的**：`LOCK_STALE_MS = 90s`，超过 90 秒的锁会被下一次写入自动 `unlink`。
> 因此**不要手工删锁** —— 等 90 秒即可。

**两个已踩过的坑**：

| 坑 | 现象 | 说明 |
|---|---|---|
| 跨日闸门无豁免通道 | 前一天日志没 rollover，第二天 Hook 全线超时 | V3.4.1 起改为自动非破坏性跨日，不再要求 Hook 人工确认 |
| `sync.status` 判定写错 | 已同步日志跨日被误判为「未同步」而转入 `pending/` | 合法值是 `'success'`（`VALID_SYNC_STATUS`），不是 `'synced'`；已修正 |

> **V3.4.1 起**：采集和手工新增事项都会自动执行非破坏性跨日。
> 旧 WorkItem 先永久导出；未同步旧日志转 `pending/<date>.json`，随后继续写当天记录。
> Hook 不再因为 `current.json` 停留在昨天而丢弃新日期活动。

**结论**：`Hook timed out` ≠ Hook 坏了。若仍看到旧日期，先确认脚本版本、
`pending/last-hook.json` 与日志目录权限；手工恢复仍可运行
`init-log.js rollover --decision keep`。

---

## 7. 任务3：每日复盘（已存在，需恢复并更新指令）

**当前状态（2026-09-26）**：已建成 Codex automation「工作记录：每日工作日报」
（`~/.codex/automations/automation/automation.toml`，每天 18:30，`failed_runs_only`）。
落盘路径：`summaries/<date>.md`；`--trigger auto_scheduled` 保证每天最多一次。

**关键约束（无人值守）**：需要放行
`export-work-activities.js` / `daily-summary.js` / `cleanup-raw-logs.js` 三个脚本，
且规则是**在 App 启动时加载**的 —— 新写的规则要**重启一次 Codex** 才生效
（实测：未重启时未提权执行会被沙箱拒绝，报 `EPERM, Permission denied`）。
总结正文不要写在命令行里，先落到固定临时文件，再用
`save --text (Get-Content -Raw '<固定路径>')` 传参，避免转义与长度问题。

**建议的任务指令**（覆盖原 prompt，把新增口径写进去）：

```text
生成今日工作日报。

数据源与顺序：
1. 运行 node scripts/export-work-activities.js
   （把已归类事项导出为永久日志）
2. 运行 node scripts/daily-summary.js material 取素材
3. 撰写并运行 node scripts/daily-summary.js save --text "..." --trigger auto_scheduled

撰写要求：
- 按「项目 × 工作类型」归并，只总结日程，不逐条铺陈细节
- 分三块：产品工作（按产品线）/ 探索学习（技能与工具建设，属个人方向）/ 日常活动（运动生活，不计入工时）
- 项目允许为空；无项目的事项按内容归入「探索学习」或「日常活动」
- 待判断事项非空时，必须列出内容，且不得对当日产出下排他性结论
- Token / Score 只读 Structured Logs，不得重算；Score 是下界时须标注
```

格式与口径详见 `references/daily-summary.md`。

---

## 8. 任务2：GitHub 归档（默认关闭，按需启用）

**当前状态**：`github.enabled = false`。

启用前需要先决定仓库与凭据：

```bash
gh auth login                              # 或手动 clone 私有仓库到工作副本
# 然后编辑 <log_dir>/config.json: "github": { "enabled": true, ... }
```

启用后追加定时任务（建议 23:00）：

```bash
node scripts/sync-github.js --apply
```

**安全默认值（不要改）**：`visibility: private`、`sync_raw_logs: false`、推送前敏感信息扫描。
详见 `references/github-sync.md`。

---

## 9. Raw 清理（建议 23:05）

```bash
node scripts/cleanup-raw-logs.js --apply
```

- 保留期 7 天（`storage.raw_log.retention_days`）。
- 只清 `raw/<source>/<YYYY-MM-DD>/`（workbuddy / codex），**绝不触碰** `logs/` 与 `summaries/`
  （脚本内有硬断言）。
- 不配的话 `raw/` 会无限增长（首次实测已积压 10 个超期目录 / 108 KB）。

---

## 10. 不需要单独配的

| 能力 | 原因 |
|---|---|
| WorkItem 永久导出 | 已接入 `daily-summary save` 与 `init-log rollover`，无需独立任务 |
| TickTick 同步 | 由 `ticktick-work-review` 负责，含在任务3 的复盘流程里 |
| AI 自动归类 | `ai.auto_analysis.enabled = true` 但**当前无可用 AI 通道**，静默 0 次调用。要么接入通道，要么按需手工跑 `/analyze` |

---

## 11. 汇总：一张表

| # | 任务 | 触发 | 命令 | 现状 |
|---|---|---|---|---|
| 0 | Codex Hook 自愈 | 每小时兜底 | `ensure-codex-hooks.js --repair` | 🟢 接入 auto-maintenance |
| 1 | 采集 | Hook `UserPromptSubmit` | `hook-bridge.js` → `collect-activity.js`（新日期自动跨日） | 🟢 已配 |
| 2 | 对话结束结算 | Hook `Stop` | `settle-conversation.js --latest --quiet --exit-zero` | 🟢 已配并运行 |
| 3 | 每日复盘 | 每天 18:30 | `export-work-activities.js` → `daily-summary.js material` → 撰写 → `save --text … --trigger auto_scheduled` | 🟢 已配（Codex automation「工作记录：每日工作日报」） |
| 4 | GitHub 归档 | 每天 23:00 | `sync-github.js --apply` | ⚪ 默认关闭 |
| 5 | Raw 清理 | 每天 23:05 | `cleanup-raw-logs.js --apply` | 🟢 已配（Codex automation「工作记录：Raw 快照清理」） |
| 6 | 待判断事项判定回写 | 每天 21:00 | `collect-activity.js analyze` → `apply` → `export-work-activities.js` → `settle-conversation.js --latest/--relink` | 🟢 已配（自动化「工作记录：判定回写与会话结算」）|

**最小可用集**：任务0 + 任务1 + 任务2。其余按需。

### 11.1 推荐的本机兜底入口

宿主定时任务直接调用：

```bash
node scripts/auto-maintenance.js
node scripts/auto-maintenance.js --days 7     # 放宽结算回填窗口（默认 2 天）
```

它会在一个进程内完成：

```text
ensure-codex-hooks.js --repair（Codex Hook 命令、事件与信任状态）
  → settle-conversation.js --backfill（昨天～今天）
  → export-work-activities.js
  → status.js --json 健康检查
```

正常时退出码为 0；Codex Hook 修复、采集触发、结算触发、自动记录或 spool 任一异常时
退出码非零，适合接入 Codex 定时任务或系统计划任务，并采用「仅失败时提醒」的通知策略。

> ✅ **2026-09-26 傍晚更新：本机已有定时任务（Codex automation）。**
>
> ```text
> ~/.codex/automations/codex/automation.toml
>   name   = 工作记录：Codex 采集兜底维护
>   rrule  = FREQ=DAILY;BYHOUR=22;BYMINUTE=30        （每天 22:30）
>   prompt = 执行 auto-maintenance.js --days 7 → 只回报结果
>   notification_policy = failed_runs_only           （仅失败时通知）
>   target = 项目「AI Skill 探索」（cwds = PROJECT_PATH）
> ```
>
> 两个必须知道的前提（否则任务会「跑了却失败」）：
>
> 1. **命令要预先放行**：无人值守时没有人工审批。已为该命令写入
>    `~/.codex/rules/default.rules` 的 `prefix_rule(decision="allow")`；
>    规则是**逐字符匹配**的，任务里的命令必须与放行的那条完全一致
>    （含结尾的 `2>&1 | Out-String`）。
> 2. **node 路径绑定 Codex 版本**：命令里写的是
>    `...\OpenAI\Codex\runtimes\cua_node\<hash>\bin\node.exe`。
>    Codex 升级后路径会变 —— 此时任务会失败并按提示读取
>    `~/.work-time-tracking/node-path.txt` 的新路径，更新任务与放行规则即可。
>
> ⚠️ **2026-09-26 下午的实测（保留为历史）**：当时本机确实没有任何定时任务。
>
> ```text
> ~/.codex/automations/          不存在
> Windows 计划任务（任务名含 wtt / work-time / maint / codex）  0 条
> WorkBuddy tasks/               只有历史任务记录，没有调度
> ```
>
> 也就是说上面这句「用户不需要每天手动检查」在当时是**不成立的** ——
> 定时任务从未创建，而 Hook 一旦失效就再也没有任何兜底，
> 于是「每天手动排查」成为唯一手段。这正是用户 2026-09-26 反馈的问题。
>
> **现在真正生效的触发点是 SessionStart**（见 §6.4b）：
> `hook-bridge.js` 在每次会话开始时幂等修复 Codex hooks，并顺带跑一次
> `auto-maintenance.js --days 3`（1 小时冷却、跨天必跑、零 AI）。
> 因此即使用户只开一个工具，也能在下次会话把缺口补回来。
>
> 如需更强的保证（长时间不开任何一个工具也能自动补齐），再把它接到宿主定时任务：
>
> ```bash
> node scripts/auto-maintenance.js --days 7
> ```
>
> 接入后仍要遵守「仅失败时提醒」：正常静默，异常才通知。

---

## 12. 无 Hook 时的兜底

宿主不支持 Hook / 未配置时，技能仍可正常使用，只是记录来源变为**手动**：

```bash
node scripts/write-work-item.js --content "【异构算力平台】【需求梳理】完善GPU调度需求" --start 10:10
```

此时 `/status` 会如实显示「宿主触发：🔴 未配置」，
**不得声称已实现完全自动记录**。

---

## 13. 相关文档

| 文档 | 内容 |
|---|---|
| `references/trigger-adapters.md` | 触发机制、宿主适配层、AI 调用策略 |
| `references/settlement.md` | 任务1 的结算机制 |
| `references/github-sync.md` | 任务2 的归档规则 |
| `references/status-and-collectors.md` | 三态状态查询与宿主触发状态 |
