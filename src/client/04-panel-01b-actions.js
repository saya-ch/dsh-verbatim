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
        const mine = (listSeq.current.task = (listSeq.current.task || 0) + 1);
        const staleTask = () => !alive.current || settled || mine !== listSeq.current.task;

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
          if (staleTask()) return;
          let terminal = null;
          let resolvedScope = scope;

          if (taskId !== null) {
            try {
              const task = await rpcRead('task', { taskId });
              if (staleTask()) return;
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
              if (staleTask()) return;
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

          if (staleTask()) return;
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

      const openScene = async (sceneId, forceOpen = false, reload = false) => {
        if (forceOpen && !reload && scene && scene.sceneId === sceneId && scene.detail && !scene.error) {
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

