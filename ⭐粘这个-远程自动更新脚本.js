// 命定之诗 · 独立任务助手（jsDelivr 远程自动更新加载器）
// 项目地址：https://github.com/yue-234/quest-assistant
// 使用方式：将本文件全文粘贴至酒馆脚本助手（TavernHelper）新建脚本并启用即可。
// 默认跟随 @main 分支最新构建；如需锁定版本，可将 REF 改为具体 Git Tag（例如 'v1.0.0'）。

(function () {
  const REPO = 'yue-234/quest-assistant';
  const REF = 'main';
  const ASSET_PATH = 'dist/quest-assistant.js';
  const STORAGE_KEY = 'quest_helper_cdn_origin_v1';
  const TIMEOUT_MS = 8000;
  const CDN_ORIGINS = [
    'https://testingcf.jsdelivr.net',
    'https://cdn.jsdelivr.net',
    'https://fastly.jsdelivr.net',
    'https://gcore.jsdelivr.net',
  ];

  function parentWindow() {
    try {
      if (window.parent && window.parent !== window) return window.parent;
    } catch {
      /* 跨源退回自身 */
    }
    return window;
  }

  function readSavedOrigin() {
    for (const win of [parentWindow(), window]) {
      try {
        const val = win?.localStorage?.getItem(STORAGE_KEY) || '';
        if (val) return val;
      } catch {
        /* 忽略 */
      }
    }
    return '';
  }

  function saveOrigin(origin) {
    for (const win of [parentWindow(), window]) {
      try {
        if (win?.localStorage) {
          win.localStorage.setItem(STORAGE_KEY, origin);
          return;
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  function notifyError(message) {
    const toastr = globalThis.toastr || parentWindow()?.toastr;
    if (typeof toastr?.error === 'function') toastr.error(message);
    console.error(`[任务助手 CDN] ${message}`);
  }

  function buildCandidateOrigins() {
    const saved = readSavedOrigin();
    if (!saved || !CDN_ORIGINS.includes(saved)) return CDN_ORIGINS.slice();
    return [saved, ...CDN_ORIGINS.filter((item) => item !== saved)];
  }

  async function fetchScript(url) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        cache: 'no-cache',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const code = await res.text();
      if (!code || !code.includes('QuestHelperApp')) {
        throw new Error('返回内容不是有效的任务助手脚本');
      }
      return code;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function boot() {
    const origins = buildCandidateOrigins();
    const errors = [];
    for (const origin of origins) {
      const url = `${origin}/gh/${REPO}@${REF}/${ASSET_PATH}`;
      try {
        const code = await fetchScript(url);
        saveOrigin(origin);
        (0, eval)(code);
        return;
      } catch (err) {
        errors.push(`${origin}: ${err && err.message ? err.message : err}`);
      }
    }
    notifyError(
      `任务助手远程脚本加载失败（所有 jsDelivr 节点均不可达），请检查网络或改用离线版「⭐粘这个-任务助手脚本.js」。详情：${errors.join(' | ')}`,
    );
  }

  void boot();
})();
