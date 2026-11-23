// exclude-range.test.js —— 软排除区间（D-169 / D-170 / D-172 / D-176）
//
// 重点三块：
//   ① 时区：绝不依赖机器时区（纯日期按 +08:00，不是 Date.parse 的 UTC）；
//   ② 边界：11-08 23:59:59.999 排除 / 11-09 00:00:00.000 不排除（左闭右开）；
//   ③ 非法配置必须报明确错误，不能静默跳过（与 T2 的数据路径策略不同）。
//
// 另外带一组**差分测试**：断言本文件与 T2（src/ingest/export.js）的时间口径一致，
// 这样将来谁改了时区逻辑，这里会立刻红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ConfigError,
  DEFAULT_UTC_OFFSET,
  applyExclusions,
  dayKeyInZone,
  dayRange,
  findRange,
  formatCount,
  formatExcludedSummary,
  isExcluded,
  isNormalizedRanges,
  normalizeRanges,
  parseInstantStrict,
  summarizeExclusions,
} from './exclude-range.js';

// T2 的实现，只用于差分比对
import * as t2 from '../ingest/export.js';

/** 2026-11-08T00:00:00+08:00 */
const T_11_08 = 1_794_067_200_000;
/** 2026-11-09T00:00:00+08:00 */
const T_11_09 = 1_794_153_600_000;

/** 任务文档里给出的那份真实配置 */
const REAL_RANGES = [
  { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '调试期' },
];

// ─────────────────────────────────────────────────────────────
// ① 时区
// ─────────────────────────────────────────────────────────────

test('ConfigError：带 code 与 path，便于提示用户改配置', () => {
  const e = new ConfigError('配置错了', { path: 'excludeRanges[0].from' });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ConfigError');
  assert.equal(e.code, 'CONFIG_INVALID');
  assert.equal(e.path, 'excludeRanges[0].from');
});

test('parseInstantStrict：纯日期按 +08:00 解释，不是 JS 默认的 UTC（D-172）', () => {
  const got = parseInstantStrict('2026-11-08');
  assert.equal(got, T_11_08);
  // JS 的 Date.parse('2026-11-08') 按 UTC 解释，正好差 8 小时
  assert.equal(Date.parse('2026-11-08'), 1_794_096_000_000);
  assert.equal(got - Date.parse('2026-11-08'), -8 * 3_600_000, '必须比 UTC 口径早 8 小时（即 11-08 00:00 +08）');
  assert.equal(dayKeyInZone(got, DEFAULT_UTC_OFFSET), '2026-11-08');
});

test('parseInstantStrict：不带时区的日期时间也按 +08:00', () => {
  const withOffset = Date.parse('2026-11-08T12:00:00+08:00');
  assert.equal(parseInstantStrict('2026-11-08T12:00:00'), withOffset);
  assert.equal(parseInstantStrict('2026-11-08T12:00'), withOffset);
  assert.equal(parseInstantStrict('2026-11-08 12:00:00'), withOffset, '空格分隔也要认');
  assert.equal(parseInstantStrict('2026-11-08T12:00:00.000'), withOffset);
  assert.equal(parseInstantStrict('  2026-11-08T12:00:00  '), withOffset, '首尾空白要容忍');
});

test('parseInstantStrict：带时区的尊重原串（Z / ±HH:MM / ±HHMM）', () => {
  assert.equal(parseInstantStrict('2026-11-07T16:00:00Z'), T_11_08);
  assert.equal(parseInstantStrict('2026-11-07T16:00:00+00:00'), T_11_08);
  assert.equal(parseInstantStrict('2026-11-08T00:00:00+08:00'), T_11_08);
  assert.equal(parseInstantStrict('2026-11-08T00:00:00+0800'), T_11_08);
  assert.equal(
    parseInstantStrict('2026-11-07T13:00:00-05:00'),
    Date.parse('2026-11-07T13:00:00-05:00'),
    '负偏移也要按原串算',
  );
  // 同一时刻的三种写法必须完全相等
  assert.equal(
    parseInstantStrict('2026-11-07T16:00:00Z'),
    parseInstantStrict('2026-11-08T00:00:00+08:00'),
  );
});

