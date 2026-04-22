// Runs in the page's main world (via content_scripts "world": "MAIN").
// Installs fetch/XHR hooks to capture:
//   - /api/timedtext responses (actual caption data)
//   - /youtubei/v1/player responses (track list on SPA navigation)
// Communicates with the isolated-world content script via window.postMessage.
//
// This file MUST NOT use any chrome.* APIs — main world has no access to them.
(function () {
  if (window.__ytbsInjected) return;
  window.__ytbsInjected = true;

  function post(msg) {
    try { window.postMessage(Object.assign({ __ytbs: true }, msg), '*'); } catch (e) {}
  }

  function extractTracks(playerResponse, source) {
    try {
      if (!playerResponse) return false;
      const r = playerResponse.captions;
      const tracks = r && r.playerCaptionsTracklistRenderer && r.playerCaptionsTracklistRenderer.captionTracks;
      const videoId = playerResponse.videoDetails && playerResponse.videoDetails.videoId;
      if (!tracks || !Array.isArray(tracks) || !tracks.length) return false;
      post({
        type: 'YT_PLAYER_DATA',
        videoId,
        source,
        trackCount: tracks.length,
        languages: tracks.map(t => t.languageCode).filter(Boolean)
      });
      return true;
    } catch (e) { return false; }
  }

  // A. Poll ytInitialPlayerResponse briefly on first page load.
  let tries = 0;
  const tid = setInterval(() => {
    if (extractTracks(window.ytInitialPlayerResponse, 'initial')) { clearInterval(tid); return; }
    if (++tries > 40) clearInterval(tid);
  }, 250);

  // B. Hook fetch — catch timedtext responses and youtubei player responses.
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes('/api/timedtext')) {
        res.clone().text().then(body => {
          post({ type: 'YT_CAPTIONS', url, body });
        }).catch(() => {});
      } else if (url.includes('/youtubei/v1/player')) {
        res.clone().json().then(data => extractTracks(data, 'youtubei')).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // C. Hook XHR defensively.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ytbsUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const u = String(this.__ytbsUrl || '');
    if (u.includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try { post({ type: 'YT_CAPTIONS', url: u, body: this.responseText }); } catch (e) {}
      });
    } else if (u.includes('/youtubei/v1/player')) {
      this.addEventListener('load', () => {
        try { extractTracks(JSON.parse(this.responseText), 'youtubei-xhr'); } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[YTBS] page hooks installed (MAIN world)');
})();
