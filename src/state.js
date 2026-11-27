// 独立任务助手的状态推算。只读 stat_data 与聊天记录，不修改任何数据。
// 与「任务助手-世界书.ejs」采用同一套区域识别、去后缀匹配与三合一完结判定算法。

import { DATA, DATA_VERSION } from './data.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const text = (v) => String(v ?? '');
const int = (v) => {
  const m = text(v).replace(/[,，]/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : 0;
};

/** 独立任务情报板在 stat_data.事件 下的键名（/事件/任务情报板）。 */
export const BOARD_KEY = '任务情报板';

/** 独立标识（不依赖任何命定核心）。 */
export const CORE_NAME = '任务助手';
export const SPEAKER = '任务助手';

// ---------------------------------------------------------------------------
// 基础读取
// ---------------------------------------------------------------------------

/** 命定点数（沿用命定之诗通用路径 stat_data.命运点数）。 */
export function fpOf(stat) {
  return int(obj(stat)['命运点数']);
}

/** 将各类世界时间格式归一为稳定的「世界日」键。 */
export function normalizeDay(raw) {
  const s = text(raw).trim();
  if (!s) return '';

  const ymd = s.match(/^(.*?)(\d+)\s*年.*?(\d{1,2})\s*月.*?(\d{1,2})\s*日/);
  if (ymd) {
    const era = (ymd[1] || '').replace(/[\s-]+$/g, '');
    return `${era}${Number(ymd[2])}年-${Number(ymd[3])}月-${Number(ymd[4])}日`;
  }

  const md = s.match(/^(.*?)(\d{1,2})\s*月.*?(\d{1,2})\s*日/);
  if (md) {
    const prefix = (md[1] || '').replace(/[\s-]+$/g, '');
    return `${prefix}${Number(md[2])}月-${Number(md[3])}日`;
  }

  const iso = s.match(/^(.*?)(\d{1,6})[-/.](\d{1,2})[-/.](\d{1,2})(?=$|[\sT\-–—,，(（])/);
  if (iso) {
    const prefix = (iso[1] || '').replace(/[\s-]+$/g, '');
    const m = String(Number(iso[3])).padStart(2, '0');
    const d = String(Number(iso[4])).padStart(2, '0');
    return `${prefix}${iso[2]}-${m}-${d}`;
  }

  const stripped = s
    .replace(/[\sT\-–—,，]+(?:星期|周|礼拜)[一二三四五六日天].*$/, '')
    .replace(/[\sT\-–—,，]+\d{1,2}:\d{2}(?::\d{2})?.*$/, '')
    .replace(/[\s\-–—,，]+(?:凌晨|拂晓|黎明|清晨|早晨|早上|上午|正午|中午|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|午夜).*$/, '')
    .trim();
  const base = stripped || s.split(/\s+/)[0].split('T')[0];
  return base.length > 32 ? base.slice(0, 32) : base;
}

export function worldDay(stat) {
  return normalizeDay(obj(obj(stat)['世界'])['时间']);
}

/** 读取独立任务情报板节点（/事件/任务情报板）。 */
export function boardNode(stat) {
  return obj(obj(obj(stat)['事件'])[BOARD_KEY]);
}

// ---------------------------------------------------------------------------
// 区域识别与任务情报板解析
// ---------------------------------------------------------------------------

const QUEST_CATEGORY_ORDER = { 剧情任务: 0, 本地主线: 1, 支线任务: 2 };
const SUB_PLACE_SUFFIX =
  /(?:区|街|巷|道|路|广场|市场|集市|酒馆|旅馆|客栈|大厅|大殿|宫殿|房|室|店|铺|阁|楼|层|号|码头|站台|营地|入口|门口|走廊|甲板|房间|内部|露台|塔顶|地下|外廊|庭院|花园|港口区)$/;

function normGeo(v) {
  return text(v).trim().toLowerCase().replace(/\s+/g, '');
}

function splitLoc(v) {
  return text(v)
    .split(/[-－—>＞/／,，、;；·•・\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从地点字符串与地理图谱中解析出稳定的「区域级」标识。
 * 同城内部街道/酒馆/房间移动命中同一区域，不误判换区。
 */
export function resolveRegionText(rawText, geoData = null) {
  const raw = text(rawText).trim();
  if (!raw) return { key: '', name: '', raw: '' };

  const places = Array.isArray(geoData && geoData.places) ? geoData.places : [];
  if (places.length) {
    const byId = Object.create(null);
    for (const p of places) {
      if (p && p.id) byId[p.id] = p;
    }
    const depthOf = (p) => {
      let d = 0;
      let cur = p;
      const seen = new Set();
      while (cur && cur.parent && !seen.has(cur.parent) && byId[cur.parent]) {
        seen.add(cur.parent);
        cur = byId[cur.parent];
        d += 1;
      }
      return d;
    };
    const cmp = (a, b) => {
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    };

    const nQuery = normGeo(raw);
    const segs = splitLoc(raw).map(normGeo).filter(Boolean);
    let bestPlace = null;
    let bestScore = null;

    for (const place of places) {
      if (!place || place.is_geographic === false) continue;
      const tokens = [place.id, place.name, ...(Array.isArray(place.keywords) ? place.keywords : [])]
        .map(normGeo)
        .filter(Boolean);
      const d = depthOf(place);
      const imp = Number(place.importance || 0);
      for (const tk of tokens) {
        let sc = null;
        if (nQuery === tk) sc = [2, d, 4, segs.length, imp, tk.length];
        for (let i = 0; i < segs.length; i += 1) {
          let cur = null;
          if (segs[i] === tk) cur = [2, d, 3, i, imp, tk.length];
          else if (segs[i].includes(tk)) cur = [2, d, 2, i, imp, tk.length];
          if (cur && (!sc || cmp(cur, sc) > 0)) sc = cur;
        }
        if (!sc && nQuery.includes(tk)) sc = [1, d, 1, 0, imp, tk.length];
        if (sc && (!bestScore || cmp(sc, bestScore) > 0)) {
          bestScore = sc;
          bestPlace = place;
        }
      }
    }

    if (bestPlace) {
      const name = text(bestPlace.name).trim() || text(bestPlace.id).trim();
      return { key: text(bestPlace.id).trim() || normGeo(name), name, raw };
    }
  }

  const parts = splitLoc(raw);
  if (!parts.length) return { key: normGeo(raw), name: raw, raw };
  let trimmed = parts.slice(0, Math.min(parts.length, 4));
  while (trimmed.length > 1 && SUB_PLACE_SUFFIX.test(trimmed[trimmed.length - 1])) {
    trimmed = trimmed.slice(0, -1);
  }
  const name = trimmed[trimmed.length - 1];
  return { key: normGeo(name), name, raw };
}

/** 从 stat_data.世界.地点 提取区域级标识。 */
export function resolveRegion(stat, geoData = null) {
  return resolveRegionText(obj(obj(stat)['世界'])['地点'], geoData);
}

function sameRegion(region, boardKeyRaw, boardNameRaw, geoData = null) {
  if (!region.key && !region.name) return true;
  if (!boardKeyRaw && !boardNameRaw) return true;
  const rk = normGeo(region.key);
  const rn = normGeo(region.name);
  const bk = normGeo(boardKeyRaw);
  const bn = normGeo(boardNameRaw);
  if ((rk && (bk === rk || bn === rk)) || (rn && (bk === rn || bn === rn))) return true;
  const parsedBoard = resolveRegionText(boardNameRaw || boardKeyRaw, geoData);
  const pbk = normGeo(parsedBoard.key);
  const pbn = normGeo(parsedBoard.name);
  if ((rk && pbk && pbk === rk) || (rn && pbn && pbn === rn)) return true;
  if (rn && ((bn && bn.endsWith(rn)) || (bk && bk.endsWith(rn)))) return true;
  return false;
}

function normalizeQuestCategory(raw) {
  const s = text(raw).trim();
  if (s.includes('剧情')) return '剧情任务';
  if (s.includes('主线')) return '本地主线';
  return '支线任务';
}

const QUEST_WAY_RULES = [
  { re: /悬赏|讨伐|通缉|清剿|狩猎/, way: '悬赏讨伐', wayKind: 'contact', guideLabel: '悬赏指引' },
  { re: /危机|救援|救助|救人|突围|解围|逃亡|追杀|护送/, way: '危机介入', wayKind: 'crisis', guideLabel: '切入指引' },
  { re: /调查|追查|查案|侦查|暗访|追踪|寻人/, way: '调查追踪', wayKind: 'clue', guideLabel: '调查线索' },
  { re: /探索|寻宝|遗迹|秘境|迷宫|勘探/, way: '探索寻宝', wayKind: 'clue', guideLabel: '探索线索' },
  { re: /周旋|交涉|谈判|博弈|潜入|刺探|斡旋|调停/, way: '势力周旋', wayKind: 'clue', guideLabel: '切入指引' },
  { re: /异象|灾厄|异变|异动|失控|污染|异常/, way: '异象处置', wayKind: 'crisis', guideLabel: '现场线索' },
  { re: /委托|雇佣|征召|代办|跑腿|采集|押运/, way: '委托接取', wayKind: 'contact', guideLabel: '接取指引' },
];

function normalizeQuestWay(raw) {
  const s = text(raw).trim();
  if (!s) return { way: '委托接取', wayKind: 'contact', guideLabel: '接取指引' };
  for (const rule of QUEST_WAY_RULES) {
    if (rule.re.test(s)) return { way: rule.way, wayKind: rule.wayKind, guideLabel: rule.guideLabel };
  }
  if (s.length >= 2 && s.length <= 6) {
    return { way: s, wayKind: 'clue', guideLabel: '切入指引' };
  }
  return { way: '委托接取', wayKind: 'contact', guideLabel: '接取指引' };
}

export const CLAIMED_MARK_RE = /(?:[✓✔☑]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得|[✓✔☑])\s*[\]】）)]|\[\s*\d+\s*[✓✔☑]\s*\])/;
export const LOST_MARK_RE = /(?:[✕✗✘]|[\[【（(]\s*(?:已失效|已错失|已作废|[✕✗✘×])\s*[\]】）)]|\[\s*\d+\s*[✕✗✘×]\s*\]|^\s*×(?!\s*\d)|(?:\s+×|(?<!\d)×)\s*$)/;

export function cleanRewardText(raw) {
  return text(raw)
    .replace(/^\s*\[\s*\d+\s*[✓✔☑✕✗✘×□☐]?\s*\]\s*/g, '')
    .replace(/(?:\s*(?:[✓✔☑✕✗✘]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得|已失效|已错失|已作废|[✓✔☑✕✗✘×])\s*[\]】）)])|(?:\s+×|(?<!\d)×))+\s*$/g, '')
    .replace(/^\s*(?:[✓✔☑✕✗✘]|×(?!\s*\d)|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得|已失效|已错失|已作废|[✓✔☑✕✗✘×])\s*[\]】）)])+\s*/g, '')
    .trim();
}

