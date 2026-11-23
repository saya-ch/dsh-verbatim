// session-config.test.js —— 会话配置（D-014 / D-166 / D-169 / D-175）
//
// 覆盖四件事：
//   ① 默认值 = { record: false, tools: false, autoRecall: false, excludeRanges: [] }（D-166/D-230：默认关）
//   ② 配置目录分工：运行时读 <dbRoot>/sessions/<id>.json，测试用临时 dbRoot（D-175）
//   ③ 写盘原子、合并语义正确、未知字段不丢
//   ④ 非法配置（空区间 / from > to / 解析不了 / 类型错）报明确错误，不静默跳过

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './exclude-range.js';
import {
  CONFIG_KEYS,
  DEFAULT_SESSION_CONFIG,
  RESERVED_KEYS,
  SWITCH_KEYS,
  defaultSessionConfig,
  enabledOf,
  ensureSessionConfig,
  loadSessionConfig,
  loadSessionExcludeRanges,
  resolveDbRoot,
  resolveDshHome,
  saveSessionConfig,
  sessionConfigExists,
  sessionConfigPath,
  sessionsDir,
  setSessionExcludeRanges,
  setSessionFlag,
  validateSessionConfig,
} from './session-config.js';

/** src/config 目录 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录（里面有个只放 fixture 的 sessions/，D-175） */
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
/** 真实会话 id，项目内 sessions/ 下有它的 fixture */
const FIXTURE_SID = 'qqb-p-0000000000-00000000000000000000000000000000';

/** 2026-11-08T00:00:00+08:00 / 2026-11-09T00:00:00+08:00 */
const T_11_08 = 1_794_067_200_000;
const T_11_09 = 1_794_153_600_000;

/** 造一个临时 dbRoot，测试结束自动清理 */
function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─────────────────────────────────────────────────────────────
// ① 默认值与 schema
// ─────────────────────────────────────────────────────────────

test('默认配置的完整 JSON：record/tools **默认关**、autoRecall 关、无排除区间（D-166/D-230）', () => {
  const cfg = defaultSessionConfig();
  assert.deepEqual(cfg, {
    // 2026-11-18 作者要求：装上是默认关，由人显式打开（修正 D-009 的"记录默认常开"）
    record: false,
    tools: false,
    autoRecall: false,
    excludeRanges: [],
  });
  // 字段顺序也要稳定（写进文件后人是照着顺序读的）
  assert.deepEqual(Object.keys(cfg), ['record', 'tools', 'autoRecall', 'excludeRanges']);
  assert.deepEqual(DEFAULT_SESSION_CONFIG, cfg);
});

test('默认值每次都是新副本，调用方改不到常量', () => {
  const a = defaultSessionConfig();
  a.record = false;
  a.excludeRanges.push({ from: '2026-11-08', to: '2026-11-09' });
  assert.equal(defaultSessionConfig().record, false);   // D-230：默认关
  assert.deepEqual(defaultSessionConfig().excludeRanges, []);
  assert.ok(Object.isFrozen(DEFAULT_SESSION_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_SESSION_CONFIG.excludeRanges));
});

test('autoRecall 在 schema 里、但不在面板开关里（D-166）', () => {
  assert.ok(CONFIG_KEYS.includes('autoRecall'), 'schema 必须保留这个字段');
  assert.ok(RESERVED_KEYS.includes('autoRecall'));
  assert.deepEqual([...SWITCH_KEYS], ['record', 'tools'], '面板只渲染两个开关');
  assert.equal(SWITCH_KEYS.includes('autoRecall'), false, 'autoRecall 不进面板（D-166）');
  // 但协议里仍要带出来，前端不用改协议
  assert.deepEqual(enabledOf(defaultSessionConfig()), { record: false, tools: false, autoRecall: false });
});

test('validateSessionConfig：缺字段补默认值，未知字段保留并告警', () => {
  const warnings = [];
  const cfg = validateSessionConfig(
    { record: false, myOwnField: 42 },
    { onWarn: (m) => warnings.push(m) },
  );
  assert.equal(cfg.record, false);
  assert.equal(cfg.tools, false, '缺的字段补默认值（D-230：默认关）');
  assert.equal(cfg.autoRecall, false);
  assert.deepEqual(cfg.excludeRanges, []);
  assert.equal(cfg.myOwnField, 42, '未知字段要保留，别把别人写的东西冲掉');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未知配置项 "myOwnField"/);
});

