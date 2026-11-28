// 独立任务助手的操作函数。在 stat_data 副本上修改，返回 { stat, done } 或 { error }。
// 所有变量写入独立路径 /事件/任务情报板，绝不触碰任何命定核心私有节点。

import { DATA } from './data.js';
import {
  BOARD_KEY, CORE_NAME, SPEAKER, fpOf, boardNode, effectiveChatCount, rescanFresh, lastNonSystemIsAssistant,
  normalizeDay, worldDay, addWorldDays, resolveRegion, resolveRegionText, normalizeQuestCategory,
  normalizeQuestFocus, isOnceFocusExpired, stripQuestBackendTags, CLOSED_TASK_RE,
  cleanRewardText, parseClaimedSet, parseLostSet,
  mergeRewardMapEntries, normalizeQuestRewards,
  CLAIMED_MARK_RE, LOST_MARK_RE,
  stripTaskTitle, matchFormalTask, extractHistoryStats, wasInHistoryFormalTasks,
  isAftermathEntryExpired,
} from './state.js';

export { CORE_NAME, SPEAKER };

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {});
const text = (v) => String(v ?? '');
const safeStr = (v) => (typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

function setOwnProp(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

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
    ? board['意向'].map((x) => safeStr(x).trim()).filter(Boolean)
    : [];
  const meta = findBoardEntryMeta(board, id, title);
  const shownTitle = stripQuestBackendTags(title) || title || id;
  const aliasSet = new Set([id, title, ...(meta ? meta.extraAliases : [])].map((x) => text(x).trim()).filter(Boolean));
  const has = current.some((x) => aliasSet.has(x) || aliasSet.has(text(x).trim()));
  if (has) {
    board['意向'] = current.filter((x) => !aliasSet.has(x) && !aliasSet.has(text(x).trim()));
    return { stat: next, done: `已取消锁定「${shownTitle}」` };
  }
  board['意向'] = [...current, id || title];
  return { stat: next, done: `已锁定「${shownTitle}」，只会因时限到期自动清除` };
}

/** 划掉不感兴趣的任务情报，下一回合自动补入新任务。 */
export function ignoreQuest(stat, questId, questTitle = '') {
  const id = text(questId).trim();
  const title = text(questTitle).trim();
  if (!id && !title) return { error: '请先选择一条任务情报' };

  const next = draft(stat);
  const board = ensureBoard(next);
  let removedTitle = title;
  const removedKeys = new Set();
  if (id) removedKeys.add(id);

  const addKeyAlias = (val) => {
    const raw = safeStr(val);
    const trimmed = raw.trim();
    if (raw) removedKeys.add(raw);
    if (trimmed) removedKeys.add(trimmed);
  };
  if (Array.isArray(board['列表'])) {
    board['列表'] = board['列表'].filter((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
      const r = item;
      const rawId = safeStr(r['id'] || r['编号']).trim();
      const itemId = rawId || `q${idx + 1}`;
      const itemTitle = safeStr(r['标题']).trim();
      const idHit = !!id && (rawId
        ? (rawId === id || safeStr(r['id']).trim() === id || safeStr(r['编号']).trim() === id)
        : (itemId === id && (!title || !itemTitle || itemTitle === title)));
      const hit = idHit || (!!title && itemTitle === title);
      if (hit) {
        if (itemTitle) removedTitle = itemTitle;
        addKeyAlias(itemId);
        addKeyAlias(r['id']);
        addKeyAlias(r['编号']);
        addKeyAlias(itemTitle);
        addKeyAlias(stripQuestBackendTags(itemTitle));
      }
      return !hit;
    });
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const r = v;
      const itemTitle = safeStr(r['标题']).trim();
      const rawIdField = safeStr(r['id']).trim();
      const rawNumField = safeStr(r['编号']).trim();
      const innerId = rawIdField || rawNumField;
      if (
        (id && (k === id || text(k).trim() === id || innerId === id || rawIdField === id || rawNumField === id))
        || (title && itemTitle === title)
      ) {
        if (itemTitle) removedTitle = itemTitle;
        addKeyAlias(k);
        addKeyAlias(r['id']);
        addKeyAlias(r['编号']);
        addKeyAlias(itemTitle);
        addKeyAlias(stripQuestBackendTags(itemTitle));
        delete board['列表'][k];
      }
    }
  }
  addKeyAlias(removedTitle);
  addKeyAlias(stripQuestBackendTags(removedTitle));

  if (Array.isArray(board['意向'])) {
    board['意向'] = board['意向'].filter((x) => {
      const sx = safeStr(x);
      const tx = sx.trim();
      return !!tx && !removedKeys.has(sx) && !removedKeys.has(tx);
    });
  }
  for (const mapField of ['已兑现', '已失效']) {
    const map = board[mapField];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const mk of Object.keys(map)) {
      if (removedKeys.has(mk) || (mk.trim() && removedKeys.has(mk.trim()))) {
        delete map[mk];
      }
    }
  }
  pruneRaceStageKeys(
    board,
    removedKeys,
    board['列表'] && typeof board['列表'] === 'object' ? activeBoardRewardKeySet(board) : null,
  );
  if (Array.isArray(board['曾接取'])) {
    const removedNorm = stripTaskTitle(removedTitle);
    const nextEver = board['曾接取'].filter((x) => {
      const s = safeStr(x).trim();
      if (!s) return false;
      if (removedKeys.has(s) || removedKeys.has(safeStr(x))) return false;
      if (removedNorm && stripTaskTitle(s) === removedNorm) return false;
      return true;
    });
    if (nextEver.length) board['曾接取'] = nextEver;
    else delete board['曾接取'];
  }

  const ignored = Array.isArray(board['忽略'])
    ? board['忽略'].map((x) => safeStr(x).trim()).filter(Boolean)
    : [];
  if (removedTitle && !ignored.includes(removedTitle)) ignored.push(removedTitle);
  board['忽略'] = ignored.slice(-DATA.questBoard.maxIgnored);

  const shownRemoved = stripQuestBackendTags(removedTitle) || removedTitle || id;
  return { stat: next, done: `已忽略「${shownRemoved}」，下一回合自动补入新情报` };
}

function findBoardEntryMeta(board, id, title) {
  if (Array.isArray(board['列表'])) {
    for (let idx = 0; idx < board['列表'].length; idx += 1) {
      const item = board['列表'][idx];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rawIdField = safeStr(item['id']).trim();
      const rawNumField = safeStr(item['编号']).trim();
      const rawId = rawIdField || rawNumField;
      const itemId = rawId || `q${idx + 1}`;
      const itemTitle = safeStr(item['标题']).trim();
      const idHit = !!id && (rawId
        ? (rawId === id || rawIdField === id || rawNumField === id)
        : (itemId === id && (!title || !itemTitle || itemTitle === title)));
      if (idHit || (title && itemTitle === title)) {
        return {
          entry: item,
          rawKey: '',
          extraAliases: [itemId, rawIdField, rawNumField, itemTitle, stripQuestBackendTags(itemTitle)].filter(Boolean),
        };
      }
    }
    return null;
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    for (const [k, v] of Object.entries(board['列表'])) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const itemTitle = safeStr(v['标题']).trim();
      const rawIdField = safeStr(v['id']).trim();
      const rawNumField = safeStr(v['编号']).trim();
      const innerId = rawIdField || rawNumField;
      if (
        (id && (k === id || text(k).trim() === id || innerId === id || rawIdField === id || rawNumField === id))
        || (title && itemTitle === title)
      ) {
        return {
          entry: v,
          rawKey: text(k),
          extraAliases: [text(k), rawIdField, rawNumField, itemTitle, stripQuestBackendTags(itemTitle)].filter(Boolean),
        };
      }
    }
  }
  return null;
}

