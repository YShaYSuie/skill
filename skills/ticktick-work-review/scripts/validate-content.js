#!/usr/bin/env node
'use strict';

/**
 * 校验 TickTick 任务备注（content）是否符合模板。
 * 归属：ticktick-work-review（同步逻辑侧），与 references/mcp-capabilities.md
 * 「content（备注）模板」一节同源，两者必须一起改。
 *
 * 用法：
 *   node scripts/validate-content.js --source ai|manual|manual_open|none --content "<文本>" \
 *        [--workitem-id WI-20260928-A8F2C1D3] [--json]
 *   node scripts/validate-content.js --selftest
 *
 * 退出码：
 *   0 = 通过（可能带 warning）
 *   1 = 有违规，必须按模板重写后再写入 / 回写
 *   2 = 参数或用法错误
 */

// manual_open = 手动录入、但结束时间未记录（V1.2 补：此前该情形无模板可依，
//   只能用 manual 但缺区间行 → 必然违规；写 none 又会谎称「时间未记录」——开始时刻是有的）
const SOURCES = ['ai', 'manual', 'manual_open', 'none'];

// 每种来源唯一允许的首行（none 无时间行）
const REQUIRED_LINE = {
  ai: /^开始时间：\d{1,2}:\d{2}$/,
  manual: /^实际时间：\d{1,2}:\d{2}-\d{1,2}:\d{2}$/,
  manual_open: /^开始时间：\d{1,2}:\d{2}$/,
  none: null,
};

// 允许的行数（时间行 + 来源行）
const EXPECTED_LINES = { ai: 2, manual: 2, manual_open: 2, none: 1 };

/** 供错误提示引用的模板样例 */
const TIME_LINE_EXAMPLE = {
  ai: '开始时间：11:30',
  manual: '实际时间：12:15-13:00',
  manual_open: '开始时间：11:30',
  none: '（无时间行）',
};

// 注意：id 只取 [A-Za-z0-9-]，不能用 \S+ —— 否则会把后缀「（AI 推导）」一并吞进 id
const SOURCE_LINE = /^来源：WorkTimeLog\s+([A-Za-z0-9-]+)/;

const WORKITEM_ID = /^WI-\d{8}-[0-9A-Za-z]+$/;

// scope: 'always' 任何来源都禁；'outside-manual' 手动录入允许（那是它必须写的行）
const FORBIDDEN = [
  { id: 'field-name', label: 'TickTick 字段名', scope: 'always',
    re: /\b(startDate|dueDate|isAllDay|timeZone|projectId|taskId|repeatFlag|etag)\b/i },
  { id: 'internal-term', label: '内部术语', scope: 'always',
    re: /本地区间|本地时间线|本地日志|本地记录|区间/ },
  { id: 'disclaimer', label: '免责声明 / 自我解释', scope: 'always',
    re: /非真实|不是真实|并非真实|不代表真实|会话收尾|会话结束|记录收尾|由会话|未采集|仅供参考|推算|推断/ },
  { id: 'arrow', label: '箭头 / 映射记号', scope: 'always',
    re: /→|->|=>/ },
  { id: 'interval', label: '时间区间', scope: 'outside-manual',
    re: /\d{1,2}:\d{2}\s*[-~—至]\s*\d{1,2}:\d{2}/ },
  { id: 'any-time', label: '具体时刻（无时间依据时不得出现）', scope: 'none-only',
    re: /\d{1,2}:\d{2}/ },
];

function normalize(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n');
}

function validate(rawContent, source, workItemId) {
  const violations = [];
  const warnings = [];

  if (!SOURCES.includes(source)) {
    return {
      ok: false,
      violations: [{ id: 'bad-source', label: `--source 必须是 ${SOURCES.join(' / ')}，收到「${source}」` }],
      warnings: [],
      lines: [],
    };
  }

  const text = normalize(rawContent);
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length === 0) {
    violations.push({ id: 'empty', label: 'content 为空' });
    return { ok: false, violations, warnings, lines };
  }

  // 1. 首行（或时间行）必须严格匹配模板
  const required = REQUIRED_LINE[source];
  const timeLines = required ? lines.filter((l) => required.test(l)) : [];
  if (required && timeLines.length !== 1) {
    violations.push({
      id: 'missing-time-line',
      label: `缺少或重复模板时间行，应恰好一行形如「${TIME_LINE_EXAMPLE[source]}」`,
    });
  }

  // 2. 来源锚点必须存在
  const sourceLines = lines.filter((l) => SOURCE_LINE.test(l));
  if (sourceLines.length !== 1) {
    violations.push({
      id: 'missing-source',
      label: '缺少唯一一行「来源：WorkTimeLog <本地 WorkItem id>」——这是按 id 定位任务的唯一锚点，缺了会退回标题匹配',
    });
  } else {
    const id = SOURCE_LINE.exec(sourceLines[0])[1];
    if (workItemId && id !== workItemId) {
      violations.push({ id: 'source-mismatch', label: `来源 id「${id}」与 --workitem-id「${workItemId}」不一致` });
    }
    if (!WORKITEM_ID.test(id)) {
      warnings.push({ id: 'source-id-format', label: `来源 id「${id}」不符合 WI-YYYYMMDD-XXXX 形态，请核对是否写成了其它编号` });
    }
  }

  // 3. 行数必须等于模板行数，多出来的行即为即兴发挥
  if (lines.length !== EXPECTED_LINES[source]) {
    const expected = EXPECTED_LINES[source];
    const extra = lines.filter((l) => !(required && required.test(l)) && !SOURCE_LINE.test(l));
    violations.push({
      id: 'extra-line',
      label: `行数应为 ${expected} 行，实际 ${lines.length} 行` +
        (extra.length ? `；多余内容：${extra.map((l) => `「${l}」`).join('、')}` : ''),
    });
  }

  // 4. 禁写清单
  for (const rule of FORBIDDEN) {
    if (rule.scope === 'outside-manual' && source === 'manual') continue;
    if (rule.scope === 'none-only' && source !== 'none') continue;
    const hit = rule.re.exec(text);
    if (hit) {
      violations.push({ id: rule.id, label: `出现${rule.label}：「${hit[0]}」` });
    }
  }

  return { ok: violations.length === 0, violations, warnings, lines };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { flags: {}, bools: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.bools[key] = true;
    } else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function report(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  for (const v of result.violations) {
    process.stdout.write(`[违规] ${v.id}: ${v.label}\n`);
  }
  for (const w of result.warnings) {
    process.stdout.write(`[提示] ${w.id}: ${w.label}\n`);
  }
  process.stdout.write(result.ok ? 'PASS: content 符合模板。\n' : `FAIL: ${result.violations.length} 项违规，按模板重写后再写入。\n`);
}

