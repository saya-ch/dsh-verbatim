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
            if (nextId) await openScene(nextId, true, true);
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
            const res = await rpcRead('mediaPreview', { id: md.id, sessionId });
            if (!alive.current) return;
            setMediaPreviews((prev) => ({
              ...prev,
              [key]: res && res.ok ? { ok: true, src: res.dataUrl || res.url } : { ok: false, reason: res?.reason || '无法预览' },
            }));
          } catch (e) {
            if (!alive.current) return;
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

