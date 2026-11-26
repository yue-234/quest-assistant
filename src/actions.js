// 独立任务助手的操作函数。在 stat_data 副本上修改，返回 { stat, done } 或 { error }。
// 所有变量写入独立路径 /事件/任务情报板，绝不触碰任何命定核心私有节点。

import { DATA } from './data.js';
import {
  BOARD_KEY, CORE_NAME, SPEAKER, fpOf, boardNode, rescanFresh,
  stripTaskTitle, matchFormalTask, extractHistoryStats, wasInHistoryFormalTasks,
} from './state.js';

export { CORE_NAME, SPEAKER };

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {});
const text = (v) => String(v ?? '');

/** 深拷贝 stat_data 并确保 /事件/任务情报板 存在。 */
function draft(stat) {
  const next = JSON.parse(JSON.stringify(stat || {}));
  if (!next['事件'] || typeof next['事件'] !== 'object' || Array.isArray(next['事件'])) {
    next['事件'] = {};
  }
  if (!next['事件'][BOARD_KEY] || typeof next['事件'][BOARD_KEY] !== 'object' || Array.isArray(next['事件'][BOARD_KEY])) {
    next['事件'][BOARD_KEY] = {};
  }
  return next;
}

function ensureBoard(next) {
  if (!next['事件'][BOARD_KEY] || typeof next['事件'][BOARD_KEY] !== 'object' || Array.isArray(next['事件'][BOARD_KEY])) {
    next['事件'][BOARD_KEY] = {};
  }
  return next['事件'][BOARD_KEY];
}

