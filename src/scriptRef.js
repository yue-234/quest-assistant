// 远程脚本版本号（Git Ref）配置与可用版本查询工具。

export const DEFAULT_SCRIPT_REF = 'main';
export const BASELINE_SCRIPT_TAG = 'v1.4.0';
export const SCRIPT_REF_KEY = 'quest_helper_script_ref_v1';
export const CDN_ORIGIN_KEY = 'quest_helper_cdn_origin_v1';
export const SCRIPT_REPO = 'yue-234/quest-assistant';
export const SCRIPT_ASSET_PATH = 'dist/quest-assistant.js';
export const CDN_ORIGINS = [
  'https://testingcf.jsdelivr.net',
  'https://cdn.jsdelivr.net',
  'https://fastly.jsdelivr.net',
  'https://gcore.jsdelivr.net',
];
export const JSDELIVR_VERSIONS_URL = `https://data.jsdelivr.net/v1/packages/gh/${SCRIPT_REPO}`;
export const GITHUB_TAGS_URL = `https://api.github.com/repos/${SCRIPT_REPO}/tags?per_page=30`;

/** 校验并归一化版本号/分支名（支持去掉前导 @；空或非法输入返回空字符串）。 */
export function normalizeScriptRef(raw) {
  const cleaned = String(raw ?? '').trim().replace(/^@+/, '');
  if (!cleaned) return '';
  if (cleaned.length > 64 || cleaned.includes('..') || cleaned.startsWith('/') || cleaned.endsWith('/')) {
    return '';
  }
  return /^[A-Za-z0-9._/-]+$/.test(cleaned) ? cleaned : '';
}

/** 读取玩家自定义覆盖的版本号；未设置时返回空字符串（由加载器采用默认 main 最新分支）。 */
export function readScriptRef(readStorage) {
  if (typeof readStorage !== 'function') return '';
  try {
    return normalizeScriptRef(readStorage(SCRIPT_REF_KEY));
  } catch {
    return '';
  }
}

/** 保存玩家自定义覆盖的版本号；传入空值时恢复跟随加载器默认版本（main）。 */
export function writeScriptRef(writeStorage, ref) {
  const normalized = normalizeScriptRef(ref);
  if (typeof writeStorage === 'function') {
    try {
      writeStorage(SCRIPT_REF_KEY, normalized);
    } catch {
      /* 忽略存储异常 */
    }
  }
  return normalized;
}

async function fetchJsonWithTimeout(fetchFn, url, timeoutMs = 5000) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(url, {
      cache: 'no-cache',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 拉取已发布版本列表（优先 jsDelivr，未返回 Tag 时回退 GitHub Tags API），并补齐 main 与基准版本。 */
export async function fetchAvailableScriptRefs(fetchFn = globalThis.fetch, defaultRef = DEFAULT_SCRIPT_REF) {
  const list = [];
  const pushUnique = (val) => {
    const n = normalizeScriptRef(val);
    if (n && !list.includes(n)) list.push(n);
  };

  pushUnique(defaultRef || DEFAULT_SCRIPT_REF);

  if (typeof fetchFn === 'function') {
    const jsdPayload = await fetchJsonWithTimeout(fetchFn, JSDELIVR_VERSIONS_URL);
    const jsdVersions = Array.isArray(jsdPayload?.versions) ? jsdPayload.versions : [];
    for (const entry of jsdVersions) {
      if (typeof entry === 'string') pushUnique(entry);
      else if (entry && typeof entry.version === 'string') pushUnique(entry.version);
    }

    if (jsdVersions.length === 0) {
      const ghTags = await fetchJsonWithTimeout(fetchFn, GITHUB_TAGS_URL);
      if (Array.isArray(ghTags)) {
        for (const tag of ghTags) {
          if (tag && typeof tag.name === 'string') pushUnique(tag.name);
        }
      }
    }
  }

  pushUnique('main');
  pushUnique(BASELINE_SCRIPT_TAG);
  return list;
}

/** 从 jsDelivr 四节点依次拉取指定 ref 的脚本并校验内容，记住可用节点。 */
export async function fetchScriptByRef(
  ref,
  {
    fetchFn = globalThis.fetch,
    readStorage = null,
    writeStorage = null,
    timeoutMs = 8000,
  } = {},
) {
  const targetRef = normalizeScriptRef(ref) || DEFAULT_SCRIPT_REF;
  if (typeof fetchFn !== 'function') {
    throw new Error('当前环境不支持网络请求');
  }
  let savedOrigin = '';
  if (typeof readStorage === 'function') {
    try {
      savedOrigin = String(readStorage(CDN_ORIGIN_KEY) || '');
    } catch {
      savedOrigin = '';
    }
  }
  const origins = savedOrigin && CDN_ORIGINS.includes(savedOrigin)
    ? [savedOrigin, ...CDN_ORIGINS.filter((o) => o !== savedOrigin)]
    : CDN_ORIGINS.slice();

  const errors = [];
  for (const origin of origins) {
    const url = `${origin}/gh/${SCRIPT_REPO}@${targetRef}/${SCRIPT_ASSET_PATH}`;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, {
        cache: 'no-cache',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res || !res.ok) {
        throw new Error(`HTTP ${res ? res.status : 'ERR'}`);
      }
      const code = await res.text();
      if (!code || !code.includes('QuestHelperApp')) {
        throw new Error('返回内容不是有效的任务助手脚本');
      }
      if (typeof writeStorage === 'function') {
        try {
          writeStorage(CDN_ORIGIN_KEY, origin);
        } catch {
          /* 忽略 */
        }
      }
      return { code, origin, ref: targetRef };
    } catch (err) {
      errors.push(`${origin}: ${err && err.message ? err.message : err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error(errors.join(' | '));
}
