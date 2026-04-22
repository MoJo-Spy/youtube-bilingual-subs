// Content script — runs in isolated world on youtube.com.
// v0.5.0: sentence-level grouping. Caption segments from YouTube are merged
// into sentence-sized chunks before translation and display.

(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);


  // ---------------------------------------------------------------------------
  // Self-scan via PerformanceObserver — works without depending on inject.js's
  // scanPerformance() being present (some users may have an older inject.js).
  // The observer fires for every resource load (including past ones with
  // buffered:true), so we catch /api/timedtext URLs YouTube fetches without
  // any postMessage dance.
  // ---------------------------------------------------------------------------
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name && e.name.includes('/api/timedtext')) {
          // handleTimedTextUrl is defined later but hoisted via function
          // declaration at the bottom of the IIFE; safe to call here once
          // captions arrive at runtime.
          handleTimedTextUrl(e.name, 'observer');
        }
      }
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch (_) {}

  // Tunables
  const BATCH_SIZE = 20;
  const CONTEXT_BEFORE = 3;
  const CONTEXT_AFTER = 3;

  const GROUP_MAX_DUR_MS = 8000;   // max duration of a merged group
  const GROUP_MAX_CHARS = 140;     // max character count of a merged group
  const GROUP_GAP_SPLIT_MS = 1200; // split when inter-segment gap >= this
  const SENTENCE_END_RE = /[.!?。！？…][\s)"'』」]*$/;

  // State — now groups, not raw segments
  let groups = [];            // [{start, end, text, translated?}]
  let currentVideoId = null;
  let currentLangCode = null;
  let tracksForVideo = [];
  let usedUrl = null;
  let overlay = null;
  let badge = null;
  let video = null;
  let translating = false;
  let enabled = true;
  let waitTimer = null;
  let badgeHideTimer = null;
  let ccTriggerTried = false;

  chrome.storage.sync.get({ enabled: true }).then(cfg => { enabled = cfg.enabled; });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (!enabled && overlay) overlay.innerHTML = '';
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__ytbs) return;
    if (d.type === 'YT_TIMEDTEXT_URL') handleTimedTextUrl(d.url, d.source);
    else if (d.type === 'YT_TRACKS') handleTracks(d);
  });

  function handleTracks(d) {
    if (d.videoId && d.videoId === currentVideoId && tracksForVideo.length) return;
    tracksForVideo = d.tracks || [];
    console.log('[YTBS] tracks:', tracksForVideo.map(t => t.languageCode + (t.kind === 'asr' ? '(auto)' : '')).join(', '));
    if (!tracksForVideo.length) setStatus('No subtitle tracks on this video', 'warn', 8000);
  }

  async function handleTimedTextUrl(url, source) {
    if (!enabled) return;
    if (url === usedUrl && groups.length) return;
    console.log('[YTBS] timedtext URL from', source);

    try {
      const u = /[?&]fmt=/.test(url) ? url.replace(/([?&])fmt=[^&]*/, '$1fmt=json3') : url + '&fmt=json3';
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) { setStatus(`Track fetch failed: ${res.status}`, 'err'); return; }
      const body = await res.text();
      if (!body.length) { setStatus('Empty caption body', 'warn'); return; }
      usedUrl = url;
      try { currentLangCode = new URL(url).searchParams.get('lang'); } catch (_) {}
      handleCaptionsBody(body);
    } catch (err) {
      setStatus('Fetch error: ' + err.message, 'err');
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing + sentence grouping
  // ---------------------------------------------------------------------------
  function parseTimedText(body) {
    if (!body) return [];
    try {
      const data = JSON.parse(body);
      if (data && Array.isArray(data.events)) {
        const out = [];
        for (const ev of data.events) {
          if (!ev.segs || !Array.isArray(ev.segs)) continue;
          const text = ev.segs.map(seg => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          out.push({ start: ev.tStartMs || 0, dur: ev.dDurationMs || 3000, text });
        }
        return out;
      }
    } catch (_) {}
    try {
      const doc = new DOMParser().parseFromString(body, 'text/xml');
      const nodes = doc.querySelectorAll('text');
      if (nodes.length) {
        return Array.from(nodes).map(n => ({
          start: parseFloat(n.getAttribute('start') || '0') * 1000,
          dur: parseFloat(n.getAttribute('dur') || '2') * 1000,
          text: decodeHtml(n.textContent || '').replace(/\s+/g, ' ').trim()
        })).filter(c => c.text);
      }
    } catch (_) {}
    return [];
  }

  function decodeHtml(s) {
    const e = document.createElement('textarea');
    e.innerHTML = s;
    return e.value;
  }

  /**
   * Merge consecutive raw segments into sentence-sized groups.
   * Splits when:
   *   - current group text ends with terminal punctuation
   *   - inter-segment gap exceeds GROUP_GAP_SPLIT_MS
   *   - merging would exceed GROUP_MAX_DUR_MS or GROUP_MAX_CHARS
   */
  function groupIntoSentences(segments) {
    if (!segments.length) return [];
    const out = [];
    let cur = null;

    const shouldCloseBefore = (next) => {
      if (!cur) return false;
      if (SENTENCE_END_RE.test(cur.text)) return true;
      if ((next.start - cur.end) >= GROUP_GAP_SPLIT_MS) return true;
      // "Would this merge overflow?" — close pre-emptively instead
      const newDur = (next.start + next.dur) - cur.start;
      const newLen = cur.text.length + 1 + next.text.length;
      if (newDur > GROUP_MAX_DUR_MS || newLen > GROUP_MAX_CHARS) return true;
      return false;
    };

    for (const seg of segments) {
      if (cur && shouldCloseBefore(seg)) {
        out.push(cur);
        cur = null;
      }
      if (!cur) {
        cur = { start: seg.start, end: seg.start + seg.dur, text: seg.text };
      } else {
        cur.end = seg.start + seg.dur;
        // Join with space unless previous ended with a hyphen (word break)
        const joiner = /[-–—]$/.test(cur.text) ? '' : ' ';
        cur.text = cur.text + joiner + seg.text;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function handleCaptionsBody(body) {
    const segments = parseTimedText(body);
    console.log('[YTBS] parsed', segments.length, 'raw segments');
    if (!segments.length) { setStatus('Captions empty after parse', 'warn'); return; }

    const grouped = groupIntoSentences(segments);
    console.log('[YTBS] grouped into', grouped.length, 'sentences (from', segments.length, 'segments)');

    const videoId = getVideoId();
    if (videoId === currentVideoId && groups.length === grouped.length) return;
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }

    currentVideoId = videoId;
    groups = grouped;
    const langLabel = currentLangCode ? ` [${currentLangCode}]` : '';
    setStatus(`${groups.length} sentences${langLabel} — translating…`, 'info');
    ensureOverlay();
    translationLoop();
  }

  function getVideoId() {
    try { return new URL(location.href).searchParams.get('v'); } catch (_) { return null; }
  }

  function tryTriggerCC() {
    if (ccTriggerTried) return;
    ccTriggerTried = true;
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return;
    if (btn.getAttribute('aria-pressed') !== 'true') {
      setStatus('Enabling CC to load captions…', 'info');
      btn.click();
    }
  }

  // ---------------------------------------------------------------------------
  // Near-playhead priority batching
  // ---------------------------------------------------------------------------
  function pickNextBatch() {
    if (!groups.length) return null;
    const t = (video?.currentTime || 0) * 1000;

    let startIdx = -1;
    for (let i = 0; i < groups.length; i++) {
      if (!groups[i].translated && groups[i].start >= t - 5000) { startIdx = i; break; }
    }
    if (startIdx === -1) startIdx = groups.findIndex(g => !g.translated);
    if (startIdx === -1) return null;

    const picked = [];
    let lastIdx = startIdx;
    for (let i = startIdx; i < groups.length && picked.length < BATCH_SIZE; i++) {
      if (!groups[i].translated) { picked.push({ id: i, text: groups[i].text }); lastIdx = i; }
    }

    const ctxBefore = [];
    for (let i = startIdx - 1; i >= 0 && ctxBefore.length < CONTEXT_BEFORE; i--) {
      ctxBefore.unshift(groups[i].text);
    }
    const ctxAfter = [];
    for (let i = lastIdx + 1; i < groups.length && ctxAfter.length < CONTEXT_AFTER; i++) {
      ctxAfter.push(groups[i].text);
    }

    return { lines: picked, context_before: ctxBefore, context_after: ctxAfter };
  }

  async function translationLoop() {
    if (translating) return;
    translating = true;
    const videoId = currentVideoId;
    const total = groups.length;

    try {
      while (true) {
        if (videoId !== currentVideoId || !enabled) break;
        const batch = pickNextBatch();
        if (!batch) break;

        const done = groups.filter(g => g.translated).length;
        setStatus(`Translating ${done}/${total}…`, 'info');

        let response = null;
        try {
          response = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_BATCH',
            videoId,
            lines: batch.lines,
            context_before: batch.context_before,
            context_after: batch.context_after
          });
        } catch (e) {
          setStatus('Extension message failed — reload tab', 'err');
          break;
        }
        if (!response) continue;
        if (response.error) setStatus(response.error.slice(0, 80), 'err');
        if (response.translations) {
          for (const { id, text } of response.translations) {
            if (groups[id]) groups[id].translated = text;
          }
        }
      }
      const translated = groups.filter(g => g.translated).length;
      if (translated === total) setStatus(`Ready ✓  ${total} sentences`, 'ok', 3000);
      else if (translated) setStatus(`Partial: ${translated}/${total}`, 'warn', 5000);
    } finally {
      translating = false;
    }
  }

  function onSeek() {
    if (!translating && groups.length) translationLoop();
  }

  // ---------------------------------------------------------------------------
  // Overlay / display
  // ---------------------------------------------------------------------------
  function ensureOverlay() {
    const container = document.querySelector('#movie_player')
      || document.querySelector('.html5-video-container');
    if (!container) { setTimeout(ensureOverlay, 500); return; }

    if (!overlay || !container.contains(overlay)) {
      overlay = document.createElement('div');
      overlay.id = 'ytbs-overlay';
      container.appendChild(overlay);
    }
    ensureBadge(container);
    document.body.classList.add('ytbs-active');

    const v = document.querySelector('video');
    if (v && v !== video) {
      video = v;
      video.addEventListener('timeupdate', updateOverlay);
      video.addEventListener('seeking', () => { updateOverlay(); onSeek(); });
    }
  }

  function ensureBadge(container) {
    if (badge && container.contains(badge)) return;
    badge = document.createElement('div');
    badge.id = 'ytbs-badge';
    badge.style.display = 'none';
    container.appendChild(badge);
  }

  function setStatus(text, kind, autoHideMs) {
    ensureOverlay();
    if (!badge) return;
    if (badgeHideTimer) { clearTimeout(badgeHideTimer); badgeHideTimer = null; }
    badge.textContent = 'YTBS: ' + text;
    badge.dataset.kind = kind || 'info';
    badge.style.display = 'block';
    if (autoHideMs) {
      badgeHideTimer = setTimeout(() => { if (badge) badge.style.display = 'none'; }, autoHideMs);
    }
  }

  function findActiveGroup(t) {
    if (!groups.length) return null;
    let lo = 0, hi = groups.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = groups[mid];
      if (g.start > t) { hi = mid - 1; continue; }
      if (t < g.end) best = g;
      lo = mid + 1;
    }
    return best;
  }

  function updateOverlay() {
    if (!overlay || !video) return;
    if (!enabled) { overlay.innerHTML = ''; return; }
    const t = video.currentTime * 1000;
    const g = findActiveGroup(t);
    if (!g) { overlay.innerHTML = ''; return; }
    overlay.innerHTML =
      `<div class="ytbs-original">${escapeHtml(g.text)}</div>` +
      (g.translated ? `<div class="ytbs-translated">${escapeHtml(g.translated)}</div>` : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
    );
  }

  function resetForNewVideo() {
    groups = [];
    usedUrl = null;
    tracksForVideo = [];
    ccTriggerTried = false;
    currentLangCode = null;
    currentVideoId = getVideoId();
    if (overlay) overlay.innerHTML = '';
    if (waitTimer) clearTimeout(waitTimer);

    ensureOverlay();
    setStatus('Waiting for caption URL…', 'info');

    setTimeout(() => {
      if (!groups.length && !usedUrl && enabled) tryTriggerCC();
    }, 4000);

    waitTimer = setTimeout(() => {
      if (!groups.length && enabled) {
        setStatus(tracksForVideo.length ? 'Could not capture caption URL' : 'Video has no captions', 'warn');
      }
    }, 15000);
  }

  document.addEventListener('yt-navigate-finish', () => {
    const newId = getVideoId();
    if (newId && newId !== currentVideoId) { console.log('[YTBS] SPA navigate to', newId); resetForNewVideo(); }
  });

  function bootIfOnWatch() {
    if (!location.pathname.startsWith('/watch')) return;
    if (!getVideoId()) return;
    resetForNewVideo();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootIfOnWatch, { once: true });
  } else {
    bootIfOnWatch();
  }
})();