function toRewardRawArray(raw) {
  if (Array.isArray(raw)) return [...raw];
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[、，,;\n；|｜]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/** 合并奖励状态 map 中同一任务通过 id 与 title 双键保存的条目，避免双键并存时丢数据。 */
export function mergeRewardMapEntries(map, id, title = '') {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const k1 = text(id).trim();
  const k2 = text(title).trim();
  const out = [];
  if (k1 && Object.prototype.hasOwnProperty.call(map, k1)) {
    out.push(...toRewardRawArray(map[k1]));
  }
  if (k2 && k2 !== k1 && Object.prototype.hasOwnProperty.call(map, k2)) {
    out.push(...toRewardRawArray(map[k2]));
  }
  return out;
}

function parseRewardSlotSet(raw) {
  const slots = new Set();
  const texts = new Set();
  const arr = toRewardRawArray(raw);
  for (const item of arr) {
    if (typeof item === 'number' && Number.isFinite(item) && item >= 1) {
      slots.add(Math.floor(item));
      continue;
    }
    const s = text(item).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 1) slots.add(n);
    } else {
      const cleaned = cleanRewardText(s);
      if (cleaned) texts.add(cleaned.replace(/\s+/g, ''));
    }
  }
  return { slots, texts };
}

export function parseClaimedSet(raw) {
  return parseRewardSlotSet(raw);
}

