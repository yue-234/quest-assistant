// 将 actions.js 的结果写回酒馆最新楼层的 MVU 变量并存档。
import { parentWindow, readChatId } from './host.js';

const QUEUE_KEY = '__questHelperCommitQueue';
const MVU_END_KEY = '__questHelperMvuEnd';
const MSG_RECV_KEY = '__questHelperMsgRecv';
const DEFAULT_MSG_RECV_GRACE_MS = 1800;

/** 记录宿主页最近一次 MVU 变量更新完成信号（供 runtime 与 panel 共享）。 */
export function recordMvuUpdateEnded(chatCount = null, chatId = '') {
  try {
    parentWindow[MVU_END_KEY] = {
      chatCount: typeof chatCount === 'number' && Number.isFinite(chatCount) ? chatCount : null,
      chatId: chatId ? String(chatId) : '',
      at: Date.now(),
    };
  } catch {
    /* 忽略宿主环境写入异常 */
  }
}

/** 清除宿主页上的 MVU 变量更新完成信号。 */
export function clearMvuUpdateEnded() {
  try {
    delete parentWindow[MVU_END_KEY];
  } catch {
    /* 忽略 */
  }
}

/** 记录宿主页最近一次消息落楼时间（供 runtime 与 panel 共享宽限期）。 */
export function recordMsgReceived(chatCount = null, chatId = '') {
  try {
    parentWindow[MSG_RECV_KEY] = {
      chatCount: typeof chatCount === 'number' && Number.isFinite(chatCount) ? chatCount : null,
      chatId: chatId ? String(chatId) : '',
      at: Date.now(),
    };
  } catch {
    /* 忽略宿主环境写入异常 */
  }
}

/** 清除宿主页上的消息落楼宽限信号。 */
export function clearMsgReceived() {
  try {
    delete parentWindow[MSG_RECV_KEY];
  } catch {
    /* 忽略 */
  }
}

/** 返回宿主页消息落楼后的剩余宽限毫秒数（0 表示不在宽限期内）。 */
export function msgRecvGraceRemainingMs({ chatCount = null, chatId = '', graceMs = DEFAULT_MSG_RECV_GRACE_MS } = {}) {
  try {
    const rec = parentWindow[MSG_RECV_KEY];
    if (!rec || typeof rec !== 'object' || !rec.at) return 0;
    const curId = chatId ? String(chatId) : '';
    if (curId && rec.chatId && rec.chatId !== curId) return 0;
    if (rec.chatCount !== null && typeof chatCount === 'number' && Number.isFinite(chatCount) && rec.chatCount !== chatCount) {
      return 0;
    }
    const elapsed = Date.now() - rec.at;
    return elapsed >= 0 && elapsed < graceMs ? graceMs - elapsed : 0;
  } catch {
    return 0;
  }
}

/** 当前是否仍处于消息落楼后的 MVU 额外模型启动宽限期内。 */
export function isMsgRecvWithinGrace(opts = {}) {
  return msgRecvGraceRemainingMs(opts) > 0;
}

