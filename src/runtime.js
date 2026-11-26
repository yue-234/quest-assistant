// 独立任务助手主入口。挂载 iframe 面板、可拖动悬浮球与后台静默维护。
// 全局暴露 window.QuestHelperApp（open / close / stop），与任何命定核心完全隔离。
// 项目地址：https://github.com/yue-234/quest-assistant

import { PANEL_CSS, PANEL_JS } from 'quest-helper:panel';
import { BOARD_KEY, CORE_NAME, SPEAKER, readState } from './state.js';
import {
  hasClosedQuestLeftovers,
  needsQuestAcceptedRecord,
  questRescanDone,
  maintainQuestBoard,
} from './actions.js';
import { commit, generating } from './commit.js';
import * as host from './host.js';
import { mountFab } from './fab.js';

const QUEST_SEEN_KEY = 'quest_helper_seen_progress_v1';
const FRAME_ID = 'quest-helper-studio';
const FRAME_STYLE =
  'position:fixed;inset:0;width:100%;height:100vh;height:100dvh;border:0;margin:0;padding:0;' +
  'z-index:9988;background:transparent;color-scheme:normal;display:none';

function hostWindow() {
  try {
    if (window.parent && window.parent !== window && window.parent.document) return window.parent;
  } catch {
    /* 跨源退回自身 */
  }
  return window;
}

