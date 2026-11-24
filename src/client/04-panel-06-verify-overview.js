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