function findBoardEntry(board, id, title) {
  const meta = findBoardEntryMeta(board, id, title);
  return meta ? meta.entry : null;
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

function pruneMapKeyAliases(map, key, title, extraAliases = []) {
  const aliasRaw = new Set();
  const aliasTrim = new Set();
  for (const a of [key, title, stripQuestBackendTags(title), ...(Array.isArray(extraAliases) ? extraAliases : [])]) {
    const s = text(a);
    const t = s.trim();
    if (s) aliasRaw.add(s);
    if (t) aliasTrim.add(t);
  }
  for (const mk of Object.keys(map)) {
    if (mk === key) continue;
    const trimmed = text(mk).trim();
    if (aliasRaw.has(mk) || (trimmed && aliasTrim.has(trimmed))) {
      delete map[mk];
    }
  }
}

function removeSlotFromRewardMap(board, field, key, title, slot, cleanSlotText, rawKey = '', extraAliases = []) {
  const map = board[field];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  const curArr = mergeRewardMapEntries(map, key, title, rawKey, extraAliases);
  const filtered = curArr.filter((x) => {
    if (typeof x === 'number' && Math.floor(x) === slot) return false;
    const s = text(x).trim();
    if (/^\d+$/.test(s) && Number(s) === slot) return false;
    if (cleanSlotText && cleanRewardText(s).replace(/\s+/g, '') === cleanSlotText) return false;
    return true;
  });
  const normalized = normalizeRewardSlotList(filtered);
  if (normalized.length > 0) setOwnProp(map, key, normalized);
  else delete map[key];
  pruneMapKeyAliases(map, key, title, [rawKey, ...extraAliases]);
}

function addSlotToRewardMap(board, field, key, title, slot, cleanSlotText, rawKey = '', extraAliases = []) {
  if (!board[field] || typeof board[field] !== 'object' || Array.isArray(board[field])) {
    board[field] = {};
  }
  const map = board[field];
  const curArr = mergeRewardMapEntries(map, key, title, rawKey, extraAliases).filter((x) => {
    const s = text(x).trim();
    if (cleanSlotText && !/^\d+$/.test(s) && cleanRewardText(s).replace(/\s+/g, '') === cleanSlotText) {
      return false;
    }
    return true;
  });
  setOwnProp(map, key, normalizeRewardSlotList([...curArr, slot]));
  pruneMapKeyAliases(map, key, title, [rawKey, ...extraAliases]);
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

  const targetMeta = findBoardEntryMeta(board, id, title);
  const targetEntry = targetMeta ? targetMeta.entry : null;
  const rawKey = targetMeta ? targetMeta.rawKey : '';
  const extraAliases = targetMeta ? targetMeta.extraAliases : [];
  const rawRewards = targetEntry ? normalizeQuestRewards(targetEntry['预期收益']) : [];
  const rawSlotText = rawRewards[slot - 1] !== undefined ? text(rawRewards[slot - 1]) : '';
  const cleanSlotText = cleanRewardText(rawSlotText).replace(/\s+/g, '');
  const hadInlineMark = CLAIMED_MARK_RE.test(rawSlotText);
  const hadLostInline = LOST_MARK_RE.test(rawSlotText);

  const mergedClaimed = mergeRewardMapEntries(board['已兑现'], key, title, rawKey, extraAliases);
  const claimedInfo = parseClaimedSet(mergedClaimed);
  const existsInMap = claimedInfo.slots.has(slot)
    || (!!cleanSlotText && claimedInfo.texts.has(cleanSlotText));

  const wasClaimed = existsInMap || hadInlineMark;
  if (wasClaimed) {
    removeSlotFromRewardMap(board, '已兑现', key, title, slot, cleanSlotText, rawKey, extraAliases);
    if (hadInlineMark) stripInlineSlotMark(targetEntry, rawRewards, slot);
    return { stat: next, done: `已取消第 ${slot} 栏收益的兑现标记` };
  }

  removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText, rawKey, extraAliases);
  if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
  addSlotToRewardMap(board, '已兑现', key, title, slot, cleanSlotText, rawKey, extraAliases);
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
  const targetMeta = findBoardEntryMeta(board, id, title);
  const targetEntry = targetMeta ? targetMeta.entry : null;
  const rawKey = targetMeta ? targetMeta.rawKey : '';
  const extraAliases = targetMeta ? targetMeta.extraAliases : [];

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

  const claimedInfo = parseClaimedSet(mergeRewardMapEntries(claimedMap, key, title, rawKey, extraAliases));
  const lostInfo = parseLostSet(mergeRewardMapEntries(lostMap, key, title, rawKey, extraAliases));
  const claimedInMap = claimedInfo.slots.has(slot)
    || (!!cleanSlotText && claimedInfo.texts.has(cleanSlotText));
  const lostInMap = lostInfo.slots.has(slot)
    || (!!cleanSlotText && lostInfo.texts.has(cleanSlotText));

  // 与解析保持一致：已兑现优先于已失效
  const isClaimed = claimedInMap || hadClaimedInline;
  const isLost = !isClaimed && (lostInMap || hadLostInline);

  if (isClaimed) {
    removeSlotFromRewardMap(board, '已兑现', key, title, slot, cleanSlotText, rawKey, extraAliases);
    if (hadClaimedInline || hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
    addSlotToRewardMap(board, '已失效', key, title, slot, cleanSlotText, rawKey, extraAliases);
    return { stat: next, done: `已将第 ${slot} 栏收益标记为已失效 ✕` };
  }

  if (isLost) {
    removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText, rawKey, extraAliases);
    if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
    return { stat: next, done: `已将第 ${slot} 栏收益恢复为待获得状态` };
  }

  removeSlotFromRewardMap(board, '已失效', key, title, slot, cleanSlotText, rawKey, extraAliases);
  if (hadLostInline) stripInlineSlotMark(targetEntry, rawRewards, slot);
  addSlotToRewardMap(board, '已兑现', key, title, slot, cleanSlotText, rawKey, extraAliases);
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

function writeFocusToBoard(board, rawText, mode, effCountStr, effFloorStr = '') {
  const reqMode = mode === 'once' ? 'once' : 'long';
  const norm = normalizeQuestFocus({ 文本: rawText, 模式: reqMode });
  if (!norm.text) {
    delete board['关注方向'];
    return null;
  }
  if (norm.mode === 'once') {
    board['关注方向'] = {
      文本: norm.text,
      模式: 'once',
      消息数: effCountStr,
    };
    if (!effCountStr && effFloorStr) {
      board['关注方向']['楼层'] = effFloorStr;
    }
  } else {
    board['关注方向'] = {
      文本: norm.text,
      模式: 'long',
    };
  }
  return norm;
}

/** 设定或清空任务情报板「关注方向」（软倾斜生成偏好）。 */
export function setQuestFocus(stat, rawText, { mode = 'long', chatCount, chat, floor } = {}) {
  const eff = effectiveChatCount(chat, chatCount);
  const effStr = eff !== undefined && eff !== null ? String(eff) : '';
  const effFloorStr = !effStr && floor !== undefined && floor !== null && floor !== '' ? String(floor) : '';
  const next = draft(stat);
  const board = ensureBoard(next);
  const written = writeFocusToBoard(board, rawText, mode, effStr, effFloorStr);
  if (!written) {
    return { stat: next, done: '已清空关注方向，恢复通用情报生成' };
  }
  const modeDesc = written.mode === 'once' ? '仅本次' : '长期';
  return { stat: next, done: `已设定${modeDesc}关注方向「${written.text}」` };
}

/** 当前是否存在已过期的「仅本次」关注方向。 */
export function hasExpiredOnceFocus(stat, current = {}) {
  return isOnceFocusExpired(boardNode(stat), current);
}

/** 清理已过期的「仅本次」关注方向（传 current 时按新鲜度校验；未传 current 时直接清理 once 项）。 */
export function clearExpiredOnceFocus(stat, current) {
  const next = draft(stat);
  const board = ensureBoard(next);
  const rawFocus = board['关注方向'];
  const focus = normalizeQuestFocus(rawFocus);
  const rawIsOnce = !!(rawFocus && typeof rawFocus === 'object' && !Array.isArray(rawFocus)
    && (rawFocus['模式'] === 'once' || rawFocus.mode === 'once'));
  if (focus.mode !== 'once' && !rawIsOnce) {
    return { stat: next, done: '无需清理关注方向' };
  }
  if (current !== undefined && focus.text && !isOnceFocusExpired(board, current)) {
    return { stat: next, done: '关注方向尚未过期' };
  }
  delete board['关注方向'];
  return { stat: next, done: '已清理过期的仅本次关注方向' };
}

function applyRescanFocus(board, effCountStr, effFloorStr, focusText, focusMode, current = {}) {
  if (focusText !== undefined) {
    writeFocusToBoard(board, focusText, focusMode || 'long', effCountStr, effFloorStr);
    return;
  }
  const existing = normalizeQuestFocus(board['关注方向']);
  if (existing.text && existing.mode === 'once') {
    if (isOnceFocusExpired(board, current)) {
      delete board['关注方向'];
    } else {
      const nextFocus = {
        文本: existing.text,
        模式: 'once',
        消息数: effCountStr,
      };
      if (!effCountStr && effFloorStr) {
        nextFocus['楼层'] = effFloorStr;
      }
      board['关注方向'] = nextFocus;
    }
  }
}

/** 预约下一回合重扫当前区域的本地任务情报（保留已锁定与跨区剧情任务）。 */
export function requestQuestRescan(
  stat,
  floor,
  chatCount,
  { nullCore = false, chat, lastIsAssistant, focusText, focusMode } = {},
) {
  const effectiveCount = effectiveChatCount(chat, chatCount);
  const effCountStr = effectiveCount !== undefined && effectiveCount !== null ? String(effectiveCount) : '';
  const effFloorStr = !effCountStr && floor !== undefined && floor !== null && floor !== '' ? String(floor) : '';
  const boardNow = boardNode(stat);
  if (rescanFresh(obj(boardNow['待重扫']), { floor, chatCount: effectiveCount, chat, lastIsAssistant })) {
    return { error: '本回合已经预约过地区重扫了，等下一回合刷新' };
  }
  const curDay = nullCore ? worldDay(stat) : '';
  if (nullCore) {
    const lastDay = normalizeDay(boardNow['上次重扫日']);
    if (curDay && lastDay && curDay === lastDay) {
      return { error: '今日已重扫过本地情报，请等次日再试' };
    }
  } else {
    const cost = DATA.questBoard.rescanFp;
    if (fpOf(stat) < cost) {
      return { error: `命运点数不足：地区重扫需要 ${cost} FP，现有 ${fpOf(stat)} FP` };
    }
  }

  const next = draft(stat);
  const board = ensureBoard(next);
  if (nullCore) {
    if (curDay) board['上次重扫日'] = curDay;
  } else {
    next['命运点数'] = fpOf(stat) - DATA.questBoard.rescanFp;
  }
  board['待重扫'] = {
    楼层: floor === undefined || floor === null ? '' : String(floor),
    消息数: effCountStr,
  };
  applyRescanFocus(board, effCountStr, effFloorStr, focusText, focusMode, {
    floor,
    chatCount: effectiveCount,
    chat,
    lastIsAssistant,
  });
  return {
    stat: next,
    done: nullCore
      ? '已启动今日免费地区情报重扫，下一回合刷新本地情报'
      : `已扣除 ${DATA.questBoard.rescanFp} FP 启动地区情报重扫，下一回合刷新本地情报`,
  };
}

/** 重扫请求是否已随主模型回复落地消费，可由界面或后台维护安全清理。 */
export function questRescanDone(
  stat,
  currentFloor,
  currentCount,
  { chat, lastIsAssistant } = {},
) {
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
  const atCount = num(pending['消息数']);
  const nowCount = num(effectiveChatCount(chat, currentCount));
  if (atCount !== null && nowCount !== null) {
    if (nowCount > atCount + 1) return true;
    if (nowCount === atCount + 1 && isAssistantTail === true) return true;
    return false;
  }
  const atFloor = num(pending['楼层']);
  const nowFloor = num(currentFloor);
  if (atFloor !== null && nowFloor !== null) {
    if (nowFloor > atFloor + 1) return true;
    if (nowFloor === atFloor + 1 && isAssistantTail === true) return true;
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

function formalEntriesOf(stat) {
  return Object.entries(obj(obj(stat)['任务列表']))
    .map(([k, v]) => {
      const f = obj(v);
      return {
        key: text(k).trim(),
        status: text(f['状态']).trim(),
        progress: text(f['进展']).trim(),
      };
    })
    .filter((t) => !!t.key);
}

function boardEntriesOf(board) {
  const out = [];
  if (Array.isArray(board['列表'])) {
    const arr = board['列表'];
    for (let idx = 0; idx < arr.length; idx += 1) {
      const entry = arr[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const r = obj(entry);
      const rawId = safeStr(r['id'] || r['编号']).trim();
      out.push({
        idx,
        id: rawId || `q${idx + 1}`,
        rawId,
        hasExplicitId: !!rawId,
        rawKey: '',
        title: safeStr(r['标题']).trim(),
        raw: r,
      });
    }
    return out;
  }
  if (board['列表'] && typeof board['列表'] === 'object') {
    let idx = 0;
    for (const [k, v] of Object.entries(board['列表'])) {
      const curIdx = idx;
      idx += 1;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const r = obj(v);
      const rawKey = text(k);
      const trimmedKey = rawKey.trim();
      const innerId = safeStr(r['id'] || r['编号']).trim();
      const rawId = trimmedKey || innerId;
      out.push({
        idx: curIdx,
        id: rawId || `q${curIdx + 1}`,
        rawId,
        hasExplicitId: !!rawId,
        rawKey,
        title: safeStr(r['标题']).trim(),
        raw: r,
      });
    }
  }
  return out;
}

function isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats, rawKey = '') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const r = obj(entry);
  const title = safeStr(r['标题']).trim();
  if (!title) return false;
  const rawIdField = safeStr(r['id']).trim();
  const rawNumField = safeStr(r['编号']).trim();
  const id = text(rawKey).trim() || rawIdField || rawNumField || `q${idx + 1}`;
  const formal = matchFormalTask(formalEntriesOf(stat), title);
  if (formal) return CLOSED_TASK_RE.test(formal.status);

  // 已不在正式任务列表，满足任一条件即判定已完结：
  // 1) 在「曾接取」印记中；2) 历史楼层的正式任务列表中曾出现过；3) 至少命中 1 个有效收益栏位的已兑现记录
  const norm = stripTaskTitle(title);
  if (
    everSet.has(id)
    || (!!rawIdField && everSet.has(rawIdField))
    || (!!rawNumField && everSet.has(rawNumField))
    || everSet.has(title)
    || (norm && everNormSet.has(norm))
  ) {
    return true;
  }
  if (wasInHistoryFormalTasks(historyStats, id, title)) return true;

  const rawRewards = normalizeQuestRewards(r['预期收益']);
  const extraKeys = [rawIdField, rawNumField, stripQuestBackendTags(title)];
  const claimedInfo = parseClaimedSet(mergeRewardMapEntries(claimedMap, id, title, rawKey, extraKeys));
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
    ? board['曾接取'].map((x) => safeStr(x).trim()).filter(Boolean)
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
  const addKey = (val) => {
    const raw = safeStr(val);
    const trimmed = raw.trim();
    if (raw) keys.add(raw);
    if (trimmed) keys.add(trimmed);
  };
  const remaining = boardEntriesOf(board);
  for (const e of remaining) {
    addKey(e.id);
    addKey(e.rawKey);
    addKey(e.raw['id']);
    addKey(e.raw['编号']);
    addKey(e.title);
    addKey(stripQuestBackendTags(e.title));
  }
  if (board['列表'] && typeof board['列表'] === 'object' && !Array.isArray(board['列表'])) {
    for (const k of Object.keys(board['列表'])) {
      addKey(k);
    }
  }
  return keys;
}

function pruneRaceStageKeys(board, removedKeys = null, activeKeys = null) {
  const stageMap = board['竞速暂存'];
  if (!stageMap || typeof stageMap !== 'object' || Array.isArray(stageMap)) return;
  for (const mk of Object.keys(stageMap)) {
    const trimmed = text(mk).trim();
    const hitRemoved = removedKeys && (removedKeys.has(mk) || (trimmed && removedKeys.has(trimmed)));
    const isOrphan = activeKeys && !activeKeys.has(mk) && (!trimmed || !activeKeys.has(trimmed));
    if (hitRemoved || isOrphan) {
      delete stageMap[mk];
    }
  }
  if (Object.keys(stageMap).length === 0) {
    delete board['竞速暂存'];
  }
}

function hasOrphanRewardMapKeys(board) {
  const entries = boardEntriesOf(board);
  const activeKeys = activeBoardRewardKeySet(board);
  const activeNorms = new Set(entries.map((e) => stripTaskTitle(e.title)).filter(Boolean));
  for (const mapField of ['已兑现', '已失效', '竞速暂存']) {
    const map = board[mapField];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const k of Object.keys(map)) {
      const trimmed = text(k).trim();
      if (!activeKeys.has(k) && (!trimmed || !activeKeys.has(trimmed))) return true;
    }
  }
  if (Array.isArray(board['意向'])) {
    for (let i = 0; i < board['意向'].length; i += 1) {
      const s = safeStr(board['意向'][i]).trim();
      if (s && !activeKeys.has(s)) return true;
    }
  }
  if (Array.isArray(board['曾接取'])) {
    for (let i = 0; i < board['曾接取'].length; i += 1) {
      const s = safeStr(board['曾接取'][i]).trim();
      if (!s) continue;
      const n = stripTaskTitle(s);
      if (!activeKeys.has(s) && (!n || !activeNorms.has(n))) return true;
    }
  }
  return false;
}

/** 任务板里是否存在已完结却尚未清理的残留条目（含已脱离列表的已兑现/已失效/意向/曾接取孤儿键）。 */
export function hasClosedQuestLeftovers(stat, current = {}) {
  const board = boardNode(stat);
  const claimedMap = obj(board['已兑现']);
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  if (Array.isArray(board['列表'])) {
    const arr = board['列表'];
    for (let idx = 0; idx < arr.length; idx += 1) {
      const entry = arr[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats)) return true;
    }
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    let idx = 0;
    for (const [k, v] of Object.entries(board['列表'])) {
      const curIdx = idx;
      idx += 1;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (isQuestEntryClosed(stat, v, curIdx, claimedMap, everSet, everNormSet, historyStats, k)) return true;
    }
  }
  return hasOrphanRewardMapKeys(board);
}

