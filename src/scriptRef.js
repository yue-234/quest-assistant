// 远程脚本版本号（Git Ref）配置与实时最新版本查询工具。

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

/** 解析语义化版本号（如 v1.4.2），用于比较版本高低；非数字版本返回 null。 */
function parseSemverTag(tag) {
  const m = String(tag ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] || '',
  };
}

/** 比较两个版本 Tag，降序排列时返回负数表示 a 新于 b。 */
export function compareSemverTags(a, b) {
  const pa = parseSemverTag(a);
  const pb = parseSemverTag(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pb.major - pa.major;
    if (pa.minor !== pb.minor) return pb.minor - pa.minor;
    if (pa.patch !== pb.patch) return pb.patch - pa.patch;
    if (pa.pre !== pb.pre) {
      if (!pa.pre) return -1;
      if (!pb.pre) return 1;
      return pb.pre.localeCompare(pa.pre);
    }
    return 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return String(b ?? '').localeCompare(String(a ?? ''));
}

/** 判断远端最新 Tag 是否严格高于当前运行版本。 */
export function hasNewerScriptVersion(latestTag, meta = {}) {
  const latest = normalizeScriptRef(latestTag);
  if (!latest) return false;
  const loadedRef = normalizeScriptRef(meta?.loadedRef);
  const scriptVersion = normalizeScriptRef(meta?.scriptVersion);
  const current = (!loadedRef || loadedRef === 'main') ? scriptVersion : loadedRef;
  if (!current) return false;
  return compareSemverTags(latest, current) < 0;
}

/** 从文本（如世界书子标题 "任务助手v1.4.4"）中提取并归一化版本号（vX.Y.Z）。 */
export function extractVersionFromText(text) {
  const m = String(text ?? '').match(/(?:^|[^a-zA-Z0-9_.])v?(\d+\.\d+(?:\.\d+)?)(?=$|[^a-zA-Z0-9_.])/i);
  if (!m) return '';
  return `v${m[1]}`;
}

/** 判断一条世界书条目是否属于「任务助手」。 */
export function isQuestAssistantEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const content = String(entry.content ?? '');
  if (
    content.includes('/事件/任务情报板')
    || content.includes('<任务情报板>')
    || content.includes('yue-234/quest-assistant')
  ) {
    return true;
  }
  const title = String(entry.name ?? entry.comment ?? '').trim();
  return title.includes('任务助手') || title.includes('任务情报板');
}

function extractEntryContentVersion(content) {
  const m = String(content ?? '').match(/\/\/\s*@version\s+([^\s\r\n]+)/i);
  return m ? extractVersionFromText(m[1]) : '';
}

/** 从当前启用的世界书集合中定位任务助手条目，并优先从其子标题提取版本号。 */
export function inspectWorldbookEntries(bookEntriesList = []) {
  const candidates = [];
  for (const book of bookEntriesList) {
    const bookName = String(book?.bookName ?? '').trim();
    const entries = Array.isArray(book?.entries) ? book.entries : [];
    for (const entry of entries) {
      if (!isQuestAssistantEntry(entry)) continue;
      const title = String(entry.name ?? entry.comment ?? '').trim();
      const enabled = entry.enabled !== false && entry.disable !== true;
      const titleVer = extractVersionFromText(title);
      const contentVer = extractEntryContentVersion(entry.content);
      const bookVer = extractVersionFromText(bookName);
      const version = titleVer || contentVer || bookVer;
      candidates.push({ bookName, title, enabled, version });
    }
  }

  if (candidates.length === 0) {
    return { supported: true, found: false, enabled: false, version: '', title: '', bookName: '' };
  }

  candidates.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (!!a.version !== !!b.version) return a.version ? -1 : 1;
    return 0;
  });

  const best = candidates[0];
  return {
    supported: true,
    found: true,
    enabled: best.enabled,
    version: best.version,
    title: best.title,
    bookName: best.bookName,
  };
}

