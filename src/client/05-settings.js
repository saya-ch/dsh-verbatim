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

        /** 一行「标签 + 说明 + 开关」 */
        function settingRow(label, hint, value, onChange, key, first) {
          const on = value === true;
          return h('div', { key, style: first ? { ...ST.row, ...ST.rowFirst } : ST.row },
            h('div', { style: ST.rowMain },
              h('div', { style: ST.rowName }, label),
              hint ? h('div', { style: ST.rowHint }, hint) : null),
            h('div', { style: ST.rowControl },
              h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': on,
                'aria-label': label,
                style: ST.track(on),
                onClick: () => onChange(!on),
              }, h('span', { style: ST.knob(on) }))));
        }

        /**
         * 本地服务探测面板：点「本地」后自动扫一遍常见服务，不让人手填地址。
         *
         * 探测结果直接变成可选按钮：点一下就把 baseUrl 填好，
         * 如果那个服务只暴露了一个 embedding 模型，连模型也一起选上。
         */
        function LocalProbe(props) {
          const { t, kind = 'embedding', current, currentModel, onPick } = props;
          const [state, setState] = useState({ phase: 'idle', data: null, err: null });
          const [showAllModels, setShowAllModels] = useState(false);
          const mounted = useRef(true);
          const scanSeq = useRef(0);
          useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

          const scan = useCallback(async () => {
            const seq = ++scanSeq.current;
            setState({ phase: 'scanning', data: null, err: null });
            try {
              const raw = await callRpc('probeLocal', {}, 'read');
              if (!mounted.current || scanSeq.current !== seq) return;
              setState({ phase: 'done', data: normalizeProbe(raw), err: null });
            } catch (e) {
              if (!mounted.current || scanSeq.current !== seq) return;
              setState({ phase: 'done', data: null, err: msgOf(e) });
            }
          }, []);

          useEffect(() => { void scan(); }, [scan]);

          if (state.phase === 'scanning') {
            return h('div', { style: { ...ST.row } },
              h('div', { style: ST.rowMain },
                h('div', { style: ST.rowName }, t('settings.probeScanning')),
                h('div', { style: ST.rowHint }, t('settings.probeScanningHint'))));
          }

          if (state.err !== null) {
            return h('div', { style: ST.row },
              h('div', { style: ST.rowMain },
                h('div', { style: { ...ST.rowName, color: ERROR } }, t('settings.probeFailed', { err: state.err })),
                h('div', { style: ST.rowHint }, t('settings.probeManual'))),
              h('div', { style: ST.rowControl },
                h('button', { type: 'button', style: ST.smallBtn, onClick: scan }, t('common.retry'))));
          }

          const data = state.data;
          const alive = data?.alive ?? [];
          if (alive.length === 0) {
            return h('div', { style: ST.row },
              h('div', { style: ST.rowMain },
                h('div', { style: ST.rowName }, t('settings.probeNone')),
                h('div', { style: ST.rowHint }, data?.summary ?? t('settings.probeManual'))),
              h('div', { style: ST.rowControl },
                h('button', { type: 'button', style: ST.smallBtn, onClick: scan }, t('settings.probeAgain'))));
          }

          const preferredList = (s) => (kind === 'llm'
            ? (s.chatModels?.length ? s.chatModels : s.models)
            : kind === 'rerank'
              ? (s.rerankModels ?? [])
              : (s.embeddingModels?.length ? s.embeddingModels : s.models));
          const activeSvc = alive.find((s) => current && current.startsWith(s.baseUrl.replace(/\/+$/, ''))) || alive[0];
          const preferred = activeSvc ? preferredList(activeSvc) : [];
          const allModels = activeSvc?.models ?? [];
          const shownModels = showAllModels || (preferred.length === 0 && kind !== 'rerank') ? allModels : preferred;

          return h('div', { style: { ...ST.row, alignItems: 'flex-start' } },
            h('div', { style: ST.rowMain },
              h('div', { style: ST.rowName }, t('settings.probeFound', { n: alive.length })),
              h('div', { style: ST.rowHint }, t('settings.probePickHint')),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
                ...alive.map((s) => {
                  const on = current && current.startsWith(s.baseUrl.replace(/\/+$/, ''));
                  const modelCount = preferredList(s).length;
                  return h('button', {
                    key: s.id,
                    type: 'button',
                    'aria-pressed': on,
                    style: on ? { ...ST.probeCard, ...ST.probeCardOn } : ST.probeCard,
                    onClick: () => onPick(s),
                  },
                  h('div', { style: { fontWeight: 600, fontSize: FS.base } }, s.name),
                  h('div', { style: { fontSize: FS.xs, color: LABEL3, marginTop: 2 } }, s.baseUrl),
                  h('div', { style: { fontSize: FS.xs, color: LABEL3, marginTop: 2 } },
                    modelCount > 0 ? t('settings.probeModels', { n: modelCount }) : t('settings.probeNoModel')));
                })),
              activeSvc && shownModels.length > 0
                ? h('div', { style: { marginTop: 10 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 } },
                    h('span', { style: { fontSize: FS.xs, color: LABEL3 } }, t('settings.probeModelPick')),
                    allModels.length > preferred.length && !showAllModels
                      ? h('button', {
                        type: 'button',
                        style: ST.smallBtn,
                        onClick: () => setShowAllModels(true),
                      }, t('settings.probeShowAll', { n: allModels.length }))
                      : null),
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    ...shownModels.map((m) => {
                      const active = currentModel === m;
                      return h('button', {
                        key: m,
                        type: 'button',
                        'aria-pressed': active,
                        style: active ? { ...ST.chip, ...ST.chipOn } : ST.chip,
                        onClick: () => onPick(activeSvc, m),
                      }, m);
                    })))
                : null,
              h('div', { style: { marginTop: 8 } },
                h('button', { type: 'button', style: ST.smallBtn, onClick: scan }, t('settings.probeAgain')))),
            null);
        }

        function normalizeProbe(raw) {
          const r = raw && typeof raw === 'object' ? raw : {};
          const map = (s) => ({
            id: String(s?.id ?? ''),
            name: String(s?.name ?? ''),
            baseUrl: String(s?.baseUrl ?? ''),
            hint: typeof s?.hint === 'string' ? s.hint : '',
            models: Array.isArray(s?.models) ? s.models : [],
            embeddingModels: Array.isArray(s?.embeddingModels) ? s.embeddingModels : [],
            rerankModels: Array.isArray(s?.rerankModels) ? s.rerankModels : [],
            chatModels: Array.isArray(s?.chatModels) ? s.chatModels : [],
          });
          return {
            alive: asArray(r, 'alive').map(map),
            summary: typeof r.summary === 'string' ? r.summary : null,
          };
        }

        /** 渲染本地探测面板 */
        function localProbe(t, opts) {
          return h(LocalProbe, { t, ...opts });
        }

        function ModelTestRow(props) {
          const { t, kind, spec, onPickModel, onTestResult } = props;
          const [res, setRes] = useState(null);
          const [testing, setTesting] = useState(false);
          const [modelsState, setModelsState] = useState(null);
          const [fetchingModels, setFetchingModels] = useState(false);
          const alive = useRef(true);
          const testSeq = useRef(0);
          const modelsSeq = useRef(0);
          useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

          useEffect(() => { testSeq.current += 1; setRes(null); }, [spec.mode, spec.baseUrl, spec.model]);
          useEffect(() => { modelsSeq.current += 1; setModelsState(null); }, [spec.mode, spec.baseUrl]);

          const runTest = async () => {
            const seq = ++testSeq.current;
            setTesting(true);
            setRes(null);
            try {
              const r = await callRpc('probeLocal', {
                test: {
                  kind,
                  mode: spec.mode,
                  baseUrl: spec.baseUrl,
                  model: spec.model,
                  ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
                },
              }, 'write');
              if (!alive.current || testSeq.current !== seq) return;
              setRes(r);
              if (typeof onTestResult === 'function') onTestResult(r);
            } catch (e) {
              if (!alive.current || testSeq.current !== seq) return;
              setRes({ ok: false, error: msgOf(e) });
            } finally {
              if (alive.current && testSeq.current === seq) setTesting(false);
            }
          };

          const fetchRemoteModels = async () => {
            const seq = ++modelsSeq.current;
            setFetchingModels(true);
            setModelsState(null);
            try {
              const r = await callRpc('probeLocal', {
                listModels: {
                  kind,
                  mode: spec.mode,
                  baseUrl: spec.baseUrl,
                  ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
                },
              }, 'write');
              if (!alive.current || modelsSeq.current !== seq) return;
              setModelsState(r);
            } catch (e) {
              if (!alive.current || modelsSeq.current !== seq) return;
              setModelsState({ ok: false, models: [], error: msgOf(e) });
            } finally {
              if (alive.current && modelsSeq.current === seq) setFetchingModels(false);
            }
          };

          const fetchedList = modelsState && modelsState.ok && Array.isArray(modelsState.models)
            ? modelsState.models.slice(0, 24)
            : [];

          return h('div', { style: { ...ST.row, flexDirection: 'column', alignItems: 'stretch', gap: 8 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
              h('div', { style: ST.rowMain },
                res === null
                  ? h('div', { style: ST.rowHint }, spec.model || '—')
                  : res.ok
                    ? h('div', { style: { fontSize: FS.sm, color: SUCCESS, fontWeight: 500 } },
                      kind === 'embedding'
                        ? t('settings.testOkEmbed', { ms: res.latencyMs ?? 0, dim: res.nativeDim ?? '?' })
                        : kind === 'rerank'
                          ? t('settings.testOkRerank', { ms: res.latencyMs ?? 0, model: res.model || spec.model })
                          : t('settings.testOkLlm', { ms: res.latencyMs ?? 0, model: res.model || spec.model }))
                    : h('div', { style: { fontSize: FS.sm, color: ERROR } },
                      t('settings.testFail', { err: res.error ?? '' }))),
              h('div', { style: { ...ST.rowControl, gap: 6 } },
                spec.mode === 'remote' && typeof onPickModel === 'function'
                  ? h('button', {
                    type: 'button',
                    style: ST.smallBtn,
                    disabled: fetchingModels || testing,
                    onClick: () => { void fetchRemoteModels(); },
                  }, fetchingModels ? t('settings.fetchingModels') : t('settings.fetchModels'))
                  : null,
                h('button', {
                  type: 'button',
                  style: ST.smallBtn,
                  disabled: testing,
                  onClick: () => { void runTest(); },
                }, testing ? t('settings.testing') : t('settings.testConn')))),
            modelsState && !modelsState.ok
              ? h('div', { style: { fontSize: FS.xs, color: ERROR } }, modelsState.error ?? '')
              : null,
            fetchedList.length > 0
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                ...fetchedList.map((m) => {
                  const active = spec.model === m;
                  return h('button', {
                    key: `rm-${m}`,
                    type: 'button',
                    'aria-pressed': active,
                    style: active ? { ...ST.chip, ...ST.chipOn } : ST.chip,
                    onClick: () => onPickModel(m),
                  }, m);
                }))
              : null);
        }

        function modelTestRow(t, kind, spec, onPickModel, key, onTestResult) {
          return h(ModelTestRow, { key, t, kind, spec, onPickModel, onTestResult });
        }

        function DshLlmPicker(props) {
          const { t, provider, model, onSelect } = props;
          const [listState, setListState] = useState(null);
          const [loading, setLoading] = useState(false);
          const [testRes, setTestRes] = useState(null);
          const [testing, setTesting] = useState(false);

          const loadModels = useCallback(async () => {
            setLoading(true);
            try {
              const r = await callRpc('probeLocal', { listModels: { kind: 'llm' } }, 'write');
              setListState(r);
            } catch (e) {
              setListState({ ok: false, models: [], error: msgOf(e) });
            } finally {
              setLoading(false);
            }
          }, []);

          useEffect(() => { void loadModels(); }, [loadModels]);
          useEffect(() => { setTestRes(null); }, [provider, model]);

          const runTest = async () => {
            setTesting(true);
            setTestRes(null);
            try {
              const r = await callRpc('probeLocal', { test: { kind: 'llm', provider, model } }, 'write');
              setTestRes(r);
            } catch (e) {
              setTestRes({ ok: false, error: msgOf(e) });
            } finally {
              setTesting(false);
            }
          };

          const items = listState && listState.ok && Array.isArray(listState.models) ? listState.models : [];

          return h('div', { style: { ...ST.row, flexDirection: 'column', alignItems: 'stretch', gap: 10, paddingBottom: 16 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              h('div', { style: ST.rowMain },
                h('div', { style: ST.rowName }, t('settings.dshModels')),
                h('div', { style: ST.rowHint }, t('settings.llmModelHint'))),
              h('div', { style: { ...ST.rowControl, gap: 6 } },
                h('button', {
                  type: 'button',
                  style: ST.smallBtn,
                  disabled: loading,
                  onClick: () => { void loadModels(); },
                }, loading ? t('common.loading') : t('settings.dshModelsRefresh')),
                h('button', {
                  type: 'button',
                  style: ST.smallBtn,
                  disabled: testing || !model,
                  onClick: () => { void runTest(); },
                }, testing ? t('settings.testing') : t('settings.testConn')))),
            listState && !listState.ok
              ? h('div', { style: { fontSize: FS.xs, color: ERROR } }, listState.error ?? '')
              : null,
            listState && listState.ok && items.length === 0
              ? h('div', { style: { fontSize: FS.xs, color: WARN } }, t('settings.dshModelsEmpty'))
              : null,
            items.length > 0
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                ...items.map((m) => {
                  const active = m.model === model && (!provider || m.provider === provider);
                  return h('button', {
                    key: `${m.provider}:${m.model}`,
                    type: 'button',
                    'aria-pressed': active,
                    style: active ? { ...ST.chip, ...ST.chipOn } : ST.chip,
                    onClick: () => { void onSelect(m.provider, m.model); },
                  }, m.label || `${m.providerName || m.provider} · ${m.model}`);
                }))
              : null,
            testRes !== null
              ? h('div', { style: { fontSize: FS.sm, color: testRes.ok ? SUCCESS : ERROR, fontWeight: testRes.ok ? 500 : 400 } },
                testRes.ok
                  ? t('settings.testOkLlm', { ms: testRes.latencyMs ?? 0, model: testRes.model || model })
                  : t('settings.testFail', { err: testRes.error ?? '' }))
              : null);
        }
        /**
         * 一行「标签 + 说明 + 输入框」——**受控组件**。
         *
         * 作者 2026-11-18：不能「失焦就偷偷保存」，要有明确的保存按钮。
         * 所以这里只把输入值报给父组件（暂存），真正写盘由父组件的「保存」按钮做。
         *
         * 必须是组件（不能是普通函数）：父组件按配置项数量动态渲染它，
         * 普通函数 + 内部 hooks 会导致 hooks 数量随渲染变化 → React #310 白屏。实测踩过。
         */
        function SettingInput(props) {
          const { label, hint, value, edited, onChange, first } = props;
          return h('div', { style: first ? { ...ST.row, ...ST.rowFirst } : ST.row },
            h('div', { style: ST.rowMain },
              h('div', { style: ST.rowName }, label),
              hint ? h('div', { style: ST.rowHint }, hint) : null),
            h('div', { style: ST.rowControl },
              h('input', {
                type: 'text',
                value: value ?? '',
                style: edited ? { ...ST.input, ...ST.inputEdited } : ST.input,
                onChange: (e) => onChange(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') e.preventDefault(); },
              })));
        }

        /** 渲染一行输入框（组件化调用，别改成普通函数） */
        function settingInput(label, hint, value, edited, onChange, key, first) {
          return h(SettingInput, { key, label, hint, value, edited, onChange, first });
        }

        /**
         * 一行「标签 + 说明 + 分段选择」（本地 / 远程）。
         * 同样必须是组件：内部没有 hooks，但保持和 SettingInput 一致的调用风格。
         */
        function SettingChoice(props) {
          const { label, hint, value, options, onPick, first } = props;
          return h('div', { style: first ? { ...ST.row, ...ST.rowFirst } : ST.row },
            h('div', { style: ST.rowMain },
              h('div', { style: ST.rowName }, label),
              hint ? h('div', { style: ST.rowHint }, hint) : null),
            h('div', { style: { ...ST.rowControl, gap: 0, ...ST.segmented } },
              ...options.map((o) => h('button', {
                key: o.value,
                type: 'button',
                'aria-pressed': value === o.value,
                style: value === o.value ? { ...ST.seg, ...ST.segOn } : ST.seg,
                onClick: () => onPick(o.value),
              }, o.label))));
        }

        function settingChoice(label, hint, value, options, onPick, key, first) {
          return h(SettingChoice, { key, label, hint, value, options, onPick, first });
        }

        /**
         * 一行「标签 + 说明 + 密码框」。
         *
         * Key 直接填（作者 2026-11-18），但**不回显**：输入框初始为空，
         * 已保存的只显示掩码提示；输入新值才提交，留空表示不改。
         */
        function SettingSecret(props) {
          const { t, label, hint, note, masked, value, edited, onChange, onClear, first } = props;
          return h('div', { style: first ? { ...ST.row, ...ST.rowFirst } : ST.row },
            h('div', { style: ST.rowMain },
              h('div', { style: ST.rowName }, label),
              hint ? h('div', { style: ST.rowHint }, hint) : null,
              note ? h('div', { style: ST.rowHint }, note) : null),
            h('div', { style: ST.rowControl },
              h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('input', {
                    type: 'password',
                    value: value ?? '',
                    placeholder: masked || t('settings.apiKeyPlaceholder'),
                    autocomplete: 'off',
                    spellcheck: false,
                    style: edited ? { ...ST.input, ...ST.inputEdited } : ST.input,
                    onChange: (e) => onChange(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') e.preventDefault(); },
                  }),
                  onClear
                    ? h('button', { type: 'button', style: ST.smallBtn, onClick: onClear }, t('settings.apiKeyClear'))
                    : null),
                h('div', { style: { ...ST.foot, fontSize: FS.xs } },
                  masked ? t('settings.apiKeySaved', { masked }) : t('settings.apiKeyEmpty')))));
        }

        function settingSecret(t, label, hint, note, masked, value, edited, onChange, onClear, key, first) {
          return h(SettingSecret, { key, t, label, hint, note, masked, value, edited, onChange, onClear, first });
        }

        /** 归一化 panel.globalConfig 的响应 */
        function normalizeGlobal(raw) {
          const r = raw && typeof raw === 'object' ? raw : {};
          const cfg = r.config && typeof r.config === 'object' ? r.config : {};
          const d = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {};
          const e = cfg.embedding && typeof cfg.embedding === 'object' ? cfg.embedding : {};
          const l = cfg.llm && typeof cfg.llm === 'object' ? cfg.llm : {};
          const rr = cfg.rerank && typeof cfg.rerank === 'object' ? cfg.rerank : {};
          const s = cfg.search && typeof cfg.search === 'object' ? cfg.search : {};
          const idx = cfg.index && typeof cfg.index === 'object' ? cfg.index : {};
          const emb = r.embedding && typeof r.embedding === 'object' ? r.embedding : {};
          const llm = r.llm && typeof r.llm === 'object' ? r.llm : {};
          const rerank = r.rerank && typeof r.rerank === 'object' ? r.rerank : {};
          const vecExt = r.vecExt && typeof r.vecExt === 'object' ? r.vecExt : {};
          return {
            config: {
              defaults: { record: d.record === true, tools: d.tools === true },
              embedding: {
                mode: e.mode === 'local' ? 'local' : 'remote',
                model: e.model ?? '',
                dim: typeof e.dim === 'number' ? e.dim : 1024,
                baseUrl: e.baseUrl ?? '',
                apiKeyEnv: e.apiKeyEnv ?? '',
              },
              llm: {
                enabled: l.enabled === true,
                provider: l.provider ?? '',
                model: l.model ?? '',
                autoRefine: l.autoRefine === true,
                dailyLimit: typeof l.dailyLimit === 'number' ? l.dailyLimit : 50,
              },
              rerank: {
                enabled: rr.enabled === true,
                mode: rr.mode === 'local' ? 'local' : 'remote',
                model: rr.model ?? '',
                baseUrl: rr.baseUrl ?? 'https://api.siliconflow.cn/v1',
                apiKeyEnv: rr.apiKeyEnv ?? '',
                topN: typeof rr.topN === 'number' ? rr.topN : 50,
              },
              search: {
                defaultLimit: typeof s.defaultLimit === 'number' ? s.defaultLimit : 8,
              },
              index: {
                autoIndex: idx.autoIndex === true,
              },
            },
            embedding: {
              ready: emb.ready === true,
              reason: typeof emb.reason === 'string' ? emb.reason : null,
              mode: emb.mode === 'local' ? 'local' : 'remote',
              baseUrl: emb.baseUrl ?? null,
              model: emb.model ?? null,
              dim: emb.dim ?? null,
              // 只拿掩码，永远拿不到完整 key（服务端就不返回）
              hasApiKey: emb.hasApiKey === true,
              apiKeyMasked: typeof emb.apiKeyMasked === 'string' ? emb.apiKeyMasked : null,
              keySource: ['config', 'env', 'none'].includes(emb.keySource) ? emb.keySource : 'none',
              envName: typeof emb.envName === 'string' ? emb.envName : null,
            },
            llm: {
              ready: llm.ready === true,
              enabled: llm.enabled === true,
              hasHostLlm: llm.hasHostLlm === true,
              reason: typeof llm.reason === 'string' ? llm.reason : null,
              provider: llm.provider ?? null,
              model: llm.model ?? null,
            },
            rerank: {
              ready: rerank.ready === true,
              enabled: rerank.enabled === true,
              reason: typeof rerank.reason === 'string' ? rerank.reason : null,
              mode: rerank.mode === 'local' ? 'local' : 'remote',
              baseUrl: rerank.baseUrl ?? null,
              model: rerank.model ?? null,
              hasApiKey: rerank.hasApiKey === true,
              apiKeyMasked: typeof rerank.apiKeyMasked === 'string' ? rerank.apiKeyMasked : null,
              keySource: ['config', 'env', 'none'].includes(rerank.keySource) ? rerank.keySource : 'none',
              envName: typeof rerank.envName === 'string' ? rerank.envName : null,
            },
            vecExt: {
              loaded: vecExt.loaded === true,
              path: typeof vecExt.path === 'string' ? vecExt.path : null,
              platform: typeof vecExt.platform === 'string' ? vecExt.platform : '',
              arch: typeof vecExt.arch === 'string' ? vecExt.arch : '',
            },
            path: typeof r.path === 'string' ? r.path : '',
            exists: r.exists === true,
            warnings: asArray(r.warnings, 'warnings').filter((w) => typeof w === 'string'),
          };
        }

        const noopUseSessions = () => null;

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
              a.click();
              URL.revokeObjectURL(url);
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
              a.click();
              URL.revokeObjectURL(url);
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