const FUSE_TRIM_EDGE_RE = /^[\s"'“”‘’【】\[\]()（）:：\-—·,，;；]+|[\s"'“”‘’【】\[\]()（）:：\-—·,，;；。！？!?]+$/g;

const FAILED_OR_CANCELED_RE = /(?:已失败|失败|已取消|取消|放弃)/;

function extractDirectorLead(entry, id, stat, board, currentCount, current = {}, failedOrCanceled = false) {
  const r = obj(entry);
  const rawTitle = text(r['标题']).trim();
  const title = stripQuestBackendTags(rawTitle) || rawTitle;
  if (!title) return null;
  const sources = [text(r['真相']), text(r['幕后真相'])].filter(Boolean);
  if (!sources.length) return null;

  let leadType = '';
  let afterMarker = '';
  if (!failedOrCanceled) {
    for (const src of sources) {
      const m = src.match(/余震引信\s*[：:]\s*([\s\S]*)/);
      if (m) {
        leadType = '假象余震';
        afterMarker = m[1];
        break;
      }
    }
  }
  if (!leadType) {
    for (const src of sources) {
      const m = src.match(/后续引信\s*[：:]\s*([\s\S]*)/);
      if (m) {
        leadType = '因果后续';
        afterMarker = m[1];
        break;
      }
    }
  }
  if (!leadType) return null;

  const sentence = text(afterMarker)
    .split(/[\r\n。！？!?|｜]+/)[0]
    .replace(/[\s\u3000]+/g, ' ')
    .replace(FUSE_TRIM_EDGE_RE, '')
    .trim();
  const fuse = sentence.slice(0, 60).replace(FUSE_TRIM_EDGE_RE, '').trim();
  if (!fuse) return null;

  const locRaw = text(r['地点']).trim();
  const boardRegion = text(board['区域'] || board['区域名']).trim();
  const geo = current.geoData || null;
  const matchesBoardRegion = !!(locRaw && boardRegion
    && (locRaw === boardRegion || locRaw.split(/[-－—>＞/／,，、;；·•・\n]+/).map((s) => s.trim()).includes(boardRegion)));
  const locName = locRaw
    ? (matchesBoardRegion ? boardRegion : (resolveRegionText(locRaw, geo).name || locRaw))
    : '';
  const area = locName || boardRegion || resolveRegion(stat, geo).name || '';
  const curDay = worldDay(stat);
  const triggerDay = curDay ? (addWorldDays(curDay, 1) || curDay) : '';

  // 按偶数 AI 尾 +3（至少隔过一个完整问答周期再到下次用户发言后的 plot 阶段）计算触发窗口
  const lead = {
    id: id || title,
    标题: title,
    类型: leadType,
    引信: fuse,
    区域: area,
    触发后消息数: currentCount !== null ? String(currentCount + 3) : '',
    触发日: triggerDay,
  };
  if (currentCount !== null) {
    lead['过期消息数'] = String(currentCount + 13);
  }
  return lead;
}

function isAftershockQuestEntry(entry, lead = null) {
  if (lead && lead['类型'] === '假象余震') return true;
  const r = obj(entry);
  if (r['余震'] === true || r['来自余震'] === true) return true;
  const tagText = [r['来源'], r['标签'], r['类型'], r['标题'], r['真相'], r['幕后真相']]
    .map((v) => text(v))
    .join(' ');
  if (/余震引信\s*[：:]/.test(tagText)) return true;
  if (/【\s*假象余震二段\s*】/.test(tagText)) return false;
  return /【\s*假象余震\s*】|余震衍生/.test(tagText);
}

function updateDirectorAfterSweep(board, stat, removedEntries, currentCount, current = {}) {
  if (!removedEntries.length) return;
  const rawDirector = board['导演状态'];
  const hadDirector = !!(rawDirector && typeof rawDirector === 'object' && !Array.isArray(rawDirector));
  const director = hadDirector ? obj(rawDirector) : {};
  let cooldown = Math.max(0, Math.floor(Number(director['余震冷却']) || 0));
  const queue = Array.isArray(director['待引爆'])
    ? director['待引爆'].filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => ({ ...x }))
    : [];
  let touched = false;
  const staged = [];

  for (const { entry, id, failedOrCanceled } of removedEntries) {
    const lead = extractDirectorLead(entry, id, stat, board, currentCount, current, failedOrCanceled);
    const cat = normalizeQuestCategory(obj(entry)['类别']);
    const isAs = isAftershockQuestEntry(entry, lead);
    if ((cat === '剧情任务' || cat === '本地主线') && !isAs && cooldown > 0) {
      cooldown -= 1;
      touched = true;
    }
    if (lead) staged.push(lead);
  }

  for (const lead of staged) {
    const dup = queue.some((q) => text(q['标题']).trim() === lead['标题']);
    const aftershockCount = queue.filter((q) => q['类型'] === '假象余震').length;
    if (!dup && queue.length < 2 && (lead['类型'] !== '假象余震' || aftershockCount < 1)) {
      queue.push(lead);
      if (lead['类型'] === '假象余震' && cooldown < 3) {
        cooldown = 3;
      }
      touched = true;
    }
  }

  if (!hadDirector && !touched) return;
  if (queue.length > 0) {
    director['待引爆'] = queue;
    director['余震冷却'] = cooldown;
    board['导演状态'] = director;
    return;
  }
  delete director['待引爆'];
  if (cooldown > 0) {
    director['余震冷却'] = cooldown;
    board['导演状态'] = director;
    return;
  }
  delete board['导演状态'];
}

