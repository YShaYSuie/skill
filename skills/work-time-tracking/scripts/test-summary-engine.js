#!/usr/bin/env node
'use strict';
/**
 * test-summary-engine.js — 总结引擎回归测试（零依赖、内置）。
 *
 * 本地正则过滤是"看起来对就容易吃错"的典型：一条过宽的规则会静默吞掉真实工作。
 * 因此这里用**正反双向用例**固化边界，改规则后必须重跑。
 *
 *   node scripts/test-summary-engine.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。**不写任何日志**。
 */

const path = require('path');
const C = require(path.join(__dirname, 'lib', 'log-core.js'));
const SE = require(path.join(__dirname, 'lib', 'summary-engine.js'));

/** 必须保留：真实工作 / 生活指令 */
const KEEP = [
  '你好，帮我完善GPU细粒度调度需求',
  '帮我记录一下刚才的会议结论',
  '看一下设备管理的需求梳理做到哪了',
  '现在开始设计容器创建页面',
  '整理考核模块的状态机',
  '同步一下这条需求到需求池',
  '今天下午的评审会议纪要',
  'index.html页面上方存在很大的空白',
  '在系统管理需要添加二级菜单：邮箱配置',
  '5.2 实体关系下的内容好像有点奇怪，怎么显示了Syntax error in text？',
  '需要注意该门户网站主要是提供相关信息的发布与预览',
  // 生活事项
  '肩背拉伸瑜伽',
  '散步',
];

/** 必须过滤：无关对话 / 工具操作 / 宿主通知 */
const DROP = [
  '总结今日',
  '总结一下',
  '输出今日总结',
  '生成今日总结',
  // 2026-09-21 修正：带宾语的总结指令此前漏网（宾语必须**指代记录本身**才算指令）
  '总结今日工作',
  '总结一下今天的工作',
  '总结今天的工作记录',
  '汇总一下当天情况',
  '复盘今日情况',
  '看看今天的记录',
  '同步到滴答清单中',
  '现在这个skill开始自动记录了吗',
  '这个hook怎么配置啊',
  'hook每次重启电脑需要我再手动启动吗',
  '你好',
  '谢谢',
  '你好呀今天过得怎么样啊',
  '今天天气不错呀',
  '@skill:work-time-tracking 现在记录了哪些内容',
  '[$work-time-tracking](C:\\x\\SKILL.md) 现在有开始自动记录了吗',
  '<task-notification><task-id>G3j36u</task-id><status>completed</status>',
  // 真实数据中出现过的「维护记录工具」的请求 —— 不是工作事项
  '更新skill关于这一块的逻辑，日志记录是正常记录的',
  '更新从workbuddy自动同步过去的日志记录',
  '不要使用映射的项目名称！！我要的是workbuddy自己记录这个对话属于哪个项目空间的对话数据',
  '不对，不是按本地文件路径的，应该取workbuddy空间下设置的项目名称',
  '记录到事项中的不用提取对话中的项目名称，而是根据workbuddy或者codex等工具中已新建的项目名称',
  '有个问题，如果后面我新建项目，是不是还有手动更新这个项目映射呢',
  '已有的项目名称包括：云浮门户系统、中大气象系统',
  '这个项目名称应该是记录在线上的，能拿到线上的数据吗',
  '更新今日的操作日志记录，记录项目名称',
  '@image#1:Clipboard_Screenshot.png',
  '继续上一个任务',
  // V3.24：自动采集的过程 / 维护活动不是用户成果
  '修复网络问题',
  '自动化任务结果',
];

const asAuto = (content) => ({
  content,
  source: 'auto',
  status: 'needs_confirmation',
  time_segments: [],
});

let fail = 0;

console.log('=== 应保留（真实事项） ===');
for (const c of KEEP) {
  const r = SE.classify(asAuto(c));
  if (!r.include) fail += 1;
  console.log(`  ${r.include ? '✔' : '✘ 误杀'}  ${JSON.stringify(c).slice(0, 60)}`);
  if (!r.include) console.log(`        → ${r.reason}`);
}