/** 切换某条任务情报的「锁定任务」状态（只会因时限到期自动清除，并透传预期收益给模型）。 */
export function toggleQuestIntent(stat, questId, questTitle = '') {
  const id = text(questId).trim();
  const title = text(questTitle).trim();
  if (!id && !title) return { error: '请先选择一条任务情报' };

  const next = draft(stat);
  const board = ensureBoard(next);
  const current = Array.isArray(board['意向'])
    ? board['意向'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  const has = current.includes(id) || (title && current.includes(title));
  if (has) {
    board['意向'] = current.filter((x) => x !== id && (!title || x !== title));
    return { stat: next, done: `已取消锁定「${title || id}」` };
  }
  board['意向'] = [...current, id || title];
  return { stat: next, done: `已锁定「${title || id}」，只会因时限到期自动清除` };
}

/** 划掉不感兴趣的任务情报，下一回合自动补入新任务。 */
export function ignoreQuest(stat, questId, questTitle = '') {
  const id = text(questId).trim();
  const title = text(questTitle).trim();
  if (!id && !title) return { error: '请先选择一条任务情报' };

  const next = draft(stat);
  const board = ensureBoard(next);
  let removedTitle = title;

  if (Array.isArray(board['列表'])) {
    board['列表'] = board['列表'].filter((item, idx) => {
      const r = obj(item);
      const itemId = text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
      const itemTitle = text(r['标题']).trim();
      const hit = (id && itemId === id) || (title && itemTitle === title);
      if (hit && itemTitle) removedTitle = itemTitle;
      return !hit;
    });
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      const r = obj(v);
      const itemTitle = text(r['标题']).trim();
      if ((id && k === id) || (title && itemTitle === title)) {
        if (itemTitle) removedTitle = itemTitle;
        delete board['列表'][k];
      }
    }
  }

  if (Array.isArray(board['意向'])) {
    board['意向'] = board['意向'].filter((x) => x !== id && (!removedTitle || x !== removedTitle));
  }
  if (board['已兑现'] && typeof board['已兑现'] === 'object') {
    if (id) delete board['已兑现'][id];
    if (removedTitle) delete board['已兑现'][removedTitle];
  }
  if (Array.isArray(board['曾接取'])) {
    const removedNorm = stripTaskTitle(removedTitle);
    const nextEver = board['曾接取'].filter((x) => {
      const s = text(x).trim();
      if (!s) return false;
      if (id && s === id) return false;
      if (removedTitle && s === removedTitle) return false;
      if (removedNorm && stripTaskTitle(s) === removedNorm) return false;
      return true;
    });
    if (nextEver.length) board['曾接取'] = nextEver;
    else delete board['曾接取'];
  }

  const ignored = Array.isArray(board['忽略'])
    ? board['忽略'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  if (removedTitle && !ignored.includes(removedTitle)) ignored.push(removedTitle);
  board['忽略'] = ignored.slice(-DATA.questBoard.maxIgnored);

  return { stat: next, done: `已忽略「${removedTitle || id}」，下一回合自动补入新情报` };
}

/** 切换某条任务情报第 slotNo 栏（1 起）预期收益的「已兑现 ✓」状态，供玩家手动补勾或取消。 */
export function toggleQuestRewardClaimed(stat, questId, slotNo, questTitle = '') {
  const id = text(questId).trim();
  const title = text(questTitle).trim();
  const slot = Math.floor(Number(slotNo));
  const key = id || title;
  if (!key || !Number.isFinite(slot) || slot < 1) {
    return { error: '请先选择有效的收益栏位' };
  }

  const next = draft(stat);
  const board = ensureBoard(next);
  if (!board['已兑现'] || typeof board['已兑现'] !== 'object' || Array.isArray(board['已兑现'])) {
    board['已兑现'] = {};
  }

  let targetEntry = null;
  if (Array.isArray(board['列表'])) {
    targetEntry = board['列表'].find((item, idx) => {
      const r = obj(item);
      const itemId = text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
      const itemTitle = text(r['标题']).trim();
      return (id && itemId === id) || (title && itemTitle === title);
    }) || null;
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      const r = obj(v);
      const itemTitle = text(r['标题']).trim();
      if ((id && k === id) || (title && itemTitle === title)) {
        targetEntry = v;
        break;
      }
    }
  }

  const cleanRw = (s) => text(s)
    .replace(/^\s*\[\s*\d+\s*[✓✔☑□☐]?\s*\]\s*/g, '')
    .replace(/\s*(?:[✓✔☑]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得)\s*[\]】）)])+\s*$/g, '')
    .replace(/^\s*(?:[✓✔☑]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得)\s*[\]】）)])+\s*/g, '')
    .trim();

  const rawList = targetEntry && Array.isArray(targetEntry['预期收益']) ? targetEntry['预期收益'] : null;
  const rawSlotText = rawList && rawList[slot - 1] !== undefined ? text(rawList[slot - 1]) : '';
  const cleanSlotText = cleanRw(rawSlotText).replace(/\s+/g, '');
  const hadInlineMark = /(?:[✓✔☑]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得)\s*[\]】）)])/.test(rawSlotText);

  const curRaw = board['已兑现'][key] ?? (title && board['已兑现'][title]) ?? [];
  const curArr = Array.isArray(curRaw) ? curRaw : [];
  const existsInMap = curArr.some((x) => {
    if (typeof x === 'number' && Math.floor(x) === slot) return true;
    const s = text(x).trim();
    if (/^\d+$/.test(s) && Number(s) === slot) return true;
    return cleanSlotText && cleanRw(s).replace(/\s+/g, '') === cleanSlotText;
  });

  const wasClaimed = existsInMap || hadInlineMark;
  if (wasClaimed) {
    const filtered = curArr.filter((x) => {
      if (typeof x === 'number' && Math.floor(x) === slot) return false;
      const s = text(x).trim();
      if (/^\d+$/.test(s) && Number(s) === slot) return false;
      if (cleanSlotText && cleanRw(s).replace(/\s+/g, '') === cleanSlotText) return false;
      return true;
    });
    if (filtered.length > 0) board['已兑现'][key] = filtered;
    else delete board['已兑现'][key];
    if (title && title !== key) delete board['已兑现'][title];
    if (hadInlineMark && rawList) rawList[slot - 1] = cleanRw(rawSlotText);
    return { stat: next, done: `已取消第 ${slot} 栏收益的兑现标记` };
  }

  const nextArr = [...curArr, slot];
  const nums = nextArr.filter((x) => typeof x === 'number' || /^\d+$/.test(text(x).trim())).map((x) => Math.floor(Number(x)));
  const others = nextArr.filter((x) => !(typeof x === 'number' || /^\d+$/.test(text(x).trim())));
  const uniqueNums = [...new Set(nums)].sort((a, b) => a - b);
  board['已兑现'][key] = [...uniqueNums, ...others];
  if (title && title !== key) delete board['已兑现'][title];
  return { stat: next, done: `已将第 ${slot} 栏收益标记为已兑现 ✓` };
}

/** 消耗 100 FP 预约下一回合重扫当前区域的本地任务情报（保留已锁定与跨区剧情任务）。 */
export function requestQuestRescan(stat, floor, chatCount) {
  const cost = DATA.questBoard.rescanFp;
  const boardNow = boardNode(stat);
  if (rescanFresh(obj(boardNow['待重扫']), { floor, chatCount })) {
    return { error: '本回合已经预约过地区重扫了，等下一回合刷新' };
  }
  if (fpOf(stat) < cost) {
    return { error: `命运点数不足：地区重扫需要 ${cost} FP，现有 ${fpOf(stat)} FP` };
  }
  const next = draft(stat);
  next['命运点数'] = String(fpOf(stat) - cost);
  const board = ensureBoard(next);
  board['待重扫'] = {
    楼层: floor === undefined || floor === null ? '' : String(floor),
    消息数: chatCount === undefined || chatCount === null ? '' : String(chatCount),
  };
  return { stat: next, done: `已扣除 ${cost} FP 启动地区情报重扫，下一回合刷新本地情报` };
}