function selftest() {
  const cases = [
    {
      name: '用户实测的违规样例（AI 推导 + 本地区间 + 免责声明）',
      source: 'ai',
      content: '开始时间：11:30\n本地区间：11:30-11:42；结束时间为会话收尾，非真实结束\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）',
      expect: false,
      hit: ['internal-term', 'disclaimer', 'interval', 'extra-line'],
    },
    {
      name: '合规：AI 推导',
      source: 'ai',
      content: '开始时间：11:30\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）',
      expect: true,
      hit: [],
    },
    {
      name: '合规：手动录入',
      source: 'manual',
      content: '实际时间：12:15-13:00\n来源：WorkTimeLog WI-20260928-B1C2D3E4（手动录入）',
      expect: true,
      hit: [],
    },
    {
      name: '合规：无时间依据',
      source: 'none',
      content: '来源：WorkTimeLog WI-20260928-C9D8E7F6（时间未记录）',
      expect: true,
      hit: [],
    },
    {
      name: '违规：AI 推导却写了区间',
      source: 'ai',
      content: '开始时间：11:30\n来源：WorkTimeLog WI-20260928-A8F2C1D3（11:30-11:42）',
      expect: false,
      hit: ['interval'],
    },
    {
      name: '违规：把字段名写进备注',
      source: 'ai',
      content: '开始时间：11:30 → startDate\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）',
      expect: false,
      hit: ['field-name', 'arrow'],
    },
    {
      name: '违规：缺来源锚点',
      source: 'ai',
      content: '开始时间：11:30',
      expect: false,
      hit: ['missing-source'],
    },
    {
      name: '违规：手动录入缺区间',
      source: 'manual',
      content: '来源：WorkTimeLog WI-20260928-B1C2D3E4（手动录入）',
      expect: false,
      hit: ['missing-time-line'],
    },
    {
      name: '违规：无时间依据却写了时刻',
      source: 'none',
      content: '开始时间：11:30\n来源：WorkTimeLog WI-20260928-C9D8E7F6（AI 推导）',
      expect: false,
      hit: ['any-time', 'extra-line'],
    },
    {
      name: '违规：来源 id 与本地不一致',
      source: 'ai',
      content: '开始时间：11:30\n来源：WorkTimeLog WI-20260928-FFFFFFFF（AI 推导）',
      expect: false,
      workItemId: 'WI-20260928-A8F2C1D3',
      hit: ['source-mismatch'],
    },
    {
      name: '合规：手动录入但结束未记录（只写开始时间）',
      source: 'manual_open',
      content: '开始时间：10:00\n来源：WorkTimeLog WI-20260924-F646E52C（手动录入）',
      expect: true,
      hit: [],
    },
    {
      name: '违规：手动录入但结束未记录，却写了区间',
      source: 'manual_open',
      content: '实际时间：10:00-10:40\n来源：WorkTimeLog WI-20260924-F646E52C（手动录入）',
      expect: false,
      hit: ['missing-time-line', 'interval'],
    },
    {
      name: '合规：字面量 \\n 换行的等价写法',
      source: 'ai',
      content: '开始时间：11:30\\n来源：WorkTimeLog WI-20260928-A8F2C1D3（AI 推导）',
      expect: true,
      hit: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const r = validate(c.content, c.source, c.workItemId);
    const ids = r.violations.map((v) => v.id);
    const okVerdict = r.ok === c.expect;
    const okHits = c.hit.every((h) => ids.includes(h));
    const pass = okVerdict && okHits;
    if (!pass) failed++;
    process.stdout.write(
      `${pass ? 'ok  ' : 'FAIL'} | ${c.name}\n` +
      `       期望 ${c.expect ? 'PASS' : 'FAIL'}，实得 ${r.ok ? 'PASS' : 'FAIL'}` +
      `；违规=${ids.length ? ids.join(',') : '无'}\n`
    );
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} 用例通过。\n`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const { flags, bools } = parseArgs(process.argv.slice(2));

  if (bools.selftest) process.exit(selftest());

  if (bools.help || (!flags.content && !flags.source)) {
    process.stdout.write(
      '用法：node scripts/validate-content.js --source ai|manual|none --content "<文本>" ' +
      '[--workitem-id WI-YYYYMMDD-XXXX] [--json]\n' +
      '      node scripts/validate-content.js --selftest\n'
    );
    process.exit(2);
  }

  const result = validate(flags.content, flags.source, flags['workitem-id']);
  report(result, !!bools.json);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validate, FORBIDDEN, REQUIRED_LINE, EXPECTED_LINES };