console.log();
console.log('=== 应过滤（无关对话） ===');
for (const c of DROP) {
  const r = SE.classify(asAuto(c));
  if (r.include) fail += 1;
  console.log(`  ${r.include ? '✘ 漏过' : '✔'}  ${JSON.stringify(c).slice(0, 60)}`);
  if (r.include) console.log(`        → 未被过滤`);
}

/* ------------------------- 合并逻辑 ------------------------- */

const mk = (o) => C.normalizeItem(Object.assign({ date: '2026-09-20', tags: [], notes: '' }, o));
const P = { project_name: '异构算力平台', project_confidence: 'high' };

const mergedCases = [
  {
    name: '同项目同类型 + 内容相关 → 合并',
    records: [
      mk(Object.assign({}, P, {
        id: 'A1', content: '完善GPU细粒度调度需求规格说明书', work_type: '需求梳理',
        work_type_confidence: 'high', start_time: '09:00', end_time: '09:30',
        status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '09:00', end: '09:30' }],
      })),
      mk(Object.assign({}, P, {
        id: 'A2', content: '完善GPU细粒度调度需求中的节点选择逻辑', work_type: '需求梳理',
        work_type_confidence: 'high', start_time: '09:35', end_time: '10:05',
        status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '09:35', end: '10:05' }],
      })),
    ],
    expect: (v) => v.items.length === 1 && v.items[0].merged_count === 2,
    label: '合并为 1 条',
  },
  {
    name: '同项目不同类型 → 不合并',
    records: [
      mk(Object.assign({}, P, {
        id: 'B1', content: '设计GPU分配配置页面', work_type: '产品设计',
        work_type_confidence: 'high', start_time: '10:30', end_time: '11:30',
        status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '10:30', end: '11:30' }],
      })),
      mk(Object.assign({}, P, {
        id: 'B2', content: '完善GPU调度需求', work_type: '需求梳理',
        work_type_confidence: 'high', start_time: '11:30', end_time: '12:00',
        status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '11:30', end: '12:00' }],
      })),
    ],
    expect: (v) => v.items.length === 2,
    label: '保持 2 条',
  },
  {
    name: '原始 records 不被修改',
    records: [
      mk(Object.assign({}, P, {
        id: 'C1', content: '完善GPU需求', work_type: '需求梳理', work_type_confidence: 'high',
        start_time: '09:00', end_time: '09:30', status: 'completed', source: 'manual',
        confidence: 'high', time_segments: [{ start: '09:00', end: '09:30' }],
      })),
    ],
    expect: (v) => v.items.length === 1,
    label: '只读派生',
  },
];

