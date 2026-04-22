// Service worker — handles translation API calls and caches results.

const CACHE_PREFIX = 'ytbs_c2_'; // bumped from _c_ to invalidate old context-less translations
const DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: 'Chinese (Simplified)',
  enabled: true
};

async function getConfig() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function cacheKeyFor(videoId, model, lang, lineId, text) {
  const str = `${videoId}|${model}|${lang}|${lineId}|${text}`;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return CACHE_PREFIX + hex;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'TRANSLATE_BATCH') {
    translateBatch(msg).then(sendResponse).catch(err => {
      sendResponse({ translations: [], error: String(err) });
    });
    return true;
  }
});

async function translateBatch({ videoId, lines, context_before = [], context_after = [] }) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { translations: [] };
  if (!cfg.apiKey) return { translations: [], error: 'API key not set. Open extension options.' };

  // 1. Cache check
  const keyMap = {};
  for (const l of lines) {
    keyMap[l.id] = await cacheKeyFor(videoId, cfg.model, cfg.targetLang, l.id, l.text);
  }
  const cachedObj = await chrome.storage.local.get(Object.values(keyMap));

  const toTranslate = [];
  const translations = [];
  for (const l of lines) {
    const k = keyMap[l.id];
    if (cachedObj[k]) translations.push({ id: l.id, text: cachedObj[k] });
    else toTranslate.push(l);
  }
  if (!toTranslate.length) return { translations };

  // 2. Build context-aware prompt
  const numbered = toTranslate.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
  const beforeBlock = context_before.length
    ? `Previous lines (context only — do NOT translate, do NOT include in output):\n`
      + context_before.map(t => `  · ${t}`).join('\n') + '\n\n'
    : '';
  const afterBlock = context_after.length
    ? `\n\nUpcoming lines (context only — do NOT translate, do NOT include in output):\n`
      + context_after.map(t => `  · ${t}`).join('\n')
    : '';

  const userPrompt =
`You are translating subtitles for a YouTube video into ${cfg.targetLang}.
These lines are consecutive segments of continuous speech — individual lines may be sentence fragments that continue from or into the surrounding lines. Translate so that, when read in sequence, the output flows naturally as spoken dialogue.

${beforeBlock}Translate these ${toTranslate.length} lines (keep the same count, one translation per line):
${numbered}${afterBlock}

Rules:
- Output EXACTLY ${toTranslate.length} translations — one per input line.
- Keep the register natural and conversational.
- Preserve proper nouns, technical terms, and numbers.
- If a line is a fragment, translate it as a fragment — do NOT merge it with neighboring lines.
- Return ONLY a JSON object mapping line number (as string) to translation. No markdown, no commentary.

Example output: {"1":"译文一","2":"译文二"}`;

  let content = '';
  try {
    const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You are a professional subtitle translator. Always output valid JSON exactly as instructed, with one translation per input line.' },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { translations, error: `API ${res.status}: ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    content = data?.choices?.[0]?.message?.content || '';
  } catch (e) {
    return { translations, error: 'Network: ' + e.message };
  }

  // 3. Parse JSON (tolerant to ```json fences / stray text)
  let parsed = null;
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { translations, error: 'Model did not return valid JSON' };
  }

  // 4. Store results
  const toCache = {};
  for (let i = 0; i < toTranslate.length; i++) {
    const t = parsed[String(i + 1)] ?? parsed[i + 1];
    if (typeof t === 'string' && t.trim()) {
      const l = toTranslate[i];
      translations.push({ id: l.id, text: t.trim() });
      toCache[keyMap[l.id]] = t.trim();
    }
  }
  try { await chrome.storage.local.set(toCache); } catch (_) {}

  return { translations };
}
