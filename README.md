# YouTube Bilingual Subtitles

A minimal Chrome MV3 extension that overlays **bilingual subtitles** on YouTube by translating the existing caption track through your own OpenAI-compatible endpoint.

**[English](#english)** · **[中文](#中文)**

---

## English

### Requirements

- Chrome / Chromium ≥ 111 (needs MV3 `world: "MAIN"`)
- An OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, LM Studio, custom gateway, …)
- A video with an existing caption track (live streams are not supported)

### Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions/` and toggle **Developer mode** on.
3. Click **Load unpacked** and select the repo folder.
4. Click the extension icon → **Open settings**.
5. Fill in:
   - **API Base URL** — e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1`
   - **API Key**
   - **Model** — e.g. `gpt-4o-mini`, `qwen2.5:14b`
   - **Target Language** — e.g. `Chinese (Simplified)`, `日本語`, `Spanish`
6. **Test connection** → **Save**.
7. Open a YouTube video with captions, enable CC, bilingual overlay appears within a few seconds.

### How it works

1. `inject.js` runs in the page's MAIN world and patches `fetch` / `XHR` to capture `/api/timedtext` responses.
2. `content.js` parses `json3` / `xml` caption formats and batches 20 lines at a time to the service worker.
3. `background.js` calls `${baseURL}/chat/completions` and caches results in `chrome.storage.local` keyed by `videoId + model + language + line`.
4. The overlay renders over the video and re-syncs on every `timeupdate`.

### Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — API calls + cache |
| `content.js` | Content script — parse captions, render overlay |
| `inject.js` | Page-context `fetch` / `XHR` hook |
| `overlay.css` | Subtitle styles |
| `options.html` / `options.js` | Settings page |
| `popup.html` / `popup.js` | Toolbar toggle |

### Customization

- **Prompt** — `background.js`, search `userPrompt`. Add glossary or context.
- **Batch size** — `content.js`, `const BATCH = 20`. Bigger = cheaper + better context, higher latency.
- **Styles** — `overlay.css`. Adjust `#ytbs-overlay` position, font, colors.
- **Keep native captions visible** — remove the `body.ytbs-active .ytp-caption-window-container` rule.
- **Tighter host permission** — replace `<all_urls>` in `manifest.json` with your API domain.

### Known limits

- Live streams are not supported (different timedtext format).
- Videos without a caption track are out of scope — wire in a Whisper/ASR backend if you need those.
- Non-strict OpenAI-compatible servers may drop lines; the parser tolerates markdown fences and extracts the first `{...}` block.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 环境要求

- Chrome / Chromium ≥ 111（MV3 `world: "MAIN"` 字段所需）
- 一个 OpenAI 兼容的接口（OpenAI、Ollama、vLLM、LM Studio、自建网关等）
- 视频本身自带字幕轨（直播不支持）

### 安装（开发者模式加载）

1. 克隆或下载本仓库。
2. 打开 `chrome://extensions/`，右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本仓库目录。
4. 点击扩展图标 → **Open settings**。
5. 填写：
   - **API Base URL** — 例如 `https://api.openai.com/v1`、`http://localhost:11434/v1`
   - **API Key**
   - **Model** — 例如 `gpt-4o-mini`、`qwen2.5:14b`
   - **Target Language** — 例如 `Chinese (Simplified)`、`日本語`、`Spanish`
6. **Test connection** 通过后 **Save**。
7. 打开任意带 CC 字幕的 YouTube 视频，开启字幕，几秒内双语字幕即出现。

### 工作原理

1. `inject.js` 注入到页面 MAIN world，劫持 `fetch` / `XHR` 捕获 `/api/timedtext` 响应。
2. `content.js` 解析 `json3` / `xml` 字幕格式，每 20 行一批发送给 service worker。
3. `background.js` 调用 `${baseURL}/chat/completions`，按 `videoId + model + language + line` 为 key 缓存到 `chrome.storage.local`。
4. 覆盖层渲染在视频上方，跟随 `timeupdate` 事件同步。

### 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单 |
| `background.js` | Service worker —— API 调用与缓存 |
| `content.js` | 内容脚本 —— 解析字幕、渲染覆盖层 |
| `inject.js` | 页面上下文的 `fetch` / `XHR` 钩子 |
| `overlay.css` | 字幕样式 |
| `options.html` / `options.js` | 设置页 |
| `popup.html` / `popup.js` | 工具栏快捷开关 |

### 自定义

- **提示词** —— `background.js` 中搜索 `userPrompt`，可加入术语表或上下文。
- **批大小** —— `content.js` 的 `const BATCH = 20`。调大 = 更省成本、上下文更完整，但延迟更高。
- **样式** —— 编辑 `overlay.css`，调整 `#ytbs-overlay` 的位置、字号、颜色。
- **保留原生字幕** —— 删除 `body.ytbs-active .ytp-caption-window-container` 规则。
- **收紧权限** —— 把 `manifest.json` 中的 `<all_urls>` 改为你实际使用的 API 域名。

### 已知限制

- 不支持直播（timedtext 格式不同）。
- 本扩展仅处理已有字幕轨的视频，无字幕视频需要接入 Whisper / ASR。
- 部分 OpenAI 兼容服务不强制 JSON 输出；解析器会容忍 markdown 围栏并提取首个 `{...}` 块，但不保证 0 丢行。

### 许可

MIT，详见 [LICENSE](LICENSE)。