console.log();
console.log('=== 宿主系统通知：即使带项目名也必须排除 ===');
{
  const cases = [
    ['<task-notification><task-id>G3j36u</task-id><status>completed</status>', '云浮门户系统'],
    ['<task-notification><task-id>x</task-id><summary>cd "E:/work/项目文档/中大气象"</summary>', '中大气象系统'],
  ];
  for (const [content, project] of cases) {
    const r = SE.classify({ content, source: 'auto', status: 'needs_confirmation', time_segments: [], project_name: project });
    const ok = !r.include;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  带 project_name=${project} 的宿主通知仍被排除`);
    if (!ok) console.log(`        → ${r.reason}`);
  }
  // 反向：手动记录 + 有项目 → 必须保留
  const keep = SE.classify({ content: '完善配置页面', source: 'manual', status: 'completed', time_segments: [], project_name: '云浮门户系统' });
  const ok2 = keep.include;
  if (!ok2) fail += 1;
  console.log(`  ${ok2 ? '✔' : '✘'}  手动记录 + 有项目 → 保留`);

  const manualOps = SE.classify({
    content: '修复网络问题',
    source: 'manual',
    status: 'completed',
    time_segments: [],
    project_name: '云浮门户系统',
  });
  const ok3 = manualOps.include;
  if (!ok3) fail += 1;
  console.log(`  ${ok3 ? '✔' : '✘'}  手动记录「修复网络问题」仍保留`);
}

console.log();
console.log('=== 噪声即使带项目名也必须被过滤（回归） ===');
{
  const cases = [
    ['继续上一个任务', '云浮门户'],
    ['@image#1:Clipboard_Screenshot.png', '云浮门户'],
    ['输出今日总结', '云浮门户'],
    ['汇总一下', '气象数据'],
    ['修复网络问题', '云浮门户'],
    ['自动化任务结果', '云浮门户'],
  ];
  for (const [content, project] of cases) {
    const r = SE.classify({ content, source: 'auto', status: 'needs_confirmation', time_segments: [], project_name: project });
    const okc = !r.include;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  带 project_name=${project}：${JSON.stringify(content).slice(0, 30)} 仍被过滤`);
  }
  // 反向：真实工作 + 项目名 → 必须保留
  const keeps = ['总结今日会议结论', '继续完善需求说明书', '完善云浮门户的分类管理'];
  for (const content of keeps) {
    const r = SE.classify({ content, source: 'auto', status: 'needs_confirmation', time_segments: [], project_name: '云浮门户' });
    const okc = r.include;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  真实工作不被误杀：${JSON.stringify(content).slice(0, 30)}`);
  }

  // 反向（2026-09-21 修正的守卫）：宾语不是「记录本身」的总结类请求 = 真实工作，不得误杀。
  // 修正后的宾语白名单只含 工作/记录/日志/情况/总结/汇总 这几个指代记录的词，
  // 因此下面这些以真实产物为宾语的请求必须保留。
  const keeps2 = [
    '总结基金金融调研记录',      // 宾语「基金金融调研记录」不在白名单 → 保留
    '汇总异构图谱的实体关系',    // 宾语是技术对象 → 保留
    '复盘上次评审的问题点',      // 宾语是评审问题 → 保留
  ];
  for (const content of keeps2) {
    const r = SE.classify({ content, source: 'auto', status: 'needs_confirmation', time_segments: [], project_name: '基金金融' });
    const okc = r.include;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  总结类真实工作不被误杀：${JSON.stringify(content).slice(0, 30)}`);
  }
}

console.log();
console.log('=== 合并逻辑 ===');
for (const c of mergedCases) {
  const log = { date: '2026-09-20', records: c.records };
  const before = log.records.length;
  const v = SE.buildSummaryView(log);
  const ok = c.expect(v) && log.records.length === before;
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✔' : '✘'}  ${c.name} → ${c.label}（实际 ${v.items.length} 条）`);
  if (log.records.length !== before) {
    fail += 1;
    console.log('        ✘ 原始 records 被修改！');
  }
}

