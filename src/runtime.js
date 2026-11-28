// 独立任务助手主入口。挂载 iframe 面板、可拖动悬浮球与后台静默维护。
// 全局暴露 window.QuestHelperApp（open / close / stop），与任何命定核心完全隔离。
// 项目地址：https://github.com/yue-234/quest-assistant

import { PANEL_CSS, PANEL_JS } from 'quest-helper:panel';
import { BOARD_KEY, CORE_NAME, SPEAKER, effectiveChatCount, normalizeQuestFocus, readState } from './state.js';
import {
  hasClosedQuestLeftovers,
  hasExpiredAftermath,
  hasExpiredDirectorLeads,
  hasExpiredOnceFocus,
  needsQuestAcceptedRecord,
  questRescanDone,
  maintainQuestBoard,
} from './actions.js';
import {
  clearMsgReceived,
  clearMvuUpdateEnded,
  commit,
  extraAnalysisActive,
  generating,
  isMvuUpdateEndedFor,
  msgRecvGraceRemainingMs,
  recordMsgReceived,
  recordMvuUpdateEnded,
} from './commit.js';
import { SCRIPT_VERSION } from './data.js';
import * as host from './host.js';
import { mountFab } from './fab.js';
import { mountWand } from './wand.js';
import { ENTRY_MODES, normalizeEntryMode, readEntryMode, writeEntryMode } from './entryMode.js';
import {
  DEFAULT_SCRIPT_REF,
  fetchScriptByRef,
  normalizeScriptRef,
  readScriptRef,
  writeScriptRef,
} from './scriptRef.js';

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
  let panelOpened = false;
  let lastUnread = false;
  let entryMode = readEntryMode(host.readStorage);
  let entryControl = null;

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

  let openSeq = 0;

  const hide = () => {
    openSeq += 1;
    if (!frame) return;
    panelOpened = false;
    frame.style.display = 'none';
    entryControl?.setHidden(false);
    syncEntryUnread();
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
    const mySeq = ++openSeq;
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
      if (stopped || mySeq !== openSeq) return;
      if (!panel) throw new Error('任务情报面板未初始化');
      panel.onClose = hide;
      panel.onEntryModeChange = (nextMode) => mountActiveEntry(nextMode);
      panel.getScriptMeta = getScriptMeta;
      panel.onScriptRefChange = async (nextRef) => {
        const loader = win.__QuestHelperRemoteLoader;
        if (loader && typeof loader.switchRef === 'function') {
          return loader.switchRef(nextRef, { reopen: true });
        }
        return switchSelfRef(nextRef, { reopen: true });
      };
      panelOpened = true;
      panel.open();
      el.style.display = 'block';
      entryControl?.setHidden(true);
      try {
        doc.defaultView.focus();
        el.contentWindow.focus();
      } catch {
        /* 忽略 */
      }
    } catch (error) {
      if (stopped || mySeq !== openSeq) return;
      panelOpened = false;
      el.remove();
      frame = null;
      ready = null;
      entryControl?.setHidden(false);
      toast(`任务情报板打不开：${error && error.message ? error.message : error}`);
    }
  };

  const close = () => hide();

  const getScriptMeta = () => {
    const loader = win.__QuestHelperRemoteLoader;
    const selfBoot = win.__QuestHelperSelfBoot;
    const remoteManaged = !!(loader && typeof loader.switchRef === 'function');
    return {
      remoteManaged,
      canSwitchVersion: true,
      scriptVersion: SCRIPT_VERSION,
      defaultRef: loader?.defaultRef || DEFAULT_SCRIPT_REF,
      loadedRef: loader?.loadedRef || selfBoot?.ref || SCRIPT_VERSION,
      loadedOrigin: loader?.loadedOrigin || selfBoot?.origin || '',
      overrideRef: readScriptRef(host.readStorage),
      selfBooted: !remoteManaged && !!selfBoot?.ref,
    };
  };

  const switchSelfRef = async (nextRef, { reopen = false } = {}) => {
    const normalized = normalizeScriptRef(nextRef);
    const targetRef = normalized || DEFAULT_SCRIPT_REF;
    const prevOverride = readScriptRef(host.readStorage);
    const prevSelfBoot = win.__QuestHelperSelfBoot;
    const prevBootstrappedRef = win.__QuestHelperBootstrappedRef;
    const result = await fetchScriptByRef(targetRef, {
      fetchFn: win.fetch || globalThis.fetch,
      readStorage: host.readStorage,
      writeStorage: host.writeStorage,
    });
    if (stopped) return { ref: result.ref, origin: result.origin };
    writeScriptRef(host.writeStorage, normalized === DEFAULT_SCRIPT_REF ? '' : normalized);
    win.__QuestHelperSelfBoot = { ref: result.ref, origin: result.origin };
    win.__QuestHelperBootstrappedRef = result.ref;
    stop();
    try {
      (0, eval)(result.code);
      if (reopen && win.QuestHelperApp && typeof win.QuestHelperApp.open === 'function') {
        void win.QuestHelperApp.open();
      }
    } catch (error) {
      writeScriptRef(host.writeStorage, prevOverride);
      if (prevSelfBoot) win.__QuestHelperSelfBoot = prevSelfBoot;
      else delete win.__QuestHelperSelfBoot;
      if (prevBootstrappedRef !== undefined) win.__QuestHelperBootstrappedRef = prevBootstrappedRef;
      else delete win.__QuestHelperBootstrappedRef;
      start();
      if (reopen) void open();
      toast(`脚本版本切换失败，已回退原版本：${error && error.message ? error.message : error}`);
      throw error;
    }
    return { ref: result.ref, origin: result.origin };
  };

  const mountActiveEntry = (mode = entryMode) => {
    entryControl?.destroy();
    entryControl = null;
    entryMode = normalizeEntryMode(mode);
    entryControl = entryMode === ENTRY_MODES.WAND
      ? mountWand(doc, win, { onOpen: () => void open() })
      : mountFab(doc, win, { onOpen: () => void open() });
    entryControl.setHidden(panelOpened);
    entryControl.setUnread(lastUnread);
    return entryMode;
  };

  const seenProgressKey = () => {
    const cid = host.readChatId();
    return cid ? `${QUEST_SEEN_KEY}:${cid}` : QUEST_SEEN_KEY;
  };

  const syncEntryUnread = (statOverride) => {
    try {
      const stat = statOverride || host.readStat();
      if (!stat || typeof stat !== 'object') {
        lastUnread = false;
        entryControl?.setUnread(false);
        return;
      }
      const chat = readHostChat();
      const st = readState(stat, {
        floor: readHostFloor(),
        chatCount: chat ? chat.length : null,
        geoData: readHostGeoData(),
        chat,
        nullCore: host.isNullCore(),
        extraAnalyzing: extraAnalysisActive(),
      });
      const sig = st && st.questBoard ? st.questBoard.progressSignature : '';
      const seen = host.readStorage(seenProgressKey());
      lastUnread = !!(sig && sig !== seen);
      entryControl?.setUnread(lastUnread);
    } catch {
      lastUnread = false;
      entryControl?.setUnread(false);
    }
  };

  mountActiveEntry(entryMode);
  syncEntryUnread();

  // TavernHelper 的 eventOn / tavern_events 按脚本 iframe 注入在当前作用域 globalThis 上
  const events = globalThis.tavern_events || win.tavern_events || (win.parent && win.parent.tavern_events);
  const eventOn = typeof globalThis.eventOn === 'function'
    ? globalThis.eventOn
    : (typeof win.eventOn === 'function' ? win.eventOn : (win.parent && win.parent.eventOn));
  const stCtx = (() => {
    try { return win.SillyTavern?.getContext?.() || null; } catch { return null; }
  })();
  const stEvents = events || stCtx?.eventTypes || stCtx?.event_types;
  const stEventSource = stCtx?.eventSource || stCtx?.event_source;
  const listen = (name, handler) => {
    if (!name) return;
    if (typeof eventOn === 'function') {
      try {
        const handle = eventOn(name, handler);
        if (typeof handle === 'function') stops.push(handle);
        else if (handle && typeof handle.stop === 'function') stops.push(() => handle.stop());
      } catch {
        /* 忽略不存在的事件 */
      }
      return;
    }
    if (stEventSource && typeof stEventSource.on === 'function') {
      try {
        stEventSource.on(name, handler);
        if (typeof stEventSource.removeListener === 'function') {
          stops.push(() => stEventSource.removeListener(name, handler));
        } else if (typeof stEventSource.off === 'function') {
          stops.push(() => stEventSource.off(name, handler));
        }
      } catch {
        /* 忽略 */
      }
    }
  };

  let bgTimer = 0;
  let bgSweeping = false;
  let bgCooldownUntil = 0;
  let graceRetry = 0;

  const RESCAN_GRACE_MS = 1800;

  const refreshOpenPanel = () => {
    if (!panelOpened || !frame) return;
    try {
      frame.contentWindow?.questHelperPanel?.refresh?.();
    } catch {
      /* 忽略跨域或卸载态 */
    }
  };

  const evalGrace = (curCount, extraFinished, extraAnalyzing, curChatId = host.readChatId()) => {
    if (extraAnalyzing || extraFinished) return { allowGrace: false, waitGraceMs: 0 };
    const rem = msgRecvGraceRemainingMs({ chatCount: curCount, chatId: curChatId, graceMs: RESCAN_GRACE_MS });
    if (rem > 0) return { allowGrace: false, waitGraceMs: rem + 50 };
    return { allowGrace: true, waitGraceMs: 0 };
  };

  const runQuestBoardMaintenance = async () => {
    if (generating()) {
      if (graceRetry < 20) {
        graceRetry += 1;
        clearTimeout(bgTimer);
        bgTimer = setTimeout(() => {
          void runQuestBoardMaintenance();
        }, 1500);
      }
      return;
    }
    if (bgSweeping) {
      clearTimeout(bgTimer);
      bgTimer = setTimeout(() => {
        void runQuestBoardMaintenance();
      }, 400);
      return;
    }
    const waitMs = bgCooldownUntil - Date.now();
    if (waitMs > 0) {
      clearTimeout(bgTimer);
      bgTimer = setTimeout(() => {
        void runQuestBoardMaintenance();
      }, waitMs + 50);
      return;
    }
    graceRetry = 0;
    let stat;
    try {
      stat = host.readStat();
    } catch {
      return;
    }
    if (!stat || typeof stat !== 'object') return;
    syncEntryUnread(stat);

    const board = stat['事件'] && stat['事件'][BOARD_KEY];
    if (!board || typeof board !== 'object') return;

    const chatSnapshot = readHostChat();
    const curFloor = readHostFloor();
    const curCount = effectiveChatCount(chatSnapshot);
    const curChatId = host.readChatId();
    const extraAnalyzing = extraAnalysisActive();
    const extraFinished = isMvuUpdateEndedFor({ chatCount: curCount, chatId: curChatId });
    const { allowGrace, waitGraceMs } = evalGrace(curCount, extraFinished, extraAnalyzing, curChatId);

    const needClearRescan = questRescanDone(stat, curFloor, curCount, {
      extraFinished,
      extraAnalyzing,
      allowGrace,
      chat: chatSnapshot,
    });
    const needSweep = !!board['列表'] && hasClosedQuestLeftovers(stat, { chat: chatSnapshot });
    const needRecord = !!board['列表'] && needsQuestAcceptedRecord(stat);
    const needSweepExpired = hasExpiredAftermath(stat);
    const hasPendingRescan = !!(board['待重扫'] && typeof board['待重扫'] === 'object' && Object.keys(board['待重扫']).length);
    const canCheckOnceFocus = !hasPendingRescan || needClearRescan || allowGrace || extraFinished;
    const needClearOnceFocus = canCheckOnceFocus && hasExpiredOnceFocus(stat, {
      floor: curFloor,
      chatCount: curCount,
      chat: chatSnapshot,
      extraAnalyzing,
      extraFinished,
      allowGrace,
      rescanCleared: needClearRescan,
    });
    const needSweepLeads = hasExpiredDirectorLeads(stat, { chatCount: curCount, chat: chatSnapshot });
    const hasOnceFocus = normalizeQuestFocus(board['关注方向']).mode === 'once'
      && !!normalizeQuestFocus(board['关注方向']).text;

    if (!needClearRescan && !needSweep && !needRecord && !needSweepExpired && !needClearOnceFocus && !needSweepLeads) {
      if ((hasPendingRescan || hasOnceFocus) && waitGraceMs > 0) {
        clearTimeout(bgTimer);
        bgTimer = setTimeout(() => {
          void runQuestBoardMaintenance();
        }, waitGraceMs);
      } else if (extraFinished && !hasPendingRescan) {
        clearMvuUpdateEnded();
      }
      return;
    }

    bgSweeping = true;
    try {
      const result = await commit(
        (statNow) => {
          // 在写锁回调内重读最新宿主页快照，防止排队期间聊天与分析状态变化
          const liveChat = readHostChat();
          const liveFloor = readHostFloor();
          const liveCount = effectiveChatCount(liveChat);
          const liveChatId = host.readChatId();
          const liveAnalyzing = extraAnalysisActive();
          const liveExtraFinished = isMvuUpdateEndedFor({ chatCount: liveCount, chatId: liveChatId });
          const liveGrace = evalGrace(liveCount, liveExtraFinished, liveAnalyzing, liveChatId).allowGrace;
          return maintainQuestBoard(statNow, {
            floor: liveFloor,
            chatCount: liveCount,
            chat: liveChat,
            extraFinished: liveExtraFinished,
            extraAnalyzing: liveAnalyzing,
            allowGrace: liveGrace,
          });
        },
        { core: CORE_NAME, speaker: SPEAKER, redraw: false },
      );
      if (result && !result.error) {
        const hasPendingRescan = !!host.readStat?.()?.['事件']?.[BOARD_KEY]?.['待重扫'];
        if (extraFinished || !hasPendingRescan) {
          clearMvuUpdateEnded();
        }
        if (hasPendingRescan && waitGraceMs > 0) {
          clearTimeout(bgTimer);
          bgTimer = setTimeout(() => {
            void runQuestBoardMaintenance();
          }, Math.max(waitGraceMs, 1550));
        }
        if (!result.skipped) {
          syncEntryUnread();
          refreshOpenPanel();
        }
      }
      bgCooldownUntil = Date.now() + 1500;
    } catch {
      /* 静默失败，待下次机会重试 */
    } finally {
      bgSweeping = false;
    }
  };

  const scheduleMaintenance = (fromMvuEnd = false) => {
    const snap = readHostChat();
    const curCount = effectiveChatCount(snap);
    const curChatId = host.readChatId();
    if (fromMvuEnd) {
      recordMvuUpdateEnded(curCount, curChatId);
    } else {
      recordMsgReceived(curCount, curChatId);
      graceRetry = 0;
    }
    const delay = bgSweeping ? 500 : Math.max(600, bgCooldownUntil - Date.now() + 50);
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => {
      void runQuestBoardMaintenance();
    }, delay);
  };

  if (stEvents && stEvents.CHAT_CHANGED) {
    listen(stEvents.CHAT_CHANGED, () => {
      clearTimeout(bgTimer);
      clearMsgReceived();
      graceRetry = 0;
      clearMvuUpdateEnded();
      close();
      syncEntryUnread();
    });
  }
  const onPassiveRefresh = () => {
    clearTimeout(bgTimer);
    clearMsgReceived();
    graceRetry = 0;
    clearMvuUpdateEnded();
    syncEntryUnread();
    // 若重Roll/删楼前已有 待重扫，宽限后补跑一次过期清理，避免遗留孤儿标记
    try {
      const pending = host.readStat?.()?.['事件']?.[BOARD_KEY]?.['待重扫'];
      if (pending && typeof pending === 'object' && Object.keys(pending).length) {
        bgTimer = setTimeout(() => {
          void runQuestBoardMaintenance();
        }, 2200);
      }
    } catch {
      /* 忽略 */
    }
  };
  listen(stEvents && stEvents.MESSAGE_RECEIVED ? stEvents.MESSAGE_RECEIVED : 'message_received', () => scheduleMaintenance(false));
  listen('mag_variable_update_ended', () => scheduleMaintenance(true));
  listen(stEvents && stEvents.MESSAGE_SWIPED ? stEvents.MESSAGE_SWIPED : 'message_swiped', onPassiveRefresh);
  listen(stEvents && stEvents.MESSAGE_EDITED ? stEvents.MESSAGE_EDITED : 'message_edited', onPassiveRefresh);
  listen(stEvents && stEvents.MESSAGE_DELETED ? stEvents.MESSAGE_DELETED : 'message_deleted', onPassiveRefresh);

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onPageHide = () => stop();
    window.addEventListener('pagehide', onPageHide, { once: true });
    stops.push(() => window.removeEventListener('pagehide', onPageHide));
  }

  const stop = () => {
    stopped = true;
    panelOpened = false;
    clearTimeout(bgTimer);
    entryControl?.destroy();
    entryControl = null;
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

  const surface = {
    open,
    close,
    stop,
    getEntryMode: () => entryMode,
    setEntryMode: (mode) => {
      const next = writeEntryMode(host.writeStorage, mode);
      mountActiveEntry(next);
      return next;
    },
    getScriptMeta,
  };
  win.QuestHelperApp = surface;
  api = surface;

  // 若使用单行 import 或离线脚本启动且曾切换固定版本，后台自动拉取目标版本接管（单会话防循环）
  const overrideRef = readScriptRef(host.readStorage);
  if (!win.__QuestHelperRemoteLoader && overrideRef && win.__QuestHelperBootstrappedRef !== overrideRef) {
    win.__QuestHelperBootstrappedRef = overrideRef;
    void fetchScriptByRef(overrideRef, {
      fetchFn: win.fetch || globalThis.fetch,
      readStorage: host.readStorage,
      writeStorage: host.writeStorage,
    })
      .then((result) => {
        if (stopped || win.__QuestHelperRemoteLoader) return;
        const wasOpen = panelOpened;
        win.__QuestHelperSelfBoot = { ref: result.ref, origin: result.origin };
        stop();
        (0, eval)(result.code);
        if (wasOpen && win.QuestHelperApp && typeof win.QuestHelperApp.open === 'function') {
          void win.QuestHelperApp.open();
        }
      })
      .catch(() => {
        /* 拉取失败时保持当前脚本运行，并清除失效覆盖避免下次继续失败 */
        if (readScriptRef(host.readStorage) === overrideRef) {
          writeScriptRef(host.writeStorage, '');
        }
      });
  }

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
