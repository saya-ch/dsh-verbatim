        function SessionManagerTab({ t, ST, setFlash, useSessions }) {
          const [overview, setOverview] = useState(null);
          const [loading, setLoading] = useState(true);
          const [loadErr, setLoadErr] = useState(null);
          const [busyKey, setBusyKey] = useState('');
          const [filter, setFilter] = useState('');
          const [confirmSid, setConfirmSid] = useState(null);
          const alive = useRef(true);
          useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

          const useSessionsHook = typeof useSessions === 'function' ? useSessions : noopUseSessions;
          let hostById = null;
          try {
            hostById = useSessionsHook((snapshot) => (snapshot && snapshot.byId ? snapshot.byId : null));
          } catch {
            hostById = null;
          }
          const hostTitleById = new Map();
          if (hostById && typeof hostById === 'object') {
            for (const [sid, rec] of Object.entries(hostById)) {
              if (!rec || typeof rec !== 'object') continue;
              const title = rec.displayTitle ?? rec.title ?? rec.name ?? '';
              if (typeof title === 'string' && title.trim()) {
                hostTitleById.set(sid, title.trim());
              }
            }
          }

          const load = useCallback(async () => {
            setLoading(true);
            setLoadErr(null);
            try {
              const res = await callRpc('dbOverview', {}, 'read');
              if (alive.current) setOverview(res);
            } catch (e) {
              const m = msgOf(e);
              if (alive.current) {
                setLoadErr(m);
                setFlash({ kind: 'err', text: m });
              }
            } finally {
              if (alive.current) setLoading(false);
            }
          }, [setFlash]);

          useEffect(() => { void load(); }, [load]);

          const rawSessions = Array.isArray(overview?.sessions) ? overview.sessions : [];
          const q = filter.trim().toLowerCase();
          const sessions = rawSessions.filter((s) => {
            if (!q) return true;
            const title = (hostTitleById.get(s.sessionId) || '').toLowerCase();
            return s.sessionId.toLowerCase().includes(q) || title.includes(q);
          });

          const toggleOne = async (sid, key, value) => {
            setBusyKey(`${sid}:${key}`);
            try {
              await callRpc('set', { sessionId: sid, key, value }, 'write');
              verbatimBus.emit('sessionChanged', { sessionId: sid });
              await load();
            } catch (e) {
              setFlash({ kind: 'err', text: msgOf(e) });
            } finally {
              if (alive.current) setBusyKey('');
            }
          };

          const batchToggle = async (key, value) => {
            if (sessions.length === 0) return;
            setBusyKey(`batch:${key}:${value}`);
            let mutated = false;
            try {
              for (const s of sessions) {
                await callRpc('set', { sessionId: s.sessionId, key, value }, 'write');
                mutated = true;
              }
              if (alive.current) setFlash({ kind: 'ok', text: t('settings.sessionsBatchOk', { n: fmtNum(sessions.length) }) });
            } catch (e) {
              if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
            } finally {
              if (mutated) {
                verbatimBus.emit('sessionChanged', {});
                await load();
              }
              if (alive.current) setBusyKey('');
            }
          };

          const handleExport = async (sid) => {
            setBusyKey(`export:${sid}`);
            try {
              const res = await callRpc('dbMaintain', { action: 'exportSession', sessionId: sid }, 'write');
              const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `verbatim-${sid.slice(0, 16)}.json`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (e) {
              setFlash({ kind: 'err', text: msgOf(e) });
            } finally {
              if (alive.current) setBusyKey('');
            }
          };

          const handleExportMd = async (sid) => {
            setBusyKey(`exportMd:${sid}`);
            try {
              const res = await callRpc('dbMaintain', { action: 'exportSession', sessionId: sid }, 'write');
              const lines = [`# 逐字记忆导出（${sid}）`, ''];
              const scenes = Array.isArray(res?.scenes) ? res.scenes : [];
              const msgs = Array.isArray(res?.msgs) ? res.msgs : [];
              const notes = Array.isArray(res?.notes) ? res.notes : [];
              const byScene = new Map();
              for (const m of msgs) {
                const key = m.sceneId ?? 'pending';
                if (!byScene.has(key)) byScene.set(key, []);
                byScene.get(key).push(m);
              }
              for (const sc of scenes) {
                lines.push(`## ${fmtShort(sc.startAt)} ~ ${fmtClock(sc.endAt)}（${sc.msgCount} 条）`);
                if (sc.gist) lines.push(`> ${sc.gist}`);
                lines.push('');
                for (const m of (byScene.get(sc.id) || [])) {
                  lines.push(`- **${m.speaker === 'user' ? '我' : 'TA'}** \`${fmtClock(m.at)}\`：${m.text}`);
                }
                lines.push('');
              }
              const pendingMsgs = byScene.get('pending') || [];
              if (pendingMsgs.length > 0) {
                lines.push(`## Pending (${pendingMsgs.length})`, '');
                for (const m of pendingMsgs) {
                  lines.push(`- **${m.speaker === 'user' ? '我' : 'TA'}** \`${fmtClock(m.at)}\`：${m.text}`);
                }
                lines.push('');
              }
              if (notes.length > 0) {
                lines.push('## 笔记', '');
                for (const n of notes) lines.push(`- \`${fmtShort(n.at)}\` ${n.content}`);
                lines.push('');
              }
              const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `verbatim-${sid.slice(0, 16)}.md`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (e) {
              setFlash({ kind: 'err', text: msgOf(e) });
            } finally {
              if (alive.current) setBusyKey('');
            }
          };

          const handleClear = async (sid) => {
            setBusyKey(`clear:${sid}`);
            setConfirmSid(null);
            try {
              const res = await callRpc('dbMaintain', { action: 'clearSession', sessionId: sid }, 'write');
              const d = res?.deleted ?? {};
              setFlash({
                kind: 'ok',
                text: t('db.clearSessionOk', {
                  msgs: fmtNum(d.msgs ?? 0),
                  scenes: fmtNum(d.scenes ?? 0),
                  notes: fmtNum(d.notes ?? 0),
                }),
              });
              verbatimBus.emit('sessionChanged', { sessionId: sid });
              await load();
            } catch (e) {
              setFlash({ kind: 'err', text: msgOf(e) });
            } finally {
              if (alive.current) setBusyKey('');
            }
          };

          const importInputRef = useRef(null);
          const handleImportFile = async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            setBusyKey('import');
            try {
              const text = await file.text();
              const payload = JSON.parse(text);
              const res = await callRpc('dbMaintain', { action: 'importSession', payload }, 'write');
              const imp = res?.imported ?? {};
              setFlash({
                kind: 'ok',
                text: t('db.importSessionOk', {
                  sid: shortSid(res?.sessionId || ''),
                  msgs: fmtNum(imp.msgs ?? 0),
                  notes: fmtNum(imp.notes ?? 0),
                }),
              });
              verbatimBus.emit('sessionChanged', { sessionId: res?.sessionId || '' });
              await load();
            } catch (err) {
              setFlash({ kind: 'err', text: msgOf(err) });
            } finally {
              if (alive.current) setBusyKey('');
            }
          };

          return h('div', { style: ST.card },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('div', { style: ST.cardTitle }, t('settings.sessionsTitle')),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('input', {
                  ref: importInputRef,
                  type: 'file',
                  accept: '.json,application/json',
                  style: { display: 'none' },
                  onChange: handleImportFile,
                }),
                h('button', {
                  type: 'button',
                  style: ST.smallBtn,
                  disabled: loading || busyKey !== '',
                  onClick: () => { importInputRef.current?.click(); },
                }, t('db.importSessionBtn')),
                h('button', {
                  type: 'button',
                  style: ST.smallBtn,
                  disabled: loading || busyKey !== '',
                  onClick: () => { void load(); },
                }, t('common.refresh')))),
            h('div', { style: ST.cardHint }, t('settings.sessionsHint')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 } },
              h('button', { type: 'button', style: ST.smallBtn, disabled: busyKey !== '' || sessions.length === 0, onClick: () => { void batchToggle('record', true); } }, t('settings.sessionsAllRecOn')),
              h('button', { type: 'button', style: ST.smallBtn, disabled: busyKey !== '' || sessions.length === 0, onClick: () => { void batchToggle('record', false); } }, t('settings.sessionsAllRecOff')),
              h('button', { type: 'button', style: ST.smallBtn, disabled: busyKey !== '' || sessions.length === 0, onClick: () => { void batchToggle('tools', true); } }, t('settings.sessionsAllToolsOn')),
              h('button', { type: 'button', style: ST.smallBtn, disabled: busyKey !== '' || sessions.length === 0, onClick: () => { void batchToggle('tools', false); } }, t('settings.sessionsAllToolsOff'))),
            rawSessions.length > 0
              ? h('input', {
                type: 'text',
                value: filter,
                placeholder: t('settings.sessionsFilter'),
                onChange: (e) => setFilter(e.target.value),
                style: { ...ST.input, marginBottom: 12, width: '100%', boxSizing: 'border-box' },
              })
              : null,
            loadErr !== null
              ? h('div', { style: { ...ST.cardHint, color: ERROR } }, loadErr)
              : loading && overview === null
                ? h('div', { style: ST.cardHint }, t('common.loading'))
                : sessions.length === 0
                  ? h('div', { style: ST.cardHint }, t('settings.sessionsEmpty'))
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12 } },
                  ...sessions.map((s) => {
                    const title = hostTitleById.get(s.sessionId) || '';
                    const recOn = Boolean(s.enabled?.record);
                    const toolsOn = Boolean(s.enabled?.tools);
                    const hasData = (s.totalMsgs ?? 0) > 0 || (s.sceneCount ?? 0) > 0 || (s.noteCount ?? 0) > 0;
                    const confirming = confirmSid === s.sessionId;
                    return h('div', {
                      key: s.sessionId,
                      style: {
                        padding: '10px 12px',
                        borderRadius: RADIUS_SM,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: BORDER,
                        background: 'var(--dsw-alias-bg-layer-1, transparent)',
                      },
                    },
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                        h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                          h('div', { style: { fontWeight: 600, fontSize: FS.base, color: LABEL1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.sessionId },
                            title ? `${title} · ${shortSid(s.sessionId)}` : s.sessionId),
                          h('div', { style: { fontSize: FS.xs, color: LABEL3, marginTop: 2, fontVariantNumeric: 'tabular-nums' } },
                            `${fmtNum(s.totalMsgs ?? 0)} ${t('common.unitMsgs')} · ${fmtNum(s.sceneCount ?? 0)} ${t('common.unitScenes')} · ${t('overview.kpiIndex')} ${fmtNum(s.indexedMsgs ?? 0)}/${fmtNum(s.totalMsgs ?? 0)} · ${t('settings.tabLlm')} ${fmtNum(s.llmGistScenes ?? 0)}/${fmtNum(s.sceneCount ?? 0)}${(s.sceneCount ?? 0) > 0 ? ` (${Math.round(((s.llmGistScenes ?? 0) / s.sceneCount) * 100)}%)` : ''} · ${t('overview.kpiNotes')} ${fmtNum(s.noteCount ?? 0)}`)),
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
                          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: FS.xs, cursor: 'pointer' } },
                            h('input', {
                              type: 'checkbox',
                              checked: recOn,
                              disabled: busyKey !== '',
                              onChange: (e) => { void toggleOne(s.sessionId, 'record', e.target.checked); },
                            }),
                            t('switch.record')),
                          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: FS.xs, cursor: 'pointer' } },
                            h('input', {
                              type: 'checkbox',
                              checked: toolsOn,
                              disabled: busyKey !== '',
                              onChange: (e) => { void toggleOne(s.sessionId, 'tools', e.target.checked); },
                            }),
                            t('switch.tools')))),
                      hasData
                        ? h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
                          h('button', {
                            type: 'button',
                            style: ST.smallBtn,
                            disabled: busyKey !== '',
                            onClick: () => { void handleExport(s.sessionId); },
                          }, t('db.exportBtn')),
                          h('button', {
                            type: 'button',
                            style: ST.smallBtn,
                            disabled: busyKey !== '',
                            onClick: () => { void handleExportMd(s.sessionId); },
                          }, t('db.exportMdBtn')),
                          confirming
                            ? [
                              h('button', {
                                key: 'yes',
                                type: 'button',
                                style: { ...ST.smallBtn, color: ERROR, borderColor: ERROR },
                                disabled: busyKey !== '',
                                onClick: () => { void handleClear(s.sessionId); },
                              }, t('db.clearSessionConfirm')),
                              h('button', {
                                key: 'no',
                                type: 'button',
                                style: ST.smallBtn,
                                onClick: () => setConfirmSid(null),
                              }, t('db.clearSessionCancel')),
                            ]
                            : h('button', {
                              type: 'button',
                              style: { ...ST.smallBtn, color: ERROR },
                              disabled: busyKey !== '',
                              onClick: () => setConfirmSid(s.sessionId),
                            }, t('db.clearSessionBtn')))
                        : null);
                  })));
        }

        function PanelSeat(props) {
          const liveT = typeof props.t === 'function' ? props.t : fallbackT;
          let liveLocale = locale;
          try {
            const active = typeof ctx.locale?.getSnapshot === 'function' ? ctx.locale.getSnapshot().active : null;
            if (active) liveLocale = String(active).toLowerCase().startsWith('en') ? 'en' : 'zh';
          } catch {
            liveLocale = locale;
          }
          return h(Panel, {
            ...props,
            key: `verbatim:${String(props.sessionId ?? 'none')}`,
            t: liveT,
            locale: liveLocale,
          });
        }

        const TabTitle = makeTabTitle(fallbackT);