console.log();
console.log('=== 时间字段保留（合并后不得丢失） ===');
{
  const C0 = require(path.join(__dirname, 'lib', 'log-core.js'));
  const mk = (o) => C0.normalizeItem(Object.assign({ date: '2026-09-20', tags: [], notes: '' }, o));
  const P = { project_name: '异构算力平台', project_confidence: 'high' };

  // ① 只有 start/end、无 time_segments（/log 补录）→ 合并后 end_time 必须保留
  {
    const recs = [
      mk(Object.assign({}, P, {
        id: 'T1', content: '考核模块状态机设计', work_type: '产品设计',
        start_time: '11:30', end_time: '11:50', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [],
      })),
      mk(Object.assign({}, P, {
        id: 'T2', content: '考核模块状态流转设计', work_type: '产品设计',
        start_time: '11:50', end_time: '12:20', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [],
      })),
    ];
    const m = SE.mergeGroup(recs, 12 * 60 + 30);
    const okStart = m.start_time === '11:30';
    const okEnd = m.end_time === '12:20';
    const okDur = m.actual_duration === 50;
    if (!okStart) fail += 1;
    if (!okEnd) fail += 1;
    if (!okDur) fail += 1;
    console.log(`  ${okStart ? '✔' : '✘'}  无 segments 时开始时间保留（实际 ${m.start_time}，期望 11:30）`);
    console.log(`  ${okEnd ? '✔' : '✘'}  无 segments 时结束时间保留（实际 ${m.end_time}，期望 12:20）`);
    console.log(`  ${okDur ? '✔' : '✘'}  无 segments 时时长正确（实际 ${m.actual_duration}，期望 50）`);
  }

  // ② 有 start、无 end（归类后无法确定结束时间）→ 必须保留 start_time，end_time 为 null
  {
    const recs = [
      mk(Object.assign({}, P, {
        id: 'T3', content: '需求文档梳理', work_type: '需求梳理',
        start_time: '15:20', end_time: null, status: 'completed', source: 'workbuddy', confidence: 'high',
        time_segments: [],
      })),
    ];
    const m = SE.mergeGroup(recs, 18 * 60);
    const okStart = m.start_time === '15:20';
    const okEnd = m.end_time === null;
    if (!okStart) fail += 1;
    if (!okEnd) fail += 1;
    console.log(`  ${okStart ? '✔' : '✘'}  无法确定结束时间时保留开始时间（实际 ${m.start_time}，期望 15:20）`);
    console.log(`  ${okEnd ? '✔' : '✘'}  不编造结束时间（实际 ${JSON.stringify(m.end_time)}，期望 null）`);
  }

  // ③ 完全无时间 → 保持为空，不得凭空补时间
  {
    const recs = [
      mk(Object.assign({}, P, {
        id: 'T4', content: '系统配置梳理', work_type: '需求梳理',
        start_time: null, end_time: null, status: 'completed', source: 'workbuddy', confidence: 'high',
        time_segments: [], time_unknown: true,
      })),
    ];
    const m = SE.mergeGroup(recs, 18 * 60);
    const ok = m.start_time === null && m.end_time === null;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  无时间信息时不凭空补（start=${JSON.stringify(m.start_time)}, end=${JSON.stringify(m.end_time)}）`);
  }
}

{
  const C0 = require(path.join(__dirname, 'lib', 'log-core.js'));
  const mk = (o) => C0.normalizeItem(Object.assign({ date: '2026-09-20', tags: [], notes: '' }, o));
  const P = { project_name: '气象数据', project_confidence: 'high' };

  // ① 同模块但**措辞完全不同**（无共同词）→ 仍应合并；开始时间取最早
  {
    const recs = [
      mk(Object.assign({}, P, {
        id: 'M1', content: '在系统管理需要添加二级菜单：邮箱配置', work_type: null,
        start_time: '14:58', end_time: '15:10', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '14:58', end: '15:10' }],
      })),
      mk(Object.assign({}, P, {
        id: 'M2', content: '在邮件管理中需要提供是否开启邮箱服务', work_type: null,
        start_time: '16:13', end_time: '16:30', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '16:13', end: '16:30' }],
      })),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-20', records: recs });
    const mergedOk = v.items.length === 1 && v.items[0].merged_count === 2;
    if (!mergedOk) fail += 1;
    console.log(`  ${mergedOk ? '✔' : '✘'}  同模块不同措辞合并为 1 条（实际 ${v.items.length} 条）`);
    const startOk = v.items[0] && v.items[0].start_time === '14:58';
    if (!startOk) fail += 1;
    console.log(`  ${startOk ? '✔' : '✘'}  开始时间取最早（实际 ${v.items[0] && v.items[0].start_time}，期望 14:58）`);
    const shared = SE.sharedTokens('在系统管理需要添加二级菜单：邮箱配置', '在邮件管理中需要提供是否开启邮箱服务');
    console.log(`      佐证：两条共同词仅 ${shared.length} 个（${shared.join('、') || '无'}）—— 靠模块而非措辞判断`);
  }

  // ② 同项目但不同模块 → 不合并
  {
    const recs = [
      mk(Object.assign({}, P, {
        id: 'N1', content: '在系统管理需要添加二级菜单：邮箱配置', work_type: null,
        start_time: '09:00', end_time: '09:30', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '09:00', end: '09:30' }],
      })),
      mk(Object.assign({}, P, {
        id: 'N2', content: '5.2 实体关系下的内容显示 Syntax error', work_type: null,
        start_time: '11:00', end_time: '11:30', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '11:00', end: '11:30' }],
      })),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-20', records: recs });
    const ok = v.items.length === 2;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  不同模块不合并（实际 ${v.items.length} 条）`);
  }

  // ③ 不同项目即使同模块也不合并
  {
    const recs = [
      mk(Object.assign({ project_name: '云浮门户', project_confidence: 'high' }, {
        id: 'P1', content: '邮箱配置需要支持测试发送', work_type: null,
        start_time: '09:00', end_time: '09:30', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '09:00', end: '09:30' }],
      })),
      mk(Object.assign({ project_name: '气象数据', project_confidence: 'high' }, {
        id: 'P2', content: '邮箱服务的开启开关', work_type: null,
        start_time: '10:00', end_time: '10:30', status: 'completed', source: 'manual', confidence: 'high',
        time_segments: [{ start: '10:00', end: '10:30' }],
      })),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-20', records: recs });
    const ok = v.items.length === 2;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  不同项目不合并（实际 ${v.items.length} 条）`);
  }

  // ④ 模块别名归并
  {
    const cases = [
      ['在系统管理添加二级菜单：邮箱配置', '邮件与邮箱配置'],
      ['邮件管理中提供是否开启邮箱服务', '邮件与邮箱配置'],
      ['实验中心的权限配置', '权限与中心管理'],
      ['课程中心以 Figma 设计稿为准', '权限与中心管理'],
    ];
    for (const [text, expect] of cases) {
      const got = SE.extractModule(text).module;
      const ok = got === expect;
      if (!ok) fail += 1;
      console.log(`  ${ok ? '✔' : '✘'}  别名归并 ${JSON.stringify(text).slice(0, 26)} → ${got}（期望 ${expect}）`);
    }
  }

  // ⑤ groupByModule：分组 + 最早时间
  {
    const items = [
      { id: 'g1', content: '邮箱配置的测试发送', project_name: '气象数据', time: '16:13' },
      { id: 'g2', content: '邮件管理的开启开关', project_name: '气象数据', time: '14:58' },
      { id: 'g3', content: '无关内容甲乙', project_name: '气象数据', time: '12:00' },
    ];
    const gs = SE.groupByModule(items);
    const mail = gs.find((g) => g.module === '邮件与邮箱配置');
    const ok1 = Boolean(mail) && mail.count === 2 && mail.earliest_time === '14:58';
    if (!ok1) fail += 1;
    console.log(`  ${ok1 ? '✔' : '✘'}  同模块 2 条并组且最早时间为 14:58（实际 ${mail ? mail.count + ' 条 / ' + mail.earliest_time : '未成组'}）`);
    const ok2 = gs.length === 2;
    if (!ok2) fail += 1;
    console.log(`  ${ok2 ? '✔' : '✘'}  无模块条目独立成组（共 ${gs.length} 组）`);
  }
}

console.log();
console.log('=== 同会话上下文归并与硬边界（V3.13） ===');
{
  const C0 = require(path.join(__dirname, 'lib', 'log-core.js'));
  const mk = (o) => C0.normalizeItem(Object.assign({ date: '2026-09-23', tags: [], notes: '' }, o));

  // 同会话短回复 + 明确对象：应合并，主时间取最早，内容不能取“怎么解决”
  {
    const recs = [
      mk({
        id: 'CTX1', content: '怎么解决', work_type: '方案设计', category: '工作',
        start_time: '16:37', end_time: '16:45', status: 'completed', source: 'manual',
        confidence: 'high', conversation_id: 'CON-CTX', time_segments: [{ start: '16:37', end: '16:45' }],
      }),
      mk({
        id: 'CTX2', content: '项目级写细则，用户级写总纲', work_type: '方案设计', category: '工作',
        start_time: '16:52', end_time: '17:00', status: 'completed', source: 'manual',
        confidence: 'high', conversation_id: 'CON-CTX', time_segments: [{ start: '16:52', end: '17:00' }],
      }),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-23', records: recs });
    const item = v.items[0] || {};
    const okCount = v.items.length === 1 && item.merged_count === 2;
    const okStart = item.start_time === '16:37';
    const okContent = item.content !== '怎么解决' && /细则/.test(item.content);
    const okEvidence = Array.isArray(item.merge_evidence) && item.merge_evidence.some((x) => /上下文续接/.test(x));
    if (!okCount) fail += 1;
    if (!okStart) fail += 1;
    if (!okContent) fail += 1;
    if (!okEvidence) fail += 1;
    console.log(`  ${okCount ? '✔' : '✘'}  同会话短回复合并为 1 条（实际 ${v.items.length} 条）`);
    console.log(`  ${okStart ? '✔' : '✘'}  合并后主时间取最早（实际 ${item.start_time}，期望 16:37）`);
    console.log(`  ${okContent ? '✔' : '✘'}  合并内容不采用无信息短句（实际 ${item.content}）`);
    console.log(`  ${okEvidence ? '✔' : '✘'}  保留上下文合并证据（实际 ${JSON.stringify(item.merge_evidence)}）`);
  }

  // 同会话但项目冲突：不得合并
  {
    const recs = [
      mk({
        id: 'PROJ1', content: '邮箱配置需求梳理', work_type: '需求梳理', category: '工作',
        project_name: '云浮门户', start_time: '09:00', end_time: '09:30', status: 'completed',
        source: 'manual', confidence: 'high', conversation_id: 'CON-SWITCH',
        time_segments: [{ start: '09:00', end: '09:30' }],
      }),
      mk({
        id: 'PROJ2', content: '邮箱服务开关调整', work_type: '需求梳理', category: '工作',
        project_name: '气象数据', start_time: '09:35', end_time: '10:00', status: 'completed',
        source: 'manual', confidence: 'high', conversation_id: 'CON-SWITCH',
        time_segments: [{ start: '09:35', end: '10:00' }],
      }),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-23', records: recs });
    const ok = v.items.length === 2;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  同会话但已确认项目冲突时不合并（实际 ${v.items.length} 条）`);
  }

  // 跨会话但同一工作对象、同类型且内容强相关：允许合并
  {
    const recs = [
      mk({
        id: 'WT1', content: '修复 work-time-tracking 自动跨日问题', work_type: '开发',
        category: '工作', start_time: '11:00', end_time: '11:10', status: 'completed',
        source: 'manual', confidence: 'high', time_segments: [{ start: '11:00', end: '11:10' }],
      }),
      mk({
        id: 'WT2', content: '排查 work-time-tracking 活动未记录原因', work_type: '开发',
        category: '工作', start_time: '11:35', end_time: '11:45', status: 'completed',
        source: 'manual', confidence: 'high', time_segments: [{ start: '11:35', end: '11:45' }],
      }),
    ];
    const v = SE.buildSummaryView({ date: '2026-09-23', records: recs });
    const ok = v.items.length === 1 && v.items[0].start_time === '11:00';
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  跨会话同一工作对象强相关可合并（实际 ${v.items.length} 条 / 首时间 ${v.items[0] && v.items[0].start_time}）`);
  }

  // 无时间记录不得因排序被误当最早时间
  {
    const recs = [
      mk({
        id: 'NT1', content: '整理客户材料', work_type: '文档整理', category: '工作',
        start_time: null, end_time: null, status: 'completed', source: 'other', confidence: 'high',
      }),
      mk({
        id: 'NT2', content: '整理客户材料补充说明', work_type: '文档整理', category: '工作',
        start_time: '13:00', end_time: '13:20', status: 'completed', source: 'manual',
        confidence: 'high', time_segments: [{ start: '13:00', end: '13:20' }],
      }),
    ];
    const m = SE.mergeGroup(recs, 18 * 60);
    const ok = m.start_time === '13:00';
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  无时间记录不抢占最早开始时间（实际 ${m.start_time}）`);
  }
}

