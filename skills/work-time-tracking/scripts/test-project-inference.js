#!/usr/bin/env node
'use strict';
/**
 * test-project-inference.js — 项目推导回归测试（零依赖、内置）。
 *
 * 设计原则（用户明确要求）：
 *   **以宿主「已新建的项目」为准**，不解析对话内容推断项目名。
 *
 * 本测试用注入的 hostProjects 模拟宿主清单，验证：
 *   1 project_map（正式名称）最长前缀匹配
 *   2 命中宿主已建项目 → 用项目目录名，high
 *   3 未登记的 cwd → null（不猜）
 *   4 无意义目录段被跳过；盘符/时间戳/系统目录不得成为项目名
 *
 *   node scripts/test-project-inference.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。**不写任何日志**。
 */

const path = require('path');
const C = require(path.join(__dirname, 'lib', 'log-core.js'));

let fail = 0;

/** 模拟宿主已建项目清单 */
const HOST = {
  paths: [
    'E:/work/项目文档/云浮门户2609',
    'E:/work/项目文档/中大气象',
    'E:/work/项目文档/粤企知/第三期/1-需求管理',
    'D:/codex/2026-09-20/system-config-html',
  ],
  bySource: {},
};

const MAP_CFG = {
  project_map: {
    'E:/work/项目文档/云浮门户2609': '云浮门户系统',
    'E:/work/项目文档/中大气象': '中大气象系统',
  },
};

const emptyCfg = {};

function check(desc, cwd, config, expectName, expectConf, expectSource) {
  const r = C.projectFromCwd(cwd, { config: config || {}, hostProjects: HOST });
  const ok =
    r.project_name === expectName &&
    r.project_confidence === expectConf &&
    (expectSource === undefined || r.source === expectSource);
  if (!ok) fail += 1;
  console.log(
    `  ${ok ? '✔' : '✘'}  ${desc}\n` +
      `       ${JSON.stringify(cwd)}  →  ${JSON.stringify(r.project_name)} [${r.project_confidence}] (${r.source})`
  );
  if (!ok) console.log(`        期望 ${JSON.stringify(expectName)} [${expectConf}] ${expectSource || ''}`);
}

console.log('=== ① project_map 正式名称（最长前缀匹配） ===');
check('精确命中', 'E:/work/项目文档/云浮门户2609', MAP_CFG, '云浮门户系统', 'high', 'project_map');
check('子目录命中', 'E:/work/项目文档/云浮门户2609/src', MAP_CFG, '云浮门户系统', 'high', 'project_map');
check('深层子目录命中', 'E:/work/项目文档/云浮门户2609/原型/views', MAP_CFG, '云浮门户系统', 'high', 'project_map');
check('反斜杠写法', 'E:\\work\\项目文档\\中大气象\\docs', MAP_CFG, '中大气象系统', 'high', 'project_map');

console.log();
console.log('=== ② 命中宿主已建项目（无映射时用目录名） ===');
check('宿主项目', 'E:/work/项目文档/云浮门户2609', emptyCfg, '云浮门户2609', 'high', 'host_project');
check('宿主项目子目录', 'E:/work/项目文档/中大气象/数据', emptyCfg, '中大气象', 'high', 'host_project');
check('宿主深层项目（取根目录下一段）', 'E:/work/项目文档/粤企知/第三期/1-需求管理', emptyCfg, '粤企知', 'high', 'host_project');
check('D 盘宿主项目', 'D:/codex/2026-09-20/system-config-html', emptyCfg, 'system-config-html', 'high', 'host_project');

console.log();
console.log('=== ③ 未登记的 cwd → 不猜（返回 null） ===');
check('未登记目录', 'E:/work/项目文档/其他项目', emptyCfg, null, null, 'cwd_unregistered');
check('WorkBuddy 时间戳工作区', '<USER_HOME>/WorkBuddy/2026-09-20-10-24-52', emptyCfg, null, null, 'cwd_unregistered');
check('纯数字目录', 'D:/data/12345678', emptyCfg, null, null, 'cwd_unregistered');
check('空 cwd', '', emptyCfg, null, null, 'none');
check('undefined cwd', undefined, emptyCfg, null, null, 'none');

console.log();
console.log('=== ④ 大小写不敏感（Windows 路径） ===');
check('小写盘符', 'e:/work/项目文档/云浮门户2609', MAP_CFG, '云浮门户系统', 'high', 'project_map');
check('小写盘符 + 宿主项目', 'e:/work/项目文档/中大气象', emptyCfg, '中大气象', 'high', 'host_project');
check('全大写目录段', 'E:/WORK/项目文档/云浮门户2609', MAP_CFG, '云浮门户系统', 'high', 'project_map');

console.log();
console.log('=== ⑤ 项目名取「通用根目录」的下一段 ===');
{
  const cases = [
    ['E:/work/项目文档/粤企知/第三期/1-需求管理', '粤企知'],
    ['E:/work/项目文档/数字国资/基金金融/8-验收材料/政数局/202609', '数字国资'],
    ['E:/work/项目文档/SCUT/1-项目管理/5-项目周报', 'SCUT'],
    ['E:/work/招投标事宜/异构算力', '招投标事宜'],
  ];
  for (const [dir, expect] of cases) {
    const got = C.projectNameFromDir(dir);
    const ok = got === expect;
    if (!ok) fail += 1;
    console.log(`  ${ok ? '✔' : '✘'}  ${dir}\n       → ${JSON.stringify(got)}  期望 ${JSON.stringify(expect)}`);
  }
}

console.log();
console.log('=== ⑥ 边界：前缀相似但非子目录 ===');
check('26090 不应命中 2609', 'E:/work/项目文档/云浮门户26090', emptyCfg, null, null, 'cwd_unregistered');

console.log();
console.log(fail === 0 ? '✓ 全部通过' : `✗ 存在 ${fail} 处偏差`);
process.exit(fail === 0 ? 0 : 1);
