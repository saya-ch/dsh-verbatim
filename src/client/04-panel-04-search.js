      /* ---------- 标签页：搜索 ---------- */

      function renderSearch() {
        const monthVal = currentMonthYMD();
        const whenOptions = [
          { value: '', label: t('search.whenAll') },
          { value: '7d', label: t('search.when7d') },
          { value: '30d', label: t('search.when30d') },
          { value: monthVal, label: t('search.whenMonth') },
        ];

        const sourceBadge = (hit) => {
          const srcs = Array.isArray(hit.sources) ? hit.sources : [];
          const hasKw = srcs.includes('keyword');
          const hasVec = srcs.includes('vector');
          const scoreText = typeof hit.score === 'number' ? ` ${hit.score.toFixed(2)}` : '';
          if (hasKw && hasVec) {
            return h('span', { style: S.sourceBadgeBoth }, `${t('search.sourceBoth')}${scoreText}`);
          }
          if (hasVec) {
            return h('span', { style: S.sourceBadgeVec }, `${t('search.sourceVector')}${scoreText}`);
          }
          return h('span', { style: S.sourceBadgeKw }, t('search.sourceKeyword'));
        };

        const activeQuery = (searchResult && searchResult.query) || searchQuery;

        let content = null;
        if (searchBusy) {
          content = h(SkeletonGroup, { kind: 'cards', count: 3 });
        } else if (searchResult === null) {
          content = tabErr !== null ? null : h('div', { style: S.emptyCard }, t('search.prompt'));
        } else {
          const semNote = searchResult.semantic && searchResult.semantic.note
            ? h('div', { style: { ...S.hint, marginBottom: 6 } }, searchResult.semantic.note)
            : null;
          const matchedNotes = Array.isArray(searchResult.matchedNotes) ? searchResult.matchedNotes : [];
          const matchedScenes = Array.isArray(searchResult.matchedScenes) ? searchResult.matchedScenes : [];
          const visibleHits = searchSpeaker === 'all'
            ? searchResult.hits
            : searchResult.hits.filter((hit) => hit.speaker === searchSpeaker);
          const summary = h('div', { style: S.searchSummary },
            h('span', null, t('search.total', { n: fmtNum(searchSpeaker === 'all' ? searchResult.total : visibleHits.length) })),
            searchSpeaker === 'all' && searchResult.hits.length < searchResult.total
              ? h('span', null, t('search.shown', { n: fmtNum(searchResult.hits.length) }))
              : null,
            searchResult.semantic && searchResult.semantic.reranked
              ? h('span', { style: S.sourceBadgeBoth }, t('search.rerankedBadge'))
              : null);

          const notesBlock = matchedNotes.length > 0
            ? h('div', { style: { marginBottom: 10 } },
              h('div', { style: { ...S.sectionTitle, marginBottom: 6 } },
                t('search.matchedNotes', { n: fmtNum(matchedNotes.length) })),
              ...matchedNotes.map((n) => {
                const hasKw = n.sources.includes('keyword');
                const hasVec = n.sources.includes('vector');
                const scoreText = typeof n.score === 'number' ? ` ${n.score.toFixed(2)}` : '';
                const badgeStyle = hasKw && hasVec ? S.sourceBadgeBoth : hasVec ? S.sourceBadgeVec : S.sourceBadgeKw;
                const badgeText = hasKw && hasVec
                  ? `${t('search.noteBoth')}${scoreText}`
                  : hasVec
                    ? `${t('search.noteVec')}${scoreText}`
                    : t('search.noteKw');
                const aboutLabel = n.about ? t(`notes.about.${n.about}`) : null;
                return h('div', {
                  key: `note-${n.id}`,
                  className: 'dvp-card',
                  'data-clickable': '1',
                  style: {
                    ...S.card,
                    marginTop: 5,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    borderLeft: `3px solid ${BRAND}`,
                  },
                  onClick: () => {
                    setTab('notes');
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.xs, color: LABEL2, fontWeight: 500 } },
                      `${aboutLabel ? `${aboutLabel} · ` : ''}${fmtShort(n.at)}`),
                    h('span', { style: badgeStyle }, badgeText)),
                  h('div', { style: { fontSize: FS.sm, color: LABEL1, marginTop: 4, lineHeight: 1.45 } },
                    renderMarkdown(n.content, { highlightQuery: activeQuery, markStyle: S.searchMark })));
              }))
            : null;

          const scenesBlock = matchedScenes.length > 0
            ? h('div', { style: { marginBottom: 10 } },
              h('div', { style: { ...S.sectionTitle, marginBottom: 6 } },
                t('search.matchedScenes', { n: fmtNum(matchedScenes.length) })),
              ...matchedScenes.map((sc) => {
                const hasKw = sc.sources.includes('keyword');
                const hasVec = sc.sources.includes('vector');
                const scoreText = typeof sc.score === 'number' ? ` ${sc.score.toFixed(2)}` : '';
                const badgeStyle = hasKw && hasVec ? S.sourceBadgeBoth : hasVec ? S.sourceBadgeVec : S.sourceBadgeKw;
                const badgeText = hasKw && hasVec
                  ? `${t('search.sceneBoth')}${scoreText}`
                  : hasVec
                    ? `${t('search.sceneVec')}${scoreText}`
                    : t('search.sceneKw');
                return h('div', {
                  key: `sc-${sc.id}`,
                  className: 'dvp-card',
                  'data-clickable': '1',
                  style: { ...S.card, marginTop: 5, padding: '8px 10px', cursor: 'pointer' },
                  onClick: () => {
                    void jumpToTimeline({ sceneId: sc.id, at: sc.startAt });
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.xs, color: LABEL2, fontWeight: 500 } },
                      `${fmtSceneRange(sc.startAt, sc.endAt)} · ${t('timeline.sceneMsgs', { n: fmtNum(sc.msgCount) })}`),
                    h('span', { style: badgeStyle }, badgeText)),
                  h('div', { style: { fontSize: FS.sm, color: LABEL1, marginTop: 4, lineHeight: 1.45 } },
                    renderHighlightedText(sc.gist, activeQuery, S.searchMark)));
              }))
            : null;

          if (visibleHits.length === 0 && matchedScenes.length === 0 && matchedNotes.length === 0) {
            content = h('div', null,
              semNote,
              h('div', { style: S.emptyCard }, t('search.empty', { query: activeQuery.trim() })));
          } else {
            content = h('div', null,
              notesBlock,
              scenesBlock,
              visibleHits.length > 0 ? summary : null,
              semNote,
              ...visibleHits.map((hit, index) => {
                const tag = speakerTag(hit.speaker);
                const hitKey = String(hit.id ?? index);
                const copyId = `hit:${hitKey}`;
                const isCopied = copiedKey === copyId;
                const isChunk = hit.chunk !== null;
                const isExpanded = expandedHits[hitKey] === true;
                const isWindow = Boolean(hit.window && hit.window.text && !isChunk);
                const winKind = hit.window?.kind === 'thread'
                  ? 'thread'
                  : (hit.window?.kind === 'exchange' ? 'exchange' : 'window');
                const winBadgeKey = winKind === 'thread'
                  ? 'search.threadBadge'
                  : (winKind === 'exchange' ? 'search.exchangeBadge' : 'search.windowBadge');
                const winExpandKey = winKind === 'thread'
                  ? 'search.expandThread'
                  : (winKind === 'exchange' ? 'search.expandExchange' : 'search.expandWindow');
                const defaultShowWindow = isWindow && (winKind === 'thread' || hit.text.length < 80);
                const hasCustomToggle = Object.prototype.hasOwnProperty.call(expandedHits, hitKey);
                const showWindowText = isWindow && (hasCustomToggle ? Boolean(expandedHits[hitKey]) : defaultShowWindow);
                const chunkText = isChunk
                  ? (hit.chunk.text !== null
                    ? hit.chunk.text
                    : (hit.chunk.startChar !== null && hit.chunk.endChar !== null
                      ? hit.text.slice(hit.chunk.startChar, hit.chunk.endChar)
                      : hit.text))
                  : hit.text;
                const shownText = isChunk && !isExpanded
                  ? chunkText
                  : (showWindowText ? hit.window.text : hit.text);
                const canJump = hit.sceneId !== null || typeof hit.at === 'number';
                const sceneRange = hit.sceneStartAt !== null
                  ? fmtSceneRange(hit.sceneStartAt, hit.sceneEndAt)
                  : null;

                return h('div', {
                  key: hitKey,
                  className: 'dvp-slide dvp-card',
                  style: {
                    ...S.searchCard,
                    borderLeftColor: tag.color,
                    animationDelay: `${Math.min(index, 12) * 20}ms`,
                  },
                },
                  h('div', { style: S.searchMetaRow },
                    h('div', { style: S.searchMetaLeft },
                      h('span', { style: { ...S.msgSpeaker, color: tag.color } }, tag.text),
                      h('span', { style: S.msgTime }, fmtShort(hit.at)),
                      sourceBadge(hit),
                      isWindow
                        ? h('span', { style: S.sourceBadgeBoth },
                          t(winBadgeKey, { n: fmtNum(hit.window.msgCount || 2) }))
                        : null,
                      hit.inSurface === 0 ? h('span', { style: S.tag }, t('timeline.compacted')) : null,
                      hit.excluded ? h('span', { style: S.tag }, t('search.excludedTag')) : null),
                    h('button', {
                      type: 'button',
                      style: isCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                      onClick: () => { void handleCopy(copyId, shownText); },
                    }, isCopied ? t('common.copied') : t('common.copy'))),
                  h('div', { style: { ...S.msgText, marginTop: 4 } },
                    renderMarkdown(shownText, { highlightQuery: activeQuery, markStyle: S.searchMark })),
                  isChunk
                    ? h('div', { style: S.chunkBar },
                      h('span', null, hit.chunk.total
                        ? t('search.chunkPart', { k: hit.chunk.idx + 1, total: hit.chunk.total })
                        : t('search.chunkPartSingle', { k: hit.chunk.idx + 1 })),
                      h('span', null, t('search.fullLength', { n: fmtNum(hit.text.length) })),
                      h('button', {
                        type: 'button',
                        style: S.linkBtn,
                        onClick: () => setExpandedHits((prev) => ({ ...prev, [hitKey]: !isExpanded })),
                      }, isExpanded ? t('search.collapseFull') : t('search.expandFull')))
                    : (isWindow
                      ? h('div', { style: S.chunkBar },
                        h('span', null, t(winBadgeKey, { n: fmtNum(hit.window.msgCount || 2) })),
                        h('button', {
                          type: 'button',
                          style: S.linkBtn,
                          onClick: () => setExpandedHits((prev) => ({ ...prev, [hitKey]: !showWindowText })),
                        }, showWindowText
                          ? t('search.collapseWindow')
                          : t(winExpandKey, { n: fmtNum(hit.window.msgCount || 2) })))
                      : null),
                  Array.isArray(hit.relatedTimeline) && hit.relatedTimeline.length > 0
                    ? h('div', { style: { ...S.hint, marginTop: 4, fontSize: FS.xs, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 } },
                      h('span', null, t('search.relatedTimeline', { dates: '' }).replace(/[:：]\s*$/, '') + '：'),
                      ...hit.relatedTimeline
                        .filter((rt) => rt && (rt.at !== null || rt.sceneId !== null))
                        .slice(0, 5)
                        .map((rt, rIdx) => h('button', {
                          key: `rt-${rIdx}-${rt.sceneId ?? rt.at}`,
                          type: 'button',
                          style: { ...S.linkBtn, fontSize: FS.xs, padding: '0 4px' },
                          onClick: () => { void jumpToTimeline({ sceneId: rt.sceneId ?? null, at: rt.at ?? null }); },
                        }, fmtShort(rt.at))))
                    : null,
                  h('div', { style: S.searchFooter },
                    sceneRange
                      ? h('span', { style: S.dim },
                        hit.sceneMsgCount !== null
                          ? `${sceneRange} · ${t('timeline.sceneMsgs', { n: fmtNum(hit.sceneMsgCount) })}`
                          : sceneRange)
                      : h('span', null),
                    canJump
                      ? h('button', {
                        type: 'button',
                        style: S.linkBtn,
                        onClick: () => { void jumpToTimeline(hit); },
                      }, t('search.jumpTimeline'))
                      : null));
              }));
          }
        }

        return h('div', null,
          h('form', {
            style: S.searchBar,
            onSubmit: (e) => {
              e.preventDefault();
              void runSearch();
            },
          },
            h('div', { className: 'dvp-search-wrap', style: S.searchInputWrap },
              h('span', { style: S.searchIcon }, h(SearchIcon, { size: 14 })),
              h('input', {
                ref: searchInputRef,
                type: 'text',
                value: searchQuery,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.placeholder'),
                style: S.searchInput,
                onChange: (e) => setSearchQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape' && searchQuery !== '') {
                    setSearchQuery('');
                    setSearchResult(null);
                    setTabErr('search', null);
                  }
                },
              }),
              searchQuery !== ''
                ? h('button', {
                  type: 'button',
                  style: S.clearBtn,
                  'aria-label': t('search.clear'),
                  title: t('search.clear'),
                  onClick: () => {
                    setSearchQuery('');
                    setSearchResult(null);
                    setTabErr('search', null);
                    if (searchInputRef.current) searchInputRef.current.focus();
                  },
                }, '×')
                : null),
            h('button', {
              type: 'submit',
              style: S.primaryBtn,
              disabled: searchBusy || searchQuery.trim() === '',
            }, t('search.submit'))),
          h('div', { style: S.pillRow },
            h('div', { style: S.pillGroup },
              ...whenOptions.map((opt) => h('button', {
                key: opt.value || 'all',
                type: 'button',
                'aria-pressed': searchWhen === opt.value,
                style: searchWhen === opt.value ? { ...S.pill, ...S.pillActive } : S.pill,
                onClick: () => {
                  setSearchWhen(opt.value);
                  if (searchQuery.trim()) void runSearch({ when: opt.value });
                },
              }, opt.label))),
            h('label', { style: S.checkLabel },
              h('input', {
                type: 'checkbox',
                checked: searchIncludeExcluded,
                onChange: (e) => {
                  const next = e.target.checked;
                  setSearchIncludeExcluded(next);
                  if (searchQuery.trim()) void runSearch({ includeExcluded: next });
                },
              }),
              h('span', null, t('search.includeExcluded')))),
          h('div', { style: { ...S.pillGroup, marginTop: 4, marginBottom: 6 } },
            ...['all', 'user', 'assistant'].map((sp) => h('button', {
              key: sp,
              type: 'button',
              'aria-pressed': searchSpeaker === sp,
              style: searchSpeaker === sp ? { ...S.pill, ...S.pillActive } : S.pill,
              onClick: () => setSearchSpeaker(sp),
            }, t(sp === 'all' ? 'search.speakerAll' : sp === 'user' ? 'search.speakerUser' : 'search.speakerAssistant')))),
          searchHistory.length > 0 && searchResult === null && !searchBusy
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
              h('span', { style: { fontSize: FS.xs, color: LABEL3 } }, t('search.history')),
              ...searchHistory.map((hq) => h('button', {
                key: hq,
                type: 'button',
                style: S.dbChip,
                onClick: () => {
                  setSearchQuery(hq);
                  void runSearch({ query: hq });
                },
              }, hq)),
              h('button', {
                type: 'button',
                style: { ...S.linkBtn, fontSize: FS.xs, marginLeft: 2 },
                onClick: () => {
                  setSearchHistory([]);
                  try { if (typeof localStorage !== 'undefined') localStorage.removeItem('dsh-verbatim:search-history'); } catch { /* ignore */ }
                },
              }, t('search.clearHistory')))
            : null,
          content,
          h('div', { style: { marginTop: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 8 } },
            h('div', { style: { ...S.rowBetween, alignItems: 'center' } },
              h('button', {
                type: 'button',
                style: S.linkBtn,
                onClick: () => {
                  const next = !recallOpen;
                  setRecallOpen(next);
                  if (next) {
                    setRecallBusy(true);
                    void rpcRead('recallLog', { sessionId, limit: 15 })
                      .then((res) => { if (alive.current) setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { if (alive.current) setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { if (alive.current) setRecallBusy(false); });
                  }
                },
              }, `${recallOpen ? '▾' : '▸'} ${t('search.recallToggle')}`),
              recallOpen
                ? h('button', {
                  type: 'button',
                  style: S.copyBtn,
                  disabled: recallBusy,
                  onClick: () => {
                    setRecallBusy(true);
                    void rpcRead('recallLog', { sessionId, limit: 15 })
                      .then((res) => { if (alive.current) setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { if (alive.current) setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { if (alive.current) setRecallBusy(false); });
                  },
                }, t('common.refresh'))
                : null),
            recallOpen
              ? (recallBusy && recallItems === null
                ? h('div', { style: { ...S.hint, marginTop: 6 } }, t('common.loading'))
                : !recallItems || recallItems.length === 0
                  ? h('div', { style: { ...S.hint, marginTop: 6 } }, t('search.recallEmpty'))
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
                    ...recallItems.map((rc) => h('div', {
                      key: rc.id,
                      style: { ...S.card, padding: '7px 9px', marginTop: 0 },
                    },
                      h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                        h('span', { style: { fontWeight: 600, fontSize: FS.xs, color: LABEL1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          rc.query ? `「${rc.query}」` : (rc.when || '(recent)')),
                        h('span', { style: { fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' } },
                          `${fmtClock(rc.at)} · ${rc.elapsedMs}ms · ${fmtNum(rc.resultChars)}字`)),
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 } },
                        h('span', { style: S.tag }, `kw ${rc.counts?.keyword ?? 0}`),
                        h('span', { style: S.tag }, `vec ${rc.counts?.vector ?? 0}`),
                        rc.reranked ? h('span', { style: S.sourceBadgeBoth }, t('search.rerankedBadge')) : null,
                        ...(Array.isArray(rc.hitScenes) ? rc.hitScenes : []).map((hs) => h('button', {
                          key: String(hs.sceneId),
                          type: 'button',
                          style: S.dbChip,
                          onClick: () => { void jumpToTimeline({ sceneId: hs.sceneId, at: hs.startAt }); },
                        }, `${fmtShort(hs.startAt)} (${hs.count})`)))))))
              : null));
      }

