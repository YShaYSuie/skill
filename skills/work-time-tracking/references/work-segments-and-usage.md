# Work Segment 与 AI Usage

> 本文档定义 V3.5 新增的 `work-segments.jsonl` 与 `ai-usage.jsonl`。
> Conversation 仍是 Token / Credit 的原始总账；本机制只增加**可审计的精确归属**。

---

## 1. 数据关系

```text
Conversation
    ├── Skill Usage
    ├── Work Segment 0..N
    ├── Work Activity 0..N
    └── AI Usage 0..N
```

关系规则：

```text
Work Segment 必须关联 conversation_id
Work Activity 可关联 conversation_id 与 segment_id
AI Usage 必须关联 conversation_id
AI Usage 可精确关联 activity_id 或 segment_id
无法精确关联时，attribution_status = unallocated
```

不得把 Conversation 总量按主题、字符、Skill 数或 Token 占比拆分。

---

## 2. Work Segment

### 2.1 用途

Segment 表示一次 Conversation 内连续的工作主题。它解决：

> 同一个 Conversation 中完成了多件不同的事。

Segment 是归属辅助对象，不是成本总账，也不替代 Work Activity。

### 2.2 推荐字段

```json
{
  "segment_id": "SEG-YYYYMMDD-XXXXXXXXXX",
  "conversation_id": "CON-YYYYMMDD-XXXXXXXX",
  "date": "YYYY-MM-DD",
  "ordinal": 0,
  "topic": "GPU 细粒度调度设计",
  "summary": "设计 MIG、显存隔离与节点资源调度规则。",
  "start_time": "2026-09-23T10:00:00+08:00",
  "end_time": "2026-09-23T10:45:00+08:00",
  "source": "agent",
  "status": "completed",
  "confidence": "high"
}
```

### 2.3  ID 与幂等

```text
segment_id = SEG-<YYYYMMDD>-<sha1(conversation_id|ordinal|start_time|topic) 前10位>
```

同一 Segment 重复写入只更新原记录，不新增。

### 2.4 拆分规则

出现以下情况时可形成新 Segment：

```text
工作目标发生变化
项目发生变化
项目阶段发生明显变化
出现独立可交付成果
连续排查独立工具故障
```

没有明显主题变化时不拆分。

---

## 3. Work Activity 扩展字段

V3.5 在 Work Activity 上增加：

| 字段 | 含义 |
|---|---|
| `segment_id` | 关联 Segment；人工事项可为 `null` |
| `ai_role` | `AI主导` / `AI协作` / `AI辅助` / `AI查询` / `AI排障` / `未知` |
| `classification_status` | V3.6：`confirmed` / `pending_review` —— 归属二次确认状态；确认后默认不再重复验证 |
| `detail` | 脱敏后的结构化说明；不再受 200 字展示限制 |
| `log` | 不超过 200 字的展示日志 |
| `log_length` | `log.length` |
| `skills[]` | 与事项直接关联的 Skill |
| `models[]` | 与事项直接关联的模型 |

`content` 继续作为兼容字段，保持 200 字以内的展示内容。

---

## 4. AI Usage Record

### 4.1 用途

AI Usage Record 表示一条**可精确表达的用量归属**：

```text
某段会话 / 某个工作事项实际用了多少 Token / Credit
```

它不能替代 Conversation 总账。Conversation 仍保存平台提供的完整 Token / Credit。

### 4.2 字段

```json
{
  "ai_usage_id": "AUS-YYYYMMDD-XXXXXXXXXX",
  "conversation_id": "CON-YYYYMMDD-XXXXXXXX",
  "segment_id": "SEG-YYYYMMDD-XXXXXXXXXX",
  "activity_id": "ACT-YYYYMMDD-XXXXXXXXXX",
  "date": "YYYY-MM-DD",
  "attribution_status": "exact",
  "input_token": 600,
  "output_token": 400,
  "total_token": 1000,
  "credit": 1.2,
  "model": "gpt-test",
  "models": ["gpt-test"],
  "agent": "codex",
  "skills": ["work-time-tracking"],
  "start_time": "2026-09-23T10:00:00+08:00",
  "end_time": "2026-09-23T10:20:00+08:00",
  "source": "other",
  "note": null
}
```

### 4.3 Token 计算

```text
平台提供 total_token       → 优先使用平台值
未提供但 input/output 都有 → total_token = input_token + output_token
任一端缺失且无平台总量     → total_token = null
```

`credit` 与 Token 独立，禁止换算。

### 4.4 ID 与幂等

```text
ai_usage_id =
  AUS-<YYYYMMDD>-<sha1(conversation_id|activity_id|segment_id|ordinal) 前10位>
```

重复结算按业务键覆盖，不累加。

---

## 5. Attribution Status

| 状态 | 含义 | 约束 |
|---|---|---|
| `exact` | 已知用量明确对应 Segment / Activity | 至少有一个目标 ID |
| `partial` | 只明确了一部分，缺失部分不可推算 | 至少有一个目标 ID；只累计已给数值 |
| `unallocated` | 用量已知但事项未知 | 不得包含 `segment_id` / `activity_id` |

Conversation 汇总输出同时保留：

```text
allocated_token
allocated_credit
unallocated_token
unallocated_credit
```

`unallocated = Conversation 总账 - 已明确归属部分`。
结果不得小于 0；若归属大于总账，汇总会给出 `over_allocated` 警告。

---

## 6. 结算用法

```bash
node scripts/settle-conversation.js --session <id> \
  --segments-file segments.json \
  --activities-file activities.json \
  --ai-usage-file ai-usage.json
```

`activities.json` 与 `ai-usage.json` 可用 `segment_index` / `activity_index`
引用同一批文件中的对象，结算时转换为稳定的 `segment_id` / `activity_id`。

单条 Segment 也可用：

```bash
--segment "主题|摘要|开始|结束|序号"
```

### 6.1 校验规则

```text
所有 Segment / Activity / AI Usage 必须属于当前 Conversation
Activity 引用的 segment_id 必须存在
AI Usage 引用的 activity_id / segment_id 必须存在
unallocated 不得带目标 ID
exact / partial 必须有目标 ID
敏感信息先脱敏再写入
```

校验失败时整次结算不写入，避免留下半套归属数据。

---

## 7. 统计口径

`aggregate-logs.js` 与日 / 周 / 月 / 项目总结继续使用 Conversation 总量，
同时增加：

```text
AI Usage 精确归属 Token / Credit
未归属 Token / Credit
exact / partial / unallocated 记录数
按 Activity 的精确用量
按项目 / 工作类型 / 项目阶段的精确用量
```

旧会话级归因继续保留：

```text
attributeDimension() = 会话级、全有或全无、歧义不计入任何一方
allocatedDimension() = AI Usage 精确归属，绝不反推
```

两种口径必须分开呈现，不得相加。

---

## 8. 与 200 字限制的关系

```text
content / log  → 展示日志，最多 200 字
detail         → 脱敏后的结构化说明，默认安全上限 4000 字
```

`detail` 仍不能保存完整 Prompt、完整 AI Response、完整文件内容或敏感信息。
若超过安全上限，记录 `detail_compression`，不得静默截断。

---

## 9. 非目标

本机制不负责：

```text
按主题自动计算成本比例
把未归属成本强行分给项目
从 Token 反推工作时间
把 Skill 调用次数当成价值
让 Skill 自己后台监听
```