export function parseLostSet(raw) {
  return parseRewardSlotSet(raw);
}

export function normalizeQuestRewards(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => text(x).trim()).filter(Boolean);
  }
  const s = text(raw).trim();
  if (!s) return [];
  return s
    .split(/[、，,;\n；|｜]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 一次重扫请求是否仍然新鲜（尚未经过下一回合消费）。 */
export function rescanFresh(pending, current = {}) {
  if (!pending || !Object.keys(pending).length) return false;
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const atCount = num(pending['消息数']);
  const nowCount = num(current.chatCount);
  if (atCount !== null && nowCount !== null) return nowCount <= atCount + 1;
  const atFloor = num(pending['楼层']);
  const nowFloor = num(current.floor);
  if (atFloor !== null && nowFloor !== null) return nowFloor <= atFloor + 2;
  return false;
}

const CLOSED_TASK_RE = /(?:已完成|完成|已失败|失败|已结束|已取消|放弃)/;

export function stripTaskTitle(s) {
  return text(s)
    .replace(/^\s*(?:[\[【][^\]】]*[\]】])\s*/g, '')
    .replace(/(?:\s*(?:[（(][^）)]*[）)]|[\[【][^\]】]*[\]】]))+\s*$/g, '')
    .replace(/[\s·•・:：—\-－,，、。!！?？「」『』《》“”‘’"']+/g, '')
    .trim()
    .toLowerCase();
}

export function matchFormalTask(formalList, title) {
  if (!title || !formalList.length) return null;
  const exact = formalList.find((t) => t.key === title);
  if (exact) return exact;
  const norm = stripTaskTitle(title);
  if (norm) {
    const normExact = formalList.find((t) => stripTaskTitle(t.key) === norm);
    if (normExact) return normExact;
    if (norm.length >= 4) {
      const normSub = formalList.find((t) => {
        const tk = stripTaskTitle(t.key);
        if (tk.length < 4) return false;
        if (!tk.includes(norm) && !norm.includes(tk)) return false;
        return Math.min(tk.length, norm.length) / Math.max(tk.length, norm.length) >= 0.75;
      });
      if (normSub) return normSub;
    }
  }
  return null;
}

/**
 * 从酒馆聊天数组（chat[i].variables[swipe_id].stat_data）或消息列表（{ stat }）中提取最近历史楼层的 stat_data。
 * 只读不写，用于反查某条任务是否曾进入过正式「任务列表」。
 */
export function extractHistoryStats(chatOrMessages, limit = 50) {
  if (!Array.isArray(chatOrMessages) || !chatOrMessages.length) return [];
  const out = [];
  for (let i = chatOrMessages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = chatOrMessages[i];
    if (!m || typeof m !== 'object') continue;
    let hs = null;
    if (Array.isArray(m.variables)) {
      const v = m.variables[m.swipe_id ?? 0];
      if (v && typeof v === 'object' && v.stat_data && typeof v.stat_data === 'object') hs = v.stat_data;
    } else if (m.stat && typeof m.stat === 'object') {
      hs = m.stat;
    } else if (m.stat_data && typeof m.stat_data === 'object') {
      hs = m.stat_data;
    } else if ('任务列表' in m || '事件' in m) {
      hs = m;
    }
    if (hs) out.push(hs);
  }
  return out;
}

/** 检查某条任务是否在历史楼层的正式「任务列表」中出现过（且必须与该层任务情报板上的该条同框）。 */
export function wasInHistoryFormalTasks(historyStats, id, title) {
  if (!Array.isArray(historyStats) || !historyStats.length || !title) return false;
  const norm = stripTaskTitle(title);
  for (const hStat of historyStats) {
    const hFormalMap = obj(obj(hStat)['任务列表']);
    const hKeys = Object.keys(hFormalMap);
    if (!hKeys.length) continue;
    const hFormalList = hKeys
      .map((k) => ({ key: text(k).trim(), status: text(obj(hFormalMap[k])['状态']).trim() }))
      .filter((t) => !!t.key);
    if (!matchFormalTask(hFormalList, title)) continue;

    const hBoard = obj(obj(obj(hStat)['事件'])[BOARD_KEY]);
    const hBoardList = Array.isArray(hBoard['列表'])
      ? hBoard['列表'].map((item, idx) => ({ item, rawKey: '', idx }))
      : Object.entries(obj(hBoard['列表'])).map(([k, v], idx) => ({ item: v, rawKey: text(k).trim(), idx }));
    if (hBoardList.length === 0) continue;
    const onBoard = hBoardList.some(({ item, rawKey, idx }) => {
      const r = obj(item);
      const itemId = rawKey || text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
      const itemTitle = text(r['标题']).trim();
      if (id && itemId === id && (!itemTitle || itemTitle === title || (norm && stripTaskTitle(itemTitle) === norm))) {
        return true;
      }
      if (itemTitle && (itemTitle === title || (norm && stripTaskTitle(itemTitle) === norm))) return true;
      return false;
    });
    if (!onBoard) continue;
    return true;
  }
  return false;
}

const AFTERMATH_TONE_MAP = { 绿: 'green', 黄: 'yellow', 红: 'red' };
const MONTH_PREFIX = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const validMD = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const ymdOrd = (y, mo, d) => y * 365 + MONTH_PREFIX[mo - 1] + d;

function parseYmdInfo(raw) {
  const norm = normalizeDay(raw);
  if (!norm) return null;
  const m = norm.match(/(\d+)\s*年?-(\d{1,2})\s*月?-(\d{1,2})\s*日?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return validMD(mo, d) ? { y, mo, d, ord: ymdOrd(y, mo, d) } : null;
}

function parseUntilOrdinal(untilRaw, curInfo) {
  const raw = text(untilRaw).trim();
  if (!raw || /(?:^|[^a-zA-Z0-9_])[vV]\d+\.\d+(?:\.\d+)?/.test(raw)) return null;
  const norm = normalizeDay(raw);
  const ymd = norm.match(/(\d+)\s*年?-(\d{1,2})\s*月?-(\d{1,2})\s*日?/);
  if (ymd) {
    const y = Number(ymd[1]);
    const mo = Number(ymd[2]);
    const d = Number(ymd[3]);
    return validMD(mo, d) ? ymdOrd(y, mo, d) : null;
  }
  const md = norm.match(/(?:^|[^\d])(\d{1,2})月-(\d{1,2})日/);
  if (md && curInfo) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    if (!validMD(mo, d)) return null;
    let ord = ymdOrd(curInfo.y, mo, d);
    if (ord < curInfo.ord - 180) ord = ymdOrd(curInfo.y + 1, mo, d);
    return ord;
  }
  return null;
}

/** 解析单条区域/世界词条，支持「[绿/黄/红][至到期日]【短标签】正文」（前缀顺序任意）、无色阶与旧纯文本兼容格式。 */
export function parseAftermathEntry(raw, currentDay = '') {
  const str = text(raw).trim();
  if (!str) {
    return { text: '', tone: '', tag: '', body: '', until: '', isTemp: false, daysLeft: null, expired: false };
  }
  let rest = str;
  let tone = '';
  let until = '';
  for (let guard = 0; guard < 4; guard += 1) {
    if (!tone) {
      const toneMatch = rest.match(/^(?:\[([绿黄红])\]|【([绿黄红])】)\s*/);
      if (toneMatch) {
        tone = AFTERMATH_TONE_MAP[toneMatch[1] || toneMatch[2]] || '';
        rest = rest.slice(toneMatch[0].length);
        continue;
      }
    }
    if (!until) {
      const untilMatch = rest.match(/^(?:\[\s*至\s*([^\]]+)\]|【\s*至\s*([^】]+)】)\s*/);
      if (untilMatch) {
        until = (untilMatch[1] || untilMatch[2] || '').trim();
        rest = rest.slice(untilMatch[0].length);
        continue;
      }
    }
    break;
  }
  const tagMatch = rest.match(/^【([^】]{1,12})】\s*([\s\S]*)$/);
  const tag = tagMatch ? tagMatch[1].trim() : '';
  const body = tagMatch ? tagMatch[2].trim() : (rest.trim() || str);
  const isTemp = !!until;
  let daysLeft = null;
  if (isTemp && currentDay) {
    const curInfo = parseYmdInfo(currentDay);
    if (curInfo) {
      const untilOrd = parseUntilOrdinal(until, curInfo);
      if (untilOrd !== null) {
        daysLeft = untilOrd - curInfo.ord;
      }
    }
  }
  const expired = daysLeft !== null && daysLeft < 0;
  return { text: str, tone, tag, body, until, isTemp, daysLeft, expired };
}

