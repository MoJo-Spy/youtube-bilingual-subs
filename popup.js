async function init() {
  const { enabled = true, apiKey = '' } = await chrome.storage.sync.get(['enabled', 'apiKey']);
  document.getElementById('enabled').checked = enabled;
  const status = document.getElementById('status');
  if (!apiKey) {
    status.textContent = '⚠ API key not set — click "Open settings"';
    status.classList.add('warn');
  } else {
    status.textContent = enabled ? 'Active on YouTube' : 'Currently disabled';
    status.classList.remove('warn');
  }
}

document.getElementById('enabled').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  init();
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
