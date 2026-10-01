#!/usr/bin/env node
'use strict';
/**
 * test-role-profile.js — 角色画像（PM 视角总结）回归测试。
 *
 * 覆盖 2026-09-21 新增的 `lib/role-profile.js`：
 *   1. 配置归一化与默认画像（产品经理）
 *   2. 角色相关性判定（项目工作 vs 探索/学习/生活）
 *   3. 需求阶段识别（需求分析 / 方案设计 / 评审对齐 / 跟进落地）
 *   4. 交付物识别，重点是**防误判**（原型交付物 vs 原型项目名）
 *   5. 工具建设与产品工作的分离（不虚增 PM 交付物）
 *   6. 按产品线汇总
 *   7. 渲染输出（无产品工作时不打印空壳块）
 *   8. 幂等与只读性（不修改输入）
 *
 * 纯本地规则，零网络、零 Token，不触碰 LOG_ROOT。
 *
 *   node scripts/test-role-profile.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。
 */

const path = require('path');
const RP = require('./lib/role-profile.js');
const C = require('./lib/log-core.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✔  ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘  ${name}${detail ? '    ' + detail : ''}`);
  }
}

const role = RP.normalizeRole({});

/* ------------------------------------------------------------------ *
 * 1. 默认画像与归一化
 * ------------------------------------------------------------------ */
console.log('=== 1. 默认画像与配置归一化 ===');
{
  ok('默认角色是产品经理', role.title === '产品经理');
  ok('默认启用', role.enabled === true);
  ok('默认四个需求阶段', role.stages.length === 4, JSON.stringify(role.stages));
  ok('默认包含交付物词表', role.deliverables.length > 0);
  ok('默认关注三项', role.focus.length === 3, JSON.stringify(role.focus));
  ok('product_lines 默认空（表示用记录里的项目名）', Array.isArray(role.product_lines) && role.product_lines.length === 0);

  ok('可整体关闭', RP.normalizeRole({ enabled: false }).enabled === false);
  ok('可自定义角色名', RP.normalizeRole({ title: '产品负责人' }).title === '产品负责人');
  // 词表为空数组时必须回落默认，否则用户误删一个字段会导致识别全失效
  ok('stages 空数组回落默认', RP.normalizeRole({ stages: [] }).stages.length === 4);
  ok('deliverables 空数组回落默认', RP.normalizeRole({ deliverables: [] }).deliverables.length > 0);
  // product_lines 留空是**有意义**的默认，不能回落
  ok('product_lines 留空保持为空', RP.normalizeRole({ product_lines: [] }).product_lines.length === 0);
  ok('可自定义阶段词表', RP.normalizeRole({ stages: ['售前', '交付'] }).stages.join() === '售前,交付');
  ok('非对象输入回落默认', RP.normalizeRole(null).title === '产品经理');
  ok('数组输入回落默认', RP.normalizeRole([]).title === '产品经理');
}

