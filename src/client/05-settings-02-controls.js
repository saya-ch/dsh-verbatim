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

