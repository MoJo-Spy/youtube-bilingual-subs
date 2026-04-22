const FIELDS = ['baseURL', 'apiKey', 'model', 'targetLang', 'enabled'];
const DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: 'Chinese (Simplified)',
  enabled: true
};

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[f];
    else el.value = cfg[f] || '';
  }
}

async function save() {
  const cfg = {};
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    cfg[f] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  await chrome.storage.sync.set(cfg);
  setStatus('Saved ✓', 'ok');
  setTimeout(() => setStatus(''), 2000);
}

function setStatus(text, kind) {
  const el = document.getElementById('status');
  el.textContent = text || '';
  el.style.color = kind === 'err' ? 'var(--error)' : kind === 'ok' ? 'var(--accent-hover)' : 'var(--muted)';
}

async function testConnection() {
  setStatus('Testing…', 'muted');
  const baseURL = document.getElementById('baseURL').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();

  if (!baseURL || !apiKey || !model) {
    setStatus('Fill in base URL, API key, and model first.', 'err');
    return;
  }

  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with just: OK' }],
        max_tokens: 10,
        temperature: 0
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      setStatus(`Failed (${res.status}): ${txt.slice(0, 160)}`, 'err');
      return;
    }
    const data = await res.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    setStatus(`Connected ✓  Model replied: "${reply.slice(0, 40)}"`, 'ok');
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', testConnection);
load();
