// 独立任务助手的操作函数。在 stat_data 副本上修改，返回 { stat, done } 或 { error }。
// 所有变量写入独立路径 /事件/任务情报板，绝不触碰任何命定核心私有节点。

import { DATA } from './data.js';
import {
  BOARD_KEY, CORE_NAME, SPEAKER, fpOf, boardNode, effectiveChatCount, rescanFresh, lastNonSystemIsAssistant,
  normalizeDay, worldDay, cleanRewardText, parseClaimedSet, parseLostSet,
  mergeRewardMapEntries, normalizeQuestRewards,
  CLAIMED_MARK_RE, LOST_MARK_RE,
  stripTaskTitle, matchFormalTask, extractHistoryStats, wasInHistoryFormalTasks,
  isAftermathEntryExpired,
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
  if (board['已失效'] && typeof board['已失效'] === 'object') {
    if (id) delete board['已失效'][id];
    if (removedTitle) delete board['已失效'][removedTitle];
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

function findBoardEntry(board, id, title) {
  if (Array.isArray(board['列表'])) {
    return board['列表'].find((item, idx) => {
      const r = obj(item);
      const itemId = text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
      const itemTitle = text(r['标题']).trim();
      return (id && itemId === id) || (title && itemTitle === title);
    }) || null;
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      const r = obj(v);
      const itemTitle = text(r['标题']).trim();
      if ((id && text(k).trim() === id) || (title && itemTitle === title)) return v;
    }
  }
  return null;
}

function normalizeRewardSlotList(arr) {
  const nums = [];
  const others = [];
  const seenOther = new Set();
  for (const x of arr) {
    if (typeof x === 'number' && Number.isFinite(x) && x >= 1) {
      nums.push(Math.floor(x));
      continue;
    }
    const s = text(x).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 1) nums.push(n);
      continue;
    }
    const compact = cleanRewardText(s).replace(/\s+/g, '');
    if (compact && seenOther.has(compact)) continue;
    if (compact) seenOther.add(compact);
    others.push(x);
  }
  const uniqueNums = [...new Set(nums)].sort((a, b) => a - b);
  return [...uniqueNums, ...others];
}

function removeSlotFromRewardMap(board, field, key, title, slot, cleanSlotText) {
  const map = board[field];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  const curArr = mergeRewardMapEntries(map, key, title);
  const filtered = curArr.filter((x) => {
    if (typeof x === 'number' && Math.floor(x) === slot) return false;
    const s = text(x).trim();
    if (/^\d+$/.test(s) && Number(s) === slot) return false;
    if (cleanSlotText && cleanRewardText(s).replace(/\s+/g, '') === cleanSlotText) return false;
    return true;
  });
  const normalized = normalizeRewardSlotList(filtered);
  if (normalized.length > 0) map[key] = normalized;
  else delete map[key];
  if (title && title !== key) delete map[title];
}

function addSlotToRewardMap(board, field, key, title, slot, cleanSlotText) {
  if (!board[field] || typeof board[field] !== 'object' || Array.isArray(board[field])) {
    board[field] = {};
  }
  const map = board[field];
  const curArr = mergeRewardMapEntries(map, key, title).filter((x) => {
    const s = text(x).trim();
    if (cleanSlotText && !/^\d+$/.test(s) && cleanRewardText(s).replace(/\s+/g, '') === cleanSlotText) {
      return false;
    }
    return true;
  });
  map[key] = normalizeRewardSlotList([...curArr, slot]);
  if (title && title !== key) delete map[title];
}