/** 判断宿主页记录的 MVU 更新结束事件是否匹配当前聊天与消息数。 */
export function isMvuUpdateEndedFor({ chatCount = null, chatId = '' } = {}) {
  try {
    const rec = parentWindow[MVU_END_KEY];
    if (!rec || typeof rec !== 'object') return false;
    const curId = chatId ? String(chatId) : '';
    if (curId && rec.chatId && rec.chatId !== curId) return false;
    if (rec.chatCount !== null && typeof chatCount === 'number' && Number.isFinite(chatCount) && rec.chatCount !== chatCount) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 当前宿主是否正在运行 MVU 额外模型变量解析。 */
export function extraAnalysisActive() {
  try {
    return !!parentWindow.Mvu?.isDuringExtraAnalysis?.();
  } catch {
    return false;
  }
}

/** 回复或 MVU 额外模型解析正在进行时禁止写变量，避免并发踩踏与覆盖。 */
export function generating() {
  if (extraAnalysisActive()) return true;
  try {
    const stop = parentWindow.document.getElementById('mes_stop');
    return !!stop && parentWindow.getComputedStyle(stop).display !== 'none';
  } catch {
    return false;
  }
}

function latestSwipeId() {
  try {
    const ctx = parentWindow.SillyTavern?.getContext?.();
    const chat = ctx?.chat || parentWindow.SillyTavern?.chat;
    if (Array.isArray(chat) && chat.length > 0) {
      const last = chat[chat.length - 1];
      return last ? (last.swipe_id ?? 0) : null;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function readLastMsgId() {
  try {
    const fn = parentWindow.TavernHelper?.getLastMessageId
      || (typeof globalThis.getLastMessageId === 'function' ? globalThis.getLastMessageId : null)
      || parentWindow.__qhSandboxHelper?.('getLastMessageId');
    if (typeof fn === 'function') {
      const id = fn();
      if (typeof id === 'number' && Number.isFinite(id)) return id;
    }
    const ctx = parentWindow.SillyTavern?.getContext?.();
    const chat = ctx?.chat || parentWindow.SillyTavern?.chat;
    if (Array.isArray(chat)) return chat.length - 1;
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 串行化提交操作：队列挂载在宿主窗口上，确保 runtime.js 与 panel.js 共享同一把写锁，
 * 每次真正轮到自己执行时才调用 mvu.getMvuData 读取最新状态。
 * @param {(stat: object) => ({stat: object, done: string} | {skip: true} | {error: string})} action
 * @param {{core?: string, speaker?: string, redraw?: boolean, expectedChatId?: string}} [options]
 * @returns {Promise<{done?: string, skipped?: boolean, error?: string}>}
 */
export function commit(action, { core = '任务助手', speaker = '任务助手', redraw = true, expectedChatId = '' } = {}) {
  const enqueueChatId = expectedChatId ? String(expectedChatId).trim() : readChatId();
  const enqueueMsgId = readLastMsgId();
  const enqueueSwipeId = latestSwipeId();
  const exec = async () => {
    const mvu = parentWindow.Mvu;
    if (!mvu?.getMvuData || !mvu?.replaceMvuData) return { error: '没有找到 MVU，变量写不进去' };
    if (generating()) return { error: '回复还在生成，等它写完再操作' };
    const chatIdBefore = readChatId();
    const msgIdBefore = readLastMsgId();
    const swipeIdBefore = latestSwipeId();
    if (enqueueChatId && chatIdBefore && chatIdBefore !== enqueueChatId) {
      return { error: '操作期间聊天已切换，请重试' };
    }
    if (
      (typeof enqueueMsgId === 'number' && typeof msgIdBefore === 'number' && msgIdBefore !== enqueueMsgId)
      || (enqueueSwipeId !== null && swipeIdBefore !== null && swipeIdBefore !== enqueueSwipeId)
    ) {
      return { error: '操作期间聊天或最新楼层已变化，请重试' };
    }
    const option = { type: 'message', message_id: 'latest' };
    let data;
    try {
      data = JSON.parse(JSON.stringify(mvu.getMvuData(option) ?? {}));
    } catch (error) {
      console.error(`[${core}] 读取变量失败:`, error);
      return { error: '读取变量失败' };
    }
    if (!data.stat_data || typeof data.stat_data !== 'object' || !('主角' in data.stat_data)) {
      return { error: `最新楼层没有变量，等下一轮回复之后再操作（${speaker}）` };
    }
    const result = action(data.stat_data);
    if (!result || result.skip) return { skipped: true };
    if (result.error) return result;
    const chatIdNow = readChatId();
    const msgIdNow = readLastMsgId();
    const swipeIdNow = latestSwipeId();
    const refChatId = chatIdBefore || enqueueChatId;
    const refMsgId = typeof msgIdBefore === 'number' ? msgIdBefore : enqueueMsgId;
    const refSwipeId = swipeIdBefore !== null ? swipeIdBefore : enqueueSwipeId;
    if (
      (refChatId && chatIdNow && chatIdNow !== refChatId)
      || (typeof refMsgId === 'number' && typeof msgIdNow === 'number' && msgIdNow !== refMsgId)
      || (refSwipeId !== null && swipeIdNow !== null && swipeIdNow !== refSwipeId)
    ) {
      return { error: '操作期间聊天或最新楼层已变化，请重试' };
    }
    data.stat_data = result.stat;
    try {
      await mvu.replaceMvuData(data, option);
    } catch (error) {
      console.error(`[${core}] 写入变量失败:`, error);
      return { error: '写入变量失败' };
    }
    try {
      await parentWindow.SillyTavern?.getContext?.()?.saveChat?.();
    } catch (error) {
      console.warn(`[${core}] 存档失败，下次发送时会一起保存:`, error);
    }
    if (redraw) {
      try {
        const helper = parentWindow.TavernHelper;
        const id = helper?.getLastMessageId?.();
        if (typeof id === 'number' && id >= 0) await helper.refreshOneMessage?.(id);
      } catch (error) {
        console.warn(`[${core}] 重绘楼层失败:`, error);
      }
    }
    return { done: result.done };
  };

  const prev = parentWindow[QUEUE_KEY] || Promise.resolve();
  const nextTask = prev.catch(() => {}).then(exec);
  parentWindow[QUEUE_KEY] = nextTask.catch(() => {});
  return nextTask;
}
