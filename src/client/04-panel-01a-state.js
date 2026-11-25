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