function isDirectorLeadExpired(lead, curCount) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead) || curCount === null) return false;
  const rawExp = text(lead['过期消息数']).trim();
  if (!rawExp) return false;
  const expNum = Number(rawExp);
  return Number.isFinite(expNum) && curCount > expNum;
}

function isValidDirectorLead(lead) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return false;
  return !!text(lead['引信'] || lead['内容'] || lead['矛盾'] || lead['异常']).trim();
}

/** 导演状态队列里是否存在已超过过期消息数窗口或空壳/畸形待清理的节点。 */
export function hasExpiredDirectorLeads(stat, current = {}) {
  const board = boardNode(stat);
  if (!Object.prototype.hasOwnProperty.call(board, '导演状态')) return false;
  const director = board['导演状态'];
  if (!director || typeof director !== 'object' || Array.isArray(director)) return true;
  const cooldown = Math.max(0, Math.floor(Number(director['余震冷却']) || 0));
  const hasPendingKey = Object.prototype.hasOwnProperty.call(director, '待引爆');
  if (hasPendingKey && !Array.isArray(director['待引爆'])) return true;
  const queue = Array.isArray(director['待引爆']) ? director['待引爆'] : [];
  if (hasPendingKey && queue.length === 0) return true;
  if (queue.some((lead) => !isValidDirectorLead(lead))) return true;
  if (queue.length === 0 && cooldown <= 0) return true;
  const eff = effectiveChatCount(current.chat, current.chatCount);
  const curCount = eff !== undefined && eff !== null ? eff : null;
  if (curCount === null) return false;
  return queue.some((lead) => isDirectorLeadExpired(lead, curCount));
}

