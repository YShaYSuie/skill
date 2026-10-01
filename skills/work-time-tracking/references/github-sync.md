# GitHub 日志持久化（V3.1）

> 用户需求 §十五~§十八、§二十九。实现落在 `scripts/sync-github.js`，
> 由 `scripts/test-egress-guard.js`（静态）与 `scripts/test-github-sync.js`（离线行为）双重把关。

---

## 1. 定位：三层存储的最后一层

```text
Raw Conversation   → 短期缓存（默认 7 天，cleanup-raw-logs.js 清理）
        ↓
Structured Logs    → 永久保留（logs/<date>/*.jsonl）← **Local 是 Source of Truth**
        ↓
GitHub             → 长期远程归档（本文件）
        ↓
Daily Summary      → 永久保留（summaries/<date>.md）
```

GitHub 的角色是 **Remote Archive（远端归档）**，不是数据源。
任何统计、复盘、同步到滴答清单的动作都**只读本地 Structured Logs**。

---

## 2. ⚠️ 默认关闭（重要）

```json
"github": { "enabled": false }
```

用户 2026-09-21 明确「日志暂不自动推送到 GitHub」，因此本能力虽然整合进本技能，
**默认不推送**。启用方式二选一：

```bash
# ① 持久启用（写入 config）
#    <log_dir>/config.json → "github": { "enabled": true, ... }
# ② 单次临时启用
node scripts/sync-github.js --apply --force
```

**为什么保留这个能力而不是删掉**：用户随后要求把「GitHub 日志持久化」作为
`work-time-tracking` 的一部分（不拆成独立 Skill），因此实现存在、默认休眠。

---

## 3. 目录结构（远端 = 本地，1:1）

```text
worktimeLog/                     ← 仓库名（config.github.repository）
├── 2026-09-19/
│   ├── conversations.jsonl
│   ├── skill-usage.jsonl
│   ├── work-segments.jsonl
│   ├── work-activities.jsonl
│   └── ai-usage.jsonl
├── 2026-09-20/
│   └── ...
└── 2026-09-21/
    └── ...
```

本地 `logs/<date>/` 与远端 `<date>/` **完全同形**，因此同步是逐文件比对，
不需要任何路径映射 —— 这也是 V3.1 把本地布局从 `structured/<kind>/<date>.jsonl`
改成 `logs/<date>/<kind>.jsonl` 的原因。

---

## 4. 同步原则：Local 覆盖 Remote

```text
本地 Structured Logs ──► GitHub 远端
      （权威）              （从属）
```

| 情况 | 行为 |
|---|---|
| 远端不存在该文件 | 上传本地文件（`created`） |
| 远端存在**且内容一致** | **不更新**，不产生空提交（`up_to_date`） |
| 远端存在**但内容不同** | **本地覆盖远端**，产生 Commit（`updated`） |
| 远端有、本地已无该日期目录 | 默认**不删**；只有 `--prune` 才删除 |
| 远端被别人改过（远端领先） | 先 `fetch` 对齐工作副本，再用本地内容覆盖 → **仍以本地为准** |

### ✗ 禁止

```text
不要因为 GitHub 文件内容不同，就自动反向覆盖本地数据
```

实现上的结构性保证：`sync-github.js` 只**读** `<log_dir>/logs/**`，
只**写**工作副本（`<log_dir>/.github-sync/` 或 `github.work_directory`）。
`test-egress-guard.js` 会静态断言「写入目标不出现日志目录」，
`test-github-sync.js` 会行为断言「同步前后本地日志逐字节不变」。

### 为什么需要先 fetch（易漏的点）

只比较「本地 vs 工作副本」是**不够的**：工作副本可能停留在旧提交上，
而远端已经被别处改动（人工编辑、另一台机器推送）—— 那种情况下工作副本
`git status` 是干净的，脚本会误判为「内容一致、无需更新」，远端就永远停在错的内容上。

正确做法：

```text
git fetch <remote> <branch>
  ├── FETCH_HEAD == 本地 HEAD  → 无差异，继续正常流程
  └── FETCH_HEAD != 本地 HEAD  → git reset --hard FETCH_HEAD（把工作副本对齐远端）
                                 再让本地文件覆盖上去
                                 正常 commit + fast-forward push
```

这样远端被本地覆盖，且**不产生 force push、不破坏远端历史**。
`git reset --hard` 只作用于工作副本（纯缓存），**绝不触碰日志目录**。

---

## 5. 同步范围