test('parseInstantStrict：接受 Date 与 epoch 毫秒数字', () => {
  assert.equal(parseInstantStrict(T_11_08), T_11_08);
  assert.equal(parseInstantStrict(new Date(T_11_08)), T_11_08);
  assert.throws(() => parseInstantStrict(Number.NaN), ConfigError);
  assert.throws(() => parseInstantStrict(Infinity), ConfigError);
  assert.throws(() => parseInstantStrict(new Date('nope')), ConfigError);
});

test('parseInstantStrict：拒收 2026/11/08 这类会被机器本地时区解释的写法（D-172 的坑）', () => {
  for (const bad of ['2026/11/08', '11-08', '2026年11月8日', '昨天', '2026-11', '']) {
    assert.throws(
      () => parseInstantStrict(bad),
      (e) => {
        assert.ok(e instanceof ConfigError, `${bad} 应该抛 ConfigError`);
        assert.match(e.message, /无法解析为时刻|空字符串/);
        assert.ok(e.path, '错误要带字段路径');
        return true;
      },
      `应当拒收 ${JSON.stringify(bad)}`,
    );
  }
});

test('parseInstantStrict：拒收进位日期（2 月 30 日、24:00、13 月）', () => {
  // V8 会把 2026-02-30 悄悄进位成 03-02，把 24:00 进位成次日 00:00 —— 配置里这一定是笔误
  assert.throws(() => parseInstantStrict('2026-02-30'), ConfigError);
  assert.throws(() => parseInstantStrict('2026-02-30T00:00:00+08:00'), ConfigError);
  assert.throws(() => parseInstantStrict('2026-04-31T00:00:00+08:00'), ConfigError);
  assert.throws(() => parseInstantStrict('2026-11-08T24:00:00+08:00'), ConfigError);
  assert.throws(() => parseInstantStrict('2026-13-01'), ConfigError);
  assert.throws(() => parseInstantStrict('2026-11-08T12:60:00+08:00'), ConfigError);
  // 闰年 2 月 29 日是真的，要能过
  assert.equal(dayKeyInZone(parseInstantStrict('2028-02-29')), '2028-02-29');
});