// ─────────────────────────────────────────────────────────────
// ② 配置目录分工（D-175）
// ─────────────────────────────────────────────────────────────

test('resolveDbRoot：默认 $DSH_HOME/verbatim，也接受 dbRoot / dshHome / 字符串', () => {
  const old = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    assert.equal(resolveDbRoot(), path.join(resolveDshHome(), 'verbatim'));
    assert.ok(resolveDbRoot().endsWith(path.join('.dsh', 'verbatim')));

    process.env.DSH_HOME = path.join(os.tmpdir(), 'fake-dsh-home');
    assert.equal(
      resolveDbRoot(),
      path.join(path.resolve(process.env.DSH_HOME), 'verbatim'),
      '环境变量 DSH_HOME 优先',
    );
    assert.equal(resolveDbRoot({ dshHome: 'C:/x/y' }), path.resolve('C:/x/y', 'verbatim'));
    assert.equal(resolveDbRoot({ dbRoot: 'C:/x/wm' }), path.resolve('C:/x/wm'));
    assert.equal(resolveDbRoot('C:/x/wm'), path.resolve('C:/x/wm'), '老签名：第二参直接给 dbRoot');
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }
});

test('sessionConfigPath：<dbRoot>/sessions/<session-id>.json', () => {
  const root = path.join(os.tmpdir(), 'wm-root');
  assert.equal(
    sessionConfigPath('abc', { dbRoot: root }),
    path.join(path.resolve(root), 'sessions', 'abc.json'),
  );
  assert.equal(sessionsDir({ dbRoot: root }), path.join(path.resolve(root), 'sessions'));
  // 老签名（第二参直接给 dbRoot 字符串）也要能用
  assert.equal(sessionConfigPath('abc', root), path.join(path.resolve(root), 'sessions', 'abc.json'));
});