/** 重扫请求是否已经过去（由界面或后台维护顺手清理）。 */
export function questRescanDone(stat, currentFloor, currentCount) {
  const pending = obj(boardNode(stat)['待重扫']);
  if (!Object.keys(pending).length) return false;
  return !rescanFresh(pending, { floor: currentFloor, chatCount: currentCount });
}

/** 清掉已消费的重扫请求标记。 */
export function clearQuestRescan(stat) {
  const next = draft(stat);
  const board = ensureBoard(next);
  delete board['待重扫'];
  return { stat: next, done: '地区重扫标记已清空' };
}

const CLOSED_TASK_RE = /(?:已完成|完成|已失败|失败|已结束|已取消|放弃)/;

function formalEntriesOf(stat) {
  return Object.entries(obj(obj(stat)['任务列表']))
    .map(([k, v]) => ({
      key: text(k).trim(),
      status: text(obj(v)['状态']).trim(),
    }))
    .filter((t) => !!t.key);
}

function boardEntriesOf(board) {
  if (Array.isArray(board['列表'])) {
    return board['列表'].map((entry, idx) => {
      const r = obj(entry);
      return {
        id: text(r['id'] || r['编号']).trim() || `q${idx + 1}`,
        title: text(r['标题']).trim(),
        raw: r,
      };
    });
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    return Object.entries(board['列表']).map(([k, v]) => {
      const r = obj(v);
      return {
        id: text(k).trim(),
        title: text(r['标题']).trim(),
        raw: { id: k, ...r },
      };
    });
  }
  return [];
}

function isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats) {
  const r = obj(entry);
  const title = text(r['标题']).trim();
  if (!title) return false;
  const id = text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
  const formal = matchFormalTask(formalEntriesOf(stat), title);
  if (formal) return CLOSED_TASK_RE.test(formal.status);

  // 已不在正式任务列表，满足任一条件即判定已完结：
  // 1) 在「曾接取」印记中；2) 历史楼层的正式任务列表中曾出现过；3) 已有任意已兑现记录
  const norm = stripTaskTitle(title);
  if (everSet.has(id) || everSet.has(title) || (norm && everNormSet.has(norm))) return true;
  if (wasInHistoryFormalTasks(historyStats, id, title)) return true;

  const claimedRaw = claimedMap[id] ?? claimedMap[title];
  const hasMapClaim = Array.isArray(claimedRaw)
    ? claimedRaw.length > 0
    : (typeof claimedRaw === 'string' && !!claimedRaw.trim());
  if (hasMapClaim) return true;
  const rawRewards = Array.isArray(r['预期收益']) ? r['预期收益'] : [];
  return rawRewards.some((rw) => /(?:[✓✔☑]|[\[【（(]\s*(?:已兑现|已发放|已领取|已获得)\s*[\]】）)])/.test(text(rw)));
}

function everSetsOf(board) {
  const list = Array.isArray(board['曾接取'])
    ? board['曾接取'].map((x) => text(x).trim()).filter(Boolean)
    : [];
  return {
    list,
    set: new Set(list),
    normSet: new Set(list.map(stripTaskTitle).filter(Boolean)),
  };
}

/** 当前是否存在命中正式「任务列表」（进行中）却尚未登记进「曾接取」的板上任务。 */
export function needsQuestAcceptedRecord(stat) {
  const board = boardNode(stat);
  const entries = boardEntriesOf(board);
  if (!entries.length) return false;
  const formalList = formalEntriesOf(stat);
  if (!formalList.length) return false;
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  return entries.some(({ title }) => {
    if (!title) return false;
    const formal = matchFormalTask(formalList, title);
    if (!formal || CLOSED_TASK_RE.test(formal.status)) return false;
    const norm = stripTaskTitle(title);
    return !everSet.has(title) && (!norm || !everNormSet.has(norm));
  });
}

/**
 * 将当前已进入正式「任务列表」（进行中）的板上任务标题登记到「曾接取」数组，
 * 并清理已不在任务板列表里的孤儿印记。
 */
