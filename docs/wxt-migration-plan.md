# WXT 迁移目录草案（Vue 3 版）

> 状态：草案（未执行）
> 日期：2026-04-26
> 决策依据：consensus(GPT-5.4 + Gemini-2.5-Pro) + 用户偏好（中文社区优先 / 新手友好）

## 决策上下文

- **产品定位**：「你的模型，你的 YouTube — 双语字幕 + 划词翻译，全程 BYOK」
- **划词范围**：仅 `youtube.com` 站内任意文本（非全网，非仅评论区）
- **技术栈**：WXT + TypeScript + **Vue 3（Composition API + `<script setup>`）** + Tailwind v4
- **核心权衡**：放弃「无构建、肉眼可审计」承诺，换取工程效率与 UI 质量；通过 reproducible build + sourcemap + README 审计指南补偿

> Vue 3 选型理由：用户为新手，Vue 在中文社区教程量、视频内容、入门曲线上明显优于 Preact + signals；WXT 官方提供 `@wxt-dev/module-vue`，零额外配置。

## 1. 目标目录树

```
youtube-bilingual-subs/
├── package.json
├── tsconfig.json
├── wxt.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── public/
│   └── icons/  (16/48/128.png)
├── src/
│   ├── entrypoints/
│   │   ├── inject.content.ts        # MAIN world（替代 inject.js）
│   │   ├── content.ts               # isolated content script（替代 content.js）
│   │   ├── background.ts            # SW（替代 background.js）
│   │   ├── popup/
│   │   │   ├── index.html
│   │   │   ├── main.ts
│   │   │   └── App.vue
│   │   └── options/
│   │       ├── index.html
│   │       ├── main.ts
│   │       └── App.vue
│   ├── components/
│   │   ├── ui/              # Switch.vue / Input.vue / Button.vue / Card.vue
│   │   ├── overlay/         # SubtitleOverlay.vue + StatusBadge.vue
│   │   └── selection/       # SelectionBubble.vue + useSelection.ts
│   ├── lib/
│   │   ├── caption-parser.ts        # parseTimedText
│   │   ├── sentence-grouper.ts      # groupIntoSentences
│   │   ├── translator.ts            # API 调用 + JSON 解析
│   │   └── prompt.ts                # 提示词组装
│   ├── shared/
│   │   ├── messages.ts              # 类型化消息协议
│   │   ├── cache.ts                 # SHA-1 cacheKeyFor
│   │   ├── defaults.ts              # DEFAULTS 单一来源
│   │   ├── storage.ts               # chrome.storage 包装
│   │   └── log.ts                   # [YTBS] 日志
│   └── styles/
│       ├── tokens.css               # design tokens
│       └── global.css               # base + @tailwind
├── README.md
└── CLAUDE.md
```

构建产物（`.output/chrome-mv3/`）仍只有 5 个入口文件，源文件约 25 个。

## 2. package.json

```json
{
  "name": "youtube-bilingual-subs",
  "version": "0.2.0",
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "build": "wxt build",
    "build:firefox": "wxt build -b firefox",
    "zip": "wxt zip",
    "compile": "vue-tsc --noEmit",
    "postinstall": "wxt prepare"
  },
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.270",
    "@wxt-dev/module-vue": "^1.0.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vue-tsc": "^2.1.0",
    "wxt": "^0.19.0"
  }
}
```

`vue-tsc` 替代普通 `tsc` 来同时检查 `.ts` 和 `.vue` 文件中的 TypeScript。

