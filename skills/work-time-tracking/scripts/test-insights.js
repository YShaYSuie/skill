#!/usr/bin/env node
'use strict';
/**
 * test-insights.js — 「AI 使用洞察」回归测试（V3.6，用户 2026-09-24）。
 *
 * 用户要回答的四件事：哪个 Skill 高频 / 哪个用不上 / 哪个消耗偏高 / 哪个模型有用，
 * 以及「项目工作中哪个阶段比较侧重在 AI 上」。
 *
 * 本测试盯住最容易出错、也最容易被「帮忙补齐」的四条红线：
 *   ① 模型名归一：同一模型的不同写法必须收敛为一行；
 *   ② 维度合计 **不得大于** 会话总 Token；
 *   ③ 没有 conversation_id 的事项只算时间，**Token/积分记 null，不摊派**；
 *   ④ 同一会话在同一维度被多个取值引用 → **不计入任何一方**。
 *
 *   node scripts/test-insights.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。全程在临时沙箱目录内，不碰真实日志。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const ME = require(path.join(ROOT, 'lib', 'metrics-engine.js'));
const IE = require(path.join(ROOT, 'lib', 'insights-engine.js'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e)}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || '断言失败');
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-insights-'));
const DATE = '2026-09-01';
const dayDir = path.join(sandbox, 'logs', DATE);
fs.mkdirSync(dayDir, { recursive: true });

const writeJsonl = (name, rows) => {
  fs.writeFileSync(
    path.join(dayDir, name),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
    'utf8'
  );
};

const conv = (id, model, token, extra) =>
  Object.assign(
    {
      conversation_id: id,
      date: DATE,
      agent: 'codex',
      source: 'codex',
      model_name: model,
      models: [model],
      start_time: `${DATE}T10:00:00+08:00`,
      end_time: `${DATE}T10:30:00+08:00`,
      duration_seconds: 1800,
      total_token: token,
      input_token: token - 100,
      output_token: 100,
      cached_token: Math.floor(token / 2),
      reasoning_token: 10,
      total_score: 0,
      score_source: 'not_applicable',
      score_request_count: 0,
      request_count: 2,
      status: 'completed',
      settlement_status: 'settled',
      session_id: `sess-${id}`,
      project: null,
      title: `会话 ${id}`,
      skill_count: 0,
    },
    extra || {}
  );

const activity = (id, convId, content, extra) =>
  Object.assign(
    {
      activity_id: id,
      date: DATE,
      content,
      project_name: null,
      work_type: null,
      category: null,
      project_stage: null,
      output: null,
      detail: null,
      display_content: content,
      log: content,
      log_length: content.length,
      start_time: '10:00',
      end_time: '10:30',
      duration_minutes: 30,
      source: 'agent',
      conversation_id: convId,
      segment_id: null,
      status: 'completed',
      confidence: 'high',
      classification_status: 'pending_review',
      skills: [],
      models: [],
    },
    extra || {}
  );

const skillUsage = (id, convId, skillId, version, token, bToken, ordinal) => ({
  usage_id: id,
  conversation_id: convId,
  date: DATE,
  agent: 'codex',
  source: 'codex',
  skill_id: skillId,
  skill_name: skillId,
  skill_version: version,
  start_time: `${DATE}T10:05:00+08:00`,
  end_time: `${DATE}T10:05:00+08:00`,
  duration_seconds: 0,
  skill_token: token,
  token_source: token === null ? 'unavailable' : 'injection',
  call_request_id: `req-${ordinal}`,
  call_request_total_token: bToken,
  load_chars: token === null ? null : token * 4,
  args: null,
  status: 'completed',
  trigger_type: 'agent',
  skill_invocation_id: `inv-${id}`,
  ordinal,
});

// C1 → 项目甲；C2 → 项目乙；C3 同时被甲与乙引用（歧义）
writeJsonl('conversations.jsonl', [
  conv('CON-A', 'custom-local:deepseek-v4-flash', 1000),
  conv('CON-B', 'deepseek-v4-flash', 3000),
  conv('CON-C', 'fast-model', 4000, { agent: 'craft', source: 'workbuddy', total_score: 7.5, score_source: 'workbuddy_credit' }),
  conv('CON-D', 'deepseek-v4-flash', 500, { request_count: 1 }),
]);

writeJsonl('skill-usage.jsonl', [
  skillUsage('SU-1', 'CON-A', 'work-time-tracking', '3.6', 3930, 33000, 0),
  skillUsage('SU-2', 'CON-A', 'work-time-tracking', '3.6', 3930, 33000, 1),
  skillUsage('SU-3', 'CON-A', 'work-time-tracking', '3.6', 3930, 33000, 2),
  skillUsage('SU-4', 'CON-B', 'huge-skill', '1.0', 90000, 900000, 0),
  skillUsage('SU-5', 'CON-B', 'huge-skill', '1.0', 90000, 900000, 1),
  skillUsage('SU-6', 'CON-B', 'huge-skill', '1.0', 90000, 900000, 2),
  // Codex 侧：能数出调用次数，但载入体积不可获取 → null
  skillUsage('SU-7', 'CON-D', 'idea-inbox-git-sync', null, null, null, 0),
]);

writeJsonl('work-activities.jsonl', [
  activity('ACT-1', 'CON-A', '气象数据需求文档梳理', {
    project_name: '气象数据',
    work_type: '需求文档',
    category: '工作',
    project_stage: '需求分析',
  }),
  activity('ACT-2', 'CON-B', '云浮门户评审对齐', {
    project_name: '云浮门户',
    work_type: '会议',
    category: '工作',
    project_stage: '评审对齐',
  }),
  activity('ACT-3', 'CON-C', '甲项目原型设计', { project_name: '气象数据', category: '工作' }),
  activity('ACT-4', 'CON-C', '乙项目方案评审', { project_name: '云浮门户', category: '工作' }),
  // 无 conversation_id：是合法常态（人工记录）→ 只算时间，Token 记 null
  activity('ACT-5', null, '人工补录：需求梳理', {
    project_name: '气象数据',
    category: '工作',
    source: 'manual',
  }),
  // 探索沉淀事项（不进职业口径）
  activity('ACT-6', 'CON-A', '给 work-time-tracking 加洞察报告', {
    project_name: 'AI Skill 探索',
    category: '探索沉淀',
  }),
]);

const metrics = ME.buildMetricsRange(sandbox, DATE, DATE);
const config = {
  summary: { insights: { enabled: true, stale_days: 30, top_n: 5 } },
  role: {},
  work: {},
};
const insights = IE.buildInsights(metrics, { config, inventory: null });
const totalToken = metrics.cost.total_token;

console.log('1. 模型名归一与对比');
check('provider 前缀被归并：custom-local:x 与 x 合为一行', () => {
  const row = insights.models.rows.find((r) => /deepseek/i.test(r.model));
  assert(row, '未找到 deepseek 行');
  assert(
    row.raw_names.length === 2,
    `应记录 2 种原始写法，实际 ${JSON.stringify(row.raw_names)}`
  );
  assert(row.total_token === 4500, `Token 应为 1000+3000+500=4500，实际 ${row.total_token}`);
});
check('会话数按主模型归属，不因 models[] 多写而重复计数', () => {
  const sum = insights.models.rows.reduce((s, r) => s + r.conversation_count, 0);
  assert(sum === 4, `模型会话数合计应等于总会话数 4，实际 ${sum}`);
});
check('显式别名生效（config.json 的 ai.model_aliases）', () => {
  // 别名表读的是日志目录的 config.json（与脚本其它部分同源，不额外注入）
  fs.writeFileSync(
    path.join(sandbox, 'config.json'),
    JSON.stringify({ ai: { model_aliases: { 'fast-model': '快速模型' } } }),
    'utf8'
  );
  const m = ME.buildMetricsRange(sandbox, DATE, DATE);
  const withAlias = IE.buildInsights(m, { config, inventory: null });
  const row = withAlias.models.rows.find((r) => r.model === '快速模型');
  assert(row, `别名未生效，实际模型：${withAlias.models.rows.map((r) => r.model).join(',')}`);
  fs.rmSync(path.join(sandbox, 'config.json'), { force: true });
});
check('模型 Token 合计等于会话总量', () => {
  const sum = insights.models.rows.reduce((s, r) => s + (r.total_token || 0), 0);
  assert(sum === totalToken, `模型合计 ${sum} 应等于会话总量 ${totalToken}`);
});
check('缓存命中率 = 缓存 Token ÷ 总 Token（保留两位）', () => {
  const row = insights.models.rows.find((r) => r.total_token === 4500);
  // (500+1500+250) / 4500 = 50
  assert(row.cache_hit_rate === 50, `命中率应为 50，实际 ${row.cache_hit_rate}`);
});

console.log('\n2. 维度合计不得大于会话总量');
check('按项目的 Token 合计 ≤ 会话总 Token', () => {
  const sum = metrics.cost.by_project.reduce((s, r) => s + (r.total_token || 0), 0);
  assert(sum <= totalToken, `项目维度合计 ${sum} 大于会话总量 ${totalToken}`);
});
check('按项目阶段 / 工作类型的合计同样不得越界', () => {
  for (const dim of ['by_project_stage', 'by_work_type']) {
    const sum = metrics.cost[dim].reduce((s, r) => s + (r.total_token || 0), 0);
    assert(sum <= totalToken, `${dim} 合计 ${sum} 大于会话总量 ${totalToken}`);
  }
});
check('同一会话被两个项目引用 → 归入 ambiguous，不计入任何一方', () => {
  const amb = metrics.cost.by_project_ambiguous;
  assert(amb.length > 0, '应识别出歧义会话');
  const convIds = amb.map((x) => x.conversation_id);
  assert(convIds.includes('CON-C'), `CON-C 应被标为歧义，实际 ${convIds.join(',')}`);
  for (const row of metrics.cost.by_project) {
    if (row.key === '气象数据' || row.key === '云浮门户') {
      assert(
        row.total_token < 4000,
        `${row.key} 不应拿到歧义会话 CON-C 的 4000 Token，实际 ${row.total_token}`
      );
    }
  }
});

console.log('\n3. 未归属不摊派');
check('无 conversation_id 的事项：时间照算，Token 不因它增加', () => {
  // 「AI Skill 探索」是另一个项目 → CON-A 同时被两个项目引用 → 按歧义规则不计入任何一方。
  // 这正是「探索沉淀不该占职业口径」的动机：全量口径下 CON-A 无法归属。
  const all = metrics.cost.by_project.find((r) => r.key === '气象数据');
  assert(all, '未找到气象数据行（全量口径）');
  assert(all.without_conversation >= 1, '应记录 without_conversation');
  assert(all.total_token === null, '全量口径下 CON-A 因跨项目歧义不可归属，应为 null');

  // 工作口径剔除「AI Skill 探索」后，CON-A 唯一归属气象数据 → 拿到 1000。
  const work = metrics.cost.by_project_work.find((r) => r.key === '气象数据');
  assert(work, '未找到气象数据行（工作口径）');
  // ACT-1（CON-A）+ ACT-3（CON-C，与云浮门户歧义）+ ACT-5（人工，无 conversation_id）
  assert(work.activities === 3, `工作口径应含 3 条事项，实际 ${work.activities}`);
  assert(work.total_token === 1000, `工作口径应拿到 1000 Token，实际 ${work.total_token}`);
});
check('工作口径与全量口径不可相加（各自都 ≤ 会话总量）', () => {
  for (const key of ['by_project_work', 'by_project']) {
    const sum = metrics.cost[key].reduce((s, r) => s + (r.total_token || 0), 0);
    assert(sum <= totalToken, `${key} 合计 ${sum} 大于会话总量 ${totalToken}`);
  }
});
check('Skill 级积分恒为 null（宿主不提供）', () => {
  for (const r of metrics.cost.skill.by_skill) {
    assert(r.total_score === null, `${r.skill_id} 的积分应为 null，实际 ${r.total_score}`);
    assert(r.score_source === 'unavailable', 'score_source 应为 unavailable');
  }
});
check('Token 与积分互不换算：计分会话只贡献积分，模型不含 API 会话的假积分', () => {
  assert(metrics.cost.total_score === 7.5, `总积分应为 7.5，实际 ${metrics.cost.total_score}`);
  const api = insights.models.rows.find((r) => r.total_token === 4500);
  assert(
    api.score_known_conversations === 0 && api.score_not_applicable_conversations === 3,
    '走模型 API 的会话应记为 not_applicable，而不是 0 分'
  );
});

console.log('\n4. Skill 盘点');
check('高频按调用次数降序（同次数时排序确定）', () => {
  const inv = insights.skills.high_frequency.map((r) => r.invocations);
  for (let i = 1; i < inv.length; i += 1) {
    assert(inv[i - 1] >= inv[i], `调用次数应为降序，实际 ${inv.join(',')}`);
  }
  const ids = insights.skills.high_frequency.map((r) => r.skill_id);
  assert(ids[0] === 'huge-skill', `首条应为 huge-skill（3 次、载入更大），实际 ${ids.join(',')}`);
  assert(
    insights.skills.high_frequency[insights.skills.high_frequency.length - 1].skill_id ===
      'idea-inbox-git-sync',
    '调用最少的应排最后'
  );
});
check('Codex 侧 Skill：次数可计，载入体积为 null（不估算）', () => {
  const row = insights.skills.by_skill.find((r) => r.skill_id === 'idea-inbox-git-sync');
  assert(row, '应包含 Codex 侧的 Skill');
  assert(row.invocations === 1, `调用次数应为 1，实际 ${row.invocations}`);
  assert(row.total_token === null, `载入体积应为 null，实际 ${row.total_token}`);
});
check('消耗偏高的判据同时看载入体积与平均单次请求用量', () => {
  const ids = insights.skills.expensive.map((r) => r.skill_id);
  assert(ids.includes('huge-skill'), `huge-skill 应被判为消耗偏高，实际 ${ids.join(',')}`);
  assert(!ids.includes('work-time-tracking'), '低载入的 Skill 不应被判为消耗偏高');
  assert(insights.skills.expensive_basis === 'load_and_call', '本批 B 口径可用，应为双判据');
});
check('清单缺失时「装了没用过」如实留空，不编造', () => {
  assert(insights.skills.never_used === null, '未提供清单时应为 null');
  assert(insights.skills.inventory_summary === null, '未提供清单时摘要应为 null');
});

console.log('\n5. 报告渲染');
const text = IE.renderInsights(insights).join('\n');
check('七个章节齐全', () => {
  for (const h of ['## 一、', '## 二、', '## 三、', '## 四、', '## 五、', '## 六、', '## 七、']) {
    assert(text.includes(h), `缺少章节 ${h}`);
  }
});
check('明确写出「Skill 载入体积不是真实消耗」', () => {
  assert(text.includes('不是真实消耗'), '报告未声明口径');
});
check('空数据如实说明，不打印「不可获取（不可获取）」这类噪声', () => {
  assert(!text.includes('不可获取（不可获取）'), '出现重复的不可获取措辞');
});
check('渲染不修改输入对象', () => {
  const before = JSON.stringify(insights);
  IE.renderInsights(insights);
  assert(JSON.stringify(insights) === before, '输入对象被修改');
});
check('渲染结果确定（可重复）', () => {
  assert(IE.renderInsights(insights).join('\n') === text, '两次渲染结果不一致');
});

try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (e) {
  /* 清理失败不影响结论 */
}

console.log(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed ? 1 : 0);
