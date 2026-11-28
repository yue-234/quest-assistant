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
  const matches = [...String(text ?? '').matchAll(/(?:^|[^a-zA-Z0-9_.])v?(\d+\.\d+(?:\.\d+)?)(?=$|[^a-zA-Z0-9_.])/gi)];
  if (!matches.length) return '';
  return `v${matches[matches.length - 1][1]}`;
}

/** 判断一条世界书条目是否属于「任务助手」（避免主世界书中普通说明/备忘误判）。 */
export function isQuestAssistantEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const content = String(entry.content ?? '');
  if (
    content.includes('<任务情报板变量更新协议>')
    || content.includes('<任务情报板当前状态>')
    || content.includes('yue-234/quest-assistant')
    || /\/\/\s*@role\s+(?:plot|update|all)\b/i.test(content)
    || /const\s+_wbRole\s*=\s*['"](?:plot|update|all)['"]/.test(content)
    || (/\/\/\s*@version\b/i.test(content) && content.includes('/事件/任务情报板'))
    || (content.includes('<任务情报板>') && content.includes('</任务情报板>'))
  ) {
    return true;
  }
  const title = String(entry.name ?? entry.comment ?? '').trim();
  if (title.includes('任务助手')) return true;
  const hasMvuRoleTag = /\[(?:mvu_plot|mvu_update)\]/i.test(title);
  return hasMvuRoleTag && title.includes('任务情报板');
}

function extractEntryContentVersion(content) {
  const m = String(content ?? '').match(/\/\/\s*@version\s+([^\s\r\n]+)/i);
  return m ? extractVersionFromText(m[1]) : '';
}