## 3. wxt.config.ts

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'YouTube Bilingual Subs',
    description: '你的模型，你的 YouTube — 双语字幕 + 划词翻译，全程 BYOK',
    permissions: ['storage'],
    host_permissions: [
      '*://*.youtube.com/*',
      // BYOK 任意 endpoint：用 optional_host_permissions 在首次保存设置时按需申请
    ],
    optional_host_permissions: ['*://*/*'],
    web_accessible_resources: [
      { resources: ['inject.js'], matches: ['*://*.youtube.com/*'] },
    ],
  },
  vite: () => ({
    build: {
      minify: false,           // 保留可审计性
      sourcemap: true,
      target: 'chrome120',
    },
  }),
});
```

`<all_urls>` 收敛为 `optional_host_permissions`：用户保存自定义 baseURL 时再触发授权对话框，符合极客对最小权限的预期。

## 4. tokens.css（design system 单一来源）

```css
/* src/styles/tokens.css */
:root {
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;

  /* light (默认 popup/options) */
  --bg: #FFFFFF;
  --surface: #F6F7F9;
  --elevated: #FFFFFF;
  --text: #0B0D12;
  --muted: #5B6473;
  --border: #E5E7EB;
  --accent: #5B7BFF;
  --success: #35C759;
  --warn: #F5A524;
  --danger: #FF5D73;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0B0D12;
    --surface: #151922;
    --elevated: #1B2130;
    --text: #E6EAF2;
    --muted: #9AA4B2;
    --border: #232938;
    --accent: #7C9BFF;
  }
}

/* overlay 永远深色，不跟随系统 */
.ytbs-overlay-scope {
  --overlay-bg: rgba(10, 12, 18, 0.42);
  --overlay-text: #FFFFFF;
  --overlay-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
}
```

## 5. shared/messages.ts（类型化协议）

```ts
// src/shared/messages.ts
export type TranslateBatchRequest = {
  type: 'TRANSLATE_BATCH';
  videoId: string;
  targetLang: string;
  lines: { id: string; text: string }[];
  contextBefore: string[];
  contextAfter: string[];
};

export type TranslateSelectionRequest = {
  type: 'TRANSLATE_SELECTION';
  text: string;
  targetLang: string;
};

export type TranslateResponse = {
  ok: boolean;
  translations?: Record<string, string>;
  error?: string;
};

export type CaptionsMessage = {
  __ytbs: true;
  type: 'YT_CAPTIONS' | 'YT_PLAYER_DATA';
  url?: string;
  body?: string;
  tracks?: unknown;
};
```

## 6. shared/defaults.ts（替代 popup.js / options.js 重复）

```ts
// src/shared/defaults.ts
export const DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: 'zh-CN',
  enabled: true,
  // 新增
  selectionEnabled: true,
  subtitleFontScale: 1.0,
  theme: 'auto' as 'auto' | 'light' | 'dark',
} as const;

export const CACHE_PREFIX = 'ytbs_c2_';
export const BATCH_SIZE = 20;
export const CONTEXT_BEFORE = 3;
export const CONTEXT_AFTER = 3;
```

## 7. entrypoints/background.ts 骨架

```ts
// src/entrypoints/background.ts
import type {
  TranslateBatchRequest,
  TranslateSelectionRequest,
  TranslateResponse,
} from '@/shared/messages';
import { translate } from '@/lib/translator';
import { log } from '@/shared/log';