/** 静默清理导演状态中已过期或畸形待引爆引信；队列清空且无冷却时移除导演状态节点。 */
export function sweepExpiredDirectorLeads(stat, current = {}) {
  const next = draft(stat);
  const board = ensureBoard(next);
  if (!Object.prototype.hasOwnProperty.call(board, '导演状态')) {
    return { stat: next, done: '无需清理导演状态' };
  }
  const director = board['导演状态'];
  if (!director || typeof director !== 'object' || Array.isArray(director)) {
    delete board['导演状态'];
    return { stat: next, done: '已清理畸形导演状态节点' };
  }
  const eff = effectiveChatCount(current.chat, current.chatCount);
  const curCount = eff !== undefined && eff !== null ? eff : null;
  const queue = Array.isArray(director['待引爆']) ? director['待引爆'] : [];
  const kept = queue.filter((lead) => isValidDirectorLead(lead) && (curCount === null || !isDirectorLeadExpired(lead, curCount)));
  const cooldown = Math.max(0, Math.floor(Number(director['余震冷却']) || 0));

  if (kept.length > 0) {
    director['待引爆'] = kept;
    return { stat: next, done: '已清理过期导演状态引信' };
  }
  delete director['待引爆'];
  if (cooldown > 0) {
    director['余震冷却'] = cooldown;
  } else {
    delete board['导演状态'];
  }
  return { stat: next, done: '已清理过期导演状态引信' };
}

const MAX_RECEIPTS = 10;
const ABANDONED_STATUS_RE = /(?:已放弃|放弃|已取消|取消)/;
const FAILED_STATUS_RE = /(?:已失败|失败)/;
const EXPLICIT_FAIL_REASON_RE = /(?:彻底失败|任务失败|失利)/;
const RECEIPT_REASON_TRIM_RE = /^[\s，,；;。、：:\-—|｜]+|[\s，,；;、：:\-—|｜]+$/g;