test('机器时区无关：TZ=UTC 与 TZ=America/New_York 下得到同一时刻（D-176）', () => {
  const modulePath = fileURLToPath(new URL('./exclude-range.js', import.meta.url));
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    process.stdout.write(JSON.stringify({
      strict: m.parseInstantStrict('2026-11-08'),
      day: m.dayKeyInZone(m.parseInstantStrict('2026-11-08')),
      nativeDateOnly: Date.parse('2026-11-08'),
      nativeSlash: Date.parse('2026/11/08'),
    }));
  `;
  const run = (tz) => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    });
    return JSON.parse(out);
  };

  const shanghai = run('Asia/Shanghai');
  const utc = run('UTC');
  const newYork = run('America/New_York');

  for (const r of [shanghai, utc, newYork]) {
    assert.equal(r.strict, T_11_08, '任何时区都必须解析成同一个时刻');
    assert.equal(r.day, '2026-11-08', '日切与机器时区无关');
  }
  // 反证两条「原生解析为什么不能用」：
  // ① 纯日期：JS 规定按 UTC 解释（不是本地），所以任何机器上都比 +08 的当天 0 点早 8 小时；
  // ② 斜杠日期：这才是按机器本地时区解释，换时区结果就变（本次配置一律拒收这种写法）。
  assert.equal(shanghai.nativeDateOnly, 1_794_096_000_000, '纯日期被当成 UTC，比正确口径早 8 小时');
  assert.equal(utc.nativeDateOnly, shanghai.nativeDateOnly);
  assert.equal(newYork.nativeDateOnly, shanghai.nativeDateOnly);
  assert.notEqual(shanghai.nativeDateOnly, T_11_08);

  assert.equal(shanghai.nativeSlash, T_11_08, '在本机（+08）上斜杠写法恰好对——这正是它危险的地方');
  assert.notEqual(utc.nativeSlash, shanghai.nativeSlash, '换到 UTC 机器就差 8 小时');
  assert.notEqual(newYork.nativeSlash, shanghai.nativeSlash, '换到纽约机器又是另一个值');
});

// ─────────────────────────────────────────────────────────────
// ② 归一化与边界
// ─────────────────────────────────────────────────────────────

test('normalizeRanges：左闭右开边界（11-08 23:59:59.999 排除 / 11-09 00:00:00.000 不排除）', () => {
  const ranges = normalizeRanges(REAL_RANGES);
  assert.equal(ranges.length, 1);
  assert.deepEqual(
    { from: ranges[0].from, to: ranges[0].to, reason: ranges[0].reason },
    { from: T_11_08, to: T_11_09, reason: '调试期' },
  );
  assert.equal(ranges[0].fromText, '2026-11-08T00:00:00+08:00', '原串要留着给面板显示');
  assert.equal(ranges[0].toText, '2026-11-09T00:00:00+08:00');

  // 两条硬要求
  assert.equal(isExcluded(Date.parse('2026-11-08T23:59:59.999+08:00'), ranges), true, '终点前 1ms 必须排除');
  assert.equal(isExcluded(Date.parse('2026-11-09T00:00:00.000+08:00'), ranges), false, '终点本身不排除');

  // 完整边界扫描
  assert.equal(isExcluded(T_11_08, ranges), true, '起点包含');
  assert.equal(isExcluded(T_11_08 - 1, ranges), false, '起点前 1ms 不排除');
  assert.equal(isExcluded(T_11_09 - 1, ranges), true, '终点前 1ms 排除');
  assert.equal(isExcluded(T_11_09, ranges), false, '终点不排除');
  assert.equal(isExcluded(T_11_09 + 1, ranges), false);
});

test('normalizeRanges：纯日期写法也能直接写进配置（11-08 ~ 11-09）', () => {
  const ranges = normalizeRanges([{ from: '2026-11-08', to: '2026-11-09' }]);
  assert.equal(ranges[0].from, T_11_08, 'from 按 11-08 00:00 +08 解释');
  assert.equal(ranges[0].to, T_11_09, 'to 按 11-09 00:00 +08 解释');
  assert.equal(isExcluded(Date.parse('2026-11-09T00:00:00+08:00'), ranges), false);
  assert.equal(isExcluded(Date.parse('2026-11-09T00:30:00+08:00'), ranges), false, '11-09 必须正常入库（D-169/171）');
});

test('normalizeRanges：排序、reason 归一、空配置返回空数组', () => {
  const ranges = normalizeRanges([
    { from: '2026-11-10T00:00:00+08:00', to: '2026-11-11T00:00:00+08:00' },
    { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '  调试期  ' },
  ]);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].from < ranges[1].from, '必须按起点升序');
  assert.equal(ranges[0].reason, '调试期', 'reason 去首尾空白');
  assert.equal(ranges[1].reason, null, '没写 reason 就是 null');

  assert.deepEqual(normalizeRanges(undefined), []);
  assert.deepEqual(normalizeRanges(null), []);
  assert.deepEqual(normalizeRanges([]), []);
});

test('normalizeRanges：空区间 / from > to / 解析不了 / 类型错 都要报明确错误', () => {
  const cases = [
    { input: { from: '2026-11-08', to: '2026-11-09' }, msg: /必须是数组/ },
    { input: ['2026-11-08'], msg: /必须是对象/ },
    {
      input: [{ from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00' }, 'x'],
      msg: /excludeRanges\[1\]：必须是对象/,
    },
    { input: [{ to: '2026-11-09T00:00:00+08:00' }], msg: /缺少 from/ },
    { input: [{ from: '2026-11-08T00:00:00+08:00' }], msg: /缺少 to/ },
    { input: [{ from: '不是时间', to: '2026-11-09' }], msg: /excludeRanges\[0\]\.from：无法解析为时刻/ },
    { input: [{ from: '2026-11-08', to: '不是时间' }], msg: /\.to：无法解析为时刻/ },
    {
      input: [{ from: '2026-11-09T00:00:00+08:00', to: '2026-11-08T00:00:00+08:00' }],
      msg: /to 早于 from，区间为空/,
    },
    {
      input: [{ from: '2026-11-08T00:00:00+08:00', to: '2026-11-08T00:00:00+08:00' }],
      msg: /from 与 to 相同，区间为空/,
    },
    { input: [{ from: '2026-11-08', to: '2026-11-09', reason: 123 }], msg: /reason：必须是字符串/ },
    { input: [{ from: Number.NaN, to: '2026-11-09' }], msg: /数字不是有限值/ },
    { input: [{ from: null, to: '2026-11-09' }], msg: /期望字符串/ },
  ];

  for (const { input, msg } of cases) {
    assert.throws(
      () => normalizeRanges(input),
      (e) => {
        assert.ok(e instanceof ConfigError, `应抛 ConfigError：${JSON.stringify(input)}`);
        assert.match(e.message, msg);
        return true;
      },
      `应报错：${JSON.stringify(input)}`,
    );
  }
});

test('findRange / isExcluded：配置原样与归一化后的都接受', () => {
  const norm = normalizeRanges(REAL_RANGES);
  assert.ok(isNormalizedRanges(norm));
  assert.ok(!isNormalizedRanges(REAL_RANGES));

  const hitRaw = findRange(T_11_08 + 1000, REAL_RANGES);
  const hitNorm = findRange(T_11_08 + 1000, norm);
  assert.equal(hitRaw.from, hitNorm.from);
  assert.equal(hitRaw.reason, '调试期', '命中要能带出 reason 给面板显示');
  assert.equal(findRange(T_11_09, norm), null);

  // 时间戳本身坏了（NaN / undefined）→ 不算排除，但也不炸
  assert.equal(isExcluded(Number.NaN, norm), false);
  assert.equal(isExcluded(undefined, norm), false);
  assert.equal(isExcluded(T_11_08, []), false, '没配排除区间时一律不排除');
  assert.equal(isExcluded(T_11_08, undefined), false);

  // 配置非法时要抛，不能静默返回「不排除」
  assert.throws(() => isExcluded(T_11_08, [{ from: 'x', to: 'y' }]), ConfigError);
});

test('多区间与重叠区间：命中第一个，不重复计数（D-173 口径）', () => {
  const ranges = normalizeRanges([
    { from: '2026-11-08', to: '2026-11-10', reason: 'A' },
    { from: '2026-11-09', to: '2026-11-11', reason: 'B' },
  ]);
  assert.equal(findRange(Date.parse('2026-11-09T12:00:00+08:00'), ranges).reason, 'A', '重叠区取先命中的那个');
  assert.equal(findRange(Date.parse('2026-11-10T12:00:00+08:00'), ranges).reason, 'B');
  assert.equal(findRange(Date.parse('2026-11-11T00:00:00+08:00'), ranges), null);
});

// ─────────────────────────────────────────────────────────────
// ③ 统计与展示
// ─────────────────────────────────────────────────────────────

test('applyExclusions：打标记（就地）+ 统计条数/字数，与 in_surface 正交（D-173）', () => {
  const msgs = [
    { seq: 1, at: Date.parse('2026-11-08T15:33:00+08:00'), text: '某条测试文本', in_surface: 0 },
    { seq: 2, at: Date.parse('2026-11-08T23:59:59.999+08:00'), text: 'edge', in_surface: 0 },
    { seq: 3, at: Date.parse('2026-11-09T00:00:00.000+08:00'), text: '11-09 正常', in_surface: 1 },
    { seq: 4, at: Date.parse('2026-11-09T08:00:00+08:00'), text: '早八', in_surface: 1 },
  ];

  const summary = applyExclusions(msgs, REAL_RANGES);
  assert.deepEqual(msgs.map((m) => m.excluded), [1, 1, 0, 0]);
  assert.equal(summary.count, 2);
  assert.equal(summary.chars, '某条测试文本'.length + 'edge'.length);
  assert.equal(summary.totalCount, 4);
  assert.equal(summary.ranges[0].count, 2, '每条区间单独计数，面板要分区间展示');
  assert.equal(summary.ranges[0].chars, summary.chars);
  // 正交：in_surface 不能被这里改动
  assert.deepEqual(msgs.map((m) => m.in_surface), [0, 0, 1, 1]);
});

test('summarizeExclusions：只统计，不改入参', () => {
  const msgs = [
    { at: T_11_08 + 1, text: 'aa' },
    { at: T_11_09 + 1, text: 'bbb' },
  ];
  const summary = summarizeExclusions(msgs, REAL_RANGES);
  assert.equal(summary.count, 1);
  assert.equal(summary.chars, 2);
  assert.equal(summary.totalChars, 5);
  assert.equal(msgs[0].excluded, undefined, '不能被改');
});

test('formatExcludedSummary / formatCount：绝对数 + 千分位，不用 Intl（D-174 / D-176）', () => {
  assert.equal(formatCount(21264), '21,264');
  assert.equal(formatCount(327), '327');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(
    formatExcludedSummary({ count: 327, chars: 21264 }),
    '按日期排除 327 条 / 21,264 字',
  );
});

// ─────────────────────────────────────────────────────────────
// ④ 与 T2 的一致性（差分测试：防止两套时区逻辑跑偏）
// ─────────────────────────────────────────────────────────────

test('差分：本文件与 T2 的 parseInstant 对合法写法给出同一时刻', () => {
  const samples = [
    '2026-11-08',
    '2026-11-09',
    '2026-01-01',
    '2028-02-29',
    '2026-11-08T00:00',
    '2026-11-08T12:00:00',
    '2026-11-08T23:59:59.999',
    '2026-11-08T00:00:00+08:00',
    '2026-11-07T16:00:00Z',
    '2026-11-08T00:00:00+0800',
    '2026-11-07T13:00:00-05:00',
    '2026-11-08 12:00:00',
  ];
  for (const s of samples) {
    assert.equal(parseInstantStrict(s), t2.parseInstant(s), `与 T2 不一致：${s}`);
  }
});

test('差分：与 T2 的 normalizeExcludeRanges 对合法区间结果一致', () => {
  const raw = [
    { from: '2026-11-10T00:00:00+08:00', to: '2026-11-11T00:00:00+08:00' },
    { from: '2026-11-08', to: '2026-11-09', reason: '调试期' },
  ];
  const mine = normalizeRanges(raw).map((r) => ({ from: r.from, to: r.to, reason: r.reason }));
  const theirs = t2.normalizeExcludeRanges(raw).map((r) => ({ from: r.from, to: r.to, reason: r.reason }));
  assert.deepEqual(mine, theirs);
});

test('差分：数据路径宽松跳过、配置路径严格报错——这是有意的分工', () => {
  const bad = [
    { from: '2026-11-09', to: '2026-11-08' }, // 反了就空
    { from: 'x', to: 'y' }, // 解析不了
    { from: '2026-11-08' }, // 缺 to
  ];
  // T2：告警 + 跳过，导出照常跑完（数据路径不能因为一条配置坏掉就中断）
  const warnings = [];
  const lenient = t2.normalizeExcludeRanges(bad, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(lenient, []);
  assert.equal(warnings.length, 3, 'T2 每条都告警');

  // 本文件：直接抛，且指出第几个区间（配置路径错了必须让人看见）
  for (let i = 0; i < bad.length; i++) {
    assert.throws(
      () => normalizeRanges([bad[i]]),
      (e) => {
        assert.match(e.message, /excludeRanges\[0\]/);
        return true;
      },
    );
  }
});

// ─────────────────────────────────────────────────────────────
// ⑤ 生成配置用的小工具
// ─────────────────────────────────────────────────────────────

test('dayRange：一天 → 可直接写进配置的区间（左闭右开）', () => {
  const r = dayRange('2026-11-08');
  assert.equal(r.from, '2026-11-08T00:00:00+08:00');
  assert.equal(r.to, '2026-11-09T00:00:00+08:00');
  assert.equal(r.fromMs, T_11_08);
  assert.equal(r.toMs, T_11_09);
  assert.equal(r.reason, null);

  // 生成出来的东西能直接当配置用，且边界正确
  const ranges = normalizeRanges([r]);
  assert.equal(isExcluded(Date.parse('2026-11-08T23:59:59.999+08:00'), ranges), true);
  assert.equal(isExcluded(Date.parse('2026-11-09T00:00:00.000+08:00'), ranges), false);

  // 跨月/跨年
  assert.deepEqual(
    [dayRange('2026-12-31').from, dayRange('2026-12-31').to],
    ['2026-12-31T00:00:00+08:00', '2027-01-01T00:00:00+08:00'],
  );
  assert.throws(() => dayRange('2026-02-30'), ConfigError);
});