function detectEntryRole(entry) {
  const title = String(entry?.name ?? entry?.comment ?? '').trim();
  const content = String(entry?.content ?? '');
  const hasPlotTag = /\[mvu_plot\]/i.test(title);
  const hasUpdateTag = /\[mvu_update\]/i.test(title);
  const hasPlotMarkup = content.includes('<任务情报板>') || content.includes('推进规则:');
  const hasUpdateMarkup = content.includes('<任务情报板变量更新协议>') || content.includes('任务情报板变量更新规则');

  let role = 'all';
  const roleMeta = content.match(/\/\/\s*@role\s+(plot|update|all)\b/i);
  const roleConst = !roleMeta && content.match(/const\s+_wbRole\s*=\s*['"](plot|update|all)['"]/);
  if (roleMeta) {
    const r = roleMeta[1].toLowerCase();
    role = r === 'plot' || r === 'update' ? r : 'all';
  } else if (roleConst) {
    const r = roleConst[1];
    role = r === 'plot' || r === 'update' ? r : 'all';
  } else if (title.includes('剧情引导')) {
    role = 'plot';
  } else if (title.includes('变量更新')) {
    role = 'update';
  } else if (hasPlotMarkup && hasUpdateMarkup) {
    role = 'all';
  } else if (hasUpdateMarkup) {
    role = 'update';
  } else if (hasPlotMarkup) {
    role = 'plot';
  } else if (hasPlotTag && !hasUpdateTag) {
    role = 'plot';
  } else if (hasUpdateTag && !hasPlotTag) {
    role = 'update';
  }

  return {
    role,
    hasMvuTag: hasPlotTag,
    hasLegacyUpdateTag: hasUpdateTag,
  };
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
      const bookVer = bookName.includes('任务助手') ? extractVersionFromText(bookName) : '';
      const version = titleVer || contentVer || bookVer;
      const { role, hasMvuTag, hasLegacyUpdateTag } = detectEntryRole(entry);
      candidates.push({ bookName, title, enabled, version, role, hasMvuTag, hasLegacyUpdateTag });
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

  const enabledCandidates = candidates.filter((c) => c.enabled);
  if (enabledCandidates.length === 0) {
    const best = candidates[0];
    const hasDual = candidates.some((c) => c.role === 'plot') || candidates.some((c) => c.role === 'update');
    return {
      supported: true,
      found: true,
      enabled: false,
      version: best.version,
      title: best.title,
      bookName: best.bookName,
      ...(hasDual ? { dualMode: true } : {}),
    };
  }

  const enabledPlot = enabledCandidates.filter((c) => c.role === 'plot');
  const enabledUpdate = enabledCandidates.filter((c) => c.role === 'update');
  const enabledLegacy = enabledCandidates.filter((c) => c.role === 'all');
  const hasDualEnabled = enabledPlot.length > 0 || enabledUpdate.length > 0;
  const legacyDualMixed = hasDualEnabled && enabledLegacy.length > 0;
  const duplicateConflict = enabledPlot.length > 1 || enabledUpdate.length > 1 || enabledLegacy.length > 1;

  // 收集已启用条目的去重语义版本号（按 semver 降序，末尾为较低版本）
  const distinctVersions = [];
  for (const c of enabledCandidates) {
    if (!c.version) continue;
    if (!distinctVersions.some((v) => compareSemverTags(v, c.version) === 0)) {
      distinctVersions.push(c.version);
    }
  }
  distinctVersions.sort(compareSemverTags);

  const hasPartialDisabled = hasDualEnabled
    && (enabledPlot.length === 0 || enabledUpdate.length === 0);
  const missingRole = hasPartialDisabled
    ? (enabledPlot.length === 0 ? 'plot' : 'update')
    : '';

  const hasVersioned = enabledCandidates.some((c) => !!c.version);
  const hasUnversioned = enabledCandidates.some((c) => !c.version);
  const missingRoleVersion = hasVersioned && hasUnversioned;
  const versionConflict = distinctVersions.length > 1;

  const legacyMvuUpdate = enabledCandidates.some((c) => c.hasLegacyUpdateTag);
  const missingMvuTag = hasDualEnabled
    && enabledCandidates.some((c) => (c.role === 'plot' || c.role === 'update') && !c.hasMvuTag);

  const primary = enabledPlot[0] || enabledUpdate[0] || enabledCandidates[0];
  const bookNames = [...new Set(enabledCandidates.map((c) => c.bookName).filter(Boolean))];
  const resolvedVersion = versionConflict
    ? (distinctVersions[distinctVersions.length - 1] || primary.version)
    : (distinctVersions[0] || primary.version);

  const result = {
    supported: true,
    found: true,
    enabled: true,
    version: resolvedVersion,
    title: primary.title,
    bookName: bookNames.join(' / ') || primary.bookName,
  };
  if (hasDualEnabled) {
    result.dualMode = true;
    result.titles = [enabledPlot[0]?.title, enabledUpdate[0]?.title].filter(Boolean);
  }
  if (hasPartialDisabled) {
    result.partialDisabled = true;
    result.missingRole = missingRole;
  }
  if (legacyDualMixed) result.legacyDualMixed = true;
  if (duplicateConflict) result.duplicateConflict = true;
  if (legacyMvuUpdate) result.legacyMvuUpdate = true;
  if (missingMvuTag) result.missingMvuTag = true;
  if (missingRoleVersion) result.missingRoleVersion = true;
  if (versionConflict) {
    result.versionConflict = true;
    result.versions = distinctVersions;
  }
  return result;
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
  if (wbInfo.legacyDualMixed) {
    return {
      status: 'legacy_dual_mixed',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '检测到旧版单条目与新版双条目同时启用，请关闭或删除旧条目仅保留一套',
    };
  }
  if (wbInfo.duplicateConflict) {
    return {
      status: 'duplicate_role',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '世界书中同时启用了多份同角色任务助手条目，请清理重复条目',
    };
  }
  if (wbInfo.legacyMvuUpdate) {
    return {
      status: 'legacy_mvu_update',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '检测到世界书条目标题仍包含 [mvu_update] 前缀，当前版本已改为双 [mvu_plot] 条目随主模型运行，请重新导入最新双条目世界书或将分拆条目标题前缀改为 [mvu_plot]',
    };
  }
  if (wbInfo.partialDisabled) {
    const missingLabel = wbInfo.missingRole === 'plot'
      ? '「剧情引导 [mvu_plot]」'
      : (wbInfo.missingRole === 'update' ? '「变量更新 [mvu_plot]」' : '另一半');
    return {
      status: 'partial_disabled',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: `任务助手双条目世界书仅启用了部分条目，缺少${missingLabel}，请同时启用两个条目`,
    };
  }
  if (wbInfo.missingMvuTag) {
    return {
      status: 'missing_mvu_tag',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '分拆条目标题缺少 [mvu_plot] 前缀，请补上 [mvu_plot] 标签或重新导入世界书',
    };
  }
  if (wbInfo.versionConflict) {
    return {
      status: 'mismatch',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '世界书中存在多个不同版本的任务助手条目，请清理旧条目并保持版本一致',
    };
  }
  if (wbInfo.missingRoleVersion) {
    return {
      status: 'version_unannotated',
      mismatch: true,
      worldbookVersion: wbInfo.version || '',
      scriptVersion: scriptVer,
      message: '已启用的任务助手条目中部分未标注版本号，请重新导入一致版本',
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

/** 根据世界书兼容性检查结果生成设置页徽章文案与样式色调。 */
export function worldbookCompatibilityBadge(wbCheck, wbInfo, { loading = false } = {}) {
  if (loading && !wbInfo) return { text: '检测中', tone: 'muted' };
  if (wbCheck?.status === 'matched') return { text: '✓ 与脚本匹配', tone: 'ok' };
  if (wbCheck?.mismatch) {
    if (wbCheck.status === 'disabled') return { text: '条目未启用', tone: 'warn' };
    if (wbCheck.status === 'partial_disabled') return { text: '双条目未全开', tone: 'warn' };
    if (wbCheck.status === 'duplicate_role') return { text: '同角色条目重复', tone: 'warn' };
    if (wbCheck.status === 'legacy_dual_mixed') return { text: '新旧条目混用', tone: 'warn' };
    if (wbCheck.status === 'legacy_mvu_update') return { text: '含旧 [mvu_update] 前缀', tone: 'warn' };
    if (wbCheck.status === 'missing_mvu_tag') return { text: '缺少 [mvu_plot] 标签', tone: 'warn' };
    if (wbCheck.status === 'version_unannotated') return { text: '部分未标版本', tone: 'warn' };
    if (wbInfo?.versionConflict) return { text: '双条目版本不一致', tone: 'warn' };
    return { text: '版本不匹配 · 建议更新', tone: 'warn' };
  }
  return { text: wbCheck?.status === 'unversioned' ? '无版本号' : '未识别', tone: 'muted' };
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
