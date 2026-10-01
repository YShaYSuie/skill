# 安全与最小权限（§12 / §55）

> **记录「做了什么」，而不是记录电脑里所有内容。** 本 Skill 不是全量电脑监控工具。

---

## 1. 访问边界（§55）

本 Skill **只能访问**：

```text
用户明确配置的日志目录
宿主允许提供的必要事件信息
```

**默认禁止**：

```text
全盘扫描 · 浏览器数据 · 密码 · Cookie · API Key · 私钥
剪贴板 · 任意 Shell 命令 · 任意权限扩展
```

实现约束：

- `resolveDir()` 只解析用户指定的目录；未配置时报错要求用户指定，
  **绝不回落到技能安装目录或工作区**。
- 脚本内没有任何对日志目录之外路径的读取逻辑。
- `config.security.allow_*` 为 **fail-closed**：写成 `true` 会被 `normalizeSecurityConfig()`
  忽略并回落为 `false`；`validate-log.js` 会把「安全边界被违规打开」直接列为 problem。

---

## 2. Activity 安全过滤（§12）

```text
Activity → Security Filter → WorkItem
```

**禁止绕过 Security Filter 直接进入长期日志。**

### 2.1 允许记录

```text
时间 · 工具来源 · 事件类型 · 工作主题 · 必要的任务上下文
```

### 2.2 禁止记录

```text
密码 · API Key · Token · Cookie · 私钥 · 银行卡信息
完整环境变量 · 完整文件内容 · 浏览器隐私内容
剪贴板内容 · 密码管理器内容
```

### 2.3 执行位置

`scripts/lib/security.js` 的 `filterContent()`，由三个入口统一调用，不存在绕过路径：

| 入口 | 时机 |
|---|---|
| `collect-activity.js ingest` | Activity 入库前 |
| `write-work-item.js` | WorkItem 写入前 |
| `update-work-item.js edit --content` | 改写内容前 |

两步处理：

```text
① 脱敏：命中敏感规则的片段 → [已脱敏:标签]
② 展示内容压缩：折叠换行与连续空白；仍超长（> max_activity_length，默认 200 字）时
        调用线上 LLM 总结到 200 字以内；AI 不可用才截断
③ 结构化 detail：仍先脱敏、折叠单行，但不走 200 字限制；
        默认独立安全上限 4000 字，超过时记录 detail_compression
```

压缩是硬要求：即使不含密钥，也不允许把整段对话或整份文件存进 `current.json`。
`detail` 也不是完整聊天记录备份，只是结构化说明。

### 2.4 超长内容的处理顺序（2026-09-21 起）

**超长不再等于「报错」或「静默截断」**，而是先尝试 AI 压缩：

```text
超长文本
  ├─ ai_summarize = true（默认）
  │    ├─ ① 调 AI 压缩（lib/llm.js → summarizeToLimit）
  │    │     成功 → summarized: true，content_compression.summarized = true
  │    │     失败 → ② 本地截断到上限，truncated: true 且写明 llm_error
  │    └─ 超时预算 ai_summarize_timeout_sec（默认 6s，必须 < hook-bridge 的 7s）
  └─ ai_summarize = false → 直接本地截断（离线/受限环境可用）
```

三条入口行为已统一：

| 入口 | 超长时的行为 |
|---|---|
| `collect-activity.js ingest` | AI 压缩；失败才截断（**不再静默截断**） |
| `write-work-item.js` | AI 压缩；不再报「疑似原始对话」错误 |
| `update-work-item.js edit --content` | AI 压缩；仍拒绝多行 |

> **历史缺陷（已修复）**：早期版本中 Hook 自动采集会把超长内容静默截断到 200 字，
> 截断标记只存在于 stdout（Hook 场景被丢弃）且未持久化 ⇒ 用户完全无感、尾部内容永久丢失。
> 现在无论压缩还是截断，都会在 WorkItem 上留下 `content_compression` 字段。

**AI 压缩的隐私边界**：压缩只发送「被判定为超长的这一条文本」本身，
不发送日志上下文、不发送其他 WorkItem、不发送 Activity 明细。这与 §5 的批量分析边界一致。

> 注意：这是本 Skill 中**唯一**会把内容外发到 LLM 能力的路径（脱敏规则仍是纯本地正则）。
> 若需完全离线，把 `config.security.ai_summarize` 置为 `false` 即退回本地截断。

---

## 3. 本地脱敏规则

纯本地正则，零 AI 调用（§36）。命中即替换，并在输出中回传 `security.hits`。

| 标签 | 覆盖内容 |
|---|---|
| 私钥 | `-----BEGIN … PRIVATE KEY-----` 全块 |
| API Key | `sk-…`、`sk-ant-…`、`AKIA…`、`AIza…` |
| Token | `ghp_`/`gho_`/`github_pat_`、`xox[baprs]-`、JWT 三段式 |
| Bearer 凭据 | `Bearer <长串>` |
| 口令字段 | `password= / secret: / api_key: / access_key=` 等键值对 |
| Cookie | `cookie: …`、`set-cookie: …` |
| 环境变量转储 | 连续 3 个以上 `KEY=VALUE`（§12 禁止完整环境变量） |
| 身份证件信息 | 18 位（末位可为 X） |
| 银行卡信息 | 4 组 4 位数字（含空格/短横分隔） |
| 邮箱地址 | 常规邮箱格式 |

