# Changelog

All notable changes to `dsh-verbatim` are documented here.

## [0.1.0] - 2026-11-23

### Companion-First Memory & Retrieval
- **Verbatim SQLite Storage**: Persists complete conversation history (including compacted turns) in local SQLite (`node:sqlite`, `FTS5`, optional `sqlite-vec` with cosine fallback) with strict per-session isolation and physical deletion on rewind.
- **Companion Dual-Granularity Pipeline**: Defaults new and rebuilt sessions to `exchange` → `thread` segmentation with 30-minute settle windows, scene merge/split locking, and timeline cluster folding.
- **Hybrid Search + Optional Rerank**: Parallel keyword (`FTS5` trigram + 2-char CJK `LIKE`) and multi-granularity vector KNN fused via RRF (`k = 60`), with candidate pool expansion (`perRoute >= 24`) when `/rerank` is enabled.
- **Media Attachments & Captions**: Extracts attachment metadata (`sha256:` / local path / URL), resolves host attachment paths and user captions directly inside `memory_search` results, and supports inline preview & caption editing in the Library view.

### Agent Tools & Privacy Hardening
- **3-Tool Minimalist Surface**: Exposes `memory_search`, `memory_remember`, and `memory_forget` returning clean, compact plain-text dialogue blocks (`Speaker: text`).
- **Strict Exclusion Boundary**: Removed `includeExcluded` from the Agent tool schema and hints; excluded ranges and muted messages are only accessible to the user in the host UI.
- **Trash Discoverability**: `memory_search(scope='note')` surfaces recoverable trash note IDs so `memory_forget(restore: true)` is reachable.
- **Live Tool Hot-Reload**: Toggling `tools` in the panel immediately re-registers tools on active host agents without restarting.

### Material 3 Companion UI
- **6 Sidebar Tabs**: Overview (Hero sanctuary card, tonal KPI tiles, 38px circular Recall Readiness gauge, collapsible diagnostics), Search, Timeline (chat-bubble styling with hover-reveal actions), Notes (color-coded by ownership, duplicate merge, 30-day trash), Verify, and Library (session overview with 2-step delete, data browser with media caption editor, read-only SQL).
- **5 Global Settings Tabs**: General & Retrieval (with 3-step interactive Setup Guide), Sessions, Embedding (local service auto-probe + dimension detection), Rerank, and optional Summary LLM.
