/**
 * client-render.test.js —— 前端组件真实渲染冒烟测试（零外部依赖，模拟 StrictMode + DSH selector hook）。
 *
 * 专门拦截纯 JS 前端最容易踩的四类回归：
 *   1. ReferenceError / 未定义样式常量（如 BRAND_TINT）
 *   2. DSH useSessions(selector) 无参误调用
 *   3. React 18 StrictMode 下 alive.current 未重置导致永久卡在「加载中…」
 *   4. 切换设置页 5 个 Tab / 侧栏 6 个 Tab 时渲染崩溃
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMiniReact() {
  const instances = new Map();
  let currentId = null;
  let hookIdx = 0;

  function getInst(id) {
    let inst = instances.get(id);
    if (!inst) {
      inst = { states: [], refs: [], effects: [], memos: [], cleanups: [] };
      instances.set(id, inst);
    }
    return inst;
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(init) {
      const inst = getInst(currentId);
      const idx = hookIdx++;
      if (!(idx in inst.states)) {
        inst.states[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (val) => {
        inst.states[idx] = typeof val === 'function' ? val(inst.states[idx]) : val;
      };
      return [inst.states[idx], setState];
    },
    useRef(init) {
      const inst = getInst(currentId);
      const idx = hookIdx++;
      if (!(idx in inst.refs)) inst.refs[idx] = { current: init };
      return inst.refs[idx];
    },
    useCallback(fn) {
      hookIdx++;
      return fn;
    },
    useMemo(fn) {
      hookIdx++;
      return fn();
    },
    useEffect(fn, deps) {
      const inst = getInst(currentId);
      const idx = hookIdx++;
      const prev = inst.effects[idx];
      const changed = !prev || !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        inst.effects[idx] = { fn, deps, pending: true };
      }
    },
  };

  /** 递归展开组件树（遇到函数组件自动分配稳定实例 id 并渲染），并执行 StrictMode 效果周期 */
  function renderTree(node, pathKey = 'root', strictFirstPass = false) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((c, i) => renderTree(c, `${pathKey}[${i}]`, strictFirstPass));
    if (typeof node.type === 'function') {
      const key = node.props?.key !== undefined ? `${pathKey}:${node.props.key}` : `${pathKey}:${node.type.name || 'fn'}`;
      const prevId = currentId;
      const prevHook = hookIdx;
      currentId = key;
      hookIdx = 0;
      const out = node.type({ ...node.props, children: node.children });
      const inst = getInst(key);
      // 触发 pending effects（StrictMode 首次挂载：运行 -> 立即 cleanup -> 再运行一次！）
      for (let i = 0; i < inst.effects.length; i++) {
        const eff = inst.effects[i];
        if (!eff || !eff.pending) continue;
        eff.pending = false;
        if (typeof inst.cleanups[i] === 'function') inst.cleanups[i]();
        const c1 = eff.fn();
        if (strictFirstPass) {
          if (typeof c1 === 'function') c1();
          inst.cleanups[i] = eff.fn();
        } else {
          inst.cleanups[i] = c1;
        }
      }
      currentId = prevId;
      hookIdx = prevHook;
      return renderTree(out, key, strictFirstPass);
    }
    return {
      ...node,
      children: (node.children || []).map((c, i) => renderTree(c, `${pathKey}/${node.type}[${i}]`, strictFirstPass)),
    };
  }

  function findAll(tree, pred, acc = []) {
    if (!tree || typeof tree !== 'object') return acc;
    if (Array.isArray(tree)) {
      for (const x of tree) findAll(x, pred, acc);
      return acc;
    }
    if (pred(tree)) acc.push(tree);
    for (const c of tree.children || []) findAll(c, pred, acc);
    return acc;
  }

  function textOf(tree) {
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
    if (!tree || typeof tree !== 'object') return '';
    if (Array.isArray(tree)) return tree.map(textOf).join(' ');
    return (tree.children || []).map(textOf).join(' ');
  }

  return { React, renderTree, findAll, textOf };
}