function extractLastProgressClause(rawText) {
  const s = text(rawText).trim();
  if (!s) return '';
  const parts = s
    .split(/[\r\n;；]+|(?=\[\s*\d{1,6}[^\]\r\n]{1,20}\])/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : s;
  const cleaned = last
    .replace(/^\[\s*[^\]\r\n]{1,24}\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(RECEIPT_REASON_TRIM_RE, '')
    .trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
}

function findRaceStageEntry(board, id, title, rawKey = '', entry = null) {
  const stageMap = board && typeof board === 'object' ? board['竞速暂存'] : null;
  if (!stageMap || typeof stageMap !== 'object' || Array.isArray(stageMap)) return null;
  const r = obj(entry);
  const cleanTitle = stripQuestBackendTags(title);
  const candidates = [id, rawKey, r['id'], r['编号'], title, cleanTitle];
  const tried = new Set();
  for (const cand of candidates) {
    for (const key of [text(cand), text(cand).trim()]) {
      if (!key || tried.has(key)) continue;
      tried.add(key);
      if (Object.prototype.hasOwnProperty.call(stageMap, key)) {
        const val = stageMap[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) return val;
      }
    }
  }
  return null;
}

const EXPLICIT_ID_SYM = Symbol('hasExplicitId');

function buildReceiptRecord({
  id,
  rawKey = '',
  hasExplicitId = true,
  entry,
  stat,
  board,
  prevBoard = null,
  formal = null,
  prevFormal = null,
}) {
  const r = obj(entry);
  const rawTitle = safeStr(r['标题']).trim();
  const cleanTitle = stripQuestBackendTags(rawTitle) || rawTitle;
  if (!cleanTitle) return null;
  const itemId = text(id).trim() || cleanTitle;
  const category = normalizeQuestCategory(r['类别']);
  const rankMatch = safeStr(r['等级']).trim().toUpperCase().match(/[SABCD]/);
  const rank = rankMatch ? rankMatch[0] : 'C';

  const curClaimed = obj(board['已兑现']);
  const curLost = obj(board['已失效']);
  const prevClaimed = prevBoard ? obj(prevBoard['已兑现']) : {};
  const prevLost = prevBoard ? obj(prevBoard['已失效']) : {};
  const extraKeys = [safeStr(r['id']).trim(), safeStr(r['编号']).trim(), cleanTitle];
  const claimedInfo = parseClaimedSet([
    ...mergeRewardMapEntries(prevClaimed, itemId, rawTitle, rawKey, extraKeys),
    ...mergeRewardMapEntries(curClaimed, itemId, rawTitle, rawKey, extraKeys),
  ]);
  const lostInfo = parseLostSet([
    ...mergeRewardMapEntries(prevLost, itemId, rawTitle, rawKey, extraKeys),
    ...mergeRewardMapEntries(curLost, itemId, rawTitle, rawKey, extraKeys),
  ]);
  const rawRewards = normalizeQuestRewards(r['预期收益']);
  const rewardsSummary = rawRewards.map((rawRw, rwIdx) => {
    const slot = rwIdx + 1;
    const cleanText = cleanRewardText(rawRw) || rawRw;
    const compact = cleanText.replace(/\s+/g, '');
    const claimed = CLAIMED_MARK_RE.test(rawRw)
      || claimedInfo.slots.has(slot)
      || claimedInfo.texts.has(compact);
    const lost = !claimed && (
      LOST_MARK_RE.test(rawRw)
      || lostInfo.slots.has(slot)
      || lostInfo.texts.has(compact)
    );
    return {
      栏号: slot,
      文本: cleanText,
      状态: claimed ? 'claimed' : (lost ? 'lost' : 'open'),
    };
  });

  const claimedCount = rewardsSummary.filter((x) => x['状态'] === 'claimed').length;
  const lostCount = rewardsSummary.filter((x) => x['状态'] === 'lost').length;
  const raceStage = findRaceStageEntry(board, itemId, rawTitle, rawKey, r)
    || (prevBoard ? findRaceStageEntry(prevBoard, itemId, rawTitle, rawKey, r) : null);

  const stageRumor = raceStage
    ? (Array.isArray(raceStage['待揭晓风声']) ? raceStage['待揭晓风声'][raceStage['待揭晓风声'].length - 1] : raceStage['待揭晓风声'])
    : '';
  const reason = extractLastProgressClause(formal?.progress)
    || extractLastProgressClause(prevFormal?.progress)
    || extractLastProgressClause(r['进展'] || r['动态'] || r['最新进展'])
    || extractLastProgressClause(stageRumor);

  const statusText = text(formal?.status || prevFormal?.status || '').trim();
  const explicitDone = /(?:已完成|完成)/.test(statusText) && !FAILED_OR_CANCELED_RE.test(statusText);
  let outcomeLabel = '已完成';
  if (ABANDONED_STATUS_RE.test(statusText)) {
    outcomeLabel = '已放弃';
  } else if (FAILED_STATUS_RE.test(statusText)) {
    outcomeLabel = '已失败';
  } else if (explicitDone) {
    outcomeLabel = lostCount > 0 ? '折损结案' : '已完成';
  } else if (raceStage && raceStage['待失败结案'] === true) {
    outcomeLabel = '已失败';
  } else if (claimedCount === 0 && lostCount > 0) {
    outcomeLabel = '已失败';
  } else if (claimedCount === 0 && EXPLICIT_FAIL_REASON_RE.test(reason)) {
    outcomeLabel = '已失败';
  } else if (lostCount > 0) {
    outcomeLabel = '折损结案';
  }

  const closedDay = worldDay(stat) || normalizeDay(board['更新日']) || '';
  const rec = {
    id: itemId,
    标题: cleanTitle,
    类别: category,
    等级: rank,
    终局: outcomeLabel,
    原因: reason,
    结案日: closedDay,
    收益结算: rewardsSummary,
    已阅: false,
  };
  Object.defineProperty(rec, EXPLICIT_ID_SYM, { value: Boolean(hasExplicitId), enumerable: false });
  return rec;
}

function receiptIdOf(item, idx) {
  const r = obj(item);
  return safeStr(r['id'] ?? r['编号'] ?? r.id ?? '').trim() || `rcpt${idx + 1}`;
}

function appendReceipts(board, records, { chat, chatCount } = {}) {
  if (!Array.isArray(records) || !records.length) return false;
  const eff = effectiveChatCount(chat, chatCount);
  const curCount = eff !== undefined && eff !== null && Number.isFinite(Number(eff)) ? Number(eff) : null;
  const countStr = curCount !== null ? String(curCount) : '0';

  const existing = [];
  if (Array.isArray(board['待阅回执'])) {
    for (let i = 0; i < board['待阅回执'].length; i += 1) {
      const x = board['待阅回执'][i];
      if (x && typeof x === 'object' && !Array.isArray(x)) existing.push({ ...x });
    }
  }
  const existingKeys = existing.map((r, idx) => ({
    id: receiptIdOf(r, idx),
    norm: stripTaskTitle(stripQuestBackendTags(safeStr(r['标题'] ?? r.title).trim())),
  }));
  let added = false;
  for (const rec of records) {
    if (!rec) continue;
    const rid = text(rec.id).trim();
    const rNorm = stripTaskTitle(rec['标题']);
    const recHasExplicit = rec[EXPLICIT_ID_SYM] !== undefined ? Boolean(rec[EXPLICIT_ID_SYM]) : true;
    const isDup = existingKeys.some((ex) => (
      (rNorm && ex.norm && ex.norm === rNorm)
      || (recHasExplicit && rid && ex.id === rid)
    ));
    if (isDup) continue;
    const cleanRec = { ...rec };
    delete cleanRec[EXPLICIT_ID_SYM];
    existing.push(cleanRec);
    existingKeys.push({ id: rid || `rcpt${existing.length}`, norm: rNorm });
    added = true;
  }
  if (!added) return false;

  const activeIndices = [];
  const unreadActiveIndices = [];
  const readActiveIndices = [];
  for (let i = 0; i < existing.length; i += 1) {
    const item = existing[i];
    if (item['已收起'] === true || item.dismissed === true) continue;
    activeIndices.push(i);
    if (item['已阅'] ?? item.read) readActiveIndices.push(i);
    else unreadActiveIndices.push(i);
  }
  if (activeIndices.length <= MAX_RECEIPTS) {
    board['待阅回执'] = existing;
    return true;
  }
  const keepVisible = new Set();
  for (const idx of unreadActiveIndices.slice(-MAX_RECEIPTS)) {
    keepVisible.add(idx);
  }
  const remainSlots = MAX_RECEIPTS - keepVisible.size;
  if (remainSlots > 0) {
    for (const idx of readActiveIndices.slice(-remainSlots)) {
      keepVisible.add(idx);
    }
  }
  board['待阅回执'] = existing.map((item, idx) => {
    if (item['已收起'] === true || item.dismissed === true) return item;
    if (keepVisible.has(idx)) return item;
    const existingCount = safeStr(item['已阅消息数'] ?? item.readMsgCount).trim();
    return {
      id: receiptIdOf(item, idx),
      标题: safeStr(item['标题'] ?? item.title).trim(),
      已收起: true,
      已阅: true,
      已阅消息数: existingCount || countStr || '0',
    };
  });
  return true;
}

function hasBoardObject(stat) {
  const ev = stat && typeof stat === 'object' ? stat['事件'] : null;
  return !!(
    ev && typeof ev === 'object' && !Array.isArray(ev)
    && Object.prototype.hasOwnProperty.call(ev, BOARD_KEY)
    && ev[BOARD_KEY] && typeof ev[BOARD_KEY] === 'object' && !Array.isArray(ev[BOARD_KEY])
  );
}

function statBoardSignature(stat) {
  return JSON.stringify([boardNode(stat), obj(obj(stat)['任务列表'])]);
}

function findImmediatePrevStat(stat, current = {}) {
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  if (!historyStats.length) return null;
  let curSig = null;
  for (const hs of historyStats) {
    if (!hs || typeof hs !== 'object') continue;
    if (hs === stat) continue;
    if (curSig === null) curSig = statBoardSignature(stat);
    if (statBoardSignature(hs) === curSig) continue;
    return hs;
  }
  return null;
}

function findAiRemovedClosedEntries(stat, current = {}) {
  if (!hasBoardObject(stat)) return [];
  const board = boardNode(stat);
  const prevStat = current.prevStat !== undefined
    ? current.prevStat
    : findImmediatePrevStat(stat, current);
  if (!prevStat) return [];
  const prevBoard = boardNode(prevStat);
  const prevEntries = boardEntriesOf(prevBoard);
  if (!prevEntries.length) return [];

  const curEntries = boardEntriesOf(board);
  const curExplicitIdSet = new Set();
  const curTitleSet = new Set();
  const curNormSet = new Set();
  for (const e of curEntries) {
    if (e.hasExplicitId) {
      if (e.id) curExplicitIdSet.add(e.id);
      if (e.rawKey) curExplicitIdSet.add(e.rawKey);
      if (e.rawKey && e.rawKey.trim()) curExplicitIdSet.add(e.rawKey.trim());
      if (e.rawId) curExplicitIdSet.add(e.rawId);
      const rId = safeStr(e.raw['id']).trim();
      const rNum = safeStr(e.raw['编号']).trim();
      if (rId) curExplicitIdSet.add(rId);
      if (rNum) curExplicitIdSet.add(rNum);
    }
    if (e.title) {
      curTitleSet.add(e.title);
      const n = stripTaskTitle(e.title);
      if (n) curNormSet.add(n);
    }
  }

  const ignoredList = Array.isArray(board['忽略'])
    ? board['忽略'].map((x) => safeStr(x).trim()).filter(Boolean)
    : [];
  const ignoredSet = new Set(ignoredList);
  const ignoredNormSet = new Set(ignoredList.map(stripTaskTitle).filter(Boolean));

  // 包含 已收起: true 的同楼层墓碑，防止手动收起后在同楼层被重新捕获
  const existingReceiptsInfo = [];
  if (Array.isArray(board['待阅回执'])) {
    for (let idx = 0; idx < board['待阅回执'].length; idx += 1) {
      const r = board['待阅回执'][idx];
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      existingReceiptsInfo.push({
        id: receiptIdOf(r, idx),
        norm: stripTaskTitle(stripQuestBackendTags(safeStr(r['标题'] ?? r.title).trim())),
      });
    }
  }

  const curFormalList = formalEntriesOf(stat);
  const prevFormalList = formalEntriesOf(prevStat);
  const { set: prevEverSet, normSet: prevEverNormSet } = everSetsOf(prevBoard);
  const prevClaimedMap = obj(prevBoard['已兑现']);
  const prevLostMap = obj(prevBoard['已失效']);
  const curClaimedMap = obj(board['已兑现']);
  const curLostMap = obj(board['已失效']);

  const matched = [];
  for (const e of prevEntries) {
    if (!e.title) continue;
    const norm = stripTaskTitle(e.title);
    const eRawIdField = safeStr(e.raw['id']).trim();
    const eRawNumField = safeStr(e.raw['编号']).trim();
    if (
      curTitleSet.has(e.title)
      || (norm && curNormSet.has(norm))
      || (e.hasExplicitId && (
        (e.id && curExplicitIdSet.has(e.id))
        || (e.rawKey && curExplicitIdSet.has(e.rawKey))
        || (e.rawId && curExplicitIdSet.has(e.rawId))
        || (eRawIdField && curExplicitIdSet.has(eRawIdField))
        || (eRawNumField && curExplicitIdSet.has(eRawNumField))
      ))
    ) {
      continue;
    }
    if (
      (e.hasExplicitId && e.id && ignoredSet.has(e.id))
      || ignoredSet.has(e.title)
      || (norm && ignoredNormSet.has(norm))
    ) {
      continue;
    }
    const alreadyCaptured = existingReceiptsInfo.some((r) => (
      (norm && r.norm && norm === r.norm)
      || (e.hasExplicitId && e.id && r.id === e.id)
    ));
    if (alreadyCaptured) {
      continue;
    }

    const curFormal = matchFormalTask(curFormalList, e.title);
    // 仍在当前正式任务列表且处于进行中：并非结案，不捕获
    if (curFormal && !CLOSED_TASK_RE.test(curFormal.status)) continue;

    const prevFormal = matchFormalTask(prevFormalList, e.title);
    const closedInCurFormal = !!(curFormal && CLOSED_TASK_RE.test(curFormal.status));
    const wasInPrevFormal = !!prevFormal;
    const wasEverAccepted = prevEverSet.has(e.id)
      || (!!eRawIdField && prevEverSet.has(eRawIdField))
      || (!!eRawNumField && prevEverSet.has(eRawNumField))
      || prevEverSet.has(e.title)
      || (!!e.rawKey && prevEverSet.has(e.rawKey))
      || (!!norm && prevEverNormSet.has(norm));
    const extraKeys = [eRawIdField, eRawNumField, stripQuestBackendTags(e.title)];
    const hasRewardHistory = mergeRewardMapEntries(prevClaimedMap, e.id, e.title, e.rawKey, extraKeys).length > 0
      || mergeRewardMapEntries(prevLostMap, e.id, e.title, e.rawKey, extraKeys).length > 0
      || mergeRewardMapEntries(curClaimedMap, e.id, e.title, e.rawKey, extraKeys).length > 0
      || mergeRewardMapEntries(curLostMap, e.id, e.title, e.rawKey, extraKeys).length > 0
      || normalizeQuestRewards(e.raw['预期收益']).some((rw) => CLAIMED_MARK_RE.test(rw) || LOST_MARK_RE.test(rw));

    if (!closedInCurFormal && !wasInPrevFormal && !wasEverAccepted && !hasRewardHistory) {
      continue;
    }
    matched.push({
      entry: e.raw,
      id: e.id,
      rawKey: e.rawKey,
      hasExplicitId: e.hasExplicitId,
      formal: curFormal,
      prevFormal,
      prevBoard,
    });
  }
  return matched;
}

/** 途径 B 检测：上一楼层板上已接取或结案的任务，本轮是否被 AI 直接从列表移除且尚未记入待阅回执。 */
export function hasAiRemovedClosedEntries(stat, { chat, historyStats, prevStat } = {}) {
  return findAiRemovedClosedEntries(stat, { chat, historyStats, prevStat }).length > 0;
}

/** 途径 B 捕获：对比紧邻上一楼层快照，为本轮被 AI 直接移出列表的结案任务补写待阅回执。 */
export function captureAiRemovedReceipts(stat, { chat, historyStats, chatCount, prevStat } = {}) {
  const candidates = findAiRemovedClosedEntries(stat, { chat, historyStats, chatCount, prevStat });
  if (!candidates.length) return { skip: true };
  const next = draft(stat);
  const board = ensureBoard(next);
  const records = candidates
    .map((c) => buildReceiptRecord({
      id: c.id,
      rawKey: c.rawKey,
      hasExplicitId: c.hasExplicitId,
      entry: c.entry,
      stat,
      board,
      prevBoard: c.prevBoard,
      formal: c.formal,
      prevFormal: c.prevFormal,
    }))
    .filter(Boolean);
  if (!appendReceipts(board, records, { chat, chatCount })) return { skip: true };
  return { stat: next, done: '已捕获结案任务回执' };
}

/** 将待阅回执中所有未阅项标记为已阅并记录当前有效消息数；无未阅项时返回 { skip: true }。 */
export function markReceiptsRead(stat, { chat, chatCount } = {}) {
  const curBoard = boardNode(stat);
  if (!Array.isArray(curBoard['待阅回执']) || !curBoard['待阅回执'].length) {
    return { skip: true };
  }
  const hasUnread = curBoard['待阅回执'].some(
    (r) => r && typeof r === 'object' && !Array.isArray(r) && !(r['已收起'] ?? r.dismissed) && !(r['已阅'] ?? r.read),
  );
  if (!hasUnread) return { skip: true };

  const next = draft(stat);
  const board = ensureBoard(next);
  const eff = effectiveChatCount(chat, chatCount);
  const countStr = eff !== undefined && eff !== null && Number.isFinite(Number(eff)) ? String(eff) : '';
  board['待阅回执'] = board['待阅回执'].map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    if ((item['已收起'] ?? item.dismissed) || (item['已阅'] ?? item.read)) return item;
    const updated = { ...item, 已阅: true };
    if (countStr) updated['已阅消息数'] = countStr;
    return updated;
  });
  return { stat: next, done: '已将结案回执标记为已阅' };
}

