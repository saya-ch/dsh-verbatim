      /* ---------- 标签页：TA的笔记 ---------- */

      function renderNotes() {
        const trashCount = deletedNotesTotal !== null
          ? deletedNotesTotal
          : (deletedNotes !== null
            ? deletedNotes.length
            : (stats && typeof stats.deletedNotesCount === 'number' ? stats.deletedNotesCount : null));
        const trashLabel = trashCount !== null
          ? `${t('notes.tabTrash')} (${fmtNum(trashCount)})`
          : t('notes.tabTrash');

        const switcher = h('div', { style: { ...S.rowBetween, alignItems: 'center', marginBottom: 8 } },
          h('div', { style: { ...S.segmented, marginBottom: 0 }, role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': notesView === 'active',
              style: notesView === 'active' ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => setNotesView('active'),
            }, t('notes.tabActive')),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': notesView === 'trash',
              style: notesView === 'trash' ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => {
                setNotesView('trash');
                if (deletedNotes === null && !trashLoading) void loadDeletedNotes();
              },
            }, trashLabel)),
          notesView === 'active'
            ? h('button', {
              type: 'button',
              style: noteForm ? S.btn : S.primaryBtn,
              onClick: () => setNoteForm(noteForm ? null : { content: '', about: 'him' }),
            }, noteForm ? t('common.cancel') : t('notes.add'))
            : null);

        const composer = notesView === 'active' && noteForm !== null
          ? h('div', { style: { ...S.card, marginTop: 0, marginBottom: 8 } },
            h('textarea', {
              style: { ...S.dbSqlArea, fontFamily: 'inherit', fontSize: FS.sm, minHeight: 62 },
              value: noteForm.content,
              placeholder: t('notes.addPlaceholder'),
              onChange: (e) => setNoteForm({ ...noteForm, content: e.target.value }),
            }),
            h('div', { style: { ...S.rowBetween, alignItems: 'center', marginTop: 6, gap: 6, flexWrap: 'wrap' } },
              h('div', { style: S.pillGroup },
                ...[
                  { v: 'him', label: t('notes.about.him') },
                  { v: 'me', label: t('notes.about.me') },
                  { v: 'us', label: t('notes.about.us') },
                  { v: '', label: t('notes.aboutAny') },
                ].map((opt) => h('button', {
                  key: opt.v || 'any',
                  type: 'button',
                  style: noteForm.about === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
                  onClick: () => setNoteForm({ ...noteForm, about: opt.v }),
                }, opt.label))),
              h('button', {
                type: 'button',
                style: S.primaryBtn,
                disabled: busy === 'note:add' || !String(noteForm.content ?? '').trim(),
                onClick: () => { void saveNewNote(); },
              }, busy === 'note:add' ? t('common.saving') : t('common.save'))))
          : null;

        if (notesView === 'trash') {
          let trashBody = null;
          if (trashErr !== null) {
            trashBody = h('div', { style: S.errorCard },
              h('div', null, trashErr),
              h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => { void loadDeletedNotes(); },
                }, t('common.retry'))));
          } else if (deletedNotes === null || trashLoading) {
            trashBody = h(SkeletonGroup, { kind: 'cards', count: 3 });
          } else if (deletedNotes.length === 0) {
            trashBody = h('div', { style: S.emptyCard }, t('notes.trashEmpty'));
          } else {
            const nowMs = Date.now();
            trashBody = h('div', null, ...deletedNotes.map((note, index) => {
              const aboutKey = note.about === 'me' || note.about === 'him' || note.about === 'us' ? note.about : null;
              const restoring = busy === `restore:${String(note.id)}`;
              const leftDays = note.expiresAt !== null
                ? Math.max(0, Math.ceil((note.expiresAt - nowMs) / DAY_MS))
                : null;
              const expireText = leftDays === null
                ? null
                : leftDays === 0
                  ? t('notes.expiresSoon')
                  : t('notes.expiresIn', { n: leftDays });

              return h('div', {
                key: String(note.id),
                className: 'dvp-slide dvp-card',
                style: { ...S.noteCard, animationDelay: `${Math.min(index, 10) * 20}ms` },
              },
                h('div', { style: S.rowBetween },
                  h('div', { style: S.trashMeta },
                    h('span', null, t('notes.deletedAt', { date: fmtShort(note.deletedAt) })),
                    expireText !== null ? h('span', { style: { color: WARN } }, `· ${expireText}`) : null),
                  h('button', {
                    type: 'button',
                    style: S.btn,
                    disabled: restoring,
                    onClick: () => { if (note.id !== undefined) void restoreNote(note.id); },
                  }, restoring ? t('notes.restoring') : t('notes.restore'))),
                h('div', { style: { marginTop: 4, fontSize: FS.base, lineHeight: 1.6, wordBreak: 'break-word' } }, renderMarkdown(note.content)),
                aboutKey === null ? null : h('div', { style: { ...S.dim, marginTop: 2 } }, t(`notes.about.${aboutKey}`)));
            }));
          }
          return h('div', null, switcher, trashBody);
        }

        // 读失败时上面的错误带已经说了，这里不能再显示「TA还没记过笔记」
        if (notes === null) return h('div', null, switcher, composer, tabErr !== null ? null : h(SkeletonGroup, { kind: 'cards', count: 3 }));
        if (notes.length === 0) {
          return h('div', null, switcher, composer, tabErr !== null ? null : h('div', { style: S.emptyCard }, t('empty.notes')));
        }

        const filterBar = h('div', { style: { marginBottom: 6 } },
          h('div', { style: { ...S.pillGroup, marginBottom: 5 } },
            ...[
              { v: 'all', label: t('notes.filterAll') },
              { v: 'him', label: t('notes.about.him') },
              { v: 'me', label: t('notes.about.me') },
              { v: 'us', label: t('notes.about.us') },
            ].map((opt) => h('button', {
              key: opt.v,
              type: 'button',
              style: noteAboutFilter === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
              onClick: () => setNoteAboutFilter(opt.v),
            }, opt.label))),
          h('input', {
            type: 'text',
            style: { ...S.input, width: '100%' },
            value: noteFilter,
            placeholder: t('notes.filterPlaceholder'),
            onChange: (e) => setNoteFilter(e.target.value),
          }));

        const qLower = noteFilter.trim().toLowerCase();
        const filteredNotes = notes.filter((n) => {
          if (noteAboutFilter !== 'all' && n.about !== noteAboutFilter) return false;
          if (qLower && !String(n.content ?? '').toLowerCase().includes(qLower)) return false;
          return true;
        });

        const scanDuplicates = async () => {
          setDupBusy(true);
          try {
            const res = await rpcRead('findDuplicateNotes', { sessionId });
            const groups = Array.isArray(res?.groups) ? res.groups : [];
            setDupGroups(groups);
            if (groups.length === 0) setFlash({ kind: 'ok', text: t('notes.dedupNone') });
          } catch (e) {
            setFlash({ kind: 'err', text: msgOf(e) });
          } finally {
            setDupBusy(false);
          }
        };

        const mergeDupGroup = async (group) => {
          setDupBusy(true);
          try {
            const dropIds = group.duplicates.map((d) => d.id);
            const res = await rpcWrite('mergeNotes', { sessionId, keepId: group.keep.id, dropIds });
            setFlash({ kind: 'ok', text: t('notes.dedupMergedOk', { n: fmtNum(res?.dropped ?? dropIds.length) }) });
            setDupGroups((prev) => (Array.isArray(prev) ? prev.filter((g) => g.keep.id !== group.keep.id) : null));
            await Promise.all([loadNotes(true), loadStatus()]);
          } catch (e) {
            setFlash({ kind: 'err', text: msgOf(e) });
          } finally {
            setDupBusy(false);
          }
        };

        return h('div', null,
          switcher,
          composer,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 6 } },
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: dupBusy,
              onClick: () => { void scanDuplicates(); },
            }, t('notes.dedupBtn'))),
          Array.isArray(dupGroups) && dupGroups.length > 0
            ? h('div', { style: { marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              ...dupGroups.map((g) => h('div', {
                key: `dup-${g.keep.id}`,
                style: { ...S.card, borderColor: WARN, padding: '8px 10px' },
              },
                h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: FS.xs, fontWeight: 600, color: LABEL1 } }, `#${g.keep.id} (${fmtShort(g.keep.at)})`),
                  h('button', {
                    type: 'button',
                    style: S.primaryBtn,
                    disabled: dupBusy,
                    onClick: () => { void mergeDupGroup(g); },
                  }, t('notes.dedupMerge', { n: g.duplicates.length }))),
                h('div', { style: { fontSize: FS.xs, color: LABEL1, marginTop: 4 } }, g.keep.content),
                ...g.duplicates.map((d) => h('div', {
                  key: `d-${d.id}`,
                  style: { fontSize: FS.xs, color: LABEL3, marginTop: 3, paddingLeft: 8, borderLeft: `2px solid ${BORDER}` },
                }, `≈${Math.round((d.similarity ?? 0) * 100)}% · #${d.id}: ${d.content}`)))))
            : null,
          filterBar,
          filteredNotes.length === 0
            ? h('div', { style: S.emptyCard }, t('notes.filterEmpty'))
            : null,
          ...filteredNotes.map((note, index) => {
          const aboutKey = note.about === 'me' || note.about === 'him' || note.about === 'us' ? note.about : null;
          const deleting = busy === `note:${String(note.id)}`;
          const accentColor = aboutKey === 'him' ? BRAND : aboutKey === 'me' ? '#d94862' : aboutKey === 'us' ? '#8b5cf6' : BORDER_STRONG;
          return h('div', {
            key: String(note.id),
            className: 'dvp-slide dvp-card',
            style: {
              ...S.noteCard,
              borderLeft: `3px solid ${accentColor}`,
              animationDelay: `${Math.min(index, 10) * 20}ms`,
            },
          },
            h('div', { style: S.rowBetween },
              h('span', { style: S.dim }, fmtShort(note.at)),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: S.linkBtn,
                  disabled: deleting,
                  onClick: () => setEditingNote({ id: note.id, text: note.content }),
                }, t('notes.edit')),
                h('button', {
                  type: 'button',
                  style: S.linkBtn,
                  disabled: deleting,
                  onClick: () => { if (note.id !== undefined) void deleteNote(note.id); },
                }, deleting ? t('notes.deleting') : t('common.delete')))),
            editingNote && editingNote.id === note.id
              ? h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
                h('textarea', {
                  value: editingNote.text,
                  rows: 3,
                  onChange: (e) => setEditingNote({ id: note.id, text: e.target.value }),
                  style: { ...S.input, width: '100%', boxSizing: 'border-box', fontSize: FS.sm, resize: 'vertical' },
                }),
                h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                  h('button', { type: 'button', style: S.btn, onClick: () => setEditingNote(null) }, t('common.cancel')),
                  h('button', {
                    type: 'button',
                    style: S.primaryBtn,
                    disabled: !editingNote.text.trim(),
                    onClick: async () => {
                      const nextText = editingNote.text.trim();
                      try {
                        await rpcWrite('updateNote', { sessionId, id: note.id, content: nextText });
                        if (!alive.current) return;
                        setEditingNote(null);
                        setFlash({ kind: 'ok', text: t('notes.updatedOk') });
                        await loadNotes();
                      } catch (e) {
                        if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
                      }
                    },
                  }, t('common.save'))))
              : h('div', { style: { marginTop: 3, fontSize: FS.base, lineHeight: 1.6, wordBreak: 'break-word' } }, renderMarkdown(note.content)),
            aboutKey === null ? null : h('div', { style: { ...S.dim, marginTop: 2 } }, t(`notes.about.${aboutKey}`)));
        }));
      }


