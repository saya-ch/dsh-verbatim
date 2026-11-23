    /* ══════════════════════════ 取值工具 ══════════════════════════ */

    const msgOf = (e) => (e && e.message ? e.message : String(e));

    function pickNum(...values) {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
          const n = Number(value);
          if (Number.isFinite(n)) return n;
        }
      }
      return undefined;
    }

    function pickNumOrNull(...values) {
      return pickNum(...values) ?? null;
    }

    function pickStr(...values) {
      for (const value of values) {
        if (typeof value === 'string') return value;
      }
      return null;
    }

    function asArray(raw, key) {
      if (Array.isArray(raw)) return raw;
      if (raw && Array.isArray(raw[key])) return raw[key];
      return [];
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    const fmtNum = (n, locale) =>
      typeof n === 'number' && Number.isFinite(n)
        ? n.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')
        : '—';

    /** 「16.2 万字」/「8,120 字」/「162,000 chars」 */
    function charsLabel(n, locale) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
      if (locale === 'zh') {
        if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
        return `${fmtNum(n, 'zh')} 字`;
      }
      return `${fmtNum(n, 'en')} chars`;
    }

    /** 字节数格式化（B / KB / MB / GB） */
    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /** 缩短过长的 sessionId 便于窄栏展示 */
    function shortSid(sid) {
      const s = String(sid ?? '');
      if (s.length <= 22) return s;
      return `${s.slice(0, 12)}…${s.slice(-6)}`;
    }

    /** epoch ms → '2026-11-17'（本地时区；不要用 toISOString，那是 UTC，跨零点会差一天） */
    const fmtDateKey = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };

    /** '2026-11-17' → '11-17' */
    const fmtDay = (date) => {
      const text = String(date ?? '');
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text || '—';
    };

    const fmtClock = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    /** '11-15 01:40' */
    const fmtShort = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    /** 场景时间：'11-15 01:40–02:30' */
    const fmtSceneRange = (startAt, endAt) => {
      if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return '—';
      return `${fmtShort(startAt)}–${fmtClock(endAt)}`;
    };

    const isYMD = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim());

    /** YYYY-MM-DD 按日历加减天数（纯 UTC 日期算术，避免本地时区跨夏令时/零点偏移） */
    function shiftYMD(ymd, deltaDays) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
      if (!m) return null;
      const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    }

    /** 当前本地年月 'YYYY-MM' */
    function currentMonthYMD() {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    }

    async function copyToClipboard(text) {
      const value = String(text ?? '');
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
      if (typeof document !== 'undefined') {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } finally { ta.remove(); }
        if (ok) return true;
      }
      return false;
    }

    /** 安全切分纯文本做关键词高亮，绝不使用 dangerouslySetInnerHTML */
    function renderHighlightedText(text, query, markStyle) {
      const source = String(text ?? '');
      const rawQuery = String(query ?? '').trim();
      if (!source || !rawQuery) return source;
      const terms = Array.from(new Set(
        rawQuery.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      ))
        .sort((a, b) => b.length - a.length)
        .slice(0, 12);
      if (terms.length === 0) return source;
      const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      let re;
      try {
        re = new RegExp(`(${pattern})`, 'gi');
      } catch {
        return source;
      }
      const parts = source.split(re);
      if (parts.length <= 1) return source;
      return parts.map((part, idx) => {
        if (!part) return null;
        return idx % 2 === 1
          ? h('mark', { key: `m${idx}`, style: markStyle }, part)
          : part;
      });
    }

    /**
     * 轻量安全 Markdown 渲染（纯 React 元素，绝不使用 dangerouslySetInnerHTML）。
     * 支持：围栏代码块、标题、引用、有序/无序列表、行内代码、加粗、斜体、删除线、安全链接，
     * 并兼容搜索关键词高亮（highlightQuery）。
     */
    function renderMarkdown(text, opts = {}) {
      const source = String(text ?? '');
      if (!source) return '';
      const query = opts.highlightQuery || '';
      const markStyle = opts.markStyle || S.searchMark;

      const renderInline = (line, keyPrefix) => {
        // 匹配顺序：行内代码 > 链接 > 加粗 > 删除线 > 斜体
        const tokenRe = /(`[^`\n]+`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*)/g;
        const nodes = [];
        let last = 0;
        let idx = 0;
        let m;
        while ((m = tokenRe.exec(line)) !== null) {
          if (m.index > last) {
            nodes.push(renderHighlightedText(line.slice(last, m.index), query, markStyle));
          }
          const raw = m[0];
          const k = `${keyPrefix}-${idx++}`;
          if (raw.startsWith('`')) {
            nodes.push(h('code', { key: k, style: S.mdInlineCode }, renderHighlightedText(raw.slice(1, -1), query, markStyle)));
          } else if (m[2] !== undefined && m[3] !== undefined) {
            nodes.push(h('a', {
              key: k,
              href: m[3],
              target: '_blank',
              rel: 'noopener noreferrer',
              style: S.mdLink,
            }, renderHighlightedText(m[2], query, markStyle)));
          } else if (m[4] !== undefined) {
            nodes.push(h('strong', { key: k, style: { fontWeight: 600 } }, renderHighlightedText(m[4], query, markStyle)));
          } else if (m[5] !== undefined) {
            nodes.push(h('del', { key: k, style: { opacity: 0.7 } }, renderHighlightedText(m[5], query, markStyle)));
          } else if (m[6] !== undefined) {
            nodes.push(h('em', { key: k }, renderHighlightedText(m[6], query, markStyle)));
          }
          last = m.index + raw.length;
        }
        if (last < line.length) {
          nodes.push(renderHighlightedText(line.slice(last), query, markStyle));
        }
        return nodes.length === 1 ? nodes[0] : nodes;
      };

      const splitTableRow = (rowLine) => {
        let s = String(rowLine ?? '').trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        const cells = [];
        let cur = '';
        for (let k = 0; k < s.length; k++) {
          if (s[k] === '\\' && s[k + 1] === '|') {
            cur += '|';
            k += 1;
          } else if (s[k] === '|') {
            cells.push(cur.trim());
            cur = '';
          } else {
            cur += s[k];
          }
        }
        cells.push(cur.trim());
        return cells;
      };

      const parseTableAligns = (sepLine) => {
        if (!sepLine || !sepLine.includes('|')) return null;
        const cells = splitTableRow(sepLine);
        if (cells.length === 0) return null;
        const aligns = [];
        for (const c of cells) {
          if (!/^:?-{2,}:?$/.test(c)) return null;
          if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
          else if (c.endsWith(':')) aligns.push('right');
          else aligns.push('left');
        }
        return aligns;
      };

      const lines = source.replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let bi = 0;

      while (i < lines.length) {
        const line = lines[i];

        // ① 围栏代码块 ```lang
        const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line);
        if (fence) {
          const lang = fence[1] || '';
          const codeLines = [];
          i += 1;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) {
            codeLines.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1; // 跳过结束 ```
          blocks.push(h('div', { key: `b${bi++}`, style: S.mdCodeWrap },
            lang ? h('div', { style: S.mdCodeLang }, lang) : null,
            h('pre', { style: S.mdPre }, h('code', null, renderHighlightedText(codeLines.join('\n'), query, markStyle)))));
          continue;
        }

        // ② 标题 # .. ######
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
          const lvl = heading[1].length;
          blocks.push(h('div', {
            key: `b${bi++}`,
            style: lvl === 1 ? S.mdH1 : lvl === 2 ? S.mdH2 : S.mdH3,
          }, renderInline(heading[2], `h${bi}`)));
          i += 1;
          continue;
        }

        // ②.5 分隔线 --- / *** / ___
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', {
            key: `b${bi++}`,
            style: { border: 'none', borderTop: `1px solid ${BORDER}`, margin: '8px 0' },
          }));
          i += 1;
          continue;
        }

        // ②.8 GFM 表格（表头行 + 分隔行 | --- | --- | + 数据行）
        if (i + 1 < lines.length && line.includes('|')) {
          const aligns = parseTableAligns(lines[i + 1]);
          if (aligns !== null) {
            const headCells = splitTableRow(line);
            const colCount = Math.max(headCells.length, aligns.length);
            i += 2;
            const bodyRows = [];
            while (
              i < lines.length
              && lines[i].trim() !== ''
              && lines[i].includes('|')
              && !/^```/.test(lines[i])
            ) {
              bodyRows.push(splitTableRow(lines[i]));
              i += 1;
            }
            const tKey = bi++;
            const cellStyle = (ci, isHead) => ({
              padding: '4px 8px',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: BORDER,
              textAlign: aligns[ci] || 'left',
              fontWeight: isHead ? 600 : 400,
              background: isHead ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))' : 'transparent',
              verticalAlign: 'top',
              wordBreak: 'break-word',
            });
            blocks.push(h('div', {
              key: `b${tKey}`,
              style: { overflowX: 'auto', margin: '6px 0', maxWidth: '100%' },
            },
              h('table', {
                style: {
                  borderCollapse: 'collapse',
                  width: '100%',
                  fontSize: FS.xs,
                  lineHeight: 1.5,
                },
              },
                h('thead', null,
                  h('tr', null,
                    ...Array.from({ length: colCount }, (_, ci) => h('th', {
                      key: `th-${ci}`,
                      style: cellStyle(ci, true),
                    }, renderInline(headCells[ci] ?? '', `th${tKey}-${ci}`))))),
                bodyRows.length > 0
                  ? h('tbody', null,
                    ...bodyRows.map((r, ri) => h('tr', { key: `tr-${ri}` },
                      ...Array.from({ length: colCount }, (_, ci) => h('td', {
                        key: `td-${ri}-${ci}`,
                        style: cellStyle(ci, false),
                      }, renderInline(r[ci] ?? '', `td${tKey}-${ri}-${ci}`))))))
                  : null)));
            continue;
          }
        }

        // ③ 引用块 >
        if (/^>\s?/.test(line)) {
          const qLines = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            qLines.push(lines[i].replace(/^>\s?/, ''));
            i += 1;
          }
          blocks.push(h('blockquote', { key: `b${bi++}`, style: S.mdQuote },
            ...qLines.map((ql, qi) => h('div', { key: `q${qi}` }, ql ? renderInline(ql, `ql${bi}-${qi}`) : '\u00A0'))));
          continue;
        }

        // ④ 无序列表 - / *
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
            i += 1;
          }
          blocks.push(h('ul', { key: `b${bi++}`, style: S.mdList },
            ...items.map((it, ii) => h('li', { key: `u${ii}`, style: S.mdLi }, renderInline(it, `ul${bi}-${ii}`)))));
          continue;
        }

        // ⑤ 有序列表 1.
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
            i += 1;
          }
          blocks.push(h('ol', { key: `b${bi++}`, style: S.mdList },
            ...items.map((it, ii) => h('li', { key: `o${ii}`, style: S.mdLi }, renderInline(it, `ol${bi}-${ii}`)))));
          continue;
        }

        // ⑥ 空行
        if (line.trim() === '') {
          i += 1;
          continue;
        }

        // ⑦ 普通段落（合并连续非空行，保留换行）
        const pLines = [];
        while (
          i < lines.length
          && lines[i].trim() !== ''
          && !/^```/.test(lines[i])
          && !/^#{1,6}\s+/.test(lines[i])
          && !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[i])
          && !(i + 1 < lines.length && lines[i].includes('|') && parseTableAligns(lines[i + 1]) !== null)
          && !/^>\s?/.test(lines[i])
          && !/^\s*[-*]\s+/.test(lines[i])
          && !/^\s*\d+\.\s+/.test(lines[i])
        ) {
          pLines.push(lines[i]);
          i += 1;
        }
        const pKey = `b${bi++}`;
        blocks.push(h('div', { key: pKey, style: S.mdPara },
          ...pLines.flatMap((pl, pi) => (pi === 0
            ? [h('span', { key: `p${pi}` }, renderInline(pl, `${pKey}-${pi}`))]
            : [h('br', { key: `br${pi}` }), h('span', { key: `p${pi}` }, renderInline(pl, `${pKey}-${pi}`))]))));
      }

      if (blocks.length === 0) return renderHighlightedText(source, query, markStyle);
      return h('div', { style: S.mdRoot }, ...blocks);
    }

    /**
     * 第一个不同的位置（按 UTF-16 码元算，够用且和「第 N 个字」的中文直觉基本吻合）。
     * 一致时返回 -1。
     */
    function firstDiffIndex(a, b) {
      const limit = Math.min(a.length, b.length);
      for (let i = 0; i < limit; i += 1) {
        if (a.charAt(i) !== b.charAt(i)) return i;
      }
      return a.length === b.length ? -1 : limit;
    }

    /* ══════════════════════════ RPC ══════════════════════════ */
    //
    // 契约见 PANEL.md §5：路径 `/verbatim-api/panel.<method>`。
    //   读：GET  + query
    //   写：POST + JSON body（同时把参数镜像到 query，服务端只读 query 也能工作）
    // 这样无论 Host 用哪种取参方式，写操作都不会因为取不到参数而静默失败（E4）。

    const API_PREFIX = `${API}/panel.`;

    function toQuery(params) {
      const usp = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null) continue;
        usp.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      return usp.toString();
    }

    /**
     * 响应信封归一：
     *   - {ok:false} 抛错
     *   - {ok:true, data} / {result} **只有在长得像信封时**才拆包
     *     （`panel.task` 自己就带一个 result 字段，不能把它当信封拆掉）
     *   - 其余原样返回（PANEL §5 的返回值本来就是裸对象）
     */
    function unwrap(body, method) {
      if (body === null || body === undefined) throw new Error(`panel.${method}: 响应是空的`);
      if (typeof body !== 'object') throw new Error(`panel.${method}: 响应不是对象`);
      // **数组是合法的**：PANEL §5 里 panel.flags / panel.timeline / panel.notes
      // 的返回值本身就是数组，不是信封。之前这里一律要求「对象」，
      // 导致这三个接口在界面上报「响应不是对象」（截图可见）。数组直接返回，不走信封拆包。
      if (Array.isArray(body)) return body;
      if (body.ok === false) throw new Error(String(body.error ?? body.message ?? `panel.${method} 失败`));
      // **带 state 的响应不当作错误**（2026-11-18，A3 审计抓到的阻塞 bug）：
      // `panel.task` 失败时返回 `{ state: 'failed', error: '...' }`，没有 ok 字段。
      // 之前这里把它当 RPC 错误抛掉 → applyRebuild 的 catch 误判成「task 接口不存在」
      // → 退回轮询 status → status 永远追不平 → **永远显示「重建中…」，真实错误永远不显示**。
      if (body.ok === undefined && body.state === undefined
        && typeof body.error === 'string' && body.error) throw new Error(body.error);

      const keys = Object.keys(body);
      if (body.ok === true && 'data' in body && keys.length <= 2) return body.data;
      if ('result' in body && (keys.length === 1 || (keys.length === 2 && body.ok === true))) return body.result;
      return body;
    }

    const verbatimListeners = new Set();
    const verbatimBus = {
      emit(type, detail) {
        for (const fn of [...verbatimListeners]) {
          try { fn({ type, detail }); } catch { /* 单个订阅者异常不影响其他 */ }
        }
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        verbatimListeners.add(fn);
        return () => { verbatimListeners.delete(fn); };
      },
    };

    async function callRpc(method, params, mode) {
      const path = `${API_PREFIX}${method}`;
      const write = mode === 'write';
      const query = write ? '' : toQuery(params);
      const url = query ? `${path}?${query}` : path;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
      }, write ? 30000 : 20000);

      let response;
      let text = '';
      try {
        response = await fetch(url, write
          ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params ?? {}),
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          }
          : {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          });
        text = await response.text().catch(() => '');
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`panel.${method} timeout`);
        throw e;
      } finally {
        clearTimeout(timer);
      }

      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        const detail = parsed && (parsed.error ?? parsed.message)
          ? `: ${parsed.error ?? parsed.message}`
          : text
            ? `: ${text.slice(0, 200)}`
            : '';
        const err = new Error(
          response.status === 404
            ? `HTTP 404 (${path})${detail}`
            : `HTTP ${response.status} (panel.${method})${detail}`,
        );
        err.status = response.status;
        if (parsed && typeof parsed.code === 'string') err.code = parsed.code;
        throw err;
      }

      if (parsed === null) throw new Error(`panel.${method}: invalid JSON response`);
      return unwrap(parsed, method);
    }

    const rpcRead = (method, params) => callRpc(method, params, 'read');
    const rpcWrite = (method, params) => callRpc(method, params, 'write');

    /* ══════════════════════════ 响应归一（PANEL §5） ══════════════════════════ */
    //
    // 只做「字段别名」级兼容：契约里的字段名是主路径，
    // 顺带认几个等价写法（msgs/scenes/outOfSurface 之类），避免因为命名小差异
    // 把已经拿到的数据丢掉。**不会凭空编造数字**。

    function normalizeVectorState(raw) {
      const vector = raw && typeof raw.vector === 'object' ? raw.vector : {};
      const state = String(vector.state ?? '').toLowerCase();
      if (state === 'ok' || state === 'normal') return 'ok';
      if (state === 'degraded' || state === 'fallback' || state === 'brute' || state === 'bruteforce') return 'degraded';
      if (state === 'disabled' || state === 'off' || state === 'unset') return 'disabled';
      // 「有 key 但索引空 / 覆盖率低」——语义路实际不会跑，面板不能显示成正常
      if (state === 'empty') return 'empty';
      if (state === 'partial') return 'partial';
      // 2026-11-18：这两种最容易被误报成「正常」
      //   mismatch = 索引模型 ≠ 当前配置（每次查询都会抛 vec:err）
      //   mixed    = 库里混了两套模型的向量（结果无意义）
      if (state === 'mismatch' || state === 'model-mismatch' || state === 'modelmismatch') return 'mismatch';
      if (state === 'mixed' || state === 'inconsistent') return 'mixed';
      // 兼容老响应：只有 hasVec 布尔
      if (typeof raw?.hasVec === 'boolean') return raw.hasVec ? 'ok' : 'degraded';
      if (typeof vector.hasVec === 'boolean') return vector.hasVec ? 'ok' : 'degraded';
      return 'unknown';
    }

    function normalizeStatus(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const st = root.stats && typeof root.stats === 'object' ? root.stats : {};
      const ve = root.vector && typeof root.vector === 'object' ? root.vector : {};
      const en = root.enabled && typeof root.enabled === 'object' ? root.enabled : {};
      const rawRanges = Array.isArray(root.excludeRanges)
        ? root.excludeRanges
        : (root.config && Array.isArray(root.config.excludeRanges) ? root.config.excludeRanges : []);

      return {
        dbExists: typeof root.dbExists === 'boolean' ? root.dbExists : undefined,
        // 缺字段时按 PANEL §3.1 的默认值：两个开关都开。
        // 另外记下「这个字段到底是不是服务端给的」——写操作确认状态时要用（不能自己猜）。
        enabled: {
          record: en.record === undefined ? true : en.record === true,
          tools: en.tools === undefined ? true : en.tools === true,
        },
        enabledKnown: {
          record: typeof en.record === 'boolean',
          tools: typeof en.tools === 'boolean',
        },
        excludeRanges: rawRanges
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            from: pickStr(r.from, r.fromText) ?? '',
            to: pickStr(r.to, r.toText) ?? '',
            reason: pickStr(r.reason) ?? '',
          }))
          .filter((r) => r.from !== '' && r.to !== ''),
        stats: {
          // 这几个数字是面板的「事实陈述」，服务端没给就是 null（界面显示「—」），
          // 绝不用 0 冒充 —— 「其中 0 条不在上下文里」和「不知道」是两回事（D-096）。
          totalMsgs: pickNumOrNull(st.totalMsgs, st.msgs),
          totalChars: pickNumOrNull(st.totalChars, st.chars),
          startAt: pickNumOrNull(st.startAt, st.firstAt),
          compactedMsgs: pickNumOrNull(st.compactedMsgs, st.outOfSurface),
          compactedChars: pickNumOrNull(st.compactedChars, st.outOfSurfaceChars),
          rewindedMsgs: pickNumOrNull(st.rewindedMsgs, st.rewinded),
          excludedMsgs: pickNumOrNull(st.excludedMsgs, st.excluded),
          deletedNotesCount: pickNumOrNull(st.deletedNotesCount, st.deletedNotes),
          sceneCount: pickNumOrNull(st.sceneCount, st.scenes),
          scenesWithGist: pickNumOrNull(st.scenesWithGist),
          llmGistScenes: pickNumOrNull(st.llmGistScenes) ?? 0,
          llmGistRatio: pickNumOrNull(st.llmGistRatio) ?? 0,
          dayCount: pickNumOrNull(st.dayCount),
        },
        llm: root.llm && typeof root.llm === 'object'
          ? {
            ready: root.llm.ready === true,
            enabled: root.llm.enabled === true,
            mode: root.llm.mode === 'local' ? 'local' : 'remote',
            model: pickStr(root.llm.model),
          }
          : { ready: false, enabled: false, mode: 'remote', model: null },
        vector: {
          model: pickStr(ve.model),
          dim: pickNumOrNull(ve.dim),
          indexed: pickNum(ve.indexed) ?? 0,
          total: pickNum(ve.total) ?? 0,
          state: normalizeVectorState(root),
          // 服务端给的降级/未启用说明（B7：要明说，不能假装正常）
          reason: pickStr(ve.reason),

          // ── 索引实体（2026-11-18）───────────────────────────────
          // 白名单之前会**静默吞掉**服务端新加的字段（A1 问题 13），
          // 所以这几个必须显式放行，否则面板永远看不到「混用/不一致」。
          /** 库里全部的模型分组 [{model, dim, count}] —— 混用时有好几组 */
          models: Array.isArray(ve.models)
            ? ve.models
              .filter((m) => m && typeof m.model === 'string')
              .map((m) => ({ model: m.model, dim: pickNumOrNull(m.dim), count: pickNum(m.count) ?? 0 }))
            : [],
          /** 当前配置的模型 {model, dim}；null = 没配 */
          configured: ve.configured && typeof ve.configured === 'object' && typeof ve.configured.model === 'string'
            ? { model: ve.configured.model, dim: pickNumOrNull(ve.configured.dim) }
            : null,
          /** 库里是否只有一种模型 */
          consistent: typeof ve.consistent === 'boolean' ? ve.consistent : null,
          windows: ve.windows && typeof ve.windows === 'object'
            ? {
              total: pickNum(ve.windows.total) ?? 0,
              indexed: pickNum(ve.windows.indexed) ?? 0,
              pending: pickNum(ve.windows.pending) ?? 0,
              kinds: ve.windows.kinds && typeof ve.windows.kinds === 'object'
                ? {
                  window: pickNum(ve.windows.kinds.window) ?? 0,
                  exchange: pickNum(ve.windows.kinds.exchange) ?? 0,
                  thread: pickNum(ve.windows.kinds.thread) ?? 0,
                }
                : null,
            }
            : null,
          /** 库里模型 == 当前配置；null = 无法判断 */
          modelMatch: typeof ve.modelMatch === 'boolean' ? ve.modelMatch : null,
          /** 当前会话待补建的可索引消息条数 */
          pending: pickNumOrNull(ve.pending),
        },
        /** 近期后台任务（用于恢复显示正在运行的索引进度） */
        tasks: Array.isArray(root.tasks) ? root.tasks : [],
        // 服务端主动声明的限制（例如老库的 note 表没有 session_id 列 → 笔记只能全库看）
        warnings: Array.isArray(root.warnings) ? root.warnings.filter((w) => typeof w === 'string' && w) : [],
      };
    }

    function normalizeTimeline(raw) {
      return asArray(raw, 'days').map((day) => ({
        date: String(day?.date ?? ''),
        msgCount: pickNum(day?.msgCount, day?.msgs) ?? 0,
        sceneCount: pickNum(day?.sceneCount, day?.scenes) ?? 0,
        pendingMsgs: pickNum(day?.pendingMsgs) ?? 0,
        chars: pickNum(day?.chars) ?? 0,
        scenes: asArray(day, 'scenes').map((scene) => ({
          id: scene?.id,
          startAt: pickNumOrNull(scene?.startAt),
          endAt: pickNumOrNull(scene?.endAt),
          msgCount: pickNum(scene?.msgCount, scene?.msgs) ?? 0,
          gist: pickStr(scene?.gist),
          gistSource: pickStr(scene?.gistSource),
          locked: scene?.locked === true,
          compacted: scene?.compacted === true,
        })),
      })).filter((day) => day.date !== '');
    }

    /**
     * 场次的「前一场的尾巴」（`scene.lead_in`，D-098/D-100）。
     *
     * 服务端可能是三种形态，一个都不能丢、也不能崩：
     *   - 数组：[{ speaker?, text, at? }]（正常数据）
     *   - 字符串：老数据不是 JSON，服务端原样给出（index.js:917）→ 当成一段背景文字
     *   - 空/坏：[] 
     * PANEL §3.4 要求「和 memory_search 按时间翻返回的一样」，所以这个字段必须渲染出来。
     */
    function normalizeLeadIn(raw) {
      if (Array.isArray(raw)) {
        return raw
          .filter((m) => m && typeof m.text === 'string' && m.text !== '')
          .map((m) => ({
            speaker: m.speaker === 'user' ? 'user' : m.speaker === 'assistant' ? 'assistant' : null,
            text: m.text,
            at: pickNumOrNull(m.at),
          }));
      }
      if (typeof raw === 'string' && raw.trim() !== '') {
        return [{ speaker: null, text: raw, at: null }];
      }
      return [];
    }

    function normalizeSceneDetail(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      return {
        startAt: pickNumOrNull(root.startAt),
        endAt: pickNumOrNull(root.endAt),
        precededBy: pickNumOrNull(root.precededBy),
        followedBy: pickNumOrNull(root.followedBy),
        locked: root.locked === true,
        gist: pickStr(root.gist),
        gistSource: pickStr(root.gistSource),
        msgs: asArray(root, 'msgs').map((m) => ({
          id: m?.id,
          at: pickNumOrNull(m?.at),
          speaker: m?.speaker === 'user' ? 'user' : 'assistant',
          text: String(m?.text ?? ''),
          inSurface: pickNum(m?.inSurface) ?? 1,
          excluded: m?.excluded === 1 || m?.excluded === true,
          media: Array.isArray(m?.media)
            ? m.media
              .filter((md) => md && typeof md.path === 'string' && md.path)
              .map((md) => ({
                id: md.id,
                path: String(md.path),
                width: pickNumOrNull(md.width),
                height: pickNumOrNull(md.height),
                caption: pickStr(md.caption),
              }))
            : [],
        })),
        // 契约 (§5) 里有 leadIn，工具也会渲染它 —— 面板不能当没看见
        leadIn: normalizeLeadIn(root.leadIn),
      };
    }

    function normalizeNote(note) {
      return {
        id: pickNum(note?.id),
        content: String(note?.content ?? ''),
        about: pickStr(note?.about),
        at: pickNumOrNull(note?.at),
      };
    }

    function normalizeFlag(flag) {
      return {
        id: pickNum(flag?.id),
        msgId: pickNum(flag?.msgId),
        reason: pickStr(flag?.reason),
        at: pickNumOrNull(flag?.at),
        snippet: pickStr(flag?.snippet, flag?.text),
      };
    }

    function normalizeSample(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      if (root.id === undefined || root.id === null) return { empty: true };
      const scene = root.scene && typeof root.scene === 'object' ? root.scene : null;
      return {
        empty: false,
        id: pickNum(root.id),
        at: pickNumOrNull(root.at),
        speaker: root.speaker === 'user' ? 'user' : 'assistant',
        text: String(root.text ?? ''),
        scene: scene === null
          ? null
          : {
            startAt: pickNumOrNull(scene.startAt),
            endAt: pickNumOrNull(scene.endAt),
            msgCount: pickNum(scene.msgCount, scene.msgs) ?? 0,
          },
      };
    }

    function normalizeVerify(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const dbText = pickStr(root.dbText, root.db, root.text);
      const logText = pickStr(root.logText, root.log);
      let identical = typeof root.identical === 'boolean' ? root.identical : undefined;
      if (identical === undefined && dbText !== null && logText !== null) identical = dbText === logText;
      return {
        dbText,
        logText,
        identical: identical === true,
        // logText 为 null 时服务端会说清原因（日志轮转/seq 不在日志里），直接用它的原话
        reason: pickStr(root.reason),
      };
    }

    function normalizeSearch(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const sem = root.semantic && typeof root.semantic === 'object' ? root.semantic : {};
      const hits = asArray(root, 'hits').map((hit) => {
        const rawSources = Array.isArray(hit?.sources)
          ? hit.sources
          : (Array.isArray(hit?.routes) ? hit.routes : []);
        const sources = rawSources
          .map((s) => String(s ?? '').toLowerCase())
          .filter(Boolean);
        const sceneObj = hit?.scene && typeof hit.scene === 'object' ? hit.scene : null;
        const rawChunk = hit?.chunk && typeof hit.chunk === 'object' ? hit.chunk : null;
        const rawWindow = hit?.window && typeof hit.window === 'object' ? hit.window : null;
        return {
          id: pickNum(hit?.id, hit?.msgId),
          at: pickNumOrNull(hit?.at),
          speaker: hit?.speaker === 'user' ? 'user' : 'assistant',
          text: String(hit?.text ?? ''),
          sceneId: pickNumOrNull(hit?.sceneId, sceneObj?.id),
          sceneStartAt: pickNumOrNull(hit?.sceneStartAt, sceneObj?.startAt),
          sceneEndAt: pickNumOrNull(hit?.sceneEndAt, sceneObj?.endAt),
          sceneMsgCount: pickNumOrNull(hit?.sceneMsgCount, sceneObj?.msgCount),
          inSurface: pickNum(hit?.inSurface) ?? 1,
          excluded: hit?.excluded === true || hit?.excluded === 1,
          sources,
          score: pickNumOrNull(hit?.score, hit?.similarity, hit?.cosine),
          rerankScore: pickNumOrNull(hit?.rerankScore),
          chunk: rawChunk
            ? {
              idx: pickNum(rawChunk.idx, rawChunk.index, rawChunk.part) ?? 0,
              total: pickNumOrNull(rawChunk.total, rawChunk.count),
              startChar: pickNumOrNull(rawChunk.startChar),
              endChar: pickNumOrNull(rawChunk.endChar),
              text: pickStr(rawChunk.text),
            }
            : null,
          window: rawWindow && typeof rawWindow.text === 'string' && rawWindow.text.trim() !== ''
            ? {
              id: pickNumOrNull(rawWindow.id),
              kind: pickStr(rawWindow.kind),
              startMsgId: pickNumOrNull(rawWindow.startMsgId),
              endMsgId: pickNumOrNull(rawWindow.endMsgId),
              msgCount: pickNum(rawWindow.msgCount) ?? 0,
              text: String(rawWindow.text),
            }
            : null,
          focusExchange: hit?.focusExchange && typeof hit.focusExchange === 'object'
            ? {
              startMsgId: pickNumOrNull(hit.focusExchange.startMsgId),
              endMsgId: pickNumOrNull(hit.focusExchange.endMsgId),
            }
            : null,
          relatedTimeline: Array.isArray(hit?.relatedTimeline)
            ? hit.relatedTimeline
              .filter((rt) => rt && (rt.at != null || rt.sceneId != null))
              .map((rt) => ({ at: pickNumOrNull(rt.at), sceneId: pickNumOrNull(rt.sceneId) }))
            : [],
        };
      });
      const matchedNotes = asArray(root, 'matchedNotes').map((n) => ({
        id: pickNum(n?.id),
        content: String(n?.content ?? ''),
        about: pickStr(n?.about),
        at: pickNumOrNull(n?.at),
        score: pickNumOrNull(n?.score),
        sources: Array.isArray(n?.sources) ? n.sources.map((x) => String(x).toLowerCase()).filter(Boolean) : ['keyword'],
      })).filter((n) => n.id !== undefined && n.content !== '');
      const matchedScenes = asArray(root, 'matchedScenes').map((s) => ({
        id: pickNum(s?.id),
        startAt: pickNumOrNull(s?.startAt),
        endAt: pickNumOrNull(s?.endAt),
        msgCount: pickNum(s?.msgCount) ?? 0,
        gist: String(s?.gist ?? ''),
        sources: Array.isArray(s?.sources) ? s.sources.map((x) => String(x).toLowerCase()).filter(Boolean) : ['keyword'],
        score: pickNumOrNull(s?.score),
      })).filter((s) => s.id !== undefined && s.gist !== '');
      return {
        query: pickStr(root.query) ?? '',
        total: pickNum(root.total) ?? hits.length,
        matchedNotes,
        matchedScenes,
        hits,
        semantic: {
          state: pickStr(sem.state),
          enabled: typeof sem.enabled === 'boolean' ? sem.enabled : (typeof sem.ok === 'boolean' ? sem.ok : undefined),
          used: typeof sem.used === 'boolean' ? sem.used : undefined,
          reranked: sem.reranked === true,
          rerankModel: pickStr(sem.rerankModel),
          rerankError: pickStr(sem.rerankError),
          note: pickStr(sem.note, sem.reason, root.semanticNote),
        },
      };
    }

    function normalizeDeletedNotes(raw) {
      const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const list = Array.isArray(raw)
        ? raw
        : (Array.isArray(root.items) ? root.items : asArray(root, 'notes'));
      const items = list.map((item) => {
        const deletedAt = pickNumOrNull(item?.deletedAt, item?.deleted_at);
        const expiresAt = pickNumOrNull(item?.expiresAt, item?.expires_at)
          ?? (deletedAt !== null ? deletedAt + NOTE_RETENTION_DAYS * DAY_MS : null);
        return {
          id: pickNum(item?.id),
          content: String(item?.content ?? ''),
          about: pickStr(item?.about),
          at: pickNumOrNull(item?.at),
          deletedAt,
          expiresAt,
        };
      });
      return {
        items,
        total: pickNum(root.total) ?? items.length,
      };
    }

