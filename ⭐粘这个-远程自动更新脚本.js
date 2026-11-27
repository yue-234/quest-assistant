// 命定之诗 · 独立任务助手（jsDelivr 远程版本切换加载器）
// 项目地址：https://github.com/yue-234/quest-assistant
// 使用方式：将本文件全文粘贴至酒馆脚本助手（TavernHelper）新建脚本并启用即可。
// 默认跟随 main 分支最新构建（推送后自动同步）；如需固定老版本，可在面板「⚙ 设置」中切换为指定 Tag（如 v1.4.0）或修改下方 DEFAULT_REF。

(function () {
  const DEFAULT_REF = 'main';
  const REPO = 'yue-234/quest-assistant';
  const ASSET_PATH = 'dist/quest-assistant.js';
  const ORIGIN_STORAGE_KEY = 'quest_helper_cdn_origin_v1';
  const REF_STORAGE_KEY = 'quest_helper_script_ref_v1';
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

  function readStorage(key) {
    for (const win of [parentWindow(), window]) {
      try {
        const val = win?.localStorage?.getItem(key) || '';
        if (val) return val;
      } catch {
        /* 忽略 */
      }
    }
    return '';
  }

  function writeStorage(key, val) {
    for (const win of [parentWindow(), window]) {
      try {
        if (win?.localStorage) {
          win.localStorage.setItem(key, val);
          return;
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  function normalizeRef(raw) {
    const cleaned = String(raw ?? '').trim().replace(/^@+/, '');
    if (!cleaned || cleaned.length > 64 || cleaned.includes('..') || cleaned.startsWith('/') || cleaned.endsWith('/')) {
      return '';
    }
    return /^[A-Za-z0-9._/-]+$/.test(cleaned) ? cleaned : '';
  }

  function notifyError(message) {
    const toastr = globalThis.toastr || parentWindow()?.toastr;
    if (typeof toastr?.error === 'function') toastr.error(message);
    console.error(`[任务助手 CDN] ${message}`);
  }

  function buildCandidateOrigins() {
    const saved = readStorage(ORIGIN_STORAGE_KEY);
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

  async function fetchByRef(ref) {
    const origins = buildCandidateOrigins();
    const errors = [];
    for (const origin of origins) {
      const url = `${origin}/gh/${REPO}@${ref}/${ASSET_PATH}`;
      try {
        const code = await fetchScript(url);
        writeStorage(ORIGIN_STORAGE_KEY, origin);
        return { code, origin, ref };
      } catch (err) {
        errors.push(`${origin}: ${err && err.message ? err.message : err}`);
      }
    }
    throw new Error(errors.join(' | '));
  }

  const remoteState = {
    defaultRef: DEFAULT_REF,
    loadedRef: DEFAULT_REF,
    loadedOrigin: '',
    async switchRef(nextRef, { reopen = false } = {}) {
      const normalized = normalizeRef(nextRef);
      const targetRef = normalized || DEFAULT_REF;
      const prevOverride = readStorage(REF_STORAGE_KEY);
      const result = await fetchByRef(targetRef);
      writeStorage(REF_STORAGE_KEY, normalized);
      remoteState.loadedRef = result.ref;
      remoteState.loadedOrigin = result.origin;
      const win = parentWindow();
      try {
        if (win?.QuestHelperApp && typeof win.QuestHelperApp.stop === 'function') {
          win.QuestHelperApp.stop();
        }
        (0, eval)(result.code);
        if (reopen && win?.QuestHelperApp && typeof win.QuestHelperApp.open === 'function') {
          void win.QuestHelperApp.open();
        }
        return { ref: result.ref, origin: result.origin };
      } catch (err) {
        writeStorage(REF_STORAGE_KEY, prevOverride);
        throw err;
      }
    },
  };

  function exposeRemoteHandle() {
    const win = parentWindow();
    if (win) win.__QuestHelperRemoteLoader = remoteState;
    globalThis.__QuestHelperRemoteLoader = remoteState;
  }

  async function boot() {
    exposeRemoteHandle();
    const customRef = normalizeRef(readStorage(REF_STORAGE_KEY));
    const preferredRef = customRef || DEFAULT_REF;

    try {
      const result = await fetchByRef(preferredRef);
      remoteState.loadedRef = result.ref;
      remoteState.loadedOrigin = result.origin;
      (0, eval)(result.code);
      return;
    } catch (firstErr) {
      if (customRef && customRef !== DEFAULT_REF) {
        writeStorage(REF_STORAGE_KEY, '');
        try {
          const fallback = await fetchByRef(DEFAULT_REF);
          remoteState.loadedRef = fallback.ref;
          remoteState.loadedOrigin = fallback.origin;
          (0, eval)(fallback.code);
          notifyError(`自定义版本 ${customRef} 加载失败，已自动回退到默认版本 ${DEFAULT_REF}`);
          return;
        } catch (fallbackErr) {
          notifyError(
            `任务助手远程脚本加载失败（${customRef} 与默认 ${DEFAULT_REF} 均不可达），请检查网络或改用离线版「⭐粘这个-任务助手脚本.js」。详情：${fallbackErr?.message || fallbackErr}`,
          );
          return;
        }
      }
      notifyError(
        `任务助手远程脚本加载失败（版本 ${preferredRef} 所有 jsDelivr 节点均不可达），请检查网络或改用离线版「⭐粘这个-任务助手脚本.js」。详情：${firstErr?.message || firstErr}`,
      );
    }
  }

  void boot();
})();