function loadClientPlugin(React, mockFetch) {
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  let pluginDef = null;
  const slots = {};
  const ctx = {
    locale: {
      add() {},
      register() { return () => {}; },
      bind: () => (k) => k,
      getSnapshot: () => ({ active: 'zh' }),
      preference: 'zh',
    },
    sidebarRightTabs: { register() { return () => {}; } },
    slots: {
      register(meta, Comp) { return { meta, Comp }; },
      inject(name, factory) {
        const item = factory();
        slots[name] = item;
        return () => {};
      },
    },
    effect(fn) { return fn(); },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          pluginDef = spec.factory((mod) => {
            if (mod === 'react') return React;
            throw new Error(`unexpected require: ${mod}`);
          });
        },
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', style: {} }),
      head: { appendChild() {} },
    },
    fetch: mockFetch,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  pluginDef.apply(ctx);
  return slots;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('前端冒烟：SettingsPanel 在 StrictMode + selector useSessions 下渲染全部 5 个 Tab（含会话管理）', async () => {
  const { React, renderTree, findAll, textOf } = createMiniReact();

  const mockFetch = async (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('panel.globalConfig')) {
      body = {
        config: {
          defaults: { record: false, tools: false },
          embedding: { mode: 'remote', model: 'qwen', dim: 1024, baseUrl: 'https://example.com/v1', apiKeyEnv: '' },
          llm: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', autoRefine: false, dailyLimit: 50 },
          rerank: { enabled: false, mode: 'remote', model: '', baseUrl: '', apiKeyEnv: '', topN: 20 },
          search: { defaultLimit: 8 },
          index: { autoIndex: false },
        },
        embedding: { ready: true, mode: 'remote', model: 'qwen', dim: 1024, hasApiKey: true, keySource: 'config' },
        llm: { ready: true, enabled: true, hasHostLlm: true, provider: 'deepseek', model: 'deepseek-chat' },
        rerank: { ready: false, enabled: false, mode: 'remote' },
        vecExt: { loaded: true, path: 'vec0.dll', platform: 'win32', arch: 'x64' },
        path: 'C:/tmp/config.json',
        exists: true,
        warnings: [],
      };
    } else if (u.includes('panel.dbOverview')) {
      body = {
        sessions: [
          { sessionId: 'sess-alpha', totalMsgs: 42, sceneCount: 3, indexedMsgs: 42, llmGistScenes: 2, noteCount: 1, enabled: { record: true, tools: true } },
        ],
      };
    } else if (u.includes('panel.probeLocal')) {
      body = { alive: [], dshModels: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' }] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  // 严格模拟 DSH 的 selector-only useSessions hook（无参调用直接抛错！）
  const strictUseSessions = (selector) => {
    if (typeof selector !== 'function') throw new TypeError('selector is not a function');
    return selector({ byId: { 'sess-alpha': { displayTitle: '测试会话标题' } } });
  };

  const slots = loadClientPlugin(React, mockFetch);
  const SettingsComp = slots['settings.section'].Comp;
  const rootEl = React.createElement(SettingsComp, { useSessions: strictUseSessions });

  // 首次挂载（开启 StrictMode 双挂载周期）
  renderTree(rootEl, 'settings', true);
  await flush();
  let tree = renderTree(rootEl, 'settings', false);

  // 找到所有 role="tab" 按钮，逐个点击并渲染验证
  const tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  assert.equal(tabs.length, 5, '设置页应有 5 个 Tab');

  for (const tabBtn of tabs) {
    tabBtn.props.onClick();
    tree = renderTree(rootEl, 'settings', true);
    await flush();
    tree = renderTree(rootEl, 'settings', false);
  }

  // 切回「会话管理」（第 2 个 Tab）确认数据已加载而非卡在加载中
  tabs[1].props.onClick();
  tree = renderTree(rootEl, 'settings', true);
  await flush();
  tree = renderTree(rootEl, 'settings', false);
  const txt = textOf(tree);
  assert.ok(txt.includes('测试会话标题'), `会话管理页应渲染出真实会话标题，实际文本：${txt.slice(0, 200)}`);
  assert.ok(txt.includes('42'), '会话管理页应渲染出消息统计');
});

test('前端冒烟：PanelSeat 在 StrictMode 下渲染全部 6 个侧栏 Tab 无异常', async () => {
  const { React, renderTree, findAll } = createMiniReact();

  const mockFetch = async (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('panel.status')) {
      body = {
        enabled: { record: true, tools: true },
        excludeRanges: [],
        stats: { totalMsgs: 10, totalChars: 500, sceneCount: 2, scenesWithGist: 2, llmGistScenes: 1, llmGistRatio: 50, dayCount: 1, compactedMsgs: 0, excludedMsgs: 0, deletedNotesCount: 0 },
        vector: { state: 'ok', indexed: 10, total: 10, model: 'qwen', dim: 1024, models: [] },
        llm: { ready: true, enabled: true, model: 'deepseek-chat' },
        tasks: [],
        warnings: [],
      };
    } else if (u.includes('panel.timeline')) {
      body = [{ date: '2026-11-19', msgCount: 10, sceneCount: 1, pendingMsgs: 2, chars: 500, scenes: [{ id: 1, startAt: 1000, endAt: 2000, msgCount: 8, gist: '测试摘要', gistSource: 'llm', locked: true, compacted: false }] }];
    } else if (u.includes('panel.notes')) {
      body = [{ id: 1, content: '测试笔记', about: 'him', at: 1000 }];
    } else if (u.includes('panel.flags')) {
      body = [];
    } else if (u.includes('panel.dbOverview')) {
      body = { dbBytes: 1024, walBytes: 0, schemaVersion: 15, hasVec: true, totals: { sessions: 1, msgs: 10, scenes: 2, notes: 1, deletedNotes: 0, indexedMsgs: 10, pendingMsgs: 0 }, tables: { msg: 10, scene: 2, window: 3, note: 1, flag: 0, chunk: 0, media: 0 }, health: [], sessions: [{ sessionId: 'sess-1', totalMsgs: 10, sceneCount: 2, windowCount: 3, indexedMsgs: 10, noteCount: 1, enabled: { record: true, tools: true } }] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const strictUseSessions = (selector) => {
    if (typeof selector !== 'function') throw new TypeError('selector is not a function');
    return selector({ byId: { 'sess-1': { displayTitle: '主对话' } } });
  };

  const slots = loadClientPlugin(React, mockFetch);
  const PanelComp = slots['sidebar.right.pane.tab'].Comp;
  const rootEl = React.createElement(PanelComp, { sessionId: 'sess-1', useSessions: strictUseSessions });

  renderTree(rootEl, 'panel', true);
  await flush();
  let tree = renderTree(rootEl, 'panel', false);

  const tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  assert.ok(tabs.length >= 6, `侧栏应至少有 6 个 Tab，实际 ${tabs.length}`);
  for (const tabBtn of tabs.slice(0, 6)) {
    tabBtn.props.onClick();
    tree = renderTree(rootEl, 'panel', true);
    await flush();
    tree = renderTree(rootEl, 'panel', false);
  }
});

test('前端回归：windows.kinds / matchedScenes / relatedTimeline 正常渲染，且 POST 不把参数塞进 URL', async () => {
  const { React, renderTree, findAll, textOf } = createMiniReact();
  const seenUrls = [];

  const mockFetch = async (url, init) => {
    const u = String(url);
    seenUrls.push({ url: u, method: init?.method || 'GET' });
    let body = {};
    if (u.includes('panel.status')) {
      body = {
        enabled: { record: true, tools: true, autoRecall: false },
        stats: { msgs: 20, scenes: 3, notes: 1, excludedMsgs: 0, excludedChars: 0, totalChars: 500 },
        vector: {
          state: 'ready',
          model: 'sf:Qwen/Qwen3-Embedding-0.6B@1024',
          dim: 1024,
          indexed: 20,
          total: 20,
          pending: 0,
          windows: { total: 10, indexed: 10, pending: 0, kinds: { window: 0, exchange: 6, thread: 4 } },
        },
        warnings: [],
      };
    } else if (u.includes('panel.flags')) {
      body = [];
    } else if (u.includes('panel.search')) {
      body = {
        query: '测试词',
        total: 1,
        matchedNotes: [],
        matchedScenes: [{ id: 2, startAt: 1700000000000, endAt: 1700000600000, msgCount: 5, gist: '包含测试词的场景', sources: ['keyword'], score: 0.9 }],
        hits: [{
          id: 11,
          at: 1700000100000,
          speaker: 'user',
          text: '测试词原文',
          sceneId: 2,
          sceneStartAt: 1700000000000,
          sceneEndAt: 1700000600000,
          sceneMsgCount: 5,
          sources: ['keyword', 'vector'],
          score: 0.92,
          window: { id: 9, kind: 'thread', startMsgId: 10, endMsgId: 14, msgCount: 5, text: 'thread text' },
          relatedTimeline: [{ at: 1699900000000, sceneId: 1 }],
        }],
        semantic: { used: true, state: 'ready', reranked: true },
      };
    } else if (u.includes('panel.set')) {
      body = { ok: true, key: 'record', value: false };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const slots = loadClientPlugin(React, mockFetch);
  const PanelComp = slots['sidebar.right.pane.tab'].Comp;
  const rootEl = React.createElement(PanelComp, { sessionId: 'sess-reg' });

  renderTree(rootEl, 'reg', true);
  await flush();
  let tree = renderTree(rootEl, 'reg', false);
  const overviewText = textOf(tree);
  assert.match(overviewText, /4.*6|6.*4/, '概览页应渲染 windows.kinds 的 thread/exchange 数量');

  // 触发一次 POST（panel.set）验证 URL 不带 query 参数
  const switches = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'switch');
  assert.ok(switches.length >= 1);
  switches[0].props.onClick();
  await flush();
  const postCall = seenUrls.find((c) => c.url.includes('panel.set'));
  assert.ok(postCall, '应发出 panel.set 请求');
  assert.equal(postCall.method, 'POST');
  assert.equal(postCall.url.includes('?'), false, `POST 请求 URL 不应带 query：${postCall.url}`);

  // 切到搜索 Tab 并执行一次搜索（验证 matchedScenes + relatedTimeline 不抛 ReferenceError）
  const tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  const searchTab = tabs.find((b) => /tab\.search|搜索|Search/i.test(textOf(b))) || tabs[2];
  assert.ok(searchTab);
  searchTab.props.onClick();
  tree = renderTree(rootEl, 'reg', true);
  await flush();
  tree = renderTree(rootEl, 'reg', false);

  const inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.length >= 1);
  inputs[0].props.onChange({ target: { value: '测试词' } });
  tree = renderTree(rootEl, 'reg', false);
  const forms = findAll(tree, (n) => n.type === 'form');
  assert.ok(forms.length >= 1);
  forms[0].props.onSubmit({ preventDefault() {} });
  tree = renderTree(rootEl, 'reg', true);
  await flush();
  tree = renderTree(rootEl, 'reg', false);
  const searchText = textOf(tree);
  assert.match(searchText, /包含\s*测试词\s*的场景/, 'matchedScenes 应正常高亮渲染而不抛 ReferenceError');
  assert.match(searchText, /search\.threadBadge/, 'window.kind=thread 应正常保留并渲染');
  assert.match(searchText, /search\.relatedTimeline/, 'relatedTimeline 应正常保留并渲染');
});

test('前端回归：SettingsPanel 切开关调 patch() 更新 state 不抛 ReferenceError', async () => {
  const { React, renderTree, findAll, textOf } = createMiniReact();
  const baseResp = {
    config: {
      defaults: { record: false, tools: false },
      embedding: { mode: 'remote', model: 'qwen', dim: 1024, baseUrl: 'https://example.com/v1', apiKeyEnv: '' },
      llm: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', autoRefine: false, dailyLimit: 50 },
      rerank: { enabled: false, mode: 'remote', model: '', baseUrl: '', apiKeyEnv: '', topN: 20 },
      search: { defaultLimit: 8 },
      index: { autoIndex: false },
    },
    embedding: { ready: true, mode: 'remote', model: 'qwen', dim: 1024, hasApiKey: false },
    llm: { ready: true, enabled: true, hasHostLlm: true, provider: 'deepseek', model: 'deepseek-chat' },
    rerank: { ready: false, enabled: false, mode: 'remote' },
    vecExt: { loaded: true, path: 'vec0.dll', platform: 'win32', arch: 'x64' },
    path: 'C:/tmp/config.json',
    exists: true,
    warnings: [],
  };
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('panel.setGlobalConfig')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          ...baseResp,
          config: { ...baseResp.config, defaults: { record: true, tools: false } },
          applies: '已保存',
        }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(baseResp) };
  };

  const slots = loadClientPlugin(React, mockFetch);
  const SettingsComp = slots['settings.section'].Comp;
  const rootEl = React.createElement(SettingsComp, {});
  renderTree(rootEl, 'set-patch', true);
  await flush();
  let tree = renderTree(rootEl, 'set-patch', false);

  const switches = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'switch');
  assert.ok(switches.length >= 1);
  switches[0].props.onClick();
  await flush();
  tree = renderTree(rootEl, 'set-patch', false);
  const txt = textOf(tree);
  assert.doesNotMatch(txt, /is not defined|ReferenceError/, 'patch() 不应抛出 ReferenceError');
  assert.match(txt, /已保存/, 'patch() 应正常显示保存提示');
});