/** 手动收起单条或全部待阅回执：同楼层置 已收起 墓碑防止途径 B 重复捕获，下一轮 AI 回复由 sweepExpiredReceipts 物理移除。 */
export function dismissReceipt(stat, receiptId = '', { chat, chatCount } = {}) {
  const targetId = text(receiptId).trim();
  const next = draft(stat);
  const board = ensureBoard(next);
  if (!Array.isArray(board['待阅回执']) || !board['待阅回执'].length) {
    delete board['待阅回执'];
    return { stat: next, done: '已收起结案回执' };
  }
  const eff = effectiveChatCount(chat, chatCount);
  const curCount = eff !== undefined && eff !== null && Number.isFinite(Number(eff)) ? Number(eff) : null;
  const countStr = curCount !== null ? String(curCount) : '';

  board['待阅回执'] = board['待阅回执'].map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    if (item['已收起'] === true || item.dismissed === true) return item;
    const itemId = receiptIdOf(item, idx);
    if (targetId && itemId !== targetId) return item;
    const existingCount = safeStr(item['已阅消息数'] ?? item.readMsgCount).trim();
    return {
      ...item,
      已收起: true,
      已阅: true,
      已阅消息数: countStr || existingCount || '0',
    };
  });
  return { stat: next, done: targetId ? '已收起该条结案回执' : '已清空全部结案回执' };
}

function isReceiptExpired(receipt, curCount, isAssistantTail) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return true;
  const isDismissed = receipt['已收起'] === true || receipt.dismissed === true;
  const isRead = isDismissed || Boolean(receipt['已阅'] ?? receipt.read);
  if (!isRead) return false;
  if (curCount === null || !isAssistantTail) return false;
  const rawReadCount = receipt['已阅消息数'] ?? receipt.readMsgCount;
  if (rawReadCount === undefined || rawReadCount === null || rawReadCount === '') return false;
  const readCount = Number(rawReadCount);
  return Number.isFinite(readCount) && curCount > readCount;
}

/** 是否存在已阅或已收起且已推进至下一轮 AI 回复的待清理回执（或空壳/畸形待阅回执节点）。 */
export function hasExpiredReceipts(stat, { chat, chatCount, lastIsAssistant } = {}) {
  const board = boardNode(stat);
  if (!Object.prototype.hasOwnProperty.call(board, '待阅回执')) return false;
  const list = board['待阅回执'];
  if (!Array.isArray(list) || list.length === 0) return true;
  const eff = effectiveChatCount(chat, chatCount);
  const curCount = eff !== undefined && eff !== null && Number.isFinite(Number(eff)) ? Number(eff) : null;
  const isAssistantTail = typeof lastIsAssistant === 'boolean'
    ? lastIsAssistant
    : lastNonSystemIsAssistant(chat) === true;
  return list.some((r) => isReceiptExpired(r, curCount, isAssistantTail));
}

/** 静默清理已阅或已收起且已推进至下一轮 AI 回复的结案回执；清空时移除 待阅回执 键。 */
export function sweepExpiredReceipts(stat, { chat, chatCount, lastIsAssistant } = {}) {
  const next = draft(stat);
  const board = ensureBoard(next);
  if (!Object.prototype.hasOwnProperty.call(board, '待阅回执')) {
    return { stat: next, done: '无需清理结案回执' };
  }
  const list = board['待阅回执'];
  if (!Array.isArray(list) || list.length === 0) {
    delete board['待阅回执'];
    return { stat: next, done: '已清理空结案回执节点' };
  }
  const eff = effectiveChatCount(chat, chatCount);
  const curCount = eff !== undefined && eff !== null && Number.isFinite(Number(eff)) ? Number(eff) : null;
  const isAssistantTail = typeof lastIsAssistant === 'boolean'
    ? lastIsAssistant
    : lastNonSystemIsAssistant(chat) === true;
  const kept = list.filter((r) => !isReceiptExpired(r, curCount, isAssistantTail));
  if (kept.length) board['待阅回执'] = kept;
  else delete board['待阅回执'];
  return { stat: next, done: '已清理已阅结案回执' };
}

