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