/* ------------------------------------------------------------------ *
 * 2. 角色相关性
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 2. 角色相关性判定 ===');
{
  ok('有项目名 → 角色相关', RP.isRoleRelevant({ project_name: '云浮门户', content: 'x' }));
  ok('无项目但有工作类型 → 角色相关', RP.isRoleRelevant({ work_type: '需求分析', content: 'x' }));
  ok('工作类型为「其他」且无项目 → 非角色', !RP.isRoleRelevant({ work_type: '其他', content: 'x' }));
  ok('无项目无类型 → 非角色', !RP.isRoleRelevant({ content: '散步' }));
  ok('非角色判定与角色判定互斥', RP.isNonRole({ content: '散步' }) && !RP.isNonRole({ project_name: 'P' }));
  // 有项目时即使含「学习」字样也算角色相关（如「学习平台的需求分析」）
  ok(
    '项目工作含「学习」字样仍算角色相关',
    RP.isRoleRelevant({ project_name: '学习平台', content: '学习平台的需求分析' })
  );
}

/* ------------------------------------------------------------------ *
 * 3. 需求阶段识别
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 3. 需求阶段识别 ===');
{
  const cases = [
    ['梳理云浮门户需求说明书', '需求分析'],
    ['做竞品分析对比三家厂商', '需求分析'],
    ['设计设备管理页面的交互原型', '方案设计'],
    ['更新信息架构与模块划分', '方案设计'],
    ['参加需求评审会并对齐口径', '评审对齐'],
    ['与研发沟通排期', '评审对齐'],
    ['跟进上线进度并推动验收', '跟进落地'],
    ['排查线上缺陷并推动回归', '跟进落地'],
  ];
  cases.forEach(([content, want]) => {
    const got = RP.detectStage({ content }, role);
    ok(`「${content.slice(0, 16)}…」→ ${want}`, got === want, `实际 ${got}`);
  });
  ok('识别不出时返回 null（不硬套）', RP.detectStage({ content: '整理了一下桌面' }, role) === null);
  ok('空内容返回 null', RP.detectStage({}, role) === null);
  // 用户删掉的阶段不应再被识别
  ok(
    '画像里删除的阶段不再识别',
    RP.detectStage({ content: '参加需求评审会' }, RP.normalizeRole({ stages: ['跟进落地'] })) === null
  );
}

/* ------------------------------------------------------------------ *
 * 4. 交付物识别（防误判是重点）
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 4. 交付物识别（含防误判） ===');
{
  ok('识别「需求文档」', RP.detectDeliverables({ content: '输出云浮门户需求文档' }, role).includes('需求文档'));
  ok('识别「原型」（产出语境）', RP.detectDeliverables({ content: '完成设备管理页面的原型设计' }, role).includes('原型'));
  ok('识别「评审结论」', RP.detectDeliverables({ content: '整理需求评审结论' }, role).includes('评审结论'));
  ok('识别「竞品分析」', RP.detectDeliverables({ content: '做竞品分析' }, role).includes('竞品分析'));
  ok('识别「排期表」', RP.detectDeliverables({ content: '输出项目排期' }, role).includes('排期表'));

  // ⚠️ 防误判：项目/工具名里的「原型」不是交付物（真实踩到的 bug）
  ok(
    '「创建原型版本发布 skill」不算产出原型',
    !RP.detectDeliverables({ content: '创建原型版本发布 skill（版本管理 + GitHub Release）' }, role).includes('原型')
  );
  ok(
    '「原型项目部署脚本」不算产出原型',
    !RP.detectDeliverables({ content: '原型项目部署脚本改造' }, role).includes('原型')
  );
  ok('无交付物时返回空数组', RP.detectDeliverables({ content: '开了一天会' }, role).length === 0);
  ok('空对象返回空数组', RP.detectDeliverables({}, role).length === 0);

  // 一条事项可命中多个交付物
  const multi = RP.detectDeliverables({ content: '同时更新需求文档与原型设计' }, role);
  ok('一条事项可命中多个交付物', multi.includes('需求文档') && multi.includes('原型'), JSON.stringify(multi));
}

/* ------------------------------------------------------------------ *
 * 5. 工具建设与产品工作分离
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 5. 工具建设 vs 产品工作 ===');
{
  ok('含 skill 判为工具建设', RP.isTooling({ content: '创建原型版本发布 skill' }));
  ok('含 hook 判为工具建设', RP.isTooling({ content: '排查修复 Hook 超时' }));
  ok('工具项目名判为工具建设', RP.isToolingProject({ project_name: '每日工作记录 skill' }));
  ok('产品项目名不判为工具建设', !RP.isToolingProject({ project_name: '云浮门户' }));
  ok('普通产品事项不判为工具建设', !RP.isTooling({ content: '梳理云浮门户需求说明书' }));
}

/* ------------------------------------------------------------------ *
 * 6. 汇总视图
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 6. buildRoleView 汇总 ===');
{
  // 真实 PM 工作场景
  const items = [
    { id: 'a', project_name: '云浮门户', work_type: '需求分析', content: '梳理云浮门户需求说明书', actual_duration: 90 },
    { id: 'b', project_name: '云浮门户', work_type: '原型设计', content: '完成设备总览页面原型设计', actual_duration: 60 },
    { id: 'c', project_name: '数字国资', work_type: '沟通协调', content: '参加需求评审会与研发对齐', actual_duration: 30 },
    { id: 'd', project_name: null, work_type: null, content: '散步', actual_duration: 20 },
  ];
  const v = RP.buildRoleView(items, role);
  ok('返回视图对象', Boolean(v));
  ok('角色相关 3 项（排除散步）', v.role_relevant_count === 3, `实际 ${v.role_relevant_count}`);
  ok('产品工作 3 项', v.product_work_count === 3, `实际 ${v.product_work_count}`);
  ok('无工具建设', v.tooling_count === 0);
  ok('非角色 1 项（散步）', v.non_role_count === 1);
  ok('阶段含需求分析与方案设计', v.stages.some((s) => s.stage === '需求分析') && v.stages.some((s) => s.stage === '方案设计'));
  ok('阶段按画像顺序排列', v.stages[0].stage === '需求分析', `实际 ${v.stages[0].stage}`);
  ok('产品线两条', v.product_lines.length === 2, JSON.stringify(v.product_lines.map((p) => p.product_line)));
  ok('产品线按时长降序（云浮门户 150 分钟在前）', v.product_lines[0].product_line === '云浮门户');
  ok('交付物含需求文档与原型', v.deliverables.some((d) => d.deliverable === '需求文档') && v.deliverables.some((d) => d.deliverable === '原型'));

  // 工具建设场景（今日真实数据）
  const toolItems = [
    { id: 'x', project_name: '每日工作记录 skill', work_type: '开发', content: '实现 taskId 回写字段', actual_duration: 51 },
    { id: 'y', project_name: '原型版本发布 skill', work_type: '开发', content: '创建原型版本发布 skill', actual_duration: 33 },
  ];
  const tv = RP.buildRoleView(toolItems, role);
  ok('工具建设 2 项', tv.tooling_count === 2, `实际 ${tv.tooling_count}`);
  ok('产品工作 0 项', tv.product_work_count === 0);
  ok('产品线为空（工具项目不算产品线）', tv.product_lines.length === 0);
  ok('交付物为空（不虚增）', tv.deliverables.length === 0, JSON.stringify(tv.deliverables));

  // 只有日常活动（无项目、无工作类型）时**不再返回 null** ——
  // 用户明确「项目允许为空」，且运动等日常活动必须单列，不能被整块丢弃。
  // 视图只在「当天完全没有事项」时才为空。
  const onlyLife = [{ id: 'z', project_name: null, work_type: null, content: '散步' }];
  const lifeView = RP.buildRoleView(onlyLife, role);
  ok('只有日常活动时仍返回视图（不丢弃）', lifeView !== null);
  ok('日常活动计入 daily 桶', lifeView && lifeView.buckets.daily.count === 1);
  ok('日常活动不计入工时', lifeView && lifeView.work_minutes === 0);
  ok('无事项时才返回 null', RP.buildRoleView([], role) === null);
  ok('关闭画像时返回 null', RP.buildRoleView(items, RP.normalizeRole({ enabled: false })) === null);
}

/* ------------------------------------------------------------------ *
 * 7. 渲染输出
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 7. renderRoleView 渲染 ===');
{
  const items = [
    { project_name: '云浮门户', work_type: '需求分析', content: '梳理云浮门户需求说明书', actual_duration: 90 },
    { project_name: null, work_type: null, content: '散步', actual_duration: 20 },
  ];
  const text = RP.renderRoleView(RP.buildRoleView(items, role)).join('\n');
  ok('含「十、角色维度汇总」标题', text.includes('十、角色维度汇总'));
  ok('标题带角色名', text.includes('产品经理'));
  ok('含需求阶段分布块', text.includes('需求阶段分布'));
  ok('含按产品线汇总块', text.includes('按产品线汇总'));
  ok('含交付物产出块', text.includes('交付物产出'));
  ok('含日常活动单列块', text.includes('日常活动'));
  ok('日常活动块明确「不计入工时」', text.includes('不计入工时'));
  ok('日常活动块标出「散步」', text.includes('散步'));
  // 探索学习分桶的断言在 test-activity-classification.js（该夹具里没有此类事项）

  // 今日场景：无产品工作 → 不打印空壳块
  const toolItems = [{ project_name: '每日工作记录 skill', work_type: '开发', content: '实现字段', actual_duration: 51 }];
  const t2 = RP.renderRoleView(RP.buildRoleView(toolItems, role)).join('\n');
  ok('无产品工作时不打印「需求阶段分布」空块', !t2.includes('需求阶段分布'));
  ok('无产品工作时不打印「按产品线汇总」空块', !t2.includes('按产品线汇总'));
  ok('无产品工作仍保留交付物块并说明原因', t2.includes('交付物产出') && t2.includes('无产品工作'));
  ok('无产品工作单列工具建设', t2.includes('工具建设'));

  ok('空视图渲染为空数组', RP.renderRoleView(null).length === 0);
  ok('渲染结果无尾随空行', (() => {
    const L = RP.renderRoleView(RP.buildRoleView(items, role));
    return L.length > 0 && L[L.length - 1] !== '';
  })());
}

/* ------------------------------------------------------------------ *
 * 8. V3.24：显式分类、过程维护与能力变化
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 8. V3.24：显式分类、过程维护与能力变化 ===');
{
  const section = { exploration_projects: ['AI Skill 探索'], exploration_keywords: [] };
  ok(
    '显式「探索沉淀」优先于业务项目',
    RP.categoryOf(
      { category: '探索沉淀', project_name: '云浮门户', content: '调整日报结构' },
      section
    ) === '探索沉淀'
  );
  ok(
    '显式「工作」优先于 AI 项目',
    RP.categoryOf(
      { category: '工作', project_name: 'AI Skill 探索', content: '梳理需求' },
      section
    ) === '工作'
  );
  ok(
    '自动采集「查看日志」判为过程维护',
    RP.isOperationalSupport({ source: 'auto', content: '查看日志', project_name: '云浮门户' })
  );
  ok(
    '自动采集「修复网络问题」判为过程维护',
    RP.isOperationalSupport({ source: 'auto', content: '修复网络问题', project_name: '云浮门户' })
  );
  ok(
    '自动采集「自动化任务结果」判为过程维护',
    RP.isOperationalSupport({ source: 'auto', content: '自动化任务结果' })
  );
  ok(
    '手动记录不被维护规则吃掉',
    !RP.isOperationalSupport({ source: 'manual', content: '查看日志' })
  );

  const boardItems = [
    { category: '工作', project_name: '云浮门户', content: '梳理需求说明书', actual_duration: 60 },
    { source: 'auto', project_name: '云浮门户', content: '修复网络问题', actual_duration: 10 },
  ];
  const board = RP.groupWorkBoard(boardItems, role, section);
  ok('工作看板排除过程维护', board.item_count === 1, `实际 ${board.item_count}`);
  ok('工作看板保留维护计数', board.operational_count === 1);

  const exploration = RP.buildExplorationView(
    [
      {
        category: '探索沉淀',
        project_name: 'AI Skill 探索',
        content: '完善新能力',
        output: '新增工作成果视图',
      },
      { category: '探索沉淀', content: '修复 Hook 超时' },
    ],
    section
  );
  ok('探索沉淀识别新增能力', exploration.main.some((x) => x.change_type === '新增能力'));
  ok('探索沉淀折叠稳定性维护', exploration.maintenance_count === 1);

  const normalizedExploration = C.normalizeItem({
    category: '探索沉淀',
    content: '完善新能力',
    output: '新增工作成果视图',
    project_stage: '需求分析',
  });
  ok('探索沉淀允许保存 output', normalizedExploration.output === '新增工作成果视图');
  ok('探索沉淀仍清空项目阶段', normalizedExploration.project_stage === null);

  const normalizedLife = C.normalizeItem({
    category: '生活',
    content: '吃晚饭',
    output: '不应保留',
  });
  ok('生活事项仍清空 output', normalizedLife.output === null);
}

/* ------------------------------------------------------------------ *
 * 9. 只读性与确定性
 * ------------------------------------------------------------------ */
console.log();
console.log('=== 9. 只读性与确定性 ===');
{
  const items = [
    { id: 'a', project_name: '云浮门户', work_type: '需求分析', content: '梳理需求说明书', actual_duration: 90 },
  ];
  const snapshot = JSON.stringify(items);
  RP.buildRoleView(items, role);
  ok('不修改输入对象', JSON.stringify(items) === snapshot);

  const v1 = JSON.stringify(RP.buildRoleView(items, role));
  const v2 = JSON.stringify(RP.buildRoleView(items, role));
  ok('同一输入结果确定（可重复）', v1 === v2);
  ok('归一化幂等', JSON.stringify(RP.normalizeRole(RP.normalizeRole({}))) === JSON.stringify(role));
  ok('空数组不报错', RP.buildRoleView([], role) === null);
  ok('非数组不报错', RP.buildRoleView(null, role) === null);
}

console.log();
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ 存在 ${fail} 处偏差 / 共 ${pass + fail} 项`);
process.exit(fail === 0 ? 0 : 1);