/** 校验世界书版本与当前脚本运行版本是否匹配（决定设置按钮是否显示红点提醒）。 */
export function checkWorldbookCompatibility(wbInfo, scriptMeta = {}) {
  const loadedRef = normalizeScriptRef(scriptMeta?.loadedRef);
  const scriptRaw = (!loadedRef || loadedRef === 'main') ? scriptMeta?.scriptVersion : loadedRef;
  const scriptVer = extractVersionFromText(scriptRaw) || normalizeScriptRef(scriptRaw);

  if (!wbInfo || wbInfo.supported === false) {
    return {
      status: 'unsupported',
      mismatch: false,
      worldbookVersion: '',
      scriptVersion: scriptVer,
      message: '当前环境未提供世界书读取接口',
    };
  }
  if (!wbInfo.found) {
    return {
      status: 'not_found',
      mismatch: false,
      worldbookVersion: '',
      scriptVersion: scriptVer,
      message: '未在当前启用世界书中检测到任务助手条目',
    };
  }
  if (!wbInfo.enabled) {
    return {
      status: 'disabled',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '世界书中的任务助手条目当前处于关闭状态，请启用并保持版本一致',
    };
  }
  if (!wbInfo.version) {
    return {
      status: 'unversioned',
      mismatch: false,
      worldbookVersion: '',
      scriptVersion: scriptVer,
      message: `已检测到「${wbInfo.title || '任务助手'}」，但子标题未标注版本号`,
    };
  }
  if (scriptVer && compareSemverTags(wbInfo.version, scriptVer) === 0) {
    return {
      status: 'matched',
      mismatch: false,
      worldbookVersion: wbInfo.version,
      scriptVersion: scriptVer,
      message: '世界书与脚本版本匹配',
    };
  }
  return {
    status: 'mismatch',
    mismatch: true,
    worldbookVersion: wbInfo.version,
    scriptVersion: scriptVer,
    message: `世界书版本 ${wbInfo.version} 与当前脚本 ${scriptVer || '未知'} 不匹配，建议更新至一致版本`,
  };
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
      cache: 'no-store',
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

async function queryRemoteTags(fetchFn) {
  if (typeof fetchFn !== 'function') return [];

  const collect = (rawList, extract) => {
    const out = [];
    for (const entry of rawList) {
      const n = normalizeScriptRef(extract(entry));
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  };

  // 优先直接查询 GitHub Tags API（实时反映最新推送的 Tag），失败或空时回退 jsDelivr 列表
  const ghTags = await fetchJsonWithTimeout(fetchFn, GITHUB_TAGS_URL);
  if (Array.isArray(ghTags)) {
    const parsed = collect(ghTags, (t) => t?.name);
    if (parsed.length > 0) return parsed;
  }

  const jsdPayload = await fetchJsonWithTimeout(fetchFn, JSDELIVR_VERSIONS_URL);
  const jsdVersions = Array.isArray(jsdPayload?.versions) ? jsdPayload.versions : [];
  return collect(jsdVersions, (v) => (typeof v === 'string' ? v : v?.version));
}

/** 实时获取最新发布的版本 Tag（按语义化版本号降序取最高），失败时返回空字符串。 */
export async function fetchLatestScriptTag(fetchFn = globalThis.fetch) {
  const tags = await queryRemoteTags(fetchFn);
  if (!tags.length) return '';
  const sorted = tags.slice().sort(compareSemverTags);
  return sorted[0] || '';
}

/** 拉取已发布版本列表并补齐 main 与基准版本。 */
export async function fetchAvailableScriptRefs(fetchFn = globalThis.fetch, defaultRef = DEFAULT_SCRIPT_REF) {
  const list = [];
  const pushUnique = (val) => {
    const n = normalizeScriptRef(val);
    if (n && !list.includes(n)) list.push(n);
  };

  pushUnique(defaultRef || DEFAULT_SCRIPT_REF);
  const tags = await queryRemoteTags(fetchFn);
  tags.slice().sort(compareSemverTags).forEach(pushUnique);
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
