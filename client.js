/**
 * dsh-verbatim 面板 —— 右侧边栏的一个标签页。
 *
 * 设计目标（见 PANEL.md）：**核实窗口，不是管理后台**。
 * 它存在的意义是让人随时能亲眼确认「TA记得的，和你说过的，是同一句话」。
 *
 * 四条不做（PANEL §1 / ACCEPTANCE D1~D4）：
 *   - 不放情绪/关系指标（D-090：没有亲密度、没有冷热）
 *   - 不放线索列表（thread 第一版没做，D-093）
 *   - 不放「污染候选」（E1~E6 已取消，D-079）
 *   - 不展示TA的 reasoning（D-005）
 *
 * 两条硬约束：
 *   1. **一个对话一个面板**（A2/B1）：所有请求都带当前 sessionId，
 *      绝不像旧版那样读全库。会话 id 变了就整个组件重挂（见 PanelSeat），
 *      从结构上杜绝串数据。
 *   2. **只有两个开关**（D-166 / B2）：记录、给TA工具。
 *      `autoRecall` 只是协议里保留的字段，面板**不渲染**。
 *
 * 数据全部来自 Host 侧 `/verbatim-api/panel.<method>`（见 PANEL §5，共 20 个方法）。
 * 同源 fetch，不需要额外鉴权配置。
 */

