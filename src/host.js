// 酒馆宿主接入：只读聊天记录与 MVU 变量，向输入框写入行动草稿。
// 在酒馆助手脚本或同源 iframe 内运行；拿不到助手函数时退回到父页面 SillyTavern。

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

export function toast(message, kind = 'info') {
  const toastr = globalThis.toastr ?? parentWindow.toastr;
  toastr?.[kind]?.(message);
}

export { parentWindow };
