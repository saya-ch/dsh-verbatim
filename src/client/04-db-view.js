    /**
     * 「库」标签页独立视图组件 —— 负责全库总览、数据浏览（支持 kind/向量筛选与详情检视）与只读 SQL。
     */
    function DbTabView(props) {
      const {
        t,
        locale,
        sessionId,
        useSessions,
        dbSubTab,
        setDbSubTab,
        dbOverview,
        dbOverviewBusy,
        dbSession,
        setDbSession,
        dbTable,
        setDbTable,
        dbWindowKind,
        setDbWindowKind,
        dbVecFilter,
        setDbVecFilter,
        dbFilter,
        setDbFilter,
        dbPage,
        setDbPage,
        dbPageInput,
        setDbPageInput,
        dbRowsData,
        dbRowsBusy,
        dbExpandedRow,
        setDbExpandedRow,
        dbTask,
        dbActionBusy,
        dbSql,
        setDbSql,
        dbSqlBusy,
        dbSqlRes,
        dbSqlErr,
        copiedKey,
        handleCopy,
        loadDbOverview,
        loadDbRows,
        runDbMaintain,
        triggerDbSessionIndex,
        runDbSql,
        jumpToTimeline,
        setTab,
      } = props;

      const rawSessions = dbOverview && Array.isArray(dbOverview.sessions) ? dbOverview.sessions : [];
      const [dbMediaPreviews, setDbMediaPreviews] = useState({});
      const [captionDrafts, setCaptionDrafts] = useState({});
      const [captionBusyId, setCaptionBusyId] = useState(null);
      const [confirmDeleteSid, setConfirmDeleteSid] = useState(null);
      const mounted = useRef(true);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

      const toggleDbMediaPreview = async (mediaId) => {
        const key = String(mediaId);
        if (dbMediaPreviews[key]) {
          setDbMediaPreviews((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          return;
        }
        setDbMediaPreviews((prev) => ({ ...prev, [key]: { loading: true } }));
        try {
          const res = await rpcRead('mediaPreview', dbSession ? { id: mediaId, sessionId: dbSession } : { id: mediaId });
          if (!mounted.current) return;
          setDbMediaPreviews((prev) => ({ ...prev, [key]: res }));
        } catch (e) {
          if (!mounted.current) return;
          setDbMediaPreviews((prev) => ({ ...prev, [key]: { ok: false, reason: msgOf(e) } }));
        }
      };

      const saveMediaCaption = async (mediaId, fallbackCaption = '') => {
        const key = String(mediaId);
        const text = typeof captionDrafts[key] === 'string' ? captionDrafts[key] : String(fallbackCaption ?? '');
        setCaptionBusyId(mediaId);
        try {
          await rpcWrite('setMediaCaption', dbSession ? { id: mediaId, sessionId: dbSession, caption: text } : { id: mediaId, caption: text });
          if (!mounted.current) return;
          await loadDbRows();
        } catch (e) {
          if (mounted.current) {
            setDbMediaPreviews((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ok: false, reason: msgOf(e) } }));
          }
        } finally {
          if (mounted.current) setCaptionBusyId(null);
        }
      };
      const sessions = sessionId
        ? [
          ...rawSessions.filter((s) => s.sessionId === sessionId),
          ...rawSessions.filter((s) => s.sessionId !== sessionId),
        ]
        : rawSessions;

      const renderTaskBanner = () => {
        if (!dbTask) return null;
        if (dbTask.phase === 'running') {
          const prog = dbTask.progress;
          const hasRatio = prog && typeof prog.total === 'number' && prog.total > 0;
          const pctVal = hasRatio
            ? (typeof prog.pct === 'number' ? prog.pct : Math.min(100, Math.round((prog.done / prog.total) * 100)))
            : null;
          return h('div', { style: { ...S.card, marginTop: 0, marginBottom: 8 } },
            h('div', { style: { ...S.rowBetween, alignItems: 'center' } },
              h('span', { style: S.hint }, `${shortSid(dbTask.sessionId)} · ${(prog && prog.label) || t('index.syncRunning')}`),
              hasRatio
                ? h('span', { style: { ...S.hint, fontVariantNumeric: 'tabular-nums', color: LABEL2 } },
                  `${fmtNum(prog.done, locale)} / ${fmtNum(prog.total, locale)} (${pctVal}%)`)
                : null),
            h('div', { style: S.progressTrack },
              hasRatio
                ? h('div', { style: { ...S.progressFill, width: `${pctVal}%` } })
                : h('div', { className: 'dvp-running', style: S.progressPulse })));
        }
        if (dbTask.phase === 'done') {
          return h('div', { style: { ...S.flashOk, marginBottom: 8 } },
            `${shortSid(dbTask.sessionId)} · ${t('index.syncDone')} ${dbTask.detail}`);
        }
        return h('div', { style: { ...S.flashErr, marginBottom: 8 } },
          `${shortSid(dbTask.sessionId)} · ${t('index.rebuildFail', { err: dbTask.error ?? '—' })}`);
      };

      const renderSessionsView = () => {
        if (dbOverviewBusy && dbOverview === null) {
          return h(SkeletonGroup, { kind: 'cards', count: 3 });
        }
        if (dbOverview === null) return null;
        const tot = dbOverview.totals || {};
        const health = Array.isArray(dbOverview.health) ? dbOverview.health : [];
        const totalSize = (dbOverview.dbBytes || 0) + (dbOverview.walBytes || 0);
        const pathCopied = copiedKey === 'db:path';

        return h('div', null,
          renderTaskBanner(),
          // ① 4 格全库摘要条
          h('div', { style: { ...S.kpiGrid, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginBottom: 8 } },
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.size')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                dbOverview.isMemory ? ':memory:' : fmtBytes(totalSize))),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.schema')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                `v${dbOverview.schemaVersion ?? '?'} · ${dbOverview.hasVec ? 'vec0' : 'JS'}`)),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.sessionsHeading', { n: fmtNum(tot.sessions ?? sessions.length, locale) })),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                fmtNum(tot.msgs ?? 0, locale))),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.vecNo')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md, color: (tot.pendingMsgs ?? 0) > 0 ? WARN : SUCCESS } },
                fmtNum(tot.pendingMsgs ?? 0, locale)))),

          // 路径与维护操作条
          h('div', { style: { ...S.card, marginTop: 0, padding: '8px 10px' } },
            !dbOverview.isMemory && dbOverview.dbPath
              ? h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 8, marginBottom: 6 } },
                h('span', {
                  style: { ...S.hint, fontFamily: CODE_FONT, fontSize: FS.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 auto' },
                  title: dbOverview.dbPath,
                }, dbOverview.dbPath),
                h('button', {
                  type: 'button',
                  style: pathCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                  onClick: () => { void handleCopy('db:path', dbOverview.dbPath); },
                }, pathCopied ? t('common.copied') : t('common.copy')))
              : null,
            health.length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 } },
                ...health.map((item, idx) => h('div', {
                  key: String(idx),
                  style: item.kind === 'warn' ? S.warnHint : S.hint,
                }, `${item.kind === 'warn' ? '⚠ ' : ''}${item.text}`)))
              : null,
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: dbActionBusy !== '',
                onClick: () => { void runDbMaintain('backup'); },
              }, t('db.backup')),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: dbActionBusy !== '',
                onClick: () => { void runDbMaintain('vacuum'); },
              }, t('db.vacuum')),
              (tot.deletedNotes ?? 0) > 0
                ? h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: dbActionBusy !== '',
                  onClick: () => { void runDbMaintain('purgeTrash', { all: true }); },
                }, t('db.purgeTrash', { n: fmtNum(tot.deletedNotes, locale) }))
                : null)),

          // ② 各会话列表
          h('div', { style: { ...S.sectionTitle, marginTop: 12 } }, t('db.sessionsHeading', { n: fmtNum(sessions.length, locale) })),
          sessions.length === 0
            ? h('div', { style: { ...S.emptyCard, marginTop: 6 } }, t('db.noSessions'))
            : h('div', { style: { border: `1px solid ${BORDER}`, borderRadius: RADIUS, overflow: 'hidden', marginTop: 6 } },
              ...sessions.map((s, idx) => {
                const isCur = s.sessionId === sessionId;
                const recOn = s.enabled && s.enabled.record === true;
                const toolsOn = s.enabled && s.enabled.tools === true;
                const cov = s.totalMsgs > 0 ? Math.min(100, Math.round(((s.indexedMsgs ?? 0) / s.totalMsgs) * 100)) : 0;
                return h('div', {
                  key: s.sessionId,
                  style: {
                    padding: '9px 11px',
                    borderTop: idx > 0 ? `1px solid ${BORDER}` : 'none',
                    borderLeft: isCur ? `3px solid ${BRAND}` : '3px solid transparent',
                    background: isCur ? `color-mix(in srgb, ${BRAND} 3%, transparent)` : 'transparent',
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.sm, fontWeight: 600, color: LABEL1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.sessionId },
                      h(SessionInlineName, { useSessions, sessionId: s.sessionId }),
                      isCur ? h('span', { style: { ...S.sourceBadgeVec, marginLeft: 6 } }, t('db.currentBadge')) : null),
                    h('span', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                      h('span', { style: recOn ? S.sourceBadgeBoth : S.tag }, `${t('switch.record')}: ${recOn ? t('switch.on') : t('switch.off')}`),
                      h('span', { style: toolsOn ? S.sourceBadgeBoth : S.tag }, `${t('switch.tools')}: ${toolsOn ? t('switch.on') : t('switch.off')}`))),
                  h('div', { style: { ...S.hint, marginTop: 3, fontVariantNumeric: 'tabular-nums' } },
                    `${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')} · `
                    + `${fmtNum(s.sceneCount, locale)} ${t('common.unitScenes')} · `
                    + `${fmtNum(s.windowCount ?? 0, locale)} ${t('db.kindWindow')} · `
                    + `${cov}% ${t('overview.kpiIndex')} · `
                    + `${fmtNum(s.noteCount, locale)} ${t('overview.kpiNotes')}`),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      onClick: () => {
                        setDbSession(s.sessionId);
                        setDbPage(0);
                        setDbFilter('');
                        setDbWindowKind('');
                        setDbVecFilter('');
                        setDbSubTab('browse');
                        void loadDbRows({ sessionId: s.sessionId, page: 0, query: '', kind: '', vec: '' });
                      },
                    }, t('db.browseBtn')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void triggerDbSessionIndex(s.sessionId, 'incremental'); },
                    }, t('db.syncIndexBtn')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void triggerDbSessionIndex(s.sessionId, 'scene', { useLlm: false }); },
                    }, t('index.resplit')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void runDbMaintain('exportSession', { sessionId: s.sessionId }); },
                    }, t('db.exportBtn')),
                    confirmDeleteSid === s.sessionId
                      ? [
                        h('button', {
                          key: 'del-yes',
                          type: 'button',
                          style: { ...S.btn, borderColor: ERROR, color: ERROR, fontWeight: 600 },
                          disabled: dbActionBusy !== '',
                          onClick: () => {
                            setConfirmDeleteSid(null);
                            void runDbMaintain('clearSession', { sessionId: s.sessionId, removeConfig: true });
                          },
                        }, t('db.deleteSessionConfirm')),
                        h('button', {
                          key: 'del-no',
                          type: 'button',
                          style: S.btn,
                          disabled: dbActionBusy !== '',
                          onClick: () => setConfirmDeleteSid(null),
                        }, t('db.clearSessionCancel')),
                      ]
                      : h('button', {
                        type: 'button',
                        style: { ...S.btn, color: ERROR },
                        disabled: dbActionBusy !== '',
                        onClick: () => setConfirmDeleteSid(s.sessionId),
                      }, t('db.deleteSessionBtn'))));
              })));
      };

      const renderBrowseView = () => {
        const tables = ['msg', 'scene', 'window', 'note', 'flag', 'chunk', 'media'];
        const activeDbSession = dbSession ? rawSessions.find((s) => s.sessionId === dbSession) : null;
        const tableCounts = dbSession
          ? (activeDbSession
            ? (activeDbSession.tables || {
              msg: activeDbSession.totalMsgs ?? 0,
              scene: activeDbSession.sceneCount ?? 0,
              window: activeDbSession.windowCount ?? 0,
              note: (activeDbSession.noteCount ?? 0) + (activeDbSession.deletedNoteCount ?? 0),
              flag: activeDbSession.flagCount ?? 0,
              chunk: activeDbSession.chunkCount ?? 0,
              media: activeDbSession.mediaCount ?? 0,
            })
            : { msg: 0, scene: 0, window: 0, note: 0, flag: 0, chunk: 0, media: 0 })
          : ((dbOverview && dbOverview.tables) || {});

        const rows = dbRowsData && Array.isArray(dbRowsData.rows) ? dbRowsData.rows : [];
        const kindCounts = dbRowsData && dbRowsData.kindCounts ? dbRowsData.kindCounts : null;
        const total = dbRowsData ? (dbRowsData.total ?? 0) : 0;
        const pageSize = dbRowsData ? (dbRowsData.limit ?? 20) : 20;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));

        const jumpDbPage = () => {
          const n = Math.trunc(Number(dbPageInput));
          if (!Number.isFinite(n)) {
            setDbPageInput(String(dbPage + 1));
            return;
          }
          const target = Math.min(totalPages - 1, Math.max(0, n - 1));
          setDbPage(target);
          setDbPageInput(String(target + 1));
          void loadDbRows({ page: target });
        };

        const kindBadge = (k) => {
          if (k === 'thread') return { text: t('db.kindThread'), style: S.sourceBadgeBoth };
          if (k === 'exchange') return { text: t('db.kindExchange'), style: S.sourceBadgeVec };
          return { text: t('db.kindWindow'), style: S.tag };
        };

        const formatRowPreview = (row) => {
          if (dbTable === 'msg') {
            return {
              head: `#${row.seq ?? row.id} · ${row.speaker ?? ''} · ${fmtShort(row.at)}`,
              sceneId: row.scene_id ?? null,
              at: row.at ?? null,
              badges: [
                row.vec_model ? { text: t('db.vecYes'), style: S.sourceBadgeVec } : { text: t('db.vecNo'), style: S.sourceBadgeKw },
                row.in_surface === 0 ? { text: t('timeline.compacted'), style: S.tag } : null,
                row.excluded === 1 ? { text: t('search.excludedTag'), style: S.tag } : null,
              ].filter(Boolean),
              body: String(row.text ?? ''),
            };
          }
          if (dbTable === 'scene') {
            return {
              head: `scene #${row.id} · ${fmtSceneRange(row.start_at, row.end_at)} · ${fmtNum(row.msg_count, locale)} ${t('common.unitMsgs')}`,
              sceneId: row.id ?? null,
              at: row.start_at ?? null,
              badges: [
                row.has_out_of_surface ? { text: t('timeline.compacted'), style: S.tag } : null,
                (row.excluded_count ?? 0) > 0 ? { text: t('search.excludedTag'), style: S.tag } : null,
              ].filter(Boolean),
              body: String(row.gist || t('db.noGist')),
            };
          }
          if (dbTable === 'window') {
            const wKind = row.kind || 'window';
            return {
              head: `#${row.id} · scene #${row.scene_id} [${row.start_msg_id ?? '?'}..${row.end_msg_id ?? '?'}] · ${fmtSceneRange(row.start_at, row.end_at)} · ${fmtNum(row.msg_count, locale)} ${t('common.unitMsgs')}`,
              sceneId: row.scene_id ?? null,
              at: row.start_at ?? null,
              badges: [
                kindBadge(wKind),
                row.vec_model ? { text: t('db.vecYes'), style: S.sourceBadgeVec } : { text: t('db.vecNo'), style: S.sourceBadgeKw },
              ],
              body: String(row.text ?? ''),
            };
          }
          if (dbTable === 'note') {
            return {
              head: `note #${row.id} · ${row.about || '—'} · ${fmtShort(row.at)}`,
              badges: [row.deleted_at ? { text: 'deleted', style: S.sourceBadgeKw } : { text: 'active', style: S.sourceBadgeVec }],
              body: String(row.content ?? ''),
            };
          }
          if (dbTable === 'flag') {
            return {
              head: `flag #${row.id} · msg #${row.msg_id} · ${fmtShort(row.at)}`,
              badges: [row.resolved_at ? { text: 'resolved', style: S.tag } : { text: 'open', style: S.sourceBadgeKw }],
              body: `${row.reason || '—'} — ${String(row.text ?? '').slice(0, 140)}`,
            };
          }
          if (dbTable === 'chunk') {
            return {
              head: `chunk #${row.id} · msg #${row.msg_id} [${row.idx}] (${row.start_char}..${row.end_char})`,
              badges: [],
              body: String(row.snippet ?? ''),
            };
          }
          return {
            head: `media #${row.id} · msg #${row.msg_id} · ${row.width ?? '?'}×${row.height ?? '?'}${row.at ? ` · ${fmtShort(row.at)}` : ''}`,
            sceneId: row.scene_id ?? null,
            at: row.at ?? row.created_at ?? null,
            badges: [
              row.caption ? { text: 'caption', style: S.sourceBadgeVec } : null,
            ].filter(Boolean),
            body: String(row.caption || row.path || ''),
          };
        };

        const activeRow = rows.find((r, i) => `${dbTable}:${r.id ?? i}` === dbExpandedRow) || null;

        return h('div', null,
          // ① 会话 + 表选择紧凑工具栏
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 } },
            h('select', {
              style: S.dbSelect,
              value: dbSession,
              onChange: (e) => {
                const nextSid = e.target.value;
                setDbSession(nextSid);
                setDbPage(0);
                setDbFilter('');
                setDbWindowKind('');
                setDbVecFilter('');
                void loadDbRows({ sessionId: nextSid, page: 0, query: '', kind: '', vec: '' });
              },
            },
              ...sessions.filter((s) => s.sessionId === sessionId).map((s) => h('option', { key: `cur-${s.sessionId}`, value: s.sessionId },
                `★ ${t('db.currentBadge')} · ${shortSid(s.sessionId)} (${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')})`)),
              sessionId && !sessions.some((s) => s.sessionId === sessionId)
                ? h('option', { key: `cur-${sessionId}`, value: sessionId }, `★ ${t('db.currentBadge')} · ${shortSid(sessionId)}`)
                : null,
              h('option', { value: '' }, t('db.allSessions', { n: fmtNum(sessions.length, locale) })),
              ...sessions.filter((s) => s.sessionId !== sessionId).map((s) => h('option', { key: s.sessionId, value: s.sessionId },
                `${shortSid(s.sessionId)} (${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')})`))),

            h('div', { style: S.dbChipRow },
              ...tables.map((tbl) => h('button', {
                key: tbl,
                type: 'button',
                style: dbTable === tbl ? { ...S.dbChip, ...S.dbChipOn } : S.dbChip,
                onClick: () => {
                  setDbTable(tbl);
                  setDbPage(0);
                  setDbFilter('');
                  setDbWindowKind('');
                  setDbVecFilter('');
                  void loadDbRows({ table: tbl, page: 0, query: '', kind: '', vec: '' });
                },
              }, `${t(`db.table.${tbl}`)}${typeof tableCounts[tbl] === 'number' ? ` (${fmtNum(tableCounts[tbl], locale)})` : ''}`))),

            // ② 条件子筛选（window kind / 向量状态）+ 搜索框
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              dbTable === 'window'
                ? h('div', { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
                  ...[
                    { k: '', label: t('db.kindAll') },
                    { k: 'thread', label: `${t('db.kindThread')}${kindCounts ? ` (${fmtNum(kindCounts.thread ?? 0, locale)})` : ''}` },
                    { k: 'exchange', label: `${t('db.kindExchange')}${kindCounts ? ` (${fmtNum(kindCounts.exchange ?? 0, locale)})` : ''}` },
                    { k: 'window', label: `${t('db.kindWindow')}${kindCounts ? ` (${fmtNum(kindCounts.window ?? 0, locale)})` : ''}` },
                  ].map((opt) => h('button', {
                    key: `wk-${opt.k || 'all'}`,
                    type: 'button',
                    style: dbWindowKind === opt.k ? { ...S.pill, ...S.pillActive } : S.pill,
                    onClick: () => {
                      setDbWindowKind(opt.k);
                      setDbPage(0);
                      void loadDbRows({ kind: opt.k, page: 0 });
                    },
                  }, opt.label)))
                : null,
              dbTable === 'msg' || dbTable === 'window'
                ? h('div', { style: { display: 'inline-flex', gap: 4 } },
                  ...[
                    { v: '', label: t('db.vecAll') },
                    { v: 'yes', label: t('db.vecYes') },
                    { v: 'no', label: t('db.vecNo') },
                  ].map((opt) => h('button', {
                    key: `vf-${opt.v || 'all'}`,
                    type: 'button',
                    style: dbVecFilter === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
                    onClick: () => {
                      setDbVecFilter(opt.v);
                      setDbPage(0);
                      void loadDbRows({ vec: opt.v, page: 0 });
                    },
                  }, opt.label)))
                : null,
              h('form', {
                style: { display: 'flex', gap: 4, flex: '1 1 180px', minWidth: 0 },
                onSubmit: (e) => {
                  e.preventDefault();
                  setDbPage(0);
                  void loadDbRows({ page: 0 });
                },
              },
                h('input', {
                  type: 'search',
                  style: S.input,
                  value: dbFilter,
                  placeholder: t('db.filterPlaceholder'),
                  onChange: (e) => setDbFilter(e.target.value),
                }),
                dbFilter
                  ? h('button', {
                    type: 'button',
                    style: S.btn,
                    onClick: () => {
                      setDbFilter('');
                      setDbPage(0);
                      void loadDbRows({ query: '', page: 0 });
                    },
                  }, t('db.filterClear'))
                  : null,
                h('button', { type: 'submit', style: S.btn, disabled: dbRowsBusy }, t('db.filterBtn'))))),

          // ③ 紧凑列表 + 选中详情检视
          dbRowsBusy && dbRowsData === null
            ? h(SkeletonGroup, { kind: 'rows', count: 5 })
            : rows.length === 0
              ? h('div', { style: S.emptyCard }, t('db.emptyRows'))
              : h('div', null,
                h('div', { style: { border: `1px solid ${BORDER}`, borderRadius: RADIUS, overflow: 'hidden' } },
                  ...rows.map((row, idx) => {
                    const rowKey = `${dbTable}:${row.id ?? idx}`;
                    const isOpen = dbExpandedRow === rowKey;
                    const pv = formatRowPreview(row);
                    const rowCopyId = `dbrow:${rowKey}`;
                    const rowCopied = copiedKey === rowCopyId;
                    return h('div', {
                      key: rowKey,
                      style: {
                        borderTop: idx > 0 ? `1px solid ${BORDER}` : 'none',
                        borderLeft: isOpen ? `3px solid ${BRAND}` : '3px solid transparent',
                        background: isOpen ? `color-mix(in srgb, ${BRAND} 4%, transparent)` : 'transparent',
                        padding: '7px 10px',
                      },
                    },
                      h('div', {
                        'data-clickable': '1',
                        style: { ...S.rowBetween, alignItems: 'center', gap: 6 },
                        onClick: () => setDbExpandedRow(isOpen ? null : rowKey),
                      },
                        h('span', { style: { fontFamily: CODE_FONT, fontSize: FS.xs, color: LABEL2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          `${isOpen ? '▾ ' : '▸ '}${pv.head}`),
                        h('span', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                          ...pv.badges.map((b, bi) => h('span', { key: String(bi), style: b.style }, b.text)))),
                      h('div', {
                        style: {
                          marginTop: 2,
                          fontSize: FS.sm,
                          color: LABEL1,
                          lineHeight: 1.45,
                          display: '-webkit-box',
                          WebkitLineClamp: isOpen ? 99 : 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        },
                      }, pv.body),
                      isOpen
                        ? h('div', { style: { marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${BORDER}` } },
                          dbTable === 'media'
                            ? (() => {
                              const mKey = String(row.id);
                              const mPrev = dbMediaPreviews[mKey];
                              const capVal = captionDrafts[mKey] !== undefined ? captionDrafts[mKey] : String(row.caption ?? '');
                              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 } },
                                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                                  h('input', {
                                    type: 'text',
                                    style: { ...S.input, flex: '1 1 200px' },
                                    value: capVal,
                                    placeholder: t('db.mediaCaptionPlaceholder'),
                                    onChange: (e) => {
                                      const v = e.target.value;
                                      setCaptionDrafts((prev) => ({ ...prev, [mKey]: v }));
                                    },
                                  }),
                                  h('button', {
                                    type: 'button',
                                    style: S.primaryBtn,
                                    disabled: captionBusyId === row.id,
                                    onClick: () => { void saveMediaCaption(row.id, row.caption); },
                                  }, captionBusyId === row.id ? '…' : t('db.mediaCaptionSave')),
                                  h('button', {
                                    type: 'button',
                                    style: S.btn,
                                    onClick: () => { void toggleDbMediaPreview(row.id); },
                                  }, t('db.mediaPreviewBtn'))),
                                mPrev
                                  ? (mPrev.loading
                                    ? h('div', { style: S.hint }, '…')
                                    : mPrev.ok && (mPrev.dataUrl || mPrev.url)
                                      ? h('img', {
                                        src: mPrev.dataUrl || mPrev.url,
                                        alt: capVal || `media #${row.id}`,
                                        style: { maxWidth: '100%', maxHeight: 260, borderRadius: RADIUS_SM, border: `1px solid ${BORDER}`, objectFit: 'contain', alignSelf: 'flex-start' },
                                      })
                                      : h('div', { style: S.warnHint }, mPrev.reason || t('common.failed')))
                                  : null);
                            })()
                            : null,
                          h('pre', { style: S.dbDetailPre }, JSON.stringify(row, null, 2)),
                          h('div', { style: { ...S.actions, marginTop: 4 } },
                            pv.sceneId && (!row.session_id || row.session_id === sessionId)
                              ? h('button', {
                                type: 'button',
                                style: S.btn,
                                onClick: () => {
                                  if (typeof jumpToTimeline === 'function') {
                                    void jumpToTimeline({ sceneId: pv.sceneId, at: pv.at, id: dbTable === 'msg' || dbTable === 'media' ? (row.msg_id ?? row.id) : undefined });
                                  } else if (typeof setTab === 'function') {
                                    setTab('timeline');
                                  }
                                },
                              }, t('db.jumpScene'))
                              : null,
                            h('button', {
                              type: 'button',
                              style: rowCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                              onClick: () => { void handleCopy(rowCopyId, JSON.stringify(row, null, 2)); },
                            }, rowCopied ? t('common.copied') : t('common.copy'))))
                        : null);
                  })),
                // 分页栏
                h('div', { style: { ...S.rowBetween, alignItems: 'center', marginTop: 8, flexWrap: 'wrap', gap: 6 } },
                  h('span', { style: { ...S.hint, fontVariantNumeric: 'tabular-nums' } },
                    t('db.pageInfo', { page: dbPage + 1, pages: totalPages, total: fmtNum(total, locale) })),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbPage <= 0 || dbRowsBusy,
                      onClick: () => {
                        const p = Math.max(0, dbPage - 1);
                        setDbPage(p);
                        void loadDbRows({ page: p });
                      },
                    }, t('db.prevPage')),
                    totalPages > 1
                      ? h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                        h('input', {
                          type: 'number',
                          min: 1,
                          max: totalPages,
                          value: dbPageInput,
                          disabled: dbRowsBusy,
                          'aria-label': t('db.jumpPage'),
                          onChange: (e) => { setDbPageInput(e.target.value); },
                          onKeyDown: (e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              jumpDbPage();
                            }
                          },
                          style: {
                            ...S.input,
                            width: 56,
                            padding: '3px 6px',
                            fontSize: FS.xs,
                            textAlign: 'center',
                            fontVariantNumeric: 'tabular-nums',
                          },
                        }),
                        h('button', {
                          type: 'button',
                          style: S.btn,
                          disabled: dbRowsBusy,
                          onClick: jumpDbPage,
                        }, t('db.jumpPage')))
                      : null,
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbPage + 1 >= totalPages || dbRowsBusy,
                      onClick: () => {
                        const p = dbPage + 1;
                        setDbPage(p);
                        void loadDbRows({ page: p });
                      },
                    }, t('db.nextPage'))))));
      };

      const renderSqlView = () => {
        const escSid = String(sessionId || '').replace(/'/g, "''");
        const templates = [
          ...(sessionId ? [
            {
              label: t('db.tplCurMsgs'),
              sql: `SELECT id, seq, speaker, in_surface, vec_model, substr(text, 1, 80) AS preview FROM msg WHERE session_id = '${escSid}' ORDER BY seq DESC LIMIT 20`,
            },
            {
              label: t('db.tplWinKinds'),
              sql: `SELECT COALESCE(kind, 'window') AS kind, COUNT(*) AS cnt, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM window WHERE session_id = '${escSid}' GROUP BY kind`,
            },
            {
              label: t('db.tplCurScenes'),
              sql: `SELECT id, msg_count, compacted_count, substr(gist, 1, 90) AS gist FROM scene WHERE session_id = '${escSid}' ORDER BY start_at DESC LIMIT 20`,
            },
            {
              label: t('db.tplCurNotes'),
              sql: `SELECT id, about, substr(content, 1, 80) AS content, deleted_at FROM note WHERE session_id = '${escSid}' ORDER BY at DESC LIMIT 30`,
            },
          ] : []),
          {
            label: t('db.tplSessions'),
            sql: 'SELECT session_id, COUNT(*) AS msgs, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM msg GROUP BY session_id ORDER BY msgs DESC',
          },
          {
            label: t('db.tplPending'),
            sql: sessionId
              ? `SELECT id, seq, speaker, substr(text, 1, 60) AS preview FROM msg WHERE session_id = '${escSid}' AND excluded = 0 AND vec_model IS NULL ORDER BY at DESC LIMIT 30`
              : 'SELECT id, session_id, seq, speaker, substr(text, 1, 60) AS preview FROM msg WHERE excluded = 0 AND vec_model IS NULL ORDER BY at DESC LIMIT 30',
          },
          {
            label: t('db.tplTables'),
            sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
          },
        ];

        return h('div', null,
          h('div', { style: S.hint }, t('db.sqlHint')),
          h('div', { style: S.dbChipRow },
            ...templates.map((tpl, i) => h('button', {
              key: `tpl-${i}`,
              type: 'button',
              style: S.dbChip,
              onClick: () => {
                setDbSql(tpl.sql);
                void runDbSql(tpl.sql);
              },
            }, tpl.label))),
          h('textarea', {
            style: { ...S.dbSqlArea, marginTop: 6 },
            value: dbSql,
            onChange: (e) => setDbSql(e.target.value),
          }),
          h('div', { style: { ...S.actions, marginTop: 6 } },
            h('button', {
              type: 'button',
              style: S.primaryBtn,
              disabled: dbSqlBusy || !dbSql.trim(),
              onClick: () => { void runDbSql(); },
            }, dbSqlBusy ? '…' : t('db.sqlRun'))),
          dbSqlErr
            ? h('div', { style: { ...S.errorCard, marginTop: 8 } }, dbSqlErr)
            : null,
          dbSqlRes
            ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.hint },
                t('db.sqlMeta', { n: fmtNum(dbSqlRes.rowCount, locale), ms: fmtNum(dbSqlRes.elapsedMs, locale) })
                + (dbSqlRes.truncated ? t('db.sqlTruncated', { shown: fmtNum(dbSqlRes.rows.length, locale) }) : '')),
              dbSqlRes.rows.length === 0
                ? h('div', { style: { ...S.emptyCard, marginTop: 6 } }, t('db.sqlEmpty'))
                : h('div', { style: S.dbTableWrap },
                  h('table', { style: S.dbTable },
                    h('thead', null,
                      h('tr', null,
                        ...dbSqlRes.columns.map((c) => h('th', { key: c, style: S.dbTh }, c)))),
                    h('tbody', null,
                      ...dbSqlRes.rows.map((r, ri) => h('tr', { key: String(ri) },
                        ...dbSqlRes.columns.map((c) => {
                          const v = r[c];
                          const text = v === null || v === undefined ? 'NULL' : String(v);
                          return h('td', { key: c, style: S.dbTd, title: text }, text);
                        })))))))
            : null);
      };

      return h('div', null,
        h('div', { style: { ...S.rowBetween, alignItems: 'center', marginBottom: 8 } },
          h('div', { style: { ...S.segmented, marginBottom: 0 } },
            ...['sessions', 'browse', 'sql'].map((sub) => h('button', {
              key: sub,
              type: 'button',
              style: dbSubTab === sub ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => {
                setDbSubTab(sub);
                if (sub === 'browse' && dbRowsData === null) void loadDbRows();
              },
            }, t(sub === 'sessions' ? 'db.subSessions' : sub === 'browse' ? 'db.subBrowse' : 'db.subSql')))),
          h('button', {
            type: 'button',
            style: S.btn,
            disabled: dbOverviewBusy || dbRowsBusy,
            onClick: () => {
              void loadDbOverview();
              if (dbSubTab === 'browse') void loadDbRows();
            },
          }, t('common.refresh'))),
        dbSubTab === 'sessions' ? renderSessionsView()
          : dbSubTab === 'browse' ? renderBrowseView()
            : renderSqlView());
    }
