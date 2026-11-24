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