/** 静默清理任务板里已完结的残留条目（含其意向、已兑现、已失效、竞速暂存与曾接取键，并拍照留存待阅回执与提取隐藏导演引信）。 */
export function sweepClosedQuests(stat, current = {}) {
  const next = draft(stat);
  const board = ensureBoard(next);
  const claimedMap = obj(board['已兑现']);
  const { set: everSet, normSet: everNormSet } = everSetsOf(board);
  const historyStats = Array.isArray(current.historyStats)
    ? current.historyStats
    : extractHistoryStats(current.chat || current.messages);
  const eff = effectiveChatCount(current.chat, current.chatCount);
  const currentCount = eff !== undefined && eff !== null ? eff : null;
  const removedIds = new Set();
  const removedTitles = new Set();
  const removedNorms = new Set();
  const removedEntries = [];

  const formalList = formalEntriesOf(stat);
  const prevStat = current.prevStat !== undefined
    ? current.prevStat
    : findImmediatePrevStat(stat, { chat: current.chat || current.messages, historyStats });
  const prevBoard = prevStat ? boardNode(prevStat) : null;
  const prevFormalList = prevStat ? formalEntriesOf(prevStat) : [];
  const isEntryFailedOrCanceled = (entry) => {
    const title = safeStr(obj(entry)['标题']).trim();
    if (!title) return false;
    const formal = matchFormalTask(formalList, title);
    return !!(formal && FAILED_OR_CANCELED_RE.test(formal.status));
  };

  if (Array.isArray(board['列表'])) {
    board['列表'] = board['列表'].filter((entry, idx) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const closed = isQuestEntryClosed(stat, entry, idx, claimedMap, everSet, everNormSet, historyStats);
      if (closed) {
        const r = obj(entry);
        const rawIdField = safeStr(r['id']).trim();
        const rawNumField = safeStr(r['编号']).trim();
        const rawId = rawIdField || rawNumField;
        const id = rawId || `q${idx + 1}`;
        const title = safeStr(r['标题']).trim();
        if (id) removedIds.add(id);
        if (rawIdField) removedIds.add(rawIdField);
        if (rawNumField) removedIds.add(rawNumField);
        if (title) {
          removedTitles.add(title);
          const cleanT = stripQuestBackendTags(title);
          if (cleanT) removedTitles.add(cleanT);
          const n = stripTaskTitle(title);
          if (n) removedNorms.add(n);
        }
        removedEntries.push({
          entry,
          id,
          rawKey: '',
          hasExplicitId: !!rawId,
          formal: matchFormalTask(formalList, title),
          prevFormal: matchFormalTask(prevFormalList, title),
          failedOrCanceled: isEntryFailedOrCanceled(entry),
        });
      }
      return !closed;
    });
  } else if (board['列表'] && typeof board['列表'] === 'object') {
    let idx = 0;
    for (const [k, v] of Object.entries(board['列表'])) {
      const curIdx = idx;
      idx += 1;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (isQuestEntryClosed(stat, v, curIdx, claimedMap, everSet, everNormSet, historyStats, k)) {
        const r = obj(v);
        const trimmedK = text(k).trim();
        const rawIdField = safeStr(r['id']).trim();
        const rawNumField = safeStr(r['编号']).trim();
        const innerId = rawIdField || rawNumField;
        const itemId = trimmedK || innerId || `q${curIdx + 1}`;
        const title = safeStr(r['标题']).trim();
        if (k) removedIds.add(k);
        if (itemId) removedIds.add(itemId);
        if (rawIdField) removedIds.add(rawIdField);
        if (rawNumField) removedIds.add(rawNumField);
        if (title) {
          removedTitles.add(title);
          const cleanT = stripQuestBackendTags(title);
          if (cleanT) removedTitles.add(cleanT);
          const n = stripTaskTitle(title);
          if (n) removedNorms.add(n);
        }
        removedEntries.push({
          entry: v,
          id: itemId,
          rawKey: k,
          hasExplicitId: !!(trimmedK || innerId),
          formal: matchFormalTask(formalList, title),
          prevFormal: matchFormalTask(prevFormalList, title),
          failedOrCanceled: isEntryFailedOrCanceled(v),
        });
        delete board['列表'][k];
      }
    }
  }

  // 途径 A：在清除 已兑现/已失效/竞速暂存 键之前先为被清扫的完结条目拍照留存待阅回执
  if (removedEntries.length) {
    const receiptRecords = removedEntries
      .map((item) => buildReceiptRecord({
        id: item.id,
        rawKey: item.rawKey,
        hasExplicitId: item.hasExplicitId,
        entry: item.entry,
        stat,
        board,
        prevBoard,
        formal: item.formal,
        prevFormal: item.prevFormal,
      }))
      .filter(Boolean);
    appendReceipts(board, receiptRecords, { chat: current.chat || current.messages, chatCount: current.chatCount });
  }

  updateDirectorAfterSweep(board, stat, removedEntries, currentCount, current);

  const activeRewardKeys = activeBoardRewardKeySet(board);
  if (Array.isArray(board['意向'])) {
    const prevIntentLen = board['意向'].length;
    const nextIntent = board['意向'].filter((x) => {
      const sx = safeStr(x);
      const tx = sx.trim();
      if (!tx) return false;
      if (removedIds.has(sx) || removedIds.has(tx) || removedTitles.has(sx) || removedTitles.has(tx)) return false;
      return activeRewardKeys.has(sx) || activeRewardKeys.has(tx);
    });
    if (nextIntent.length) board['意向'] = nextIntent;
    else if (prevIntentLen > 0) delete board['意向'];
  }
  for (const mapField of ['已兑现', '已失效']) {
    const map = board[mapField];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const k of [...removedIds, ...removedTitles]) delete map[k];
    for (const k of Object.keys(map)) {
      const trimmed = text(k).trim();
      if (!activeRewardKeys.has(k) && (!trimmed || !activeRewardKeys.has(trimmed))) {
        delete map[k];
      }
    }
  }
  pruneRaceStageKeys(
    board,
    new Set([...removedIds, ...removedTitles]),
    activeRewardKeys,
  );
  if (Array.isArray(board['曾接取'])) {
    const remaining = boardEntriesOf(board);
    const remainIds = new Set(remaining.map((e) => e.id).filter(Boolean));
    const remainTitles = new Set(remaining.map((e) => e.title).filter(Boolean));
    const remainNorms = new Set(remaining.map((e) => stripTaskTitle(e.title)).filter(Boolean));
    const nextEver = board['曾接取'].filter((x) => {
      const s = safeStr(x).trim();
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

/** 统一检查是否存在待执行的后台维护项（供 runtime.js 与 panel.js 复用单一真源）。 */
export function hasPendingMaintenance(
  stat,
  { floor, chatCount, chat, historyStats, lastIsAssistant } = {},
) {
  if (questRescanDone(stat, floor, chatCount, { chat, lastIsAssistant })) return true;
  if (hasAiRemovedClosedEntries(stat, { chat, historyStats })) return true;
  if (hasClosedQuestLeftovers(stat, { chat, historyStats })) return true;
  const board = boardNode(stat);
  if (board['列表'] && needsQuestAcceptedRecord(stat)) return true;
  if (hasExpiredAftermath(stat)) return true;
  if (hasExpiredOnceFocus(stat, { floor, chatCount, chat, lastIsAssistant })) return true;
  if (hasExpiredDirectorLeads(stat, { chatCount, chat })) return true;
  if (hasExpiredReceipts(stat, { chat, chatCount, lastIsAssistant })) return true;
  return false;
}

/** 合并后台维护：按序执行清重扫 → 补捕 AI 直删结案回执 → 扫完结残留 → 登记曾接取 → 清过期词条 → 清过期关注方向 → 清过期导演引信 → 清已阅过期回执，无改动时返回 { skip: true }。 */
export function maintainQuestBoard(
  stat,
  { floor, chatCount, chat, historyStats, lastIsAssistant } = {},
) {
  const resolvedPrevStat = findImmediatePrevStat(stat, { chat, historyStats });
  let cur = stat;
  let changed = false;
  let rescanCleared = false;
  if (questRescanDone(cur, floor, chatCount, { chat, lastIsAssistant })) {
    cur = clearQuestRescan(cur).stat;
    changed = true;
    rescanCleared = true;
  }
  if (hasAiRemovedClosedEntries(cur, { chat, historyStats, prevStat: resolvedPrevStat })) {
    const capRes = captureAiRemovedReceipts(cur, { chat, historyStats, chatCount, prevStat: resolvedPrevStat });
    if (capRes && capRes.stat) {
      cur = capRes.stat;
      changed = true;
    }
  }
  if (hasClosedQuestLeftovers(cur, { chat, historyStats })) {
    cur = sweepClosedQuests(cur, { chat, historyStats, chatCount, prevStat: resolvedPrevStat }).stat;
    changed = true;
  }
  if (boardNode(cur)['列表'] && needsQuestAcceptedRecord(cur)) {
    cur = recordAcceptedQuests(cur).stat;
    changed = true;
  }
  if (hasExpiredAftermath(cur)) {
    cur = sweepExpiredAftermath(cur).stat;
    changed = true;
  }
  const focusOpts = { floor, chatCount, chat, lastIsAssistant, rescanCleared };
  if (hasExpiredOnceFocus(cur, focusOpts)) {
    cur = clearExpiredOnceFocus(cur, focusOpts).stat;
    changed = true;
  }
  if (hasExpiredDirectorLeads(cur, { chatCount, chat })) {
    cur = sweepExpiredDirectorLeads(cur, { chatCount, chat }).stat;
    changed = true;
  }
  if (hasExpiredReceipts(cur, { chat, chatCount, lastIsAssistant })) {
    cur = sweepExpiredReceipts(cur, { chat, chatCount, lastIsAssistant }).stat;
    changed = true;
  }
  if (!changed) return { skip: true };
  return { stat: cur, done: '已完成任务情报板后台维护' };
}
