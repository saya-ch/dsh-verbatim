// panel-config.test.js —— 面板 RPC 读全局配置的回归测试
//
// 回归点：createPanelApi 里的 getGlobal() 曾经引用了不存在的 `ctx`
// （`ctx` 只在 apply() 里有）。只要 config.json 带 warning（坏 JSON、
// 或 apiKeyEnv 误填成 key 本身），任何会读 embedding 配置的 RPC
// （status / rebuild …）就抛 `ReferenceError: ctx is not defined`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from './store/db.js';
import { apply, createPanelApi, PANEL_METHODS } from '../index.js';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const silent = { warn() {}, info() {} };

function setup(configText) {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-panelcfg-'));
  mkdirSync(join(dir, 'verbatim'), { recursive: true });
  if (configText !== undefined) writeFileSync(join(dir, 'verbatim', 'config.json'), configText);
  const handle = openDb({ dbPath: ':memory:', dshHome: dir, loadVec: false, logger: silent });
  const warnings = [];
  const api = createPanelApi({
    handle,
    dbPath: ':memory:',
    dshHome: dir,
    dbRoot: join(dir, 'verbatim'),
    logger: { warn: (m) => warnings.push(m), info() {} },
  });
  return {
    api,
    warnings,
    cleanup() {
      try { handle.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('config.json 是坏 JSON：panel.status 照常返回，warning 走 logger（不抛 ReferenceError）', async () => {
  const t = setup('{ not json');
  try {
    const r = await t.api.call('status', { sessionId: 's1' });
    assert.equal(r.sessionId, 's1');
    assert.ok(r.vector && typeof r.vector.state === 'string');
    assert.ok(t.warnings.some((w) => w.includes('config.json')), `应记一条 config.json 告警，实际：${t.warnings}`);
  } finally {
    t.cleanup();
  }
});

test('apiKeyEnv 误填成 key 本身：panel.status 不抛，且给出告警', async () => {
  const t = setup(JSON.stringify({ embedding: { apiKeyEnv: 'sk-abcdefghijklmnop' } }));
  try {
    await t.api.call('status', { sessionId: 's1' });
    assert.ok(t.warnings.some((w) => w.includes('apiKeyEnv')));
  } finally {
    t.cleanup();
  }
});

test('PANEL_METHODS 与实际注册的方法一一对应（不多不少）', () => {
  const t = setup();
  try {
    const actual = Object.keys(t.api.methods).sort();
    assert.deepEqual([...PANEL_METHODS].sort(), actual);
  } finally {
    t.cleanup();
  }
});

test('apply(ctx, config) 正常激活并注册生命周期清理（无 ReferenceError）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-apply-'));
  const cleanups = [];
  const ctx = {
    logger: silent,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
    on() { return () => {}; },
    agents: { list: () => [] },
    webServer: { register: () => () => {} },
    get(name) { return name === 'llm' ? null : undefined; },
    get llm() { throw new Error('cannot get property "llm" without inject'); },
  };
  try {
    const dispose = apply(ctx, { dshHome: dir, dbPath: ':memory:' });
    assert.equal(typeof dispose, 'function');
    for (const fn of cleanups) fn();
    dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client.js 在模拟浏览器模块加载器下正常激活并注册侧边栏与设置页（无 ReferenceError）', () => {
  let loadedMod = null;
  const registered = [];
  const ctx = {
    locale: { register: () => () => {}, bind: () => (k) => k },
    effect(fn) {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    sidebarRightTabs: { register: (x) => { registered.push(['tab', x.id]); return () => {}; } },
    slots: {
      inject: (slotName, fn) => { registered.push(['slot', slotName]); return fn(); },
      register: (x) => () => x,
    },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { loadedMod = mod; } } },
    document: {
      head: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', remove: () => {} }),
    },
    React: {
      createElement: (...a) => ({ type: a[0], props: a[1], children: a.slice(2) }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
    },
    console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, encodeURIComponent,
  };
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  assert.equal(loadedMod?.id, 'dsh-verbatim');
  const exportsObj = loadedMod.factory((id) => (id === 'react' ? sandbox.React : null));
  exportsObj.apply(ctx);
  assert.ok(registered.some(([k, v]) => k === 'tab' && v === 'verbatim'));
  assert.ok(registered.some(([k, v]) => k === 'slot' && v === 'sidebar.right.pane.tab'));
  assert.ok(registered.some(([k, v]) => k === 'slot' && v === 'settings.section'));
});
