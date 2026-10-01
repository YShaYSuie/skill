#!/usr/bin/env node
'use strict';
/**
 * test-skill-inventory.js — 本地 Skill 清单盘点回归测试（V3.6）。
 *
 * 用户 2026-09-24：「哪个 skill 我压根就用不上」——
 * 这需要把「本机装了什么」与「日志里用过什么」对账，而不是只统计用过的。
 *
 * 覆盖：
 *   ① frontmatter 解析（引号 / 缺失 / 损坏）
 *   ② 已安装 vs 已部署（central 只代表已安装）
 *   ③ 从未使用 / 陈旧 / 用过但清单里没有
 *   ④ 目录不存在时如实降级，不报错、不编造
 *   ⑤ `$skill-name` 与路径引用的识别（含 shell 变量防误报、同行去重）
 *
 *   node scripts/test-skill-inventory.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。测试全程在临时沙箱目录内，不动真实日志。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SI = require(path.join(__dirname, 'lib', 'skill-inventory.js'));

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-skill-inv-'));
const makeSkill = (root, dir, frontmatter) => {
  const p = path.join(root, dir);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(
    path.join(p, 'SKILL.md'),
    frontmatter === null ? '# 没有 frontmatter\n' : `---\n${frontmatter}\n---\n\n# 正文\n`,
    'utf8'
  );
  return p;
};

const CENTRAL = path.join(sandbox, 'central');
const CODEX = path.join(sandbox, 'codex-dir');
const MISSING = path.join(sandbox, 'nope');

makeSkill(CENTRAL, 'alpha-skill', 'name: alpha-skill\nversion: "1.2"\ndescription: 甲技能');
makeSkill(CENTRAL, 'beta-skill', 'name: beta-skill\ndescription: "带引号的乙技能"');
makeSkill(CENTRAL, 'broken-skill', null);
// P0-1 夹具：目录名/name 是英文 id，display_name 是中文 —— 用于验证别名归一化
makeSkill(
  CENTRAL,
  'web-design-engineer',
  'name: web-design-engineer\ndisplay_name: 网页设计工程师\nversion: "2.1.0"'
);
makeSkill(CODEX, 'alpha-skill', 'name: alpha-skill'); // 同名部署 → 合并为一条

console.log('1. frontmatter 解析');
check('解析 name / version / description', () => {
  const r = SI.parseFrontmatter('---\nname: x\ndescription: "有 空格 的描述"\n---\n正文');
  assert(r.name === 'x', `name 应为 x，实际 ${r.name}`);
  assert(r.description === '有 空格 的描述', `description 解析错误：${r.description}`);
});
check('没有 frontmatter 时返回空值而不是抛错', () => {
  const r = SI.parseFrontmatter('# 只有正文');
  assert(r.name === null && r.description === null, '应全部为 null');
});
check('只认 name / version / description，忽略其它字段', () => {
  const r = SI.parseFrontmatter('---\nname: y\ntools: 随便写\n---\n');
  assert(r.name === 'y', 'name 未取到');
});

console.log('\n2. 扫描：已安装 vs 已部署');
const inv = SI.scan([
  { label: 'central', path: CENTRAL },
  { label: 'codex', path: CODEX },
  { label: 'missing-agent', path: MISSING },
]);
check('目录不存在时如实标注 exists=false，不抛错', () => {
  const m = inv.roots.find((r) => r.label === 'missing-agent');
  assert(m && m.exists === false, 'missing-agent 应为 exists=false');
});
check('同名 Skill 跨目录合并为一条并记录部署位置', () => {
  const rows = inv.skills.filter((s) => s.skill_id === 'alpha-skill');
  assert(rows.length === 1, `alpha-skill 应合并为 1 条，实际 ${rows.length}`);
  assert(
    rows[0].deployed_in.includes('central') && rows[0].deployed_in.includes('codex'),
    `deployed_in 不完整：${rows[0].deployed_in.join('/')}`
  );
});
check('frontmatter 缺失时回落到目录名（不丢弃该 Skill）', () => {
  assert(
    inv.skills.some((s) => s.skill_id === 'broken-skill'),
    'broken-skill 应回落到目录名出现在清单里'
  );
});
check('version 缺失时为 null', () => {
  const beta = inv.skills.find((s) => s.skill_id === 'beta-skill');
  assert(beta && beta.version === null, 'beta-skill.version 应为 null');
});

console.log('\n3. 对账：从未使用 / 陈旧 / 用过但清单里没有');
const annotated = SI.annotate(inv, {
  usedSkillIds: ['alpha-skill', 'ghost-skill'],
  lastUsedAt: new Map([['alpha-skill', '2026-01-01T10:00:00+08:00']]),
  staleDays: 30,
  now: new Date('2026-09-24T12:00:00+08:00'),
});
check('从未使用 = 已安装 − 已使用', () => {
  const ids = annotated.never_used.map((x) => x.skill_id).sort();
  assert(ids.includes('beta-skill'), 'beta-skill 应出现在从未使用里');
  assert(!ids.includes('alpha-skill'), 'alpha-skill 用过，不应出现在从未使用里');
});
check('陈旧判定按 staleDays 计算天数', () => {
  const a = annotated.stale.find((x) => x.skill_id === 'alpha-skill');
  assert(a, 'alpha-skill 应因超过 30 天未用进入 stale');
  assert(a.days_since_last_use >= 260, `天数应为 260+，实际 ${a.days_since_last_use}`);
});
check('用过但清单里没有的 Skill 单独列出（不混进已安装）', () => {
  assert(
    annotated.used_not_installed.includes('ghost-skill'),
    `used_not_installed 应含 ghost-skill，实际 ${annotated.used_not_installed.join(',')}`
  );
  assert(
    !annotated.installed.some((x) => x.skill_id === 'ghost-skill'),
    'ghost-skill 不应出现在已安装里'
  );
});
check('只部署到 central 不算「已部署到某个 Agent」', () => {
  const beta = annotated.installed.find((x) => x.skill_id === 'beta-skill');
  assert(beta && beta.deployed === false, 'beta-skill 只在 central，deployed 应为 false');
  const alpha = annotated.installed.find((x) => x.skill_id === 'alpha-skill');
  assert(alpha && alpha.deployed === true, 'alpha-skill 同时部署到 codex，deployed 应为 true');
});
check('计数自洽：installed_count = used + never_used（不含清单外）', () => {
  assert(
    annotated.installed_count === annotated.used_count + annotated.never_used.length,
    `计数不自洽：${annotated.installed_count} ≠ ${annotated.used_count} + ${annotated.never_used.length}`
  );
});

console.log('\n4. 显式 Skill 引用识别');
const known = new Set(['alpha-skill', 'beta-skill', 'work-time-tracking']);
check('$skill-name 可识别', () => {
  const hits = SI.extractSkillRefs('帮我 $alpha-skill 一下', known);
  assert(hits.length === 1 && hits[0].skill_id === 'alpha-skill', JSON.stringify(hits));
});
check('路径引用可识别（skills/<name>/SKILL.md）', () => {
  const hits = SI.extractSkillRefs('见 skills/beta-skill/SKILL.md', known);
  assert(hits.length === 1 && hits[0].skill_id === 'beta-skill', JSON.stringify(hits));
});
check('shell 变量不得被误判（$PATH / $HOME / $env）', () => {
  assert(SI.extractSkillRefs('echo $PATH $HOME $env', known).length === 0, '不应有命中');
});
check('同一行重复引用只算一次，跨行分别计数', () => {
  const hits = SI.extractSkillRefs('$alpha-skill 与 $alpha-skill\n再来 $alpha-skill', known);
  assert(hits.length === 2, `应识别 2 次引用，实际 ${hits.length}`);
});
check('未安装的名字不识别（宁可漏报也不误报）', () => {
  assert(SI.extractSkillRefs('$not-installed-skill', known).length === 0, '不应命中');
});
check('空输入不抛错', () => {
  assert(SI.extractSkillRefs('', known).length === 0, '空串应返回空数组');
  assert(SI.extractSkillRefs(null, known).length === 0, 'null 应返回空数组');
});

console.log('\n4b. SKILL.md 载入识别（V3.22）');
check('Windows 反斜杠路径的 SKILL.md 载入可识别', () => {
  const hits = SI.extractSkillMdLoads(
    "Get-Content -LiteralPath 'C:\\Users\\User\\.skills-manager\\skills\\alpha-skill\\SKILL.md'",
    known
  );
  assert(hits.length === 1 && hits[0].skill_id === 'alpha-skill', JSON.stringify(hits));
});
check('正斜杠路径同样可识别', () => {
  const hits = SI.extractSkillMdLoads('Read skills/beta-skill/SKILL.md now', known);
  assert(hits.length === 1 && hits[0].skill_id === 'beta-skill', JSON.stringify(hits));
});
check('JSON 转义后的双反斜杠路径同样可识别（工具调用参数的真实形态）', () => {
  const args = JSON.stringify({
    cmd: "Get-Content -LiteralPath 'C:\\Users\\User\\.skills-manager\\skills\\alpha-skill\\SKILL.md' -Encoding UTF8",
  });
  const hits = SI.extractSkillMdLoads(args, known);
  assert(hits.length === 1 && hits[0].skill_id === 'alpha-skill', JSON.stringify(hits));
});
check('技能目录下的其它文件不算载入（脚本 ≠ 技能定义）', () => {
  const hits = SI.extractSkillMdLoads(
    "node 'C:\\x\\skills\\alpha-skill\\scripts\\run.js' --go",
    known
  );
  assert(hits.length === 0, `不应命中，实际 ${JSON.stringify(hits)}`);
});
check('未安装的名字不识别', () => {
  assert(SI.extractSkillMdLoads('skills/not-installed/SKILL.md', known).length === 0, '不应命中');
});
check('同一行同一 Skill 只算一次，跨行分别计数', () => {
  const hits = SI.extractSkillMdLoads(
    "skills/alpha-skill/SKILL.md\nskills/alpha-skill/SKILL.md",
    known
  );
  assert(hits.length === 2, `跨行应算 2 次，实际 ${hits.length}`);
});

console.log('\n5. 只读性');
check('扫描不写入任何文件', () => {
  const before = fs.readdirSync(CENTRAL).sort().join(',');
  SI.scan([{ label: 'central', path: CENTRAL }]);
  const after = fs.readdirSync(CENTRAL).sort().join(',');
  assert(before === after, '目录内容发生变化');
});

console.log('\n6. skill_id 归一化（P0-1）');
check('frontmatter 读出 display_name', () => {
  const md = '---\nname: web-design-engineer\ndisplay_name: 网页设计工程师\n---\n正文';
  const meta = SI.parseFrontmatter(md);
  assert(meta.name === 'web-design-engineer', `name 应为英文 id，实际 ${meta.name}`);
  assert(meta.display_name === '网页设计工程师', `display_name 应被读出，实际 ${meta.display_name}`);
});
check('display_name 不覆盖 name（id 仍取英文）', () => {
  const md = '---\nname: some-skill\ndisplay_name: 某个技能\n---\n';
  const meta = SI.parseFrontmatter(md);
  assert(meta.name === 'some-skill', 'name 不得被 display_name 顶替');
});
check('别名表把中文显示名映射到英文 id', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  const zh = inv.aliasToId.get('网页设计工程师');
  assert(zh === 'web-design-engineer', `中文名应映射到英文 id，实际 ${zh}`);
});
check('resolveSkillId：中文显示名 → 英文 id', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  const got = SI.resolveSkillId('网页设计工程师', inv);
  assert(got === 'web-design-engineer', `实际 ${got}`);
});
check('resolveSkillId：英文 id 原样返回', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  assert(SI.resolveSkillId('alpha-skill', inv) === 'alpha-skill', '英文 id 不应被改动');
});
check('resolveSkillId：大小写变体归一', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  assert(SI.resolveSkillId('ALPHA-SKILL', inv) === 'alpha-skill', '应归一到 canonical 大小写');
});
check('resolveSkillId：未知名字不臆造，原样返回', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  const got = SI.resolveSkillId('从未安装过的技能', inv);
  assert(got === '从未安装过的技能', `未命中应原样返回，实际 ${got}`);
});
check('resolveSkillId：空值安全', () => {
  assert(SI.resolveSkillId('', null) === '', '空串应返回空串');
  assert(SI.resolveSkillId(null, null) === '', 'null 应返回空串');
});
check('同一 Skill 只产生一个 id（中英文不分裂）', () => {
  const inv = SI.scan([{ label: 'central', path: CENTRAL }]);
  const a = SI.resolveSkillId('网页设计工程师', inv);
  const b = SI.resolveSkillId('web-design-engineer', inv);
  assert(a === b, `同一 Skill 的两个名字应归一到同一个 id：${a} vs ${b}`);
});
check('别名冲突被记录而非静默择一', () => {
  // 两个 Skill 声明同一 display_name：应记录冲突，保留先到的
  const dir = path.join(sandbox, 'conflict');
  for (const [folder, disp] of [['skill-a', '同名技能'], ['skill-b', '同名技能']]) {
    const abs = path.join(dir, folder);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'SKILL.md'), `---\nname: ${folder}\ndisplay_name: ${disp}\n---\n`);
  }
  const inv = SI.scan([{ label: 'central', path: dir }]);
  assert(inv.aliasConflicts.length >= 1, '应记录至少一条别名冲突');
  assert(inv.aliasToId.get('同名技能') === 'skill-a', '冲突时应保留先到的');
});

try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (e) {
  /* 清理失败不影响结论 */
}

console.log(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed ? 1 : 0);