window.__ModuleLoader__.load({
  id: 'dsh-verbatim',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'dsh-verbatim';
    const API = '/verbatim-api';
    const TAB_ID = 'verbatim';
    const TAB_KIND = 'verbatim-memory';

    /** `panel.timeline` 的 limit 上限（index.js 的 intParam max: 100） */
    const TIMELINE_MAX = 100;
    /** 时间轴默认展开最近多少天（直接拉取全部可用天数，上限 TIMELINE_MAX） */
    const TIMELINE_DAYS = TIMELINE_MAX;
    /** 每次检索最多拉取多少条命中 */
    const SEARCH_LIMIT = 30;
    /** 每页笔记条数 */
    const NOTES_LIMIT = 50;
    /** 已标记列表一次拉多少条 */
    const FLAGS_LIMIT = 50;
    /** 软删笔记默认保留天数（兜底计算用） */
    const NOTE_RETENTION_DAYS = 30;
    const DAY_MS = 86400000;
    /** 重建索引轮询间隔与无进展超时（毫秒） */
    const REBUILD_POLL_MS = 800;
    const REBUILD_TIMEOUT_MS = 120000;

    /* ══════════════════════════ 文案 ══════════════════════════ */

    const en = {
      title: 'Verbatim memory',
      description: 'Every word you have shared, kept safe.',

      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.loadMore': 'Load more',
      'common.save': 'Save',
      'common.saved': 'Saved',
      'common.saving': 'Saving…',
      'common.delete': 'Delete',
      'common.copy': 'Copy',
      'common.copied': '✓ Copied',
      'common.backTop': 'Back to top',
      'common.failed': 'Cannot read the memory library.',
      'common.noSession': 'No session id reached this panel, so it cannot tell which conversation it belongs to.',
      'common.unitMsgs': 'msgs',
      'common.unitScenes': 'scenes',

      'switch.record': 'Remember new chats',
      'switch.tools': 'Let TA recall',
      'switch.on': 'on',
      'switch.off': 'off',
      'switch.recordOff': 'Paused. The {n} messages already saved stay safe; turn it back on any time.',
      'switch.toolsOff': 'TA will not search past memories in this chat. Saved memories stay untouched.',
      'switch.writeOk': 'Saved: {name} {state}',
      'switch.writeFail': 'Could not save: {err}',
      'switch.writeUnconfirmed': 'Sent the change to {name}, but the server did not confirm the resulting state. Refresh to check.',

      'stats.coreBefore': '',
      'stats.coreAfter': 'in long-term memory',
      'stats.coreHint': 'Moved out of the active window, yet every word is still kept for TA to recall.',
      'stats.rewinded': 'Forgotten by rewind: {n}',
      'stats.rewindedHint': '(erased completely, no trace kept)',
      'stats.from': 'since {date}',

      'index.heading': 'Recall readiness',
      'index.advancedShow': 'Diagnostics & maintenance',
      'index.advancedHide': 'Hide diagnostics',
      'index.modelStored': 'Stored model',
      'index.modelConfigured': 'Current model',
      'index.modelNever': 'not built yet',
      'index.consistency': 'Consistency',
      'index.consistencyOk': '✓ match',
      'index.consistencyMismatch': '✗ mismatch — rebuild needed',
      'index.consistencyMixed': '✗ {n} model sets — rebuild required',
      'index.consistencyUnknown': '— unknown',
      'index.unitDim': 'dim',
      'index.state': 'Status',
      'index.modelUnset': 'not configured',
      'index.dim': '{n} dim',
      'index.count': 'Recallable msgs',
      'index.windowsCount': 'Memory fragments',
      'index.windowsKinds': ' ({thread} threads · {exchange} exchanges)',
      'index.statePending': 'Pending sync',
      'index.rebuildFailedBadge': 'Sync failed',
      'index.pendingCount': '{n} msgs pending',
      'index.syncIndex': 'Sync & Index',
      'index.noTaskId': 'Missing taskId in rebuild response',
      'index.syncRunning': 'Syncing & indexing…',
      'index.syncDone': 'Sync & index finished',
      'index.syncUpToDate': 'Already up to date (nothing pending)',
      'index.resplit': 'Re-split scenes',
      'index.refineGist': 'Re-refine all gists',
      'index.refineGistMissing': 'Refine missing gists',
      'index.llmGistCoverage': 'LLM gists: {done} / {total} scenes ({pct}%)',
      'timeline.pendingMsgs': 'In progress · {n} msgs (auto-seals after 30m quiet)',
      'timeline.mergePrev': 'Merge prev',
      'timeline.splitHere': 'Split here',
      'timeline.refineOne': 'Refine gist',
      'timeline.editGist': 'Edit gist',
      'timeline.gistSavedOk': 'Scene gist saved (locked as manual).',
      'timeline.muteMsg': 'Exclude',
      'timeline.unmuteMsg': 'Restore',
      'timeline.mutedTag': 'Excluded',
      'notes.edit': 'Edit',
      'notes.updatedOk': 'Note updated.',
      'db.exportMdBtn': 'Export MD',
      'timeline.mergedOk': 'Merged with previous scene.',
      'timeline.splitOk': 'Split into two scenes.',
      'timeline.refinedOneOk': 'Scene gist refined.',
      'timeline.previewImg': 'Preview',
      'search.rerankedBadge': 'Reranked',
      'search.recallTitle': 'Recent AI Recall Trace ({n})',
      'search.recallToggle': 'AI Recall Trace',
      'search.recallEmpty': 'No AI memory_search calls recorded in this session yet.',
      'notes.dedupBtn': 'Find duplicates',
      'notes.dedupNone': 'No duplicate notes found.',
      'notes.dedupMerge': 'Merge & archive ({n})',
      'notes.dedupMergedOk': 'Archived {n} duplicate notes to trash.',
      'settings.llmAutoRefine': 'Auto-refine gists in background',
      'settings.llmAutoRefineHint': 'Automatically run LLM summary on settled unrefined scenes during idle sync.',
      'settings.llmDailyLimit': 'Daily auto-refine cap',
      'settings.llmDailyLimitHint': 'Max scenes auto-refined per day to guard token budget.',
      'db.importSessionBtn': 'Import JSON',
      'db.importSessionOk': 'Imported {sid}: {msgs} msgs, {notes} notes.',
      'index.llmCostHint': 'Vector indexing & scene splitting never call an LLM (embedding / local only).',
      'index.llmReadyHint': 'Scene gists participate in search. LLM ({model}) is ready for optional refinement.',
      'index.rebuild': 'Rebuild vectors',
      'index.rebuildConfirm': 'Note: rebuilding vectors affects the **whole library**, not just this conversation — every conversation gets re-embedded (embedding only, **no LLM calls**). Stored text is never touched. Continue?',
      'index.rebuildYes': 'Rebuild now',
      'index.rebuildRunning': 'Rebuilding…',
      'index.rebuildDone': 'Rebuild finished',
      'index.rebuildFail': 'Rebuild failed: {err}',
      'index.rebuildSlow': 'Still running. Check progress later with Refresh.',
      'index.rebuildUnsure': 'The index has stayed at {indexed} / {total} the whole time, so I cannot confirm the rebuild actually ran. Refresh to check.',
      'index.resultSynced': '({n} new messages ingested)',
      'index.resultIndexed': '({n} newly indexed)',
      'index.resultVectors': '({n} vectors)',
      'index.resultChunks': '({n} chunks)',
      'index.resultScenes': '({n} scenes)',
      'index.progressChunks': ' · {n} chunks',
      'index.stateOk': 'normal',
      'index.stateDegraded': 'degraded to brute-force cosine (works the same, just slower)',
      'index.stateEmpty': 'not indexed yet (semantic search is skipped until you rebuild)',
      'index.statePartial': 'partially indexed (semantic search is skipped until coverage is enough)',
      'index.stateDisabled': 'disabled (no embedding key: semantic search is off, timeline and keywords still work)',
      'index.stateMismatch': 'unusable — the index was built with a different model',
      'index.stateMixed': 'unusable — the library holds vectors from two different models',
      'index.stateUnknown': 'unknown (the API returned no vector.state)',
      'index.semanticOff': 'Semantic search is disabled.',

      'tab.overview': 'Overview',
      'tab.search': 'Search',
      'tab.timeline': 'Timeline',
      'tab.notes': 'Notes',
      'tab.verify': 'Check',
      'tab.db': 'DB',
      'db.subSessions': 'Sessions',
      'db.subBrowse': 'Browse',
      'db.subSql': 'SQL',
      'db.summary': 'LIBRARY OVERVIEW',
      'db.sessionsHeading': 'SESSIONS IN LIBRARY ({n})',
      'db.size': 'File size',
      'db.schema': 'Schema',
      'db.vecEngine': 'Vector engine',
      'db.vecNative': 'sqlite-vec',
      'db.vecFallback': 'Brute-force fallback',
      'db.totals': '{sessions} sessions · {msgs} msgs · {scenes} scenes · {notes} notes',
      'db.vecCoverage': 'Vectors: {indexed} / {total}',
      'db.backup': 'Backup',
      'db.vacuum': 'Compact',
      'db.purgeTrash': 'Purge trash ({n})',
      'db.backupOk': 'Backup saved: {path} ({size})',
      'db.vacuumOk': 'Compacted: {before} → {after}',
      'db.purgeOk': 'Purged {n} expired deleted notes.',
      'db.exportOk': 'Exported {msgs} msgs and {notes} notes.',
      'db.actionFail': 'Operation failed: {err}',
      'db.currentBadge': 'Current',
      'db.browseBtn': 'Browse',
      'db.syncIndexBtn': 'Sync & Index',
      'db.exportBtn': 'Export',
      'db.allSessions': 'All sessions ({n})',
      'db.filterPlaceholder': 'Filter text…',
      'db.filterBtn': 'Filter',
      'db.emptyRows': 'No rows match the current view.',
      'db.pageInfo': 'Page {page} / {pages} · {total} rows',
      'db.prevPage': 'Prev',
      'db.nextPage': 'Next',
      'db.jumpPage': 'Go',
      'db.table.msg': 'msg',
      'db.table.scene': 'scene',
      'db.table.window': 'window',
      'db.table.note': 'note',
      'db.table.flag': 'flag',
      'db.table.chunk': 'chunk',
      'db.table.media': 'media',
      'db.sqlHint': 'Read-only SQL (SELECT / PRAGMA / EXPLAIN / WITH). Writes are blocked.',
      'db.sqlRun': 'Run query',
      'db.sqlMeta': '{n} rows · {ms} ms',
      'db.sqlTruncated': ' (showing first {shown})',
      'db.sqlEmpty': 'Query returned 0 rows.',
      'db.kindAll': 'All types',
      'db.kindThread': 'Thread',
      'db.kindExchange': 'Exchange',
      'db.kindWindow': 'Window',
      'db.vecAll': 'All vectors',
      'db.vecYes': 'Indexed',
      'db.vecNo': 'Pending',
      'db.filterClear': 'Clear',
      'db.jumpScene': 'Open scene',
      'db.noGist': '(no gist)',
      'db.tplWinKinds': 'Window kinds breakdown',
      'db.mediaCaptionPlaceholder': 'Add a note/caption for this image…',
      'db.mediaCaptionSave': 'Save caption',
      'db.mediaCaptionSaved': 'Caption updated',
      'db.mediaPreviewBtn': 'Preview image',
      'db.tplSessions': 'Sessions',
      'db.tplPending': 'Unindexed',
      'db.tplNotes': 'Recent notes',
      'db.tplTables': 'Tables',
      'db.noSessions': 'No sessions stored in the database yet.',
      'overview.switches': 'COMPANION PERMISSIONS',
      'overview.exclude': 'PRIVATE TIME RANGES',
      'overview.scale': 'MEMORY FOOTPRINT',
      'overview.activity': 'LAST 7 DAYS',
      'overview.activityTip': '{date}: {n} messages',
      'overview.index': 'RECALL & SEMANTICS',
      'overview.searchEntry': 'Find words, moments, or notes you shared…',
      'overview.searchTag': 'Search',
      'overview.kpiScenes': 'Moments',
      'overview.kpiIndex': 'Recall Ready',
      'overview.kpiNotes': 'Shared Notes',
      'overview.kpiDays': '{n} days',
      'overview.kpiPending': '{n} pending',
      'overview.kpiTrash': '{n} in trash',
      'overview.kpiOpen': 'View →',
      'overview.activityHint': 'Tap a bar to revisit that day',
      'status.dotActive': 'Remembering',
      'status.dotWarn': 'New memories to organize',
      'status.dotOff': 'Paused',

      'exclude.excludedCount': 'Excluded by time range: {n} (skipped in search by default)',
      'exclude.empty': 'No time ranges excluded yet.',
      'exclude.add': '+ Add exclude range',
      'exclude.from': 'Start date',
      'exclude.to': 'End date (inclusive)',
      'exclude.reason': 'Reason (optional)',
      'exclude.reasonPlaceholder': 'e.g. debugging / private talk',
      'exclude.save': 'Save & apply',
      'exclude.remove': 'Remove',
      'exclude.missingStart': 'Please choose a start date.',
      'exclude.invalidRange': 'End date cannot be earlier than start date.',
      'exclude.saveOk': 'Exclude ranges saved and active.',
      'exclude.saveFail': 'Could not save exclude ranges: {err}',
      'exclude.fullDay': '{date} (full day)',
      'exclude.inclusiveHint': 'Includes end date; stored as [from, next day).',

      'search.placeholder': 'Search exact words or meaning…',
      'search.submit': 'Search',
      'search.clear': 'Clear',
      'search.whenAll': 'All',
      'search.when7d': '7 days',
      'search.when30d': '30 days',
      'search.whenMonth': 'This month',
      'search.includeExcluded': 'Include excluded',
      'search.prompt': 'Search by exact words, fuzzy impression, or topic across your shared chats, scenes, and notes.',
      'search.empty': 'Nothing matched "{query}" yet.',
      'search.total': '{n} message hit(s)',
      'search.shown': 'showing {n} messages',
      'search.matchedScenes': 'Related moments ({n})',
      'search.sceneKw': 'Scene exact',
      'search.sceneVec': 'Scene meaning',
      'search.sceneBoth': 'Scene both',
      'search.matchedNotes': 'Shared notes ({n})',
      'search.noteKw': 'Note exact',
      'search.noteVec': 'Note meaning',
      'search.noteBoth': 'Note both',
      'search.sourceKeyword': 'Exact',
      'search.sourceVector': 'Meaning',
      'search.sourceBoth': 'Exact + Meaning',
      'search.excludedTag': 'excluded',
      'search.chunkPart': 'Part {k}/{total}',
      'search.chunkPartSingle': 'Part {k}',
      'search.fullLength': '{n} chars total',
      'search.expandFull': 'Show full message',
      'search.windowBadge': 'Window · {n} msgs',
      'search.threadBadge': 'Thread · {n} msgs',
      'search.exchangeBadge': 'Exchange · {n} msgs',
      'search.expandWindow': 'Show window ({n} msgs)',
      'search.expandThread': 'Show thread ({n} msgs)',
      'search.expandExchange': 'Show exchange ({n} msgs)',
      'search.collapseWindow': 'Show single line',
      'search.relatedTimeline': 'Also discussed on: {dates}',
      'search.collapseFull': 'Show matched part',
      'search.jumpTimeline': 'View in timeline →',
      'search.speakerAll': 'All speakers',
      'search.speakerUser': 'Only me',
      'search.speakerAssistant': 'Only TA',
      'search.history': 'Recent:',
      'search.clearHistory': 'Clear',
      'timeline.onlyCompacted': 'Compacted only',
      'timeline.copyScene': 'Copy scene',
      'timeline.prevScene': '← Prev scene',
      'timeline.nextScene': 'Next scene →',
      'notes.add': '+ Add note',
      'notes.addPlaceholder': 'Write something to remember…',
      'notes.aboutAny': 'General',
      'notes.filterAll': 'All',
      'notes.filterPlaceholder': 'Filter notes…',
      'notes.filterEmpty': 'No notes match the current filter.',
      'notes.addOk': 'Note saved.',
      'notes.addFail': 'Could not save note: {err}',
      'search.jumpFail': 'Could not locate message in timeline: {err}',
      'search.failed': 'Search failed: {err}',

      'empty.recordOff': 'This conversation has no records yet.',
      'empty.enableRecord': 'Start recording',
      'empty.otherTab': 'Nothing here yet — check « Overview » to see how to start.',
      'empty.goOverview': 'Go to Overview',
      'empty.noData': 'The library is empty. A few messages in a conversation will fill it.',
      'empty.noDb': 'No memory library yet.',
      'empty.init': 'Initialize',
      'empty.initConfirm': 'Initializing rescans this conversation, splits scenes and builds the index. It can take a while. Continue?',
      'empty.initRunning': 'Initializing…',
      'empty.initDone': 'Initialization finished.',
      'empty.timeline': 'This conversation has no per-day records yet.',
      'empty.notes': 'TA has not written any notes yet. The first thing TA wants to remember will show up here.',
      'empty.verify': 'There is no stored text to check yet.',
      'empty.flags': 'Nothing is marked yet. Draw a message and mark it if something looks wrong.',

      'timeline.noScenes': 'No scenes on this day.',
      'timeline.sceneEmpty': 'This scene has no messages.',
      'timeline.leadIn': '(tail of the previous scene)',
      'timeline.older': 'Load earlier days',
      'timeline.olderMore': 'Load {n} more days',
      'timeline.olderMax': 'Showing the earliest days the API will return ({n}).',
      'timeline.olderFailed': 'Could not load earlier days: {err}',
      'timeline.sceneMsgs': '{n} msgs',
      'timeline.compacted': 'compressed',
      'timeline.sceneFailed': 'Could not read this scene: {err}',
      'timeline.speaker.user': 'you',
      'timeline.speaker.assistant': 'TA',

      'notes.tabActive': 'Notes',
      'notes.tabTrash': 'Trash',
      'notes.trashEmpty': 'Trash is empty. Soft-deleted notes remain restorable for 30 days.',
      'notes.deletedAt': 'Deleted {date}',
      'notes.expiresIn': '{n}d left before purge',
      'notes.expiresSoon': 'Purging soon',
      'notes.restore': 'Restore',
      'notes.restoring': 'Restoring…',
      'notes.restoreOk': 'Restored to notes.',
      'notes.restoreFail': 'Could not restore: {err}',
      'notes.deleteOk': 'Deleted (soft delete, restorable for 30 days)',
      'notes.deleteFail': 'Could not delete: {err}',
      'notes.deleting': 'Deleting…',
      'notes.about.me': 'about TA',
      'notes.about.him': 'about you',
      'notes.about.us': 'about the two of you',

      'verify.draw': 'Draw one',
      'verify.drawing': 'Drawing…',
      'verify.hint': 'Draw a random message and compare the text stored in the library with the text in the session log.',
      'verify.scene': '(scene {from}–{to}, {n} msgs)',
      'verify.viewRaw': 'View raw',
      'verify.loadingRaw': 'Reading…',
      'verify.mark': 'Mark as wrong',
      'verify.db': 'In the library',
      'verify.log': 'In the log',
      'verify.identical': 'identical',
      'verify.differs': 'differs from character {n}',
      'verify.dbChars': 'library {n} chars',
      'verify.logChars': 'log {n} chars',
      'verify.logMissing': 'Not found in the session log',
      'verify.cannotCompare': 'Cannot compare (this message is not in the log)',
      'verify.reason': 'Reason (optional)',
      'verify.reasonPlaceholder': 'e.g. cannot find this line / this is not what I said',
      'verify.markConfirm': 'Mark it',
      'verify.markOk': 'Marked. Nothing was deleted; search still returns this message.',
      'verify.markFail': 'Could not mark: {err}',
      'verify.flagged': 'Marked {n}',
      'verify.flagsFailed': 'Could not read the marked list: {err}',
      'verify.flagsStale': 'The {n} below are from the last successful read and may be out of date.',
      'verify.flagsUnknown': 'marked list unreadable',
      'verify.unflag': 'Unmark',
      'verify.unflagAll': 'Unmark all',
      'verify.unflagOk': 'Unmarked {n}',
      'verify.unflagFail': 'Could not unmark: {err}',
      'verify.noReason': 'no reason given',
      'verify.sampleFail': 'Could not draw a message: {err}',
      'verify.auditTitle': 'Conversation memory audit',
      'verify.auditCompacted': 'Compacted & preserved',
      'verify.auditCompactedVal': '{n} msgs',
      'verify.auditCompactedAction': 'View compacted →',
      'verify.auditVector': 'Vector index coverage',
      'verify.auditVectorVal': '{indexed} / {total} msgs',
      'verify.auditVectorAction': 'Index now',
      'verify.auditGist': 'Scene gist coverage (searchable)',
      'verify.auditGistVal': '{gists} / {scenes} scenes',
      'verify.auditGistAction': 'Generate',
      'verify.batchBtn': 'Spot-check 5 msgs',
      'verify.batchRunning': 'Checking…',
      'verify.batchAllOk': 'Checked {total} messages — all verbatim identical to session log ✓',
      'verify.batchSummary': 'Checked {total}: {ok} identical · {diff} differs · {missing} not in log',
      'verify.idPlaceholder': 'Verify by msg ID (e.g. 42)…',
      'verify.idBtn': 'Verify ID',
      'verify.idInvalid': 'Please enter a valid positive integer msg ID.',
      'db.tplCurMsgs': 'Current session msgs',
      'db.tplCurScenes': 'Current session scenes',
      'db.tplCurNotes': 'Current session notes',
      'verify.verifyFail': 'Could not compare: {err}',
      // ── 设置页（2026-11-18 补：之前 52 个 key 只有中文，英文界面整页显示原始 key）──
      'settings.nav': 'Verbatim memory',
      'settings.title': 'Verbatim memory',
      'settings.subtitle': 'Global defaults for all conversations. Per-chat switches live in the side panel and always take priority.',
      'settings.defaults': 'Defaults for new chats',
      'settings.defaultsHint': 'Both start off so memories are only kept when you choose to turn them on.',
      'settings.defaultsRecordHint': 'Remember new messages. Turning it off never deletes saved memories.',
      'settings.defaultsToolsHint': 'Let TA search past memories and notes during the conversation.',
      'settings.embedding': 'Semantic search',
      'settings.embeddingReady': 'available: {model} @ {dim} dim',
      'settings.embeddingOff': 'unavailable: {reason} Keyword search and the timeline still work.',
      'settings.model': 'Model',
      'settings.modelHint': 'Embedding model id. Leave empty to turn semantic search off.',
      'settings.dim': 'Dimensions',
      'settings.dimHint': 'Must match the model\'s output dimension (or MRL target <= native dim). Run "Test connection" below to detect the real dimension.',
      'settings.mode': 'Service type',
      'settings.modeHint': 'Local = runs on this machine (Ollama / LM Studio); Remote = calls an API.',
      'settings.modeLocal': 'Local',
      'settings.modeRemote': 'Remote',
      'settings.baseUrl': 'Endpoint',
      'settings.baseUrlHint': 'For local use something like http://127.0.0.1:11434/v1; for remote keep its https address.',
      'settings.apiKey': 'API key',
      'settings.apiKeyHint': 'Paste the key here. Leave empty to keep the current one.',
      'settings.apiKeyHintLocal': 'Local services usually need no key — leave it empty if yours does not.',
      'settings.apiKeyNote': 'Leave empty to keep the current key.',
      'settings.apiKeyPlaceholder': 'Enter new API key (leave blank to keep)',
      'settings.apiKeySaved': 'Saved: {masked}',
      'settings.apiKeyEmpty': 'Not set',
      'settings.apiKeyClear': 'Clear',
      'settings.keyFromConfig': 'already stored in the config file: {masked}',
      'settings.keyFromEnv': 'currently read from the environment variable {name}',
      'settings.probeScanning': 'Looking for local services…',
      'settings.probeScanningHint': 'Trying the usual ports: Ollama 11434, LM Studio 1234, vLLM 8000, llama.cpp 8080.',
      'settings.probeFound': 'Found {n} local service(s) running',
      'settings.probePickHint': 'Pick one — the address and model will be filled in for you.',
      'settings.probeNone': 'No local service answered',
      'settings.probeManual': 'Start one first (ollama serve / LM Studio developer mode / vllm serve), or type the address below.',
      'settings.probeAgain': 'Scan again',
      'settings.probeFailed': 'Scan failed: {err}',
      'settings.probeModels': '{n} model(s)',
      'settings.probeNoModel': 'no models listed',
      'settings.probeModelPick': 'Detected models (click to apply)',
      'settings.probeShowAll': 'Show all ({n})',
      'settings.fetchModels': 'Fetch models',
      'settings.fetchingModels': 'Fetching…',
      'settings.dimDetectedOk': 'Matches detected model native dimension ({dim}d).',
      'settings.dimDetectedMrl': 'Model native dimension is {native}d; truncating via MRL to {dim}d.',
      'settings.dimDetectedTooHigh': 'Invalid dimension: model only outputs {native}d, cannot pad to {dim}d.',
      'settings.dimSyncNative': 'Use native {dim}d',
      'settings.dimVecMismatch': 'Note: the active sqlite-vec table is fixed at 1024d; changing away from 1024d will fail under vec0 unless truncated via MRL.',
      'settings.testConn': 'Test connection',
      'settings.testing': 'Testing…',
      'settings.testOkEmbed': 'Connected · {ms}ms · {dim}d vector',
      'settings.testOkLlm': 'Connected · {ms}ms · {model}',
      'settings.testFail': 'Failed: {err}',
      'settings.apiKeyWarn': 'The key is written to config.json in plain text. Only this machine can read it — but do not share that file.',
      'settings.llm': 'Scene summary LLM (optional)',
      'settings.llmReady': 'available: {model} (scene gists participate in search; click "Refine gists (LLM)" to upgrade)',
      'settings.llmDisabled': 'off — using zero-cost extractive scene gists (already indexed in vec_scene for search).',
      'settings.llmOff': 'unavailable: {reason} Falling back to zero-cost extractive scene gists.',
      'settings.llmEnable': 'Enable LLM gist refinement',
      'settings.llmEnableHint': 'Scene gists participate directly in keyword & semantic search (vec_scene). Vector indexing never calls this LLM; it only runs when you explicitly refine scene gists.',
      'settings.llmModelHint': 'Choose from models already configured in DSH (no extra API key needed).',
      'settings.dshModels': 'DSH configured models',
      'settings.dshModelsRefresh': 'Refresh models',
      'settings.dshModelsEmpty': 'No models found in DSH yet. Configure a model in DSH "Models" settings first.',
      'settings.llmBaseUrlHint': 'OpenAI-compatible endpoint (appends /chat/completions). Local e.g. http://127.0.0.1:11434/v1; remote e.g. https://api.deepseek.com/v1.',
      'settings.search': 'Retrieval',
      'settings.alwaysHybrid': 'Always-hybrid search',
      'settings.alwaysHybridDesc': 'Always runs keyword + vector KNN + RRF fusion in parallel whenever embedding & index are ready.',
      'settings.defaultLimit': 'Messages per search',
      'settings.defaultLimitHint': 'Default number of messages returned per search (matched scene gists are shown separately on top).',
      'settings.autoIndex': 'Auto-index new messages',
      'settings.autoIndexHint': 'When enabled, incrementally embed new messages in the background after sync (requires embedding configured).',
      'settings.tabGeneral': 'General',
      'settings.tabEmbedding': 'Embedding',
      'settings.tabLlm': 'Summary LLM',
      'settings.tabRerank': 'Rerank',
      'settings.tabSessions': 'Sessions',
      'settings.sessionsTitle': 'Session Toggles & Storage',
      'settings.sessionsHint': 'Toggle recording/tools per session or in bulk, and export or clear stored data.',
      'settings.sessionsFilter': 'Filter by session ID...',
      'settings.sessionsAllRecOn': 'All Record On',
      'settings.sessionsAllRecOff': 'All Record Off',
      'settings.sessionsAllToolsOn': 'All Tools On',
      'settings.sessionsAllToolsOff': 'All Tools Off',
      'settings.sessionsEmpty': 'No sessions found yet.',
      'settings.sessionsBatchOk': 'Updated {n} sessions.',
      'db.clearSessionBtn': 'Clear Data',
      'db.clearSessionConfirm': 'Confirm Clear?',
      'db.clearSessionCancel': 'Cancel',
      'db.clearSessionOk': 'Cleared session: {msgs} msgs, {scenes} scenes, {notes} notes.',
      'db.deleteSessionBtn': 'Delete',
      'db.deleteSessionConfirm': 'Confirm Delete?',
      'settings.badgeOn': 'Ready',
      'settings.badgeOff': 'Off',
      'settings.badgeWarn': 'Setup',
      'settings.rerank': 'Rerank model (optional)',
      'settings.rerankReady': 'available: {model} (re-scores top candidates after RRF fusion)',
      'settings.rerankDisabled': 'off — using RRF fusion ranking directly (zero extra latency).',
      'settings.rerankOff': 'unavailable: {reason} Falling back to RRF fusion ranking.',
      'settings.rerankEnable': 'Enable Rerank re-scoring',
      'settings.rerankEnableHint': 'Calls /rerank to re-order top candidates after RRF fusion. Automatically falls back to RRF if it fails or times out.',
      'settings.rerankModelHint': 'Reranker model id (e.g. BAAI/bge-reranker-v2-m3, Qwen/Qwen3-Reranker-4B).',
      'settings.rerankBaseUrlHint': 'OpenAI / SiliconFlow-compatible endpoint (appends /rerank).',
      'settings.rerankTopN': 'Candidates to rerank',
      'settings.rerankTopNHint': 'How many top RRF candidates are sent to the reranker (default 50).',
      'settings.testOkRerank': 'Connected · {ms}ms · {model}',
      'settings.vecExtTitle': 'Vector engine (sqlite-vec)',
      'settings.vecExtLoaded': 'Native vec0 extension active ({platform}/{arch}) · {path}',
      'settings.vecExtFallback': 'sqlite-vec not loaded on {platform}/{arch} — using pure SQLite cosine fallback (same results, slower at large scale).',
      'settings.path': 'Config file',
      'settings.pathExists': 'This file exists and is in use.',
      'settings.pathMissing': 'No such file yet — the defaults above are in effect. Saving will create it.',
      'settings.saved': 'Saved.',
      'settings.save': 'Save changes',
      'settings.discard': 'Discard',
      'settings.savedShort': 'Saved',
      'settings.unsavedHint': 'Unsaved changes — the highlighted fields are waiting.',
      'settings.discarded': 'Changes discarded.',
      'settings.loadFailed': 'Could not read global settings: {err}',
      'settings.guideTitle': 'Quick Setup Guide',
      'settings.guideDone': 'All set — semantic recall is ready to use.',
      'settings.guidePending': 'Complete the steps below so TA can recall past moments by meaning.',
      'settings.guideStep1Title': '1. Configure Embedding Model (Recommended)',
      'settings.guideStep1Desc': 'Lets TA recall past chats by meaning rather than exact words alone. Supports local Ollama / LM Studio or remote APIs.',
      'settings.guideStep1Ready': 'Ready · {model}',
      'settings.guideStep1Go': 'Set up →',
      'settings.guideStep2Title': '2. Rerank Model (Optional)',
      'settings.guideStep2Desc': 'Improves precision when your memory library grows large by re-scoring top candidates.',
      'settings.guideStep2Ready': 'Ready · {model}',
      'settings.guideStep2Go': 'Configure →',
      'settings.guideStep3Title': '3. Enable in a Conversation',
      'settings.guideStep3Desc': 'Open "Verbatim memory" in the right sidebar of any chat and turn on "Remember new chats" & "Let TA recall".',
      'settings.llmCompanionNote': 'Note: Companion mode indexes fine-grained exchanges & threads directly, so accurate recall works without an extra Summary LLM. Keep this off unless you specifically want LLM-rewritten scene summaries.',
      'index.setupGuideHint': 'No embedding model configured yet — exact keyword search still works. Configure one in Settings → Verbatim memory → Embedding to unlock semantic recall.',
    };

    const zh = {
      title: '逐字记忆',
      description: '把你们说过的每句话，都好好留在这里。',

      'common.refresh': '刷新',
      'common.loading': '加载中…',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.loadMore': '加载更多',
      'common.save': '保存',
      'common.saved': '已保存',
      'common.saving': '保存中…',
      'common.delete': '删除',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.backTop': '返回顶部',
      'common.failed': '无法读取记忆库。',
      'common.noSession': '未获取到当前会话 ID。',
      'common.unitMsgs': '条',
      'common.unitScenes': '场',

      'switch.record': '记住新对话',
      'switch.tools': '让 TA 随时回想',
      'switch.on': '开启',
      'switch.off': '关闭',
      'switch.recordOff': '已暂停记录新对话。之前留存的 {n} 句依然安好，随时可重新开启。',
      'switch.toolsOff': '已暂停让 TA 在这段对话里主动翻找记忆，已存内容不受影响。',
      'switch.writeOk': '已更新：{name}（{state}）',
      'switch.writeFail': '保存失败：{err}',
      'switch.writeUnconfirmed': '「{name}」已提交，但未收到服务端确认，请刷新核对。',

      'stats.coreBefore': '其中',
      'stats.coreAfter': '句已收进长期记忆',
      'stats.coreHint': '虽然离开了当前上下文，但原话一直都在，随时能想起',
      'stats.rewinded': '已撤回并彻底抹去 {n} 句',
      'stats.rewindedHint': '（不留任何痕迹）',
      'stats.from': '始于 {date}',

      'index.heading': '语义回想',
      'index.advancedShow': '高级诊断与维护',
      'index.advancedHide': '收起诊断与维护',
      'index.modelStored': '库内模型',
      'index.modelConfigured': '当前配置',
      'index.modelNever': '尚未建立索引',
      'index.consistency': '一致性',
      'index.consistencyOk': '一致',
      'index.consistencyMismatch': '不一致，需重建',
      'index.consistencyMixed': '混存 {n} 套模型，需重建',
      'index.consistencyUnknown': '未知',
      'index.unitDim': '维',
      'index.state': '状态',
      'index.modelUnset': '未配置',
      'index.dim': '{n} 维',
      'index.count': '可回想消息',
      'index.windowsCount': '记忆片段向量',
      'index.windowsKinds': '（微话题 {thread} · 问答 {exchange}）',
      'index.statePending': '待同步',
      'index.rebuildFailedBadge': '上次同步失败',
      'index.pendingCount': '待索引 {n} 条',
      'index.syncIndex': '增量同步索引',
      'index.noTaskId': '重建接口未返回 taskId',
      'index.syncRunning': '同步索引中…',
      'index.syncDone': '同步索引完成',
      'index.syncUpToDate': '当前会话索引已是最新',
      'index.resplit': '重切场景',
      'index.refineGist': '全量精炼摘要',
      'index.refineGistMissing': '补齐未精炼摘要',
      'index.llmGistCoverage': 'LLM 摘要覆盖：{done} / {total} 场（{pct}%）',
      'timeline.pendingMsgs': '正在聊 · {n} 句（安静 30 分钟后会自动整理成一段回忆）',
      'timeline.mergePrev': '合并至上一场',
      'timeline.splitHere': '在此拆分',
      'timeline.refineOne': '单场精炼',
      'timeline.editGist': '编辑摘要',
      'timeline.gistSavedOk': '摘要已保存（已锁定为手动摘要）。',
      'timeline.muteMsg': '暂不回想',
      'timeline.unmuteMsg': '恢复回想',
      'timeline.mutedTag': '暂不回想',
      'notes.edit': '编辑',
      'notes.updatedOk': '笔记已更新。',
      'db.exportMdBtn': '导出 Markdown',
      'timeline.mergedOk': '已合并至上一场并锁定边界。',
      'timeline.splitOk': '已拆分为两个场景并锁定边界。',
      'timeline.refinedOneOk': '单场摘要已更新。',
      'timeline.previewImg': '预览',
      'search.rerankedBadge': '智能精排',
      'search.recallTitle': 'TA 最近的回想记录（{n}）',
      'search.recallToggle': '看看 TA 刚才想起了什么',
      'search.recallEmpty': '这段对话里 TA 还没有翻找过过往记忆。',
      'notes.dedupBtn': '重复检测',
      'notes.dedupNone': '未检测到重复笔记。',
      'notes.dedupMerge': '合并归档（{n} 条）',
      'notes.dedupMergedOk': '已将 {n} 条重复笔记移入回收站。',
      'settings.llmAutoRefine': '后台自动补齐摘要',
      'settings.llmAutoRefineHint': '新场景归档后，在后台低并发自动补齐未精炼场景的 LLM 摘要。',
      'settings.llmDailyLimit': '每日自动摘要上限',
      'settings.llmDailyLimitHint': '限制每日后台自动调用的场次数，用于控制模型开销。',
      'db.importSessionBtn': '导入 JSON',
      'db.importSessionOk': '已导入 {sid}：{msgs} 条消息，{notes} 条笔记。',
      'index.llmCostHint': '增量同步、向量重建与场景重切仅使用本地算法或 Embedding，不调用 LLM。',
      'index.llmReadyHint': '摘要模型已就绪（{model}），可按需补齐或全量精炼场景摘要。',
      'index.rebuild': '重建向量',
      'index.rebuildConfirm': '重建向量将作用于整个记忆库（仅重算 Embedding 向量，不修改原文、不调用 LLM）。重建期间语义检索暂不可用，是否继续？',
      'index.rebuildYes': '确认重建',
      'index.rebuildRunning': '重建中…',
      'index.rebuildDone': '重建完成',
      'index.rebuildFail': '重建失败：{err}',
      'index.rebuildSlow': '任务仍在后台运行，请稍后刷新查看进度。',
      'index.rebuildUnsure': '索引计数维持在 {indexed} / {total}，请刷新确认任务状态。',
      'index.resultSynced': ' · 新增 {n} 条',
      'index.resultIndexed': ' · 补建 {n} 条',
      'index.resultVectors': ' · 向量 {n} 条',
      'index.resultChunks': ' · 分片 {n}',
      'index.resultScenes': ' · 场景 {n} 场',
      'index.progressChunks': ' · 分片 {n}',
      'index.stateOk': '正常',
      'index.stateDegraded': '纯 SQLite 余弦检索（未加载 vec0 扩展）',
      'index.stateEmpty': '尚未建立索引（当前仅关键词检索）',
      'index.statePartial': '索引覆盖不足（当前仅关键词检索）',
      'index.stateDisabled': '未启用（未配置 Embedding，关键词检索与时间轴正常）',
      'index.stateMismatch': '不可用：库内索引与当前配置模型不一致',
      'index.stateMixed': '不可用：库内混存多套模型向量',
      'index.stateUnknown': '状态未知',
      'index.semanticOff': '语义检索未启用。',

      'tab.overview': '概览',
      'tab.search': '搜索',
      'tab.timeline': '时间轴',
      'tab.notes': '笔记',
      'tab.verify': '核对',
      'tab.db': '库',
      'db.subSessions': '记忆总览',
      'db.subBrowse': '原文浏览',
      'db.subSql': '高级查询 (SQL)',
      'db.summary': '存储总览',
      'db.sessionsHeading': '库内对话（{n}）',
      'db.size': '记忆库大小',
      'db.schema': '格式版本',
      'db.vecEngine': '向量引擎',
      'db.vecNative': 'sqlite-vec',
      'db.vecFallback': 'SQLite 余弦回退',
      'db.totals': '{sessions} 对话 · {msgs} 消息 · {scenes} 场景 · {notes} 笔记',
      'db.vecCoverage': '全库可回想：{indexed} / {total}',
      'db.backup': '热备份',
      'db.vacuum': '压缩整理',
      'db.purgeTrash': '清空回收站 ({n})',
      'db.backupOk': '备份已保存：{path}（{size}）',
      'db.vacuumOk': '压缩完成：{before} → {after}',
      'db.purgeOk': '已清理 {n} 条过期软删笔记。',
      'db.exportOk': '已导出 {msgs} 条消息、{notes} 条笔记。',
      'db.actionFail': '操作失败：{err}',
      'db.currentBadge': '当前',
      'db.browseBtn': '浏览数据',
      'db.syncIndexBtn': '同步索引',
      'db.exportBtn': '导出 JSON',
      'db.allSessions': '全部会话（{n}）',
      'db.filterPlaceholder': '按关键字筛选…',
      'db.filterBtn': '筛选',
      'db.emptyRows': '无匹配记录。',
      'db.pageInfo': '第 {page} / {pages} 页 · 共 {total} 条',
      'db.prevPage': '上一页',
      'db.nextPage': '下一页',
      'db.jumpPage': '跳转',
      'db.table.msg': '消息 msg',
      'db.table.scene': '场景 scene',
      'db.table.window': '记忆窗 window',
      'db.table.note': '笔记 note',
      'db.table.flag': '标记 flag',
      'db.table.chunk': '分片 chunk',
      'db.table.media': '图片媒体 media',
      'db.sqlHint': '仅允许单条只读查询（SELECT / PRAGMA / EXPLAIN / WITH）。',
      'db.sqlRun': '执行',
      'db.sqlMeta': '{n} 行 · {ms} ms',
      'db.sqlTruncated': '（仅展示前 {shown} 行）',
      'db.sqlEmpty': '查询完成，返回 0 行。',
      'db.kindAll': '全部类型',
      'db.kindThread': '微话题',
      'db.kindExchange': '问答',
      'db.kindWindow': '对话窗',
      'db.vecAll': '全部向量状态',
      'db.vecYes': '已建向量',
      'db.vecNo': '待索引',
      'db.filterClear': '清空',
      'db.jumpScene': '跳到所属场次',
      'db.noGist': '（无摘要）',
      'db.tplWinKinds': '对话窗类型分布',
      'db.mediaCaptionPlaceholder': '给这张图片补一句备注（可用于搜索）…',
      'db.mediaCaptionSave': '保存备注',
      'db.mediaCaptionSaved': '图片备注已更新',
      'db.mediaPreviewBtn': '预览图片',
      'db.tplSessions': '会话统计',
      'db.tplPending': '未索引消息',
      'db.tplNotes': '最近笔记',
      'db.tplTables': '表结构',
      'db.noSessions': '暂无会话数据。',
      'overview.switches': '陪伴权限',
      'overview.exclude': '私密排除时段',
      'overview.scale': '记忆轮廓',
      'overview.activity': '最近 7 天聊了多少',
      'overview.activityTip': '{date}：{n} 句',
      'overview.index': '语义回想',
      'overview.searchEntry': '找找你们聊过的话、场景或笔记…',
      'overview.searchTag': '搜索',
      'overview.kpiScenes': '共度场景',
      'overview.kpiIndex': '回想就绪度',
      'overview.kpiNotes': '共同笔记',
      'overview.kpiDays': '跨度 {n} 天',
      'overview.kpiPending': '待整理 {n} 句',
      'overview.kpiTrash': '回收站 {n}',
      'overview.kpiOpen': '查看 →',
      'overview.activityHint': '点柱子回到那天的对话',
      'status.dotActive': '记忆同步中',
      'status.dotWarn': '有新记忆待整理',
      'status.dotOff': '暂未记录新对话',

      'exclude.excludedCount': '已排除 {n} 条消息（检索默认跳过）',
      'exclude.empty': '未配置排除时段。',
      'exclude.add': '+ 添加时段',
      'exclude.from': '开始日期',
      'exclude.to': '结束日期（含当天）',
      'exclude.reason': '备注（选填）',
      'exclude.reasonPlaceholder': '例如：测试期 / 隐私内容',
      'exclude.save': '保存并应用',
      'exclude.remove': '移除',
      'exclude.missingStart': '请选择开始日期。',
      'exclude.invalidRange': '结束日期不能早于开始日期。',
      'exclude.saveOk': '排除时段已生效。',
      'exclude.saveFail': '保存失败：{err}',
      'exclude.fullDay': '{date}（全天）',
      'exclude.inclusiveHint': '包含结束当天（内部按左闭右开区间处理）。',

      'search.placeholder': '输入想找的词、话题或模糊印象…',
      'search.submit': '搜索',
      'search.clear': '清空',
      'search.whenAll': '全部时间',
      'search.when7d': '近 7 天',
      'search.when30d': '近 30 天',
      'search.whenMonth': '本月',
      'search.includeExcluded': '含已排除',
      'search.prompt': '输入想找的词或大致印象，帮你在原话、场景记忆和笔记里一起翻找。',
      'search.empty': '还没有找到和「{query}」有关的记忆。',
      'search.total': '找到 {n} 句相关对话',
      'search.shown': '当前展示前 {n} 句',
      'search.matchedScenes': '相关场景（{n}）',
      'search.sceneKw': '摘要原词',
      'search.sceneVec': '摘要语意',
      'search.sceneBoth': '摘要双匹配',
      'search.matchedNotes': '相关笔记（{n}）',
      'search.noteKw': '笔记原词',
      'search.noteVec': '笔记语意',
      'search.noteBoth': '笔记双匹配',
      'search.sourceKeyword': '原词',
      'search.sourceVector': '语意',
      'search.sourceBoth': '原词+语意',
      'search.excludedTag': '已排除',
      'search.chunkPart': '第 {k}/{total} 段',
      'search.chunkPartSingle': '第 {k} 段',
      'search.fullLength': '全文 {n} 字',
      'search.expandFull': '展开全文',
      'search.windowBadge': '记忆窗 · {n} 句',
      'search.threadBadge': '微话题 · {n} 句',
      'search.exchangeBadge': '问答对 · {n} 句',
      'search.expandWindow': '展开前后对话（{n} 句）',
      'search.expandThread': '展开这段微话题（{n} 句）',
      'search.expandExchange': '展开这组问答（{n} 句）',
      'search.collapseWindow': '仅看命中句',
      'search.relatedTimeline': '那几天也聊过：{dates}',
      'search.collapseFull': '收起',
      'search.jumpTimeline': '回到那天的时间轴 →',
      'search.speakerAll': '全部',
      'search.speakerUser': '你说的',
      'search.speakerAssistant': 'TA 说的',
      'search.history': '最近找过：',
      'search.clearHistory': '清空',
      'timeline.onlyCompacted': '只看长期记忆',
      'timeline.copyScene': '复制整段',
      'timeline.prevScene': '← 上一段',
      'timeline.nextScene': '下一段 →',
      'notes.add': '+ 记一笔',
      'notes.addPlaceholder': '写下想让 TA 一直记住的事…',
      'notes.aboutAny': '不限归属',
      'notes.filterAll': '全部',
      'notes.filterPlaceholder': '按关键词筛选…',
      'notes.filterEmpty': '无匹配笔记。',
      'notes.addOk': '笔记已保存。',
      'notes.addFail': '保存失败：{err}',
      'search.jumpFail': '定位失败：{err}',
      'search.failed': '检索失败：{err}',

      'empty.recordOff': '当前会话未开启记录。',
      'empty.enableRecord': '开启记录',
      'empty.otherTab': '当前会话暂无数据，请先在「概览」开启记录或同步。',
      'empty.goOverview': '前往概览',
      'empty.noData': '暂无入库消息。',
      'empty.noDb': '记忆库尚未初始化。',
      'empty.init': '初始化',
      'empty.initConfirm': '将扫描当前会话日志、切分场景并构建索引，是否继续？',
      'empty.initRunning': '初始化中…',
      'empty.initDone': '初始化完成。',
      'empty.timeline': '暂无时间轴记录。',
      'empty.notes': '暂无笔记。',
      'empty.verify': '暂无可核对的消息。',
      'empty.flags': '暂无异常标记。',

      'timeline.noScenes': '当日无已归档场景。',
      'timeline.sceneEmpty': '该场景无消息记录。',
      'timeline.leadIn': '接上一段的尾巴',
      'timeline.older': '加载更早',
      'timeline.olderMore': '再加载 {n} 天',
      'timeline.olderMax': '已到达最大查询范围（{n} 天）。',
      'timeline.olderFailed': '加载失败：{err}',
      'timeline.sceneMsgs': '{n} 句',
      'timeline.compacted': '长期记忆',
      'timeline.sceneFailed': '场景详情加载失败：{err}',
      'timeline.speaker.user': '你',
      'timeline.speaker.assistant': 'TA',

      'notes.tabActive': '记得的事',
      'notes.tabTrash': '回收站',
      'notes.trashEmpty': '回收站还是空的。删掉的笔记会在这里保留 30 天，随时可以找回。',
      'notes.deletedAt': '删除于 {date}',
      'notes.expiresIn': '{n} 天后清理',
      'notes.expiresSoon': '即将清理',
      'notes.restore': '恢复',
      'notes.restoring': '恢复中…',
      'notes.restoreOk': '笔记已恢复。',
      'notes.restoreFail': '恢复失败：{err}',
      'notes.deleteOk': '已移入回收站（30 天内可随时找回）。',
      'notes.deleteFail': '删除失败：{err}',
      'notes.deleting': '删除中…',
      'notes.about.me': '关于 TA 自己',
      'notes.about.him': '关于你',
      'notes.about.us': '我们的约定',

      'verify.draw': '随机抽一句',
      'verify.drawing': '抽取中…',
      'verify.hint': '随机抽一句已记住的话，和原始对话记录逐字比对，确认没有记错、漏记或走样。',
      'verify.scene': '（{from}–{to} · {n} 条）',
      'verify.viewRaw': '比对日志原文',
      'verify.loadingRaw': '读取中…',
      'verify.mark': '标记异常',
      'verify.db': '库内原文',
      'verify.log': '日志原文',
      'verify.identical': '逐字一致',
      'verify.differs': '存在差异（始于第 {n} 字符）',
      'verify.dbChars': '库内 {n} 字',
      'verify.logChars': '日志 {n} 字',
      'verify.logMissing': '日志中未找到该条记录',
      'verify.cannotCompare': '无法比对（日志缺失该条）',
      'verify.reason': '异常说明（选填）',
      'verify.reasonPlaceholder': '例如：检索漏召回 / 内容异常',
      'verify.markConfirm': '确认标记',
      'verify.markOk': '已记录标记，不影响原有数据与检索。',
      'verify.markFail': '标记失败：{err}',
      'verify.flagged': '已标记 {n} 条',
      'verify.flagsFailed': '读取标记列表失败：{err}',
      'verify.flagsStale': '当前显示的是上次缓存的 {n} 条记录。',
      'verify.flagsUnknown': '标记列表读取失败',
      'verify.unflag': '移除标记',
      'verify.unflagAll': '清空标记',
      'verify.unflagOk': '已移除 {n} 条标记。',
      'verify.unflagFail': '移除失败：{err}',
      'verify.noReason': '无备注',
      'verify.sampleFail': '抽检失败：{err}',
      'verify.verifyFail': '比对失败：{err}',
      'verify.auditTitle': '记忆健康度',
      'verify.auditCompacted': '已收进长期记忆的原话',
      'verify.auditCompactedVal': '{n} 句',
      'verify.auditCompactedAction': '去看看 →',
      'verify.auditVector': '可语义回想进度',
      'verify.auditVectorVal': '{indexed} / {total} 句',
      'verify.auditVectorAction': '立即同步',
      'verify.auditGist': '已整理摘要的场景',
      'verify.auditGistVal': '{gists} / {scenes} 场',
      'verify.auditGistAction': '补齐摘要',
      'verify.batchBtn': '批量抽检 5 条',
      'verify.batchRunning': '抽检中…',
      'verify.batchAllOk': '抽检 {total} 条，均与原始日志逐字一致。',
      'verify.batchSummary': '抽检 {total} 条：一致 {ok} · 差异 {diff} · 日志缺失 {missing}',
      'verify.idPlaceholder': '输入消息 ID 精准核对…',
      'verify.idBtn': '按 ID 核对',
      'verify.idInvalid': '请输入有效的正整数 ID。',
      'db.tplCurMsgs': '当前会话消息',
      'db.tplCurScenes': '当前会话场景',
      'db.tplCurNotes': '当前会话笔记',

      // ── 设置页（全局）──
      'settings.nav': '逐字记忆',
      'settings.title': '逐字记忆',
      'settings.subtitle': '这里是所有对话共用的默认设置。每个对话自己的「记住新对话 / 让 TA 随时回想」开关可以在右侧栏单独调整，优先级更高。',
      'settings.defaults': '新对话默认权限',
      'settings.defaultsHint': '新开启的对话默认不自动记录，只有你明确打开时才会把对话留存在本地记忆库里。',
      'settings.defaultsRecordHint': '自动记住新说的话。关闭后也不会删掉之前已经记住的内容。',
      'settings.defaultsToolsHint': '允许 TA 在需要时主动翻找过去的原话与笔记。',
      'settings.embedding': '向量模型（Embedding）',
      'settings.embeddingReady': '已就绪：{model} · {dim} 维',
      'settings.embeddingOff': '未就绪：{reason}（关键词检索与时间轴正常）',
      'settings.model': '模型名称',
      'settings.modelHint': 'Embedding 模型 ID，留空则禁用语义检索。',
      'settings.dim': '向量维度',
      'settings.dimHint': '须与模型原生输出维度或合法 MRL 截断维度一致，建议通过下方「测试连通性」自动校验。',
      'settings.mode': '部署方式',
      'settings.modeHint': '本地（Ollama / LM Studio 等）或远程兼容接口。',
      'settings.modeLocal': '本地',
      'settings.modeRemote': '远程',
      'settings.baseUrl': '接口地址',
      'settings.baseUrlHint': '兼容 OpenAI /v1 协议的接口地址（如 http://127.0.0.1:11434/v1）。',
      'settings.apiKey': 'API Key',
      'settings.apiKeyHint': '输入密钥，留空表示保持当前配置不变。',
      'settings.apiKeyHintLocal': '本地服务通常无需认证，可留空。',
      'settings.apiKeyNote': '留空表示不修改。',
      'settings.apiKeyPlaceholder': '输入新 API Key（留空保持不变）',
      'settings.apiKeySaved': '已配置：{masked}',
      'settings.apiKeyEmpty': '未配置',
      'settings.apiKeyClear': '清除',
      'settings.keyFromConfig': '来源：本地配置文件（{masked}）',
      'settings.keyFromEnv': '来源：环境变量 {name}',
      'settings.probeScanning': '正在扫描本地服务…',
      'settings.probeScanningHint': '探测常见端口：11434 (Ollama)、1234 (LM Studio)、8000 (vLLM)、8080 (llama.cpp)。',
      'settings.probeFound': '检测到 {n} 个本地服务',
      'settings.probePickHint': '点击服务可自动填充地址与模型列表。',
      'settings.probeNone': '未检测到运行中的本地服务',
      'settings.probeManual': '请先启动本地推理服务，或手动填写下方接口地址。',
      'settings.probeAgain': '重新扫描',
      'settings.probeFailed': '扫描失败：{err}',
      'settings.probeModels': '{n} 个模型',
      'settings.probeNoModel': '无可用模型',
      'settings.probeModelPick': '可用模型（点击选用）',
      'settings.probeShowAll': '查看全部 ({n})',
      'settings.fetchModels': '获取模型列表',
      'settings.fetchingModels': '获取中…',
      'settings.dimDetectedOk': '与模型原生维度一致（{dim} 维）。',
      'settings.dimDetectedMrl': '原生维度 {native}，当前配置将按 MRL 截断至 {dim} 维。',
      'settings.dimDetectedTooHigh': '维度越界：模型原生仅 {native} 维，无法输出 {dim} 维向量。',
      'settings.dimSyncNative': '同步为 {dim} 维',
      'settings.dimVecMismatch': '当前 sqlite-vec 虚表固定为 1024 维，建议保持 1024 维以获得原生加速。',
      'settings.testConn': '测试连通性',
      'settings.testing': '测试中…',
      'settings.testOkEmbed': '连接成功 · {ms}ms · {dim} 维',
      'settings.testOkLlm': '连接成功 · {ms}ms · {model}',
      'settings.testFail': '连接失败：{err}',
      'settings.apiKeyWarn': '密钥明文存储于本地 config.json，请妥善保管配置文件。',
      'settings.llm': '摘要模型（可选）',
      'settings.llmReady': '已就绪：{model}',
      'settings.llmDisabled': '未启用（当前使用本地抽取式场景摘要并写入 vec_scene）。',
      'settings.llmOff': '未就绪：{reason}（已回退本地抽取式摘要）',
      'settings.llmEnable': '启用 LLM 场景摘要',
      'settings.llmEnableHint': '用于将抽取式场景摘要精炼为结构化语义摘要；常规同步与向量重建不调用 LLM。',
      'settings.llmModelHint': '直接复用 DSH 已配置的模型，无需重复配置接口与密钥。',
      'settings.dshModels': 'DSH 可用模型',
      'settings.dshModelsRefresh': '刷新列表',
      'settings.dshModelsEmpty': '未读取到 DSH 模型，请先在主程序「模型」设置中完成配置。',
      'settings.llmBaseUrlHint': '兼容 /chat/completions 的接口地址。',
      'settings.search': '检索策略',
      'settings.alwaysHybrid': '全量混合检索',
      'settings.alwaysHybridDesc': '向量索引就绪时始终并行执行关键词 + 向量 KNN + RRF 融合。',
      'settings.defaultLimit': '默认返回条数',
      'settings.defaultLimitHint': '单次检索默认返回的消息上限。',
      'settings.autoIndex': '后台自动补建索引',
      'settings.autoIndexHint': '同步新消息后在后台增量补建向量索引。',
      'settings.tabGeneral': '通用与检索',
      'settings.tabEmbedding': '向量模型',
      'settings.tabLlm': '摘要模型',
      'settings.tabRerank': '精排模型',
      'settings.tabSessions': '会话管理',
      'settings.sessionsTitle': '会话开关与数据管理',
      'settings.sessionsHint': '管理各会话的记录/工具开关，支持导出、导入与清空库内数据（清空不影响开关配置）。',
      'settings.sessionsFilter': '按会话名称或 ID 筛选…',
      'settings.sessionsAllRecOn': '全部开启记录',
      'settings.sessionsAllRecOff': '全部关闭记录',
      'settings.sessionsAllToolsOn': '全部开启工具',
      'settings.sessionsAllToolsOff': '全部关闭工具',
      'settings.sessionsEmpty': '暂无会话记录。',
      'settings.sessionsBatchOk': '已更新 {n} 个会话。',
      'db.clearSessionBtn': '清空数据',
      'db.clearSessionConfirm': '确认清空',
      'db.clearSessionCancel': '取消',
      'db.clearSessionOk': '已清空：{msgs} 条消息、{scenes} 个场景、{notes} 条笔记。',
      'db.deleteSessionBtn': '删除',
      'db.deleteSessionConfirm': '确认删除',
      'settings.badgeOn': '就绪',
      'settings.badgeOff': '关闭',
      'settings.badgeWarn': '待配置',
      'settings.rerank': '精排模型（Rerank，可选）',
      'settings.rerankReady': '已就绪：{model}',
      'settings.rerankDisabled': '未启用（直接使用 RRF 融合排序）。',
      'settings.rerankOff': '未就绪：{reason}（已回退 RRF 排序）',
      'settings.rerankEnable': '启用 Rerank 二次精排',
      'settings.rerankEnableHint': '在 RRF 融合后调用 /rerank 重排候选，超时或异常时自动回退 RRF 原序。',
      'settings.rerankModelHint': '精排模型 ID（如 BAAI/bge-reranker-v2-m3、Qwen/Qwen3-Reranker-4B）。',
      'settings.rerankBaseUrlHint': '兼容 /rerank 协议的接口地址。',
      'settings.rerankTopN': '精排候选数',
      'settings.rerankTopNHint': '送入精排模型的 RRF 头部候选条数（默认 50）。',
      'settings.testOkRerank': '连接成功 · {ms}ms · {model}',
      'settings.vecExtTitle': '向量引擎（sqlite-vec）',
      'settings.vecExtLoaded': '原生 vec0 扩展已启用（{platform}/{arch}）· {path}',
      'settings.vecExtFallback': '当前环境（{platform}/{arch}）未加载 sqlite-vec，使用纯 SQLite 余弦检索。',
      'settings.path': '配置文件',
      'settings.pathExists': '配置文件生效中。',
      'settings.pathMissing': '尚未创建，当前使用默认配置，保存后自动生成。',
      'settings.saved': '已保存。',
      'settings.save': '保存修改',
      'settings.discard': '放弃修改',
      'settings.savedShort': '已保存',
      'settings.unsavedHint': '存在未保存的修改。',
      'settings.discarded': '已放弃修改。',
      'settings.loadFailed': '读取全局配置失败：{err}',
      'settings.guideTitle': '快速上手引导',
      'settings.guideDone': '已全部就绪，现在可以顺畅体验陪伴式语意回想了。',
      'settings.guidePending': '按下面 3 步配置，让 TA 能按意思想起你们聊过的每一件事。',
      'settings.guideStep1Title': '1. 配置向量模型（Embedding，推荐）',
      'settings.guideStep1Desc': '让 TA 能按语意联想过往话题，而不只是死记关键词。支持本地 Ollama / LM Studio 或云端接口。',
      'settings.guideStep1Ready': '已就绪 · {model}',
      'settings.guideStep1Go': '去配置 →',
      'settings.guideStep2Title': '2. 精排模型（Rerank，可选）',
      'settings.guideStep2Desc': '对话积累多起来后，帮 TA 从候选记忆里挑出最贴切的那几句。',
      'settings.guideStep2Ready': '已就绪 · {model}',
      'settings.guideStep2Go': '按需配置 →',
      'settings.guideStep3Title': '3. 在对话右侧栏开启陪伴权限',
      'settings.guideStep3Desc': '打开任意对话，在右侧栏「逐字记忆」中打开「记住新对话」与「让 TA 随时回想」即可。',
      'settings.llmCompanionNote': '提示：当前已采用精细问答与微话题直检，无需额外摘要模型也能准确回忆，且不消耗额外对话 Token；此处仅保留给有手动精炼摘要需求的用户按需启用。',
      'index.setupGuideHint': '还没配置向量模型，目前仅支持按原词查找。到左下角「设置 → 逐字记忆 → 向量模型」填好后即可开启语意回想。',
    };

    /* ══════════════════════════ 取值工具 ══════════════════════════ */

    const msgOf = (e) => (e && e.message ? e.message : String(e));

    function pickNum(...values) {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
          const n = Number(value);
          if (Number.isFinite(n)) return n;
        }
      }
      return undefined;
    }

    function pickNumOrNull(...values) {
      return pickNum(...values) ?? null;
    }

    function pickStr(...values) {
      for (const value of values) {
        if (typeof value === 'string') return value;
      }
      return null;
    }

    function asArray(raw, key) {
      if (Array.isArray(raw)) return raw;
      if (raw && Array.isArray(raw[key])) return raw[key];
      return [];
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    const fmtNum = (n, locale) =>
      typeof n === 'number' && Number.isFinite(n)
        ? n.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')
        : '—';

    /** 「16.2 万字」/「8,120 字」/「162,000 chars」 */
    function charsLabel(n, locale) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
      if (locale === 'zh') {
        if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
        return `${fmtNum(n, 'zh')} 字`;
      }
      return `${fmtNum(n, 'en')} chars`;
    }

    /** 字节数格式化（B / KB / MB / GB） */
    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /** 缩短过长的 sessionId 便于窄栏展示 */
    function shortSid(sid) {
      const s = String(sid ?? '');
      if (s.length <= 22) return s;
      return `${s.slice(0, 12)}…${s.slice(-6)}`;
    }

    /** epoch ms → '2026-11-17'（本地时区；不要用 toISOString，那是 UTC，跨零点会差一天） */
    const fmtDateKey = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };

    /** '2026-11-17' → '11-17' */
    const fmtDay = (date) => {
      const text = String(date ?? '');
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text || '—';
    };

    const fmtClock = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    /** '11-15 01:40' */
    const fmtShort = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      const d = new Date(at);
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    /** 场景时间：'11-15 01:40–02:30' */
    const fmtSceneRange = (startAt, endAt) => {
      if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return '—';
      return `${fmtShort(startAt)}–${fmtClock(endAt)}`;
    };

    const isYMD = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim());

    /** YYYY-MM-DD 按日历加减天数（纯 UTC 日期算术，避免本地时区跨夏令时/零点偏移） */
    function shiftYMD(ymd, deltaDays) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
      if (!m) return null;
      const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    }

    /** 当前本地年月 'YYYY-MM' */
    function currentMonthYMD() {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    }

    async function copyToClipboard(text) {
      const value = String(text ?? '');
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
      if (typeof document !== 'undefined') {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } finally { ta.remove(); }
        if (ok) return true;
      }
      return false;
    }

    /** 安全切分纯文本做关键词高亮，绝不使用 dangerouslySetInnerHTML */
    function renderHighlightedText(text, query, markStyle) {
      const source = String(text ?? '');
      const rawQuery = String(query ?? '').trim();
      if (!source || !rawQuery) return source;
      const terms = Array.from(new Set(
        rawQuery.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      ))
        .sort((a, b) => b.length - a.length)
        .slice(0, 12);
      if (terms.length === 0) return source;
      const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      let re;
      try {
        re = new RegExp(`(${pattern})`, 'gi');
      } catch {
        return source;
      }
      const parts = source.split(re);
      if (parts.length <= 1) return source;
      return parts.map((part, idx) => {
        if (!part) return null;
        return idx % 2 === 1
          ? h('mark', { key: `m${idx}`, style: markStyle }, part)
          : part;
      });
    }

    /**
     * 轻量安全 Markdown 渲染（纯 React 元素，绝不使用 dangerouslySetInnerHTML）。
     * 支持：围栏代码块、标题、引用、有序/无序列表、行内代码、加粗、斜体、删除线、安全链接，
     * 并兼容搜索关键词高亮（highlightQuery）。
     */
    function renderMarkdown(text, opts = {}) {
      const source = String(text ?? '');
      if (!source) return '';
      const query = opts.highlightQuery || '';
      const markStyle = opts.markStyle || S.searchMark;

      const renderInline = (line, keyPrefix) => {
        // 匹配顺序：行内代码 > 链接 > 加粗 > 删除线 > 斜体
        const tokenRe = /(`[^`\n]+`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*)/g;
        const nodes = [];
        let last = 0;
        let idx = 0;
        let m;
        while ((m = tokenRe.exec(line)) !== null) {
          if (m.index > last) {
            nodes.push(renderHighlightedText(line.slice(last, m.index), query, markStyle));
          }
          const raw = m[0];
          const k = `${keyPrefix}-${idx++}`;
          if (raw.startsWith('`')) {
            nodes.push(h('code', { key: k, style: S.mdInlineCode }, renderHighlightedText(raw.slice(1, -1), query, markStyle)));
          } else if (m[2] !== undefined && m[3] !== undefined) {
            nodes.push(h('a', {
              key: k,
              href: m[3],
              target: '_blank',
              rel: 'noopener noreferrer',
              style: S.mdLink,
            }, renderHighlightedText(m[2], query, markStyle)));
          } else if (m[4] !== undefined) {
            nodes.push(h('strong', { key: k, style: { fontWeight: 600 } }, renderHighlightedText(m[4], query, markStyle)));
          } else if (m[5] !== undefined) {
            nodes.push(h('del', { key: k, style: { opacity: 0.7 } }, renderHighlightedText(m[5], query, markStyle)));
          } else if (m[6] !== undefined) {
            nodes.push(h('em', { key: k }, renderHighlightedText(m[6], query, markStyle)));
          }
          last = m.index + raw.length;
        }
        if (last < line.length) {
          nodes.push(renderHighlightedText(line.slice(last), query, markStyle));
        }
        return nodes.length === 1 ? nodes[0] : nodes;
      };

      const splitTableRow = (rowLine) => {
        let s = String(rowLine ?? '').trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        const cells = [];
        let cur = '';
        for (let k = 0; k < s.length; k++) {
          if (s[k] === '\\' && s[k + 1] === '|') {
            cur += '|';
            k += 1;
          } else if (s[k] === '|') {
            cells.push(cur.trim());
            cur = '';
          } else {
            cur += s[k];
          }
        }
        cells.push(cur.trim());
        return cells;
      };

      const parseTableAligns = (sepLine) => {
        if (!sepLine || !sepLine.includes('|')) return null;
        const cells = splitTableRow(sepLine);
        if (cells.length === 0) return null;
        const aligns = [];
        for (const c of cells) {
          if (!/^:?-{2,}:?$/.test(c)) return null;
          if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
          else if (c.endsWith(':')) aligns.push('right');
          else aligns.push('left');
        }
        return aligns;
      };

      const lines = source.replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let bi = 0;

      while (i < lines.length) {
        const line = lines[i];

        // ① 围栏代码块 ```lang
        const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line);
        if (fence) {
          const lang = fence[1] || '';
          const codeLines = [];
          i += 1;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) {
            codeLines.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1; // 跳过结束 ```
          blocks.push(h('div', { key: `b${bi++}`, style: S.mdCodeWrap },
            lang ? h('div', { style: S.mdCodeLang }, lang) : null,
            h('pre', { style: S.mdPre }, h('code', null, renderHighlightedText(codeLines.join('\n'), query, markStyle)))));
          continue;
        }

        // ② 标题 # .. ######
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
          const lvl = heading[1].length;
          blocks.push(h('div', {
            key: `b${bi++}`,
            style: lvl === 1 ? S.mdH1 : lvl === 2 ? S.mdH2 : S.mdH3,
          }, renderInline(heading[2], `h${bi}`)));
          i += 1;
          continue;
        }

        // ②.5 分隔线 --- / *** / ___
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', {
            key: `b${bi++}`,
            style: { border: 'none', borderTop: `1px solid ${BORDER}`, margin: '8px 0' },
          }));
          i += 1;
          continue;
        }

        // ②.8 GFM 表格（表头行 + 分隔行 | --- | --- | + 数据行）
        if (i + 1 < lines.length && line.includes('|')) {
          const aligns = parseTableAligns(lines[i + 1]);
          if (aligns !== null) {
            const headCells = splitTableRow(line);
            const colCount = Math.max(headCells.length, aligns.length);
            i += 2;
            const bodyRows = [];
            while (
              i < lines.length
              && lines[i].trim() !== ''
              && lines[i].includes('|')
              && !/^```/.test(lines[i])
            ) {
              bodyRows.push(splitTableRow(lines[i]));
              i += 1;
            }
            const tKey = bi++;
            const cellStyle = (ci, isHead) => ({
              padding: '4px 8px',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: BORDER,
              textAlign: aligns[ci] || 'left',
              fontWeight: isHead ? 600 : 400,
              background: isHead ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))' : 'transparent',
              verticalAlign: 'top',
              wordBreak: 'break-word',
            });
            blocks.push(h('div', {
              key: `b${tKey}`,
              style: { overflowX: 'auto', margin: '6px 0', maxWidth: '100%' },
            },
              h('table', {
                style: {
                  borderCollapse: 'collapse',
                  width: '100%',
                  fontSize: FS.xs,
                  lineHeight: 1.5,
                },
              },
                h('thead', null,
                  h('tr', null,
                    ...Array.from({ length: colCount }, (_, ci) => h('th', {
                      key: `th-${ci}`,
                      style: cellStyle(ci, true),
                    }, renderInline(headCells[ci] ?? '', `th${tKey}-${ci}`))))),
                bodyRows.length > 0
                  ? h('tbody', null,
                    ...bodyRows.map((r, ri) => h('tr', { key: `tr-${ri}` },
                      ...Array.from({ length: colCount }, (_, ci) => h('td', {
                        key: `td-${ri}-${ci}`,
                        style: cellStyle(ci, false),
                      }, renderInline(r[ci] ?? '', `td${tKey}-${ri}-${ci}`))))))
                  : null)));
            continue;
          }
        }

        // ③ 引用块 >
        if (/^>\s?/.test(line)) {
          const qLines = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            qLines.push(lines[i].replace(/^>\s?/, ''));
            i += 1;
          }
          blocks.push(h('blockquote', { key: `b${bi++}`, style: S.mdQuote },
            ...qLines.map((ql, qi) => h('div', { key: `q${qi}` }, ql ? renderInline(ql, `ql${bi}-${qi}`) : '\u00A0'))));
          continue;
        }

        // ④ 无序列表 - / *
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
            i += 1;
          }
          blocks.push(h('ul', { key: `b${bi++}`, style: S.mdList },
            ...items.map((it, ii) => h('li', { key: `u${ii}`, style: S.mdLi }, renderInline(it, `ul${bi}-${ii}`)))));
          continue;
        }

        // ⑤ 有序列表 1.
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
            i += 1;
          }
          blocks.push(h('ol', { key: `b${bi++}`, style: S.mdList },
            ...items.map((it, ii) => h('li', { key: `o${ii}`, style: S.mdLi }, renderInline(it, `ol${bi}-${ii}`)))));
          continue;
        }

        // ⑥ 空行
        if (line.trim() === '') {
          i += 1;
          continue;
        }

        // ⑦ 普通段落（合并连续非空行，保留换行）
        const pLines = [];
        while (
          i < lines.length
          && lines[i].trim() !== ''
          && !/^```/.test(lines[i])
          && !/^#{1,6}\s+/.test(lines[i])
          && !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[i])
          && !(i + 1 < lines.length && lines[i].includes('|') && parseTableAligns(lines[i + 1]) !== null)
          && !/^>\s?/.test(lines[i])
          && !/^\s*[-*]\s+/.test(lines[i])
          && !/^\s*\d+\.\s+/.test(lines[i])
        ) {
          pLines.push(lines[i]);
          i += 1;
        }
        const pKey = `b${bi++}`;
        blocks.push(h('div', { key: pKey, style: S.mdPara },
          ...pLines.flatMap((pl, pi) => (pi === 0
            ? [h('span', { key: `p${pi}` }, renderInline(pl, `${pKey}-${pi}`))]
            : [h('br', { key: `br${pi}` }), h('span', { key: `p${pi}` }, renderInline(pl, `${pKey}-${pi}`))]))));
      }

      if (blocks.length === 0) return renderHighlightedText(source, query, markStyle);
      return h('div', { style: S.mdRoot }, ...blocks);
    }

    /**
     * 第一个不同的位置（按 UTF-16 码元算，够用且和「第 N 个字」的中文直觉基本吻合）。
     * 一致时返回 -1。
     */
    function firstDiffIndex(a, b) {
      const limit = Math.min(a.length, b.length);
      for (let i = 0; i < limit; i += 1) {
        if (a.charAt(i) !== b.charAt(i)) return i;
      }
      return a.length === b.length ? -1 : limit;
    }

    /* ══════════════════════════ RPC ══════════════════════════ */
    //
    // 契约见 PANEL.md §5：路径 `/verbatim-api/panel.<method>`。
    //   读：GET  + query
    //   写：POST + JSON body（同时把参数镜像到 query，服务端只读 query 也能工作）
    // 这样无论 Host 用哪种取参方式，写操作都不会因为取不到参数而静默失败（E4）。

    const API_PREFIX = `${API}/panel.`;

    function toQuery(params) {
      const usp = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null) continue;
        usp.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      return usp.toString();
    }

    /**
     * 响应信封归一：
     *   - {ok:false} 抛错
     *   - {ok:true, data} / {result} **只有在长得像信封时**才拆包
     *     （`panel.task` 自己就带一个 result 字段，不能把它当信封拆掉）
     *   - 其余原样返回（PANEL §5 的返回值本来就是裸对象）
     */
    function unwrap(body, method) {
      if (body === null || body === undefined) throw new Error(`panel.${method}: 响应是空的`);
      if (typeof body !== 'object') throw new Error(`panel.${method}: 响应不是对象`);
      // **数组是合法的**：PANEL §5 里 panel.flags / panel.timeline / panel.notes
      // 的返回值本身就是数组，不是信封。之前这里一律要求「对象」，
      // 导致这三个接口在界面上报「响应不是对象」（截图可见）。数组直接返回，不走信封拆包。
      if (Array.isArray(body)) return body;
      if (body.ok === false) throw new Error(String(body.error ?? body.message ?? `panel.${method} 失败`));
      // **带 state 的响应不当作错误**（2026-11-18，A3 审计抓到的阻塞 bug）：
      // `panel.task` 失败时返回 `{ state: 'failed', error: '...' }`，没有 ok 字段。
      // 之前这里把它当 RPC 错误抛掉 → applyRebuild 的 catch 误判成「task 接口不存在」
      // → 退回轮询 status → status 永远追不平 → **永远显示「重建中…」，真实错误永远不显示**。
      if (body.ok === undefined && body.state === undefined
        && typeof body.error === 'string' && body.error) throw new Error(body.error);

      const keys = Object.keys(body);
      if (body.ok === true && 'data' in body && keys.length <= 2) return body.data;
      if ('result' in body && (keys.length === 1 || (keys.length === 2 && body.ok === true))) return body.result;
      return body;
    }

    const verbatimListeners = new Set();
    const verbatimBus = {
      emit(type, detail) {
        for (const fn of [...verbatimListeners]) {
          try { fn({ type, detail }); } catch { /* 单个订阅者异常不影响其他 */ }
        }
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        verbatimListeners.add(fn);
        return () => { verbatimListeners.delete(fn); };
      },
    };

    async function callRpc(method, params, mode) {
      const path = `${API_PREFIX}${method}`;
      const write = mode === 'write';
      const query = write ? '' : toQuery(params);
      const url = query ? `${path}?${query}` : path;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
      }, write ? 30000 : 20000);

      let response;
      let text = '';
      try {
        response = await fetch(url, write
          ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params ?? {}),
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          }
          : {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          });
        text = await response.text().catch(() => '');
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`panel.${method} timeout`);
        throw e;
      } finally {
        clearTimeout(timer);
      }

      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        const detail = parsed && (parsed.error ?? parsed.message)
          ? `: ${parsed.error ?? parsed.message}`
          : text
            ? `: ${text.slice(0, 200)}`
            : '';
        const err = new Error(
          response.status === 404
            ? `HTTP 404 (${path})${detail}`
            : `HTTP ${response.status} (panel.${method})${detail}`,
        );
        err.status = response.status;
        if (parsed && typeof parsed.code === 'string') err.code = parsed.code;
        throw err;
      }

      if (parsed === null) throw new Error(`panel.${method}: invalid JSON response`);
      return unwrap(parsed, method);
    }

    const rpcRead = (method, params) => callRpc(method, params, 'read');
    const rpcWrite = (method, params) => callRpc(method, params, 'write');

    /* ══════════════════════════ 响应归一（PANEL §5） ══════════════════════════ */
    //
    // 只做「字段别名」级兼容：契约里的字段名是主路径，
    // 顺带认几个等价写法（msgs/scenes/outOfSurface 之类），避免因为命名小差异
    // 把已经拿到的数据丢掉。**不会凭空编造数字**。

    function normalizeVectorState(raw) {
      const vector = raw && typeof raw.vector === 'object' ? raw.vector : {};
      const state = String(vector.state ?? '').toLowerCase();
      if (state === 'ok' || state === 'normal') return 'ok';
      if (state === 'degraded' || state === 'fallback' || state === 'brute' || state === 'bruteforce') return 'degraded';
      if (state === 'disabled' || state === 'off' || state === 'unset') return 'disabled';
      // 「有 key 但索引空 / 覆盖率低」——语义路实际不会跑，面板不能显示成正常
      if (state === 'empty') return 'empty';
      if (state === 'partial') return 'partial';
      // 2026-11-18：这两种最容易被误报成「正常」
      //   mismatch = 索引模型 ≠ 当前配置（每次查询都会抛 vec:err）
      //   mixed    = 库里混了两套模型的向量（结果无意义）
      if (state === 'mismatch' || state === 'model-mismatch' || state === 'modelmismatch') return 'mismatch';
      if (state === 'mixed' || state === 'inconsistent') return 'mixed';
      // 兼容老响应：只有 hasVec 布尔
      if (typeof raw?.hasVec === 'boolean') return raw.hasVec ? 'ok' : 'degraded';
      if (typeof vector.hasVec === 'boolean') return vector.hasVec ? 'ok' : 'degraded';
      return 'unknown';
    }

    function normalizeStatus(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const st = root.stats && typeof root.stats === 'object' ? root.stats : {};
      const ve = root.vector && typeof root.vector === 'object' ? root.vector : {};
      const en = root.enabled && typeof root.enabled === 'object' ? root.enabled : {};
      const rawRanges = Array.isArray(root.excludeRanges)
        ? root.excludeRanges
        : (root.config && Array.isArray(root.config.excludeRanges) ? root.config.excludeRanges : []);

      return {
        dbExists: typeof root.dbExists === 'boolean' ? root.dbExists : undefined,
        // 缺字段时按 PANEL §3.1 的默认值：两个开关都开。
        // 另外记下「这个字段到底是不是服务端给的」——写操作确认状态时要用（不能自己猜）。
        enabled: {
          record: en.record === undefined ? true : en.record === true,
          tools: en.tools === undefined ? true : en.tools === true,
        },
        enabledKnown: {
          record: typeof en.record === 'boolean',
          tools: typeof en.tools === 'boolean',
        },
        excludeRanges: rawRanges
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            from: pickStr(r.from, r.fromText) ?? '',
            to: pickStr(r.to, r.toText) ?? '',
            reason: pickStr(r.reason) ?? '',
          }))
          .filter((r) => r.from !== '' && r.to !== ''),
        stats: {
          // 这几个数字是面板的「事实陈述」，服务端没给就是 null（界面显示「—」），
          // 绝不用 0 冒充 —— 「其中 0 条不在上下文里」和「不知道」是两回事（D-096）。
          totalMsgs: pickNumOrNull(st.totalMsgs, st.msgs),
          totalChars: pickNumOrNull(st.totalChars, st.chars),
          startAt: pickNumOrNull(st.startAt, st.firstAt),
          compactedMsgs: pickNumOrNull(st.compactedMsgs, st.outOfSurface),
          compactedChars: pickNumOrNull(st.compactedChars, st.outOfSurfaceChars),
          rewindedMsgs: pickNumOrNull(st.rewindedMsgs, st.rewinded),
          excludedMsgs: pickNumOrNull(st.excludedMsgs, st.excluded),
          deletedNotesCount: pickNumOrNull(st.deletedNotesCount, st.deletedNotes),
          sceneCount: pickNumOrNull(st.sceneCount, st.scenes),
          scenesWithGist: pickNumOrNull(st.scenesWithGist),
          llmGistScenes: pickNumOrNull(st.llmGistScenes) ?? 0,
          llmGistRatio: pickNumOrNull(st.llmGistRatio) ?? 0,
          dayCount: pickNumOrNull(st.dayCount),
        },
        llm: root.llm && typeof root.llm === 'object'
          ? {
            ready: root.llm.ready === true,
            enabled: root.llm.enabled === true,
            mode: root.llm.mode === 'local' ? 'local' : 'remote',
            model: pickStr(root.llm.model),
          }
          : { ready: false, enabled: false, mode: 'remote', model: null },
        vector: {
          model: pickStr(ve.model),
          dim: pickNumOrNull(ve.dim),
          indexed: pickNum(ve.indexed) ?? 0,
          total: pickNum(ve.total) ?? 0,
          state: normalizeVectorState(root),
          // 服务端给的降级/未启用说明（B7：要明说，不能假装正常）
          reason: pickStr(ve.reason),

          // ── 索引实体（2026-11-18）───────────────────────────────
          // 白名单之前会**静默吞掉**服务端新加的字段（A1 问题 13），
          // 所以这几个必须显式放行，否则面板永远看不到「混用/不一致」。
          /** 库里全部的模型分组 [{model, dim, count}] —— 混用时有好几组 */
          models: Array.isArray(ve.models)
            ? ve.models
              .filter((m) => m && typeof m.model === 'string')
              .map((m) => ({ model: m.model, dim: pickNumOrNull(m.dim), count: pickNum(m.count) ?? 0 }))
            : [],
          /** 当前配置的模型 {model, dim}；null = 没配 */
          configured: ve.configured && typeof ve.configured === 'object' && typeof ve.configured.model === 'string'
            ? { model: ve.configured.model, dim: pickNumOrNull(ve.configured.dim) }
            : null,
          /** 库里是否只有一种模型 */
          consistent: typeof ve.consistent === 'boolean' ? ve.consistent : null,
          windows: ve.windows && typeof ve.windows === 'object'
            ? {
              total: pickNum(ve.windows.total) ?? 0,
              indexed: pickNum(ve.windows.indexed) ?? 0,
              pending: pickNum(ve.windows.pending) ?? 0,
              kinds: ve.windows.kinds && typeof ve.windows.kinds === 'object'
                ? {
                  window: pickNum(ve.windows.kinds.window) ?? 0,
                  exchange: pickNum(ve.windows.kinds.exchange) ?? 0,
                  thread: pickNum(ve.windows.kinds.thread) ?? 0,
                }
                : null,
            }
            : null,
          /** 库里模型 == 当前配置；null = 无法判断 */
          modelMatch: typeof ve.modelMatch === 'boolean' ? ve.modelMatch : null,
          /** 当前会话待补建的可索引消息条数 */
          pending: pickNumOrNull(ve.pending),
        },
        /** 近期后台任务（用于恢复显示正在运行的索引进度） */
        tasks: Array.isArray(root.tasks) ? root.tasks : [],
        // 服务端主动声明的限制（例如老库的 note 表没有 session_id 列 → 笔记只能全库看）
        warnings: Array.isArray(root.warnings) ? root.warnings.filter((w) => typeof w === 'string' && w) : [],
      };
    }

    function normalizeTimeline(raw) {
      return asArray(raw, 'days').map((day) => ({
        date: String(day?.date ?? ''),
        msgCount: pickNum(day?.msgCount, day?.msgs) ?? 0,
        sceneCount: pickNum(day?.sceneCount, day?.scenes) ?? 0,
        pendingMsgs: pickNum(day?.pendingMsgs) ?? 0,
        chars: pickNum(day?.chars) ?? 0,
        scenes: asArray(day, 'scenes').map((scene) => ({
          id: scene?.id,
          startAt: pickNumOrNull(scene?.startAt),
          endAt: pickNumOrNull(scene?.endAt),
          msgCount: pickNum(scene?.msgCount, scene?.msgs) ?? 0,
          gist: pickStr(scene?.gist),
          gistSource: pickStr(scene?.gistSource),
          locked: scene?.locked === true,
          compacted: scene?.compacted === true,
        })),
      })).filter((day) => day.date !== '');
    }

    /**
     * 场次的「前一场的尾巴」（`scene.lead_in`，D-098/D-100）。
     *
     * 服务端可能是三种形态，一个都不能丢、也不能崩：
     *   - 数组：[{ speaker?, text, at? }]（正常数据）
     *   - 字符串：老数据不是 JSON，服务端原样给出（index.js:917）→ 当成一段背景文字
     *   - 空/坏：[] 
     * PANEL §3.4 要求「和 memory_search 按时间翻返回的一样」，所以这个字段必须渲染出来。
     */
    function normalizeLeadIn(raw) {
      if (Array.isArray(raw)) {
        return raw
          .filter((m) => m && typeof m.text === 'string' && m.text !== '')
          .map((m) => ({
            speaker: m.speaker === 'user' ? 'user' : m.speaker === 'assistant' ? 'assistant' : null,
            text: m.text,
            at: pickNumOrNull(m.at),
          }));
      }
      if (typeof raw === 'string' && raw.trim() !== '') {
        return [{ speaker: null, text: raw, at: null }];
      }
      return [];
    }

    function normalizeSceneDetail(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      return {
        startAt: pickNumOrNull(root.startAt),
        endAt: pickNumOrNull(root.endAt),
        precededBy: pickNumOrNull(root.precededBy),
        followedBy: pickNumOrNull(root.followedBy),
        locked: root.locked === true,
        gist: pickStr(root.gist),
        gistSource: pickStr(root.gistSource),
        msgs: asArray(root, 'msgs').map((m) => ({
          id: m?.id,
          at: pickNumOrNull(m?.at),
          speaker: m?.speaker === 'user' ? 'user' : 'assistant',
          text: String(m?.text ?? ''),
          inSurface: pickNum(m?.inSurface) ?? 1,
          excluded: m?.excluded === 1 || m?.excluded === true,
          media: Array.isArray(m?.media)
            ? m.media
              .filter((md) => md && typeof md.path === 'string' && md.path)
              .map((md) => ({
                id: md.id,
                path: String(md.path),
                width: pickNumOrNull(md.width),
                height: pickNumOrNull(md.height),
                caption: pickStr(md.caption),
              }))
            : [],
        })),
        // 契约 (§5) 里有 leadIn，工具也会渲染它 —— 面板不能当没看见
        leadIn: normalizeLeadIn(root.leadIn),
      };
    }

    function normalizeNote(note) {
      return {
        id: pickNum(note?.id),
        content: String(note?.content ?? ''),
        about: pickStr(note?.about),
        at: pickNumOrNull(note?.at),
      };
    }

    function normalizeFlag(flag) {
      return {
        id: pickNum(flag?.id),
        msgId: pickNum(flag?.msgId),
        reason: pickStr(flag?.reason),
        at: pickNumOrNull(flag?.at),
        snippet: pickStr(flag?.snippet, flag?.text),
      };
    }

    function normalizeSample(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      if (root.id === undefined || root.id === null) return { empty: true };
      const scene = root.scene && typeof root.scene === 'object' ? root.scene : null;
      return {
        empty: false,
        id: pickNum(root.id),
        at: pickNumOrNull(root.at),
        speaker: root.speaker === 'user' ? 'user' : 'assistant',
        text: String(root.text ?? ''),
        scene: scene === null
          ? null
          : {
            startAt: pickNumOrNull(scene.startAt),
            endAt: pickNumOrNull(scene.endAt),
            msgCount: pickNum(scene.msgCount, scene.msgs) ?? 0,
          },
      };
    }

    function normalizeVerify(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const dbText = pickStr(root.dbText, root.db, root.text);
      const logText = pickStr(root.logText, root.log);
      let identical = typeof root.identical === 'boolean' ? root.identical : undefined;
      if (identical === undefined && dbText !== null && logText !== null) identical = dbText === logText;
      return {
        dbText,
        logText,
        identical: identical === true,
        // logText 为 null 时服务端会说清原因（日志轮转/seq 不在日志里），直接用它的原话
        reason: pickStr(root.reason),
      };
    }

    function normalizeSearch(raw) {
      const root = raw && typeof raw === 'object' ? raw : {};
      const sem = root.semantic && typeof root.semantic === 'object' ? root.semantic : {};
      const hits = asArray(root, 'hits').map((hit) => {
        const rawSources = Array.isArray(hit?.sources)
          ? hit.sources
          : (Array.isArray(hit?.routes) ? hit.routes : []);
        const sources = rawSources
          .map((s) => String(s ?? '').toLowerCase())
          .filter(Boolean);
        const sceneObj = hit?.scene && typeof hit.scene === 'object' ? hit.scene : null;
        const rawChunk = hit?.chunk && typeof hit.chunk === 'object' ? hit.chunk : null;
        const rawWindow = hit?.window && typeof hit.window === 'object' ? hit.window : null;
        return {
          id: pickNum(hit?.id, hit?.msgId),
          at: pickNumOrNull(hit?.at),
          speaker: hit?.speaker === 'user' ? 'user' : 'assistant',
          text: String(hit?.text ?? ''),
          sceneId: pickNumOrNull(hit?.sceneId, sceneObj?.id),
          sceneStartAt: pickNumOrNull(hit?.sceneStartAt, sceneObj?.startAt),
          sceneEndAt: pickNumOrNull(hit?.sceneEndAt, sceneObj?.endAt),
          sceneMsgCount: pickNumOrNull(hit?.sceneMsgCount, sceneObj?.msgCount),
          inSurface: pickNum(hit?.inSurface) ?? 1,
          excluded: hit?.excluded === true || hit?.excluded === 1,
          sources,
          score: pickNumOrNull(hit?.score, hit?.similarity, hit?.cosine),
          rerankScore: pickNumOrNull(hit?.rerankScore),
          chunk: rawChunk
            ? {
              idx: pickNum(rawChunk.idx, rawChunk.index, rawChunk.part) ?? 0,
              total: pickNumOrNull(rawChunk.total, rawChunk.count),
              startChar: pickNumOrNull(rawChunk.startChar),
              endChar: pickNumOrNull(rawChunk.endChar),
              text: pickStr(rawChunk.text),
            }
            : null,
          window: rawWindow && typeof rawWindow.text === 'string' && rawWindow.text.trim() !== ''
            ? {
              id: pickNumOrNull(rawWindow.id),
              kind: pickStr(rawWindow.kind),
              startMsgId: pickNumOrNull(rawWindow.startMsgId),
              endMsgId: pickNumOrNull(rawWindow.endMsgId),
              msgCount: pickNum(rawWindow.msgCount) ?? 0,
              text: String(rawWindow.text),
            }
            : null,
          focusExchange: hit?.focusExchange && typeof hit.focusExchange === 'object'
            ? {
              startMsgId: pickNumOrNull(hit.focusExchange.startMsgId),
              endMsgId: pickNumOrNull(hit.focusExchange.endMsgId),
            }
            : null,
          relatedTimeline: Array.isArray(hit?.relatedTimeline)
            ? hit.relatedTimeline
              .filter((rt) => rt && (rt.at != null || rt.sceneId != null))
              .map((rt) => ({ at: pickNumOrNull(rt.at), sceneId: pickNumOrNull(rt.sceneId) }))
            : [],
        };
      });
      const matchedNotes = asArray(root, 'matchedNotes').map((n) => ({
        id: pickNum(n?.id),
        content: String(n?.content ?? ''),
        about: pickStr(n?.about),
        at: pickNumOrNull(n?.at),
        score: pickNumOrNull(n?.score),
        sources: Array.isArray(n?.sources) ? n.sources.map((x) => String(x).toLowerCase()).filter(Boolean) : ['keyword'],
      })).filter((n) => n.id !== undefined && n.content !== '');
      const matchedScenes = asArray(root, 'matchedScenes').map((s) => ({
        id: pickNum(s?.id),
        startAt: pickNumOrNull(s?.startAt),
        endAt: pickNumOrNull(s?.endAt),
        msgCount: pickNum(s?.msgCount) ?? 0,
        gist: String(s?.gist ?? ''),
        sources: Array.isArray(s?.sources) ? s.sources.map((x) => String(x).toLowerCase()).filter(Boolean) : ['keyword'],
        score: pickNumOrNull(s?.score),
      })).filter((s) => s.id !== undefined && s.gist !== '');
      return {
        query: pickStr(root.query) ?? '',
        total: pickNum(root.total) ?? hits.length,
        matchedNotes,
        matchedScenes,
        hits,
        semantic: {
          state: pickStr(sem.state),
          enabled: typeof sem.enabled === 'boolean' ? sem.enabled : (typeof sem.ok === 'boolean' ? sem.ok : undefined),
          used: typeof sem.used === 'boolean' ? sem.used : undefined,
          reranked: sem.reranked === true,
          rerankModel: pickStr(sem.rerankModel),
          rerankError: pickStr(sem.rerankError),
          note: pickStr(sem.note, sem.reason, root.semanticNote),
        },
      };
    }

    function normalizeDeletedNotes(raw) {
      const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const list = Array.isArray(raw)
        ? raw
        : (Array.isArray(root.items) ? root.items : asArray(root, 'notes'));
      const items = list.map((item) => {
        const deletedAt = pickNumOrNull(item?.deletedAt, item?.deleted_at);
        const expiresAt = pickNumOrNull(item?.expiresAt, item?.expires_at)
          ?? (deletedAt !== null ? deletedAt + NOTE_RETENTION_DAYS * DAY_MS : null);
        return {
          id: pickNum(item?.id),
          content: String(item?.content ?? ''),
          about: pickStr(item?.about),
          at: pickNumOrNull(item?.at),
          deletedAt,
          expiresAt,
        };
      });
      return {
        items,
        total: pickNum(root.total) ?? items.length,
      };
    }

    /* ══════════════════════════ 样式（只用 DSH 设计令牌） ══════════════════════════ */

    const BORDER = 'var(--dsw-alias-border-l2, rgba(128,128,128,.25))';
    const BORDER_STRONG = 'var(--dsw-alias-border-l3, rgba(128,128,128,.38))';
    const LABEL1 = 'var(--dsw-alias-label-primary, inherit)';
    const LABEL2 = 'var(--dsw-alias-label-secondary, rgba(128,128,128,.95))';
    const LABEL3 = 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))';
    const LINK = 'var(--dsw-alias-link, var(--dsw-alias-label-primary, inherit))';
    const BRAND = 'var(--dsw-alias-state-business-primary, #4d6bfe)';
    const WARN = 'var(--dsw-alias-state-warn-primary, #c58b00)';
    const WARN_BORDER = 'var(--dsw-alias-state-warn-secondary, rgba(197,139,0,.55))';
    const SUCCESS = 'var(--dsw-alias-state-success-primary, #1a9e5d)';
    const ERROR = 'var(--dsw-alias-state-error-primary, #c0392b)';
    const RADIUS = 'var(--dsw-radius-lg, 10px)';
    const RADIUS_SM = 'var(--dsw-radius-sm, 6px)';
    const CODE_FONT = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)';

    /* ── 排版与间距尺度（2026-11-18 统一） ──
     *
     * 改之前：字号 11 档（10/10.5/11/11.5/12/12.5/13/13.5/14/18/22），
     * padding 33 种 —— 视觉上没有节奏，读起来"哪里都差一点"。
     * 现在收敛成 6 档字号 + 4 档间距，所有新样式只能从这里取。
     */
    const FS = {
      xs: 10.5,      // 辅助信息：日期、单位、极次要说明
      sm: 11.5,      // 次要：行内说明、标签、表格值
      base: 12.5,    // 正文
      md: 13.5,      // 小标题、强调正文
      lg: 18,        // 页面标题
      display: 26,   // 核心数字（一个面板只该有一个）
    };
    /** 统一过渡：所有交互态都走这个，保证手感一致 */
    const T = 'background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease';

    /**
     * 注入一段全局 CSS（带 id 去重，重复调用只更新内容）。
     *
     * 返回清理函数 —— 插件卸载时把 <style> 移掉，不留垃圾。
     * 只在模块里用一次（交互态样式表），别拿它做组件的动态样式。
     */
    function injectStyle(id, css) {
      if (typeof document === 'undefined') return () => {};
      let el = document.getElementById(id);
      if (el === null) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
      return () => {
        try { el.remove(); } catch { /* 已经被移除 */ }
      };
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        fontSize: FS.md,
        lineHeight: 1.5,
        color: LABEL1,
        fontFamily: 'inherit',
      },
      head: {
        flex: '0 0 auto',
        padding: '12px 14px 8px',
        background: `linear-gradient(180deg, color-mix(in srgb, ${BRAND} 4%, transparent), transparent)`,
        borderBottom: `1px solid ${BORDER}`,
      },
      titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 },
      title: { fontSize: FS.md, fontWeight: 600, lineHeight: '20px', letterSpacing: 0.1 },
      statusPill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: FS.xs,
        fontWeight: 500,
        lineHeight: '16px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        border: `1px solid ${BORDER}`,
        color: LABEL2,
        flex: '0 0 auto',
      },
      sessionName: {
        fontSize: FS.sm,
        lineHeight: '16px',
        color: LABEL3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 220,
      },
      swRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0' },
      swLabel: { fontSize: FS.base },
      hint: { margin: '2px 0 0', fontSize: FS.sm, lineHeight: '16px', color: LABEL3 },
      warnHint: { margin: '2px 0 0', fontSize: FS.sm, lineHeight: '16px', color: WARN },
      statLine: { marginTop: 10, fontSize: FS.base, color: LABEL2, wordBreak: 'break-word' },
      card: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '10px 12px',
        marginTop: 8,
      },
      statusDot: {
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        flex: '0 0 auto',
      },
      switchCard: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '7px 12px',
      },
      kpiGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 7,
        marginTop: 8,
      },
      kpiTile: {
        appearance: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        textAlign: 'left',
        boxSizing: 'border-box',
        minWidth: 0,
        padding: '9px 10px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04))',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        color: LABEL1,
        font: 'inherit',
        cursor: 'pointer',
      },
      kpiLabel: { fontSize: FS.xs, color: LABEL3, lineHeight: '15px' },
      kpiVal: {
        fontSize: FS.md,
        fontWeight: 600,
        color: LABEL1,
        lineHeight: '20px',
        marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
      },
      kpiSub: {
        fontSize: FS.xs,
        color: LABEL3,
        lineHeight: '14px',
        marginTop: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      },
      sparkCard: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '9px 11px 7px',
      },
      // 核心数字：整个面板唯一允许用 display 字号的地方。
      // 之前这个数字既出现在句子里又单独大字显示一遍 —— 视觉上在重复同一件事。
      coreRow: {
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '2px 6px',
        marginTop: 2,
        marginBottom: 2,
      },
      coreLabel: { fontSize: FS.base, color: LABEL2 },
      coreCard: {
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `color-mix(in srgb, ${BRAND} 24%, ${BORDER})`,
        borderRadius: 14,
        background: `radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, #e07a96 10%, transparent) 0%, transparent 60%), linear-gradient(135deg, color-mix(in srgb, ${BRAND} 10%, transparent), color-mix(in srgb, ${BRAND} 3%, transparent))`,
        padding: '13px 14px',
        marginTop: 6,
      },
      coreNum: {
        fontSize: FS.display,
        fontWeight: 600,
        lineHeight: '30px',
        letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums',
      },
      coreHint: { fontSize: FS.sm, color: LABEL2, marginTop: 3, lineHeight: 1.45 },
      rewindLine: { marginTop: 6, fontSize: FS.sm, color: LABEL3 },
      rewindHint: { fontSize: FS.sm, color: LABEL3 },
      indexBox: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        padding: '10px 12px',
        marginTop: 4,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
      },
      advToggleBtn: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '6px 0 2px',
        marginTop: 8,
        border: 0,
        borderTop: `1px dashed ${BORDER}`,
        background: 'transparent',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.xs,
        cursor: 'pointer',
      },
      indexRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      indexLabel: { fontSize: FS.sm, color: LABEL3, flex: '0 0 auto' },
      indexValue: { fontSize: FS.sm, color: LABEL1, textAlign: 'right', wordBreak: 'break-word', minWidth: 0 },
      indexStateOk: { fontSize: FS.sm, color: SUCCESS },
      indexStateWarn: { fontSize: FS.sm, color: WARN },
      indexStateOff: { fontSize: FS.sm, color: LABEL2 },
      progressTrack: {
        height: 5,
        marginTop: 6,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.25))',
        overflow: 'hidden',
      },
      // 不确定进度：一条来回跑的短条（准备/同步阶段）
      progressPulse: {
        width: '32%',
        height: '100%',
        background: BRAND,
        borderRadius: 999,
        animation: 'dvp-run 1.15s ease-in-out infinite',
      },
      // 确定百分比进度条
      progressFill: {
        height: '100%',
        background: BRAND,
        borderRadius: 999,
        transition: 'width .25s ease',
      },
      tabbar: {
        flex: '0 0 auto',
        display: 'flex',
        gap: 3,
        padding: '6px 8px',
        borderBottom: `1px solid ${BORDER}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      tab: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        flex: '1 1 0',
        minWidth: 0,
        padding: '5px 4px',
        border: 0,
        borderRadius: 999,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'center',
      },
      tabActive: {
        color: BRAND,
        fontWeight: 600,
        background: `color-mix(in srgb, ${BRAND} 12%, transparent)`,
      },
      tabBadge: {
        display: 'inline-block',
        marginLeft: 3,
        padding: '0 4px',
        borderRadius: 999,
        background: 'color-mix(in srgb, ' + WARN + ' 22%, transparent)',
        color: WARN,
        fontSize: FS.xs,
        lineHeight: '14px',
      },
      body: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '8px 12px 18px',
      },
      backTopBtn: {
        appearance: 'none',
        position: 'sticky',
        bottom: 10,
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER_STRONG,
        background: 'var(--dsw-alias-bg-base, var(--dsw-alias-card-fill, Canvas))',
        color: LABEL2,
        boxShadow: '0 2px 8px rgba(0,0,0,.12)',
        cursor: 'pointer',
        fontSize: FS.sm,
        zIndex: 5,
      },
      // 概览页的分区：每块一个标题 + 内容，中间留白
      section: { marginBottom: 16 },
      sectionTitle: {
        fontSize: FS.sm,
        fontWeight: 600,
        color: LABEL3,
        letterSpacing: '.02em',
        marginBottom: 6,
      },
      // 最近活跃度的小柱状图
      sparkRow: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 42 },
      sparkCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 0', minWidth: 0 },
      sparkBar: {
        width: '100%',
        maxWidth: 22,
        borderRadius: 2,
        background: 'color-mix(in srgb, ' + BRAND + ' 70%, transparent)',
        transition: 'height .2s ease',
      },
      sparkLabel: { marginTop: 4, fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      dim: { fontSize: FS.sm, color: LABEL3 },
      emptyCard: {
        boxSizing: 'border-box',
        border: `1px dashed color-mix(in srgb, ${BRAND} 30%, transparent)`,
        borderRadius: RADIUS,
        padding: '14px 14px',
        marginTop: 4,
        background: `color-mix(in srgb, ${BRAND} 3%, transparent)`,
        color: LABEL2,
        fontSize: FS.base,
        lineHeight: 1.65,
        wordBreak: 'break-word',
      },
      errorCard: {
        boxSizing: 'border-box',
        border: `1px solid ${ERROR}`,
        borderRadius: RADIUS,
        padding: '8px 10px',
        marginTop: 6,
        color: ERROR,
        fontSize: FS.base,
        wordBreak: 'break-word',
      },
      errDetail: { marginTop: 2, fontSize: FS.sm, color: LABEL3, wordBreak: 'break-word' },
      btn: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flex: '0 0 auto',
        padding: '4px 11px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER_STRONG,
        borderRadius: 999,
        background: 'var(--dsw-alias-card-fill, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primaryBtn: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flex: '0 0 auto',
        padding: '4px 12px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'transparent',
        borderRadius: 999,
        background: BRAND,
        color: '#fff',
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        boxShadow: `0 1px 4px color-mix(in srgb, ${BRAND} 28%, transparent)`,
      },
      linkBtn: {
        appearance: 'none',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: LINK,
        font: 'inherit',
        fontSize: FS.sm,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      dayRow: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 2px',
        border: 0,
        borderBottom: `1px solid ${BORDER}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      dayDate: { flex: '0 0 auto', fontSize: FS.base, fontWeight: 600, color: LABEL1, fontVariantNumeric: 'tabular-nums' },
      // ── 时间轴视觉（2026-11-18）──
      // 它叫「时间轴」，之前却是个普通列表 —— 没有轴。现在是：
      //   11-18 ──────  425 条 / 10 场
      //   │
      //   ● 00:20–01:34   共 51 条
      //   ● 01:40–02:06   共 40 条
      // 竖线 + 节点就是「轴」，一眼看得出这是按时间排的。
      sceneList: {
        position: 'relative',
        paddingLeft: 14,
        marginLeft: 5,
      },
      sceneItem: { position: 'relative' },
      // 节点：钉在书签细线上的微光墨点
      sceneDot: {
        position: 'absolute',
        left: -17,
        top: 11,
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-base, var(--dsw-alias-card-fill, Canvas))',
        borderWidth: 1.5,
        borderStyle: 'solid',
        borderColor: `color-mix(in srgb, ${BRAND} 45%, transparent)`,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      },
      // 展开中的那一场：青黛墨点 + 柔和晕圈
      sceneDotOn: {
        borderColor: BRAND,
        background: BRAND,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${BRAND} 22%, transparent)`,
      },
      dayCaret: {
        flex: '0 0 auto',
        width: 10,
        fontSize: FS.xs,
        color: LABEL3,
        transition: 'transform .15s ease',
        transformOrigin: 'center',
      },
      dayDash: {
        flex: '1 1 auto',
        minWidth: 8,
        height: 0,
        borderTop: `1px dashed ${BORDER_STRONG}`,
        opacity: 0.7,
      },
      dayMeta: { flex: '0 0 auto', fontSize: FS.sm, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      sceneRow: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: 0,
        borderRadius: 10,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        textAlign: 'left',
        cursor: 'pointer',
      },
      sceneTime: { flex: '1 1 auto', minWidth: 0, fontSize: FS.sm, fontWeight: 500, color: LABEL1, fontVariantNumeric: 'tabular-nums' },
      sceneMeta: { flex: '0 0 auto', color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      tag: {
        flex: '0 0 auto',
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${BRAND} 35%, ${BORDER})`,
        color: BRAND,
        fontSize: FS.xs,
        lineHeight: '14px',
      },
      msgRow: {
        padding: '10px 13px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 12,
        marginBottom: 8,
        boxShadow: '0 1px 2px rgba(0,0,0,.025)',
      },
      // 「前一场的尾巴」：背景补充，颜色压暗 + 虚线左边，和本场原文区分开（D-098 不做推断）
      leadInBox: {
        margin: '2px 0 6px',
        padding: '5px 8px',
        borderLeft: `2px dashed ${BORDER_STRONG}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        borderRadius: RADIUS_SM,
      },
      leadInRow: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '2px 0' },
      leadInSpeaker: { flex: '0 0 auto', fontSize: FS.xs, color: LABEL3, fontWeight: 600, lineHeight: '20px' },
      leadInText: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: FS.base,
        lineHeight: 1.5,
        color: LABEL2,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflowY: 'auto',
        paddingRight: 4,
      },
      msgHead: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
      msgTime: { fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      msgSpeaker: { fontSize: FS.sm, fontWeight: 600 },
      msgText: {
        marginTop: 2,
        fontSize: FS.base,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflowY: 'auto',
        paddingRight: 4,
      },
      /* ── Markdown 渲染样式 ── */
      mdRoot: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      mdPara: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      mdH1: { fontSize: FS.md, fontWeight: 700, lineHeight: 1.4, margin: '2px 0 1px' },
      mdH2: { fontSize: FS.base, fontWeight: 700, lineHeight: 1.4, margin: '2px 0 1px' },
      mdH3: { fontSize: FS.base, fontWeight: 600, lineHeight: 1.4, margin: '1px 0' },
      mdInlineCode: {
        fontFamily: CODE_FONT,
        fontSize: '0.92em',
        padding: '0 4px',
        borderRadius: 3,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))',
        wordBreak: 'break-all',
      },
      mdCodeWrap: {
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        overflow: 'hidden',
      },
      mdCodeLang: {
        fontSize: FS.xs,
        fontFamily: CODE_FONT,
        color: LABEL3,
        padding: '2px 7px',
        borderBottom: `1px solid ${BORDER}`,
      },
      mdPre: {
        margin: 0,
        padding: '6px 8px',
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.45,
        overflowX: 'auto',
        whiteSpace: 'pre',
      },
      mdQuote: {
        margin: 0,
        padding: '2px 0 2px 8px',
        borderLeft: `2px solid ${BORDER_STRONG}`,
        color: LABEL2,
      },
      mdList: { margin: 0, paddingLeft: 16 },
      mdLi: { margin: '1px 0', wordBreak: 'break-word' },
      mdLink: { color: LINK, textDecoration: 'underline', wordBreak: 'break-all' },
      noteCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: '10px 12px',
        marginTop: 8,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
      },
      rowBetween: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      input: {
        boxSizing: 'border-box',
        flex: '1 1 auto',
        minWidth: 0,
        padding: '4px 7px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.base,
        lineHeight: '18px',
      },
      formRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
      paneWrap: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8, marginTop: 6 },
      pane: {
        boxSizing: 'border-box',
        minWidth: 0,
        padding: '6px 7px',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        fontSize: FS.base,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      paneLabel: { fontSize: FS.xs, color: LABEL3, marginBottom: 2 },
      diffMark: {
        background: `color-mix(in srgb, ${ERROR} 20%, transparent)`,
        color: 'inherit',
        borderRadius: 2,
        padding: '0 1px',
      },
      flashOk: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid color-mix(in srgb, ${SUCCESS} 45%, transparent)`,
        background: `color-mix(in srgb, ${SUCCESS} 10%, transparent)`,
        color: SUCCESS,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      flashErr: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid color-mix(in srgb, ${ERROR} 45%, transparent)`,
        background: `color-mix(in srgb, ${ERROR} 10%, transparent)`,
        color: ERROR,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      // 「写成功但状态没确认」：既不能说成功，也不能说失败
      flashWarn: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid ${WARN_BORDER}`,
        background: `color-mix(in srgb, ${WARN} 10%, transparent)`,
        color: WARN,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      flagCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        padding: '7px 9px',
        marginTop: 6,
      },
      snippet: { fontSize: FS.base, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' },
      /* ── 搜索页 & 通用交互组件样式 ── */
      searchBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
      },
      searchInputWrap: {
        position: 'relative',
        flex: '1 1 auto',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        boxShadow: '0 1px 4px rgba(0,0,0,.04)',
        padding: '2px 10px 2px 12px',
        transition: T,
      },
      searchIcon: {
        flex: '0 0 auto',
        color: LABEL3,
        marginRight: 6,
        display: 'flex',
        alignItems: 'center',
      },
      searchInput: {
        boxSizing: 'border-box',
        flex: '1 1 auto',
        minWidth: 0,
        border: 0,
        outline: 'none',
        background: 'transparent',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.base,
        lineHeight: '20px',
        padding: '4px 0',
      },
      clearBtn: {
        appearance: 'none',
        flex: '0 0 auto',
        border: 0,
        background: 'transparent',
        color: LABEL3,
        fontSize: FS.md,
        lineHeight: 1,
        padding: '2px 4px',
        cursor: 'pointer',
        borderRadius: RADIUS_SM,
      },
      pillRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        flexWrap: 'wrap',
        marginBottom: 8,
      },
      pillGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'wrap',
      },
      pill: {
        appearance: 'none',
        padding: '3px 10px',
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.xs,
        fontWeight: 500,
        lineHeight: '16px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      pillActive: {
        borderColor: BRAND,
        background: `color-mix(in srgb, ${BRAND} 13%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      checkLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: FS.xs,
        color: LABEL2,
        cursor: 'pointer',
        userSelect: 'none',
      },
      searchSummary: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 6,
        fontSize: FS.sm,
        color: LABEL3,
      },
      searchCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderLeftWidth: 3,
        borderRadius: RADIUS,
        padding: '8px 10px',
        marginTop: 8,
        background: 'var(--dsw-alias-card-fill, transparent)',
      },
      searchMetaRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
      },
      searchMetaLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        minWidth: 0,
      },
      sourceBadgeKw: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid ${BORDER_STRONG}`,
        color: LABEL2,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      sourceBadgeVec: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${BRAND} 45%, transparent)`,
        background: `color-mix(in srgb, ${BRAND} 10%, transparent)`,
        color: BRAND,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      sourceBadgeBoth: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${SUCCESS} 45%, transparent)`,
        background: `color-mix(in srgb, ${SUCCESS} 10%, transparent)`,
        color: SUCCESS,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      searchMark: {
        background: `color-mix(in srgb, ${WARN} 28%, transparent)`,
        color: 'inherit',
        borderRadius: 2,
        padding: '0 1px',
      },
      chunkBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginTop: 4,
        fontSize: FS.xs,
        color: LABEL3,
      },
      copyBtn: {
        appearance: 'none',
        flex: '0 0 auto',
        padding: '1px 6px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: RADIUS_SM,
        background: 'transparent',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.xs,
        lineHeight: '15px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      copyBtnDone: {
        borderColor: `color-mix(in srgb, ${SUCCESS} 50%, transparent)`,
        color: SUCCESS,
      },
      searchFooter: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 6,
        flexWrap: 'wrap',
      },
      searchEntryBtn: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 13px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.sm,
        cursor: 'pointer',
        textAlign: 'left',
      },
      /* ── 笔记分段开关 & 回收站 ── */
      segmented: {
        display: 'inline-flex',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        overflow: 'hidden',
        marginBottom: 8,
      },
      segBtn: {
        appearance: 'none',
        padding: '4px 10px',
        border: 0,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 400,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      /* ── 数据库管理台 ── */
      dbSelect: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '4px 7px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.sm,
        lineHeight: '18px',
      },
      dbChipRow: {
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
        marginTop: 6,
      },
      dbChip: {
        appearance: 'none',
        padding: '2px 7px',
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.xs,
        fontWeight: 400,
        lineHeight: '16px',
        cursor: 'pointer',
      },
      dbChipOn: {
        borderColor: BRAND,
        background: `color-mix(in srgb, ${BRAND} 12%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      dbRowCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        padding: '6px 8px',
        marginTop: 6,
        background: 'var(--dsw-alias-card-fill, transparent)',
      },
      dbDetailPre: {
        margin: '6px 0 0',
        padding: '6px 7px',
        borderRadius: RADIUS_SM,
        border: `1px solid ${BORDER}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      dbSqlArea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 74,
        padding: '6px 8px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.5,
        resize: 'vertical',
      },
      dbTableWrap: {
        marginTop: 8,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        overflowX: 'auto',
        maxHeight: 280,
        overflowY: 'auto',
      },
      dbTable: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: FS.xs,
        fontFamily: CODE_FONT,
      },
      dbTh: {
        textAlign: 'left',
        padding: '4px 6px',
        borderBottom: `1px solid ${BORDER_STRONG}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL2,
        whiteSpace: 'nowrap',
        position: 'sticky',
        top: 0,
      },
      dbTd: {
        padding: '4px 6px',
        borderBottom: `1px solid ${BORDER}`,
        color: LABEL1,
        verticalAlign: 'top',
        maxWidth: 220,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      segBtnActive: {
        background: `color-mix(in srgb, ${BRAND} 14%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      trashMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        fontSize: FS.xs,
        color: LABEL3,
      },
      /* ── 隐私排除时段 ── */
      excludeCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        background: 'var(--dsw-alias-card-fill, transparent)',
        padding: '8px 10px',
      },
      excludeItem: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 0',
        borderBottom: `1px solid ${BORDER}`,
      },
      excludeRangeText: {
        fontFamily: CODE_FONT,
        fontSize: FS.sm,
        color: LABEL1,
      },
      excludeForm: {
        marginTop: 8,
        paddingTop: 8,
        borderTop: `1px dashed ${BORDER_STRONG}`,
      },
      dateGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        gap: 6,
        marginTop: 4,
      },
      fieldLabel: {
        fontSize: FS.xs,
        color: LABEL3,
        marginBottom: 2,
      },
      /* ── 骨架屏 ── */
      skeletonCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        padding: '10px 10px',
        marginTop: 8,
      },
      skeletonBar: {
        height: 10,
        borderRadius: 4,
      },
    };

    /* ══════════════════════════ 小部件 ══════════════════════════ */

    function Glyph({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'currentColor', opacity: 0.2 }),
        h('rect', { x: 6, y: 8, width: 12, height: 1.8, rx: 0.9, fill: 'currentColor' }),
        h('rect', { x: 6, y: 11.5, width: 9, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.72 }),
        h('rect', { x: 6, y: 15, width: 11, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.5 }),
      );
    }

    function SearchIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('line', { x1: 20, y1: 20, x2: 16.5, y2: 16.5 }),
      );
    }

    function SparkIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z' }),
      );
    }

    function MomentIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('polyline', { points: '12 7 12 12 15 14' }),
      );
    }

    function NoteIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }),
      );
    }

    function RefreshIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('polyline', { points: '23 4 23 10 17 10' }),
        h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
      );
    }

    function MicIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
      );
    }

    function BrainIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 5.9L15 18H9l-.7-3.1A7 7 0 0 1 12 2z' }),
        h('line', { x1: 9.5, y1: 21, x2: 14.5, y2: 21 }),
      );
    }

    function RingProgress({ pct = 0, size = 38, stroke = 3.5, color = BRAND }) {
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - clamped / 100);
      return h('div', {
        style: {
          position: 'relative',
          width: size,
          height: size,
          flex: '0 0 auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
        h('svg', {
          width: size,
          height: size,
          viewBox: `0 0 ${size} ${size}`,
          style: { transform: 'rotate(-90deg)', display: 'block' },
          'aria-hidden': true,
        },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2))',
            strokeWidth: stroke,
          }),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: color,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: c,
            strokeDashoffset: offset,
            style: { transition: 'stroke-dashoffset .4s ease, stroke .2s ease' },
          })),
        h('span', {
          style: {
            position: 'absolute',
            fontSize: 9.5,
            fontWeight: 600,
            color: LABEL1,
            fontVariantNumeric: 'tabular-nums',
          },
        }, `${clamped}%`));
    }

    function SanctuaryArt() {
      return h('svg', {
        viewBox: '0 0 120 80',
        width: 96,
        height: 64,
        'aria-hidden': true,
        style: {
          position: 'absolute',
          right: -6,
          top: -4,
          opacity: 0.16,
          pointerEvents: 'none',
        },
      },
        h('circle', { cx: 88, cy: 26, r: 22, fill: BRAND }),
        h('circle', { cx: 64, cy: 48, r: 14, fill: '#e07a96' }),
        h('path', {
          d: 'M88 10l2.8 7.2L98 20l-7.2 2.8L88 30l-2.8-7.2L78 20l7.2-2.8z',
          fill: '#fff',
        }),
      );
    }

    function SkeletonGroup({ kind = 'cards', count = 3 }) {
      if (kind === 'rows') {
        return h('div', { 'aria-hidden': true },
          ...Array.from({ length: count }, (_, i) => h('div', {
            key: `sk-r-${i}`,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px', borderBottom: `1px solid ${BORDER}` },
          },
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: 42 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, flex: '1 1 auto', height: 6 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: 78 } }))));
      }
      if (kind === 'lines') {
        return h('div', { 'aria-hidden': true, style: { padding: '4px 0 6px' } },
          ...Array.from({ length: count }, (_, i) => h('div', {
            key: `sk-l-${i}`,
            style: { padding: '5px 0 5px 8px', borderLeft: `2px solid ${BORDER}`, marginBottom: 4 },
          },
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '32%', height: 8 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: i % 2 === 0 ? '88%' : '72%', marginTop: 6 } }))));
      }
      return h('div', { 'aria-hidden': true },
        ...Array.from({ length: count }, (_, i) => h('div', { key: `sk-c-${i}`, style: S.skeletonCard },
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '44%', height: 9 } }),
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '92%', marginTop: 8 } }),
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: i % 2 === 0 ? '68%' : '78%', marginTop: 6 } }))));
    }

    /** 开关：只有「开 / 关」两态，没有第三态（D-166 / B2） */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        onClick: () => {
          if (!disabled) onChange(!checked);
        },
        style: {
          appearance: 'none',
          position: 'relative',
          flex: '0 0 auto',
          width: 34,
          height: 20,
          padding: 0,
          border: `1px solid ${checked ? 'transparent' : BORDER_STRONG}`,
          borderRadius: 999,
          background: checked ? BRAND : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.22))',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'background-color 120ms ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--dsw-alias-switch-thumb, #fff)',
          boxShadow: '0 1px 2px rgba(0,0,0,.28)',
          transition: 'left 120ms ease',
        },
      }));
    }

    /** 会话名（PANEL §2 标题里的「当前对话名」）。拿不到就不占位。 */
    function SessionTitle({ useSessions, sessionId }) {
      const name = useSessions((snapshot) => {
        const record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
        if (!record) return null;
        return record.displayTitle ?? record.title ?? record.name ?? null;
      });
      if (typeof name !== 'string' || name === '') return null;
      return h('div', { style: S.sessionName, title: name }, name);
    }

    const noopSessionHook = () => null;

    /** 内联会话名（用于库管理里的跨会话列表，优先展示真实标题，兜底短 sessionId） */
    function SessionInlineName({ useSessions, sessionId }) {
      const hook = typeof useSessions === 'function' ? useSessions : noopSessionHook;
      const name = hook((snapshot) => {
        const record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
        if (!record) return null;
        return record.displayTitle ?? record.title ?? record.name ?? null;
      });
      const label = typeof name === 'string' && name.trim() ? name.trim() : shortSid(sessionId);
      return h('span', { title: `${label} (${sessionId})` }, label);
    }

    /** 分栏显示一段原文；从第一个差异处开始标红 */
    function TextPane({ label, text, markAt }) {
      const value = typeof text === 'string' ? text : '';
      return h('div', { style: { minWidth: 0 } },
        h('div', { style: S.paneLabel }, label),
        h('div', { style: S.pane },
          markAt >= 0 && markAt < value.length
            ? [
              h('span', { key: 'same' }, value.slice(0, markAt)),
              h('mark', { key: 'diff', style: S.diffMark }, value.slice(markAt)),
            ]
            : value === ''
              ? h('span', { style: S.dim }, '—')
              : value));
    }

    /**
     * 「库」标签页独立视图组件 —— 负责全库总览、数据浏览（支持 kind/向量筛选与详情检视）与只读 SQL。
     */
    function DbTabView(props) {
      const {
        t,
        locale,
        sessionId,
        useSessions,
        dbSubTab,
        setDbSubTab,
        dbOverview,
        dbOverviewBusy,
        dbSession,
        setDbSession,
        dbTable,
        setDbTable,
        dbWindowKind,
        setDbWindowKind,
        dbVecFilter,
        setDbVecFilter,
        dbFilter,
        setDbFilter,
        dbPage,
        setDbPage,
        dbPageInput,
        setDbPageInput,
        dbRowsData,
        dbRowsBusy,
        dbExpandedRow,
        setDbExpandedRow,
        dbTask,
        dbActionBusy,
        dbSql,
        setDbSql,
        dbSqlBusy,
        dbSqlRes,
        dbSqlErr,
        copiedKey,
        handleCopy,
        loadDbOverview,
        loadDbRows,
        runDbMaintain,
        triggerDbSessionIndex,
        runDbSql,
        jumpToTimeline,
        setTab,
      } = props;

      const rawSessions = dbOverview && Array.isArray(dbOverview.sessions) ? dbOverview.sessions : [];
      const [dbMediaPreviews, setDbMediaPreviews] = useState({});
      const [captionDrafts, setCaptionDrafts] = useState({});
      const [captionBusyId, setCaptionBusyId] = useState(null);
      const [confirmDeleteSid, setConfirmDeleteSid] = useState(null);
      const mounted = useRef(true);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

      const toggleDbMediaPreview = async (mediaId) => {
        const key = String(mediaId);
        if (dbMediaPreviews[key]) {
          setDbMediaPreviews((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          return;
        }
        setDbMediaPreviews((prev) => ({ ...prev, [key]: { loading: true } }));
        try {
          const res = await rpcRead('mediaPreview', { id: mediaId });
          if (!mounted.current) return;
          setDbMediaPreviews((prev) => ({ ...prev, [key]: res }));
        } catch (e) {
          if (!mounted.current) return;
          setDbMediaPreviews((prev) => ({ ...prev, [key]: { ok: false, reason: msgOf(e) } }));
        }
      };

      const saveMediaCaption = async (mediaId, fallbackCaption = '') => {
        const key = String(mediaId);
        const text = typeof captionDrafts[key] === 'string' ? captionDrafts[key] : String(fallbackCaption ?? '');
        setCaptionBusyId(mediaId);
        try {
          await rpcWrite('setMediaCaption', { id: mediaId, caption: text });
          if (!mounted.current) return;
          await loadDbRows();
        } catch (e) {
          if (mounted.current) {
            setDbMediaPreviews((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ok: false, reason: msgOf(e) } }));
          }
        } finally {
          if (mounted.current) setCaptionBusyId(null);
        }
      };
      const sessions = sessionId
        ? [
          ...rawSessions.filter((s) => s.sessionId === sessionId),
          ...rawSessions.filter((s) => s.sessionId !== sessionId),
        ]
        : rawSessions;

      const renderTaskBanner = () => {
        if (!dbTask) return null;
        if (dbTask.phase === 'running') {
          const prog = dbTask.progress;
          const hasRatio = prog && typeof prog.total === 'number' && prog.total > 0;
          const pctVal = hasRatio
            ? (typeof prog.pct === 'number' ? prog.pct : Math.min(100, Math.round((prog.done / prog.total) * 100)))
            : null;
          return h('div', { style: { ...S.card, marginTop: 0, marginBottom: 8 } },
            h('div', { style: { ...S.rowBetween, alignItems: 'center' } },
              h('span', { style: S.hint }, `${shortSid(dbTask.sessionId)} · ${(prog && prog.label) || t('index.syncRunning')}`),
              hasRatio
                ? h('span', { style: { ...S.hint, fontVariantNumeric: 'tabular-nums', color: LABEL2 } },
                  `${fmtNum(prog.done, locale)} / ${fmtNum(prog.total, locale)} (${pctVal}%)`)
                : null),
            h('div', { style: S.progressTrack },
              hasRatio
                ? h('div', { style: { ...S.progressFill, width: `${pctVal}%` } })
                : h('div', { className: 'dvp-running', style: S.progressPulse })));
        }
        if (dbTask.phase === 'done') {
          return h('div', { style: { ...S.flashOk, marginBottom: 8 } },
            `${shortSid(dbTask.sessionId)} · ${t('index.syncDone')} ${dbTask.detail}`);
        }
        return h('div', { style: { ...S.flashErr, marginBottom: 8 } },
          `${shortSid(dbTask.sessionId)} · ${t('index.rebuildFail', { err: dbTask.error ?? '—' })}`);
      };

      const renderSessionsView = () => {
        if (dbOverviewBusy && dbOverview === null) {
          return h(SkeletonGroup, { kind: 'cards', count: 3 });
        }
        if (dbOverview === null) return null;
        const tot = dbOverview.totals || {};
        const health = Array.isArray(dbOverview.health) ? dbOverview.health : [];
        const totalSize = (dbOverview.dbBytes || 0) + (dbOverview.walBytes || 0);
        const pathCopied = copiedKey === 'db:path';

        return h('div', null,
          renderTaskBanner(),
          // ① 4 格全库摘要条
          h('div', { style: { ...S.kpiGrid, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginBottom: 8 } },
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.size')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                dbOverview.isMemory ? ':memory:' : fmtBytes(totalSize))),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.schema')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                `v${dbOverview.schemaVersion ?? '?'} · ${dbOverview.hasVec ? 'vec0' : 'JS'}`)),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.sessionsHeading', { n: fmtNum(tot.sessions ?? sessions.length, locale) })),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md } },
                fmtNum(tot.msgs ?? 0, locale))),
            h('div', { style: S.kpiTile },
              h('div', { style: S.kpiLabel }, t('db.vecNo')),
              h('div', { style: { ...S.kpiVal, fontSize: FS.md, color: (tot.pendingMsgs ?? 0) > 0 ? WARN : SUCCESS } },
                fmtNum(tot.pendingMsgs ?? 0, locale)))),

          // 路径与维护操作条
          h('div', { style: { ...S.card, marginTop: 0, padding: '8px 10px' } },
            !dbOverview.isMemory && dbOverview.dbPath
              ? h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 8, marginBottom: 6 } },
                h('span', {
                  style: { ...S.hint, fontFamily: CODE_FONT, fontSize: FS.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 auto' },
                  title: dbOverview.dbPath,
                }, dbOverview.dbPath),
                h('button', {
                  type: 'button',
                  style: pathCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                  onClick: () => { void handleCopy('db:path', dbOverview.dbPath); },
                }, pathCopied ? t('common.copied') : t('common.copy')))
              : null,
            health.length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 } },
                ...health.map((item, idx) => h('div', {
                  key: String(idx),
                  style: item.kind === 'warn' ? S.warnHint : S.hint,
                }, `${item.kind === 'warn' ? '⚠ ' : ''}${item.text}`)))
              : null,
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: dbActionBusy !== '',
                onClick: () => { void runDbMaintain('backup'); },
              }, t('db.backup')),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: dbActionBusy !== '',
                onClick: () => { void runDbMaintain('vacuum'); },
              }, t('db.vacuum')),
              (tot.deletedNotes ?? 0) > 0
                ? h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: dbActionBusy !== '',
                  onClick: () => { void runDbMaintain('purgeTrash', { all: true }); },
                }, t('db.purgeTrash', { n: fmtNum(tot.deletedNotes, locale) }))
                : null)),

          // ② 各会话列表
          h('div', { style: { ...S.sectionTitle, marginTop: 12 } }, t('db.sessionsHeading', { n: fmtNum(sessions.length, locale) })),
          sessions.length === 0
            ? h('div', { style: { ...S.emptyCard, marginTop: 6 } }, t('db.noSessions'))
            : h('div', { style: { border: `1px solid ${BORDER}`, borderRadius: RADIUS, overflow: 'hidden', marginTop: 6 } },
              ...sessions.map((s, idx) => {
                const isCur = s.sessionId === sessionId;
                const recOn = s.enabled && s.enabled.record === true;
                const toolsOn = s.enabled && s.enabled.tools === true;
                const cov = s.totalMsgs > 0 ? Math.min(100, Math.round(((s.indexedMsgs ?? 0) / s.totalMsgs) * 100)) : 0;
                return h('div', {
                  key: s.sessionId,
                  style: {
                    padding: '9px 11px',
                    borderTop: idx > 0 ? `1px solid ${BORDER}` : 'none',
                    borderLeft: isCur ? `3px solid ${BRAND}` : '3px solid transparent',
                    background: isCur ? `color-mix(in srgb, ${BRAND} 3%, transparent)` : 'transparent',
                  },
                },
                  h('div', { style: { ...S.rowBetween, alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: FS.sm, fontWeight: 600, color: LABEL1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.sessionId },
                      h(SessionInlineName, { useSessions, sessionId: s.sessionId }),
                      isCur ? h('span', { style: { ...S.sourceBadgeVec, marginLeft: 6 } }, t('db.currentBadge')) : null),
                    h('span', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                      h('span', { style: recOn ? S.sourceBadgeBoth : S.tag }, `${t('switch.record')}: ${recOn ? t('switch.on') : t('switch.off')}`),
                      h('span', { style: toolsOn ? S.sourceBadgeBoth : S.tag }, `${t('switch.tools')}: ${toolsOn ? t('switch.on') : t('switch.off')}`))),
                  h('div', { style: { ...S.hint, marginTop: 3, fontVariantNumeric: 'tabular-nums' } },
                    `${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')} · `
                    + `${fmtNum(s.sceneCount, locale)} ${t('common.unitScenes')} · `
                    + `${fmtNum(s.windowCount ?? 0, locale)} ${t('db.kindWindow')} · `
                    + `${cov}% ${t('overview.kpiIndex')} · `
                    + `${fmtNum(s.noteCount, locale)} ${t('overview.kpiNotes')}`),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      onClick: () => {
                        setDbSession(s.sessionId);
                        setDbPage(0);
                        setDbFilter('');
                        setDbWindowKind('');
                        setDbVecFilter('');
                        setDbSubTab('browse');
                        void loadDbRows({ sessionId: s.sessionId, page: 0, query: '', kind: '', vec: '' });
                      },
                    }, t('db.browseBtn')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void triggerDbSessionIndex(s.sessionId, 'incremental'); },
                    }, t('db.syncIndexBtn')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void triggerDbSessionIndex(s.sessionId, 'scene', { useLlm: false }); },
                    }, t('index.resplit')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbActionBusy !== '',
                      onClick: () => { void runDbMaintain('exportSession', { sessionId: s.sessionId }); },
                    }, t('db.exportBtn')),
                    confirmDeleteSid === s.sessionId
                      ? [
                        h('button', {
                          key: 'del-yes',
                          type: 'button',
                          style: { ...S.btn, borderColor: ERROR, color: ERROR, fontWeight: 600 },
                          disabled: dbActionBusy !== '',
                          onClick: () => {
                            setConfirmDeleteSid(null);
                            void runDbMaintain('clearSession', { sessionId: s.sessionId, removeConfig: true });
                          },
                        }, t('db.deleteSessionConfirm')),
                        h('button', {
                          key: 'del-no',
                          type: 'button',
                          style: S.btn,
                          disabled: dbActionBusy !== '',
                          onClick: () => setConfirmDeleteSid(null),
                        }, t('db.clearSessionCancel')),
                      ]
                      : h('button', {
                        type: 'button',
                        style: { ...S.btn, color: ERROR },
                        disabled: dbActionBusy !== '',
                        onClick: () => setConfirmDeleteSid(s.sessionId),
                      }, t('db.deleteSessionBtn'))));
              })));
      };

      const renderBrowseView = () => {
        const tables = ['msg', 'scene', 'window', 'note', 'flag', 'chunk', 'media'];
        const activeDbSession = dbSession ? rawSessions.find((s) => s.sessionId === dbSession) : null;
        const tableCounts = dbSession
          ? (activeDbSession
            ? (activeDbSession.tables || {
              msg: activeDbSession.totalMsgs ?? 0,
              scene: activeDbSession.sceneCount ?? 0,
              window: activeDbSession.windowCount ?? 0,
              note: (activeDbSession.noteCount ?? 0) + (activeDbSession.deletedNoteCount ?? 0),
              flag: activeDbSession.flagCount ?? 0,
              chunk: activeDbSession.chunkCount ?? 0,
              media: activeDbSession.mediaCount ?? 0,
            })
            : { msg: 0, scene: 0, window: 0, note: 0, flag: 0, chunk: 0, media: 0 })
          : ((dbOverview && dbOverview.tables) || {});

        const rows = dbRowsData && Array.isArray(dbRowsData.rows) ? dbRowsData.rows : [];
        const kindCounts = dbRowsData && dbRowsData.kindCounts ? dbRowsData.kindCounts : null;
        const total = dbRowsData ? (dbRowsData.total ?? 0) : 0;
        const pageSize = dbRowsData ? (dbRowsData.limit ?? 20) : 20;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));

        const jumpDbPage = () => {
          const n = Math.trunc(Number(dbPageInput));
          if (!Number.isFinite(n)) {
            setDbPageInput(String(dbPage + 1));
            return;
          }
          const target = Math.min(totalPages - 1, Math.max(0, n - 1));
          setDbPage(target);
          setDbPageInput(String(target + 1));
          void loadDbRows({ page: target });
        };

        const kindBadge = (k) => {
          if (k === 'thread') return { text: t('db.kindThread'), style: S.sourceBadgeBoth };
          if (k === 'exchange') return { text: t('db.kindExchange'), style: S.sourceBadgeVec };
          return { text: t('db.kindWindow'), style: S.tag };
        };

        const formatRowPreview = (row) => {
          if (dbTable === 'msg') {
            return {
              head: `#${row.seq ?? row.id} · ${row.speaker ?? ''} · ${fmtShort(row.at)}`,
              sceneId: row.scene_id ?? null,
              at: row.at ?? null,
              badges: [
                row.vec_model ? { text: t('db.vecYes'), style: S.sourceBadgeVec } : { text: t('db.vecNo'), style: S.sourceBadgeKw },
                row.in_surface === 0 ? { text: t('timeline.compacted'), style: S.tag } : null,
                row.excluded === 1 ? { text: t('search.excludedTag'), style: S.tag } : null,
              ].filter(Boolean),
              body: String(row.text ?? ''),
            };
          }
          if (dbTable === 'scene') {
            return {
              head: `scene #${row.id} · ${fmtSceneRange(row.start_at, row.end_at)} · ${fmtNum(row.msg_count, locale)} ${t('common.unitMsgs')}`,
              sceneId: row.id ?? null,
              at: row.start_at ?? null,
              badges: [
                row.has_out_of_surface ? { text: t('timeline.compacted'), style: S.tag } : null,
                (row.excluded_count ?? 0) > 0 ? { text: t('search.excludedTag'), style: S.tag } : null,
              ].filter(Boolean),
              body: String(row.gist || t('db.noGist')),
            };
          }
          if (dbTable === 'window') {
            const wKind = row.kind || 'window';
            return {
              head: `#${row.id} · scene #${row.scene_id} [${row.start_msg_id ?? '?'}..${row.end_msg_id ?? '?'}] · ${fmtSceneRange(row.start_at, row.end_at)} · ${fmtNum(row.msg_count, locale)} ${t('common.unitMsgs')}`,
              sceneId: row.scene_id ?? null,
              at: row.start_at ?? null,
              badges: [
                kindBadge(wKind),
                row.vec_model ? { text: t('db.vecYes'), style: S.sourceBadgeVec } : { text: t('db.vecNo'), style: S.sourceBadgeKw },
              ],
              body: String(row.text ?? ''),
            };
          }
          if (dbTable === 'note') {
            return {
              head: `note #${row.id} · ${row.about || '—'} · ${fmtShort(row.at)}`,
              badges: [row.deleted_at ? { text: 'deleted', style: S.sourceBadgeKw } : { text: 'active', style: S.sourceBadgeVec }],
              body: String(row.content ?? ''),
            };
          }
          if (dbTable === 'flag') {
            return {
              head: `flag #${row.id} · msg #${row.msg_id} · ${fmtShort(row.at)}`,
              badges: [row.resolved_at ? { text: 'resolved', style: S.tag } : { text: 'open', style: S.sourceBadgeKw }],
              body: `${row.reason || '—'} — ${String(row.text ?? '').slice(0, 140)}`,
            };
          }
          if (dbTable === 'chunk') {
            return {
              head: `chunk #${row.id} · msg #${row.msg_id} [${row.idx}] (${row.start_char}..${row.end_char})`,
              badges: [],
              body: String(row.snippet ?? ''),
            };
          }
          return {
            head: `media #${row.id} · msg #${row.msg_id} · ${row.width ?? '?'}×${row.height ?? '?'}${row.at ? ` · ${fmtShort(row.at)}` : ''}`,
            sceneId: row.scene_id ?? null,
            at: row.at ?? row.created_at ?? null,
            badges: [
              row.caption ? { text: 'caption', style: S.sourceBadgeVec } : null,
            ].filter(Boolean),
            body: String(row.caption || row.path || ''),
          };
        };

        const activeRow = rows.find((r, i) => `${dbTable}:${r.id ?? i}` === dbExpandedRow) || null;

        return h('div', null,
          // ① 会话 + 表选择紧凑工具栏
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 } },
            h('select', {
              style: S.dbSelect,
              value: dbSession,
              onChange: (e) => {
                const nextSid = e.target.value;
                setDbSession(nextSid);
                setDbPage(0);
                setDbFilter('');
                setDbWindowKind('');
                setDbVecFilter('');
                void loadDbRows({ sessionId: nextSid, page: 0, query: '', kind: '', vec: '' });
              },
            },
              ...sessions.filter((s) => s.sessionId === sessionId).map((s) => h('option', { key: `cur-${s.sessionId}`, value: s.sessionId },
                `★ ${t('db.currentBadge')} · ${shortSid(s.sessionId)} (${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')})`)),
              sessionId && !sessions.some((s) => s.sessionId === sessionId)
                ? h('option', { key: `cur-${sessionId}`, value: sessionId }, `★ ${t('db.currentBadge')} · ${shortSid(sessionId)}`)
                : null,
              h('option', { value: '' }, t('db.allSessions', { n: fmtNum(sessions.length, locale) })),
              ...sessions.filter((s) => s.sessionId !== sessionId).map((s) => h('option', { key: s.sessionId, value: s.sessionId },
                `${shortSid(s.sessionId)} (${fmtNum(s.totalMsgs, locale)} ${t('common.unitMsgs')})`))),

            h('div', { style: S.dbChipRow },
              ...tables.map((tbl) => h('button', {
                key: tbl,
                type: 'button',
                style: dbTable === tbl ? { ...S.dbChip, ...S.dbChipOn } : S.dbChip,
                onClick: () => {
                  setDbTable(tbl);
                  setDbPage(0);
                  setDbFilter('');
                  setDbWindowKind('');
                  setDbVecFilter('');
                  void loadDbRows({ table: tbl, page: 0, query: '', kind: '', vec: '' });
                },
              }, `${t(`db.table.${tbl}`)}${typeof tableCounts[tbl] === 'number' ? ` (${fmtNum(tableCounts[tbl], locale)})` : ''}`))),

            // ② 条件子筛选（window kind / 向量状态）+ 搜索框
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              dbTable === 'window'
                ? h('div', { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
                  ...[
                    { k: '', label: t('db.kindAll') },
                    { k: 'thread', label: `${t('db.kindThread')}${kindCounts ? ` (${fmtNum(kindCounts.thread ?? 0, locale)})` : ''}` },
                    { k: 'exchange', label: `${t('db.kindExchange')}${kindCounts ? ` (${fmtNum(kindCounts.exchange ?? 0, locale)})` : ''}` },
                    { k: 'window', label: `${t('db.kindWindow')}${kindCounts ? ` (${fmtNum(kindCounts.window ?? 0, locale)})` : ''}` },
                  ].map((opt) => h('button', {
                    key: `wk-${opt.k || 'all'}`,
                    type: 'button',
                    style: dbWindowKind === opt.k ? { ...S.pill, ...S.pillActive } : S.pill,
                    onClick: () => {
                      setDbWindowKind(opt.k);
                      setDbPage(0);
                      void loadDbRows({ kind: opt.k, page: 0 });
                    },
                  }, opt.label)))
                : null,
              dbTable === 'msg' || dbTable === 'window'
                ? h('div', { style: { display: 'inline-flex', gap: 4 } },
                  ...[
                    { v: '', label: t('db.vecAll') },
                    { v: 'yes', label: t('db.vecYes') },
                    { v: 'no', label: t('db.vecNo') },
                  ].map((opt) => h('button', {
                    key: `vf-${opt.v || 'all'}`,
                    type: 'button',
                    style: dbVecFilter === opt.v ? { ...S.pill, ...S.pillActive } : S.pill,
                    onClick: () => {
                      setDbVecFilter(opt.v);
                      setDbPage(0);
                      void loadDbRows({ vec: opt.v, page: 0 });
                    },
                  }, opt.label)))
                : null,
              h('form', {
                style: { display: 'flex', gap: 4, flex: '1 1 180px', minWidth: 0 },
                onSubmit: (e) => {
                  e.preventDefault();
                  setDbPage(0);
                  void loadDbRows({ page: 0 });
                },
              },
                h('input', {
                  type: 'search',
                  style: S.input,
                  value: dbFilter,
                  placeholder: t('db.filterPlaceholder'),
                  onChange: (e) => setDbFilter(e.target.value),
                }),
                dbFilter
                  ? h('button', {
                    type: 'button',
                    style: S.btn,
                    onClick: () => {
                      setDbFilter('');
                      setDbPage(0);
                      void loadDbRows({ query: '', page: 0 });
                    },
                  }, t('db.filterClear'))
                  : null,
                h('button', { type: 'submit', style: S.btn, disabled: dbRowsBusy }, t('db.filterBtn'))))),

          // ③ 紧凑列表 + 选中详情检视
          dbRowsBusy && dbRowsData === null
            ? h(SkeletonGroup, { kind: 'rows', count: 5 })
            : rows.length === 0
              ? h('div', { style: S.emptyCard }, t('db.emptyRows'))
              : h('div', null,
                h('div', { style: { border: `1px solid ${BORDER}`, borderRadius: RADIUS, overflow: 'hidden' } },
                  ...rows.map((row, idx) => {
                    const rowKey = `${dbTable}:${row.id ?? idx}`;
                    const isOpen = dbExpandedRow === rowKey;
                    const pv = formatRowPreview(row);
                    const rowCopyId = `dbrow:${rowKey}`;
                    const rowCopied = copiedKey === rowCopyId;
                    return h('div', {
                      key: rowKey,
                      style: {
                        borderTop: idx > 0 ? `1px solid ${BORDER}` : 'none',
                        borderLeft: isOpen ? `3px solid ${BRAND}` : '3px solid transparent',
                        background: isOpen ? `color-mix(in srgb, ${BRAND} 4%, transparent)` : 'transparent',
                        padding: '7px 10px',
                      },
                    },
                      h('div', {
                        'data-clickable': '1',
                        style: { ...S.rowBetween, alignItems: 'center', gap: 6 },
                        onClick: () => setDbExpandedRow(isOpen ? null : rowKey),
                      },
                        h('span', { style: { fontFamily: CODE_FONT, fontSize: FS.xs, color: LABEL2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          `${isOpen ? '▾ ' : '▸ '}${pv.head}`),
                        h('span', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                          ...pv.badges.map((b, bi) => h('span', { key: String(bi), style: b.style }, b.text)))),
                      h('div', {
                        style: {
                          marginTop: 2,
                          fontSize: FS.sm,
                          color: LABEL1,
                          lineHeight: 1.45,
                          display: '-webkit-box',
                          WebkitLineClamp: isOpen ? 99 : 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        },
                      }, pv.body),
                      isOpen
                        ? h('div', { style: { marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${BORDER}` } },
                          dbTable === 'media'
                            ? (() => {
                              const mKey = String(row.id);
                              const mPrev = dbMediaPreviews[mKey];
                              const capVal = captionDrafts[mKey] !== undefined ? captionDrafts[mKey] : String(row.caption ?? '');
                              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 } },
                                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                                  h('input', {
                                    type: 'text',
                                    style: { ...S.input, flex: '1 1 200px' },
                                    value: capVal,
                                    placeholder: t('db.mediaCaptionPlaceholder'),
                                    onChange: (e) => {
                                      const v = e.target.value;
                                      setCaptionDrafts((prev) => ({ ...prev, [mKey]: v }));
                                    },
                                  }),
                                  h('button', {
                                    type: 'button',
                                    style: S.primaryBtn,
                                    disabled: captionBusyId === row.id,
                                    onClick: () => { void saveMediaCaption(row.id, row.caption); },
                                  }, captionBusyId === row.id ? '…' : t('db.mediaCaptionSave')),
                                  h('button', {
                                    type: 'button',
                                    style: S.btn,
                                    onClick: () => { void toggleDbMediaPreview(row.id); },
                                  }, t('db.mediaPreviewBtn'))),
                                mPrev
                                  ? (mPrev.loading
                                    ? h('div', { style: S.hint }, '…')
                                    : mPrev.ok && (mPrev.dataUrl || mPrev.url)
                                      ? h('img', {
                                        src: mPrev.dataUrl || mPrev.url,
                                        alt: capVal || `media #${row.id}`,
                                        style: { maxWidth: '100%', maxHeight: 260, borderRadius: RADIUS_SM, border: `1px solid ${BORDER}`, objectFit: 'contain', alignSelf: 'flex-start' },
                                      })
                                      : h('div', { style: S.warnHint }, mPrev.reason || t('common.failed')))
                                  : null);
                            })()
                            : null,
                          h('pre', { style: S.dbDetailPre }, JSON.stringify(row, null, 2)),
                          h('div', { style: { ...S.actions, marginTop: 4 } },
                            pv.sceneId && (!row.session_id || row.session_id === sessionId)
                              ? h('button', {
                                type: 'button',
                                style: S.btn,
                                onClick: () => {
                                  if (typeof jumpToTimeline === 'function') {
                                    void jumpToTimeline({ sceneId: pv.sceneId, at: pv.at, id: dbTable === 'msg' || dbTable === 'media' ? (row.msg_id ?? row.id) : undefined });
                                  } else if (typeof setTab === 'function') {
                                    setTab('timeline');
                                  }
                                },
                              }, t('db.jumpScene'))
                              : null,
                            h('button', {
                              type: 'button',
                              style: rowCopied ? { ...S.copyBtn, ...S.copyBtnDone } : S.copyBtn,
                              onClick: () => { void handleCopy(rowCopyId, JSON.stringify(row, null, 2)); },
                            }, rowCopied ? t('common.copied') : t('common.copy'))))
                        : null);
                  })),
                // 分页栏
                h('div', { style: { ...S.rowBetween, alignItems: 'center', marginTop: 8, flexWrap: 'wrap', gap: 6 } },
                  h('span', { style: { ...S.hint, fontVariantNumeric: 'tabular-nums' } },
                    t('db.pageInfo', { page: dbPage + 1, pages: totalPages, total: fmtNum(total, locale) })),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbPage <= 0 || dbRowsBusy,
                      onClick: () => {
                        const p = Math.max(0, dbPage - 1);
                        setDbPage(p);
                        void loadDbRows({ page: p });
                      },
                    }, t('db.prevPage')),
                    totalPages > 1
                      ? h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                        h('input', {
                          type: 'number',
                          min: 1,
                          max: totalPages,
                          value: dbPageInput,
                          disabled: dbRowsBusy,
                          'aria-label': t('db.jumpPage'),
                          onChange: (e) => { setDbPageInput(e.target.value); },
                          onKeyDown: (e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              jumpDbPage();
                            }
                          },
                          style: {
                            ...S.input,
                            width: 56,
                            padding: '3px 6px',
                            fontSize: FS.xs,
                            textAlign: 'center',
                            fontVariantNumeric: 'tabular-nums',
                          },
                        }),
                        h('button', {
                          type: 'button',
                          style: S.btn,
                          disabled: dbRowsBusy,
                          onClick: jumpDbPage,
                        }, t('db.jumpPage')))
                      : null,
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: dbPage + 1 >= totalPages || dbRowsBusy,
                      onClick: () => {
                        const p = dbPage + 1;
                        setDbPage(p);
                        void loadDbRows({ page: p });
                      },
                    }, t('db.nextPage'))))));
      };

      const renderSqlView = () => {
        const escSid = String(sessionId || '').replace(/'/g, "''");
        const templates = [
          ...(sessionId ? [
            {
              label: t('db.tplCurMsgs'),
              sql: `SELECT id, seq, speaker, in_surface, vec_model, substr(text, 1, 80) AS preview FROM msg WHERE session_id = '${escSid}' ORDER BY seq DESC LIMIT 20`,
            },
            {
              label: t('db.tplWinKinds'),
              sql: `SELECT COALESCE(kind, 'window') AS kind, COUNT(*) AS cnt, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM window WHERE session_id = '${escSid}' GROUP BY kind`,
            },
            {
              label: t('db.tplCurScenes'),
              sql: `SELECT id, msg_count, compacted_count, substr(gist, 1, 90) AS gist FROM scene WHERE session_id = '${escSid}' ORDER BY start_at DESC LIMIT 20`,
            },
            {
              label: t('db.tplCurNotes'),
              sql: `SELECT id, about, substr(content, 1, 80) AS content, deleted_at FROM note WHERE session_id = '${escSid}' ORDER BY at DESC LIMIT 30`,
            },
          ] : []),
          {
            label: t('db.tplSessions'),
            sql: 'SELECT session_id, COUNT(*) AS msgs, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM msg GROUP BY session_id ORDER BY msgs DESC',
          },
          {
            label: t('db.tplPending'),
            sql: sessionId
              ? `SELECT id, seq, speaker, substr(text, 1, 60) AS preview FROM msg WHERE session_id = '${escSid}' AND excluded = 0 AND vec_model IS NULL ORDER BY at DESC LIMIT 30`
              : 'SELECT id, session_id, seq, speaker, substr(text, 1, 60) AS preview FROM msg WHERE excluded = 0 AND vec_model IS NULL ORDER BY at DESC LIMIT 30',
          },
          {
            label: t('db.tplTables'),
            sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
          },
        ];

        return h('div', null,
          h('div', { style: S.hint }, t('db.sqlHint')),
          h('div', { style: S.dbChipRow },
            ...templates.map((tpl, i) => h('button', {
              key: `tpl-${i}`,
              type: 'button',
              style: S.dbChip,
              onClick: () => {
                setDbSql(tpl.sql);
                void runDbSql(tpl.sql);
              },
            }, tpl.label))),
          h('textarea', {
            style: { ...S.dbSqlArea, marginTop: 6 },
            value: dbSql,
            onChange: (e) => setDbSql(e.target.value),
          }),
          h('div', { style: { ...S.actions, marginTop: 6 } },
            h('button', {
              type: 'button',
              style: S.primaryBtn,
              disabled: dbSqlBusy || !dbSql.trim(),
              onClick: () => { void runDbSql(); },
            }, dbSqlBusy ? '…' : t('db.sqlRun'))),
          dbSqlErr
            ? h('div', { style: { ...S.errorCard, marginTop: 8 } }, dbSqlErr)
            : null,
          dbSqlRes
            ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.hint },
                t('db.sqlMeta', { n: fmtNum(dbSqlRes.rowCount, locale), ms: fmtNum(dbSqlRes.elapsedMs, locale) })
                + (dbSqlRes.truncated ? t('db.sqlTruncated', { shown: fmtNum(dbSqlRes.rows.length, locale) }) : '')),
              dbSqlRes.rows.length === 0
                ? h('div', { style: { ...S.emptyCard, marginTop: 6 } }, t('db.sqlEmpty'))
                : h('div', { style: S.dbTableWrap },
                  h('table', { style: S.dbTable },
                    h('thead', null,
                      h('tr', null,
                        ...dbSqlRes.columns.map((c) => h('th', { key: c, style: S.dbTh }, c)))),
                    h('tbody', null,
                      ...dbSqlRes.rows.map((r, ri) => h('tr', { key: String(ri) },
                        ...dbSqlRes.columns.map((c) => {
                          const v = r[c];
                          const text = v === null || v === undefined ? 'NULL' : String(v);
                          return h('td', { key: c, style: S.dbTd, title: text }, text);
                        })))))))
            : null);
      };

      return h('div', null,
        h('div', { style: { ...S.rowBetween, alignItems: 'center', marginBottom: 8 } },
          h('div', { style: { ...S.segmented, marginBottom: 0 } },
            ...['sessions', 'browse', 'sql'].map((sub) => h('button', {
              key: sub,
              type: 'button',
              style: dbSubTab === sub ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
              onClick: () => {
                setDbSubTab(sub);
                if (sub === 'browse' && dbRowsData === null) void loadDbRows();
              },
            }, t(sub === 'sessions' ? 'db.subSessions' : sub === 'browse' ? 'db.subBrowse' : 'db.subSql')))),
          h('button', {
            type: 'button',
            style: S.btn,
            disabled: dbOverviewBusy || dbRowsBusy,
            onClick: () => {
              void loadDbOverview();
              if (dbSubTab === 'browse') void loadDbRows();
            },
          }, t('common.refresh'))),
        dbSubTab === 'sessions' ? renderSessionsView()
          : dbSubTab === 'browse' ? renderBrowseView()
            : renderSqlView());
    }
    /* ══════════════════════════ 面板 ══════════════════════════ */

    /**
     * @param {object} props 槽位注入的 props：
     *   sessionId（必带，来自 session 作用域的标准 props）、t（locale 座椅）、
     *   useSessions 等标准 hooks，以及本插件 inject 回来的 sessionId。
     */
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : ((key) => key);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
      const locale = props.locale === 'en' ? 'en' : 'zh';
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null;

      /* ---------- 数据 ---------- */
      const [status, setStatus] = useState(null);
      const [loadErr, setLoadErr] = useState(null);
      const [loading, setLoading] = useState(true);

      const [days, setDays] = useState(null);
      const [notes, setNotes] = useState(null);
      const [flags, setFlags] = useState([]);
      /** 标记列表读失败的原因。「读不出来」和「真的没有」必须分开（D-096） */
      const [flagsErr, setFlagsErr] = useState(null);
      // **按页分开记录**（2026-11-18，A4 BUG 9）：之前一个 tabErr 被三个 load 函数互相重置，
      // 结果「笔记读失败」会被时间轴的刷新洗成「TA 还没记过笔记」—— 读失败被显示成真的没有。
      const [tabErrs, setTabErrs] = useState({});
      /** 记某页的读取失败（null = 清掉） */
      const setTabErr = useCallback((page, msg) => {
        setTabErrs((prev) => (prev[page] === (msg ?? null) ? prev : { ...prev, [page]: msg ?? null }));
      }, []);

      const [sample, setSample] = useState(null);
      const [verify, setVerify] = useState(null);
      const [flagForm, setFlagForm] = useState(null);
      const [editingTerm, setEditingTerm] = useState(null);

      const [tab, setTab] = useState('overview');
      const [openDay, setOpenDay] = useState(null);
      /** 时间轴要拉到多早（天数）。默认 7，点「看更早的」按 7 天递增，到接口上限为止 */
      const [timelineDays, setTimelineDays] = useState(TIMELINE_DAYS);
      /** 时间轴上一次「已经试过」的天数：用来触发重载，同时避免失败后无限重试 */
      const [daysLimit, setDaysLimit] = useState(0);
      const [scene, setScene] = useState(null);

      /* ---------- 搜索 / 回收站 / 排除时段 / 定位高亮 ---------- */
      const [searchQuery, setSearchQuery] = useState('');
      const [searchWhen, setSearchWhen] = useState('');
      const [searchSpeaker, setSearchSpeaker] = useState('all');
      const [searchIncludeExcluded, setSearchIncludeExcluded] = useState(false);
      const [searchResult, setSearchResult] = useState(null);
      const [searchBusy, setSearchBusy] = useState(false);
      const [expandedHits, setExpandedHits] = useState({});
      const [searchHistory, setSearchHistory] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-verbatim:search-history') : null;
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8) : [];
        } catch { return []; }
      });

      const [timelineOnlyCompacted, setTimelineOnlyCompacted] = useState(false);
      const [notesView, setNotesView] = useState('active');
      const [noteFilter, setNoteFilter] = useState('');
      const [noteAboutFilter, setNoteAboutFilter] = useState('all');
      const [noteForm, setNoteForm] = useState(null);
      const [showBackTop, setShowBackTop] = useState(false);
      const bodyRef = useRef(null);
      const [deletedNotes, setDeletedNotes] = useState(null);
      const [deletedNotesTotal, setDeletedNotesTotal] = useState(null);
      const [trashErr, setTrashErr] = useState(null);
      const [trashLoading, setTrashLoading] = useState(false);

      const [excludeForm, setExcludeForm] = useState(null);
      const [copiedKey, setCopiedKey] = useState(null);
      const [highlightMsg, setHighlightMsg] = useState(null);

      /* ---------- 数据库管理台（全库 + 跨会话切换视图，默认优先当前会话） ---------- */
      const sqlEscSid = String(sessionId || '').replace(/'/g, "''");
      const defaultDbSql = sessionId
        ? `SELECT id, seq, speaker, in_surface, vec_model, substr(text, 1, 80) AS preview FROM msg WHERE session_id = '${sqlEscSid}' ORDER BY seq DESC LIMIT 20`
        : 'SELECT session_id, COUNT(*) AS msgs, SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexed FROM msg GROUP BY session_id ORDER BY msgs DESC';
      const [dbSubTab, setDbSubTab] = useState('sessions');
      const [dbOverview, setDbOverview] = useState(null);
      const [dbOverviewBusy, setDbOverviewBusy] = useState(false);
      const [dbSession, setDbSession] = useState(sessionId || '');
      const [dbTable, setDbTable] = useState('msg');
      const [dbWindowKind, setDbWindowKind] = useState('');
      const [dbVecFilter, setDbVecFilter] = useState('');
      const [dbFilter, setDbFilter] = useState('');
      const [dbPage, setDbPage] = useState(0);
      const [dbPageInput, setDbPageInput] = useState('1');
      useEffect(() => { setDbPageInput(String(dbPage + 1)); }, [dbPage]);
      const [mediaPreviews, setMediaPreviews] = useState({});
      const [indexAdvOpen, setIndexAdvOpen] = useState(false);
      const [recallOpen, setRecallOpen] = useState(false);
      const [recallItems, setRecallItems] = useState(null);
      const [recallBusy, setRecallBusy] = useState(false);
      const [dupGroups, setDupGroups] = useState(null);
      const [dupBusy, setDupBusy] = useState(false);
      const [sceneOpBusy, setSceneOpBusy] = useState('');
      const [editingGist, setEditingGist] = useState(null); // { sceneId, text }
      const [editingNote, setEditingNote] = useState(null); // { id, text }
      const [dbRowsData, setDbRowsData] = useState(null);
      const [dbRowsBusy, setDbRowsBusy] = useState(false);
      const [dbExpandedRow, setDbExpandedRow] = useState(null);
      const [dbSql, setDbSql] = useState(defaultDbSql);
      const [dbSqlBusy, setDbSqlBusy] = useState(false);
      const [dbSqlRes, setDbSqlRes] = useState(null);
      const [dbSqlErr, setDbSqlErr] = useState(null);
      const [dbActionBusy, setDbActionBusy] = useState('');
      const [dbTask, setDbTask] = useState(null);
      const [batchVerify, setBatchVerify] = useState(null);
      const [verifyIdInput, setVerifyIdInput] = useState('');

      const [busy, setBusyRaw] = useState('');
      // **计数器**（2026-11-18，A4 BUG 8）：`busy` 之前是单槽字符串，
      // 两个写操作同时在跑时，先完成的那个 `finally setBusy('')` 会把
      // 另一个的 disabled 也打开 —— 于是「开关点了没反应」或「连点发出两次写」。
      // 现在清空只在计数归零时发生，第二个操作还在跑就不清。
      const busyCount = useRef(0);
      const setBusy = useCallback((value) => {
        if (value === '') {
          busyCount.current = Math.max(0, busyCount.current - 1);
          if (busyCount.current === 0) setBusyRaw('');
        } else {
          busyCount.current += 1;
          setBusyRaw(value);
        }
      }, []);
      const [flash, setFlash] = useState(null);
      const [rebuild, setRebuild] = useState(null);
      const [initConfirm, setInitConfirm] = useState(false);

      /** 只让最后一次请求的响应落地（切会话/连点时不会串数据） */
      const reqSeq = useRef(0);
      /** 每个列表独立的序号：只认最后一次请求（2026-11-18，A4 BUG 5/7/13） */
      const listSeq = useRef({ days: 0, notes: 0, deletedNotes: 0, flags: 0, scene: 0, search: 0, dbOverview: 0, dbRows: 0 });
      const pollTimer = useRef(null);
      const dbTaskTimer = useRef(null);
      const dbPollSeq = useRef(0);
      const pollingTaskRef = useRef(null);
      const copyTimer = useRef(null);
      const highlightTimer = useRef(null);
      const msgRefs = useRef(new Map());
      const searchInputRef = useRef(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          pollingTaskRef.current = null;
          if (pollTimer.current) clearTimeout(pollTimer.current);
          if (dbTaskTimer.current) clearTimeout(dbTaskTimer.current);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          if (highlightTimer.current) clearTimeout(highlightTimer.current);
        };
      }, []);

      /* ---------- 读 ---------- */

      const loadStatus = useCallback(async () => {
        if (!sessionId) {
          setStatus(null);
          setLoading(false);
          return null;
        }
        const mine = (reqSeq.current += 1);
        setLoading(true);
        setLoadErr(null);
        try {
          const raw = await rpcRead('status', { sessionId });
          if (!alive.current || mine !== reqSeq.current) return null;
          const next = normalizeStatus(raw);
          setStatus(next);
          return next; // 给写操作确认状态用（服务端为准，不靠猜）
        } catch (e) {
          if (!alive.current || mine !== reqSeq.current) return null;
          setStatus(null);
          setLoadErr(msgOf(e));
          return null;
        } finally {
          if (alive.current && mine === reqSeq.current) setLoading(false);
        }
      }, [sessionId]);

      const loadFlags = useCallback(async () => {
        if (!sessionId) {
          setFlags([]);
          setFlagsErr(null);
          return;
        }
        const mine = (listSeq.current.flags += 1);
        const stale = () => !alive.current || mine !== listSeq.current.flags;
        try {
          const raw = await rpcRead('flags', { sessionId, limit: FLAGS_LIMIT });
          if (stale()) return;
          setFlags(asArray(raw, 'flags').map(normalizeFlag).filter((f) => f.msgId !== undefined));
          setFlagsErr(null);
        } catch (e) {
          // **不能**把失败当成「没有标记」：那会造成界面误导（用户标过 3 条却被告知一条都没有）。
          // 保留上一次读到的列表，同时把失败原因摆出来。
          if (stale()) return;
          setFlagsErr(msgOf(e));
        }
      }, [sessionId]);

      const loadDays = useCallback(async () => {
        const mine = (listSeq.current.days += 1);
        const stale = () => !alive.current || mine !== listSeq.current.days;
        // 只清自己这一页的错误（之前会把笔记页的失败一起洗掉 → 假空态）
        setTabErr('timeline', null);
        try {
          // limit 是「天数」，不是消息数（index.js:842）。timelineDays 由「看更早的」递增。
          const raw = await rpcRead('timeline', { sessionId, limit: timelineDays });
          if (stale()) return;
          setDays(normalizeTimeline(raw));
          setDaysLimit(timelineDays);
        } catch (e) {
          // 失败时**保留已经看到的列表**，不要把页面清空（更早几天读不出来不该让人丢掉现有内容）。
          // daysLimit 也一起记下：表示这个范围「已经试过」，避免 effect 无限重试。
          if (stale()) return;
          setDays((prev) => prev ?? []);
          setDaysLimit(timelineDays);
          setTabErr('timeline', msgOf(e));
        }
      }, [sessionId, timelineDays, setTabErr]);

      const loadNotes = useCallback(async () => {
        const mine = (listSeq.current.notes += 1);
        const stale = () => !alive.current || mine !== listSeq.current.notes;
        setTabErr('notes', null);
        try {
          const raw = await rpcRead('notes', { sessionId, limit: NOTES_LIMIT, offset: 0 });
          if (stale()) return;
          setNotes(asArray(raw, 'notes').map(normalizeNote));
        } catch (e) {
          if (stale()) return;
          setNotes((prev) => prev ?? []);
          setTabErr('notes', msgOf(e));
        }
      }, [sessionId, setTabErr]);

      const loadDeletedNotes = useCallback(async () => {
        if (!sessionId) return;
        const mine = (listSeq.current.deletedNotes += 1);
        const stale = () => !alive.current || mine !== listSeq.current.deletedNotes;
        setTrashLoading(true);
        setTrashErr(null);
        try {
          const raw = await rpcRead('deletedNotes', { sessionId });
          if (stale()) return;
          const norm = normalizeDeletedNotes(raw);
          setDeletedNotes(norm.items);
          setDeletedNotesTotal(norm.total);
        } catch (e) {
          if (stale()) return;
          setDeletedNotes((prev) => prev ?? []);
          setTrashErr(msgOf(e));
        } finally {
          if (!stale()) setTrashLoading(false);
        }
      }, [sessionId]);

      const loadDbOverview = useCallback(async () => {
        const mine = (listSeq.current.dbOverview += 1);
        const stale = () => !alive.current || mine !== listSeq.current.dbOverview;
        setDbOverviewBusy(true);
        setTabErr('dbOverview', null);
        try {
          const raw = await rpcRead('dbOverview', {});
          if (stale()) return null;
          setDbOverview(raw && typeof raw === 'object' ? raw : null);
          return raw;
        } catch (e) {
          if (stale()) return null;
          setTabErr('dbOverview', msgOf(e));
          return null;
        } finally {
          if (!stale()) setDbOverviewBusy(false);
        }
      }, [setTabErr]);

      const loadDbRows = useCallback(async (opts = {}) => {
        const targetTable = opts.table ?? dbTable;
        const targetSid = opts.sessionId !== undefined ? opts.sessionId : dbSession;
        const targetQuery = opts.query !== undefined ? opts.query : dbFilter;
        const targetKind = opts.kind !== undefined ? opts.kind : dbWindowKind;
        const targetVec = opts.vec !== undefined ? opts.vec : dbVecFilter;
        const targetPage = opts.page !== undefined ? opts.page : dbPage;
        const pageSize = 20;
        const mine = (listSeq.current.dbRows += 1);
        const stale = () => !alive.current || mine !== listSeq.current.dbRows;
        setDbRowsBusy(true);
        setTabErr('dbRows', null);
        try {
          const params = {
            table: targetTable,
            limit: pageSize,
            offset: targetPage * pageSize,
          };
          if (targetSid) params.sessionId = targetSid;
          if (targetQuery && targetQuery.trim()) params.query = targetQuery.trim();
          if (targetTable === 'window' && targetKind) params.kind = targetKind;
          if ((targetTable === 'msg' || targetTable === 'window') && targetVec) params.vec = targetVec;
          const raw = await rpcRead('dbRows', params);
          if (stale()) return;
          setDbRowsData(raw && typeof raw === 'object' ? raw : null);
          setDbExpandedRow(null);
        } catch (e) {
          if (stale()) return;
          setTabErr('dbRows', msgOf(e));
        } finally {
          if (!stale()) setDbRowsBusy(false);
        }
      }, [dbTable, dbSession, dbFilter, dbWindowKind, dbVecFilter, dbPage, setTabErr]);

      useEffect(() => {
        void loadStatus();
        void loadFlags();
      }, [loadStatus, loadFlags]);

      const dbAutoRef = useRef({ overview: false, browse: false });

      // 标签页数据按需加载；`daysLimit !== timelineDays` 时说明「看更早的」还没生效
      useEffect(() => {
        if (tab === 'db') {
          if (dbOverview === null && !dbOverviewBusy && !dbAutoRef.current.overview) {
            dbAutoRef.current.overview = true;
            void loadDbOverview();
          }
          if (dbSubTab === 'browse' && dbRowsData === null && !dbRowsBusy && !dbAutoRef.current.browse) {
            dbAutoRef.current.browse = true;
            void loadDbRows();
          }
          return;
        }
        if (status === null) return;
        // **概览页也要 days**：它画「最近 7 天」的柱状图（2026-11-18）。
        // 之前只在切到时间轴时才加载，导致概览页那块永远是空的。
        if ((tab === 'overview' || tab === 'timeline') && days === null) { void loadDays(); return; }
        if (tab === 'timeline' && daysLimit !== timelineDays) { void loadDays(); return; }
        if (tab === 'notes') {
          if (notesView === 'active' && notes === null) void loadNotes();
          if (notesView === 'trash' && deletedNotes === null && !trashLoading) void loadDeletedNotes();
        }
      }, [status, tab, days, daysLimit, timelineDays, notes, notesView, deletedNotes, trashLoading, dbOverview, dbOverviewBusy, dbSubTab, dbRowsData, dbRowsBusy, loadDays, loadNotes, loadDeletedNotes, loadDbOverview, loadDbRows]);

      useEffect(() => {
        if (tab !== 'timeline' || !highlightMsg || !scene || scene.loading || !scene.detail) return undefined;
        const el = msgRefs.current.get(highlightMsg.id);
        if (!el) return undefined;
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => {
            if (alive.current && el && typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          })
          : null;
        return () => {
          if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        };
      }, [tab, openDay, scene, highlightMsg]);

      useEffect(() => verbatimBus.subscribe((ev) => {
        if (!alive.current || !ev) return;
        if (ev.type === 'globalConfigChanged' || (ev.type === 'sessionChanged' && (!ev.detail?.sessionId || ev.detail.sessionId === sessionId))) {
          void loadStatus();
        }
      }), [sessionId, loadStatus]);

      const refresh = useCallback(async () => {
        setDays(null);
        setNotes(null);
        setDeletedNotes(null);
        setDeletedNotesTotal(null);
        setTrashErr(null);
        setSearchResult(null);
        setExpandedHits({});
        setExcludeForm(null);
        setHighlightMsg(null);
        setSample(null);
        setVerify(null);
        setFlagForm(null);
        setEditingTerm(null);
        setOpenDay(null);
        setScene(null);
        setInitConfirm(false);
        setTabErrs({});
        await loadStatus();
        await loadFlags();
      }, [loadStatus, loadFlags]);

      /* ---------- 写 ---------- */

      const setSwitch = useCallback(async (key, value) => {
        setBusy(`set:${key}`);
        setFlash(null);
        try {
          const result = await rpcWrite('set', { sessionId, key, value });
          // E4 / 诚实原则：**以服务端为准**。写响应和随后的 status 都没给这个字段时，
          // 就说「没确认」，绝不拿自己请求的值冒充已保存的状态。
          const fromWrite = result && result.enabled && typeof result.enabled[key] === 'boolean'
            ? result.enabled[key]
            : null;
          const fresh = await loadStatus();
          const fromStatus = fresh && fresh.enabledKnown && fresh.enabledKnown[key] === true
            ? fresh.enabled[key]
            : null;
          const finalValue = fromWrite !== null ? fromWrite : fromStatus;

          if (finalValue === null) {
            setFlash({ kind: 'warn', text: t('switch.writeUnconfirmed', { name: t(`switch.${key}`) }) });
          } else {
            setFlash({
              kind: 'ok',
              text: t('switch.writeOk', {
                name: t(`switch.${key}`),
                state: finalValue ? t('switch.on') : t('switch.off'),
              }),
            });
          }
        } catch (e) {
          setFlash({ kind: 'err', text: t('switch.writeFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const deleteNote = useCallback(async (id) => {
        setBusy(`note:${id}`);
        setFlash(null);
        try {
          await rpcWrite('deleteNote', { id, sessionId });
          setNotes((prev) => (prev === null ? null : prev.filter((note) => note.id !== id)));
          setDeletedNotes(null);
          await loadStatus();
          if (alive.current) setFlash({ kind: 'ok', text: t('notes.deleteOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.deleteFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const restoreNote = useCallback(async (id) => {
        setBusy(`restore:${id}`);
        setFlash(null);
        try {
          await rpcWrite('restoreNote', { id, sessionId });
          setDeletedNotes((prev) => (prev === null ? null : prev.filter((note) => note.id !== id)));
          setDeletedNotesTotal((prev) => (typeof prev === 'number' ? Math.max(0, prev - 1) : prev));
          await Promise.all([loadNotes(), loadDeletedNotes(), loadStatus()]);
          if (alive.current) setFlash({ kind: 'ok', text: t('notes.restoreOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.restoreFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadNotes, loadDeletedNotes, loadStatus, t]);

      const runSearch = useCallback(async (overrides = {}) => {
        if (!sessionId) return;
        const q = String(overrides.query !== undefined ? overrides.query : searchQuery).trim();
        const when = overrides.when !== undefined ? overrides.when : searchWhen;
        const incExcl = overrides.includeExcluded !== undefined ? overrides.includeExcluded : searchIncludeExcluded;
        if (!q) {
          setSearchResult(null);
          setTabErr('search', null);
          return;
        }
        const mine = (listSeq.current.search += 1);
        const stale = () => !alive.current || mine !== listSeq.current.search;
        setSearchBusy(true);
        setTabErr('search', null);
        // 记录搜索历史（最多保留 8 条）
        setSearchHistory((prev) => {
          const next = [q, ...prev.filter((item) => item !== q)].slice(0, 8);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-verbatim:search-history', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
        try {
          const params = { sessionId, query: q, limit: SEARCH_LIMIT };
          if (when) params.when = when;
          if (incExcl) params.includeExcluded = true;
          const raw = await rpcRead('search', params);
          if (stale()) return;
          setSearchResult(normalizeSearch(raw));
          setExpandedHits({});
        } catch (e) {
          if (stale()) return;
          setTabErr('search', t('search.failed', { err: msgOf(e) }));
        } finally {
          if (!stale()) setSearchBusy(false);
        }
      }, [sessionId, searchQuery, searchWhen, searchIncludeExcluded, setTabErr, t]);

      const saveNewNote = useCallback(async () => {
        if (!sessionId || !noteForm) return;
        const content = String(noteForm.content ?? '').trim();
        if (!content) return;
        setBusy('note:add');
        setFlash(null);
        try {
          await rpcWrite('addNote', {
            sessionId,
            content,
            about: noteForm.about || undefined,
          });
          if (!alive.current) return;
          setNoteForm(null);
          setFlash({ kind: 'ok', text: t('notes.addOk') });
          await loadNotes();
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('notes.addFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, noteForm, loadNotes, setBusy, t]);

      // 成功类提示 4 秒后自动淡出，不长期挡住内容（错误/警告保持常驻）
      useEffect(() => {
        if (!flash || flash.kind !== 'ok') return undefined;
        const timer = setTimeout(() => {
          if (alive.current) setFlash((cur) => (cur === flash ? null : cur));
        }, 4000);
        return () => clearTimeout(timer);
      }, [flash]);

      const handleCopy = useCallback(async (key, text) => {
        try {
          const ok = await copyToClipboard(text);
          if (!ok || !alive.current) return;
          setCopiedKey(key);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => {
            if (alive.current) setCopiedKey(null);
          }, 1800);
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: msgOf(e) });
        }
      }, []);

      const saveExcludeRanges = useCallback(async (nextRanges) => {
        setBusy('excludeRanges');
        setFlash(null);
        try {
          const clean = nextRanges.map((r) => (
            r.reason
              ? { from: r.from, to: r.to, reason: r.reason }
              : { from: r.from, to: r.to }
          ));
          await rpcWrite('setExcludeRanges', { sessionId, ranges: clean });
          setExcludeForm(null);
          setDays(null);
          setSearchResult(null);
          await loadStatus();
          if (alive.current) setFlash({ kind: 'ok', text: t('exclude.saveOk') });
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('exclude.saveFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, loadStatus, t]);

      const drawSample = useCallback(async () => {
        setBusy('sample');
        setFlash(null);
        setVerify(null);
        setFlagForm(null);
        try {
          const raw = await rpcRead('sample', { sessionId });
          if (alive.current) setSample(normalizeSample(raw));
        } catch (e) {
          if (alive.current) setSample({ empty: true });
          setFlash({ kind: 'err', text: t('verify.sampleFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setBusy('');
        }
      }, [sessionId, t]);

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
          if (!alive.current || settled) return;
          let terminal = null;
          let resolvedScope = scope;

          if (taskId !== null) {
            try {
              const task = await rpcRead('task', { taskId });
              if (!alive.current || settled) return;
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
              if (!alive.current || settled) return;
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

          if (!alive.current || settled) return;
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

      const openScene = async (sceneId, forceOpen = false) => {
        if (forceOpen && scene && scene.sceneId === sceneId && scene.detail && !scene.error) {
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
            if (nextId) await openScene(nextId, true);
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
            const res = await rpcRead('mediaPreview', { id: md.id });
            setMediaPreviews((prev) => ({
              ...prev,
              [key]: res && res.ok ? { ok: true, src: res.dataUrl || res.url } : { ok: false, reason: res?.reason || '无法预览' },
            }));
          } catch (e) {
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
                      .then((res) => { setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { setRecallBusy(false); });
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
                      .then((res) => { setRecallItems(Array.isArray(res?.items) ? res.items : []); })
                      .catch((e) => { setFlash({ kind: 'err', text: msgOf(e) }); })
                      .finally(() => { setRecallBusy(false); });
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

      /* ---------- 数据库管理台交互与视图 ---------- */

      const openDbBrowseFor = (targetSid, targetTable = 'msg') => {
        const sid = targetSid || '';
        setDbSession(sid);
        setDbTable(targetTable);
        setDbPage(0);
        setDbSubTab('browse');
        void loadDbRows({ sessionId: sid, table: targetTable, page: 0 });
      };

      const runDbMaintain = async (action, extra = {}) => {
        const key = `${action}:${extra.sessionId || 'all'}`;
        setDbActionBusy(key);
        setFlash(null);
        try {
          const res = await rpcWrite('dbMaintain', { action, ...extra });
          if (!alive.current) return;
          if (action === 'backup') {
            setFlash({ kind: 'ok', text: t('db.backupOk', { path: res.backupPath, size: fmtBytes(res.bytes) }) });
          } else if (action === 'vacuum') {
            setFlash({ kind: 'ok', text: t('db.vacuumOk', { before: fmtBytes(res.beforeBytes), after: fmtBytes(res.afterBytes) }) });
            void loadDbOverview();
          } else if (action === 'purgeTrash') {
            setFlash({ kind: 'ok', text: t('db.purgeOk', { n: fmtNum(res.purged) }) });
            void loadDbOverview();
            void loadStatus();
          } else if (action === 'exportSession') {
            const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `verbatim-${shortSid(extra.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setFlash({
              kind: 'ok',
              text: t('db.exportOk', {
                msgs: fmtNum(res.counts ? res.counts.msgs : 0),
                notes: fmtNum(res.counts ? res.counts.notes : 0),
              }),
            });
          } else if (action === 'clearSession') {
            const del = res.deleted || {};
            setFlash({
              kind: 'ok',
              text: t('db.clearSessionOk', {
                msgs: fmtNum(del.msgs ?? 0),
                scenes: fmtNum(del.scenes ?? 0),
                notes: fmtNum(del.notes ?? 0),
              }),
            });
            void loadDbOverview();
            void loadStatus();
            if (extra.sessionId && extra.sessionId === dbSession) {
              void loadDbRows({ sessionId: dbSession, page: 0 });
            }
          }
        } catch (e) {
          if (alive.current) setFlash({ kind: 'err', text: t('db.actionFail', { err: msgOf(e) }) });
        } finally {
          if (alive.current) setDbActionBusy('');
        }
      };

      const triggerDbSessionIndex = async (targetSid, targetScope = 'incremental', extra = {}) => {
        if (!targetSid) return;
        const pollRun = ++dbPollSeq.current;
        if (dbTaskTimer.current) {
          clearTimeout(dbTaskTimer.current);
          dbTaskTimer.current = null;
        }
        setDbActionBusy(`${targetScope}:${targetSid}`);
        setFlash(null);
        setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'running', progress: null, detail: '', error: null });
        let taskId = null;
        try {
          const res = await rpcWrite('rebuild', { sessionId: targetSid, scope: targetScope, ...extra });
          if (!alive.current || dbPollSeq.current !== pollRun) return;
          taskId = res && typeof res.taskId === 'string' ? res.taskId : null;
          if (!taskId) throw new Error(t('index.noTaskId'));
          setDbTask({
            sessionId: targetSid,
            scope: targetScope,
            phase: 'running',
            progress: normalizeTaskProgress(res.progress),
            detail: '',
            error: null,
          });
        } catch (e) {
          if (alive.current && dbPollSeq.current === pollRun) {
            setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: null, detail: '', error: msgOf(e) });
            setDbActionBusy('');
          }
          return;
        }

        const poll = async () => {
          if (!alive.current || dbPollSeq.current !== pollRun) return;
          try {
            const task = await rpcRead('task', { taskId });
            if (!alive.current || dbPollSeq.current !== pollRun) return;
            const prog = normalizeTaskProgress(task && task.progress);
            if (task.state === 'done') {
              const r = task.result || {};
              const parts = [];
              if (r.synced > 0) parts.push(t('index.resultSynced', { n: fmtNum(r.synced) }));
              if (r.indexed > 0) parts.push(t('index.resultIndexed', { n: fmtNum(r.indexed) }));
              if (r.scenes > 0) parts.push(t('index.resultScenes', { n: fmtNum(r.scenes) }));
              if (r.skipped) parts.push(r.skipped);
              if (parts.length === 0) parts.push(t('index.syncUpToDate'));
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'done', progress: prog, detail: parts.join(' · '), error: null });
              setDbActionBusy('');
              void loadDbOverview();
              if (targetSid === sessionId) {
                void loadStatus();
                if (targetScope === 'scene') void loadDays();
              }
              return;
            }
            if (task.state === 'failed') {
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: prog, detail: '', error: pickStr(task.error) ?? '—' });
              setDbActionBusy('');
              return;
            }
            setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'running', progress: prog, detail: '', error: null });
          } catch (e) {
            if (alive.current && dbPollSeq.current === pollRun) {
              setDbTask({ sessionId: targetSid, scope: targetScope, phase: 'error', progress: null, detail: '', error: msgOf(e) });
              setDbActionBusy('');
            }
            return;
          }
          if (alive.current && dbPollSeq.current === pollRun) {
            dbTaskTimer.current = setTimeout(poll, REBUILD_POLL_MS);
          }
        };
        dbTaskTimer.current = setTimeout(poll, 350);
      };

      const runDbSql = async (sqlOverride) => {
        const sqlText = typeof sqlOverride === 'string' ? sqlOverride : dbSql;
        if (!sqlText || !sqlText.trim()) return;
        setDbSqlBusy(true);
        setDbSqlErr(null);
        try {
          const res = await rpcWrite('dbQuery', { sql: sqlText, limit: 100 });
          if (!alive.current) return;
          setDbSqlRes(res);
        } catch (e) {
          if (!alive.current) return;
          setDbSqlRes(null);
          setDbSqlErr(msgOf(e));
        } finally {
          if (alive.current) setDbSqlBusy(false);
        }
      };

      function renderDb() {
        return h(DbTabView, {
          t, locale, sessionId, useSessions: props.useSessions,
          dbSubTab, setDbSubTab, dbOverview, dbOverviewBusy,
          dbSession, setDbSession, dbTable, setDbTable,
          dbWindowKind, setDbWindowKind, dbVecFilter, setDbVecFilter,
          dbFilter, setDbFilter, dbPage, setDbPage,
          dbPageInput, setDbPageInput, dbRowsData, dbRowsBusy,
          dbExpandedRow, setDbExpandedRow, dbTask, dbActionBusy,
          dbSql, setDbSql, dbSqlBusy, dbSqlRes, dbSqlErr,
          copiedKey, handleCopy, loadDbOverview, loadDbRows,
          runDbMaintain, triggerDbSessionIndex, runDbSql,
          jumpToTimeline, setTab,
        });
      }

      /* ---------- 组装 ---------- */

      if (sessionId === null) {
        return h('div', { style: { ...S.root, padding: 12 } },
          h('div', { style: S.emptyCard }, t('common.noSession')));
      }

      // 六个页面：概览 / 搜索 / 时间轴 / 笔记 / 核对 / 库管理
      const tabIds = ['overview', 'search', 'timeline', 'notes', 'verify', 'db'];

      const tabbar = h('div', { style: S.tabbar, role: 'tablist' },
        ...tabIds.map((id) => h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === id,
          style: tab === id ? { ...S.tab, ...S.tabActive } : S.tab,
          onClick: () => setTab(id),
        },
          t(`tab.${id}`),
          id === 'verify' && flagsErr !== null
            ? h('span', { style: S.tabBadge }, '!')
            : id === 'verify' && flags.length > 0
              ? h('span', { style: S.tabBadge }, String(flags.length))
              : null)));

      const reloadTab = () => {
        if (tab === 'overview') { void refresh(); return; }
        if (tab === 'search') { void runSearch(); return; }
        if (tab === 'db') {
          void loadDbOverview();
          if (dbSubTab === 'browse') void loadDbRows();
          return;
        }
        if (tab === 'timeline') void loadDays();
        else if (tab === 'notes') {
          if (notesView === 'trash') void loadDeletedNotes();
          else void loadNotes();
        } else void loadFlags();
      };

      // 标签页读取失败：错误带显示在内容**上方**，不替换已有内容（更早几天读失败不该清屏）
      const tabContent = h('div', { key: tab, className: 'dvp-tab-in' },
        tabErr !== null
          ? h('div', { style: { ...S.errorCard, marginBottom: 8 } },
            h('div', null, tabErr),
            h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btn, onClick: reloadTab }, t('common.retry'))))
          : null,
        tab === 'overview' ? renderOverview()
          : tab === 'search' ? renderSearch()
            : tab === 'timeline' ? renderTimeline()
              : tab === 'notes' ? renderNotes()
                : tab === 'db' ? renderDb()
                  : renderVerify());

      const bodyInner = h('div', { style: { maxWidth: 820, width: '100%', margin: '0 auto' } },
        flash
          ? h('div', {
            style: {
              ...(flash.kind === 'ok' ? S.flashOk : flash.kind === 'warn' ? S.flashWarn : S.flashErr),
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 8,
            },
          },
            h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, flash.text),
            h('button', {
              type: 'button',
              style: { appearance: 'none', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontSize: FS.md },
              onClick: () => setFlash(null),
              'aria-label': t('common.cancel'),
            }, '×'))
          : null,

        tab === 'db'
          ? tabContent
          : emptyKind !== null
          // 空态只在概览页展开（2026-11-18，A4 BUG 12）：
          // 之前四个 tab 内容完全一样、点了没反应 —— 看起来像坏了。
          // 现在概览页给完整空态卡（含能直接救场的按钮），其他页只说「先让它有东西」。
          ? (tab === 'overview'
            ? renderEmptyCard()
            : h('div', { style: S.emptyCard },
              h('div', null, t('empty.otherTab')),
              h('div', { style: S.actions },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => setTab('overview'),
                }, t('empty.goOverview')))))
          : loadErr !== null
            ? h('div', null,
              h('div', { style: S.errorCard },
                t('common.failed'),
                h('div', { style: S.errDetail }, loadErr)),
              h('div', { style: S.actions },
                h('button', { type: 'button', style: S.btn, onClick: refresh }, t('common.retry'))))
            : tabContent);

      const body = h('div', {
        ref: bodyRef,
        style: S.body,
        role: 'tabpanel',
        onScroll: (e) => {
          const top = e.currentTarget ? e.currentTarget.scrollTop : 0;
          setShowBackTop(top > 260);
        },
      },
        bodyInner,
        showBackTop
          ? h('button', {
            type: 'button',
            style: S.backTopBtn,
            title: t('common.backTop'),
            'aria-label': t('common.backTop'),
            onClick: () => {
              if (bodyRef.current && typeof bodyRef.current.scrollTo === 'function') {
                bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
              }
            },
          }, '↑')
          : null);

      return h('div', {
        style: S.root,
        'data-dsh-verbatim': '',
        onKeyDown: (e) => {
          const tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
          const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
          if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
            e.preventDefault();
            openSearchTab();
          }
        },
      },
        // 动画样式表（内联 style 写不了 keyframes / :hover），全部限定在 [data-dsh-verbatim] 子树内
        h('style', null,
          // 不确定进度条
          '@keyframes dvp-run{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}'
          // 列表项滑入：往下走 + 淡入（时间流动感）
          + '@keyframes dvp-slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}'
          // 整个展开块的淡入
          + '@keyframes dvp-fade{from{opacity:0}to{opacity:1}}'
          // 标签页切换轻柔进入（180ms）
          + '@keyframes dvp-tab-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'
          // 时间线节点脉冲
          + '@keyframes dvp-node{0%{box-shadow:0 0 0 0 ' + BRAND + '}'
          + '70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}'
          // 竖线「画下来」
          + '@keyframes dvp-spine{from{transform:scaleY(0)}to{transform:scaleY(1)}}'
          // 骨架屏 shimmer
          + '@keyframes dvp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'
          // 跳转定位命中消息脉冲发光
          + '@keyframes dvp-flash-hit{'
          + '0%{background:color-mix(in srgb,' + BRAND + ' 24%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,' + BRAND + ' 45%,transparent)}'
          + '45%{background:color-mix(in srgb,' + BRAND + ' 16%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,' + BRAND + ' 18%,transparent)}'
          + '100%{background:color-mix(in srgb,' + BRAND + ' 6%,transparent);box-shadow:0 0 0 0 transparent}}'
          + '[data-dsh-verbatim] .dvp-slide{animation:dvp-slide .24s cubic-bezier(.2,.7,.3,1) both}'
          + '[data-dsh-verbatim] .dvp-fade{animation:dvp-fade .2s ease both}'
          + '[data-dsh-verbatim] .dvp-tab-in{animation:dvp-tab-in .18s cubic-bezier(.2,.7,.3,1) both}'
          + '[data-dsh-verbatim] .dvp-node{animation:dvp-node .9s ease-out both}'
          + '[data-dsh-verbatim] .dvp-spine{animation:dvp-spine .3s ease-out both;transform-origin:top}'
          + '[data-dsh-verbatim] .dvp-spine::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:1px;'
          + 'background:linear-gradient(180deg,rgba(90,115,156,.46),rgba(210,125,125,.28) 65%,transparent);pointer-events:none}'
          + '[data-dsh-verbatim] .dvp-flash-hit{animation:dvp-flash-hit 2.2s ease-out both;border-radius:' + RADIUS_SM + '}'
          + '[data-dsh-verbatim] .dvp-shimmer{background:linear-gradient(90deg,'
          + 'var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)) 25%,'
          + 'var(--dsw-alias-bg-layer-1,rgba(128,128,128,.22)) 50%,'
          + 'var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)) 75%);'
          + 'background-size:200% 100%;animation:dvp-shimmer 1.4s ease-in-out infinite}'
          + '[data-dsh-verbatim] .dvp-card{transition:border-color .16s ease,background-color .16s ease}'
          + '[data-dsh-verbatim] .dvp-card:hover{border-color:' + BORDER_STRONG + '}'
          + '@media (prefers-reduced-motion:reduce){'
          + '[data-dsh-verbatim] .dvp-running{animation:none!important;width:100%!important;opacity:.45}'
          + '[data-dsh-verbatim] .dvp-slide,[data-dsh-verbatim] .dvp-fade,[data-dsh-verbatim] .dvp-tab-in,'
          + '[data-dsh-verbatim] .dvp-node,[data-dsh-verbatim] .dvp-spine{animation:none!important;opacity:1!important;transform:none!important}'
          + '[data-dsh-verbatim] .dvp-shimmer{animation:none!important;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}'
          + '[data-dsh-verbatim] .dvp-flash-hit{animation:none!important;background:color-mix(in srgb,' + BRAND + ' 12%,transparent);'
          + 'box-shadow:inset 0 0 0 1px color-mix(in srgb,' + BRAND + ' 45%,transparent)}}'),
        // 头部只留标题 + 刷新（开关/统计/索引已经进「概览」页了）
        h('div', { style: S.head }, renderTitle()),
        tabbar,
        body);
    }

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

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-verbatim: dictionaries');

        // ② 交互态样式表（2026-11-18）
        //
        // React 内联样式写不了 :hover / :focus-visible，而"按钮点上去没反应"
        // 是 UX 优先级最高的一类问题。所以注入一小段全局 CSS，只作用于
        // [data-dsh-verbatim] 子树 —— 不会漏到宿主页面其他地方。
        //
        // 覆盖：hover、focus-visible（键盘可达）、active、disabled、
        //      以及 prefers-reduced-motion（系统开了减少动效就全关掉）。
        ctx.effect(() => injectStyle(`dsh-verbatim-interaction`, `
          @keyframes dvp-run {
            0% { transform: translateX(-100%); }
            50% { transform: translateX(120%); }
            100% { transform: translateX(300%); }
          }
          @keyframes dvp-shimmer {
            0% { opacity: .45; }
            50% { opacity: .85; }
            100% { opacity: .45; }
          }
          @keyframes dvp-fade {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes dvp-slide {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes dvp-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: .55; transform: scale(0.88); }
          }
          [data-dsh-verbatim] .dvp-fade { animation: dvp-fade .18s ease-out both; }
          [data-dsh-verbatim] .dvp-slide { animation: dvp-slide .22s ease-out both; }
          [data-dsh-verbatim] .dvp-dot-live { animation: dvp-pulse 2.4s ease-in-out infinite; }
          [data-dsh-verbatim] .dvp-card {
            transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
          }
          [data-dsh-verbatim] .dvp-card:hover {
            border-color: var(--dsw-alias-border-l3, rgba(128,128,128,.4)) !important;
            box-shadow: 0 3px 10px rgba(0,0,0,.05) !important;
          }
          [data-dsh-verbatim] .dvp-kpi:hover {
            transform: translateY(-1px);
          }
          [data-dsh-verbatim] .dvp-search-wrap:focus-within {
            border-color: var(--dsw-alias-state-business-primary, #4d6bfe) !important;
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent) !important;
          }
          [data-dsh-verbatim] .dvp-msg-card .dvp-msg-actions {
            opacity: 0.45;
            transition: opacity .15s ease;
          }
          [data-dsh-verbatim] .dvp-msg-card:hover .dvp-msg-actions,
          [data-dsh-verbatim] .dvp-msg-card:focus-within .dvp-msg-actions {
            opacity: 1;
          }
          [data-dsh-verbatim] .dvp-shimmer {
            background: var(--dsw-alias-bg-l2, rgba(128,128,128,.16));
            animation: dvp-shimmer 1.3s ease-in-out infinite;
          }
          [data-dsh-verbatim] button { transition: ${T}; }
          [data-dsh-verbatim] button:focus:not(:focus-visible) { outline: none; }
          [data-dsh-verbatim] button:hover:not(:disabled) { opacity: 0.86; }
          [data-dsh-verbatim] button:active:not(:disabled) { transform: translateY(0.5px); }
          [data-dsh-verbatim] button:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: 2px;
          }
          [data-dsh-verbatim] button:disabled {
            opacity: .5;
            cursor: default;
            filter: none;
            transform: none;
          }
          /* 键盘焦点在输入框上也要看得见 */
          [data-dsh-verbatim] input:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: 1px;
          }
          /* 可点的整行/卡片：有 hover 才让人知道能点 */
          [data-dsh-verbatim] [data-clickable="1"] { transition: ${T}; cursor: pointer; }
          [data-dsh-verbatim] [data-clickable="1"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.07)); }
          [data-dsh-verbatim] [data-clickable="1"]:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: -2px;
          }
          /* 滚动条：细一点，别抢戏 */
          [data-dsh-verbatim] ::-webkit-scrollbar { width: 8px; height: 8px; }
          [data-dsh-verbatim] ::-webkit-scrollbar-thumb {
            background: var(--dsw-alias-border-l3, rgba(128,128,128,.32));
            border-radius: 4px;
          }
          [data-dsh-verbatim] ::-webkit-scrollbar-track { background: transparent; }

          @media (prefers-reduced-motion: reduce) {
            [data-dsh-verbatim] * {
              transition-duration: 0.01ms !important;
              animation-duration: 0.01ms !important;
            }
            [data-dsh-verbatim] button:active:not(:disabled) { transform: none; }
          }
        `), 'dsh-verbatim: interaction css');

        // ① 面板类型（决定它出现在「开始」页的工具列表里，也决定 tab 标题）
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'verbatim',
            order: 40,
            title: () => t('title'),
            description: () => t('description'),
            icon: (iconProps) => h(Glyph, { size: (iconProps && iconProps.size) || 22 }),
          }],
        }), 'dsh-verbatim: tab type');

        // ② 面板正文：session 作用域，inject 拿到的第一个参数就是 sessionId
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, PanelSeat)), 'dsh-verbatim: tab body');

        // ③ tab 条上的标题（带图标，语言切换时会重新渲染）
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, TabTitle)), 'dsh-verbatim: tab title');

        // ④ 设置页：全局配置（默认开关 + 模型 + 检索参数）
        //    不放在右侧面板里，因为它是**全局**的，不属于任何一个对话。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'verbatim',
          order: 900,
          label: () => t('settings.nav'),
          locale: NS,
        }, (props) => h(SettingsPanel, { ...props, t: (props && props.t) || t }))), 'dsh-verbatim: settings section');
      },
    };
  },
});