实测：

```text
输入：配置 api key 为 sk-<redacted> 后联调
存储：配置 api key 为 [已脱敏:API Key] 后联调
输出：security: { "redacted": true, "hits": ["api_key"], "truncated": false, "summarized": false }
```

**脱敏先于压缩**：超长文本会先脱敏再送去 AI 压缩，因此密钥不会离开本机。
压缩结果仍会再走一遍脱敏检查（防模型回吐原文）。

---

## 4. `/security` 状态查询（§12/§55）

零 Token 操作，读 `config.security` 与本地规则表生成报告：

```text
工作时间自动记录 · 安全状态

严格模式：开启

访问边界：
  日志目录：已限制
  全盘扫描：关闭
  浏览器访问：关闭
  剪贴板访问：关闭
  密码管理器访问：关闭
  任意 Shell 执行：关闭

记录禁止项：
  记录完整 Prompt：关闭
  记录完整 AI Response：关闭
  记录完整文件内容：关闭
  记录完整命令输出：关闭
  记录完整环境变量：关闭
  记录剪贴板内容：关闭
  记录浏览器隐私内容：关闭
  记录密码管理器内容：关闭

内容脱敏：开启
单条内容上限：200 字
结构化 detail 上限：4000 字
超长处理：AI 压缩（超时 6s；失败才截断）
日志目录：<USER_HOME>\WorkTimeLog

本地脱敏规则：
  私钥、API Key、Token、Bearer 凭据、口令字段、Cookie、环境变量转储、身份证件信息、银行卡信息、邮箱地址
```

```bash
node scripts/status.js security --dir "D:/WorkTimeLog"   # 校验真实数据必须显式传 --dir
node scripts/status.js security
node scripts/status.js security --json
```

> ⚠️ 和 `validate-log.js` 一样，`status.js` 不带 `--dir` 时可能解析到**残留的临时目录**
> （例如测试留下的 `%TEMP%\wtt-*`），报告看起来正常但指向的不是真实日志目录。
> 核对真实环境时一律显式传 `--dir`。

「日志目录：已限制」是唯一被允许的访问面；其余各项恒为「关闭」，配置无法打开。

---

## 5. 与 AI 上下文的边界

批量分析只发送最小结构化信息（`recent_work_items` + `pending_items`），
**不发送**完整聊天记录、完整 AI 回复、完整文件内容、完整电脑活动（§36）。

每日总结只读取 WorkItem，不读取完整 Activity（§24/§36）。

---

## 6. 自检项

`validate-log.js` 中的安全相关检查：

- 安全边界未被违规打开（逐条比对 `ACCESS_BOUNDARIES`）。
- `strict_mode` 为 `true`、`redact_sensitive` 为 `true`。
- 所有 `records[].content` 与 `pending_items[].content` **不含**未脱敏敏感信息。
- 所有 `records[].content` 为单行且不超过 `max_activity_length`。
- **超长内容的处理已留痕**：超过上限的内容必须带 `content_compression`
  （`summarized` 或 `truncated` 为 true 且写明 `reason`）。

任何一条不通过都会以退出码 5 结束，必须先修正再继续记录。

---

## 7. 超长内容留痕字段（`content_compression`）

落在 WorkItem（及 `pending_items[]` 候选）上，只在**真的发生过压缩或截断**时存在，否则为 `null`：

```json
{
  "content_compression": {
    "summarized": true,
    "truncated": false,
    "original_length": 412,
    "final_length": 71,
    "reason": "已由 AI 压缩至 71 字"
  }
}
```

| 字段 | 含义 |
|---|---|
| `summarized` | 内容由 AI 压缩而来（信息被浓缩，未丢失尾部） |
| `truncated` | 内容被本地截断（**尾部信息已永久丢失**） |
| `original_length` | 写入前的原始字符数 |
| `final_length` | 实际落库的字符数 |
| `reason` | 人类可读的处置说明；截断时必须写明失败原因 |

约束（`normalizeContentCompression()` 强制）：

- `summarized` 与 `truncated` **互斥**；数据自相矛盾（两者皆 true）时以**更保守**的
  `truncated` 为准 —— 丢失信息比误报完整更危险。
- 两者皆 false、缺 `original_length`、或不是对象 ⇒ 整个字段置 `null`，**不留半截空对象**。
- 归一化**幂等**：已归一化的记录再跑一次结果不变。

`/summary` 与 `/today` 会显示被压缩/截断的条目，避免用户误以为记录完整。

### `detail_compression`

`detail` 超过 `security.max_detail_length`（默认 4000）时，保留：

```json
{
  "truncated": true,
  "original_length": 6120,
  "final_length": 4000,
  "reason": "detail 超过安全上限，已截断至 4000 字"
}
```

未截断时字段为 `null`。这保证「展示文字不超过 200」与「结构化说明可更完整」
两种限制不会互相混淆，也不会静默丢失 detail。