```json
"github": {
  "enabled": true,
  "repository": "worktimeLog",
  "visibility": "private",
  "sync_days": 1,
  "sync_raw_logs": false
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `sync_days` | `1` | 只同步最近 1 天（当天）。设 `7` 则同步最近 7 天 |
| `sync_raw_logs` | `false` | **默认不上传 Raw**（Raw 含完整对话痕迹，体积也大） |
| `repository` | `worktimeLog` | 仓库名 |
| `visibility` | `private` | **强制 private**；写成 `public` 会在配置归一化时回落为 `private` |

命令行覆盖：`--days <n>`、`--all`、`--date <YYYY-MM-DD>`（可重复）、`--include-raw`、`--prune`。

---

## 6. 仓库创建（需要 Host 能力）

首次同步需要远端存在。脚本按以下顺序尝试，**任何一步失败都不影响本地日志**：

```text
① 工作副本已是 git 仓库          → 直接用
② 给了 --remote-url <地址|路径>  → git clone
③ 环境有 gh CLI 且未给 remote-url → gh repo create <name> --private --clone
④ 都没有                        → 报告 needs_host 并交回用户，**不假装成功**
```

> ⚠️ **明确标记为「需要 Host 能力」**：脚本**不会**替你创建一个未授权的远端仓库。
> 第 ④ 种情况下的处置：
>
> ```bash
> gh auth login                                   # 安装并登录 GitHub CLI
> # 或手动创建私有仓库后 clone 到工作副本目录：
> #   <log_dir>/.github-sync    （默认），或 config.github.work_directory 指定的位置
> ```

---

## 7. 安全规则（用户 §二十九）

```text
① 仓库默认且强制 private（public 会被回落）
② 推送前对**每个待上传文件**做敏感信息扫描（lib/security.js 的 containsSensitive）
   命中即拒绝同步该批（blocked_sensitive），且本地不受影响
③ 默认不上传 Raw（sync_raw_logs = false）
④ 绝不在命令行参数里携带令牌 —— 认证交给环境（git credential helper / SSH）
⑤ 同步失败**不删除本地日志**，下次继续尝试
⑥ 不做 force push，不破坏远端历史
```

扫描覆盖的敏感类型（复用既有的脱敏规则）：私钥、`sk-`/`AKIA`/`AIza` 类 API Key、
`ghp_`/`github_pat_` 类令牌、`xox*` 令牌、JWT、`password=`/`secret=` 类赋值、
CVE 式环境变量块等。

`test-egress-guard.js` 另做静态断言：`sync-github.js` 里不得出现令牌字面量、
不得把凭据拼进命令行参数。

---

## 8. 用法

```bash
node scripts/sync-github.js --doctor                      # 只看环境与仓库就绪情况
node scripts/sync-github.js --dry-run                     # 预演（**默认就是 dry-run**）
node scripts/sync-github.js --apply                       # 真正提交并推送
node scripts/sync-github.js --apply --days 7              # 同步最近 7 天
node scripts/sync-github.js --apply --date 2026-09-21     # 只同步某天
node scripts/sync-github.js --apply --include-raw         # 连 raw 一起传
node scripts/sync-github.js --apply --prune               # 删除远端过期日期目录
node scripts/sync-github.js --apply --force               # 忽略 enabled=false
```

调试用环境变量：`WTT_GIT_DEBUG=1` 会把每条 git 命令与耗时写到 **stderr**
（写 stderr 而非 stdout —— stdout 是结构化结果通道）。

**退出码**：本脚本恒以退出码 0 结束（除非用法错误）—— 同步失败通过
`action: failed | push_failed | needs_host` 表达，便于宿主任务简单处理。

---

## 9. 关键字段

| 字段 | 含义 |
|---|---|
| `action` | `skipped` / `dry_run` / `up_to_date` / `pushed` / `blocked_sensitive` / `failed` / `push_failed` / `needs_host` |
| `staged` | `{created, updated, unchanged}` —— 本次各有多少文件需要新增/覆盖/未变 |
| `per_date[]` | 每个日期的明细（含 `sensitive` 命中列表） |
| `sensitive_blocked[]` | 被拦下的文件与命中的敏感类型 |
| `remote_diverged` | 是否检测到远端与工作副本不一致（并已对齐后覆盖） |
| `committed` / `pushed` | 是否真的产生了提交 / 推送 |
| `pruned[]` | `--prune` 时删掉的远端日期目录 |
| `needs_host` | `true` 表示需要人工提供仓库或安装 gh |

---

## 10. 与其他环节的边界

```text
✗ 同步失败不得删除本地日志        → 结构化日志是权威，远端只是副本
✗ 同步失败不得影响每日复盘        → 复盘只读本地 logs/
✗ 同步失败不得影响 TickTick 同步  → 三者互不依赖
✓ 同步只在「每天固定时间」由宿主任务触发（任务2），不在对话结束时触发
```

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| `references/settlement.md` | 对话结算与结构化日志的完整机制 |
| `references/data-schema.md` | 结构化日志的字段字典 |
| `references/data-model.md` | 字段定义与存储生命周期 |
| `references/trigger-adapters.md` | 三个自动化任务的宿主接法 |
| `scripts/test-github-sync.js` | 离线行为测试（本地裸仓库当远端） |