function panelDocument() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>任务情报</title><style>${PANEL_CSS}</style></head>` +
    `<body style="margin:0;padding:0;background:transparent"><script>${PANEL_JS}</script></body></html>`;
}

let stops = [];
let api = null;

export function start() {
  if (api) return api;

  const win = hostWindow();
  const doc = win.document;

  if (win.QuestHelperApp) {
    try {
      win.QuestHelperApp.stop();
    } catch {
      /* 忽略 */
    }
  }

  let frame = null;
  let ready = null;
  let lastFocus = null;
  let stopped = false;

  const toast = (message, kind = 'error') => {
    const t = win.toastr;
    if (!t) return;
    const fn = t[kind] || t.info;
    if (typeof fn === 'function') fn(message);
  };

  const readHostChat = () => {
    try {
      const st = win.SillyTavern || (win.parent && win.parent.SillyTavern);
      if (!st) return null;
      const ctxChat = typeof st.getContext === 'function' ? st.getContext()?.chat : null;
      if (Array.isArray(ctxChat)) return ctxChat;
      if (Array.isArray(st.chat)) return st.chat;
    } catch {
      /* 忽略 */
    }
    return null;
  };

  const readHostGeoData = () => {
    try {
      const getVars = win.TavernHelper?.getVariables || win.getVariables;
      if (typeof getVars !== 'function') return null;
      const vars = getVars({ type: 'chat' });
      if (vars && vars.runtime_geo_compact_data && typeof vars.runtime_geo_compact_data === 'object') {
        return vars.runtime_geo_compact_data;
      }
    } catch {
      /* 忽略 */
    }
    return null;
  };

  const readHostFloor = () => {
    try {
      const id = win.TavernHelper?.getLastMessageId?.();
      if (typeof id === 'number' && id >= 0) return id;
    } catch {
      /* 忽略 */
    }
    const chat = readHostChat();
    return chat && chat.length > 0 ? chat.length - 1 : null;
  };

  const ensureFrame = () => {
    if (frame && frame.isConnected && ready) return frame;
    if (!doc.body) return null;
    doc.getElementById(FRAME_ID)?.remove();
    const el = doc.createElement('iframe');
    el.id = FRAME_ID;
    el.setAttribute('style', FRAME_STYLE);
    el.setAttribute('title', '任务情报');

    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('任务情报面板加载超时，请刷新页面再试')), 15000);
      el.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          try {
            resolve(el.contentWindow.questHelperPanel || null);
          } catch (error) {
            reject(error);
          }
        },
        { once: true },
      );
    });

    el.srcdoc = panelDocument();
    doc.body.append(el);
    frame = el;
    ready = wait;
    return frame;
  };

  const hide = () => {
    if (!frame) return;
    frame.style.display = 'none';
    fab.setHidden(false);
    syncFabUnread();
    try {
      frame.contentWindow.questHelperPanel?.hide();
    } catch {
      /* 忽略 */
    }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try {
        lastFocus.focus();
      } catch {
        /* 忽略 */
      }
    }
    lastFocus = null;
  };

  const open = async () => {
    const el = ensureFrame();
    if (!el) {
      toast('页面还没准备好，稍后再试');
      return;
    }
    lastFocus = doc.activeElement;
    try {
      let panel = null;
      try {
        panel = el.contentWindow.questHelperPanel || null;
      } catch {
        panel = null;
      }
      if (!panel) panel = await ready;
      if (stopped) return;
      if (!panel) throw new Error('任务情报面板未初始化');
      panel.onClose = hide;
      panel.open();
      el.style.display = 'block';
      fab.setHidden(true);
      try {
        doc.defaultView.focus();
        el.contentWindow.focus();
      } catch {
        /* 忽略 */
      }
    } catch (error) {
      if (stopped) return;
      el.remove();
      frame = null;
      ready = null;
      fab.setHidden(false);
      toast(`任务情报板打不开：${error && error.message ? error.message : error}`);
    }
  };

  const close = () => hide();

  const fab = mountFab(doc, win, { onOpen: () => void open() });

  const seenProgressKey = () => {
    const cid = host.readChatId();
    return cid ? `${QUEST_SEEN_KEY}:${cid}` : QUEST_SEEN_KEY;
  };

  const syncFabUnread = (statOverride) => {
    try {
      const stat = statOverride || host.readStat();
      if (!stat || typeof stat !== 'object') {
        fab.setUnread(false);
        return;
      }
      const chat = readHostChat();
      const st = readState(stat, {
        floor: readHostFloor(),
        chatCount: chat ? chat.length : null,
        geoData: readHostGeoData(),
        chat,
        nullCore: host.isNullCore(),
      });
      const sig = st && st.questBoard ? st.questBoard.progressSignature : '';
      const seen = host.readStorage(seenProgressKey());
      fab.setUnread(!!(sig && sig !== seen));
    } catch {
      fab.setUnread(false);
    }
  };
  syncFabUnread();

  const events = win.tavern_events || (win.parent && win.parent.tavern_events);
  const eventOn = win.eventOn || (win.parent && win.parent.eventOn);
  const listen = (name, handler) => {
    if (!name || typeof eventOn !== 'function') return;
    try {
      const handle = eventOn(name, handler);
      if (typeof handle === 'function') stops.push(handle);
      else if (handle && typeof handle.stop === 'function') stops.push(() => handle.stop());
    } catch {
      /* 忽略不存在的事件 */
    }
  };

  let bgTimer = 0;
  let bgSweeping = false;
  let bgCooldownUntil = 0;

  const runQuestBoardMaintenance = async () => {
    if (bgSweeping || Date.now() < bgCooldownUntil || generating()) return;
    let stat;
    try {
      stat = host.readStat();
    } catch {
      return;
    }
    if (!stat || typeof stat !== 'object') return;
    syncFabUnread(stat);

    const board = stat['事件'] && stat['事件'][BOARD_KEY];
    if (!board || typeof board !== 'object') return;

    const chatSnapshot = readHostChat();
    const curFloor = readHostFloor();
    const curCount = chatSnapshot ? chatSnapshot.length : null;
    const needClearRescan = questRescanDone(stat, curFloor, curCount);
    const needSweep = !!board['列表'] && hasClosedQuestLeftovers(stat, { chat: chatSnapshot });
    const needRecord = !!board['列表'] && needsQuestAcceptedRecord(stat);
    if (!needClearRescan && !needSweep && !needRecord) return;

    bgSweeping = true;
    try {
      await commit(
        (statNow) => maintainQuestBoard(statNow, { floor: curFloor, chatCount: curCount, chat: chatSnapshot }),
        { core: CORE_NAME, speaker: SPEAKER, redraw: false },
      );
      bgCooldownUntil = Date.now() + 1500;
    } catch {
      /* 静默失败，待下次机会重试 */
    } finally {
      bgSweeping = false;
    }
  };

  const scheduleMaintenance = () => {
    if (bgSweeping || Date.now() < bgCooldownUntil) return;
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => {
      void runQuestBoardMaintenance();
    }, 600);
  };

  if (events && events.CHAT_CHANGED) {
    listen(events.CHAT_CHANGED, () => {
      clearTimeout(bgTimer);
      close();
      syncFabUnread();
    });
  }
  listen(events && events.MESSAGE_RECEIVED ? events.MESSAGE_RECEIVED : 'message_received', scheduleMaintenance);
  listen('mag_variable_update_ended', scheduleMaintenance);

  const stop = () => {
    stopped = true;
    clearTimeout(bgTimer);
    fab.destroy();
    for (const off of stops) {
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
    stops = [];
    if (frame) {
      frame.remove();
      frame = null;
    }
    ready = null;
    api = null;
    if (win.QuestHelperApp === surface) delete win.QuestHelperApp;
  };

  const surface = { open, close, stop };
  win.QuestHelperApp = surface;
  api = surface;
  return api;
}

export function stop() {
  const win = hostWindow();
  if (win.QuestHelperApp) win.QuestHelperApp.stop();
  api = null;
}

// 作为独立脚本粘贴到酒馆脚本助手时自动启动
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const boot = () => {
    try {
      start();
    } catch (error) {
      console.error('[任务助手] 启动失败：', error);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
