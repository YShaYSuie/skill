#!/usr/bin/env node
'use strict';
/**
 * test-security-redaction.js — 敏感信息脱敏规则回归测试。
 *
 * ## 为什么用「运行时拼装」而不是字面量
 *
 * 本文件必须测试「标签 + 凭据值」这种形态能否被识别。但如果把样本直接写成
 * 字面量，**测试文件自身就会变成一个含有疑似凭据的文件** ——
 * 任何扫描器（包括技能自己的 `validate-log`）都会把它标出来，
 * 而且它也违背了「不该在仓库里放凭据样本」的常识。
 *
 * 因此样本一律在运行时拼装：`标签 + fakeValue()`。
 * 扫描器看到的是 `'令牌'` 和 `fakeValue()` 两段，不构成「标签紧跟值」的形态。
 *
 * ## 背景（2026-09-21）
 *
 * 用户在中文里贴出的凭据（「令牌：xxx」）被原样记入了明文日志 ——
 * 当时 `credential_pair` 规则只覆盖英文关键词（password / token / api_key …），
 * 中文的「令牌 / 密码 / 密钥 / 口令」完全没有覆盖。
 * 本测试守住补齐后的行为。
 *
 * 运行：`node scripts/test-security-redaction.js`；退出码非 0 = 存在偏差。
 */

const assert = require('assert');
const path = require('path');

const S = require(path.join(__dirname, 'lib', 'security'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: String((e && e.message) || e) });
    process.stdout.write(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}\n`);
  }
}
const section = (t) => process.stdout.write(`\n${t}\n`);

/**
 * 生成一个**看起来像凭据但确定不是**的样本值。
 *
 * 用固定前缀 + 固定长度，保证：① 形状足以命中规则；② 任何人一眼能看出是假值；
 * ③ 不以字面量形式出现在源码里。
 */
const fakeValue = () => `${'FAKE'.repeat(2)}-${'0123456789'.repeat(2)}`;

/** 组装「标签 + 值」——刻意不写成字面量 */
const labeled = (label, sep) => `${label}${sep}${fakeValue()}`;

process.stdout.write('test-security-redaction.js — 敏感信息脱敏回归测试\n');

/* ---------------- 1. 应该被识别 ---------------- */
section('1. 应当被识别（应命中）');

const SHOULD_HIT_CN = [
  ['令牌', '：'],
  ['令牌', ':'],
  ['令牌', '='],
  ['访问令牌', '：'],
  ['密钥', '：'],
  ['口令', '：'],
  ['密码', '：'],
  ['私钥', '：'],
  ['凭据', '：'],
  ['凭证', '='],
];

check('中文标签 + 值（10 种标签/分隔符组合）都能命中', () => {
  const miss = [];
  for (const [label, sep] of SHOULD_HIT_CN) {
    const text = labeled(label, sep);
    const hits = S.containsSensitive(text);
    if (!hits.length) miss.push(`${label}${sep}`);
  }
  assert.deepStrictEqual(miss, [], `以下组合未被识别：${miss.join('、')}`);
});

check('中文标签 + 空格 + 值（如「我的令牌是 xxx」）也能命中', () => {
  const text = `${'我的'}${'令牌'}${'是'} ${fakeValue()}`;
  assert.ok(S.containsSensitive(text).length > 0, '未命中');
});

check('英文标签 + 值仍然命中（未被本次修改破坏）', () => {
  for (const label of ['password', 'secret', 'api_key', 'auth_token']) {
    const text = labeled(label, ': ');
    assert.ok(S.containsSensitive(text).length > 0, `未命中：${label}`);
  }
});

check('redact() 会把命中的值替换掉，原文不再出现', () => {
  const v = fakeValue();
  const text = `${'令牌'}：${v}`;
  const out = S.redact(text);
  const masked = typeof out === 'string' ? out : JSON.stringify(out);
  assert.ok(!masked.includes(v), '脱敏后原文仍然可见');
});

/* ---------------- 2. 不应误伤 ---------------- */
section('2. 不应误伤（须放行）');

check('仅提到「令牌」但没有值 → 不命中', () => {
  for (const t of ['我怎么找到令牌', '令牌在哪里？', '需要配置令牌', '检查令牌配置是否正确']) {
    assert.strictEqual(S.containsSensitive(t).length, 0, `误伤：${t}`);
  }
});

check('「密码」作为功能名词出现 → 不命中', () => {
  for (const t of ['实现密码重置功能', '密码强度校验规则', '登录密码字段长度上限 20']) {
    assert.strictEqual(S.containsSensitive(t).length, 0, `误伤：${t}`);
  }
});

check('中文标签后跟中文说明（无 ASCII 值）→ 不命中', () => {
  for (const t of ['令牌已过期', '密码错误次数限制', '密钥管理模块设计']) {
    assert.strictEqual(S.containsSensitive(t).length, 0, `误伤：${t}`);
  }
});

check('普通工作描述不受影响', () => {
  for (const t of ['完成 GPU 细粒度调度需求分析', '运行 browser-verify.js 校验原型', '保存原型为草稿版本']) {
    assert.strictEqual(S.containsSensitive(t).length, 0, `误伤：${t}`);
  }
});

/* ---------------- 3. 规则集合自洽 ---------------- */
section('3. 规则集合');

check('规则名唯一（避免覆盖与调试混淆）', () => {
  const names = S.RULES.map((r) => r.name);
  assert.strictEqual(new Set(names).size, names.length, `重复规则名：${names.join(', ')}`);
});

check('中文口令规则已注册', () => {
  assert.ok(
    S.RULES.some((r) => r.name === 'credential_pair_cn'),
    '未找到 credential_pair_cn 规则'
  );
});

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  process.stdout.write('\n失败明细：\n');
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