/** 判断单条区域/世界词条是否已到期失效。 */
export function isAftermathEntryExpired(raw, currentDay) {
  return parseAftermathEntry(raw, currentDay).expired;
}

/** 读取当前任务情报板状态。 */
export function questBoardState(stat, current = {}) {
  const board = boardNode(stat);
  const region = resolveRegion(stat, current.geoData || null);
  const nullCore = Boolean(current.nullCore);
  const currentDay = worldDay(stat);
  const lastRescanDay = normalizeDay(board['上次重扫日']);
  const rescanCooldownToday = Boolean(nullCore && currentDay && lastRescanDay && lastRescanDay === currentDay);
  const boardRegionKey = text(board['区域键'] || board['区域']).trim();
  const boardRegionName = text(board['区域'] || board['区域名']).trim();
  const intents = Array.isArray(board['意向'])
    ? board['意向'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  const intentSet = new Set(intents);
  const ignored = Array.isArray(board['忽略'])
    ? board['忽略'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  const everAcceptedList = Array.isArray(board['曾接取'])
    ? board['曾接取'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  const everAcceptedSet = new Set(everAcceptedList);
  const everAcceptedNormSet = new Set(everAcceptedList.map(stripTaskTitle).filter(Boolean));
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  const claimedMap = obj(board['已兑现']);
  const lostMap = obj(board['已失效']);

  const formalList = Object.entries(obj(obj(stat)['任务列表']))
    .map(([k, v]) => {
      const f = obj(v);
      return {
        key: text(k).trim(),
        status: text(f['状态']).trim(),
        progress: text(f['进展']).trim(),
        detail: text(f['详情'] || f['描述'] || f['说明']).trim(),
        goal: text(f['目标'] || f['当前目标']).trim(),
        reward: f['奖励'] ?? f['报酬'] ?? f['预期收益'] ?? '',
      };
    })
    .filter((t) => !!t.key);

  const rawList = Array.isArray(board['列表'])
    ? board['列表'].map((entry, idx) => ({ entry, rawKey: '', idx }))
    : Object.entries(obj(board['列表'])).map(([k, v], idx) => ({ entry: v, rawKey: text(k).trim(), idx }));

  const regionChanged = !sameRegion(region, boardRegionKey, boardRegionName, current.geoData || null);

  // 读取当前区域词条与世界词条（仅命中当前区域，不跨区混入；常驻与限时分开计额且自动跳过已过期限时词条）
  const maxAftermath = DATA.questBoard.maxAftermathPerScope || 3;
  const maxTempAftermath = DATA.questBoard.maxTempAftermathPerScope || 2;
  const aftermathRoot = obj(board['余波']);
  const collectAftermathEntries = (scopeKey, raw) => {
    const out = [];
    if (Array.isArray(raw)) {
      for (let idx = 0; idx < raw.length; idx += 1) {
        const parsed = parseAftermathEntry(raw[idx], currentDay);
        if (parsed.text && !parsed.expired) out.push({ key: scopeKey, index: idx, ...parsed });
      }
      return out;
    }
    const parsed = parseAftermathEntry(raw, currentDay);
    if (parsed.text && !parsed.expired) out.push({ key: scopeKey, index: 0, ...parsed });
    return out;
  };
  const capAftermathEntries = (entries) => {
    const permIndices = [];
    const tempIndices = [];
    entries.forEach((entry, idx) => {
      if (entry.isTemp) tempIndices.push(idx);
      else permIndices.push(idx);
    });
    const keepIdx = new Set([
      ...permIndices.slice(-maxAftermath),
      ...tempIndices.slice(-maxTempAftermath),
    ]);
    return entries.filter((_, idx) => keepIdx.has(idx));
  };
  const localRawEntries = [];
  if (region.key || region.name) {
    for (const [k, v] of Object.entries(aftermathRoot)) {
      const kk = text(k).trim();
      if (!kk || kk === '世界') continue;
      if (sameRegion(region, kk, kk, current.geoData || null)) {
        for (const entry of collectAftermathEntries(k, v)) localRawEntries.push(entry);
      }
    }
  }
  const localEntries = capAftermathEntries(localRawEntries);
  const worldEntries = capAftermathEntries(collectAftermathEntries('世界', aftermathRoot['世界']));
  const aftermath = {
    local: localEntries.map((e) => e.text),
    world: worldEntries.map((e) => e.text),
    localEntries,
    worldEntries,
  };

  const matchedFormalKeys = new Set();

  const boardItems = rawList
    .map(({ entry, rawKey, idx }) => {
      const r = obj(entry);
      const title = text(r['标题']).trim();
      if (!title) return null;
      const formal = matchFormalTask(formalList, title);
      if (formal) matchedFormalKeys.add(formal.key);
      if (formal && CLOSED_TASK_RE.test(formal.status)) return null;
      const accepted = !!formal;
      const id = rawKey || text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
      const category = normalizeQuestCategory(r['类别']);
      const rankRaw = text(r['等级']).trim().toUpperCase().match(/[SABCD]/);
      const rank = rankRaw ? rankRaw[0] : 'C';
      const wayInfo = normalizeQuestWay(r['方式']);
      const location = text(r['地点'] || boardRegionName || region.name).trim();
      const guide = text(r['引导'] || r['切入'] || r['接取方式']).trim();
      const deadline = text(r['时限']).trim();
      const summary = text(r['摘要']).trim();
      const boardProgress = text(r['进展'] || r['动态'] || r['最新进展']).trim();
      const progress = accepted ? (formal.progress || boardProgress) : boardProgress;
      const itemUpdatedDay = normalizeDay(r['更新日']);
      const rawRewards = normalizeQuestRewards(r['预期收益']);
      const claimedInfo = parseClaimedSet(mergeRewardMapEntries(claimedMap, id, title));
      const lostInfo = parseLostSet(mergeRewardMapEntries(lostMap, id, title));
      const rewardItems = rawRewards.map((rawRw, rwIdx) => {
        const slot = rwIdx + 1;
        const cleanText = cleanRewardText(rawRw) || rawRw;
        const compact = cleanText.replace(/\s+/g, '');
        const claimed = CLAIMED_MARK_RE.test(rawRw)
          || claimedInfo.slots.has(slot)
          || claimedInfo.texts.has(compact);
        // 硬规则：已兑现优先于已失效（已拿到手的收益不倒扣）
        const lost = !claimed && (
          LOST_MARK_RE.test(rawRw)
          || lostInfo.slots.has(slot)
          || lostInfo.texts.has(compact)
        );
        return { slot, text: cleanText, claimed, lost };
      });
      const rewards = rewardItems.map((x) => x.text);
      const claimedCount = rewardItems.filter((x) => x.claimed).length;
      const lostCount = rewardItems.filter((x) => x.lost).length;
      const normTitle = stripTaskTitle(title);
      const everAccepted = everAcceptedSet.has(id)
        || everAcceptedSet.has(title)
        || (!!normTitle && everAcceptedNormSet.has(normTitle));
      // 三合一完结判定：不在正式任务列表，且曾有兑现 / 曾接取 / 历史楼层曾在正式任务列表出现 → 已完结隐藏
      if (!accepted && (claimedCount > 0 || everAccepted || wasInHistoryFormalTasks(historyStats, id, title))) {
        return null;
      }
      const cfg = DATA.questBoard.categories[category] || DATA.questBoard.categories['支线任务'];
      const intent = intentSet.has(id) || intentSet.has(title);
      const staleRegion = !accepted && !cfg.crossRegion && regionChanged;
      return {
        id,
        category,
        rank,
        title,
        way: wayInfo.way,
        wayKind: wayInfo.wayKind,
        guideLabel: wayInfo.guideLabel,
        guide,
        location,
        deadline,
        summary,
        progress,
        updatedDay: itemUpdatedDay,
        accepted,
        fromFormalOnly: false,
        formalTaskName: formal ? formal.key : '',
        formalStatus: formal ? (formal.status || '进行中') : '',
        rewards,
        rewardItems,
        claimedCount,
        lostCount,
        expectedSlots: cfg.rewardSlots,
        intent,
        staleRegion,
      };
    })
    .filter(Boolean);

  // 自动聚合未上墙的原版 /任务列表 进行中任务（只读展示）
  const formalOnlyItems = formalList
    .filter((f) => !matchedFormalKeys.has(f.key) && !CLOSED_TASK_RE.test(f.status))
    .map((f) => {
      const hintText = `${f.detail} ${f.key}`;
      const category = hintText.includes('剧情')
        ? '剧情任务'
        : (hintText.includes('主线') ? '本地主线' : '支线任务');
      const rankMatch = f.detail.match(/(?<![A-Za-z0-9])([SABCD])\s*级/i);
      const rank = rankMatch ? rankMatch[1].toUpperCase() : '原版';
      const rawRewards = normalizeQuestRewards(f.reward);
      const rewardItems = rawRewards.map((rawRw, rwIdx) => {
        const cleanText = cleanRewardText(rawRw) || rawRw;
        const claimed = CLAIMED_MARK_RE.test(rawRw);
        const lost = !claimed && LOST_MARK_RE.test(rawRw);
        return { slot: rwIdx + 1, text: cleanText, claimed, lost };
      });
      const rewards = rewardItems.map((x) => x.text);
      const claimedCount = rewardItems.filter((x) => x.claimed).length;
      const lostCount = rewardItems.filter((x) => x.lost).length;
      const cfg = DATA.questBoard.categories[category] || DATA.questBoard.categories['支线任务'];
      return {
        id: `formal:${f.key}`,
        category,
        rank,
        title: f.key,
        way: '剧情触发',
        wayKind: 'clue',
        guideLabel: '任务目标',
        guide: f.goal,
        location: '',
        deadline: '',
        summary: f.detail,
        progress: f.progress,
        updatedDay: '',
        accepted: true,
        fromFormalOnly: true,
        formalTaskName: f.key,
        formalStatus: f.status || '进行中',
        rewards,
        rewardItems,
        claimedCount,
        lostCount,
        expectedSlots: rewardItems.length || cfg.rewardSlots,
        intent: false,
        staleRegion: false,
      };
    });

  const items = [...boardItems, ...formalOnlyItems].sort((a, b) => {
    const ca = QUEST_CATEGORY_ORDER[a.category] ?? 9;
    const cb = QUEST_CATEGORY_ORDER[b.category] ?? 9;
    if (ca !== cb) return ca - cb;
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    if (a.intent !== b.intent) return a.intent ? -1 : 1;
    return 0;
  });

  const progressSignature = items
    .filter((x) => x.progress)
    .map((x) => `${x.id}|${x.accepted ? 'formal' : x.updatedDay}|${x.progress}`)
    .join(';;');

  const counts = {
    total: items.length,
    story: items.filter((x) => x.category === '剧情任务').length,
    local: items.filter((x) => x.category === '本地主线').length,
    side: items.filter((x) => x.category === '支线任务').length,
    accepted: items.filter((x) => x.accepted).length,
    editableAccepted: items.filter((x) => x.accepted && !x.fromFormalOnly).length,
    intent: items.filter((x) => x.intent && !x.accepted).length,
    progressed: items.filter((x) => x.progress).length,
  };

  return {
    regionKey: region.key,
    regionName: region.name,
    rawLocation: region.raw,
    boardRegionKey,
    boardRegionName,
    regionChanged,
    updatedDay: normalizeDay(board['更新日']),
    nullCore,
    lastRescanDay,
    rescanCooldownToday,
    rescanPending: rescanFresh(obj(board['待重扫']), current),
    rescanFp: DATA.questBoard.rescanFp,
    progressSignature,
    intents,
    ignored,
    aftermath,
    items,
    counts,
  };
}

/** 汇总任务助手面板所需全部状态。 */
export function readState(stat, current = {}) {
  return {
    version: DATA_VERSION,
    fp: fpOf(stat),
    day: worldDay(stat),
    questBoard: questBoardState(stat, current),
  };
}