export function recordAcceptedQuests(stat) {
  const next = draft(stat);
  const board = ensureBoard(next);
  const entries = boardEntriesOf(board);
  const formalList = formalEntriesOf(stat);
  const activeIdSet = new Set(entries.map((e) => e.id).filter(Boolean));
  const activeTitleSet = new Set(entries.map((e) => e.title).filter(Boolean));
  const activeNormSet = new Set(entries.map((e) => stripTaskTitle(e.title)).filter(Boolean));

  const kept = [];
  const seenNorm = new Set();
  const seenRaw = new Set();
  const addItem = (val) => {
    const s = text(val).trim();
    if (!s) return;
    const n = stripTaskTitle(s);
    if (seenRaw.has(s) || (n && seenNorm.has(n))) return;
    seenRaw.add(s);
    if (n) seenNorm.add(n);
    kept.push(s);
  };

  for (const raw of (Array.isArray(board['曾接取']) ? board['曾接取'] : [])) {
    const s = text(raw).trim();
    if (!s) continue;
    const n = stripTaskTitle(s);
    if (activeTitleSet.has(s) || activeIdSet.has(s) || (n && activeNormSet.has(n))) {
      addItem(s);
    }
  }
  for (const { title } of entries) {
    if (!title) continue;
    const formal = matchFormalTask(formalList, title);
    if (formal && !CLOSED_TASK_RE.test(formal.status)) addItem(title);
  }

  if (kept.length) board['曾接取'] = kept;
  else delete board['曾接取'];
  return { stat: next, done: '已登记进行中的任务印记' };
}

/** 任务板里是否存在已完结却尚未清理的残留条目。 */
export function hasClosedQuestLeftovers(stat, current = {}) {
  const board = boardNode(stat);
  const claimedMap = obj(board['已兑现']);
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  if (Array.isArray(board['列表'])) {
    return board['列表'].some((entry, idx) =>
      isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats),
    );
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    return Object.entries(board['列表']).some(([k, v], idx) =>
      isQuestEntryClosed(stat, { id: k, ...obj(v) }, idx, claimedMap, everSet, everNormSet, historyStats),
    );
  }
  return false;
}

/** 静默清理任务板里已完结的残留条目（含其意向、已兑现与曾接取键）。 */
export function sweepClosedQuests(stat, current = {}) {
  const next = draft(stat);
  const board = ensureBoard(next);
  const claimedMap = obj(board['已兑现']);
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  const removedIds = new Set();
  const removedTitles = new Set();
  const removedNorms = new Set();

  if (Array.isArray(board['列表'])) {
    board['列表'] = board['列表'].filter((entry, idx) => {
      const closed = isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats);
      if (closed) {
        const r = obj(entry);
        const id = text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
        const title = text(r['标题']).trim();
        if (id) removedIds.add(id);
        if (title) {
          removedTitles.add(title);
          const n = stripTaskTitle(title);
          if (n) removedNorms.add(n);
        }
      }
      return !closed;
    });
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      if (isQuestEntryClosed(stat, { id: k, ...obj(v) }, 0, claimedMap, everSet, everNormSet, historyStats)) {
        const title = text(obj(v)['标题']).trim();
        removedIds.add(k);
        if (title) {
          removedTitles.add(title);
          const n = stripTaskTitle(title);
          if (n) removedNorms.add(n);
        }
        delete board['列表'][k];
      }
    }
  }

  if (Array.isArray(board['意向'])) {
    board['意向'] = board['意向'].filter((x) => !removedIds.has(x) && !removedTitles.has(x));
  }
  if (board['已兑现'] && typeof board['已兑现'] === 'object') {
    for (const k of [...removedIds, ...removedTitles]) delete board['已兑现'][k];
  }
  if (Array.isArray(board['曾接取'])) {
    const remaining = boardEntriesOf(board);
    const remainIds = new Set(remaining.map((e) => e.id).filter(Boolean));
    const remainTitles = new Set(remaining.map((e) => e.title).filter(Boolean));
    const remainNorms = new Set(remaining.map((e) => stripTaskTitle(e.title)).filter(Boolean));
    const nextEver = board['曾接取'].filter((x) => {
      const s = text(x).trim();
      if (!s) return false;
      const n = stripTaskTitle(s);
      if (removedIds.has(s) || removedTitles.has(s) || (n && removedNorms.has(n))) return false;
      return remainIds.has(s) || remainTitles.has(s) || (n && remainNorms.has(n));
    });
    if (nextEver.length) board['曾接取'] = nextEver;
    else delete board['曾接取'];
  }
  return { stat: next, done: '已清理已完结的任务情报' };
}