console.log();
console.log('=== 合并透明度与时间线口径（回归：总结不得错位） ===');
{
  const C0 = require(path.join(__dirname, 'lib', 'log-core.js'));
  const mk = (o) => C0.normalizeItem(Object.assign({ date: '2026-09-20', tags: [], notes: '' }, o));
  const P = { project_name: '每日工作记录 skill', project_confidence: 'high' };
  const labelOf = (rec) => (rec && (rec.display_title || rec.content)) || '（未命名）';

  // 真实缺陷现场：4 条原始记录，其中 2 条同模块同项目应合并为 1 条 → 合并后 3 条
  const recs = [
    mk(Object.assign({}, P, {
      id: 'R1', content: '排查修复 Hook 超时', work_type: '问题排查',
      start_time: '11:35', end_time: '11:42', status: 'completed', source: 'workbuddy', confidence: 'high',
      time_segments: [{ start: '11:35', end: '11:42' }],
    })),
    mk(Object.assign({}, P, {
      id: 'R2', content: '时间字段保留逻辑修复', work_type: '开发',
      start_time: '11:42', end_time: '12:00', status: 'completed', source: 'workbuddy', confidence: 'high',
      time_segments: [{ start: '11:42', end: '12:00' }],
    })),
    mk(Object.assign({}, P, {
      id: 'R3', content: '时间字段留存与重新总结记录', work_type: '开发',
      start_time: '11:42', end_time: '12:00', status: 'completed', source: 'workbuddy', confidence: 'high',
      time_segments: [{ start: '11:42', end: '12:00' }],
    })),
    mk(Object.assign({}, P, {
      id: 'R4', content: '实现 taskId 回写字段', work_type: '开发',
      start_time: '12:01', end_time: '12:33', status: 'completed', source: 'workbuddy', confidence: 'high',
      time_segments: [{ start: '12:01', end: '12:33' }],
    })),
  ];
  const log = { date: '2026-09-20', records: recs };
  const v = SE.buildSummaryView(log);
  const items = v.items;

  // ① merged_titles：合并项必须记录各来源标题（否则合并后无法回溯）
  {
    const m = SE.mergeGroup([recs[1], recs[2]], 12 * 60 + 30);
    const okArr = Array.isArray(m.merged_titles);
    const okSame = okArr && m.merged_titles.length === 2
      && m.merged_titles.includes('时间字段保留逻辑修复')
      && m.merged_titles.includes('时间字段留存与重新总结记录');
    if (!okArr) fail += 1;
    if (!okSame) fail += 1;
    console.log(`  ${okArr ? '✔' : '✘'}  mergeGroup 产出 merged_titles 数组（实际 ${okArr ? '有' : '无'}）`);
    console.log(`  ${okSame ? '✔' : '✘'}  merged_titles 逐条对应来源内容（实际 ${okArr ? JSON.stringify(m.merged_titles) : '无'}）`);
    const okFrom = Array.isArray(m.merged_from) && m.merged_from.length === 2;
    if (!okFrom) fail += 1;
    console.log(`  ${okFrom ? '✔' : '✘'}  merged_from 同步记录来源 id（实际 ${okFrom ? JSON.stringify(m.merged_from) : '无'}）`);
  }

  // ② 合并项在「工作事项」中必须显式标注来源条数
  {
    const merged = items.find((r) => r.merged_count > 1);
    const ok = Boolean(merged);
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  存在合并项（实际合并为 ${items.length} 条；原始 ${recs.length} 条）`);
    if (ok) {
      const okTags = Array.isArray(merged.merged_titles) && merged.merged_titles.length === merged.merged_count;
      if (!okTags) fail += 1;
      console.log(`  ${okTags ? '✔' : '✘'}  合并项可展示「← 合并 N 条：…」（N=${merged.merged_count}，来源 ${merged.merged_titles ? merged.merged_titles.length : 0} 条）`);
    }
  }

  // ③ 时间线必须与「工作事项」同口径：传入 recordsOverride 后行数 == 合并后条目数
  {
    const tlMerged = C0.timeline(log, labelOf, items);
    const okCount = tlMerged.length === items.length;
    if (!okCount) fail += 1;
    console.log(`  ${okCount ? '✔' : '✘'}  时间线行数随 recordsOverride 收敛（实际 ${tlMerged.length} 行，合并后 ${items.length} 条）`);

    const tlRaw = C0.timeline(log, labelOf);
    const okRaw = tlRaw.length === recs.length;
    if (!okRaw) fail += 1;
    console.log(`  ${okRaw ? '✔' : '✘'}  不传 recordsOverride 时按原始记录渲染（实际 ${tlRaw.length} 行，原始 ${recs.length} 条）`);

    const okDiff = tlMerged.length !== tlRaw.length;
    if (!okDiff) fail += 1;
    console.log(`  ${okDiff ? '✔' : '✘'}  两种口径确有差异，错位可被检出（${tlRaw.length} vs ${tlMerged.length}）`);
  }

  // ④ 实际缺陷：若「工作事项」用合并后、时间线用原始，则行数必然错位
  {
    const mismatched = items.length !== C0.timeline(log, labelOf).length;
    const ok = mismatched === true;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  修复前口径错位可复现（${items.length} 条 vs ${C0.timeline(log, labelOf).length} 行）`);
    const fixed = items.length === C0.timeline(log, labelOf, items).length;
    if (!fixed) fail += 1;
    console.log(`  ${fixed ? '✔' : '✘'}  传 recordsOverride 后口径一致`);
  }

  // ⑤ 合并项在时间线中带合并标记
  {
    const tlMerged = C0.timeline(log, labelOf, items);
    const marked = tlMerged.filter((line) => /合并 \d+ 条/.test(line));
    const mergedCount = items.filter((r) => r.merged_count > 1).length;
    const ok = marked.length === mergedCount;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  时间线为合并项标注条数（${marked.length} 行 / 应 ${mergedCount} 行）`);
  }
}

console.log();
console.log('=== 输出格式：【项目名称】【功能/模块名称】事项内容 ===');
{
  const cases = [
    // [内容, 项目, 期望标题]
    [
      '在系统管理需要添加二级菜单：邮箱配置，该页面主要是配置系统发件箱的授权信息',
      '气象数据',
      '【气象数据】【邮件与邮箱配置】邮件与邮箱配置更新',
    ],
    [
      '1、系统配置页面system/config.html中，所有配置项的单位在输入框右侧，不要换行；',
      '气象数据',
      '【气象数据】【系统配置】系统配置',
    ],
    [
      '根据前期这个简单的需求说明文档以及已有的原型，梳理出该系统的需求说明书',
      '云浮门户',
      '【云浮门户】【需求文档】需求文档梳理',
    ],
    [
      '5.2 实体关系下的内容好像有点奇怪，怎么显示了Syntax error in text？',
      '云浮门户',
      '【云浮门户】【实体关系】实体关系问题排查',
    ],
    [
      'index.html页面上方存在很大的空白',
      '云浮门户',
      '【云浮门户】index.html页面上方存在很大的空白',
    ],
  ];
  for (const [content, project, expect] of cases) {
    const got = SE.buildItemTitle({ content, project_name: project }).title;
    const okc = got === expect;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  ${got}${okc ? '' : '   期望 ' + expect}`);
  }

  // 拼接不得重复
  const noDup = [
    ['系统配置配置', SE.joinModuleAction('系统配置', '配置')],
    ['需求文档需求梳理', SE.joinModuleAction('需求文档', '需求梳理')],
    ['方案编写梳理', SE.joinModuleAction('方案编写', '梳理')],
  ];
  for (const [bad, got] of noDup) {
    const okc = got !== bad;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  不产生「${bad}」（实际 ${got}）`);
  }

  // 无项目时不编造项目名（不出现「其他工作」），模块仍显示
  const noProj = SE.buildItemTitle({ content: '邮箱配置的测试发送' }).title;
  const okProj = !noProj.includes('其他工作') && !noProj.includes('未分类') && noProj.startsWith('【');
  if (!okProj) fail += 1;
  console.log(`  ${okProj ? '✔' : '✘'}  无项目/无模块时不编造标签（${noProj}）`);

  // 模块识别不到 → 不显示模块块（用户要求）
  const noModule = [
    ['index.html页面上方存在很大的空白', '云浮门户', '【云浮门户】index.html页面上方存在很大的空白'],
    ['累计实验参与人次', '云浮门户', '【云浮门户】累计实验参与人次'],
    ['散步', '运动计划', '【运动计划】散步'],
  ];
  for (const [content, project, expect] of noModule) {
    const got = SE.buildItemTitle({ content, project_name: project }).title;
    const okc = got === expect;
    if (!okc) fail += 1;
    console.log(`  ${okc ? '✔' : '✘'}  无模块不显示该块：${got}${okc ? '' : '   期望 ' + expect}`);
  }
}

console.log();
console.log(fail === 0 ? '✓ 全部通过' : `✗ 存在 ${fail} 处偏差`);
process.exit(fail === 0 ? 0 : 1);
