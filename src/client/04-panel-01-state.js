    /* ══════════════════════════ 面板 ══════════════════════════ */

    /**
     * @param {object} props 槽位注入的 props：
     *   sessionId（必带，来自 session 作用域的标准 props）、t（locale 座椅）、
     *   useSessions 等标准 hooks，以及本插件 inject 回来的 sessionId。
     */
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : ((key) => key);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
      const locale = props.locale === 'en' ? 'en' : 'zh';
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null;

      /* ---------- 数据 ---------- */
      const [status, setStatus] = useState(null);
      const [loadErr, setLoadErr] = useState(null);
      const [loading, setLoading] = useState(true);

      const [days, setDays] = useState(null);
      const [notes, setNotes] = useState(null);
      const [flags, setFlags] = useState([]);
      /** 标记列表读失败的原因。「读不出来」和「真的没有」必须分开（D-096） */
      const [flagsErr, setFlagsErr] = useState(null);
      // **按页分开记录**（2026-11-18，A4 BUG 9）：之前一个 tabErr 被三个 load 函数互相重置，
      // 结果「笔记读失败」会被时间轴的刷新洗成「TA 还没记过笔记」—— 读失败被显示成真的没有。
      const [tabErrs, setTabErrs] = useState({});
      /** 记某页的读取失败（null = 清掉） */
      const setTabErr = useCallback((page, msg) => {
        setTabErrs((prev) => (prev[page] === (msg ?? null) ? prev : { ...prev, [page]: msg ?? null }));
      }, []);

      const [sample, setSample] = useState(null);
      const [verify, setVerify] = useState(null);
      const [flagForm, setFlagForm] = useState(null);
      const [editingTerm, setEditingTerm] = useState(null);

      const [tab, setTab] = useState('overview');
      const [openDay, setOpenDay] = useState(null);
      /** 时间轴要拉到多早（天数）。默认 7，点「看更早的」按 7 天递增，到接口上限为止 */
      const [timelineDays, setTimelineDays] = useState(TIMELINE_DAYS);
      /** 时间轴上一次「已经试过」的天数：用来触发重载，同时避免失败后无限重试 */
      const [daysLimit, setDaysLimit] = useState(0);
      const [scene, setScene] = useState(null);

      /* ---------- 搜索 / 回收站 / 排除时段 / 定位高亮 ---------- */
      const [searchQuery, setSearchQuery] = useState('');
      const [searchWhen, setSearchWhen] = useState('');
      const [searchSpeaker, setSearchSpeaker] = useState('all');
      const [searchIncludeExcluded, setSearchIncludeExcluded] = useState(false);
      const [searchResult, setSearchResult] = useState(null);
      const [searchBusy, setSearchBusy] = useState(false);
      const [expandedHits, setExpandedHits] = useState({});
      const [searchHistory, setSearchHistory] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-verbatim:search-history') : null;
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8) : [];
        } catch { return []; }
      });

      const [timelineOnlyCompacted, setTimelineOnlyCompacted] = useState(false);
      const [notesView, setNotesView] = useState('active');
      const [noteFilter, setNoteFilter] = useState('');
      const [noteAboutFilter, setNoteAboutFilter] = useState('all');
      const [noteForm, setNoteForm] = useState(null);
      const [showBackTop, setShowBackTop] = useState(false);
      const bodyRef = useRef(null);
      const [deletedNotes, setDeletedNotes] = useState(null);
      const [deletedNotesTotal, setDeletedNotesTotal] = useState(null);
      const [trashErr, setTrashErr] = useState(null);
      const [trashLoading, setTrashLoading] = useState(false);

      const [excludeForm, setExcludeForm] = useState(null);
      const [copiedKey, setCopiedKey] = useState(null);
      const [highlightMsg, setHighlightMsg] = useState(null);

      /* ---------- 数据库管理台（全库 + 跨会话切换视图，默认优先当前会话） ---------- */
      const sqlEscSid = String(sessionId || '').replace(/'/g, "''");
      const defaultDbSql = sessionId
        ? `SELECT id, seq, speaker, in_surface, vec_model, substr(text, 1, 80) AS preview FROM msg WHERE session_id = '${sqlEscSid}' ORDER BY seq DESC LIMIT 20`
        : 'SELECT session_id, COUNT(*) AS msgs, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM msg GROUP BY session_id ORDER BY msgs DESC';
      const [dbSubTab, setDbSubTab] = useState('sessions');
      const [dbOverview, setDbOverview] = useState(null);
      const [dbOverviewBusy, setDbOverviewBusy] = useState(false);
      const [dbSession, setDbSession] = useState(sessionId || '');
      const [dbTable, setDbTable] = useState('msg');
      const [dbWindowKind, setDbWindowKind] = useState('');
      const [dbVecFilter, setDbVecFilter] = useState('');
      const [dbFilter, setDbFilter] = useState('');
      const [dbPage, setDbPage] = useState(0);
      const [dbPageInput, setDbPageInput] = useState('1');
      useEffect(() => { setDbPageInput(String(dbPage + 1)); }, [dbPage]);
      const [mediaPreviews, setMediaPreviews] = useState({});
      const [indexAdvOpen, setIndexAdvOpen] = useState(false);
      const [recallOpen, setRecallOpen] = useState(false);
      const [recallItems, setRecallItems] = useState(null);
      const [recallBusy, setRecallBusy] = useState(false);
      const [dupGroups, setDupGroups] = useState(null);
      const [dupBusy, setDupBusy] = useState(false);
      const [sceneOpBusy, setSceneOpBusy] = useState('');
      const [editingGist, setEditingGist] = useState(null); // { sceneId, text }
      const [editingNote, setEditingNote] = useState(null); // { id, text }
      const [dbRowsData, setDbRowsData] = useState(null);
      const [dbRowsBusy, setDbRowsBusy] = useState(false);
      const [dbExpandedRow, setDbExpandedRow] = useState(null);
      const [dbSql, setDbSql] = useState(defaultDbSql);
      const [dbSqlBusy, setDbSqlBusy] = useState(false);
      const [dbSqlRes, setDbSqlRes] = useState(null);
      const [dbSqlErr, setDbSqlErr] = useState(null);
      const [dbActionBusy, setDbActionBusy] = useState('');
      const [dbTask, setDbTask] = useState(null);
      const [batchVerify, setBatchVerify] = useState(null);
      const [verifyIdInput, setVerifyIdInput] = useState('');

      const [busy, setBusyRaw] = useState('');
      // **计数器**（2026-11-18，A4 BUG 8）：`busy` 之前是单槽字符串，
      // 两个写操作同时在跑时，先完成的那个 `finally setBusy('')` 会把
      // 另一个的 disabled 也打开 —— 于是「开关点了没反应」或「连点发出两次写」。
      // 现在清空只在计数归零时发生，第二个操作还在跑就不清。
      const busyCount = useRef(0);
      const setBusy = useCallback((value) => {
        if (value === '') {
          busyCount.current = Math.max(0, busyCount.current - 1);
          if (busyCount.current === 0) setBusyRaw('');
        } else {
          busyCount.current += 1;
          setBusyRaw(value);
        }
      }, []);
      const [flash, setFlash] = useState(null);
      const [rebuild, setRebuild] = useState(null);
      const [initConfirm, setInitConfirm] = useState(false);

      /** 只让最后一次请求的响应落地（切会话/连点时不会串数据） */
      const reqSeq = useRef(0);
      /** 每个列表独立的序号：只认最后一次请求（2026-11-18，A4 BUG 5/7/13） */
      const listSeq = useRef({ days: 0, notes: 0, deletedNotes: 0, flags: 0, scene: 0, search: 0, dbOverview: 0, dbRows: 0 });
      const pollTimer = useRef(null);
      const dbTaskTimer = useRef(null);
      const dbPollSeq = useRef(0);
      const pollingTaskRef = useRef(null);
      const copyTimer = useRef(null);
      const highlightTimer = useRef(null);
      const msgRefs = useRef(new Map());
      const searchInputRef = useRef(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          pollingTaskRef.current = null;
          if (pollTimer.current) clearTimeout(pollTimer.current);
          if (dbTaskTimer.current) clearTimeout(dbTaskTimer.current);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          if (highlightTimer.current) clearTimeout(highlightTimer.current);
        };
      }, []);

      /* ---------- 读 ---------- */

      const loadStatus = useCallback(async () => {
        if (!sessionId) {
          setStatus(null);
          setLoading(false);
          return null;
        }
        const mine = (reqSeq.current += 1);
        setLoading(true);
        setLoadErr(null);
        try {
          const raw = await rpcRead('status', { sessionId });
          if (!alive.current || mine !== reqSeq.current) return null;
          const next = normalizeStatus(raw);
          setStatus(next);
          return next; // 给写操作确认状态用（服务端为准，不靠猜）
        } catch (e) {
          if (!alive.current || mine !== reqSeq.current) return null;
          setStatus(null);
          setLoadErr(msgOf(e));
          return null;
        } finally {
          if (alive.current && mine === reqSeq.current) setLoading(false);
        }
      }, [sessionId]);

      const loadFlags = useCallback(async () => {
        if (!sessionId) {
          setFlags([]);
          setFlagsErr(null);
          return;
        }
        const mine = (listSeq.current.flags += 1);
        const stale = () => !alive.current || mine !== listSeq.current.flags;
        try {
          const raw = await rpcRead('flags', { sessionId, limit: FLAGS_LIMIT });
          if (stale()) return;
          setFlags(asArray(raw, 'flags').map(normalizeFlag).filter((f) => f.msgId !== undefined));
          setFlagsErr(null);
        } catch (e) {
          // **不能**把失败当成「没有标记」：那会造成界面误导（用户标过 3 条却被告知一条都没有）。
          // 保留上一次读到的列表，同时把失败原因摆出来。
          if (stale()) return;
          setFlagsErr(msgOf(e));
        }
      }, [sessionId]);

      const loadDays = useCallback(async () => {
        const mine = (listSeq.current.days += 1);
        const stale = () => !alive.current || mine !== listSeq.current.days;
        // 只清自己这一页的错误（之前会把笔记页的失败一起洗掉 → 假空态）
        setTabErr('timeline', null);
        try {
          // limit 是「天数」，不是消息数（index.js:842）。timelineDays 由「看更早的」递增。
          const raw = await rpcRead('timeline', { sessionId, limit: timelineDays });
          if (stale()) return;
          setDays(normalizeTimeline(raw));
          setDaysLimit(timelineDays);
        } catch (e) {
          // 失败时**保留已经看到的列表**，不要把页面清空（更早几天读不出来不该让人丢掉现有内容）。
          // daysLimit 也一起记下：表示这个范围「已经试过」，避免 effect 无限重试。
          if (stale()) return;
          setDays((prev) => prev ?? []);
          setDaysLimit(timelineDays);
          setTabErr('timeline', msgOf(e));
        }
      }, [sessionId, timelineDays, setTabErr]);

      const loadNotes = useCallback(async () => {
        const mine = (listSeq.current.notes += 1);
        const stale = () => !alive.current || mine !== listSeq.current.notes;
        setTabErr('notes', null);
        try {
          const raw = await rpcRead('notes', { sessionId, limit: NOTES_LIMIT, offset: 0 });
          if (stale()) return;
          setNotes(asArray(raw, 'notes').map(normalizeNote));
        } catch (e) {
          if (stale()) return;
          setNotes((prev) => prev ?? []);
          setTabErr('notes', msgOf(e));
        }
      }, [sessionId, setTabErr]);

      const loadDeletedNotes = useCallback(async () => {
        if (!sessionId) return;
        const mine = (listSeq.current.deletedNotes += 1);
        const stale = () => !alive.current || mine !== listSeq.current.deletedNotes;
        setTrashLoading(true);
        setTrashErr(null);
        try {
          const raw = await rpcRead('deletedNotes', { sessionId });
          if (stale()) return;
          const norm = normalizeDeletedNotes(raw);
          setDeletedNotes(norm.items);
          setDeletedNotesTotal(norm.total);
        } catch (e) {
          if (stale()) return;
          setDeletedNotes((prev) => prev ?? []);
          setTrashErr(msgOf(e));
        } finally {
          if (!stale()) setTrashLoading(false);
        }
      }, [sessionId]);

      const loadDbOverview = useCallback(async () => {
        const mine = (listSeq.current.dbOverview += 1);
        const stale = () => !alive.current || mine !== listSeq.current.dbOverview;
        setDbOverviewBusy(true);
        setTabErr('dbOverview', null);
        try {
          const raw = await rpcRead('dbOverview', {});
          if (stale()) return null;
          setDbOverview(raw && typeof raw === 'object' ? raw : null);
          return raw;
        } catch (e) {
          if (stale()) return null;
          setTabErr('dbOverview', msgOf(e));
          return null;
        } finally {
          if (!stale()) setDbOverviewBusy(false);
        }
      }, [setTabErr]);

      const loadDbRows = useCallback(async (opts = {}) => {
        const targetTable = opts.table ?? dbTable;
        const targetSid = opts.sessionId !== undefined ? opts.sessionId : dbSession;
        const targetQuery = opts.query !== undefined ? opts.query : dbFilter;
        const targetKind = opts.kind !== undefined ? opts.kind : dbWindowKind;
        const targetVec = opts.vec !== undefined ? opts.vec : dbVecFilter;
        const targetPage = opts.page !== undefined ? opts.page : dbPage;
        const pageSize = 20;
        const mine = (listSeq.current.dbRows += 1);
        const stale = () => !alive.current || mine !== listSeq.current.dbRows;
        setDbRowsBusy(true);
        setTabErr('dbRows', null);
        try {
          const params = {
            table: targetTable,
            limit: pageSize,
            offset: targetPage * pageSize,
          };
          if (targetSid) params.sessionId = targetSid;
          if (targetQuery && targetQuery.trim()) params.query = targetQuery.trim();
          if (targetTable === 'window' && targetKind) params.kind = targetKind;
          if ((targetTable === 'msg' || targetTable === 'window') && targetVec) params.vec = targetVec;
          const raw = await rpcRead('dbRows', params);
          if (stale()) return;
          setDbRowsData(raw && typeof raw === 'object' ? raw : null);
          setDbExpandedRow(null);
        } catch (e) {
          if (stale()) return;
          setTabErr('dbRows', msgOf(e));
        } finally {
          if (!stale()) setDbRowsBusy(false);
        }
      }, [dbTable, dbSession, dbFilter, dbWindowKind, dbVecFilter, dbPage, setTabErr]);

      useEffect(() => {
        void loadStatus();
        void loadFlags();
      }, [loadStatus, loadFlags]);

      const dbAutoRef = useRef({ overview: false, browse: false });

      // 标签页数据按需加载；`daysLimit !== timelineDays` 时说明「看更早的」还没生效
      useEffect(() => {
        if (tab === 'db') {
          if (dbOverview === null && !dbOverviewBusy && !dbAutoRef.current.overview) {
            dbAutoRef.current.overview = true;
            void loadDbOverview();
          }
          if (dbSubTab === 'browse' && dbRowsData === null && !dbRowsBusy && !dbAutoRef.current.browse) {
            dbAutoRef.current.browse = true;
            void loadDbRows();
          }
          return;
        }
        if (status === null) return;
        // **概览页也要 days**：它画「最近 7 天」的柱状图（2026-11-18）。
        // 之前只在切到时间轴时才加载，导致概览页那块永远是空的。
        if ((tab === 'overview' || tab === 'timeline') && days === null) { void loadDays(); return; }
        if (tab === 'timeline' && daysLimit !== timelineDays) { void loadDays(); return; }
        if (tab === 'notes') {
          if (notesView === 'active' && notes === null) void loadNotes();
          if (notesView === 'trash' && deletedNotes === null && !trashLoading) void loadDeletedNotes();
        }
      }, [status, tab, days, daysLimit, timelineDays, notes, notesView, deletedNotes, trashLoading, dbOverview, dbOverviewBusy, dbSubTab, dbRowsData, dbRowsBusy, loadDays, loadNotes, loadDeletedNotes, loadDbOverview, loadDbRows]);

      useEffect(() => {
        if (tab !== 'timeline' || !highlightMsg || !scene || scene.loading || !scene.detail) return undefined;
        const el = msgRefs.current.get(highlightMsg.id);
        if (!el) return undefined;
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => {
            if (alive.current && el && typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          })
          : null;
        return () => {
          if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        };
      }, [tab, openDay, scene, highlightMsg]);

      useEffect(() => verbatimBus.subscribe((ev) => {
        if (!alive.current || !ev) return;
        if (ev.type === 'globalConfigChanged' || (ev.type === 'sessionChanged' && (!ev.detail?.sessionId || ev.detail.sessionId === sessionId))) {
          void loadStatus();
        }
      }), [sessionId, loadStatus]);

      const refresh = useCallback(async () => {
        setDays(null);
        setNotes(null);
        setDeletedNotes(null);
        setDeletedNotesTotal(null);
        setTrashErr(null);
        setSearchResult(null);
        setExpandedHits({});
        setExcludeForm(null);
        setHighlightMsg(null);
        setSample(null);
        setVerify(null);
        setFlagForm(null);
        setEditingTerm(null);
        setOpenDay(null);
        setScene(null);
        setInitConfirm(false);
        setTabErrs({});
        await loadStatus();
        await loadFlags();
      }, [loadStatus, loadFlags]);

      /* ---------- 写 ---------- */

      const setSwitch = useCallback(async (key, value) => {
        setBusy(`set:${key}`);
        setFlash(null);
        try {
          const result = await rpcWrite('set', { sessionId, key, value });
          // E4 / 诚实原则：**以服务端为准**。写响应和随后的 status 都没给这个字段时，
          // 就说「没确认」，绝不拿自己请求的值冒充已保存的状态。
          const fromWrite = result && result.enabled && typeof result.enabled[key] === 'boolean'
            ? result.enabled[key]
            : null;
          const fresh = await loadStatus();
          const fromStatus = fresh && fresh.enabledKnown && fresh.enabledKnown[key] === true
            ? fresh.enabled[key]
            : null;
          const finalValue = fromWrite !== null ? fromWrite : fromStatus;

          if (finalValue === null) {
            setFlash({ kind: 'warn', text: t('switch.writeUnconfirmed', { name: t(`switch.${key}`) }) });
          } else {
            setFlash({
              kind: 'ok',
              text: t('switch.writeOk', {
                name: t(`switch.${key}`),
                state: finalValue ? t('switch.on') : t('switch.off'),
              }),
            });
          }
        } catch (e) {
          setFlash({ kind: 'err', text: t('switch.writeFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const deleteNote = useCallback(async (id) => {
        setBusy(`note:${id}`);
        setFlash(null);
        try {
          await rpcWrite('deleteNote', { id, sessionId });
          setNotes((prev) => (prev === null ? null : prev.filter((note) => note.id !== id)));
          setDeletedNotes(null);
          await loadStatus();
          if (alive.current) setFlash({ kind: 'ok', text: t('notes.deleteOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.deleteFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const restoreNote = useCallback(async (id) => {
        setBusy(`restore:${id}`);
        setFlash(null);
        try {
          await rpcWrite('restoreNote', { id, sessionId });
          setDeletedNotes((prev) => (prev === null ? null : prev.filter((note) => note.id !== id)));
          setDeletedNotesTotal((prev) => (typeof prev === 'number' ? Math.max(0, prev - 1) : prev));
          await Promise.all([loadNotes(), loadDeletedNotes(), loadStatus()]);
          if (alive.current) setFlash({ kind: 'ok', text: t('notes.restoreOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.restoreFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadNotes, loadDeletedNotes, loadStatus, t]);

      const runSearch = useCallback(async (overrides = {}) => {
        if (!sessionId) return;
        const q = String(overrides.query !== undefined ? overrides.query : searchQuery).trim();
        const when = overrides.when !== undefined ? overrides.when : searchWhen;
        const incExcl = overrides.includeExcluded !== undefined ? overrides.includeExcluded : searchIncludeExcluded;
        if (!q) {
          setSearchResult(null);
          setTabErr('search', null);
          return;
        }
        const mine = (listSeq.current.search += 1);
        const stale = () => !alive.current || mine !== listSeq.current.search;
        setSearchBusy(true);
        setTabErr('search', null);
        // 记录搜索历史（最多保留 8 条）
        setSearchHistory((prev) => {
          const next = [q, ...prev.filter((item) => item !== q)].slice(0, 8);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-verbatim:search-history', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
        try {
          const params = { sessionId, query: q, limit: SEARCH_LIMIT };
          if (when) params.when = when;
          if (incExcl) params.includeExcluded = true;
          const raw = await rpcRead('search', params);
          if (stale()) return;
          setSearchResult(normalizeSearch(raw));
          setExpandedHits({});
        } catch (e) {
          if (stale()) return;
          setTabErr('search', t('search.failed', { err: msgOf(e) }));
        } finally {
          if (!stale()) setSearchBusy(false);
        }
      }, [sessionId, searchQuery, searchWhen, searchIncludeExcluded, setTabErr, t]);

      const saveNewNote = useCallback(async () => {
        if (!sessionId || !noteForm) return;
        const content = String(noteForm.content ?? '').trim();
        if (!content) return;
        setBusy('note:add');
        setFlash(null);
        try {
          await rpcWrite('addNote', {
            sessionId,
            content,
            about: noteForm.about || undefined,
          });
          if (!alive.current) return;
          setNoteForm(null);
          setFlash({ kind: 'ok', text: t('notes.addOk') });
          await loadNotes();
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.addFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, noteForm, loadNotes, setBusy, t]);

      // 成功类提示 4 秒后自动淡出，不长期挡住内容（错误/警告保持常驻）
      useEffect(() => {
        if (!flash || flash.kind !== 'ok') return undefined;
        const timer = setTimeout(() => {
          if (alive.current) setFlash((cur) => (cur === flash ? null : cur));
        }, 4000);
        return () => clearTimeout(timer);
      }, [flash]);

      const handleCopy = useCallback(async (key, text) => {
        try {
          const ok = await copyToClipboard(text);
          if (!ok || !alive.current) return;
          setCopiedKey(key);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => {
            if (alive.current) setCopiedKey(null);
          }, 1800);
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
        }
      }, []);

      const saveExcludeRanges = useCallback(async (nextRanges) => {
        setBusy('excludeRanges');
        setFlash(null);
        try {
          const clean = nextRanges.map((r) => (
            r.reason
              ? { from: r.from, to: r.to, reason: r.reason }
              : { from: r.from, to: r.to }
          ));
          await rpcWrite('setExcludeRanges', { sessionId, ranges: clean });
          setExcludeForm(null);
          setDays(null);
          setSearchResult(null);
          await loadStatus();
          if (alive.current) setFlash({ kind: 'ok', text: t('exclude.saveOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('exclude.saveFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const drawSample = useCallback(async () => {
        setBusy('sample');
        setFlash(null);
        setVerify(null);
        setFlagForm(null);
        try {
          const raw = await rpcRead('sample', { sessionId });
          if (alive.current) setSample(normalizeSample(raw));
        } catch (e) {
          if (alive.current) setSample({ empty: true });
          setFlash({ kind: 'err', text: t('verify.sampleFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, t]);

      const viewRaw = useCallback(async (msgId) => {
        if (msgId === undefined || msgId === null) return;
        setBusy('verify');
        setFlash(null);
        try {
          const raw = await rpcRead('verify', { msgId });
          if (alive.current) setVerify({ msgId, ...normalizeVerify(raw) });
        } catch (e) {
          setFlash({ kind: 'err', text: t('verify.verifyFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [t]);

      const runBatchVerify = useCallback(async (count = 5) => {
        setBusy('batchVerify');
        setFlash(null);
        setBatchVerify({ running: true, items: [], ok: 0, diff: 0, missing: 0 });
        try {
          const seenIds = new Set();
          const picked = [];
          // 最多抽 count * 3 次，避免小会话死循环
          for (let i = 0; i < count * 3 && picked.length < count; i++) {
            const raw = await rpcRead('sample', { sessionId });
            const norm = normalizeSample(raw);
            if (!norm || norm.empty || norm.id === undefined) break;
            if (seenIds.has(norm.id)) continue;
            seenIds.add(norm.id);
            picked.push(norm);
          }
          const items = [];
          let ok = 0;
          let diff = 0;
          let missing = 0;
          for (const item of picked) {
            const vRaw = await rpcRead('verify', { msgId: item.id });
            const v = normalizeVerify(vRaw);
            const comparable = v.dbText !== null && v.logText !== null;
            const kind = !comparable ? 'missing' : (v.identical ? 'ok' : 'diff');
            if (kind === 'ok') ok += 1;
            else if (kind === 'diff') diff += 1;
            else missing += 1;
            items.push({ sample: item, verify: v, kind });
          }
          if (alive.current) {
            setBatchVerify({ running: false, items, ok, diff, missing });
          }
        } catch (e) {
          if (alive.current) {
            setBatchVerify(null);
            setFlash({ kind: 'err', text: t('verify.verifyFail', { err: msgOf(e) }) });
          }
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, t]);

      const markProblem = useCallback(async (msgId) => {
        setBusy('flag');
        setFlash(null);
        try {
          const reason = flagForm && typeof flagForm.reason === 'string' && flagForm.reason.trim()
            ? flagForm.reason.trim()
            : null;
          const result = await rpcWrite('flag', { msgId, reason });
          // 只记一笔（D-167）：样本不动、列表刷新、检索照常
          setFlagForm(null);
          await loadFlags();
          const id = pickNum(result && result.id);
          setFlash({
            kind: 'ok',
            text: id === undefined ? t('verify.markOk') : `${t('verify.markOk')}（#${id}）`,
          });
        } catch (e) {
          setFlash({ kind: 'err', text: t('verify.markFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [flagForm, loadFlags, t]);

      const unflag = useCallback(async (id) => {
        setBusy(`unflag:${id}`);
        setFlash(null);
        try {
          await rpcWrite('unflag', { id });
          await loadFlags();
          setFlash({ kind: 'ok', text: t('verify.unflagOk', { n: 1 }) });
        } catch (e) {
          setFlash({ kind: 'err', text: t('verify.unflagFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [loadFlags, t]);

      const unflagAll = useCallback(async () => {
        const open = flags.filter((flag) => flag.id !== undefined);
        if (open.length === 0) return;
        setBusy('unflagAll');
        setFlash(null);
        let done = 0;
        let failure = null;
        for (const flag of open) {
          try {
            await rpcWrite('unflag', { id: flag.id });
            done += 1;
          } catch (e) {
            failure = msgOf(e);
            break;
          }
        }
        await loadFlags();
        if (alive.current) setBusy('');
        if (failure === null) setFlash({ kind: 'ok', text: t('verify.unflagOk', { n: done }) });
        else setFlash({ kind: 'err', text: t('verify.unflagFail', { err: failure }) });
      }, [flags, loadFlags, t]);

      /**
       * 重建：`panel.rebuild` → { taskId }，然后轮询 `panel.task`（PANEL §5「然后轮询进度」）。
       *
       * 服务端如果没提供 `panel.task`（只实现了 §5 那 15 个方法），退回轮询 `status` —
       * 只是拿不到增量，只能等索引数追平；两条路都有明确的终止态，不会永远转圈。
       */
      const normalizeTaskProgress = (raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const done = pickNum(raw.done) ?? 0;
        const total = pickNumOrNull(raw.total);
        const pct = pickNumOrNull(raw.pct);
        const chunks = pickNum(raw.chunks) ?? 0;
        return {
          phase: pickStr(raw.phase) ?? 'running',
          label: pickStr(raw.label),
          done,
          total,
          pct: pct !== null ? pct : (total !== null && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null),
          chunks,
          updatedAt: pickNum(raw.updatedAt) ?? Date.now(),
        };
      };

      const startTaskPolling = useCallback((initialTaskId, scope, initialProgress = null) => {
        if (pollTimer.current) {
          clearTimeout(pollTimer.current);
          pollTimer.current = null;
        }
        let taskId = initialTaskId;
        pollingTaskRef.current = taskId;

        setRebuild({
          phase: 'running',
          scope,
          progress: normalizeTaskProgress(initialProgress),
          detail: '',
          error: null,
        });

        const summarize = (task, activeScope) => {
          const result = task && task.result && typeof task.result === 'object' ? task.result : {};
          const parts = [];
          const synced = pickNum(result.synced);
          if (synced !== undefined && synced > 0) parts.push(t('index.resultSynced', { n: fmtNum(synced) }));
          const vectors = pickNum(result.msgs, result.vectors, result.indexed, result.written);
          if (activeScope === 'incremental') {
            if (vectors !== undefined && vectors > 0) parts.push(t('index.resultIndexed', { n: fmtNum(vectors) }));
          } else if (vectors !== undefined) {
            parts.push(t('index.resultVectors', { n: fmtNum(vectors) }));
          }
          const chunks = pickNum(result.chunks);
          if (chunks !== undefined && chunks > 0) parts.push(t('index.resultChunks', { n: fmtNum(chunks) }));
          const scenes = pickNum(result.scenes);
          if (scenes !== undefined && activeScope !== 'incremental') {
            parts.push(t('index.resultScenes', { n: fmtNum(scenes) }));
          }
          const skipped = pickStr(result.skipped);
          if (skipped) parts.push(skipped);
          else if (activeScope === 'incremental' && parts.length === 0) parts.push(t('index.syncUpToDate'));
          return parts.join(' · ');
        };

        let lastProgressAt = Date.now();
        let lastSig = '';
        let settled = false;
        // `panel.task` 不可用时的兜底：只有**亲眼看到索引数不满**过，
        // 后面再变满才算完成。否则「本来就满」会被误判成立刻完成（假完成）。
        let seenBelowTotal = false;
        let fullSamples = 0;

        const tick = async () => {
          if (!alive.current || settled) return;
          let terminal = null;
          let resolvedScope = scope;

          if (taskId !== null) {
            try {
              const task = await rpcRead('task', { taskId });
              if (!alive.current || settled) return;
              resolvedScope = pickStr(task && task.scope) ?? scope;
              const state = String(task && task.state ? task.state : '');
              const prog = normalizeTaskProgress(task && task.progress);
              if (prog) {
                const sig = `${prog.phase}:${prog.done}:${prog.total}:${prog.chunks}:${prog.updatedAt}`;
                if (sig !== lastSig) {
                  lastSig = sig;
                  lastProgressAt = Date.now();
                }
              }
              if (state === 'done') {
                terminal = { phase: 'done', scope: resolvedScope, progress: prog, detail: summarize(task, resolvedScope), error: null };
              } else if (state === 'failed') {
                terminal = { phase: 'error', scope: resolvedScope, progress: prog, detail: '', error: pickStr(task.error) ?? '—' };
              } else {
                setRebuild((prev) => ({
                  phase: 'running',
                  scope: resolvedScope,
                  progress: prog ?? (prev ? prev.progress : null),
                  detail: '',
                  error: null,
                }));
              }
            } catch {
              // panel.task 不存在/任务过期：退回看已索引数
              taskId = null;
            }
          } else {
            try {
              const raw = await rpcRead('status', { sessionId });
              if (!alive.current || settled) return;
              const next = normalizeStatus(raw);
              setStatus(next);
              const indexed = next.vector.indexed;
              const total = next.vector.total;
              if (total === 0) {
                // 一条消息都没有：重建等于无事可做，不虚报「重建了 N 条」
                terminal = { phase: 'done', scope, progress: null, detail: '', error: null };
              } else if (indexed < total) {
                seenBelowTotal = true;
                fullSamples = 0;
              } else if (seenBelowTotal) {
                terminal = { phase: 'done', scope, progress: null, detail: '', error: null };
              } else {
                // 索引一直是满的：可能真的瞬间完成，也可能压根没跑起来。
                // 连续几次都满就明说「无法确认」，不要报完成。
                fullSamples += 1;
                if (fullSamples >= 3) {
                  terminal = { phase: 'unsure', scope, progress: null, indexed, total, detail: '', error: null };
                }
              }
            } catch {
              // 读不到就继续等
            }
          }

          if (!alive.current || settled) return;
          if (terminal !== null) {
            settled = true;
            pollingTaskRef.current = null;
            setRebuild(terminal);
            await loadStatus();
            if (resolvedScope === 'incremental' || resolvedScope === 'scene' || resolvedScope === 'derive') {
              void loadDays();
            }
            return;
          }
          if (Date.now() - lastProgressAt > REBUILD_TIMEOUT_MS) {
            settled = true;
            pollingTaskRef.current = null;
            setRebuild({ phase: 'slow', scope: resolvedScope, progress: null, detail: '', error: null });
            return;
          }
          pollTimer.current = setTimeout(tick, REBUILD_POLL_MS);
        };

        pollTimer.current = setTimeout(tick, 350);
      }, [sessionId, loadStatus, loadDays, t]);

      const applyRebuild = useCallback(async (scope, extra = {}) => {
        setBusy(`rebuild:${scope}`);
        setFlash(null);
        setRebuild({ phase: 'running', scope, progress: null, detail: '', error: null });

        let taskId = null;
        let initialProgress = null;
        try {
          const result = await rpcWrite('rebuild', { sessionId, scope, ...extra });
          taskId = result && typeof result.taskId === 'string' && result.taskId ? result.taskId : null;
          initialProgress = result && result.progress ? result.progress : null;
          if (result && result.state === 'failed') throw new Error(result.error ?? '重建失败');
        } catch (e) {
          if (alive.current) {
            setRebuild({ phase: 'error', scope, progress: null, detail: '', error: msgOf(e) });
            setBusy('');
          }
          return;
        }
        if (alive.current) setBusy('');
        startTaskPolling(taskId, scope, initialProgress);
      }, [sessionId, startTaskPolling]);

      // 打开/刷新面板时若后台已有本会话的索引/重建任务在跑，自动恢复轮询显示进度条
      useEffect(() => {
        if (!status || !Array.isArray(status.tasks)) return;
        if (rebuild && rebuild.phase === 'running') return;
        const running = status.tasks.find(
          (tk) => tk && tk.sessionId === sessionId && tk.state === 'running' && typeof tk.taskId === 'string',
        );
        if (running && pollingTaskRef.current !== running.taskId) {
          startTaskPolling(running.taskId, running.scope || 'vector', running.progress ?? null);
        }
      }, [status, sessionId, rebuild, startTaskPolling]);

      /* ---------- 交互 ---------- */

      const toggleDay = (date) => {
        setOpenDay(openDay === date ? null : date);
        setScene(null);
      };

      const openScene = async (sceneId, forceOpen = false) => {
        if (forceOpen && scene && scene.sceneId === sceneId && scene.detail && !scene.error) {
          return;
        }
        // **加载中点第二次 = 取消**（2026-11-18，A4 BUG 6）：
        // 之前没排除 loading，第二次点把 scene 置 null（收起），
        // 随后第一次的响应回来又 setScene(...) → 关了又自己弹开。
        if (!forceOpen && scene && scene.sceneId === sceneId && !scene.error) {
          listSeq.current.scene += 1;    // 让在途响应作废
          setScene(null);
          return;
        }
        // 只认最后一次点击（A4 BUG 7）：点场 5 又点场 6，场 5 的慢响应不许覆盖场 6
        const mine = (listSeq.current.scene += 1);
        const stale = () => !alive.current || mine !== listSeq.current.scene;
        setScene({ sceneId, loading: true, detail: null, error: null });
        try {
          const raw = await rpcRead('sceneDetail', { sceneId });
          if (stale()) return;
          setScene({ sceneId, loading: false, detail: normalizeSceneDetail(raw), error: null });
        } catch (e) {
          if (stale()) return;
          setScene({ sceneId, loading: false, detail: null, error: msgOf(e) });
        }
      };

      const jumpToTimeline = async (hit) => {
        if (!sessionId || !hit) return;
        setFlash(null);
        setTab('timeline');
        try {
          let list = Array.isArray(days) ? days : null;
          const findDayForHit = (arr) => {
            if (!Array.isArray(arr)) return null;
            if (hit.sceneId !== null && hit.sceneId !== undefined) {
              const byScene = arr.find((d) => Array.isArray(d.scenes) && d.scenes.some((s) => s.id === hit.sceneId));
              if (byScene) return byScene;
            }
            if (typeof hit.at === 'number') {
              const key = fmtDateKey(hit.at);
              return arr.find((d) => d.date === key) ?? null;
            }
            return null;
          };

          let targetDayObj = findDayForHit(list);
          if (!targetDayObj) {
            const mine = (listSeq.current.days += 1);
            const raw = await rpcRead('timeline', { sessionId, limit: TIMELINE_MAX });
            if (!alive.current || mine !== listSeq.current.days) return;
            list = normalizeTimeline(raw);
            setTimelineDays(TIMELINE_MAX);
            setDaysLimit(TIMELINE_MAX);
            setDays(list);
            targetDayObj = findDayForHit(list);

            if (!targetDayObj && typeof hit.at === 'number') {
              const rawWindow = await rpcRead('timeline', {
                sessionId,
                from: Math.max(0, hit.at - 2 * DAY_MS),
                to: hit.at + 2 * DAY_MS,
                limit: TIMELINE_DAYS,
              });
              if (!alive.current || mine !== listSeq.current.days) return;
              const extra = normalizeTimeline(rawWindow);
              if (extra.length > 0) {
                const byDate = new Map(list.map((d) => [d.date, d]));
                for (const d of extra) byDate.set(d.date, d);
                list = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
                setDays(list);
                targetDayObj = findDayForHit(list);
              }
            }
          }

          const targetDate = targetDayObj
            ? targetDayObj.date
            : (typeof hit.at === 'number' ? fmtDateKey(hit.at) : null);
          if (targetDate) setOpenDay(targetDate);

          if (hit.id !== undefined && hit.id !== null) {
            setHighlightMsg({ id: hit.id, nonce: Date.now() });
            if (highlightTimer.current) clearTimeout(highlightTimer.current);
            highlightTimer.current = setTimeout(() => {
              if (alive.current) setHighlightMsg(null);
            }, 2800);
          }

          if (hit.sceneId !== null && hit.sceneId !== undefined) {
            await openScene(hit.sceneId, true);
          }
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('search.jumpFail', { err: msgOf(e) }) });
        }
      };

      const openSearchTab = () => {
        setTab('search');
        const focusSoon = () => {
          if (alive.current && searchInputRef.current && typeof searchInputRef.current.focus === 'function') {
            searchInputRef.current.focus();
          }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusSoon);
        else setTimeout(focusSoon, 0);
      };

      /* ---------- 派生状态 ---------- */

      const stats = status ? status.stats : null;
      const vector = status ? status.vector : null;
      const enabled = status ? status.enabled : { record: true, tools: true };

      /** PANEL §4 的四种空态：库不存在 / 没开记录 / 库是空的 / 正常 */
      /** 当前页的读取失败（每页独立，互不干扰） */
      const tabErr = tab === 'db'
        ? (tabErrs.dbOverview || tabErrs.dbRows || null)
        : (tabErrs[tab] ?? null);

      const emptyKind = (() => {
        if (status === null) {
          // 库打不开时 Host 不会挂 RPC（404），或直接报 NO_DB —— 都是「还没有记忆库」
          if (loadErr && /404|410|NO_DB|NO_SUCH_TABLE|no such table|不存在|没有记忆库|打不开/i.test(loadErr)) return 'nodb';
          return null;
        }
        if (status.dbExists === false) return 'nodb';
        if (stats.totalMsgs === 0) return enabled.record ? 'nodata' : 'recordoff';
        return null;
      })();

      const speakerTag = (speaker) => (speaker === 'user'
        ? { text: t('timeline.speaker.user'), color: 'var(--dsw-alias-state-business-primary, #3b66f5)', bg: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b66f5) 6%, transparent)' }
        : { text: t('timeline.speaker.assistant'), color: '#d94862', bg: 'color-mix(in srgb, #d94862 6%, transparent)' });

