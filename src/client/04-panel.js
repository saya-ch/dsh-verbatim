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

      /* ---------- 头部 ---------- */

      function renderTitle() {
        const dotColor = !enabled.record
          ? LABEL3
          : (vector && (vector.state === 'mismatch' || vector.state === 'mixed' || (vector.pending ?? 0) > 0))
            ? WARN
            : SUCCESS;
        const dotTitle = !enabled.record
          ? t('status.dotOff')
          : (vector && (vector.state === 'mismatch' || vector.state === 'mixed' || (vector.pending ?? 0) > 0))
            ? t('status.dotWarn')
            : t('status.dotActive');

        const isLive = enabled.record && !(vector && (vector.state === 'mismatch' || vector.state === 'mixed' || (vector.pending ?? 0) > 0));
        return h('div', { style: S.titleRow },
          h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
              h('div', { style: S.title }, t('title')),
              h('span', { style: S.statusPill, title: dotTitle },
                h('span', {
                  className: isLive ? 'dvp-dot-live' : undefined,
                  style: { ...S.statusDot, background: dotColor },
                }),
                h('span', null, dotTitle))),
            useSessions !== null && sessionId !== null
              ? h(SessionTitle, { useSessions, sessionId })
              : null),
          h('button', {
            type: 'button',
            style: { ...S.btn, padding: '4px 9px' },
            onClick: refresh,
            disabled: loading === true,
            title: t('common.refresh'),
          }, h(RefreshIcon, { size: 12 }), loading ? '…' : t('common.refresh')));
      }

      function renderSwitches() {
        const iconBadge = (bg, color, icon) => h('span', {
          style: {
            width: 28,
            height: 28,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: bg,
            color,
            flex: '0 0 auto',
          },
        }, icon);
        const rows = [
          h('div', { key: 'record', style: { ...S.swRow, padding: '6px 0' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' } },
              iconBadge(`color-mix(in srgb, ${BRAND} 12%, transparent)`, BRAND, h(MicIcon, { size: 13 })),
              h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                h('div', { style: { ...S.swLabel, fontWeight: 500 } }, t('switch.record')),
                h('div', { style: { fontSize: FS.xs, color: LABEL3, lineHeight: 1.4, marginTop: 1 } }, t('settings.defaultsRecordHint')))),
            h(Switch, {
              checked: enabled.record,
              disabled: busy === 'set:record',
              label: t('switch.record'),
              onChange: (value) => { void setSwitch('record', value); },
            })),
          h('div', { key: 'tools', style: { ...S.swRow, padding: '7px 0 5px', borderTop: `1px solid ${BORDER}` } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' } },
              iconBadge('color-mix(in srgb, #d94862 12%, transparent)', '#d94862', h(BrainIcon, { size: 13 })),
              h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                h('div', { style: { ...S.swLabel, fontWeight: 500 } }, t('switch.tools')),
                h('div', { style: { fontSize: FS.xs, color: LABEL3, lineHeight: 1.4, marginTop: 1 } }, t('settings.defaultsToolsHint')))),
            h(Switch, {
              checked: enabled.tools,
              disabled: busy === 'set:tools',
              label: t('switch.tools'),
              onChange: (value) => { void setSwitch('tools', value); },
            })),
        ];

        // 关掉「记录」要明说已有数据不会丢（PANEL §3.1）
        const hints = [];
        if (status !== null && !enabled.record) {
          hints.push(h('div', { key: 'recordOff', style: { ...S.warnHint, marginTop: 4 } },
            t('switch.recordOff', { n: fmtNum(stats.totalMsgs) })));
        }
        if (status !== null && !enabled.tools) {
          hints.push(h('div', { key: 'toolsOff', style: { ...S.hint, marginTop: 4 } }, t('switch.toolsOff')));
        }
        // D-166：autoRecall 不进面板。协议里留着，这里一个字都不渲染。

        return h('div', null,
          h('div', { style: S.switchCard }, ...rows),
          ...hints);
      }

      function renderStats() {
        if (status === null) return null;
        const pieces = [
          `${fmtNum(stats.totalMsgs)} ${t('common.unitMsgs')}`,
          charsLabel(stats.totalChars, locale),
        ];
        if (stats.startAt !== null) pieces.push(t('stats.from', { date: fmtDay(fmtDateKey(stats.startAt)) }));

        const covPct = vector && vector.total > 0
          ? Math.min(100, Math.round((vector.indexed / vector.total) * 100))
          : 0;
        const pendingCount = vector ? (vector.pending ?? 0) : 0;
        const trashCount = typeof stats.deletedNotesCount === 'number' ? stats.deletedNotesCount : 0;

        return h('div', null,
          // **陪伴记忆主卡**：将对话规模与长期记忆融合为一块温暖的 Hero 卡片
          h('div', { className: 'dvp-card', style: S.coreCard },
            h(SanctuaryArt),
            h('div', { style: { position: 'relative', fontSize: FS.xs, color: LABEL2, marginBottom: 4, fontWeight: 500 } }, pieces.join(' · ')),
            h('div', { style: S.coreRow },
              t('stats.coreBefore') ? h('span', { style: S.coreLabel }, t('stats.coreBefore')) : null,
              h('span', { style: S.coreNum }, fmtNum(stats.compactedMsgs)),
              h('span', { style: S.coreLabel }, t('stats.coreAfter'))),
            h('div', { style: S.coreHint }, t('stats.coreHint'))),

          // 三格快捷指标：带微图标的 Material 3 Tonal 卡片
          h('div', { style: S.kpiGrid },
            h('button', {
              type: 'button',
              className: 'dvp-card dvp-kpi',
              'data-clickable': '1',
              style: S.kpiTile,
              onClick: () => setTab('timeline'),
            },
              h('span', { style: { ...S.kpiLabel, display: 'inline-flex', alignItems: 'center', gap: 5 } },
                h('span', { style: { color: BRAND, display: 'inline-flex' } }, h(MomentIcon, { size: 12 })),
                t('overview.kpiScenes')),
              h('span', { style: { ...S.kpiVal, fontSize: 18, marginTop: 4 } }, `${fmtNum(stats.sceneCount)}`),
              h('span', { style: S.kpiSub },
                typeof stats.dayCount === 'number'
                  ? t('overview.kpiDays', { n: fmtNum(stats.dayCount) })
                  : t('overview.kpiOpen'))),
            h('button', {
              type: 'button',
              className: 'dvp-card',
              'data-clickable': '1',
              style: S.kpiTile,
              onClick: () => {
                if (pendingCount > 0 && (rebuild === null || rebuild.phase !== 'running')) {
                  void applyRebuild('incremental');
                }
              },
            },
              h('span', { style: { ...S.kpiLabel, display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h(SparkIcon, { size: 11 }), t('overview.kpiIndex')),
              h('span', {
                style: {
                  ...S.kpiVal,
                  fontSize: 16,
                  color: vector && (vector.state === 'mismatch' || vector.state === 'mixed')
                    ? WARN
                    : pendingCount > 0 ? BRAND : SUCCESS,
                },
              }, vector && vector.total > 0 ? `${covPct}%` : '—'),
              h('span', { style: S.kpiSub },
                pendingCount > 0
                  ? t('overview.kpiPending', { n: fmtNum(pendingCount) })
                  : (vector ? `${fmtNum(vector.indexed)}/${fmtNum(vector.total)}` : '—'))),
            h('button', {
              type: 'button',
              className: 'dvp-card',
              'data-clickable': '1',
              style: S.kpiTile,
              onClick: () => setTab('notes'),
            },
              h('span', { style: { ...S.kpiLabel, display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h(NoteIcon, { size: 11 }), t('overview.kpiNotes')),
              h('span', { style: { ...S.kpiVal, fontSize: 16 } }, notes !== null ? fmtNum(notes.length) : t('overview.kpiOpen')),
              h('span', { style: S.kpiSub },
                trashCount > 0
                  ? t('overview.kpiTrash', { n: fmtNum(trashCount) })
                  : t('overview.kpiOpen')))),

          // 撤回排除的条数：证明「撤回是真的起作用了」
          h('div', { style: S.rewindLine },
            t('stats.rewinded', { n: fmtNum(stats.rewindedMsgs) }),
            stats.rewindedMsgs === null ? null : h('span', { style: S.rewindHint }, ` ${t('stats.rewindedHint')}`)));
      }

      function stateBadge() {
        if (vector === null) return null;
        if (rebuild && rebuild.phase === 'error') {
          return h('span', { style: S.indexStateWarn }, t('index.rebuildFailedBadge'));
        }
        if (vector.state === 'ok') {
          const hasPending = (vector.pending ?? 0) > 0 || (vector.windows && (vector.windows.pending ?? 0) > 0);
          if (hasPending) return h('span', { style: S.indexStateWarn }, t('index.statePending'));
          return h('span', { style: S.indexStateOk }, t('index.stateOk'));
        }
        if (vector.state === 'degraded') return h('span', { style: S.indexStateWarn }, t('index.stateDegraded'));
        if (vector.state === 'disabled') return h('span', { style: S.indexStateOff }, t('index.stateDisabled'));
        // 有 key 但索引空 / 覆盖率低 —— 语义路实际不会跑，不能显示成「正常」
        if (vector.state === 'empty') return h('span', { style: S.indexStateOff }, t('index.stateEmpty'));
        if (vector.state === 'partial') return h('span', { style: S.indexStateWarn }, t('index.statePartial'));
        // 两种**新状态**（2026-11-18，A1 审计）：之前这两种情况都显示成「正常」，
        // 而实际的语义路每次查询都在报错 —— 这是最典型的「看起来正常其实是坏的」。
        if (vector.state === 'mismatch') return h('span', { style: S.indexStateWarn }, t('index.stateMismatch'));
        if (vector.state === 'mixed') return h('span', { style: S.indexStateWarn }, t('index.stateMixed'));
        // 契约没给 state：**不能假装正常**
        return h('span', { style: S.indexStateWarn }, t('index.stateUnknown'));
      }

      /**
       * 索引卡（2026-11-18 重构）—— 回答作者的三问：
       *   ① 库里用的是什么模型？② 现在配的是什么模型？③ 一致吗 / 混过吗？
       *
       * 之前只有一个拼接出来的内部 id（`sf:qwen@1024 @ 1,024 维`），
       * 既看不出"当前配置"，也看不出"混用"，而且模型名重复了两次。
       */
      function renderIndex() {
        if (status === null) return null;
        /** 库里某套模型的短名（去掉 sf: 前缀和 @dim 后缀，只留人认得出的部分） */
        const shortName = (id) => {
          if (typeof id !== 'string' || id === '') return t('index.modelUnset');
          return id.replace(/^sf:/, '').replace(/@\d+$/, '');
        };
        const models = Array.isArray(vector.models) ? vector.models : [];
        const configured = vector.configured;
        const canRebuild = rebuild === null || rebuild.phase === 'done' || rebuild.phase === 'error'
          || rebuild.phase === 'slow' || rebuild.phase === 'unsure';

        const rows = [];
        const pendingCount = vector.pending ?? 0;
        const winStat = vector.windows && vector.windows.total > 0 ? vector.windows : null;
        const winPendingCount = winStat ? (winStat.pending ?? 0) : 0;
        const needSyncHighlight = pendingCount > 0 || winPendingCount > 0 || vector.state === 'empty' || vector.state === 'partial';
        const needRebuildHighlight = vector.state === 'mismatch' || vector.state === 'mixed';
        const anyIndexBusy = busy.startsWith('rebuild:');
        const showAdv = indexAdvOpen || needRebuildHighlight;

        const covPctRing = vector.total > 0 ? Math.min(100, Math.round((vector.indexed / vector.total) * 100)) : 0;
        const ringColor = (vector.state === 'mismatch' || vector.state === 'mixed')
          ? WARN
          : covPctRing >= 100 ? SUCCESS : BRAND;
        // ① 状态 + 环形就绪度
        rows.push(h('div', { key: 'state', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 } },
          h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: { fontSize: FS.sm, fontWeight: 600, color: LABEL1 } }, t('overview.index')),
            h('div', { style: { marginTop: 2 } }, stateBadge())),
          h(RingProgress, { pct: covPctRing, size: 38, stroke: 3.5, color: ringColor })));

        // ② 可回想消息条数
        rows.push(h('div', { key: 'count', style: { ...S.indexRow, marginTop: 3 } },
          h('span', { style: S.indexLabel }, t('index.count')),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 } },
            h('span', { style: { ...S.indexValue, fontVariantNumeric: 'tabular-nums' } },
              `${fmtNum(vector.indexed)} / ${fmtNum(vector.total)}`),
            pendingCount > 0
              ? h('span', { style: { ...S.tag, fontVariantNumeric: 'tabular-nums' } },
                t('index.pendingCount', { n: fmtNum(pendingCount) }))
              : null)));

        if (winStat) {
          const wk = winStat.kinds;
          const kindDetail = wk && ((wk.thread ?? 0) > 0 || (wk.exchange ?? 0) > 0)
            ? t('index.windowsKinds', { thread: fmtNum(wk.thread ?? 0), exchange: fmtNum(wk.exchange ?? 0) })
            : '';
          rows.push(h('div', { key: 'winCount', style: { ...S.indexRow, marginTop: 3 } },
            h('span', { style: S.indexLabel }, t('index.windowsCount')),
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 } },
              h('span', { style: { ...S.indexValue, fontVariantNumeric: 'tabular-nums' } },
                `${fmtNum(winStat.indexed)} / ${fmtNum(winStat.total)}${kindDetail}`),
              winPendingCount > 0
                ? h('span', { style: { ...S.tag, fontVariantNumeric: 'tabular-nums' } },
                  t('index.pendingCount', { n: fmtNum(winPendingCount) }))
                : null)));
        }

        // 静态覆盖率条（任务运行中时由下方实时进度条接管）
        if (vector.total > 0 && (rebuild === null || rebuild.phase !== 'running')) {
          const cov = Math.min(100, Math.round((vector.indexed / vector.total) * 100));
          const barColor = vector.state === 'mismatch' || vector.state === 'mixed'
            ? WARN
            : cov >= 100 ? SUCCESS : BRAND;
          rows.push(h('div', { key: 'covBar', style: { ...S.progressTrack, marginTop: 6, marginBottom: 2 } },
            h('div', { style: { ...S.progressFill, width: `${cov}%`, background: barColor } })));
        }

        // ③ 常用同步操作 + 高级诊断折叠按钮
        if (canRebuild) {
          rows.push(h('div', {
            key: 'indexPrimaryRow',
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 8, flexWrap: 'wrap' },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              needRebuildHighlight
                ? h('button', {
                  type: 'button',
                  style: S.primaryBtn,
                  disabled: anyIndexBusy,
                  onClick: () => setRebuild({ phase: 'confirm', scope: 'vector', detail: '', error: null }),
                }, t('index.rebuild'))
                : null,
              h('button', {
                type: 'button',
                style: !needRebuildHighlight && needSyncHighlight ? S.primaryBtn : S.btn,
                disabled: anyIndexBusy,
                onClick: () => { void applyRebuild('incremental'); },
              }, t('index.syncIndex'))),
            h('button', {
              type: 'button',
              style: { ...S.linkBtn, fontSize: FS.xs, color: LABEL3 },
              'aria-expanded': showAdv,
              onClick: () => setIndexAdvOpen((v) => !v),
            }, `${showAdv ? '▾' : '▸'} ${showAdv ? t('index.advancedHide') : t('index.advancedShow')}`)));
        } else {
          rows.push(h('button', {
            key: 'advToggleOnly',
            type: 'button',
            style: S.advToggleBtn,
            'aria-expanded': showAdv,
            onClick: () => setIndexAdvOpen((v) => !v),
          }, h('span', null, showAdv ? t('index.advancedHide') : t('index.advancedShow')),
            h('span', null, showAdv ? '▾' : '▸')));
        }

        // ④ 高级诊断与维护（默认折叠，模型异常时自动展开）
        if (showAdv) {
          const advRows = [];
          if (models.length === 0) {
            advRows.push(h('div', { key: 'm0', style: S.indexRow },
              h('span', { style: S.indexLabel }, t('index.modelStored')),
              h('span', { style: S.indexValue }, t('index.modelNever'))));
          } else {
            models.forEach((m, i) => advRows.push(h('div', { key: `m${i}`, style: { ...S.indexRow, marginTop: i === 0 ? 0 : 2 } },
              h('span', { style: S.indexLabel }, i === 0 ? t('index.modelStored') : ''),
              h('span', { style: S.indexValue },
                `${shortName(m.model)} · ${fmtNum(m.dim)} ${t('index.unitDim')}`
                + (models.length > 1 ? ` · ${fmtNum(m.count)} ${t('common.unitMsgs')}` : '')))));
          }
          advRows.push(h('div', { key: 'cfg', style: { ...S.indexRow, marginTop: 2 } },
            h('span', { style: S.indexLabel }, t('index.modelConfigured')),
            h('span', { style: S.indexValue },
              configured === null
                ? t('index.modelUnset')
                : `${shortName(configured.model)} · ${fmtNum(configured.dim)} ${t('index.unitDim')}`)));
          advRows.push(h('div', { key: 'match', style: { ...S.indexRow, marginTop: 2 } },
            h('span', { style: S.indexLabel }, t('index.consistency')),
            h('span', { style: S.indexValue }, consistencyBadge())));

          if (canRebuild) {
            const secBtn = { ...S.btn, padding: '3px 8px', fontSize: FS.xs };
            advRows.push(h('div', {
              key: 'indexActions',
              style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 8, flexWrap: 'wrap' },
            },
              !needRebuildHighlight
                ? h('button', {
                  type: 'button',
                  style: secBtn,
                  disabled: anyIndexBusy,
                  onClick: () => setRebuild({ phase: 'confirm', scope: 'vector', detail: '', error: null }),
                }, t('index.rebuild'))
                : null,
              h('button', {
                type: 'button',
                style: secBtn,
                disabled: anyIndexBusy,
                onClick: () => { void applyRebuild('scene', { useLlm: false }); },
              }, t('index.resplit'))));
          }
          rows.push(h('div', {
            key: 'advBox',
            style: { marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${BORDER}` },
          }, ...advRows));
        }

        // ⑤ 只在与状态不同的情况下说明原因，未配置向量模型时给出设置引导
        if (vector.state === 'disabled') {
          rows.push(h('div', {
            key: 'setupGuide',
            style: {
              ...S.hint,
              marginTop: 6,
              padding: '6px 9px',
              borderRadius: 8,
              background: `color-mix(in srgb, ${BRAND} 6%, transparent)`,
              color: LABEL2,
            },
          }, t('index.setupGuideHint')));
        } else if (vector.reason !== null && vector.state !== 'ok') {
          rows.push(h('div', { key: 'reason', style: { ...S.hint, marginTop: 4 } }, vector.reason));
        }

        if (rebuild !== null) rows.push(h('div', { key: 'rebuild' }, renderRebuild()));

        return h('div', { style: S.indexBox }, ...rows);
      }

      /** 一致性徽标：库里模型 == 当前配置 */
      function consistencyBadge() {
        const models = Array.isArray(vector.models) ? vector.models : [];
        if (models.length > 1) {
          return h('span', { style: S.indexStateWarn }, t('index.consistencyMixed', { n: models.length }));
        }
        if (vector.modelMatch === null) {
          // 库里没有模型 or 不知道当前配置 → 不能说「一致」
          return h('span', { style: S.indexStateOff }, t('index.consistencyUnknown'));
        }
        if (vector.modelMatch === false) {
          return h('span', { style: S.indexStateWarn }, t('index.consistencyMismatch'));
        }
        return h('span', { style: S.indexStateOk }, t('index.consistencyOk'));
      }

      function renderRebuild() {
        if (rebuild === null) return null;
        const isIncremental = rebuild.scope === 'incremental';
        if (rebuild.phase === 'confirm') {
          return h('div', null,
            h('div', { style: { ...S.warnHint, marginTop: 6 } }, t('index.rebuildConfirm')),
            h('div', { style: S.actions },
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                onClick: () => { void applyRebuild('vector'); },
              }, t('index.rebuildYes')),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => setRebuild(null),
              }, t('common.cancel'))));
        }
        if (rebuild.phase === 'running') {
          const prog = rebuild.progress;
          const hasRatio = prog && typeof prog.total === 'number' && prog.total > 0;
          const pctVal = hasRatio
            ? (typeof prog.pct === 'number' ? prog.pct : Math.min(100, Math.round((prog.done / prog.total) * 100)))
            : null;
          const label = (prog && prog.label) || (isIncremental ? t('index.syncRunning') : t('index.rebuildRunning'));
          const chunkSuffix = prog && prog.chunks > 0 ? t('index.progressChunks', { n: fmtNum(prog.chunks) }) : '';
          return h('div', { style: { marginTop: 6 } },
            h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 8 } },
              h('div', { style: S.hint }, label),
              hasRatio
                ? h('div', { style: { ...S.hint, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto', color: LABEL2 } },
                  `${fmtNum(prog.done)} / ${fmtNum(prog.total)}（${pctVal}%）${chunkSuffix}`)
                : null),
            h('div', { style: S.progressTrack },
              hasRatio
                ? h('div', { style: { ...S.progressFill, width: `${pctVal}%` } })
                : h('div', { className: 'dvp-running', style: S.progressPulse })));
        }
        if (rebuild.phase === 'done') {
          const doneLabel = isIncremental ? t('index.syncDone') : t('index.rebuildDone');
          return h('div', { style: { ...S.hint, marginTop: 6, color: SUCCESS } },
            rebuild.detail ? `${doneLabel} ${rebuild.detail}` : doneLabel);
        }
        if (rebuild.phase === 'slow') {
          return h('div', { style: { ...S.hint, marginTop: 6 } }, t('index.rebuildSlow'));
        }
        if (rebuild.phase === 'unsure') {
          // 索引数一直是满的 → 不能报「完成」，也不能报「失败」
          return h('div', { style: { ...S.warnHint, marginTop: 6 } },
            t('index.rebuildUnsure', {
              indexed: fmtNum(rebuild.indexed),
              total: fmtNum(rebuild.total),
            }));
        }
        return h('div', { style: { ...S.hint, marginTop: 6, color: ERROR } },
          t('index.rebuildFail', { err: rebuild.error ?? '—' }));
      }

      function renderWarnings() {
        if (status === null || status.warnings.length === 0) return null;
        return h('div', { style: { ...S.card, borderColor: WARN_BORDER } },
          ...status.warnings.map((warning, index) => h('div', {
            key: String(index),
            style: { ...S.warnHint, marginTop: index === 0 ? 0 : 4 },
          }, `⚠ ${warning}`)));
      }

      /* ---------- 空态（PANEL §4：每种都要说清楚下一步做什么） ---------- */

      function renderEmptyCard() {
        if (emptyKind === null) return null;
        if (emptyKind === 'nodb') {
          return h('div', { style: S.emptyCard },
            h('div', null, t('empty.noDb')),
            initConfirm
              ? h('div', null,
                h('div', { style: { ...S.hint, marginTop: 6 } }, t('empty.initConfirm')),
                h('div', { style: S.actions },
                  h('button', {
                    type: 'button',
                    style: S.primaryBtn,
                    onClick: () => {
                      setInitConfirm(false);
                      void applyRebuild('scene');
                    },
                  }, t('index.rebuildYes')),
                  h('button', { type: 'button', style: S.btn, onClick: () => setInitConfirm(false) }, t('common.cancel'))))
              : h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => setInitConfirm(true),
                }, t('empty.init'))),
            rebuild !== null ? renderRebuild() : null,
            loadErr ? h('div', { style: S.errDetail }, loadErr) : null);
        }
        if (emptyKind === 'recordoff') {
          return h('div', { style: S.emptyCard },
            h('div', null, t('empty.recordOff')),
            h('div', { style: S.actions },
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                disabled: busy === 'set:record',
                onClick: () => { void setSwitch('record', true); },
              }, t('empty.enableRecord'))));
        }
        return h('div', { style: S.emptyCard },
          h('div', null, t('empty.noData')),
          h('div', { style: S.actions },
            h('button', {
              type: 'button',
              style: S.primaryBtn,
              disabled: busy.startsWith('rebuild:') || (rebuild !== null && rebuild.phase === 'running'),
              onClick: () => { void applyRebuild('incremental'); },
            }, t('index.syncIndex'))),
          rebuild !== null ? renderRebuild() : null);
      }

      /* ---------- 标签页：时间轴 ---------- */

      function renderSceneDetail() {
        if (scene === null) return null;
        if (scene.loading) return h(SkeletonGroup, { kind: 'lines', count: 4 });
        if (scene.error) {
          return h('div', { style: { ...S.errorCard, marginTop: 4 } },
            t('timeline.sceneFailed', { err: scene.error }));
        }
        const detail = scene.detail;

        // 「前一场的尾巴」（D-098）：工具 memory_search 时间路会渲染它，面板不能少
        // （PANEL §3.4：点开某场要「看到完整往来，和 memory_search 按时间翻返回的一样」）。
        const leadIn = detail.leadIn.length === 0 ? null : h('div', { style: S.leadInBox },
          h('div', { style: { ...S.dim, marginBottom: 2 } }, t('timeline.leadIn')),
          ...detail.leadIn.map((message, index) => {
            const tag = message.speaker === null ? null : speakerTag(message.speaker);
            return h('div', { key: `lead:${String(index)}`, style: S.leadInRow },
              tag === null ? null : h('span', { style: { ...S.leadInSpeaker, color: tag.color } }, tag.text),
              h('div', { style: S.leadInText }, renderMarkdown(message.text)));
          }));

        if (detail.msgs.length === 0 && leadIn === null) {
          return h('div', { style: { ...S.dim, padding: '4px 2px' } }, t('timeline.sceneEmpty'));
        }

        // 计算当前已加载时间轴里的上一场 / 下一场（支持连续翻阅）
        const flatScenes = [];
        for (const d of (Array.isArray(days) ? days : [])) {
          for (const sc of (Array.isArray(d.scenes) ? d.scenes : [])) {
            flatScenes.push({ date: d.date, id: sc.id });
          }
        }
        const curFlatIdx = flatScenes.findIndex((x) => x.id === scene.sceneId);
        const prevSc = curFlatIdx > 0 ? flatScenes[curFlatIdx - 1] : null;
        const nextSc = curFlatIdx >= 0 && curFlatIdx + 1 < flatScenes.length ? flatScenes[curFlatIdx + 1] : null;
        const sceneCopyId = `scene:${String(scene.sceneId)}`;
        const sceneCopied = copiedKey === sceneCopyId;

        const copyWholeScene = () => {
          const text = detail.msgs
            .map((m) => `[${fmtShort(m.at)}] ${speakerTag(m.speaker).text}：${m.text}`)
            .join('\n');
          void handleCopy(sceneCopyId, text);
        };

        const jumpSiblingScene = (target) => {
          if (!target) return;
          setOpenDay(target.date);
          void openScene(target.id, true);
        };

        const runSceneOp = async (kind, payload, okKey, nextSceneIdFn) => {
          setSceneOpBusy(kind);
          try {
            const res = await rpcWrite(kind, { sessionId, ...payload });
            if (!alive.current) return;
            setFlash({ kind: 'ok', text: t(okKey) });
            await Promise.all([loadDays(), loadStatus()]);
            const nextId = nextSceneIdFn ? nextSceneIdFn(res) : scene.sceneId;
            if (nextId) await openScene(nextId, true);
          } catch (e) {
            if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
          } finally {
            if (alive.current) setSceneOpBusy('');
          }
        };

        const toggleMediaPreview = async (md) => {
          const key = String(md.id);
          if (mediaPreviews[key]) {
            setMediaPreviews((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
            return;
          }
          if (/^https?:\/\//i.test(md.path)) {
            setMediaPreviews((prev) => ({ ...prev, [key]: { ok: true, src: md.path } }));
            return;
          }
          setMediaPreviews((prev) => ({ ...prev, [key]: { loading: true } }));
          try {
            const res = await rpcRead('mediaPreview', { id: md.id });
            setMediaPreviews((prev) => ({
              ...prev,
              [key]: res && res.ok ? { ok: true, src: res.dataUrl || res.url } : { ok: false, reason: res?.reason || '无法预览' },
            }));
          } catch (e) {
            setMediaPreviews((prev) => ({ ...prev, [key]: { ok: false, reason: msgOf(e) } }));
          }
        };

        const llmReadyForScene = Boolean(status && status.llm && status.llm.ready);

        return h('div', { style: { padding: '4px 0 6px' } },
          h('div', { style: { ...S.rowBetween, alignItems: 'center', marginBottom: 6, gap: 6, flexWrap: 'wrap' } },
            h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
              prevSc
                ? h('button', { type: 'button', style: S.copyBtn, onClick: () => jumpSiblingScene(prevSc) }, t('timeline.prevScene'))
                : null,
              nextSc
                ? h('button', { type: 'button', style: S.copyBtn, onClick: () => jumpSiblingScene(nextSc) }, t('timeline.nextScene'))
                : null,
              detail.precededBy
                ? h('button', {
                  type: 'button',
                  style: S.copyBtn,
                  disabled: sceneOpBusy !== '',
                  onClick: () => { void runSceneOp('mergeScene', { sceneId: scene.sceneId }, 'timeline.mergedOk', (r) => r?.mergedSceneId); },
                }, t('timeline.mergePrev'))
                : null,
              llmReadyForScene
                ? h('button', {
                  type: 'button',
                  style: S.copyBtn,
                  disabled: sceneOpBusy !== '',
                  onClick: () => { void runSceneOp('refineOneScene', { sceneId: scene.sceneId }, 'timeline.refinedOneOk'); },
                }, t('timeline.refineOne'))
                : null,
              h('button', {
                type: 'button',
                style: S.copyBtn,
                disabled: sceneOpBusy !== '',
                onClick: () => setEditingGist({ sceneId: scene.sceneId, text: detail.gist || '' }),
              }, t('timeline.editGist'))),
            detail.msgs.length > 0
              ? h('button', {
                type: 'button',
                style: sceneCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                onClick: copyWholeScene,
              }, sceneCopied ? t('common.copied') : t('timeline.copyScene'))
              : null),
          editingGist && editingGist.sceneId === scene.sceneId
            ? h('div', { style: { display: 'flex', gap: 4, marginBottom: 6 } },
              h('input', {
                type: 'text',
                value: editingGist.text,
                onChange: (e) => setEditingGist({ sceneId: scene.sceneId, text: e.target.value }),
                style: { ...S.input, flex: '1 1 auto', padding: '4px 8px', fontSize: FS.xs },
              }),
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                disabled: sceneOpBusy !== '' || !editingGist.text.trim(),
                onClick: () => {
                  const g = editingGist.text.trim();
                  setEditingGist(null);
                  void runSceneOp('setSceneGist', { sceneId: scene.sceneId, gist: g }, 'timeline.gistSavedOk');
                },
              }, t('common.save')),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => setEditingGist(null),
              }, t('common.cancel')))
            : null,
          leadIn,
          detail.msgs.length === 0
            ? h('div', { style: { ...S.dim, padding: '4px 2px' } }, t('timeline.sceneEmpty'))
            : null,
          ...detail.msgs.map((message, index) => {
            const tag = speakerTag(message.speaker);
            const isHit = highlightMsg !== null && highlightMsg.id === message.id;
            const copyId = `msg:${String(message.id)}`;
            const isCopied = copiedKey === copyId;
            return h('div', {
              key: String(message.id),
              ref: (el) => {
                if (el) msgRefs.current.set(message.id, el);
                else msgRefs.current.delete(message.id);
              },
              // **说话人色条**（2026-11-18）：之前所有消息都是同一条灰色左边框，
              // 看不出谁说的；按说话人上色后，扫一眼就知道对话怎么交替的。
              // 打开场景时逐条淡入（错峰 18ms，最多 15 条），比整块闪出来自然。
              className: isHit ? 'dvp-slide dvp-flash-hit dvp-msg-card' : 'dvp-slide dvp-msg-card',
              style: {
                ...S.msgRow,
                borderColor: `color-mix(in srgb, ${tag.color} 22%, ${BORDER})`,
                borderRadius: message.speaker === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                background: tag.bg,
                animationDelay: isHit ? '0ms' : `${Math.min(index, 15) * 18}ms`,
              },
            },
              h('div', { style: { ...S.msgHead, justifyContent: 'space-between' } },
                h('div', { style: S.msgHead },
                  h('span', { style: { ...S.msgSpeaker, color: tag.color } }, tag.text),
                  h('span', { style: S.msgTime }, fmtClock(message.at)),
                  message.inSurface === 0 ? h('span', { style: S.tag }, t('timeline.compacted')) : null,
                  message.excluded ? h('span', { style: S.tag }, t('timeline.mutedTag')) : null),
                h('div', { className: 'dvp-msg-actions', style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  h('button', {
                    type: 'button',
                    style: S.copyBtn,
                    disabled: sceneOpBusy !== '',
                    onClick: () => {
                      void runSceneOp(
                        'setMsgExcluded',
                        { msgId: message.id, excluded: !message.excluded },
                        'common.saved',
                      );
                    },
                  }, message.excluded ? t('timeline.unmuteMsg') : t('timeline.muteMsg')),
                  index > 0
                    ? h('button', {
                      type: 'button',
                      style: S.copyBtn,
                      disabled: sceneOpBusy !== '',
                      onClick: () => { void runSceneOp('splitScene', { sceneId: scene.sceneId, atMsgId: message.id }, 'timeline.splitOk', (r) => r?.rightSceneId); },
                    }, t('timeline.splitHere'))
                    : null,
                  h('button', {
                    type: 'button',
                    style: isCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                    onClick: () => { void handleCopy(copyId, message.text); },
                  }, isCopied ? t('common.copied') : t('common.copy')))),
              h('div', { style: S.msgText }, renderMarkdown(message.text)),
              Array.isArray(message.media) && message.media.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                  ...message.media.map((md, mi) => {
                    const isHttp = /^https?:\/\//i.test(md.path);
                    const isInline = md.path.startsWith('inline:');
                    const base = md.path.split(/[\\/]/).pop() || md.path;
                    const dims = md.width && md.height ? ` (${md.width}×${md.height})` : '';
                    const mCopyId = `media:${String(md.id ?? `${message.id}-${mi}`)}`;
                    const mCopied = copiedKey === mCopyId;
                    const pv = md.id !== undefined ? mediaPreviews[String(md.id)] : null;
                    return h('div', { key: mCopyId, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('div', {
                        style: {
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 7px',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: BORDER,
                          borderRadius: RADIUS_SM,
                          background: 'var(--dsw-alias-bg-layer-1, transparent)',
                          fontSize: FS.xs,
                          color: LABEL2,
                          maxWidth: '100%',
                          alignSelf: 'flex-start',
                        },
                      },
                        isHttp
                          ? h('a', { href: md.path, target: '_blank', rel: 'noopener noreferrer', style: S.mdLink, title: md.path }, `🖼 ${base}${dims}`)
                          : h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: md.path }, `🖼 ${base}${dims}`),
                        !isInline && md.id !== undefined
                          ? h('button', {
                            type: 'button',
                            style: S.copyBtn,
                            onClick: () => { void toggleMediaPreview(md); },
                          }, t('timeline.previewImg'))
                          : null,
                        h('button', {
                          type: 'button',
                          style: mCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                          onClick: () => { void handleCopy(mCopyId, md.path); },
                        }, mCopied ? t('common.copied') : t('common.copy'))),
                      md.caption ? h('div', { style: { fontSize: FS.xs, color: LABEL3 } }, md.caption) : null,
                      pv && pv.loading ? h('div', { style: { fontSize: FS.xs, color: LABEL3 } }, t('common.loading')) : null,
                      pv && pv.ok && pv.src
                        ? h('img', {
                          src: pv.src,
                          alt: base,
                          style: { maxWidth: 240, maxHeight: 180, borderRadius: RADIUS_SM, border: `1px solid ${BORDER}`, objectFit: 'contain' },
                        })
                        : null,
                      pv && pv.ok === false
                        ? h('div', { style: { fontSize: FS.xs, color: WARN } }, pv.reason)
                        : null);
                  }))
                : null);
          }));
      }

      function renderTimeline() {
        // 读失败时上面的错误带已经在说了，这里**不能**再显示「还没有按天的记录」
        if (days === null) return tabErr !== null ? null : h(SkeletonGroup, { kind: 'rows', count: 5 });
        const off = vector !== null && vector.state === 'disabled'
          ? h('div', { style: { ...S.hint, marginBottom: 6 } }, t('index.semanticOff'))
          : null;
        const searchShortcut = h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
          h('button', {
            type: 'button',
            style: { ...S.searchEntryBtn, flex: '1 1 auto' },
            'data-clickable': '1',
            onClick: openSearchTab,
          },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' } },
              h(SearchIcon, { size: 13 }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('overview.searchEntry')))),
          h('button', {
            type: 'button',
            'aria-pressed': timelineOnlyCompacted,
            style: timelineOnlyCompacted ? { ...S.pill, ...S.pillActive } : S.pill,
            onClick: () => setTimelineOnlyCompacted((v) => !v),
          }, t('timeline.onlyCompacted')));
        if (days.length === 0) {
          return tabErr !== null ? null : h('div', null, off, searchShortcut, h('div', { style: S.emptyCard }, t('empty.timeline')));
        }
        const visibleDays = timelineOnlyCompacted
          ? days
            .map((d) => ({ ...d, scenes: d.scenes.filter((sc) => sc.compacted) }))
            .filter((d) => d.scenes.length > 0)
          : days;
        if (visibleDays.length === 0) {
          return h('div', null, off, searchShortcut, h('div', { style: S.emptyCard }, t('timeline.noScenes')));
        }
        return h('div', null, off, searchShortcut, ...visibleDays.map((day) => {
          const expanded = openDay === day.date;
          return h('div', { key: day.date, style: { marginBottom: 2 } },
            h('button', {
              type: 'button',
              style: S.dayRow,
              'data-clickable': '1',
              'aria-expanded': expanded,
              onClick: () => toggleDay(day.date),
            },
              h('span', { style: { ...S.dayCaret, transform: expanded ? 'rotate(90deg)' : 'none' } }, '▸'),
              h('span', { style: S.dayDate }, fmtDay(day.date)),
              h('span', { style: S.dayDash }),
              h('span', { style: S.dayMeta },
                `${fmtNum(day.msgCount)} ${t('common.unitMsgs')} / ${fmtNum(day.sceneCount)} ${t('common.unitScenes')} / ${charsLabel(day.chars, locale)}`)),
            expanded
              ? h('div', { className: 'dvp-fade', style: { padding: '2px 0 6px 0' } },
                (day.pendingMsgs ?? 0) > 0
                  ? h('div', {
                    style: {
                      padding: '6px 10px',
                      marginBottom: 6,
                      borderRadius: RADIUS_SM,
                      border: `1px dashed ${BORDER}`,
                      fontSize: FS.xs,
                      color: LABEL2,
                    },
                  }, t('timeline.pendingMsgs', { n: fmtNum(day.pendingMsgs) }))
                  : null,
                day.scenes.length === 0
                  ? ((day.pendingMsgs ?? 0) > 0 ? null : h('div', { style: { ...S.dim, padding: '4px 2px' } }, t('timeline.noScenes')))
                  : h('div', { className: 'dvp-spine', style: S.sceneList },
                    ...day.scenes.map((item, index) => h('div', {
                      key: `${day.date}:${String(item.id)}`,
                      style: S.sceneItem,
                    },
                      // 节点钉在竖线上；展开的这场实心高亮
                      h('span', {
                        className: scene !== null && scene.sceneId === item.id ? 'dvp-node' : undefined,
                        style: scene !== null && scene.sceneId === item.id
                          ? { ...S.sceneDot, ...S.sceneDotOn }
                          : S.sceneDot,
                      }),
                      h('button', {
                        type: 'button',
                        // 错峰滑入：一条一条下来，最多错开 12 条（再往后就一起进来，免得等太久）
                        className: 'dvp-slide',
                        style: {
                          ...S.sceneRow,
                          animationDelay: `${Math.min(index, 12) * 22}ms`,
                        },
                        'data-clickable': '1',
                        onClick: () => { void openScene(item.id); },
                      },
                        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                            h('span', { style: S.sceneTime }, fmtSceneRange(item.startAt, item.endAt)),
                            h('span', { style: S.sceneMeta }, t('timeline.sceneMsgs', { n: fmtNum(item.msgCount) })),
                            item.gistSource === 'llm' ? h('span', { style: S.sourceBadgeVec, title: 'LLM' }, '✨') : null,
                            item.locked ? h('span', { style: S.tag, title: 'Locked' }, '🔒') : null,
                            item.compacted ? h('span', { style: S.tag }, t('timeline.compacted')) : null),
                          item.gist
                            ? h('div', {
                              style: {
                                fontSize: FS.xs,
                                color: LABEL3,
                                marginTop: 2,
                                lineHeight: 1.45,
                                whiteSpace: 'normal',
                                wordBreak: 'break-word',
                              },
                            }, item.gist)
                            : null)),
                      scene !== null && scene.sceneId === item.id ? renderSceneDetail() : null))))
              : null);
        }),
          days.length >= timelineDays
            ? h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 10 } },
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => setTimelineDays((d) => d + 7),
              }, t('common.loadMore')))
            : null);
      }

      /* ---------- 标签页：搜索 ---------- */

      function renderSearch() {
        const monthVal = currentMonthYMD();
        const whenOptions = [
          { value: '', label: t('search.whenAll') },
          { value: '7d', label: t('search.when7d') },
          { value: '30d', label: t('search.when30d') },
          { value: monthVal, label: t('search.whenMonth') },
        ];

        const sourceBadge = (hit) => {
          const srcs = Array.isArray(hit.sources) ? hit.sources : [];
          const hasKw = srcs.includes('keyword');
          const hasVec = srcs.includes('vector');
          const scoreText = typeof hit.score === 'number' ? ` ${hit.score.toFixed(2)}` : '';
          if (hasKw && hasVec) {
            return h('span', { style: S.sourceBadgeBoth }, `${t('search.sourceBoth')}${scoreText}`);
          }
          if (hasVec) {
            return h('span', { style: S.sourceBadgeVec }, `${t('search.sourceVector')}${scoreText}`);
          }
          return h('span', { style: S.sourceBadgeKw }, t('search.sourceKeyword'));
        };

        const activeQuery = (searchResult && searchResult.query) || searchQuery;

        let content = null;
        if (searchBusy) {
          content = h(SkeletonGroup, { kind: 'cards', count: 3 });
        } else if (searchResult === null) {
          content = tabErr !== null ? null : h('div', { style: S.emptyCard }, t('search.prompt'));
        } else {
          const semNote = searchResult.semantic && searchResult.semantic.note
            ? h('div', { style: { ...S.hint, marginBottom: 6 } }, searchResult.semantic.note)
            : null;
          const matchedNotes = Array.isArray(searchResult.matchedNotes) ? searchResult.matchedNotes : [];
          const matchedScenes = Array.isArray(searchResult.matchedScenes) ? searchResult.matchedScenes : [];
          const visibleHits = searchSpeaker === 'all'
            ? searchResult.hits
            : searchResult.hits.filter((hit) => hit.speaker === searchSpeaker);
          const summary = h('div', { style: S.searchSummary },
            h('span', null, t('search.total', { n: fmtNum(searchSpeaker === 'all' ? searchResult.total : visibleHits.length) })),
            searchSpeaker === 'all' && searchResult.hits.length < searchResult.total
              ? h('span', null, t('search.shown', { n: fmtNum(searchResult.hits.length) }))
              : null,
            searchResult.semantic && searchResult.semantic.reranked
              ? h('span', { style: S.sourceBadgeBoth }, t('search.rerankedBadge'))
              : null);

          const notesBlock = matchedNotes.length > 0
            ? h('div', { style: { marginBottom: 10 } },
              h('div', { style: { ...S.sectionTitle, marginBottom: 6 } },
                t('search.matchedNotes', { n: fmtNum(matchedNotes.length) })),
              ...matchedNotes.map((n) => {
                const hasKw = n.sources.includes('keyword');
                const hasVec = n.sources.includes('vector');
                const scoreText = typeof n.score === 'number' ? ` ${n.score.toFixed(2)}` : '';
                const badgeStyle = hasKw && hasVec ? S.sourceBadgeBoth : hasVec ? S.sourceBadgeVec : S.sourceBadgeKw;
                const badgeText = hasKw && hasVec
                  ? `${t('search.noteBoth')}${scoreText}`
                  : hasVec
                    ? `${t('search.noteVec')}${scoreText}`
                    : t('search.noteKw');
                const aboutLabel = n.about ? t(`notes.about.${n.about}`) : null;
                return h('div', {
                  key: `note-${n.id}`,
                  className: 'dvp-card',
                  'data-clickable': '1',
                  style: {
                    ...S.card,
                    marginTop: 5,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    borderLeft: `3px solid ${BRAND}`,
                  },
                  onClick: () => {
                    setTab('notes');
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.xs, color: LABEL2, fontWeight: 500 } },
                      `${aboutLabel ? `${aboutLabel} · ` : ''}${fmtShort(n.at)}`),
                    h('span', { style: badgeStyle }, badgeText)),
                  h('div', { style: { fontSize: FS.sm, color: LABEL1, marginTop: 4, lineHeight: 1.45 } },
                    renderMarkdown(n.content, { highlightQuery: activeQuery, markStyle: S.searchMark })));
              }))
            : null;

          const scenesBlock = matchedScenes.length > 0
            ? h('div', { style: { marginBottom: 10 } },
              h('div', { style: { ...S.sectionTitle, marginBottom: 6 } },
                t('search.matchedScenes', { n: fmtNum(matchedScenes.length) })),
              ...matchedScenes.map((sc) => {
                const hasKw = sc.sources.includes('keyword');
                const hasVec = sc.sources.includes('vector');
                const scoreText = typeof sc.score === 'number' ? ` ${sc.score.toFixed(2)}` : '';
                const badgeStyle = hasKw && hasVec ? S.sourceBadgeBoth : hasVec ? S.sourceBadgeVec : S.sourceBadgeKw;
                const badgeText = hasKw && hasVec
                  ? `${t('search.sceneBoth')}${scoreText}`
                  : hasVec
                    ? `${t('search.sceneVec')}${scoreText}`
                    : t('search.sceneKw');
                return h('div', {
                  key: `sc-${sc.id}`,
                  className: 'dvp-card',
                  'data-clickable': '1',
                  style: { ...S.card, marginTop: 5, padding: '8px 10px', cursor: 'pointer' },
                  onClick: () => {
                    void jumpToTimeline({ sceneId: sc.id, at: sc.startAt });
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.xs, color: LABEL2, fontWeight: 500 } },
                      `${fmtSceneRange(sc.startAt, sc.endAt)} · ${t('timeline.sceneMsgs', { n: fmtNum(sc.msgCount) })}`),
                    h('span', { style: badgeStyle }, badgeText)),
                  h('div', { style: { fontSize: FS.sm, color: LABEL1, marginTop: 4, lineHeight: 1.45 } },
                    renderHighlightedText(sc.gist, activeQuery, S.searchMark)));
              }))
            : null;

          if (visibleHits.length === 0 && matchedScenes.length === 0 && matchedNotes.length === 0) {
            content = h('div', null,
              semNote,
              h('div', { style: S.emptyCard }, t('search.empty', { query: activeQuery.trim() })));
          } else {
            content = h('div', null,
              notesBlock,
              scenesBlock,
              visibleHits.length > 0 ? summary : null,
              semNote,
              ...visibleHits.map((hit, index) => {
                const tag = speakerTag(hit.speaker);
                const hitKey = String(hit.id ?? index);
                const copyId = `hit:${hitKey}`;
                const isCopied = copiedKey === copyId;
                const isChunk = hit.chunk !== null;
                const isExpanded = expandedHits[hitKey] === true;
                const isWindow = Boolean(hit.window && hit.window.text && !isChunk);
                const winKind = hit.window?.kind === 'thread'
                  ? 'thread'
                  : (hit.window?.kind === 'exchange' ? 'exchange' : 'window');
                const winBadgeKey = winKind === 'thread'
                  ? 'search.threadBadge'
                  : (winKind === 'exchange' ? 'search.exchangeBadge' : 'search.windowBadge');
                const winExpandKey = winKind === 'thread'
                  ? 'search.expandThread'
                  : (winKind === 'exchange' ? 'search.expandExchange' : 'search.expandWindow');
                const defaultShowWindow = isWindow && (winKind === 'thread' || hit.text.length < 80);
                const hasCustomToggle = Object.prototype.hasOwnProperty.call(expandedHits, hitKey);
                const showWindowText = isWindow && (hasCustomToggle ? Boolean(expandedHits[hitKey]) : defaultShowWindow);
                const chunkText = isChunk
                  ? (hit.chunk.text !== null
                    ? hit.chunk.text
                    : (hit.chunk.startChar !== null && hit.chunk.endChar !== null
                      ? hit.text.slice(hit.chunk.startChar, hit.chunk.endChar)
                      : hit.text))
                  : hit.text;
                const shownText = isChunk && !isExpanded
                  ? chunkText
                  : (showWindowText ? hit.window.text : hit.text);
                const canJump = hit.sceneId !== null || typeof hit.at === 'number';
                const sceneRange = hit.sceneStartAt !== null
                  ? fmtSceneRange(hit.sceneStartAt, hit.sceneEndAt)
                  : null;

                return h('div', {
                  key: hitKey,
                  className: 'dvp-slide dvp-card',
                  style: {
                    ...S.searchCard,
                    borderLeftColor: tag.color,
                    animationDelay: `${Math.min(index, 12) * 20}ms`,
                  },
                },
                  h('div', { style: S.searchMetaRow },
                    h('div', { style: S.searchMetaLeft },
                      h('span', { style: { ...S.msgSpeaker, color: tag.color } }, tag.text),
                      h('span', { style: S.msgTime }, fmtShort(hit.at)),
                      sourceBadge(hit),
                      isWindow
                        ? h('span', { style: S.sourceBadgeBoth },
                          t(winBadgeKey, { n: fmtNum(hit.window.msgCount || 2) }))
                        : null,
                      hit.inSurface === 0 ? h('span', { style: S.tag }, t('timeline.compacted')) : null,
                      hit.excluded ? h('span', { style: S.tag }, t('search.excludedTag')) : null),
                    h('button', {
                      type: 'button',
                      style: isCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                      onClick: () => { void handleCopy(copyId, shownText); },
                    }, isCopied ? t('common.copied') : t('common.copy'))),
                  h('div', { style: { ...S.msgText, marginTop: 4 } },
                    renderMarkdown(shownText, { highlightQuery: activeQuery, markStyle: S.searchMark })),
                  isChunk
                    ? h('div', { style: S.chunkBar },
                      h('span', null, hit.chunk.total
                        ? t('search.chunkPart', { k: hit.chunk.idx + 1, total: hit.chunk.total })
                        : t('search.chunkPartSingle', { k: hit.chunk.idx + 1 })),
                      h('span', null, t('search.fullLength', { n: fmtNum(hit.text.length) })),
                      h('button', {
                        type: 'button',
                        style: S.linkBtn,
                        onClick: () => setExpandedHits((prev) => ({ ...prev, [hitKey]: !isExpanded })),
                      }, isExpanded ? t('search.collapseFull') : t('search.expandFull')))
                    : (isWindow
                      ? h('div', { style: S.chunkBar },
                        h('span', null, t(winBadgeKey, { n: fmtNum(hit.window.msgCount || 2) })),
                        h('button', {
                          type: 'button',
                          style: S.linkBtn,
                          onClick: () => setExpandedHits((prev) => ({ ...prev, [hitKey]: !showWindowText })),
                        }, showWindowText
                          ? t('search.collapseWindow')
                          : t(winExpandKey, { n: fmtNum(hit.window.msgCount || 2) })))
                      : null),
                  Array.isArray(hit.relatedTimeline) && hit.relatedTimeline.length > 0
                    ? h('div', { style: { ...S.hint, marginTop: 4, fontSize: FS.xs, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 } },
                      h('span', null, t('search.relatedTimeline', { dates: '' }).replace(/[:：]\s*$/, '') + '：'),
                      ...hit.relatedTimeline
                        .filter((rt) => rt && (rt.at !== null || rt.sceneId !== null))
                        .slice(0, 5)
                        .map((rt, rIdx) => h('button', {
                          key: `rt-${rIdx}-${rt.sceneId ?? rt.at}`,
                          type: 'button',
                          style: { ...S.linkBtn, fontSize: FS.xs, padding: '0 4px' },
                          onClick: () => { void jumpToTimeline({ sceneId: rt.sceneId ?? null, at: rt.at ?? null }); },
                        }, fmtShort(rt.at))))
                    : null,
                  h('div', { style: S.searchFooter },
                    sceneRange
                      ? h('span', { style: S.dim },
                        hit.sceneMsgCount !== null
                          ? `${sceneRange} · ${t('timeline.sceneMsgs', { n: fmtNum(hit.sceneMsgCount) })}`
                          : sceneRange)
                      : h('span', null),
                    canJump
                      ? h('button', {
                        type: 'button',
                        style: S.linkBtn,
                        onClick: () => { void jumpToTimeline(hit); },
                      }, t('search.jumpTimeline'))
                      : null));
              }));
          }
        }

        return h('div', null,
          h('form', {
            style: S.searchBar,
            onSubmit: (e) => {
              e.preventDefault();
              void runSearch();
            },
          },
            h('div', { className: 'dvp-search-wrap', style: S.searchInputWrap },
              h('span', { style: S.searchIcon }, h(SearchIcon, { size: 14 })),
              h('input', {
                ref: searchInputRef,
                type: 'text',
                value: searchQuery,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.placeholder'),
                style: S.searchInput,
                onChange: (e) => setSearchQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape' && searchQuery !== '') {
                    setSearchQuery('');
                    setSearchResult(null);
                    setTabErr('search', null);
                  }
                },
              }),
              searchQuery !== ''
                ? h('button', {
                  type: 'button',
                  style: S.clearBtn,
                  'aria-label': t('search.clear'),
                  title: t('search.clear'),
                  onClick: () => {
                    setSearchQuery('');
                    setSearchResult(null);
                    setTabErr('search', null);
                    if (searchInputRef.current) searchInputRef.current.focus();
                  },
                }, '×')
                : null),
            h('button', {
              type: 'submit',
              style: S.primaryBtn,
              disabled: searchBusy || searchQuery.trim() === '',
            }, t('search.submit'))),
          h('div', { style: S.pillRow },
            h('div', { style: S.pillGroup },
              ...whenOptions.map((opt) => h('button', {
                key: opt.value || 'all',
                type: 'button',
                'aria-pressed': searchWhen === opt.value,
                style: searchWhen === opt.value ? { ...S.pill, ...S.pillActive } : S.pill,
                onClick: () => {
                  setSearchWhen(opt.value);
                  if (searchQuery.trim()) void runSearch({ when: opt.value });
                },
              }, opt.label))),
            h('label', { style: S.checkLabel },
              h('input', {
                type: 'checkbox',
                checked: searchIncludeExcluded,
                onChange: (e) => {
                  const next = e.target.checked;
                  setSearchIncludeExcluded(next);
                  if (searchQuery.trim()) void runSearch({ includeExcluded: next });
                },
              }),
              h('span', null, t('search.includeExcluded')))),
          h('div', { style: { ...S.pillGroup, marginTop: 4, marginBottom: 6 } },
            ...['all', 'user', 'assistant'].map((sp) => h('button', {
              key: sp,
              type: 'button',
              'aria-pressed': searchSpeaker === sp,
              style: searchSpeaker === sp ? { ...S.pill, ...S.pillActive } : S.pill,
              onClick: () => setSearchSpeaker(sp),
            }, t(sp === 'all' ? 'search.speakerAll' : sp === 'user' ? 'search.speakerUser' : 'search.speakerAssistant')))),
          searchHistory.length > 0 && searchResult === null && !searchBusy
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
              h('span', { style: { fontSize: FS.xs, color: LABEL3 } }, t('search.history')),
              ...searchHistory.map((hq) => h('button', {
                key: hq,
                type: 'button',
                style: S.dbChip,
                onClick: () => {
                  setSearchQuery(hq);
                  void runSearch({ query: hq });
                },
              }, hq)),
              h('button', {
                type: 'button',
                style: { ...S.linkBtn, fontSize: FS.xs, marginLeft: 2 },
                onClick: () => {
                  setSearchHistory([]);
                  try { if (typeof localStorage !== 'undefined') localStorage.removeItem('dsh-verbatim:search-history'); } catch { /* ignore */ }
                },
              }, t('search.clearHistory')))
            : null,
          content,
          h('div', { style: { marginTop: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 8 } },
            h('div', { style: { ...S.rowBetween, alignItems: 'center' } },
              h('button', {
                type: 'button',
                style: S.linkBtn,
                onClick: () => {
                  const next = !recallOpen;
                  setRecallOpen(next);
                  if (next) {
                    setRecallBusy(true);
                    void rpcRead('recallLog', { sessionId, limit: 15 })
                      .then((res) => { setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { setRecallBusy(false); });
                  }
                },
              }, `${recallOpen ? '▾' : '▸'} ${t('search.recallToggle')}`),
              recallOpen
                ? h('button', {
                  type: 'button',
                  style: S.copyBtn,
                  disabled: recallBusy,
                  onClick: () => {
                    setRecallBusy(true);
                    void rpcRead('recallLog', { sessionId, limit: 15 })
                      .then((res) => { setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { setRecallBusy(false); });
                  },
                }, t('common.refresh'))
                : null),
            recallOpen
              ? (recallBusy && recallItems === null
                ? h('div', { style: { ...S.hint, marginTop: 6 } }, t('common.loading'))
                : !recallItems || recallItems.length === 0
                  ? h('div', { style: { ...S.hint, marginTop: 6 } }, t('search.recallEmpty'))
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
                    ...recallItems.map((rc) => h('div', {
                      key: rc.id,
                      style: { ...S.card, padding: '7px 9px', marginTop: 0 },
                    },
                      h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                        h('span', { style: { fontWeight: 600, fontSize: FS.xs, color: LABEL1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          rc.query ? `「${rc.query}」` : (rc.when || '(recent)')),
                        h('span', { style: { fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' } },
                          `${fmtClock(rc.at)} · ${rc.elapsedMs}ms · ${fmtNum(rc.resultChars)}字`)),
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 } },
                        h('span', { style: S.tag }, `kw ${rc.counts?.keyword ?? 0}`),
                        h('span', { style: S.tag }, `vec ${rc.counts?.vector ?? 0}`),
                        rc.reranked ? h('span', { style: S.sourceBadgeBoth }, t('search.rerankedBadge')) : null,
                        ...(Array.isArray(rc.hitScenes) ? rc.hitScenes : []).map((hs) => h('button', {
                          key: String(hs.sceneId),
                          type: 'button',
                          style: S.dbChip,
                          onClick: () => { void jumpToTimeline({ sceneId: hs.sceneId, at: hs.startAt }); },
                        }, `${fmtShort(hs.startAt)} (${hs.count})`)))))))
              : null));
      }

      /* ---------- 标签页：TA的笔记 ---------- */

      function renderNotes() {
        const trashCount = deletedNotesTotal !== null
          ? deletedNotesTotal
          : (deletedNotes !== null
            ? deletedNotes.length
            : (stats && typeof stats.deletedNotesCount === 'number' ? stats.deletedNotesCount : null));
        const trashLabel = trashCount !== null
          ? `${t('notes.tabTrash')} (${fmtNum(trashCount)})`
          : t('notes.tabTrash');

        const switcher = h('div', { style: { ...S.rowBetween, alignItems: 'center', marginBottom: 8 } },
          h('div', { style: { ...S.segmented, marginBottom: 0 }, role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': notesView === 'active',
              style: notesView === 'active' ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => setNotesView('active'),
            }, t('notes.tabActive')),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': notesView === 'trash',
              style: notesView === 'trash' ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => {
                setNotesView('trash');
                if (deletedNotes === null && !trashLoading) void loadDeletedNotes();
              },
            }, trashLabel)),
          notesView === 'active'
            ? h('button', {
              type: 'button',
              style: noteForm ? S.btn : S.primaryBtn,
              onClick: () => setNoteForm(noteForm ? null : { content: '', about: 'him' }),
            }, noteForm ? t('common.cancel') : t('notes.add'))
            : null);

        const composer = notesView === 'active' && noteForm !== null
          ? h('div', { style: { ...S.card, marginTop: 0, marginBottom: 8 } },
            h('textarea', {
              style: { ...S.dbSqlArea, fontFamily: 'inherit', fontSize: FS.sm, minHeight: 62 },
              value: noteForm.content,
              placeholder: t('notes.addPlaceholder'),
              onChange: (e) => setNoteForm({ ...noteForm, content: e.target.value }),
            }),
            h('div', { style: { ...S.rowBetween, alignItems: 'center', marginTop: 6, gap: 6, flexWrap: 'wrap' } },
              h('div', { style: S.pillGroup },
                ...[
                  { v: 'him', label: t('notes.about.him') },
                  { v: 'me', label: t('notes.about.me') },
                  { v: 'us', label: t('notes.about.us') },
                  { v: '', label: t('notes.aboutAny') },
                ].map((opt) => h('button', {
                  key: opt.v || 'any',
                  type: 'button',
                  style: noteForm.about === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
                  onClick: () => setNoteForm({ ...noteForm, about: opt.v }),
                }, opt.label))),
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                disabled: busy === 'note:add' || !String(noteForm.content ?? '').trim(),
                onClick: () => { void saveNewNote(); },
              }, busy === 'note:add' ? t('common.saving') : t('common.save'))))
          : null;

        if (notesView === 'trash') {
          let trashBody = null;
          if (trashErr !== null) {
            trashBody = h('div', { style: S.errorCard },
              h('div', null, trashErr),
              h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => { void loadDeletedNotes(); },
                }, t('common.retry'))));
          } else if (deletedNotes === null || trashLoading) {
            trashBody = h(SkeletonGroup, { kind: 'cards', count: 3 });
          } else if (deletedNotes.length === 0) {
            trashBody = h('div', { style: S.emptyCard }, t('notes.trashEmpty'));
          } else {
            const nowMs = Date.now();
            trashBody = h('div', null, ...deletedNotes.map((note, index) => {
              const aboutKey = note.about === 'me' || note.about === 'him' || note.about === 'us' ? note.about : null;
              const restoring = busy === `restore:${String(note.id)}`;
              const leftDays = note.expiresAt !== null
                ? Math.max(0, Math.ceil((note.expiresAt - nowMs) / DAY_MS))
                : null;
              const expireText = leftDays === null
                ? null
                : leftDays === 0
                  ? t('notes.expiresSoon')
                  : t('notes.expiresIn', { n: leftDays });

              return h('div', {
                key: String(note.id),
                className: 'dvp-slide dvp-card',
                style: { ...S.noteCard, animationDelay: `${Math.min(index, 10) * 20}ms` },
              },
                h('div', { style: S.rowBetween },
                  h('div', { style: S.trashMeta },
                    h('span', null, t('notes.deletedAt', { date: fmtShort(note.deletedAt) })),
                    expireText !== null ? h('span', { style: { color: WARN } }, `· ${expireText}`) : null),
                  h('button', {
                    type: 'button',
                    style: S.btn,
                    disabled: restoring,
                    onClick: () => { if (note.id !== undefined) void restoreNote(note.id); },
                  }, restoring ? t('notes.restoring') : t('notes.restore'))),
                h('div', { style: { marginTop: 4, fontSize: FS.base, lineHeight: 1.6, wordBreak: 'break-word' } }, renderMarkdown(note.content)),
                aboutKey === null ? null : h('div', { style: { ...S.dim, marginTop: 2 } }, t(`notes.about.${aboutKey}`)));
            }));
          }
          return h('div', null, switcher, trashBody);
        }

        // 读失败时上面的错误带已经说了，这里不能再显示「TA还没记过笔记」
        if (notes === null) return h('div', null, switcher, composer, tabErr !== null ? null : h(SkeletonGroup, { kind: 'cards', count: 3 }));
        if (notes.length === 0) {
          return h('div', null, switcher, composer, tabErr !== null ? null : h('div', { style: S.emptyCard }, t('empty.notes')));
        }

        const filterBar = h('div', { style: { marginBottom: 6 } },
          h('div', { style: { ...S.pillGroup, marginBottom: 5 } },
            ...[
              { v: 'all', label: t('notes.filterAll') },
              { v: 'him', label: t('notes.about.him') },
              { v: 'me', label: t('notes.about.me') },
              { v: 'us', label: t('notes.about.us') },
            ].map((opt) => h('button', {
              key: opt.v,
              type: 'button',
              style: noteAboutFilter === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
              onClick: () => setNoteAboutFilter(opt.v),
            }, opt.label))),
          h('input', {
            type: 'text',
            style: { ...S.input, width: '100%' },
            value: noteFilter,
            placeholder: t('notes.filterPlaceholder'),
            onChange: (e) => setNoteFilter(e.target.value),
          }));

        const qLower = noteFilter.trim().toLowerCase();
        const filteredNotes = notes.filter((n) => {
          if (noteAboutFilter !== 'all' && n.about !== noteAboutFilter) return false;
          if (qLower && !String(n.content ?? '').toLowerCase().includes(qLower)) return false;
          return true;
        });

        const scanDuplicates = async () => {
          setDupBusy(true);
          try {
            const res = await rpcRead('findDuplicateNotes', { sessionId });
            const groups = Array.isArray(res?.groups) ? res.groups : [];
            setDupGroups(groups);
            if (groups.length === 0) setFlash({ kind: 'ok', text: t('notes.dedupNone') });
          } catch (e) {
            setFlash({ kind: 'err', text: msgOf(e) });
          } finally {
            setDupBusy(false);
          }
        };

        const mergeDupGroup = async (group) => {
          setDupBusy(true);
          try {
            const dropIds = group.duplicates.map((d) => d.id);
            const res = await rpcWrite('mergeNotes', { sessionId, keepId: group.keep.id, dropIds });
            setFlash({ kind: 'ok', text: t('notes.dedupMergedOk', { n: fmtNum(res?.dropped ?? dropIds.length) }) });
            setDupGroups((prev) => (Array.isArray(prev) ? prev.filter((g) => g.keep.id !== group.keep.id) : null));
            await Promise.all([loadNotes(true), loadStatus()]);
          } catch (e) {
            setFlash({ kind: 'err', text: msgOf(e) });
          } finally {
            setDupBusy(false);
          }
        };

        return h('div', null,
          switcher,
          composer,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 6 } },
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: dupBusy,
              onClick: () => { void scanDuplicates(); },
            }, t('notes.dedupBtn'))),
          Array.isArray(dupGroups) && dupGroups.length > 0
            ? h('div', { style: { marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              ...dupGroups.map((g) => h('div', {
                key: `dup-${g.keep.id}`,
                style: { ...S.card, borderColor: WARN, padding: '8px 10px' },
              },
                h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: FS.xs, fontWeight: 600, color: LABEL1 } }, `#${g.keep.id} (${fmtShort(g.keep.at)})`),
                  h('button', {
                    type: 'button',
                    style: S.primaryBtn,
                    disabled: dupBusy,
                    onClick: () => { void mergeDupGroup(g); },
                  }, t('notes.dedupMerge', { n: g.duplicates.length }))),
                h('div', { style: { fontSize: FS.xs, color: LABEL1, marginTop: 4 } }, g.keep.content),
                ...g.duplicates.map((d) => h('div', {
                  key: `d-${d.id}`,
                  style: { fontSize: FS.xs, color: LABEL3, marginTop: 3, paddingLeft: 8, borderLeft: `2px solid ${BORDER}` },
                }, `≈${Math.round((d.similarity ?? 0) * 100)}% · #${d.id}: ${d.content}`)))))
            : null,
          filterBar,
          filteredNotes.length === 0
            ? h('div', { style: S.emptyCard }, t('notes.filterEmpty'))
            : null,
          ...filteredNotes.map((note, index) => {
          const aboutKey = note.about === 'me' || note.about === 'him' || note.about === 'us' ? note.about : null;
          const deleting = busy === `note:${String(note.id)}`;
          const accentColor = aboutKey === 'him' ? BRAND : aboutKey === 'me' ? '#d94862' : aboutKey === 'us' ? '#8b5cf6' : BORDER_STRONG;
          return h('div', {
            key: String(note.id),
            className: 'dvp-slide dvp-card',
            style: {
              ...S.noteCard,
              borderLeft: `3px solid ${accentColor}`,
              animationDelay: `${Math.min(index, 10) * 20}ms`,
            },
          },
            h('div', { style: S.rowBetween },
              h('span', { style: S.dim }, fmtShort(note.at)),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: S.linkBtn,
                  disabled: deleting,
                  onClick: () => setEditingNote({ id: note.id, text: note.content }),
                }, t('notes.edit')),
                h('button', {
                  type: 'button',
                  style: S.linkBtn,
                  disabled: deleting,
                  onClick: () => { if (note.id !== undefined) void deleteNote(note.id); },
                }, deleting ? t('notes.deleting') : t('common.delete')))),
            editingNote && editingNote.id === note.id
              ? h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
                h('textarea', {
                  value: editingNote.text,
                  rows: 3,
                  onChange: (e) => setEditingNote({ id: note.id, text: e.target.value }),
                  style: { ...S.input, width: '100%', boxSizing: 'border-box', fontSize: FS.sm, resize: 'vertical' },
                }),
                h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                  h('button', { type: 'button', style: S.btn, onClick: () => setEditingNote(null) }, t('common.cancel')),
                  h('button', {
                    type: 'button',
                    style: S.primaryBtn,
                    disabled: !editingNote.text.trim(),
                    onClick: async () => {
                      const nextText = editingNote.text.trim();
                      try {
                        await rpcWrite('updateNote', { sessionId, id: note.id, content: nextText });
                        if (!alive.current) return;
                        setEditingNote(null);
                        setFlash({ kind: 'ok', text: t('notes.updatedOk') });
                        await loadNotes();
                      } catch (e) {
                        if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
                      }
                    },
                  }, t('common.save'))))
              : h('div', { style: { marginTop: 3, fontSize: FS.base, lineHeight: 1.6, wordBreak: 'break-word' } }, renderMarkdown(note.content)),
            aboutKey === null ? null : h('div', { style: { ...S.dim, marginTop: 2 } }, t(`notes.about.${aboutKey}`)));
        }));
      }


      function renderSampleCard() {
        if (sample === null) {
          return h('div', { style: S.emptyCard }, t('verify.hint'));
        }
        if (sample.empty) {
          return h('div', { style: S.emptyCard }, t('empty.verify'));
        }
        const tag = speakerTag(sample.speaker);
        const sceneHint = sample.scene === null
          ? null
          : t('verify.scene', {
            from: fmtShort(sample.scene.startAt),
            to: fmtClock(sample.scene.endAt),
            n: fmtNum(sample.scene.msgCount),
          });

        return h('div', { style: S.card },
          h('div', { style: S.msgHead },
            h('span', { style: S.msgTime }, fmtShort(sample.at)),
            h('span', { style: { ...S.msgSpeaker, color: tag.color } }, tag.text)),
          h('div', { style: S.msgText }, sample.text),
          sceneHint === null ? null : h('div', { style: { ...S.dim, marginTop: 3 } }, sceneHint),
          h('div', { style: S.actions },
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy === 'verify',
              onClick: () => { void viewRaw(sample.id); },
            }, busy === 'verify' ? t('verify.loadingRaw') : t('verify.viewRaw')),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy === 'flag' || flagForm !== null,
              onClick: () => setFlagForm({ msgId: sample.id, reason: '' }),
            }, t('verify.mark'))),

          flagForm !== null && flagForm.msgId === sample.id ? renderFlagForm() : null);
      }

      function renderFlagForm() {
        const busyFlag = busy === 'flag';
        return h('div', { style: { marginTop: 8 } },
          h('div', { style: S.dim }, t('verify.reason')),
          h('div', { style: S.formRow },
            h('input', {
              style: S.input,
              value: flagForm.reason,
              placeholder: t('verify.reasonPlaceholder'),
              'aria-label': t('verify.reason'),
              onChange: (event) => setFlagForm({ ...flagForm, reason: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); void markProblem(flagForm.msgId); }
                if (event.key === 'Escape') setFlagForm(null);
              },
            }),
            h('button', {
              type: 'button',
              style: S.primaryBtn,
              disabled: busyFlag,
              onClick: () => { void markProblem(flagForm.msgId); },
            }, busyFlag ? t('common.saving') : t('verify.markConfirm')),
            h('button', { type: 'button', style: S.btn, onClick: () => setFlagForm(null) }, t('common.cancel'))));
      }

      function renderVerifyCard() {
        if (verify === null) return null;
        const dbText = verify.dbText;
        const logText = verify.logText;
        const comparable = dbText !== null && logText !== null;
        const markAt = comparable && !verify.identical ? firstDiffIndex(dbText, logText) : -1;
        // 日志里没有这条时不能显示「一致」——避免给出失实的核对结论
        const statusText = comparable === false
          ? t('verify.cannotCompare')
          : verify.identical
            ? t('verify.identical')
            : t('verify.differs', { n: markAt + 1 });
        const statusColor = comparable === false ? LABEL3 : verify.identical ? SUCCESS : WARN;

        return h('div', { style: S.card },
          logText === null
            ? h('div', { style: { ...S.warnHint, marginTop: 0 } },
              verify.reason !== null ? verify.reason : t('verify.logMissing'))
            : h('div', { style: S.paneWrap },
              h(TextPane, { label: t('verify.db'), text: dbText, markAt }),
              h(TextPane, { label: t('verify.log'), text: logText, markAt })),
          h('div', { style: S.rowBetween },
            h('span', {
              style: {
                fontSize: FS.sm,
                marginTop: 4,
                color: statusColor,
              },
            }, statusText),
            h('span', { style: { ...S.dim, marginTop: 4 } },
              `${dbText === null ? '—' : t('verify.dbChars', { n: dbText.length })} / ${logText === null ? '—' : t('verify.logChars', { n: logText.length })}`)));
      }

      function renderFlags() {
        // 读失败 ≠ 没有标记。失败时只报失败 + 原因 + 重试，绝不显示「还没有标记」。
        const failure = flagsErr === null ? null : h('div', { style: { ...S.errorCard, marginTop: 10 } },
          h('div', null, t('verify.flagsFailed', { err: flagsErr })),
          flags.length > 0 ? h('div', { style: S.errDetail }, t('verify.flagsStale', { n: flags.length })) : null,
          h('div', { style: S.actions },
            h('button', {
              type: 'button',
              style: S.btn,
              onClick: () => { void loadFlags(); },
            }, t('common.retry'))));

        if (flags.length === 0) {
          return failure !== null ? failure : h('div', { style: { ...S.emptyCard, marginTop: 10 } }, t('empty.flags'));
        }

        return h('div', { style: { marginTop: 12 } },
          failure,
          h('div', { style: S.rowBetween },
            h('span', { style: { fontSize: FS.base, fontWeight: 600 } }, t('verify.flagged', { n: flags.length })),
            h('button', {
              type: 'button',
              style: S.linkBtn,
              disabled: busy === 'unflagAll',
              onClick: () => { void unflagAll(); },
            }, t('verify.unflagAll'))),
          ...flags.map((flag) => h('div', { key: String(flag.id), style: S.flagCard },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: S.msgTime }, fmtShort(flag.at)),
              h('span', { style: S.snippet }, flag.snippet ?? `msg #${String(flag.msgId)}`)),
            h('div', { style: { ...S.dim, marginTop: 2 } },
              flag.reason === null || flag.reason === '' ? t('verify.noReason') : flag.reason),
            h('div', { style: S.actions },
              h('button', {
                type: 'button',
                style: S.linkBtn,
                onClick: () => { void viewRaw(flag.msgId); },
              }, t('verify.viewRaw')),
              h('button', {
                type: 'button',
                style: S.linkBtn,
                disabled: busy === `unflag:${String(flag.id)}`,
                onClick: () => { void unflag(flag.id); },
              }, t('verify.unflag'))))));
      }

      function renderVerify() {
        // 读失败时不报「已标记 0 条」（0 和「不知道」不一样）
        const badge = flags.length > 0
          ? h('span', { style: { ...S.dim, marginLeft: 2 } }, t('verify.flagged', { n: flags.length }))
          : flagsErr !== null
            ? h('span', { style: { ...S.warnHint, marginLeft: 2 } }, t('verify.flagsUnknown'))
            : null;

        const compactedMsgs = stats && typeof stats.compactedMsgs === 'number' ? stats.compactedMsgs : 0;
        const sceneCount = stats && typeof stats.sceneCount === 'number' ? stats.sceneCount : 0;
        const scenesWithGist = stats && typeof stats.scenesWithGist === 'number' ? stats.scenesWithGist : 0;
        const vecTotal = vector && typeof vector.total === 'number' ? vector.total : 0;
        const vecIndexed = vector && typeof vector.indexed === 'number' ? vector.indexed : 0;
        const needVecSync = vecTotal > 0 && vecIndexed < vecTotal;
        const needGistGen = sceneCount > 0 && scenesWithGist < sceneCount;

        const auditCard = status !== null
          ? h('div', { className: 'dvp-card', style: { ...S.card, marginTop: 0, marginBottom: 10 } },
            h('div', { style: { ...S.sectionTitle, marginBottom: 6 } }, t('verify.auditTitle')),
            h('div', { style: S.indexRow },
              h('span', { style: S.indexLabel }, t('verify.auditCompacted')),
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { ...S.indexValue, fontVariantNumeric: 'tabular-nums' } },
                  t('verify.auditCompactedVal', { n: fmtNum(compactedMsgs) })),
                compactedMsgs > 0
                  ? h('button', {
                    type: 'button',
                    style: S.linkBtn,
                    onClick: () => {
                      setTimelineOnlyCompacted(true);
                      setTab('timeline');
                    },
                  }, t('verify.auditCompactedAction'))
                  : null)),
            h('div', { style: { ...S.indexRow, marginTop: 4 } },
              h('span', { style: S.indexLabel }, t('verify.auditVector')),
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { ...S.indexValue, fontVariantNumeric: 'tabular-nums', color: needVecSync ? WARN : SUCCESS } },
                  t('verify.auditVectorVal', { indexed: fmtNum(vecIndexed), total: fmtNum(vecTotal) })),
                needVecSync
                  ? h('button', {
                    type: 'button',
                    style: S.linkBtn,
                    onClick: () => {
                      setTab('overview');
                      void applyRebuild('incremental');
                    },
                  }, t('verify.auditVectorAction'))
                  : null)),
            h('div', { style: { ...S.indexRow, marginTop: 4 } },
              h('span', { style: S.indexLabel }, t('verify.auditGist')),
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { ...S.indexValue, fontVariantNumeric: 'tabular-nums', color: needGistGen ? WARN : LABEL1 } },
                  t('verify.auditGistVal', { gists: fmtNum(scenesWithGist), scenes: fmtNum(sceneCount) })),
                needGistGen
                  ? h('button', {
                    type: 'button',
                    style: S.linkBtn,
                    onClick: () => {
                      setTab('overview');
                      void applyRebuild('scene', { useLlm: false });
                    },
                  }, t('verify.auditGistAction'))
                  : null)))
          : null;

        const batchCard = batchVerify !== null
          ? h('div', { style: { ...S.card, marginTop: 8 } },
            batchVerify.running
              ? h('div', { style: S.dim }, t('verify.batchRunning'))
              : h('div', null,
                h('div', {
                  style: {
                    fontSize: FS.sm,
                    fontWeight: 500,
                    color: batchVerify.diff > 0 ? WARN : (batchVerify.ok > 0 && batchVerify.missing === 0 ? SUCCESS : LABEL1),
                  },
                }, batchVerify.diff === 0 && batchVerify.missing === 0 && batchVerify.items.length > 0
                  ? t('verify.batchAllOk', { total: batchVerify.items.length })
                  : t('verify.batchSummary', {
                    total: batchVerify.items.length,
                    ok: batchVerify.ok,
                    diff: batchVerify.diff,
                    missing: batchVerify.missing,
                  })),
                ...batchVerify.items.map((it) => h('div', {
                  key: `bv-${it.sample.id}`,
                  style: {
                    ...S.rowBetween,
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 5,
                    paddingTop: 5,
                    borderTop: `1px solid ${BORDER}`,
                    fontSize: FS.xs,
                  },
                },
                  h('span', {
                    style: {
                      color: it.kind === 'ok' ? SUCCESS : it.kind === 'diff' ? WARN : LABEL3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    },
                    title: it.sample.text,
                  }, `${it.kind === 'ok' ? '✓' : it.kind === 'diff' ? '✕' : '—'} #${it.sample.id} ${String(it.sample.text || '').slice(0, 36)}`),
                  h('button', {
                    type: 'button',
                    style: S.linkBtn,
                    onClick: () => {
                      setSample(it.sample);
                      setVerify({ msgId: it.sample.id, ...it.verify });
                    },
                  }, t('verify.viewRaw'))))))
          : null;

        const submitIdVerify = (e) => {
          e.preventDefault();
          const n = Number(verifyIdInput.trim());
          if (!Number.isInteger(n) || n < 1) {
            setFlash({ kind: 'err', text: t('verify.idInvalid') });
            return;
          }
          setSample(null);
          void viewRaw(n);
        };

        return h('div', null,
          auditCard,
          h('div', { style: { ...S.rowBetween, flexWrap: 'wrap', gap: 6 } },
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                disabled: busy === 'batchVerify' || busy === 'sample',
                onClick: () => { void runBatchVerify(5); },
              }, busy === 'batchVerify' ? t('verify.batchRunning') : t('verify.batchBtn')),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: busy === 'sample' || busy === 'batchVerify',
                onClick: () => { void drawSample(); },
              }, busy === 'sample' ? t('verify.drawing') : t('verify.draw'))),
            badge),
          h('form', { style: { ...S.formRow, marginTop: 8 }, onSubmit: submitIdVerify },
            h('input', {
              type: 'text',
              style: S.input,
              value: verifyIdInput,
              placeholder: t('verify.idPlaceholder'),
              onChange: (e) => setVerifyIdInput(e.target.value),
            }),
            h('button', {
              type: 'submit',
              style: S.btn,
              disabled: busy === 'verify' || !verifyIdInput.trim(),
            }, t('verify.idBtn'))),
          batchCard,
          renderSampleCard(),
          renderVerifyCard(),
          renderFlags());
      }

      function renderExcludeRanges() {
        if (status === null) return null;
        const ranges = Array.isArray(status.excludeRanges) ? status.excludeRanges : [];
        const excludedCount = stats && typeof stats.excludedMsgs === 'number' ? stats.excludedMsgs : 0;
        const savingExclude = busy === 'excludeRanges';

        const formatRange = (r) => {
          if (isYMD(r.from) && isYMD(r.to)) {
            const incEnd = shiftYMD(r.to, -1);
            if (incEnd === r.from) return t('exclude.fullDay', { date: r.from });
            if (incEnd && incEnd > r.from) return `${r.from} ~ ${incEnd}`;
          }
          return `${r.from} → ${r.to}`;
        };

        const submitExclude = () => {
          if (!excludeForm) return;
          const from = String(excludeForm.from ?? '').trim();
          const toInc = String(excludeForm.to || excludeForm.from || '').trim();
          if (!from) {
            setExcludeForm({ ...excludeForm, err: t('exclude.missingStart') });
            return;
          }
          if (toInc < from) {
            setExcludeForm({ ...excludeForm, err: t('exclude.invalidRange') });
            return;
          }
          const toExclusive = shiftYMD(toInc, 1);
          if (!toExclusive) {
            setExcludeForm({ ...excludeForm, err: t('exclude.invalidRange') });
            return;
          }
          const next = [
            ...ranges,
            { from, to: toExclusive, reason: String(excludeForm.reason ?? '').trim() },
          ];
          void saveExcludeRanges(next);
        };

        // 未配置任何排除时段且未展开表单时，收成紧凑一行不占首页空间
        if (ranges.length === 0 && excludeForm === null) {
          return h('div', { className: 'dvp-card', style: { ...S.excludeCard, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('span', { style: S.dim }, t('exclude.empty')),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: savingExclude,
              onClick: () => setExcludeForm({ from: '', to: '', reason: '', err: null }),
            }, t('exclude.add')));
        }

        return h('div', { className: 'dvp-card', style: S.excludeCard },
          excludedCount > 0
            ? h('div', { style: { ...S.warnHint, marginTop: 0, marginBottom: 6 } },
              t('exclude.excludedCount', { n: fmtNum(excludedCount) }))
            : null,
          ranges.length === 0
            ? h('div', { style: S.dim }, t('exclude.empty'))
            : h('div', null, ...ranges.map((r, idx) => h('div', {
              key: `${r.from}-${r.to}-${idx}`,
              style: idx === ranges.length - 1 ? { ...S.excludeItem, borderBottom: 0, paddingBottom: 2 } : S.excludeItem,
            },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: S.excludeRangeText, title: `[${r.from}, ${r.to})` }, formatRange(r)),
                r.reason ? h('div', { style: S.hint }, r.reason) : null),
              h('button', {
                type: 'button',
                style: S.linkBtn,
                disabled: savingExclude,
                onClick: () => {
                  const next = ranges.filter((_, i) => i !== idx);
                  void saveExcludeRanges(next);
                },
              }, t('exclude.remove'))))),
          excludeForm === null
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: savingExclude,
                onClick: () => setExcludeForm({ from: '', to: '', reason: '', err: null }),
              }, t('exclude.add')))
            : h('div', { style: S.excludeForm },
              h('div', { style: S.dateGrid },
                h('div', null,
                  h('div', { style: S.fieldLabel }, t('exclude.from')),
                  h('input', {
                    type: 'date',
                    style: { ...S.input, width: '100%' },
                    value: excludeForm.from,
                    'aria-label': t('exclude.from'),
                    onChange: (e) => {
                      const nextFrom = e.target.value;
                      setExcludeForm({
                        ...excludeForm,
                        from: nextFrom,
                        to: excludeForm.to || nextFrom,
                        err: null,
                      });
                    },
                  })),
                h('div', null,
                  h('div', { style: S.fieldLabel }, t('exclude.to')),
                  h('input', {
                    type: 'date',
                    style: { ...S.input, width: '100%' },
                    value: excludeForm.to,
                    min: excludeForm.from || undefined,
                    'aria-label': t('exclude.to'),
                    onChange: (e) => setExcludeForm({ ...excludeForm, to: e.target.value, err: null }),
                  }))),
              h('div', { style: { marginTop: 6 } },
                h('div', { style: S.fieldLabel }, t('exclude.reason')),
                h('input', {
                  type: 'text',
                  style: { ...S.input, width: '100%' },
                  value: excludeForm.reason,
                  placeholder: t('exclude.reasonPlaceholder'),
                  'aria-label': t('exclude.reason'),
                  onChange: (e) => setExcludeForm({ ...excludeForm, reason: e.target.value }),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submitExclude(); }
                    if (e.key === 'Escape') setExcludeForm(null);
                  },
                })),
              h('div', { style: { ...S.hint, marginTop: 4 } }, t('exclude.inclusiveHint')),
              excludeForm.err
                ? h('div', { style: { ...S.hint, color: ERROR, marginTop: 4 } }, excludeForm.err)
                : null,
              h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.primaryBtn,
                  disabled: savingExclude,
                  onClick: submitExclude,
                }, savingExclude ? t('common.saving') : t('exclude.save')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: savingExclude,
                  onClick: () => setExcludeForm(null),
                }, t('common.cancel')))));
      }

      /* ---------- 标签页：概览 ---------- */
      //
      // 原来「开关 + 统计 + 索引」挤在标签页上方，和内容争空间，
      // 面板看起来就是"一坨"。现在它们各自成为一页（作者 2026-11-18）：
      //   [概览] 开关 / 隐私排除时段 / 这个对话记了多少 / 索引状态
      //   [搜索] [时间轴] [笔记] [核对] 各自独立滚动
      function renderOverview() {
        if (status === null) {
          return loadErr !== null ? null : h(SkeletonGroup, { kind: 'cards', count: 3 });
        }

        // 扫描节奏：最近 7 天每天多少条（一眼看出"这几天聊得凶不凶"）
        const recent = activeDays();

        return h('div', null,
          // ① 顶部搜索入口（模拟搜索框，一点聚焦搜索页）
          h('div', { style: { marginBottom: 12 } },
            h('button', {
              type: 'button',
              style: S.searchEntryBtn,
              'data-clickable': '1',
              onClick: openSearchTab,
            },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' } },
                h(SearchIcon, { size: 13 }),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('overview.searchEntry'))),
              h('span', { style: S.sourceBadgeKw }, t('overview.searchTag')))),

          // ② 陪伴记忆主卡与 Bento KPI
          h('div', { style: { marginBottom: 12 } },
            renderStats()),

          // ③ 陪伴权限开关
          h('div', { style: { marginBottom: 12 } },
            renderSwitches()),

          // ④ 语义回想就绪度卡片
          h('div', { style: { marginBottom: 14 } },
            renderIndex()),

          // ⑤ 最近 7 天活跃节奏（点击柱子直达时间轴对应日期）
          recent.length > 0
            ? h('div', { style: S.section },
              h('div', { style: { ...S.rowBetween, marginBottom: 6, alignItems: 'baseline' } },
                h('div', { style: { ...S.sectionTitle, marginBottom: 0 } }, t('overview.activity')),
                h('span', { style: { fontSize: FS.xs, color: LABEL3 } }, t('overview.activityHint'))),
              h('div', { style: S.sparkCard },
                h('div', { style: S.sparkRow },
                  ...recent.map((d) => h('button', {
                    key: d.key,
                    type: 'button',
                    'data-clickable': '1',
                    style: {
                      ...S.sparkCol,
                      appearance: 'none',
                      border: 0,
                      background: 'transparent',
                      padding: '2px 0',
                      borderRadius: 4,
                      cursor: 'pointer',
                      font: 'inherit',
                    },
                    title: t('overview.activityTip', { date: d.label, n: fmtNum(d.count) }),
                    onClick: () => {
                      setOpenDay(d.key);
                      setScene(null);
                      setTab('timeline');
                    },
                  },
                    h('div', { style: { ...S.sparkBar, height: `${Math.max(5, d.ratio * 28)}px`, borderRadius: '6px 6px 2px 2px', background: `linear-gradient(180deg, ${BRAND}, color-mix(in srgb, ${BRAND} 55%, transparent))` } }),
                    h('div', { style: S.sparkLabel }, d.label))))))
            : null,

          // ⑥ 隐私排除时段（空时折叠为紧凑一行）
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, t('overview.exclude')),
            renderExcludeRanges()),

          renderWarnings());
      }

      /**
       * 最近 7 天的条数（用于概览页的小柱状图）。
       * 只统计**这个会话**、按上海自然日。
       */
      function activeDays() {
        const list = Array.isArray(days) ? days : [];
        if (list.length === 0) return [];
        const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7).reverse();
        const max = Math.max(...sorted.map((d) => d.msgCount), 1);
        return sorted.map((d) => ({
          key: d.date,
          label: d.date.slice(5),          // 11-18 → 18
          count: d.msgCount,
          ratio: d.msgCount / max,
        }));
      }

      /* ---------- 数据库管理台交互与视图 ---------- */

      const openDbBrowseFor = (targetSid, targetTable = 'msg') => {
        const sid = targetSid || '';
        setDbSession(sid);
        setDbTable(targetTable);
        setDbPage(0);
        setDbSubTab('browse');
        void loadDbRows({ sessionId: sid, table: targetTable, page: 0 });
      };

      const runDbMaintain = async (action, extra = {}) => {
        const key = `${action}:${extra.sessionId || 'all'}`;
        setDbActionBusy(key);
        setFlash(null);
        try {
          const res = await rpcWrite('dbMaintain', { action, ...extra });
          if (!alive.current) return;
          if (action === 'backup') {
            setFlash({ kind: 'ok', text: t('db.backupOk', { path: res.backupPath, size: fmtBytes(res.bytes) }) });
          } else if (action === 'vacuum') {
            setFlash({ kind: 'ok', text: t('db.vacuumOk', { before: fmtBytes(res.beforeBytes), after: fmtBytes(res.afterBytes) }) });
            void loadDbOverview();
          } else if (action === 'purgeTrash') {
            setFlash({ kind: 'ok', text: t('db.purgeOk', { n: fmtNum(res.purged) }) });
            void loadDbOverview();
            void loadStatus();
          } else if (action === 'exportSession') {
            const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `verbatim-${shortSid(extra.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setFlash({
              kind: 'ok',
              text: t('db.exportOk', {
                msgs: fmtNum(res.counts ? res.counts.msgs : 0),
                notes: fmtNum(res.counts ? res.counts.notes : 0),
              }),
            });
          } else if (action === 'clearSession') {
            const del = res.deleted || {};
            setFlash({
              kind: 'ok',
              text: t('db.clearSessionOk', {
                msgs: fmtNum(del.msgs ?? 0),
                scenes: fmtNum(del.scenes ?? 0),
                notes: fmtNum(del.notes ?? 0),
              }),
            });
            void loadDbOverview();
            void loadStatus();
            if (extra.sessionId && extra.sessionId === dbSession) {
              void loadDbRows({ sessionId: dbSession, page: 0 });
            }
          }
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('db.actionFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setDbActionBusy('');
        }
      };

      const triggerDbSessionIndex = async (targetSid, targetScope = 'incremental', extra = {}) => {
        if (!targetSid) return;
        const pollRun = ++dbPollSeq.current;
        if (dbTaskTimer.current) {
          clearTimeout(dbTaskTimer.current);
          dbTaskTimer.current = null;
        }
        setDbActionBusy(`${targetScope}:${targetSid}`);
        setFlash(null);
        setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'running', progress: null, detail: '', error: null });
        let taskId = null;
        try {
          const res = await rpcWrite('rebuild', { sessionId: targetSid, scope: targetScope, ...extra });
          if (!alive.current || dbPollSeq.current !== pollRun) return;
          taskId = res && typeof res.taskId === 'string' ? res.taskId : null;
          if (!taskId) throw new Error(t('index.noTaskId'));
          setDbTask({
            sessionId: targetSid,
            scope: targetScope,
            phase: 'running',
            progress: normalizeTaskProgress(res.progress),
            detail: '',
            error: null,
          });
        } catch (e) {
          if (alive.current && dbPollSeq.current === pollRun) {
            setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: null, detail: '', error: msgOf(e) });
            setDbActionBusy('');
          }
          return;
        }

        const poll = async () => {
          if (!alive.current || dbPollSeq.current !== pollRun) return;
          try {
            const task = await rpcRead('task', { taskId });
            if (!alive.current || dbPollSeq.current !== pollRun) return;
            const prog = normalizeTaskProgress(task && task.progress);
            if (task.state === 'done') {
              const r = task.result || {};
              const parts = [];
              if (r.synced > 0) parts.push(t('index.resultSynced', { n: fmtNum(r.synced) }));
              if (r.indexed > 0) parts.push(t('index.resultIndexed', { n: fmtNum(r.indexed) }));
              if (r.scenes > 0) parts.push(t('index.resultScenes', { n: fmtNum(r.scenes) }));
              if (r.skipped) parts.push(r.skipped);
              if (parts.length === 0) parts.push(t('index.syncUpToDate'));
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'done', progress: prog, detail: parts.join(' · '), error: null });
              setDbActionBusy('');
              void loadDbOverview();
              if (targetSid === sessionId) {
                void loadStatus();
                if (targetScope === 'scene') void loadDays();
              }
              return;
            }
            if (task.state === 'failed') {
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: prog, detail: '', error: pickStr(task.error) ?? '—' });
              setDbActionBusy('');
              return;
            }
            setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'running', progress: prog, detail: '', error: null });
          } catch (e) {
            if (alive.current && dbPollSeq.current === pollRun) {
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: null, detail: '', error: msgOf(e) });
              setDbActionBusy('');
            }
            return;
          }
          if (alive.current && dbPollSeq.current === pollRun) {
            dbTaskTimer.current = setTimeout(poll, REBUILD_POLL_MS);
          }
        };
        dbTaskTimer.current = setTimeout(poll, 350);
      };

      const runDbSql = async (sqlOverride) => {
        const sqlText = typeof sqlOverride === 'string' ? sqlOverride : dbSql;
        if (!sqlText || !sqlText.trim()) return;
        setDbSqlBusy(true);
        setDbSqlErr(null);
        try {
          const res = await rpcWrite('dbQuery', { sql: sqlText, limit: 100 });
          if (!alive.current) return;
          setDbSqlRes(res);
        } catch (e) {
          if (!alive.current) return;
          setDbSqlRes(null);
          setDbSqlErr(msgOf(e));
        } finally {
          if (alive.current) setDbSqlBusy(false);
        }
      };

      function renderDb() {
        return h(DbTabView, {
          t, locale, sessionId, useSessions: props.useSessions,
          dbSubTab, setDbSubTab, dbOverview, dbOverviewBusy,
          dbSession, setDbSession, dbTable, setDbTable,
          dbWindowKind, setDbWindowKind, dbVecFilter, setDbVecFilter,
          dbFilter, setDbFilter, dbPage, setDbPage,
          dbPageInput, setDbPageInput, dbRowsData, dbRowsBusy,
          dbExpandedRow, setDbExpandedRow, dbTask, dbActionBusy,
          dbSql, setDbSql, dbSqlBusy, dbSqlRes, dbSqlErr,
          copiedKey, handleCopy, loadDbOverview, loadDbRows,
          runDbMaintain, triggerDbSessionIndex, runDbSql,
          jumpToTimeline, setTab,
        });
      }

      /* ---------- 组装 ---------- */

      if (sessionId === null) {
        return h('div', { style: { ...S.root, padding: 12 } },
          h('div', { style: S.emptyCard }, t('common.noSession')));
      }

      // 六个页面：概览 / 搜索 / 时间轴 / 笔记 / 核对 / 库管理
      const tabIds = ['overview', 'search', 'timeline', 'notes', 'verify', 'db'];

      const tabbar = h('div', { style: S.tabbar, role: 'tablist' },
        ...tabIds.map((id) => h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === id,
          style: tab === id ? { ...S.tab, ...S.tabActive } : S.tab,
          onClick: () => setTab(id),
        },
          t(`tab.${id}`),
          id === 'verify' && flagsErr !== null
            ? h('span', { style: S.tabBadge }, '!')
            : id === 'verify' && flags.length > 0
              ? h('span', { style: S.tabBadge }, String(flags.length))
              : null)));

      const reloadTab = () => {
        if (tab === 'overview') { void refresh(); return; }
        if (tab === 'search') { void runSearch(); return; }
        if (tab === 'db') {
          void loadDbOverview();
          if (dbSubTab === 'browse') void loadDbRows();
          return;
        }
        if (tab === 'timeline') void loadDays();
        else if (tab === 'notes') {
          if (notesView === 'trash') void loadDeletedNotes();
          else void loadNotes();
        } else void loadFlags();
      };

      // 标签页读取失败：错误带显示在内容**上方**，不替换已有内容（更早几天读失败不该清屏）
      const tabContent = h('div', { key: tab, className: 'dvp-tab-in' },
        tabErr !== null
          ? h('div', { style: { ...S.errorCard, marginBottom: 8 } },
            h('div', null, tabErr),
            h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btn, onClick: reloadTab }, t('common.retry'))))
          : null,
        tab === 'overview' ? renderOverview()
          : tab === 'search' ? renderSearch()
            : tab === 'timeline' ? renderTimeline()
              : tab === 'notes' ? renderNotes()
                : tab === 'db' ? renderDb()
                  : renderVerify());

      const bodyInner = h('div', { style: { maxWidth: 820, width: '100%', margin: '0 auto' } },
        flash
          ? h('div', {
            style: {
              ...(flash.kind === 'ok' ? S.flashOk : flash.kind === 'warn' ? S.flashWarn : S.flashErr),
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 8,
            },
          },
            h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, flash.text),
            h('button', {
              type: 'button',
              style: { appearance: 'none', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontSize: FS.md },
              onClick: () => setFlash(null),
              'aria-label': t('common.cancel'),
            }, '×'))
          : null,

        tab === 'db'
          ? tabContent
          : emptyKind !== null
          // 空态只在概览页展开（2026-11-18，A4 BUG 12）：
          // 之前四个 tab 内容完全一样、点了没反应 —— 看起来像坏了。
          // 现在概览页给完整空态卡（含能直接救场的按钮），其他页只说「先让它有东西」。
          ? (tab === 'overview'
            ? renderEmptyCard()
            : h('div', { style: S.emptyCard },
              h('div', null, t('empty.otherTab')),
              h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => setTab('overview'),
                }, t('empty.goOverview')))))
          : loadErr !== null
            ? h('div', null,
              h('div', { style: S.errorCard },
                t('common.failed'),
                h('div', { style: S.errDetail }, loadErr)),
              h('div', { style: S.actions },
                h('button', { type: 'button', style: S.btn, onClick: refresh }, t('common.retry'))))
            : tabContent);

      const body = h('div', {
        ref: bodyRef,
        style: S.body,
        role: 'tabpanel',
        onScroll: (e) => {
          const top = e.currentTarget ? e.currentTarget.scrollTop : 0;
          setShowBackTop(top > 260);
        },
      },
        bodyInner,
        showBackTop
          ? h('button', {
            type: 'button',
            style: S.backTopBtn,
            title: t('common.backTop'),
            'aria-label': t('common.backTop'),
            onClick: () => {
              if (bodyRef.current && typeof bodyRef.current.scrollTo === 'function') {
                bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
              }
            },
          }, '↑')
          : null);

      return h('div', {
        style: S.root,
        'data-dsh-verbatim': '',
        onKeyDown: (e) => {
          const tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
          const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
          if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
            e.preventDefault();
            openSearchTab();
          }
        },
      },
        // 动画样式表（内联 style 写不了 keyframes / :hover），全部限定在 [data-dsh-verbatim] 子树内
        h('style', null,
          // 不确定进度条
          '@keyframes dvp-run{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}'
          // 列表项滑入：往下走 + 淡入（时间流动感）
          + '@keyframes dvp-slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}'
          // 整个展开块的淡入
          + '@keyframes dvp-fade{from{opacity:0}to{opacity:1}}'
          // 标签页切换轻柔进入（180ms）
          + '@keyframes dvp-tab-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'
          // 时间线节点脉冲
          + '@keyframes dvp-node{0%{box-shadow:0 0 0 0 ' + BRAND + '}'
          + '70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}'
          // 竖线「画下来」
          + '@keyframes dvp-spine{from{transform:scaleY(0)}to{transform:scaleY(1)}}'
          // 骨架屏 shimmer
          + '@keyframes dvp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'
          // 跳转定位命中消息脉冲发光
          + '@keyframes dvp-flash-hit{'
          + '0%{background:color-mix(in srgb,' + BRAND + ' 24%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,' + BRAND + ' 45%,transparent)}'
          + '45%{background:color-mix(in srgb,' + BRAND + ' 16%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,' + BRAND + ' 18%,transparent)}'
          + '100%{background:color-mix(in srgb,' + BRAND + ' 6%,transparent);box-shadow:0 0 0 0 transparent}}'
          + '[data-dsh-verbatim] .dvp-slide{animation:dvp-slide .24s cubic-bezier(.2,.7,.3,1) both}'
          + '[data-dsh-verbatim] .dvp-fade{animation:dvp-fade .2s ease both}'
          + '[data-dsh-verbatim] .dvp-tab-in{animation:dvp-tab-in .18s cubic-bezier(.2,.7,.3,1) both}'
          + '[data-dsh-verbatim] .dvp-node{animation:dvp-node .9s ease-out both}'
          + '[data-dsh-verbatim] .dvp-spine{animation:dvp-spine .3s ease-out both;transform-origin:top}'
          + '[data-dsh-verbatim] .dvp-spine::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:1px;'
          + 'background:linear-gradient(180deg,rgba(90,115,156,.46),rgba(210,125,125,.28) 65%,transparent);pointer-events:none}'
          + '[data-dsh-verbatim] .dvp-flash-hit{animation:dvp-flash-hit 2.2s ease-out both;border-radius:' + RADIUS_SM + '}'
          + '[data-dsh-verbatim] .dvp-shimmer{background:linear-gradient(90deg,'
          + 'var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)) 25%,'
          + 'var(--dsw-alias-bg-layer-1,rgba(128,128,128,.22)) 50%,'
          + 'var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)) 75%);'
          + 'background-size:200% 100%;animation:dvp-shimmer 1.4s ease-in-out infinite}'
          + '[data-dsh-verbatim] .dvp-card{transition:border-color .16s ease,background-color .16s ease}'
          + '[data-dsh-verbatim] .dvp-card:hover{border-color:' + BORDER_STRONG + '}'
          + '@media (prefers-reduced-motion:reduce){'
          + '[data-dsh-verbatim] .dvp-running{animation:none!important;width:100%!important;opacity:.45}'
          + '[data-dsh-verbatim] .dvp-slide,[data-dsh-verbatim] .dvp-fade,[data-dsh-verbatim] .dvp-tab-in,'
          + '[data-dsh-verbatim] .dvp-node,[data-dsh-verbatim] .dvp-spine{animation:none!important;opacity:1!important;transform:none!important}'
          + '[data-dsh-verbatim] .dvp-shimmer{animation:none!important;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}'
          + '[data-dsh-verbatim] .dvp-flash-hit{animation:none!important;background:color-mix(in srgb,' + BRAND + ' 12%,transparent);'
          + 'box-shadow:inset 0 0 0 1px color-mix(in srgb,' + BRAND + ' 45%,transparent)}}'),
        // 头部只留标题 + 刷新（开关/统计/索引已经进「概览」页了）
        h('div', { style: S.head }, renderTitle()),
        tabbar,
        body);
    }