function stripInlineSlotMark(targetEntry, rawRewards, slot) {
  if (!targetEntry || !rawRewards.length) return;
  targetEntry['预期收益'] = rawRewards.map((rw, idx) => (idx === slot - 1 ? cleanRewardText(rw) : rw));
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

  const targetEntry = findBoardEntry(board, id, title);
  const rawRewards = targetEntry ? normalizeQuestRewards(targetEntry['预期收益']) : [];
  const rawSlotText = rawRewards[slot - 1] !== undefined ? text(rawRewards[slot - 1]) : '';
  const cleanSlotText = cleanRewardText(rawSlotText).replace(/\s+/g, '');
  const hadInlineMark = CLAIMED_MARK_RE.test(rawSlotText);
  const hadLostInline = LOST_MARK_RE.test(rawSlotText);

  const mergedClaimed = mergeRewardMapEntries(board['已兑现'], key, title);
  const claimedInfo = parseClaimedSet(mergedClaimed);
  const existsInMap = claimedInfo.slots.has(slot)
    || (!!cleanSlotText && claimedInfo.texts.has(cleanSlotText));

  const wasClaimed = existsInMap || hadInlineMark;
  if (wasClaimed) {
    removeSlotFromRewardMap(board, '已兑现', key, title, slot, cleanSlotText);
    if (hadInlineMark) stripInlineSlotMark(targetEntry, rawRewards, slot);
    return { stat: next, done: `已取消第 ${slot} 栏收益的兑现标记` };
  }

  removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText);
  if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
  addSlotToRewardMap(board, '已兑现', key, title, slot, cleanSlotText);
  return { stat: next, done: `已将第 ${slot} 栏收益标记为已兑现 ✓` };
}

/** 三态循环切换某条任务情报第 slotNo 栏（1 起）预期收益状态：待获得 (□) → 已兑现 (✓) → 已失效 (✕) → 待获得 (□)。 */
export function cycleQuestRewardState(stat, questId, slotNo, questTitle = '') {
  const id = text(questId).trim();
  const title = text(questTitle).trim();
  const slot = Math.floor(Number(slotNo));
  const key = id || title;
  if (!key || !Number.isFinite(slot) || slot < 1) {
    return { error: '请先选择有效的收益栏位' };
  }

  const next = draft(stat);
  const board = ensureBoard(next);
  const targetEntry = findBoardEntry(board, id, title);

  const rawRewards = targetEntry ? normalizeQuestRewards(targetEntry['预期收益']) : [];
  const rawSlotText = rawRewards[slot - 1] !== undefined ? text(rawRewards[slot - 1]) : '';
  const cleanSlotText = cleanRewardText(rawSlotText).replace(/\s+/g, '');
  const hadClaimedInline = CLAIMED_MARK_RE.test(rawSlotText);
  const hadLostInline = LOST_MARK_RE.test(rawSlotText);

  const claimedMap = board['已兑现'] && typeof board['已兑现'] === 'object' && !Array.isArray(board['已兑现'])
    ? board['已兑现']
    : {};
  const lostMap = board['已失效'] && typeof board['已失效'] === 'object' && !Array.isArray(board['已失效'])
    ? board['已失效']
    : {};

  const claimedInfo = parseClaimedSet(mergeRewardMapEntries(claimedMap, key, title));
  const lostInfo = parseLostSet(mergeRewardMapEntries(lostMap, key, title));
  const claimedInMap = claimedInfo.slots.has(slot)
    || (!!cleanSlotText && claimedInfo.texts.has(cleanSlotText));
  const lostInMap = lostInfo.slots.has(slot)
    || (!!cleanSlotText && lostInfo.texts.has(cleanSlotText));

  // 与解析保持一致：已兑现优先于已失效
  const isClaimed = claimedInMap || hadClaimedInline;
  const isLost = !isClaimed && (lostInMap || hadLostInline);

  if (isClaimed) {
    removeSlotFromRewardMap(board, '已兑现', key, title, slot, cleanSlotText);
    if (hadClaimedInline || hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
    addSlotToRewardMap(board, '已失效', key, title, slot, cleanSlotText);
    return { stat: next, done: `已将第 ${slot} 栏收益标记为已失效 ✕` };
  }

  if (isLost) {
    removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText);
    if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
    return { stat: next, done: `已将第 ${slot} 栏收益恢复为待获得状态` };
  }

  removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText);
  if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
  addSlotToRewardMap(board, '已兑现', key, title, slot, cleanSlotText);
  return { stat: next, done: `已将第 ${slot} 栏收益标记为已兑现 ✓` };
}

