// 远程脚本版本号（Git Ref）配置与可用版本查询工具。

export const DEFAULT_SCRIPT_REF = 'v1.4.0';
export const SCRIPT_REF_KEY = 'quest_helper_script_ref_v1';
export const SCRIPT_REPO = 'yue-234/quest-assistant';
export const JSDELIVR_VERSIONS_URL = `https://data.jsdelivr.net/v1/packages/gh/${SCRIPT_REPO}`;

/** 校验并归一化版本号/分支名（支持去掉前导 @；空或非法输入返回空字符串）。 */
export function normalizeScriptRef(raw) {
  const cleaned = String(raw ?? '').trim().replace(/^@+/, '');
  if (!cleaned) return '';
  if (cleaned.length > 64 || cleaned.includes('..') || cleaned.startsWith('/') || cleaned.endsWith('/')) {
    return '';
  }
  return /^[A-Za-z0-9._/-]+$/.test(cleaned) ? cleaned : '';
}

/** 读取玩家自定义覆盖的版本号；未设置时返回空字符串（由加载器采用默认基准版本）。 */
export function readScriptRef(readStorage) {
  if (typeof readStorage !== 'function') return '';
  try {
    return normalizeScriptRef(readStorage(SCRIPT_REF_KEY));
  } catch {
    return '';
  }
}

/** 保存玩家自定义覆盖的版本号；传入空值时恢复跟随加载器默认版本。 */
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

/** 从 jsDelivr 元数据接口拉取已发布的版本列表，自动补齐默认版本与 main 分支。 */
export async function fetchAvailableScriptRefs(fetchFn = globalThis.fetch, defaultRef = DEFAULT_SCRIPT_REF) {
  const list = [];
  const pushUnique = (val) => {
    const n = normalizeScriptRef(val);
    if (n && !list.includes(n)) list.push(n);
  };

  if (typeof fetchFn === 'function') {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
    try {
      const res = await fetchFn(JSDELIVR_VERSIONS_URL, {
        cache: 'no-cache',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (res && res.ok) {
        const payload = await res.json();
        const rawVersions = Array.isArray(payload?.versions) ? payload.versions : [];
        for (const entry of rawVersions) {
          if (typeof entry === 'string') pushUnique(entry);
          else if (entry && typeof entry.version === 'string') pushUnique(entry.version);
        }
      }
    } catch {
      /* 拉取失败时退回内置基础选项 */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  pushUnique(defaultRef || DEFAULT_SCRIPT_REF);
  pushUnique('main');
  return list;
}