export default defineBackground(() => {
  log('background ready');

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TRANSLATE_BATCH') {
      translate(msg as TranslateBatchRequest)
        .then((r) => sendResponse(r satisfies TranslateResponse))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async
    }
    if (msg?.type === 'TRANSLATE_SELECTION') {
      translate(msg as TranslateSelectionRequest)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });
});
```

## 8. entrypoints/inject.content.ts（MAIN world）

```ts
// src/entrypoints/inject.content.ts
export default defineUnlistedScript(() => {
  // 现有 inject.js 的 fetch/XHR hook 与 ytInitialPlayerResponse 轮询
  // 直接迁移；不能调 chrome.*，仅用 window.postMessage({ __ytbs: true, ... })
});
```

`defineUnlistedScript` + manifest `web_accessible_resources` 的组合让 content.ts 用 `chrome.runtime.getURL('inject.js')` 注入到 MAIN world。

## 9. entrypoints/content.ts 骨架（Vue 3 版）

```ts
// src/entrypoints/content.ts
import { createApp, h } from 'vue';
import SubtitleOverlay from '@/components/overlay/SubtitleOverlay.vue';
import StatusBadge from '@/components/overlay/StatusBadge.vue';
import SelectionBubble from '@/components/selection/SelectionBubble.vue';
import '@/styles/tokens.css';
import '@/styles/global.css';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  cssInjectionMode: 'ui',
  async main(ctx) {
    // 1. 注入 MAIN world inject.js
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('/inject.js');
    (document.head ?? document.documentElement).appendChild(s);

    // 2. 监听 captions postMessage（保留现有 PerformanceObserver 兜底）
    window.addEventListener('message', onCaptionsMessage);

    // 3. 挂载 overlay UI 到 #movie_player
    const overlayUi = await createShadowRootUi(ctx, {
      name: 'ytbs-overlay',
      position: 'overlay',
      anchor: '#movie_player',
      onMount(container) {
        const app = createApp({
          render: () =>
            h('div', { class: 'ytbs-overlay-scope' }, [
              h(SubtitleOverlay),
              h(StatusBadge),
            ]),
        });
        app.mount(container);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      },
    });
    overlayUi.mount();

    // 4. 划词气泡（仅 youtube.com 由 manifest 限制）
    const bubbleUi = await createShadowRootUi(ctx, {
      name: 'ytbs-selection',
      position: 'overlay',
      anchor: 'body',
      onMount(c) {
        const app = createApp(SelectionBubble);
        app.mount(c);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      },
    });
    bubbleUi.mount();

    // 5. SPA 导航
    document.addEventListener('yt-navigate-finish', resetForNewVideo);
  },
});
```

`createShadowRootUi` 是 WXT 内置：自动 Shadow DOM 隔离 + Tailwind 样式作用域，彻底避免和 YouTube 自身样式冲突——这正是当前 `overlay.css` 的 `!important` 满天飞要解决的问题。

## 10. components/selection/SelectionBubble.vue 骨架（Vue 3 SFC）

```vue
<!-- src/components/selection/SelectionBubble.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const visible = ref(false);
const pos = ref({ x: 0, y: 0 });
const text = ref('');
const result = ref('');

function onMouseUp() {
  const sel = window.getSelection();
  const s = sel?.toString().trim();
  if (!s || s.length < 2) return;
  const range = sel!.getRangeAt(0).getBoundingClientRect();
  pos.value = { x: range.left + range.width / 2, y: range.top - 8 };
  text.value = s;
  visible.value = true;
  // TODO: 发送翻译请求 chrome.runtime.sendMessage({ type: 'TRANSLATE_SELECTION', ... })
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') visible.value = false;
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <div
    v-if="visible"
    class="fixed z-[2147483647] -translate-x-1/2 -translate-y-full
           rounded-lg border bg-[var(--elevated)] px-3 py-2 text-sm
           text-[var(--text)] shadow-lg transition-all duration-150"
    :style="{
      left: `${pos.x}px`,
      top: `${pos.y}px`,
      borderColor: 'var(--border)',
    }"
  >
    <div class="text-[var(--muted)] text-xs mb-1">{{ text }}</div>
    <div>{{ result || '翻译中…' }}</div>
  </div>
</template>
```

## 10b. entrypoints/popup/App.vue 骨架（Vue 3 SFC）

```vue
<!-- src/entrypoints/popup/App.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { DEFAULTS } from '@/shared/defaults';

const enabled = ref(DEFAULTS.enabled);
const apiKeySet = ref(false);

onMounted(async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  enabled.value = s.enabled;
  apiKeySet.value = !!s.apiKey;
});

async function toggle() {
  enabled.value = !enabled.value;
  await chrome.storage.sync.set({ enabled: enabled.value });
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}
</script>

