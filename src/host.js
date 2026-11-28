// 酒馆宿主接入：只读聊天记录与 MVU 变量，向输入框写入行动草稿。
// 在酒馆助手脚本或同源 iframe 内运行；拿不到助手函数时退回到父页面 SillyTavern。

import { inspectWorldbookEntries } from './scriptRef.js';

const parentWindow = (() => {
  if (typeof window === 'undefined') return globalThis;
  try {
    return window.parent && window.parent !== window ? window.parent : window;
  } catch {
    return window;
  }
})();

function helper(name) {
  const own = globalThis[name];
  if (typeof own === 'function') return own;
  const shared = parentWindow.TavernHelper?.[name];
  return typeof shared === 'function' ? shared : null;
}

function stContext() {
  try {
    return parentWindow.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** 读取最近 limit 层聊天（不含系统隐藏楼层）。 */
export function readMessages(limit = Infinity) {
  const context = stContext();
  const chat = context?.chat;
  if (Array.isArray(chat)) {
    const out = [];
    for (let i = Math.max(0, chat.length - limit); i < chat.length; i += 1) {
      const message = chat[i];
      if (!message || message.is_system || typeof message.mes !== 'string') continue;
      out.push({
        id: i,
        role: message.is_user ? 'user' : 'assistant',
        text: message.mes,
        stat: message.variables?.[message.swipe_id ?? 0]?.stat_data,
      });
    }
    return out;
  }
  const getChatMessages = helper('getChatMessages');
  const getLastMessageId = helper('getLastMessageId');
  if (!getChatMessages || !getLastMessageId) return [];
  try {
    const last = getLastMessageId();
    if (typeof last !== 'number' || last < 0) return [];
    return getChatMessages(`${Math.max(0, last - limit + 1)}-${last}`)
      .filter((m) => m.role !== 'system')
      .map((m) => ({ id: m.message_id, role: m.role, text: m.message ?? '', stat: m.data?.stat_data }));
  } catch {
    return [];
  }
}

/** 读取最新楼层的 stat_data。 */
export function readStat() {
  const getVariables = helper('getVariables');
  if (getVariables) {
    try {
      const vars = getVariables({ type: 'message', message_id: 'latest' });
      if (vars?.stat_data) return vars.stat_data;
    } catch {
      /* 退回 chat 扫描 */
    }
  }
  const chat = stContext()?.chat;
  if (Array.isArray(chat)) {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const message = chat[i];
      const vars = message?.variables?.[message.swipe_id ?? 0];
      if (vars?.stat_data) return vars.stat_data;
    }
  }
  return {};
}

export function lastMessageId() {
  const chat = stContext()?.chat;
  return Array.isArray(chat) ? chat.length - 1 : -1;
}

function inputBox() {
  try {
    return parentWindow.document.querySelector('#send_textarea');
  } catch {
    return null;
  }
}

export function readInput() {
  return inputBox()?.value ?? '';
}

/**
 * 写进输入框。pattern 命中旧内容时替换，否则追加在前面。
 * @returns {boolean} 是否写入成功
 */
export function writeInput(text, pattern) {
  const box = inputBox();
  if (!box) return false;
  const current = box.value.trim();
  let next;
  if (pattern && pattern.test(current)) next = current.replace(pattern, text);
  else next = current ? `${text}\n${current}` : text;
  box.value = next;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** 将焦点移回聊天输入框（若存在）。 */
export function focusInput() {
  const box = inputBox();
  if (!box || typeof box.focus !== 'function') return false;
  try {
    box.focus();
    return true;
  } catch {
    return false;
  }
}

export function toast(message, kind = 'info') {
  const toastr = globalThis.toastr ?? parentWindow.toastr;
  toastr?.[kind]?.(message);
}

/** 只读检测当前聊天是否启用了 null核心。 */
export function isNullCore() {
  try {
    const getVariables = helper('getVariables');
    if (getVariables) {
      const vars = getVariables({ type: 'chat' });
      if (vars && Object.prototype.hasOwnProperty.call(vars, '系统核心')) {
        return String(vars['系统核心'] ?? '').trim() === 'null核心';
      }
    }
  } catch {
    /* 退回 chatMetadata */
  }
  try {
    const val = stContext()?.chatMetadata?.variables?.['系统核心'];
    return String(val ?? '').trim() === 'null核心';
  } catch {
    return false;
  }
}

/** 读取当前聊天唯一标识，用于按聊天隔离本地状态。 */
export function readChatId() {
  try {
    const ctx = stContext();
    const id = ctx?.chatId ?? ctx?.chatMetadata?.chat_id ?? '';
    return String(id ?? '').trim();
  } catch {
    return '';
  }
}

/** 优先通过父窗口 localStorage 读取，跨源或受限时回退当前窗口。 */
export function readStorage(key) {
  for (const win of [parentWindow, globalThis]) {
    try {
      if (win?.localStorage) return win.localStorage.getItem(key) || '';
    } catch {
      /* 尝试下一个窗口 */
    }
  }
  return '';
}

/** 优先通过父窗口 localStorage 写入，跨源或受限时回退当前窗口。 */
export function writeStorage(key, value) {
  for (const win of [parentWindow, globalThis]) {
    try {
      if (win?.localStorage) {
        win.localStorage.setItem(key, value);
        return;
      }
    } catch {
      /* 尝试下一个窗口 */
    }
  }
}

/** 读取当前激活世界书（角色绑定 / 聊天绑定 / 全局启用）中任务助手条目的版本信息。 */
export async function readActiveWorldbookInfo() {
  const getWorldbook = helper('getWorldbook') || helper('getLorebookEntries');
  if (!getWorldbook) {
    return { supported: false, found: false, enabled: false, version: '', title: '', bookName: '' };
  }

  const names = [];
  const pushName = (val) => {
    const s = String(val ?? '').trim();
    if (s && !names.includes(s)) names.push(s);
  };

  try {
    const getCharBooks = helper('getCharWorldbookNames');
    if (getCharBooks) {
      const cb = getCharBooks('current');
      pushName(cb?.primary);
      if (Array.isArray(cb?.additional)) cb.additional.forEach(pushName);
    } else {
      const getCharLorebooks = helper('getCharLorebooks');
      const cb = getCharLorebooks ? getCharLorebooks({ type: 'all' }) : null;
      pushName(cb?.primary);
      if (Array.isArray(cb?.additional)) cb.additional.forEach(pushName);
    }
  } catch {
    /* 忽略角色世界书读取异常 */
  }

  try {
    const getChatBook = helper('getChatWorldbookName') || helper('getChatLorebook');
    if (getChatBook) pushName(getChatBook('current'));
  } catch {
    /* 忽略聊天世界书读取异常 */
  }

  try {
    const getGlobalBooks = helper('getGlobalWorldbookNames');
    if (getGlobalBooks) {
      const gb = getGlobalBooks();
      if (Array.isArray(gb)) gb.forEach(pushName);
    } else {
      const getLoreSettings = helper('getLorebookSettings');
      const gb = getLoreSettings ? getLoreSettings()?.selected_global_lorebooks : null;
      if (Array.isArray(gb)) gb.forEach(pushName);
    }
  } catch {
    /* 忽略全局世界书读取异常 */
  }

  try {
    const getPersona = helper('getPersona');
    if (getPersona) {
      pushName(getPersona('current')?.lorebook);
    }
  } catch {
    /* 忽略人设世界书读取异常 */
  }

  if (names.length === 0) {
    return { supported: true, found: false, enabled: false, version: '', title: '', bookName: '' };
  }

  const bookEntriesList = [];
  for (const bookName of names) {
    try {
      const entries = await getWorldbook(bookName);
      if (Array.isArray(entries)) {
        bookEntriesList.push({ bookName, entries });
      }
    } catch {
      /* 单本世界书读取失败跳过 */
    }
  }
  return inspectWorldbookEntries(bookEntriesList);
}

export { parentWindow };
