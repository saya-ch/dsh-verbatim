    /* ══════════════════════════ 注册 ══════════════════════════ */

    /** 标签页标题（侧栏 tab 条上的那一条） */
    function makeTabTitle(fallbackT) {
      return function TabTitle(props) {
        const t = typeof props.t === 'function' ? props.t : fallbackT;
        return h('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' },
        },
          h(Glyph, { size: 11 }),
          h('span', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, t('title')));
      };
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        let locale = 'zh';
        try {
          const active = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot().active : null;
          const preference = ctx.locale.preference ?? active;
          locale = String(preference ?? 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
        } catch {
          locale = 'zh';
        }
        const fallbackT = t;

        /**
         * 槽位座椅。**key 用 sessionId**：切到另一个对话时整个面板重新挂载，
         * 任何旧对话的 state（样本、展开的场、标记表单）都不可能带过去（A2/B1）。
         * `key` 与 `props.sessionId` 一起保证「一个对话一个面板」。
         */
        /* ══════════════════════════ 设置页（全局） ══════════════════════════ */
        //
        // 这里改的是**全局**配置（所有会话共享的那份，$DSH_HOME/verbatim/config.json）。
        // 单个对话的开关在右侧面板里，两者优先级：对话级 > 全局级（D-014）。
        //
        // 三块：
        //   ① 新会话默认开关（record / tools，默认关 —— D-230）
        //   ② 语义检索模型（模型 id / 维度 / **环境变量名**，绝不填 key 本身）
        //   ③ 检索参数（懒执行阈值 / 默认条数 / 上限）
        function SettingsPanel(props) {
          const t = props.t;
          const [state, setState] = useState(null);   // { config, path, embedding, llm, rerank, vecExt, exists, warnings }
          const [stab, setStab] = useState('general'); // general | embedding | llm | rerank
          const [detectedDim, setDetectedDim] = useState(null);
          const [err, setErr] = useState(null);
          const [busy, setBusy] = useState(true);
          const [flash, setFlash] = useState(null);
          // **草稿**（作者 2026-11-18：改成显式保存，不搞「失焦偷偷写盘」）
          // 键是 `embedding.model` 这样的路径，值是没保存的输入。
          const [drafts, setDrafts] = useState({});
          const alive = useRef(true);
          useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
          useEffect(() => {
            if (!flash || flash.kind !== 'ok') return undefined;
            const id = setTimeout(() => { if (alive.current) setFlash(null); }, 3500);
            return () => clearTimeout(id);
          }, [flash]);
          const dirty = Object.keys(drafts).length > 0;

          const setDraft = useCallback((path, value) => {
            setDrafts((prev) => ({ ...prev, [path]: value }));
          }, []);
          const clearDrafts = useCallback((paths) => {
            setDrafts((prev) => {
              const next = { ...prev };
              let changed = false;
              for (const p of paths) {
                if (Object.prototype.hasOwnProperty.call(next, p)) {
                  delete next[p];
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }, []);
          /** 取某字段当前该显示的值：有草稿用草稿，否则用服务端值 */
          const val = useCallback((path, fallback) => (
            Object.prototype.hasOwnProperty.call(drafts, path) ? drafts[path] : fallback
          ), [drafts]);


          const load = useCallback(async () => {
            setBusy(true); setErr(null);
            try {
              const raw = await callRpc('globalConfig', {}, 'read');
              if (alive.current) setState(normalizeGlobal(raw));
            } catch (e) {
              if (alive.current) setErr(msgOf(e));
            } finally {
              if (alive.current) setBusy(false);
            }
          }, []);

          useEffect(() => { void load(); }, [load]);

          /** 提交一组改动；**返回是否成功** —— 失败时调用方必须保留草稿（A4 BUG 3） */
          const patch = useCallback(async (body) => {
            setBusy(true); setFlash(null);
            try {
              const r = await callRpc('setGlobalConfig', { patch: body }, 'write');
              if (!alive.current) return true;
              if (r && r.config) {
                setState((prev) => normalizeGlobal({ ...(prev || {}), ...r }));
              } else {
                await load();
              }
              verbatimBus.emit('globalConfigChanged', { patch: body });
              if (alive.current) setFlash({ kind: 'ok', text: (r && r.applies) || t('settings.saved') });
              return true;
            } catch (e) {
              if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
              return false;
            } finally {
              if (alive.current) setBusy(false);
            }
          }, [load, t]);

          /** 把草稿按块分组后一次提交 */
          const saveAll = useCallback(async () => {
            if (!dirty) return;
            const groups = {};
            // 数值字段必须转成 number（2026-11-18，A4 BUG 4）：
            // 之前只有 embedding.dim 转了，search.* 原样把字符串写进 config.json
            // → 回显时 `typeof '7' !== 'number'` 判定失败 → 界面跳回默认值，
            //   用户看到「已保存」但数字没变，以为保存没生效。
            const NUMERIC = new Set(['embedding.dim', 'llm.dailyLimit', 'rerank.topN', 'search.defaultLimit', 'search.maxLimit']);
            for (const [path, v] of Object.entries(drafts)) {
              const [block, field] = path.split('.');
              if (!field) continue;
              groups[block] = groups[block] || {};
              if (NUMERIC.has(path)) {
                const n = Number(v);
                // 非法值**不静默替换成默认值**（A4 BUG 11）：留原值，让服务端/用户看到
                groups[block][field] = Number.isFinite(n) && n > 0 ? n : v;
              } else {
                groups[block][field] = v;
              }
            }
            // **只有成功才清草稿**（A4 BUG 3）：失败时清空会让用户输入直接消失，
            // 输入框还会跳回服务端的旧值 —— 用户会以为自己的修改被吞了。
            const ok = await patch(groups);
            if (ok) setDrafts({});
          }, [drafts, dirty, patch]);

          const discardAll = useCallback(() => {
            setDrafts({});
            setFlash({ kind: 'ok', text: t('settings.discarded') });
          }, [t]);

          const cfg = state ? state.config : null;
          const embModelVal = cfg ? val('embedding.model', cfg.embedding.model) : '';
          const embBaseVal = cfg ? val('embedding.baseUrl', cfg.embedding.baseUrl) : '';
          const embModeVal = cfg ? cfg.embedding.mode : 'remote';
          useEffect(() => { setDetectedDim(null); }, [embModeVal, embBaseVal, embModelVal]);

          if (err !== null) {
            return h('div', { style: { padding: 16 } },
              h('div', { style: S.errorCard }, t('settings.loadFailed', { err })),
              h('div', { style: S.actions }, h('button', { style: S.btn, onClick: load }, t('common.retry'))));
          }
          if (state === null) return h('div', { style: { padding: 16, ...S.dim } }, t('common.loading'));

          const emb = state.embedding;
          const llmSt = state.llm;
          const rrSt = state.rerank;
          const vecExt = state.vecExt;

          const badgeOf = (st, optional) => {
            if (optional && !st.enabled) return { text: t('settings.badgeOff'), style: ST.badgeOff };
            if (st.ready) return { text: t('settings.badgeOn'), style: ST.badgeOk };
            return { text: t('settings.badgeWarn'), style: ST.badgeWarn };
          };

          const tabItems = [
            { id: 'general', label: t('settings.tabGeneral'), badge: null },
            { id: 'sessions', label: t('settings.tabSessions'), badge: null },
            { id: 'embedding', label: t('settings.tabEmbedding'), badge: badgeOf(emb, false) },
            { id: 'rerank', label: t('settings.tabRerank'), badge: badgeOf(rrSt, true) },
            { id: 'llm', label: t('settings.tabLlm'), badge: badgeOf(llmSt, true) },
          ];

          const renderModelSection = ({
            sectionKey,
            title,
            statusBanner,
            statusWarn,
            optionalSwitch,
            enabled,
            mode,
            baseUrlHint,
            modelHint,
            extraRows,
            stView,
          }) => h('div', { key: sectionKey, style: ST.card },
            h('div', { style: ST.cardTitle }, title),
            h('div', { style: statusWarn ? { ...ST.cardHint, color: WARN } : ST.cardHint }, statusBanner),
            optionalSwitch || null,
            (!optionalSwitch || enabled) ? [
              settingChoice(t('settings.mode'), t('settings.modeHint'),
                mode,
                [{ value: 'local', label: t('settings.modeLocal') },
                 { value: 'remote', label: t('settings.modeRemote') }],
                (v) => patch({ [sectionKey]: { mode: v } }), `${sectionKey}-mode`, !optionalSwitch),

              mode === 'local'
                ? localProbe(t, {
                  kind: sectionKey,
                  current: val(`${sectionKey}.baseUrl`, cfg[sectionKey].baseUrl),
                  currentModel: val(`${sectionKey}.model`, cfg[sectionKey].model),
                  onPick: (svc, pickedModel) => {
                    const list = sectionKey === 'embedding'
                      ? svc.embeddingModels
                      : (sectionKey === 'rerank' ? svc.rerankModels : svc.chatModels);
                    const pickModel = pickedModel || list?.[0] || (sectionKey === 'rerank' ? null : svc.models?.[0]) || null;
                    clearDrafts([`${sectionKey}.baseUrl`, `${sectionKey}.model`]);
                    void patch({
                      [sectionKey]: {
                        baseUrl: svc.baseUrl,
                        ...(pickModel ? { model: pickModel } : {}),
                      },
                    });
                  },
                })
                : null,

              settingInput(t('settings.baseUrl'), baseUrlHint,
                val(`${sectionKey}.baseUrl`, cfg[sectionKey].baseUrl),
                drafts[`${sectionKey}.baseUrl`] !== undefined,
                (v) => setDraft(`${sectionKey}.baseUrl`, v), `${sectionKey}-base`),
              settingInput(t('settings.model'), modelHint,
                val(`${sectionKey}.model`, cfg[sectionKey].model),
                drafts[`${sectionKey}.model`] !== undefined,
                (v) => setDraft(`${sectionKey}.model`, v), `${sectionKey}-model`),
              ...(extraRows || []),
              settingSecret(t, t('settings.apiKey'),
                mode === 'local' ? t('settings.apiKeyHintLocal') : t('settings.apiKeyHint'),
                stView.keySource === 'config'
                  ? t('settings.keyFromConfig', { masked: stView.apiKeyMasked ?? '' })
                  : stView.keySource === 'env'
                    ? t('settings.keyFromEnv', { name: stView.envName ?? '' })
                    : t('settings.apiKeyNote'),
                stView.apiKeyMasked,
                val(`${sectionKey}.apiKey`, ''),
                drafts[`${sectionKey}.apiKey`] !== undefined,
                (v) => {
                  if (v === '') clearDrafts([`${sectionKey}.apiKey`]);
                  else setDraft(`${sectionKey}.apiKey`, v);
                },
                stView.hasApiKey ? () => {
                  clearDrafts([`${sectionKey}.apiKey`]);
                  void patch({ [sectionKey]: { apiKey: '' } });
                } : null,
                `${sectionKey}-key`),
              modelTestRow(t, sectionKey, {
                mode,
                baseUrl: val(`${sectionKey}.baseUrl`, cfg[sectionKey].baseUrl),
                model: val(`${sectionKey}.model`, cfg[sectionKey].model),
                apiKey: val(`${sectionKey}.apiKey`, ''),
              }, (pickedModel) => {
                clearDrafts([`${sectionKey}.model`]);
                setDraft(`${sectionKey}.model`, pickedModel);
              }, `${sectionKey}-test`, (testRes) => {
                if (sectionKey === 'embedding' && testRes?.ok && Number.isFinite(testRes.nativeDim)) {
                  setDetectedDim(testRes.nativeDim);
                }
              }),
              h('div', { key: `${sectionKey}-warn`, style: { ...ST.cardHint, paddingTop: 6, paddingBottom: 16 } }, t('settings.apiKeyWarn')),
            ] : null);

          return h('div', { style: ST.page, 'data-dsh-verbatim': '' },
            h('div', { style: ST.head },
              h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: ST.title }, t('settings.title')),
                h('div', { style: ST.subtitle }, t('settings.subtitle'))),
              // **显式保存**（作者 2026-11-18：不能靠失焦偷偷写盘）
              h('div', { style: ST.headActions },
                dirty
                  ? h('button', { type: 'button', style: ST.btnGhost, disabled: busy, onClick: discardAll }, t('settings.discard'))
                  : null,
                h('button', {
                  type: 'button',
                  style: dirty ? ST.btnPrimary : ST.btnPrimaryOff,
                  disabled: !dirty || busy,
                  onClick: () => { void saveAll(); },
                }, dirty ? t('settings.save') : t('settings.savedShort')))),

            // ── 设置页分段 Tab 栏 ──
            h('div', { style: ST.tabBar, role: 'tablist' },
              ...tabItems.map((it) => {
                const active = stab === it.id;
                return h('button', {
                  key: it.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': active,
                  style: active ? { ...ST.tabBtn, ...ST.tabBtnOn } : ST.tabBtn,
                  onClick: () => setStab(it.id),
                },
                  h('span', null, it.label),
                  it.badge ? h('span', { style: it.badge.style }, it.badge.text) : null);
              })),

            dirty
              ? h('div', { style: { ...ST.cardHint, color: WARN, marginBottom: 10 } }, t('settings.unsavedHint'))
              : null,

            flash !== null && h('div', {
              style: { ...ST.flash, ...(flash.kind === 'ok' ? ST.flashOk : ST.flashErr) },
            }, flash.text),

            stab === 'general' ? h('div', { key: 'tab-general' }, [
              h('div', {
                key: 'g-guide',
                style: {
                  ...ST.card,
                  borderColor: emb.ready ? 'rgba(26,158,93,.35)' : `color-mix(in srgb, ${BRAND} 35%, ${BORDER})`,
                  background: emb.ready
                    ? 'linear-gradient(135deg, rgba(26,158,93,.06), transparent)'
                    : `linear-gradient(135deg, color-mix(in srgb, ${BRAND} 8%, transparent), transparent)`,
                },
              },
                h('div', { style: ST.cardTitle }, t('settings.guideTitle')),
                h('div', { style: { ...ST.cardHint, color: emb.ready ? SUCCESS : LABEL2 } },
                  emb.ready ? t('settings.guideDone') : t('settings.guidePending')),
                h('div', { style: { ...ST.row, ...ST.rowFirst } },
                  h('div', { style: ST.rowMain },
                    h('div', { style: ST.rowName }, t('settings.guideStep1Title')),
                    h('div', { style: ST.rowHint }, t('settings.guideStep1Desc'))),
                  h('div', { style: ST.rowControl },
                    emb.ready
                      ? h('span', { style: { fontSize: FS.sm, color: SUCCESS, fontWeight: 500 } },
                        t('settings.guideStep1Ready', { model: emb.model || cfg.embedding.model || 'OK' }))
                      : h('button', {
                        type: 'button',
                        style: ST.btnPrimary,
                        onClick: () => setStab('embedding'),
                      }, t('settings.guideStep1Go')))),
                h('div', { style: ST.row },
                  h('div', { style: ST.rowMain },
                    h('div', { style: ST.rowName }, t('settings.guideStep2Title')),
                    h('div', { style: ST.rowHint }, t('settings.guideStep2Desc'))),
                  h('div', { style: ST.rowControl },
                    rrSt.ready
                      ? h('span', { style: { fontSize: FS.sm, color: SUCCESS, fontWeight: 500 } },
                        t('settings.guideStep2Ready', { model: rrSt.model || cfg.rerank.model || 'OK' }))
                      : h('button', {
                        type: 'button',
                        style: ST.btnGhost,
                        onClick: () => setStab('rerank'),
                      }, t('settings.guideStep2Go')))),
                h('div', { style: ST.row },
                  h('div', { style: ST.rowMain },
                    h('div', { style: ST.rowName }, t('settings.guideStep3Title')),
                    h('div', { style: ST.rowHint }, t('settings.guideStep3Desc'))))),

              h('div', { key: 'g-def', style: ST.card },
                h('div', { style: ST.cardTitle }, t('settings.defaults')),
                h('div', { style: ST.cardHint }, t('settings.defaultsHint')),
                settingRow(t('switch.record'), t('settings.defaultsRecordHint'),
                  cfg.defaults.record, (v) => patch({ defaults: { record: v } }), 'r-record', true),
                settingRow(t('switch.tools'), t('settings.defaultsToolsHint'),
                  cfg.defaults.tools, (v) => patch({ defaults: { tools: v } }), 'r-tools')),

              h('div', { key: 'g-search', style: ST.card },
                h('div', { style: ST.cardTitle }, t('settings.search')),
                h('div', { style: { ...ST.cardHint, paddingBottom: 6 } },
                  h('strong', { style: { color: LABEL1 } }, `${t('settings.alwaysHybrid')}：`),
                  t('settings.alwaysHybridDesc')),
                settingInput(t('settings.defaultLimit'), t('settings.defaultLimitHint'),
                  String(val('search.defaultLimit', cfg.search.defaultLimit)),
                  drafts['search.defaultLimit'] !== undefined,
                  (v) => setDraft('search.defaultLimit', v), 'i-limit', true),
                settingRow(t('settings.autoIndex'), t('settings.autoIndexHint'),
                  cfg.index.autoIndex, (v) => patch({ index: { autoIndex: v } }), 'i-autoindex')),

              h('div', { key: 'g-vec', style: { ...ST.card, padding: '14px 18px' } },
                h('div', { style: { ...ST.cardTitle, paddingTop: 0, paddingBottom: 6 } }, t('settings.vecExtTitle')),
                h('div', { style: { ...ST.foot, color: vecExt.loaded ? SUCCESS : WARN, marginBottom: 10 } },
                  vecExt.loaded
                    ? t('settings.vecExtLoaded', { platform: vecExt.platform, arch: vecExt.arch, path: vecExt.path || 'vec0' })
                    : t('settings.vecExtFallback', { platform: vecExt.platform, arch: vecExt.arch })),
                h('div', { style: ST.foot }, `${t('settings.path')}：${state.path}`),
                h('div', { style: ST.foot }, state.exists ? t('settings.pathExists') : t('settings.pathMissing')),
                ...(state.warnings ?? []).map((w, i) => h('div', { key: i, style: ST.warnLine }, w))),
            ]) : null,

            stab === 'sessions'
              ? h(SessionManagerTab, {
                key: 'sessions',
                t,
                ST,
                setFlash,
                useSessions: props.useSessions,
              })
              : null,

            stab === 'embedding' ? renderModelSection({
              sectionKey: 'embedding',
              title: t('settings.embedding'),
              statusBanner: emb.ready
                ? t('settings.embeddingReady', { model: emb.model, dim: emb.dim })
                : t('settings.embeddingOff', { reason: emb.reason ?? '' }),
              statusWarn: !emb.ready,
              mode: cfg.embedding.mode,
              baseUrlHint: t('settings.baseUrlHint'),
              modelHint: t('settings.modelHint'),
              stView: emb,
              extraRows: (() => {
                const curDim = Number(val('embedding.dim', cfg.embedding.dim));
                const dimAlerts = [];
                if (detectedDim !== null) {
                  if (Number.isFinite(curDim) && detectedDim < curDim) {
                    dimAlerts.push(h('div', {
                      key: 'dim-err',
                      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingBottom: 8, fontSize: FS.xs, color: ERROR },
                    },
                      h('span', null, t('settings.dimDetectedTooHigh', { native: detectedDim, dim: curDim })),
                      h('button', {
                        type: 'button',
                        style: ST.smallBtn,
                        onClick: () => {
                          clearDrafts(['embedding.dim']);
                          void patch({ embedding: { dim: detectedDim } });
                        },
                      }, t('settings.dimSyncNative', { dim: detectedDim }))));
                  } else if (Number.isFinite(curDim) && detectedDim > curDim) {
                    dimAlerts.push(h('div', {
                      key: 'dim-mrl',
                      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingBottom: 8, fontSize: FS.xs, color: LABEL2 },
                    },
                      h('span', null, t('settings.dimDetectedMrl', { native: detectedDim, dim: curDim })),
                      h('button', {
                        type: 'button',
                        style: ST.smallBtn,
                        onClick: () => {
                          clearDrafts(['embedding.dim']);
                          void patch({ embedding: { dim: detectedDim } });
                        },
                      }, t('settings.dimSyncNative', { dim: detectedDim }))));
                  } else if (detectedDim === curDim) {
                    dimAlerts.push(h('div', {
                      key: 'dim-ok',
                      style: { paddingBottom: 8, fontSize: FS.xs, color: SUCCESS },
                    }, t('settings.dimDetectedOk', { dim: detectedDim })));
                  }
                }
                if (vecExt.loaded && Number.isFinite(curDim) && curDim !== 1024) {
                  dimAlerts.push(h('div', {
                    key: 'dim-vec0',
                    style: { paddingBottom: 8, fontSize: FS.xs, color: WARN },
                  }, t('settings.dimVecMismatch')));
                }
                return [
                  settingInput(t('settings.dim'), t('settings.dimHint'),
                    String(val('embedding.dim', cfg.embedding.dim)),
                    drafts['embedding.dim'] !== undefined,
                    (v) => setDraft('embedding.dim', v), 'i-dim'),
                  ...dimAlerts,
                ];
              })(),
            }) : null,

            stab === 'llm' ? h('div', { key: 'llm', style: ST.card },
              h('div', { style: ST.cardTitle }, t('settings.llm')),
              h('div', {
                style: {
                  marginTop: 6,
                  marginBottom: 8,
                  padding: '9px 12px',
                  borderRadius: RADIUS_SM,
                  background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
                  border: `1px solid ${BORDER}`,
                  fontSize: FS.sm,
                  color: LABEL2,
                  lineHeight: 1.5,
                },
              }, t('settings.llmCompanionNote')),
              h('div', { style: llmSt.enabled && !llmSt.ready ? { ...ST.cardHint, color: WARN } : ST.cardHint },
                !llmSt.enabled
                  ? t('settings.llmDisabled')
                  : llmSt.ready
                    ? t('settings.llmReady', { model: llmSt.model || cfg.llm.model })
                    : t('settings.llmOff', { reason: llmSt.reason ?? '' })),
              settingRow(t('settings.llmEnable'), t('settings.llmEnableHint'),
                cfg.llm.enabled, (v) => patch({ llm: { enabled: v } }), 'l-enable', true),
              cfg.llm.enabled
                ? [
                  h(DshLlmPicker, {
                    key: 'l-picker',
                    t,
                    provider: cfg.llm.provider,
                    model: cfg.llm.model,
                    onSelect: (p, m) => patch({ llm: { provider: p, model: m } }),
                  }),
                  settingRow(t('settings.llmAutoRefine'), t('settings.llmAutoRefineHint'),
                    cfg.llm.autoRefine, (v) => patch({ llm: { autoRefine: v } }), 'l-autorefine'),
                  settingInput(t('settings.llmDailyLimit'), t('settings.llmDailyLimitHint'),
                    String(val('llm.dailyLimit', cfg.llm.dailyLimit)),
                    drafts['llm.dailyLimit'] !== undefined,
                    (v) => setDraft('llm.dailyLimit', v), 'l-dailylimit'),
                ]
                : null) : null,

            stab === 'rerank' ? renderModelSection({
              sectionKey: 'rerank',
              title: t('settings.rerank'),
              statusBanner: !rrSt.enabled
                ? t('settings.rerankDisabled')
                : rrSt.ready
                  ? t('settings.rerankReady', { model: rrSt.model || cfg.rerank.model })
                  : t('settings.rerankOff', { reason: rrSt.reason ?? '' }),
              statusWarn: rrSt.enabled && !rrSt.ready,
              optionalSwitch: settingRow(t('settings.rerankEnable'), t('settings.rerankEnableHint'),
                cfg.rerank.enabled, (v) => patch({ rerank: { enabled: v } }), 'rr-enable', true),
              enabled: cfg.rerank.enabled,
              mode: cfg.rerank.mode,
              baseUrlHint: t('settings.rerankBaseUrlHint'),
              modelHint: t('settings.rerankModelHint'),
              stView: rrSt,
              extraRows: [
                settingInput(t('settings.rerankTopN'), t('settings.rerankTopNHint'),
                  String(val('rerank.topN', cfg.rerank.topN)),
                  drafts['rerank.topN'] !== undefined,
                  (v) => setDraft('rerank.topN', v), 'rr-topn'),
              ],
            }) : null,
          );
        }

        /* ══════════════ 设置页专属样式（面板的 S 里没有 switch/knob，别混用） ══════════════ */
        //
        // 设置页是独立一页，不是右侧窄面板，字号/留白/控件尺寸都要另算。
        // 之前借 S.switch / S.knob / S.sectionTitle，那三个键在 S 里**不存在**，
        // 全部退化成原生元素 —— 开关是小方块、标题是默认字体，所以「很丑」。
        const ST = {
          page: {
            boxSizing: 'border-box',
            padding: '22px 26px 48px',
            maxWidth: 760,
            fontSize: FS.md,
            lineHeight: 1.6,
            color: LABEL1,
            fontFamily: 'inherit',
          },
          title: { fontSize: FS.lg, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 6 },
          subtitle: { fontSize: FS.base, color: LABEL3, marginBottom: 20, lineHeight: 1.55 },
          card: {
            boxSizing: 'border-box',
            border: `1px solid ${BORDER}`,
            borderRadius: RADIUS,
            padding: '2px 18px',
            marginBottom: 16,
          },
          cardTitle: { fontSize: FS.md, fontWeight: 600, paddingTop: 16, paddingBottom: 2 },
          cardHint: { fontSize: FS.base, color: LABEL3, paddingBottom: 6, lineHeight: 1.5 },
          row: {
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            padding: '13px 0',
            borderTop: `1px solid ${BORDER}`,
          },
          rowFirst: { borderTop: 'none' },
          rowMain: { flex: '1 1 auto', minWidth: 0 },
          rowName: { fontSize: FS.md, color: LABEL1 },
          rowHint: { fontSize: FS.sm, color: LABEL3, marginTop: 3, lineHeight: 1.5 },
          rowControl: { flex: '0 0 auto', display: 'flex', alignItems: 'center' },
          track: (on) => ({
            position: 'relative',
            flex: '0 0 auto',
            width: 40,
            height: 22,
            borderRadius: 11,
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            background: on ? BRAND : 'rgba(128,128,128,.34)',
            transition: 'background .16s ease',
            outline: 'none',
          }),
          knob: (on) => ({
            position: 'absolute',
            top: 2,
            left: on ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,.22)',
            transition: 'left .16s ease',
          }),
          input: {
            boxSizing: 'border-box',
            width: 250,
            padding: '7px 10px',
            fontSize: FS.base,
            color: LABEL1,
            fontFamily: CODE_FONT,
            background: 'transparent',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: BORDER_STRONG,
            borderRadius: RADIUS_SM,
            outline: 'none',
          },
          flash: { borderRadius: RADIUS_SM, padding: '9px 12px', marginBottom: 14, fontSize: FS.base },
          flashOk: { background: 'rgba(26,158,93,.10)', border: '1px solid rgba(26,158,93,.38)', color: SUCCESS },
          flashErr: { background: 'rgba(192,57,43,.10)', border: '1px solid rgba(192,57,43,.38)', color: ERROR },
          segmented: {
            display: 'inline-flex',
            border: `1px solid ${BORDER_STRONG}`,
            borderRadius: RADIUS_SM,
            overflow: 'hidden',
          },
          seg: {
            padding: '6px 14px',
            fontSize: FS.base,
            border: 'none',
            background: 'transparent',
            color: LABEL2,
            cursor: 'pointer',
            outline: 'none',
          },
          segOn: { background: BRAND, color: '#fff' },
          tabBar: {
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            marginBottom: 16,
            paddingBottom: 10,
            borderBottom: `1px solid ${BORDER}`,
          },
          tabBtn: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 13px',
            fontSize: FS.base,
            fontWeight: 500,
            borderRadius: RADIUS_SM,
            border: `1px solid ${BORDER}`,
            background: 'transparent',
            color: LABEL2,
            cursor: 'pointer',
            outline: 'none',
          },
          tabBtnOn: {
            background: `color-mix(in srgb, ${BRAND} 10%, transparent)`,
            borderColor: BRAND,
            color: BRAND,
            fontWeight: 600,
          },
          badgeOk: {
            fontSize: FS.xs,
            padding: '1px 6px',
            borderRadius: 99,
            background: 'rgba(26,158,93,.14)',
            color: SUCCESS,
            fontWeight: 500,
          },
          badgeOff: {
            fontSize: FS.xs,
            padding: '1px 6px',
            borderRadius: 99,
            background: 'rgba(128,128,128,.14)',
            color: LABEL3,
            fontWeight: 500,
          },
          badgeWarn: {
            fontSize: FS.xs,
            padding: '1px 6px',
            borderRadius: 99,
            background: 'rgba(217,119,6,.14)',
            color: WARN,
            fontWeight: 500,
          },
          foot: { fontSize: FS.sm, color: LABEL3, lineHeight: 1.6, wordBreak: 'break-all' },
          smallBtn: {
            padding: '5px 11px',
            fontSize: FS.sm,
            color: LABEL2,
            background: 'transparent',
            border: `1px solid ${BORDER_STRONG}`,
            borderRadius: RADIUS_SM,
            cursor: 'pointer',
            outline: 'none',
          },
          probeCard: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            padding: '8px 12px',
            minWidth: 150,
            background: 'transparent',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: BORDER,
            borderRadius: RADIUS_SM,
            cursor: 'pointer',
            outline: 'none',
            textAlign: 'left',
          },
          probeCardOn: { borderColor: BRAND, background: 'rgba(77,107,254,.08)' },
          head: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            marginBottom: 18,
          },
          headActions: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 },
          btnPrimary: {
            padding: '7px 16px',
            fontSize: FS.base,
            fontWeight: 500,
            color: '#fff',
            background: BRAND,
            border: 'none',
            borderRadius: RADIUS_SM,
            cursor: 'pointer',
            outline: 'none',
          },
          btnPrimaryOff: {
            padding: '7px 16px',
            fontSize: FS.base,
            color: LABEL3,
            background: 'transparent',
            border: `1px solid ${BORDER}`,
            borderRadius: RADIUS_SM,
            cursor: 'default',
            outline: 'none',
          },
          btnGhost: {
            padding: '7px 12px',
            fontSize: FS.base,
            color: LABEL2,
            background: 'transparent',
            border: 'none',
            borderRadius: RADIUS_SM,
            cursor: 'pointer',
            outline: 'none',
          },
          inputEdited: { borderColor: WARN, background: 'rgba(197,139,0,.05)' },
          chip: {
            padding: '4px 10px',
            fontSize: FS.xs,
            fontFamily: CODE_FONT,
            color: LABEL2,
            background: 'transparent',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: BORDER_STRONG,
            borderRadius: RADIUS_SM,
            cursor: 'pointer',
            outline: 'none',
            fontWeight: 400,
          },
          chipOn: {
            color: BRAND,
            borderColor: BRAND,
            background: 'rgba(59,130,246,.08)',
            fontWeight: 600,
          },
          warnLine: { fontSize: FS.sm, color: WARN, marginTop: 4, lineHeight: 1.5 },
        };