<template>
  <div class="w-[320px] p-4 font-sans bg-[var(--bg)] text-[var(--text)]">
    <h1 class="text-lg font-semibold mb-3">YT Bilingual Subs</h1>

    <div class="flex items-center justify-between py-2">
      <span class="text-sm">启用翻译</span>
      <button
        @click="toggle"
        :class="[
          'h-6 w-11 rounded-full transition-colors',
          enabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]',
        ]"
      >
        <span
          :class="[
            'block h-5 w-5 rounded-full bg-white transition-transform',
            enabled ? 'translate-x-5' : 'translate-x-0.5',
          ]"
        />
      </button>
    </div>

    <p v-if="!apiKeySet" class="text-xs text-[var(--warn)] mt-2">
      尚未配置 API Key
    </p>

    <button
      @click="openOptions"
      class="mt-4 w-full rounded-md bg-[var(--surface)] py-2 text-sm
             hover:bg-[var(--elevated)] transition-colors"
    >
      打开设置
    </button>
  </div>
</template>
```

## 10c. entrypoints/popup/main.ts

```ts
// src/entrypoints/popup/main.ts
import { createApp } from 'vue';
import App from './App.vue';
import '@/styles/tokens.css';
import '@/styles/global.css';

createApp(App).mount('#app');
```

## 10d. entrypoints/popup/index.html

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>YT Bilingual Subs</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

## 11. 文件映射表（旧 → 新）

| 现有文件 | 新位置 | 改动 |
|---------|-------|------|
| `manifest.json` | `wxt.config.ts` | 自动生成，`<all_urls>` 改 optional |
| `inject.js` | `src/entrypoints/inject.content.ts` | 加类型注解，逻辑不变 |
| `content.js` | `src/entrypoints/content.ts` + `src/lib/caption-parser.ts` + `src/lib/sentence-grouper.ts` + `src/components/overlay/*.vue` | 拆分：解析/分组逻辑下沉到 lib，UI 上 Vue SFC |
| `background.js` | `src/entrypoints/background.ts` + `src/lib/translator.ts` + `src/lib/prompt.ts` + `src/shared/cache.ts` | 拆分：API 调用与提示词独立 |
| `popup.html`/`popup.js` | `src/entrypoints/popup/{index.html,main.ts,App.vue}` | 重做 macOS utility panel |
| `options.html`/`options.js` | `src/entrypoints/options/{index.html,main.ts,App.vue}` | 重做 Linear/Stripe 风左右两栏 |
| `overlay.css` | `src/styles/{tokens.css,global.css}` + Tailwind class | Shadow DOM + Tailwind，废弃 `!important` |
| `README.md` | 同 | 增「Build from source」「Audit guide」节 |
| `CLAUDE.md` | 同 | 替换架构说明为 WXT + Vue 3 版 |

## 12. 迁移执行步骤（编号清单）

1. `pnpm dlx wxt@latest init . --template vue-ts`，选项目录是当前 repo（覆盖 .gitignore 等）
2. 把 `package.json` 改成上面草案，`pnpm i`
3. 创建 `src/styles/tokens.css` 与 `src/styles/global.css`
4. 创建 `src/shared/{messages,defaults,cache,storage,log}.ts`，把现有常量抽过去
5. 把 `inject.js` 内容平移到 `src/entrypoints/inject.content.ts`，加类型
6. 把 `background.js` 的翻译流水线拆到 `src/lib/{translator,prompt}.ts`，主入口写 `entrypoints/background.ts`
7. `content.js` 同样拆分：`lib/caption-parser.ts` + `lib/sentence-grouper.ts` + Vue UI 组件
8. 写最小 `popup/App.vue`：先只有「启用」开关 + 状态行（保证能跑）
9. 写最小 `options/App.vue`：5 个字段表单 + 保存按钮
10. `pnpm dev`，加载 `.output/chrome-mv3` 到 `chrome://extensions/`
11. 对照现有功能做冒烟测试：打开 YT 视频 → 字幕出现 → 选中评论文字 → 气泡弹出
12. 通过后再做 UI 美化：popup 改 macOS 风、options 改 Linear 风

## 13. 验收标准

- `pnpm build` 成功
- `pnpm compile` 零类型错误（vue-tsc）
- Chrome 加载 `.output/chrome-mv3` 后：YT 视频字幕功能与现版一致
- Popup 与 Options 功能等价（5 项设置 + 启用开关）
- 划词在 YT 任意页面可触发气泡
- 产物可读：`.output/chrome-mv3/background.js` 是未压缩的 JS，文件 ≤ 200 行

## 14. 设计风格速查

| 场景 | 风格 | 关键细节 |
|------|------|---------|
| Popup | macOS Utility Panel | 320×420px，圆角 12px，1px subtle border，状态行 + 主开关 + 快捷入口 |
| Options | Linear/Stripe Developer Settings | 左右两栏：左导航(Translation/Subtitle/Selection/About)，右内容；分组卡片 |
| 视频 Overlay | Functional Minimal + Subtle Glass | 弱胶囊（`bg rgba(10,12,18,.42)` + `backdrop-filter: blur(8px)`）+ 强文字阴影；不要重背景块 |
| 划词气泡 | Notion/Arc Contextual Popover | subtle elevation、轻边框、12px padding；不选 neo-brutalism |

## 15. Overlay 字幕规格

| 项 | 全屏 | 普通窗口 |
|---|------|---------|
| 原文字号 | 20px | 18px |
| 译文字号 | 28px | 24px |
| 行高 | 原 1.28 / 译 1.22 | 同 |
| text-shadow | `0 2px 12px rgba(0,0,0,.55)` | 同 |
| 背景 | `rgba(10,12,18,.42)` + `backdrop-filter: blur(8px)` | 同 |
| 容器 padding | 8px 16px，border-radius 8px | 同 |

## 16. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|-------|------|
| 划词稀释「只做 YT 字幕」标签 | 中（站内收敛后） | Slogan/README 把「YouTube 语境翻译」绑死，不漂移成「全网翻译」 |
| WXT 破坏「肉眼审计」信任 | 高 | ① 关闭 minify ② 输出 sourcemap ③ GitHub Actions reproducible build + SHA-256 ④ README 增「Build from source」一节 |
| Immersive Translate 正面竞争 | 中 | 不正面比覆盖度，强调「BYOK + 仅 YT + 极简」三角差异 |

## 17. 12 个月目标

- CWS 安装量：8,000 – 25,000
- DAU：700 – 1,800
- 30 日留存：25% – 40%

Confidence：GPT-5.4 9/10 + Gemini-2.5-Pro 8/10 = 高信号

---

## 附录 A：Vue 3 新手 5 分钟核心

整个项目你只需掌握 4 个 API：

```ts
import { ref, onMounted, computed, watch } from 'vue';

const count = ref(0);                 // 1) ref：会自动同步 UI 的变量
count.value++;                         //    在 <script> 里读写要用 .value
                                       //    在 <template> 里直接用 count（不用 .value）

const doubled = computed(() => count.value * 2);  // 2) computed：派生值

watch(count, (n, o) => console.log(n, o));        // 3) watch：监听变化

onMounted(() => console.log('已挂载'));            // 4) 生命周期钩子
```

`<script setup>` 里凡是定义的 `ref` / `function`，模板里都能直接用，**不用 export、不用 return**——这就是 Vue 3 比 React 简单的核心。

## 附录 B：与 React/Preact 心智对照

| 概念 | React/Preact | Vue 3 |
|------|--------------|-------|
| 响应式状态 | `useState` + setter | `ref()` + `.value` |
| 副作用 | `useEffect(fn, [deps])` | `watchEffect(fn)` 或 `watch(src, fn)` |
| 派生值 | `useMemo` | `computed()` |
| 模板 | JSX（在 JS 里写 HTML） | `<template>`（HTML 优先） |
| 条件渲染 | `{cond && <X/>}` | `<X v-if="cond" />` |
| 列表 | `{list.map(x => ...)}` | `<X v-for="x in list" />` |
| 双向绑定 | 手写 onChange | `v-model="x"` |
| 依赖数组 | 必须手写 `[deps]` 否则 bug | 自动追踪，不用写 |

Vue 的两个新手友好优势：① 不用写依赖数组 ② 双向绑定一行搞定。