test('sessionId 校验：挡住路径穿越与 Windows 非法字符', () => {
  for (const bad of ['../etc', 'a/b', 'a\\b', 'a:b', 'a*b', '.hidden', '', '   ', null, 42]) {
    assert.throws(
      () => sessionConfigPath(bad, { dbRoot: os.tmpdir() }),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(e.path, 'sessionId');
        return true;
      },
      `应当拒收 sessionId=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(sessionConfigPath('  ok-id  ', { dbRoot: os.tmpdir() }), path.join(
    os.tmpdir(), 'sessions', 'ok-id.json',
  ));
});

test('loadSessionConfig：文件不存在 → 默认值，且不落盘', (t) => {
  const root = tmpRoot(t);
  const cfg = loadSessionConfig('missing', { dbRoot: root });
  assert.deepEqual(cfg, defaultSessionConfig());
  assert.equal(sessionConfigExists('missing', { dbRoot: root }), false, 'load 不应该顺手建文件');
  assert.equal(fs.existsSync(sessionsDir({ dbRoot: root })), false);
});

test('loadSessionConfig：读项目内 fixture（D-175：项目 sessions/ 只放 fixture）', () => {
  // 运行时读 $DSH_HOME/verbatim/sessions/，测试里把 dbRoot 指到项目根，读的就是 fixture
  const cfg = loadSessionConfig(FIXTURE_SID, { dbRoot: PROJECT_ROOT });
  assert.equal(cfg.record, false);
  assert.equal(cfg.tools, false);
  assert.equal(cfg.autoRecall, false, 'fixture 里没写也要补成默认 false');
  assert.equal(cfg.excludeRanges.length, 1);
  assert.equal(cfg.excludeRanges[0].from, '2026-11-08T00:00:00+08:00');
  assert.equal(cfg.excludeRanges[0].to, '2026-11-09T00:00:00+08:00');
  assert.equal(cfg.excludeRanges[0].reason, '示例：这段不想记');
  // fixture 里不再有多余的 sessionId —— 配置文件名已经是 session id，
  // 内容里再存一次是冗余，且会让每次导入刷一条"未知配置项"告警（T8 集成时发现）。
  // 未知字段的保留 + 告警行为由下面的 validateSessionConfig 用例单独覆盖。
});

test('loadSessionExcludeRanges：fixture 的区间归一化成毫秒，边界精确', async () => {
  const ranges = loadSessionExcludeRanges(FIXTURE_SID, { dbRoot: PROJECT_ROOT });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].from, T_11_08);
  assert.equal(ranges[0].to, T_11_09);
  assert.equal(ranges[0].reason, '示例：这段不想记');

  const { isExcluded } = await import('./exclude-range.js');
  assert.equal(isExcluded(Date.parse('2026-11-08T23:59:59.999+08:00'), ranges), true);
  assert.equal(isExcluded(Date.parse('2026-11-09T00:00:00.000+08:00'), ranges), false);
  assert.equal(isExcluded(Date.parse('2026-11-09T08:00:00+08:00'), ranges), false, '11-09 全天正常');
});

// ─────────────────────────────────────────────────────────────
// ③ 写盘：合并、原子、稳定
// ─────────────────────────────────────────────────────────────

test('saveSessionConfig：新建文件，JSON 文本稳定且人能读懂', (t) => {
  const root = tmpRoot(t);
  const cfg = saveSessionConfig('s1', {
    excludeRanges: [
      { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '调试期' },
    ],
  }, { dbRoot: root });

  assert.deepEqual(cfg, {
    record: false,
    tools: false,
    autoRecall: false,
    excludeRanges: [
      { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '调试期' },
    ],
  });

  const file = sessionConfigPath('s1', { dbRoot: root });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), '文件末尾要有换行');
  // 配置里保留人写的字符串日期，不换算成 epoch（否则人看不懂，D-175 的初衷）
  assert.match(text, /"2026-11-08T00:00:00\+08:00"/);
  assert.equal(JSON.parse(text).excludeRanges[0].reason, '调试期');
  // 不留临时文件
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('saveSessionConfig：patch 合并，不丢其它字段（含未知字段）', (t) => {
  const root = tmpRoot(t);
  saveSessionConfig('s2', {
    myOwnField: { nested: true },
    excludeRanges: [{ from: '2026-11-08', to: '2026-11-09', reason: '调试期' }],
  }, { dbRoot: root });

  const after = saveSessionConfig('s2', { record: false }, { dbRoot: root });
  assert.equal(after.record, false);
  assert.equal(after.tools, false, '没动的字段保持原值（默认已改成关）');
  assert.equal(after.excludeRanges.length, 1, '排除区间不能被一次开关操作冲掉');
  assert.deepEqual(after.myOwnField, { nested: true }, '未知字段要保留');

  // 写盘的也是合并后的结果
  const reload = loadSessionConfig('s2', { dbRoot: root });
  assert.deepEqual(reload, after);
});

test('saveSessionConfig：patch 非法时抛错，且不写盘', (t) => {
  const root = tmpRoot(t);
  saveSessionConfig('s3', { record: true }, { dbRoot: root });
  const file = sessionConfigPath('s3', { dbRoot: root });
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => saveSessionConfig('s3', { excludeRanges: [{ from: '2026-11-09', to: '2026-11-08' }] }, { dbRoot: root }),
    ConfigError,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, '校验失败不能留下半截配置');

  assert.throws(() => saveSessionConfig('s3', { record: 'yes' }, { dbRoot: root }), ConfigError);
  assert.throws(() => saveSessionConfig('s3', 'not-an-object', { dbRoot: root }), ConfigError);
});

test('setSessionFlag：面板 panel.set 的落点（record / tools / autoRecall）', (t) => {
  const root = tmpRoot(t);
  assert.equal(setSessionFlag('s4', 'record', false, { dbRoot: root }).record, false);
  assert.equal(setSessionFlag('s4', 'tools', false, { dbRoot: root }).tools, false);
  // autoRecall 面板不渲染，但 RPC 契约里保留（D-166）
  assert.equal(setSessionFlag('s4', 'autoRecall', true, { dbRoot: root }).autoRecall, true);

  assert.throws(
    () => setSessionFlag('s4', 'whatever', true, { dbRoot: root }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /开关名只能是 "record" \/ "tools" \/ "autoRecall"/);
      return true;
    },
  );
  assert.throws(() => setSessionFlag('s4', 'record', 'yes', { dbRoot: root }), /必须是 true\/false/);
  assert.throws(() => setSessionFlag('s4', 'excludeRanges', [], { dbRoot: root }), ConfigError);
});

test('setSessionExcludeRanges + ensureSessionConfig', (t) => {
  const root = tmpRoot(t);
  const cfg = setSessionExcludeRanges('s5', [{ from: '2026-11-08', to: '2026-11-09', reason: '调试期' }], { dbRoot: root });
  assert.equal(cfg.excludeRanges.length, 1);
  assert.equal(sessionConfigExists('s5', { dbRoot: root }), true);

  // ensure：缺文件时落一份默认配置
  assert.equal(sessionConfigExists('s6', { dbRoot: root }), false);
  const made = ensureSessionConfig('s6', { dbRoot: root });
  assert.deepEqual(made, defaultSessionConfig());
  assert.equal(sessionConfigExists('s6', { dbRoot: root }), true);
  // 已有文件时不覆盖
  saveSessionConfig('s6', { tools: false }, { dbRoot: root });
  assert.equal(ensureSessionConfig('s6', { dbRoot: root }).tools, false);
});

// ─────────────────────────────────────────────────────────────
// ④ 非法配置：必须报明确错误
// ─────────────────────────────────────────────────────────────

test('非法配置：JSON 语法错 / 空文件 / 顶层不是对象', (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(sessionsDir({ dbRoot: root }), { recursive: true });

  const badJson = path.join(sessionsDir({ dbRoot: root }), 'bad-json.json');
  fs.writeFileSync(badJson, '{ "record": true, ', 'utf8');
  assert.throws(
    () => loadSessionConfig('bad-json', { dbRoot: root }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.code, 'CONFIG_INVALID_JSON');
      assert.equal(e.path, badJson, '错误要带文件路径');
      assert.match(e.message, /不是合法 JSON/);
      return true;
    },
  );

  const empty = path.join(sessionsDir({ dbRoot: root }), 'empty.json');
  fs.writeFileSync(empty, '   \n', 'utf8');
  assert.throws(
    () => loadSessionConfig('empty', { dbRoot: root }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /空文件/);
      return true;
    },
    '空文件不能静默当成默认值（会悄悄清掉排除区间）',
  );

  const arr = path.join(sessionsDir({ dbRoot: root }), 'arr.json');
  fs.writeFileSync(arr, '[1,2,3]', 'utf8');
  assert.throws(() => loadSessionConfig('arr', { dbRoot: root }), /配置必须是 JSON 对象/);
});

test('非法配置：空区间、from > to、解析不了、类型不对 —— 逐条报出字段路径', (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(sessionsDir({ dbRoot: root }), { recursive: true });

  const cases = [
    { name: 'from-gt-to', body: { excludeRanges: [{ from: '2026-11-09', to: '2026-11-08' }] }, msg: /to 早于 from/ },
    { name: 'empty-range', body: { excludeRanges: [{ from: '2026-11-08', to: '2026-11-08' }] }, msg: /from 与 to 相同/ },
    { name: 'unparsable', body: { excludeRanges: [{ from: '11月8日', to: '2026-11-09' }] }, msg: /from：无法解析为时刻/ },
    { name: 'not-array', body: { excludeRanges: 'nope' }, msg: /excludeRanges：必须是数组/ },
    { name: 'record-type', body: { record: 1 }, msg: /record：必须是 true\/false/ },
    { name: 'tools-type', body: { tools: 'on' }, msg: /tools：必须是 true\/false/ },
    { name: 'autoRecall-type', body: { autoRecall: 'false' }, msg: /autoRecall：必须是 true\/false/ },
    { name: 'missing-to', body: { excludeRanges: [{ from: '2026-11-08' }] }, msg: /缺少 to/ },
  ];

  for (const c of cases) {
    const file = path.join(sessionsDir({ dbRoot: root }), `${c.name}.json`);
    fs.writeFileSync(file, JSON.stringify(c.body), 'utf8');
    assert.throws(
      () => loadSessionConfig(c.name, { dbRoot: root }),
      (e) => {
        assert.ok(e instanceof ConfigError, `${c.name} 应抛 ConfigError`);
        assert.match(e.message, c.msg, `${c.name} 的错误信息应指明原因`);
        assert.ok(String(e.path).includes(c.name), `${c.name} 的错误应带字段路径，实际 ${e.path}`);
        return true;
      },
      `${c.name} 必须报错，不能静默跳过`,
    );
  }
});

test('非法配置：格式（schema）正确时，坏区间一条都不能静默放过', () => {
  // 这一条专门锁死「静默跳过」这个失败模式
  const bad = [{ from: '2026-11-08', to: '2026-11-08' }];
  assert.throws(() => validateSessionConfig({ excludeRanges: bad }), ConfigError);
  assert.throws(() => validateSessionConfig({ excludeRanges: bad }, { path: 'sessions/x.json' }), /sessions\/x\.json\.excludeRanges\[0\]/);
});