/** 删除 `/事件/任务情报板/余波/<scopeKey>` 中的指定词条，数组删空时移除空键，余波对象删空时移除余波字段。 */
export function deleteAftermathEntry(stat, scopeKey, index, expectedText = '') {
  const rawKey = text(scopeKey);
  const trimmedKey = rawKey.trim();
  const expected = text(expectedText).trim();
  const idx = Math.floor(Number(index));
  if (!trimmedKey) return { error: '未找到要删除的词条' };

  const next = draft(stat);
  const board = ensureBoard(next);
  const root = board['余波'];
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { error: '未找到要删除的词条' };
  }
  const key = Object.prototype.hasOwnProperty.call(root, rawKey)
    ? rawKey
    : Object.keys(root).find((k) => text(k).trim() === trimmedKey);
  if (key === undefined) {
    return { error: '未找到要删除的词条' };
  }

  const rawVal = root[key];
  if (Array.isArray(rawVal)) {
    let targetIdx = -1;
    if (Number.isFinite(idx) && idx >= 0 && idx < rawVal.length) {
      if (!expected || text(rawVal[idx]).trim() === expected) {
        targetIdx = idx;
      }
    }
    if (targetIdx === -1 && expected) {
      targetIdx = rawVal.findIndex((x) => text(x).trim() === expected);
    }
    if (targetIdx === -1) return { error: '未找到要删除的词条' };
    rawVal.splice(targetIdx, 1);
    if (rawVal.length === 0) {
      delete root[key];
    }
  } else if (typeof rawVal === 'string') {
    const cur = rawVal.trim();
    if (!cur || (expected && cur !== expected) || (Number.isFinite(idx) && idx !== 0)) {
      return { error: '未找到要删除的词条' };
    }
    delete root[key];
  } else {
    return { error: '未找到要删除的词条' };
  }

  if (Object.keys(root).length === 0) {
    delete board['余波'];
  }
  return { stat: next, done: '已删除词条' };
}

/** 全地图（含所有区域与「世界」）是否存在已过期的限时词条。 */
export function hasExpiredAftermath(stat) {
  const currentDay = worldDay(stat);
  if (!currentDay) return false;
  const board = boardNode(stat);
  const root = board['余波'];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  for (const val of Object.values(root)) {
    if (Array.isArray(val)) {
      if (val.some((item) => isAftermathEntryExpired(item, currentDay))) return true;
    } else if (typeof val === 'string') {
      if (isAftermathEntryExpired(val, currentDay)) return true;
    }
  }
  return false;
}

/** 遍历 `/事件/任务情报板/余波` 下全部键，静默移除所有已过期的限时词条并清理空键。 */
export function sweepExpiredAftermath(stat) {
  const currentDay = worldDay(stat);
  const next = draft(stat);
  const board = ensureBoard(next);
  const root = board['余波'];
  if (!currentDay || !root || typeof root !== 'object' || Array.isArray(root)) {
    return { stat: next, done: '已清理过期词条' };
  }
  for (const [k, val] of Object.entries(root)) {
    if (Array.isArray(val)) {
      const kept = val.filter((item) => !isAftermathEntryExpired(item, currentDay));
      if (kept.length > 0) root[k] = kept;
      else delete root[k];
    } else if (typeof val === 'string') {
      if (isAftermathEntryExpired(val, currentDay)) {
        delete root[k];
      }
    }
  }
  if (Object.keys(root).length === 0) {
    delete board['余波'];
  }
  return { stat: next, done: '已清理过期词条' };
}

