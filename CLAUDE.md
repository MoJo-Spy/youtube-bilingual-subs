# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Type

Chrome MV3 extension, **pure source / no build step**. Plain JS, no `package.json`, no bundler, no test runner, no lint config. Editing a `.js` / `.css` / `.html` file and reloading the extension in `chrome://extensions/` is the entire dev loop.

## Common Commands

There are no `npm` / `pnpm` / `make` targets. Workflow is manual:

- **Reload extension after edits**: `chrome://extensions/` → toggle Developer mode → Reload on the extension card.
- **Inspect content/inject scripts**: open YouTube DevTools console; logs are prefixed `[YTBS]`.
- **Inspect service worker**: `chrome://extensions/` → "Inspect views: service worker" link on the extension card. Note that the worker sleeps; logs disappear when it's evicted.
- **Reset cached translations**: in DevTools on a YouTube tab, `chrome.storage.local.clear()`. Cache entries use the prefix `ytbs_c2_` — bump this prefix in `background.js` (`CACHE_PREFIX`) to force a one-shot invalidation across users without deleting their settings (which live in `chrome.storage.sync`).
- **Test API connection**: extension popup → Open settings → "Test connection" button (calls `${baseURL}/chat/completions` with a 10-token `"Reply with just: OK"` probe).
- **Test end-to-end**: open any YouTube watch page that has CC available; the in-overlay badge (`#ytbs-badge`) reports state — `Waiting for caption URL…` → `N sentences — translating…` → `Ready ✓`.

## Architecture

Four runtime contexts cooperate. Boundary discipline matters because each context has a different `chrome.*` API surface and different access to the page DOM.

### 1. `inject.js` — MAIN world page hook

Loaded by `manifest.json` with `"world": "MAIN"` at `document_start`. **Cannot use any `chrome.*` API.** Patches `window.fetch` and `XMLHttpRequest.prototype.open/send` to capture two YouTube endpoints:

- `/api/timedtext` → posts the raw caption body via `window.postMessage({ __ytbs: true, type: 'YT_CAPTIONS', url, body })`.
- `/youtubei/v1/player` → extracts `captions.playerCaptionsTracklistRenderer.captionTracks` and posts a `YT_PLAYER_DATA` message with available languages.

Also polls `window.ytInitialPlayerResponse` for ~10 s on first load to handle the case where the player data is already present before hooks are installed.

### 2. `content.js` — isolated-world content script

Runs at `document_start` on `youtube.com`. Has access to `chrome.runtime` / `chrome.storage` but lives in an isolated world (cannot see `window.ytInitialPlayerResponse`). Responsibilities:

1. **Inject `inject.js`** by appending a `<script src=chrome.runtime.getURL('inject.js')>` (legacy path; the manifest also declares it as a MAIN-world content script — both code paths exist for resilience).
2. **PerformanceObserver fallback** — independently watches all resource loads for `/api/timedtext` URLs. This works even if `inject.js` is older than expected or its hooks were beaten to the punch by buffered loads (`buffered: true` replays past entries).
3. **Parse captions** — `parseTimedText()` accepts both `json3` (`data.events[].segs[].utf8`) and the legacy XML format. Always re-fetches the caption URL with `&fmt=json3` forced.
4. **Sentence grouping** — `groupIntoSentences()` merges raw caption segments into sentence-sized chunks. Splits on terminal punctuation (`SENTENCE_END_RE`), inter-segment gap ≥ `GROUP_GAP_SPLIT_MS` (1200 ms), or overflow of `GROUP_MAX_DUR_MS` / `GROUP_MAX_CHARS`. **This is the unit of translation and display, not the raw segment.**
5. **Near-playhead priority batching** — `pickNextBatch()` finds the first untranslated group within 5 s of `video.currentTime`, batches up to `BATCH_SIZE` (20) groups, and includes `CONTEXT_BEFORE` / `CONTEXT_AFTER` (3 each) untranslated *or* translated neighbors as context-only hints (the model is told not to translate them).
6. **Overlay rendering** — `#ytbs-overlay` is appended into `#movie_player`; `updateOverlay()` runs on `timeupdate` and uses binary search (`findActiveGroup`) to map `currentTime` → group.
7. **SPA navigation** — listens for `yt-navigate-finish` and calls `resetForNewVideo()` to clear groups + restart the wait-for-URL state machine.

### 3. `background.js` — service worker

Single message handler: `TRANSLATE_BATCH`. Pipeline:

1. **Cache lookup** — `cacheKeyFor(videoId, model, lang, lineId, text)` SHA-1 hashes all five fields together. Including `text` in the key means an edited caption automatically misses the cache. The `ytbs_c2_` prefix was bumped from `ytbs_c_` when context-aware prompts were introduced; bump it again whenever prompt semantics change in a way that would invalidate prior translations.
2. **Prompt assembly** — builds a numbered list of lines to translate with `Previous lines (context only)` and `Upcoming lines (context only)` blocks. The system prompt requires JSON output `{"1":"译文一","2":"译文二"}`.
3. **API call** — `POST ${baseURL}/chat/completions` with `temperature: 0.2`. Any OpenAI-compatible endpoint works (OpenAI, Ollama `/v1`, vLLM, LM Studio, custom gateway).
4. **Tolerant JSON parse** — strips ` ```json ` fences, falls back to extracting the first `{...}` block. Lossy on non-strict servers (some lines may be missing, surfaced as "Partial: N/M" in the badge).
5. **Cache write** — only successfully translated lines are stored.

### 4. `options.html` / `options.js` + `popup.html` / `popup.js`

Settings live in `chrome.storage.sync` under five keys: `baseURL`, `apiKey`, `model`, `targetLang`, `enabled`. The popup only toggles `enabled` and surfaces an "API key not set" warning. Both pages share the same `DEFAULTS` object — keep them in sync if adding a field.

## Cross-Cutting Conventions

- **Logging**: console-prefix is `[YTBS]`. The on-screen `#ytbs-badge` is the user-visible status surface; use `setStatus(text, kind, autoHideMs)` rather than alerting.
- **Module boundaries**:
  - `inject.js` ⇄ `content.js`: only via `window.postMessage` with an `__ytbs: true` discriminator.
  - `content.js` ⇄ `background.js`: only via `chrome.runtime.sendMessage`.
  - Never call `chrome.*` from `inject.js` (it has no access).
- **State scope**: `chrome.storage.sync` for user settings (synced across devices, ~100 KB cap), `chrome.storage.local` for translation cache (unbounded, per-device).
- **Host permissions**: `manifest.json` currently uses `<all_urls>` so user-supplied API hosts (Ollama, custom gateways, etc.) work without re-prompting. Narrowing this would break that flexibility but is required before Chrome Web Store submission — see README "Tighter host permission".

## Known Subtleties

- **Live streams are unsupported** — they use a different `/api/timedtext` format that `parseTimedText()` won't recognize. Don't add fallbacks here without designing for the streaming case explicitly.
- **The `tryTriggerCC()` shim** clicks the YouTube CC button after 4 s if no caption URL has been observed. It only fires once per video (`ccTriggerTried`).
- **Cache key includes the source text** — renaming a caption (e.g., YouTube re-transcoding) is treated as a new line, not a stale entry. This is intentional.
- **`BATCH_SIZE` trade-off** — bigger batches reduce per-call overhead and give the model more context (better fragment continuity), but increase first-paint latency for the active group. Tune in `content.js`, not `background.js`.
- **README references `BATCH = 20`** — the actual constant is `BATCH_SIZE` in `content.js`. If renaming, update the README.

## Product Direction (locked 2026-04-26 via consensus)

Two-flagship consensus (GPT-5.4 + Gemini-2.5-Pro) locked the following positioning. Treat this as authoritative — **do not drift from it without re-running consensus**.

- **Slogan**: *Your model, your YouTube — bilingual subtitles + selection translation, all BYOK.*
- **Target user**: AI/software developers, researchers, Ollama / vLLM / LM Studio users. Not language learners, not追剧 users.
- **Scope (locked)**:
  - Video subtitle translation on YouTube only (current behaviour, recorded videos with CC)
  - Selection translation on `youtube.com` only (comments, descriptions, channel pages, search). **Not** `<all_urls>`. **Not** evaluation-only-comment-area.
  - BYOK only (any OpenAI-compatible endpoint). No built-in free engine, no SaaS proxy.
- **Out of scope (locked)**: other video platforms, learning features (dictionary / Anki / grammar / pronunciation), PiP, web/PDF translation, speech-to-subtitle.
- **12-month targets**: CWS install 8k–25k, DAU 700–1,800, 30-day retention 25–40%.
- **Trust labels (must preserve through migration)**: BYOK, minimal permissions, auditable. Build artifacts must be unminified with sourcemaps; reproducible build via GitHub Actions.

## Planned Tech Stack Migration

Current pure-JS no-build stack will migrate to **WXT + TypeScript + Preact + @preact/signals + Tailwind v4**. Full plan lives in `docs/wxt-migration-plan.md` — open that file before any architectural change. Key decisions:

- **Framework**: WXT (Vite-based, framework-agnostic, best SW HMR). Plasmo and CRXJS rejected (maintenance concerns).
- **UI library**: Preact + signals + Tailwind v4. Radix Primitives via `preact/compat` alias. Not shadcn/ui (too heavy for a translation tool).
- **Design tokens**: defined in `docs/wxt-migration-plan.md` § 4 (light + dark + overlay-always-dark scopes).
- **Permission narrowing**: `<all_urls>` → `optional_host_permissions` (requested at first save of custom baseURL).
- **Auditability preservation**: `vite.build.minify = false`, sourcemap enabled, README must include "Build from source" + SHA-256 verification steps.

## When Editing

- Manifest changes (`manifest.json`) require a full extension reload, not just a tab refresh.
- `inject.js` changes require closing and reopening the YouTube tab — the page-world script is only injected on initial load.
- `content.js` / `background.js` / CSS changes are picked up by the standard "Reload" button on the extension card.
- The `version` field in `manifest.json` is the only version source; there's no `package.json` to keep in sync.