/** 预约下一回合重扫当前区域的本地任务情报（保留已锁定与跨区剧情任务）。 */
export function requestQuestRescan(
  stat,
  floor,
  chatCount,
  { nullCore = false, chat, lastIsAssistant, extraAnalyzing } = {},
) {
  const effectiveCount = effectiveChatCount(chat, chatCount);
  const boardNow = boardNode(stat);
  if (rescanFresh(obj(boardNow['待重扫']), { floor, chatCount: effectiveCount, chat, lastIsAssistant, extraAnalyzing })) {
    return { error: '本回合已经预约过地区重扫了，等下一回合刷新' };
  }
  if (nullCore) {
    const curDay = worldDay(stat);
    const lastDay = normalizeDay(boardNow['上次重扫日']);
    if (curDay && lastDay && curDay === lastDay) {
      return { error: '今日已重扫过本地情报，请等次日再试' };
    }
    const next = draft(stat);
    const board = ensureBoard(next);
    if (curDay) board['上次重扫日'] = curDay;
    board['待重扫'] = {
      楼层: floor === undefined || floor === null ? '' : String(floor),
      消息数: effectiveCount === undefined || effectiveCount === null ? '' : String(effectiveCount),
    };
    return { stat: next, done: '已启动今日免费地区情报重扫，下一回合刷新本地情报' };
  }

  const cost = DATA.questBoard.rescanFp;
  if (fpOf(stat) < cost) {
    return { error: `命运点数不足：地区重扫需要 ${cost} FP，现有 ${fpOf(stat)} FP` };
  }
  const next = draft(stat);
  next['命运点数'] = fpOf(stat) - cost;
  const board = ensureBoard(next);
  board['待重扫'] = {
    楼层: floor === undefined || floor === null ? '' : String(floor),
    消息数: effectiveCount === undefined || effectiveCount === null ? '' : String(effectiveCount),
  };
  return { stat: next, done: `已扣除 ${cost} FP 启动地区情报重扫，下一回合刷新本地情报` };
}

/** 重扫请求是否已过完额外模型结算窗口，可由界面或后台维护安全清理。 */
export function questRescanDone(
  stat,
  currentFloor,
  currentCount,
  { extraFinished = false, extraAnalyzing = false, allowGrace = false, chat, lastIsAssistant } = {},
) {
  if (extraAnalyzing) return false;
  const pending = obj(boardNode(stat)['待重扫']);
  if (!Object.keys(pending).length) return false;
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const isAssistantTail = typeof lastIsAssistant === 'boolean'
    ? lastIsAssistant
    : lastNonSystemIsAssistant(chat);
  const settled = extraFinished || allowGrace;
  const atCount = num(pending['消息数']);
  const nowCount = num(effectiveChatCount(chat, currentCount));
  // 额外模型在主回复落楼后才排队执行，需等到变量更新结束事件、落楼宽限期满或进入下一轮后再清理
  if (atCount !== null && nowCount !== null) {
    if (nowCount > atCount + 2) return true;
    if (nowCount === atCount + 2) return settled;
    if (nowCount === atCount + 1 && isAssistantTail === true) return settled;
    return false;
  }
  const atFloor = num(pending['楼层']);
  const nowFloor = num(currentFloor);
  if (atFloor !== null && nowFloor !== null) {
    if (nowFloor > atFloor + 2) return true;
    if (nowFloor === atFloor + 2) return settled;
    if (nowFloor === atFloor + 1 && isAssistantTail === true) return settled;
    return false;
  }
  return atCount === null && atFloor === null;
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
        rawKey: '',
        title: text(r['标题']).trim(),
        raw: r,
      };
    });
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    return Object.entries(board['列表']).map(([k, v]) => {
      const r = obj(v);
      const rawKey = text(k).trim();
      return {
        id: rawKey,
        rawKey,
        title: text(r['标题']).trim(),
        raw: r,
      };
    });
  }
  return [];
}

function isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats, rawKey = '') {
  const r = obj(entry);
  const title = text(r['标题']).trim();
  if (!title) return false;
  const id = text(rawKey).trim() || text(r['id'] || r['编号']).trim() || `q${idx + 1}`;
  const formal = matchFormalTask(formalEntriesOf(stat), title);
  if (formal) return CLOSED_TASK_RE.test(formal.status);

  // 已不在正式任务列表，满足任一条件即判定已完结：
  // 1) 在「曾接取」印记中；2) 历史楼层的正式任务列表中曾出现过；3) 至少命中 1 个有效收益栏位的已兑现记录
  const norm = stripTaskTitle(title);
  if (everSet.has(id) || everSet.has(title) || (norm && everNormSet.has(norm))) return true;
  if (wasInHistoryFormalTasks(historyStats, id, title)) return true;

  const rawRewards = normalizeQuestRewards(r['预期收益']);
  const claimedInfo = parseClaimedSet(mergeRewardMapEntries(claimedMap, id, title));
  return rawRewards.some((rawRw, rwIdx) => {
    const slot = rwIdx + 1;
    const cleanText = cleanRewardText(rawRw) || rawRw;
    const compact = cleanText.replace(/\s+/g, '');
    return CLAIMED_MARK_RE.test(rawRw)
      || claimedInfo.slots.has(slot)
      || claimedInfo.texts.has(compact);
  });
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

function activeBoardRewardKeySet(board) {
  const keys = new Set();
  const remaining = boardEntriesOf(board);
  for (const e of remaining) {
    if (e.id) keys.add(e.id);
    if (e.title) keys.add(e.title);
  }
  if (board['列表'] && typeof board['列表'] === 'object' && !Array.isArray(board['列表'])) {
    for (const k of Object.keys(board['列表'])) {
      keys.add(k);
      const trimmed = text(k).trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return keys;
}

function hasOrphanRewardMapKeys(board) {
  if (!board['列表'] || typeof board['列表'] !== 'object') return false;
  const activeKeys = activeBoardRewardKeySet(board);
  for (const mapField of ['已兑现', '已失效']) {
    const map = board[mapField];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const k of Object.keys(map)) {
      const trimmed = text(k).trim();
      if (!activeKeys.has(k) && (!trimmed || !activeKeys.has(trimmed))) return true;
    }
  }
  return false;
}

/** 任务板里是否存在已完结却尚未清理的残留条目（含已脱离列表的已兑现/已失效孤儿键）。 */
export function hasClosedQuestLeftovers(stat, current = {}) {
  const board = boardNode(stat);
  const claimedMap = obj(board['已兑现']);
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  if (Array.isArray(board['列表'])) {
    if (board['列表'].some((entry, idx) =>
      isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats),
    )) return true;
    return hasOrphanRewardMapKeys(board);
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    if (Object.entries(board['列表']).some(([k, v], idx) =>
      isQuestEntryClosed(stat, v, idx, claimedMap, everSet, everNormSet, historyStats, k),
    )) return true;
    return hasOrphanRewardMapKeys(board);
  }
  return false;
}

/** 静默清理任务板里已完结的残留条目（含其意向、已兑现、已失效与曾接取键）。 */
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
      if (isQuestEntryClosed(stat, v, 0, claimedMap, everSet, everNormSet, historyStats, k)) {
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
  const activeRewardKeys = activeBoardRewardKeySet(board);
  for (const mapField of ['已兑现', '已失效']) {
    const map = board[mapField];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const k of [...removedIds, ...removedTitles]) delete map[k];
    if (board['列表'] && typeof board['列表'] === 'object') {
      for (const k of Object.keys(map)) {
        const trimmed = text(k).trim();
        if (!activeRewardKeys.has(k) && (!trimmed || !activeRewardKeys.has(trimmed))) {
          delete map[k];
        }
      }
    }
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

/** 合并后台维护：单次顺序执行清重扫 → 扫完结残留 → 登记曾接取 → 清全地图过期词条，无改动时返回 { skip: true }。 */
export function maintainQuestBoard(
  stat,
  { floor, chatCount, chat, historyStats, extraFinished = false, extraAnalyzing = false, allowGrace = false, lastIsAssistant } = {},
) {
  let cur = stat;
  let changed = false;
  if (questRescanDone(cur, floor, chatCount, { extraFinished, extraAnalyzing, allowGrace, chat, lastIsAssistant })) {
    cur = clearQuestRescan(cur).stat;
    changed = true;
  }
  const board = boardNode(cur);
  if (board['列表']) {
    if (hasClosedQuestLeftovers(cur, { chat, historyStats })) {
      cur = sweepClosedQuests(cur, { chat, historyStats }).stat;
      changed = true;
    }
    if (needsQuestAcceptedRecord(cur)) {
      cur = recordAcceptedQuests(cur).stat;
      changed = true;
    }
  }
  if (hasExpiredAftermath(cur)) {
    cur = sweepExpiredAftermath(cur).stat;
    changed = true;
  }
  if (!changed) return { skip: true };
  return { stat: cur, done: '已完成任务情报板后台维护' };
}
