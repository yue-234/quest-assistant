// 独立任务助手「冒险手账」主界面。运行在同源 iframe 中，通过 host.js 读写酒馆数据，
// 点击操作经 commit.js 写回最新楼层 /事件/任务情报板。

import { DATA, SCRIPT_VERSION } from './data.js';
import { readState, effectiveChatCount, CORE_NAME, SPEAKER } from './state.js';
import {
  toggleQuestIntent,
  cycleQuestRewardState,
  deleteAftermathEntry,
  ignoreQuest,
  setQuestFocus,
  requestQuestRescan,
  hasPendingMaintenance,
  markReceiptsRead,
  dismissReceipt,
  maintainQuestBoard,
} from './actions.js';
import { commit, generating, replySettleRemainingMs } from './commit.js';
import * as host from './host.js';
import { ENTRY_MODES, readEntryMode, writeEntryMode } from './entryMode.js';
import { readMotionEnabled, writeMotionEnabled } from './motionPref.js';
import {
  BASELINE_SCRIPT_TAG,
  DEFAULT_SCRIPT_REF,
  checkWorldbookCompatibility,
  fetchLatestScriptTag,
  hasNewerScriptVersion,
  normalizeScriptRef,
  readScriptRef,
  worldbookCompatibilityBadge,
} from './scriptRef.js';
import {
  el,
  renderNoteCallout,
  createCrestIcon,
  renderReceiptsStrip,
  renderLoreView,
  renderDiaryView,
} from './panelViews.js';

const QUEST_SEEN_KEY = 'quest_helper_seen_progress_v1';
const DIARY_SEEN_KEY = 'quest_helper_seen_diary_v1';
const TAG_CHECK_TTL_MS = 5 * 60 * 1000;
const TABS = [
  { id: 'board', label: '委托板', shortLabel: '委托' },
  { id: 'lore', label: '风物志', shortLabel: '风物' },
  { id: 'diary', label: '冒险日记', shortLabel: '日记' },
  { id: 'settings', label: '设置', shortLabel: '设置' },
];

const ui = {
  activeTab: 'board',
  prevTab: 'board',
  questCategory: '全部',
  selectedQuestKey: '',
  mobileExpandedQuestKey: '',
  selectedDiaryIndex: -1,
  mobileDiaryIndexOpen: false,
  questEditRewards: false,
  confirmDeleteTrait: '',
  entryMode: ENTRY_MODES.FAB,
  motionEnabled: true,
  latestTag: '',
  latestTagState: 'idle',
  latestCheckedAt: 0,
  worldbookInfo: null,
  worldbookState: 'idle',
  switchingRef: false,
  verDraftText: null,
  focusExpanded: false,
  focusDraftText: null,
  focusDraftMode: null,
};

let tagFetchPromise = null;
let worldbookFetchPromise = null;
let worldbookFetchSeq = 0;

let root = null;
let app = null;
let mounted = false;
let busy = false;
let busySince = 0;
let busyToken = 0;
let sweeping = false;
let markingReceipts = false;
let receiptMarkAttemptKey = '';
let focusComposing = false;
let verComposing = false;
let pendingDeferredRefresh = false;
let openTimer = null;
let openCleanup = null;
let closeTimer = null;
let closeCleanup = null;
let lastRenderedTab = 'board';
let lastCompactState = false;

function isCompactViewport() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return (
    window.matchMedia('(max-width: 768px)').matches ||
    window.matchMedia('(max-height: 540px) and (orientation: landscape)').matches
  );
}

function resetTransientFocusUi({ focusToggle = false, collapse = true } = {}) {
  if (collapse) ui.focusExpanded = false;
  ui.focusDraftText = null;
  ui.focusDraftMode = null;
  focusComposing = false;
  pendingDeferredRefresh = false;
  render({ force: true, skipInputRestore: true });
  if (focusToggle && root) {
    const toggleBtn = root.querySelector('.qh-focus-toggle');
    if (toggleBtn && typeof toggleBtn.focus === 'function') host.safeFocus(toggleBtn);
  }
}

// ---------------------------------------------------------------------------
// 宿主读取与已阅存储
// ---------------------------------------------------------------------------

function chatArray() {
  try {
    for (const win of [window.parent, window]) {
      const st = win?.SillyTavern;
      if (!st) continue;
      const fromContext = typeof st.getContext === 'function' ? st.getContext()?.chat : null;
      if (Array.isArray(fromContext)) return fromContext;
      if (Array.isArray(st.chat)) return st.chat;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function lastFloor() {
  try {
    for (const win of [window.parent, window]) {
      const id = win?.TavernHelper?.getLastMessageId?.();
      if (typeof id === 'number' && id >= 0) return id;
    }
  } catch {
    /* 退回 chat.length */
  }
  const chat = chatArray();
  return chat && chat.length > 0 ? chat.length - 1 : null;
}

function chatCount() {
  return effectiveChatCount(chatArray());
}

function lastSwipeId(chat) {
  if (!Array.isArray(chat)) return '';
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const msg = chat[i];
    if (!msg || msg.is_system) continue;
    return msg.swipe_id ?? '';
  }
  return '';
}

function currentStat() {
  try {
    return host.readStat() || {};
  } catch {
    return {};
  }
}

function currentGeoData() {
  try {
    for (const win of [window.parent, window]) {
      const getVars = win?.TavernHelper?.getVariables || win?.getVariables;
      if (typeof getVars !== 'function') continue;
      const vars = getVars({ type: 'chat' });
      if (vars && vars.runtime_geo_compact_data && typeof vars.runtime_geo_compact_data === 'object') {
        return vars.runtime_geo_compact_data;
      }
    }
  } catch {
    /* 退回路径兜底 */
  }
  return null;
}

function seenProgressKey() {
  const cid = host.readChatId();
  return cid ? `${QUEST_SEEN_KEY}:${cid}` : QUEST_SEEN_KEY;
}

function markSeenProgress(sig) {
  if (!sig) return;
  host.writeStorage(seenProgressKey(), sig);
}

function seenDiaryKey() {
  const cid = host.readChatId();
  return cid ? `${DIARY_SEEN_KEY}:${cid}` : DIARY_SEEN_KEY;
}

function readSeenDiary() {
  return host.readStorage(seenDiaryKey());
}

function markSeenDiary(sig) {
  if (!sig) return;
  host.writeStorage(seenDiaryKey(), sig);
}

// ---------------------------------------------------------------------------
// Toast 与写操作
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  if (!root) return;
  const node = root.querySelector('.qh-toast');
  if (!node) return;
  node.textContent = message;
  node.className = `qh-toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'qh-toast';
  }, 2600);
}

async function run(label, action, { redraw = true, after } = {}) {
  if (busy) {
    if (Date.now() - busySince < 8000) {
      toast('上一次操作还在处理，稍等一下', 'err');
      return;
    }
    busy = false;
  }
  if (generating()) {
    toast('正在生成回复，等这一轮结束再操作', 'err');
    return;
  }
  busy = true;
  busySince = Date.now();
  const myToken = ++busyToken;
  const expectedChatId = host.readChatId?.() || '';
  try {
    const result = await commit(action, { core: CORE_NAME, speaker: SPEAKER, redraw, expectedChatId });
    if (result && result.error) {
      toast(result.error, 'err');
    } else {
      if (typeof after === 'function') after();
      toast((result && result.done) || label, 'ok');
      render();
      app?.onUnreadSync?.();
    }
  } catch (error) {
    toast(`操作失败：${error && error.message ? error.message : error}`, 'err');
  } finally {
    if (busyToken === myToken) busy = false;
  }
}

// ---------------------------------------------------------------------------
// 任务辅助逻辑
// ---------------------------------------------------------------------------

function buildQuestDraft(item) {
  const title = item.displayTitle || item.title;
  const place = item.guide || item.location || '情报指明的地点';
  if (item.wayKind === 'crisis') {
    return `根据手头的地区情报，我立刻赶往现场介入「${title}」（切入：${place}）。`;
  }
  if (item.wayKind === 'clue') {
    return `根据手头的地区情报，我顺着线索动身前往「${title}」（线索：${place}）。`;
  }
  const guide = item.guide ? `（指引：${item.guide}）` : '';
  return `根据手头的地区情报，我前往打听并接取「${title}」${guide}。`;
}

function questCatClass(category) {
  if (category === '剧情任务') return 'is-story';
  if (category === '本地主线') return 'is-local';
  return 'is-side';
}

function questKeyOf(item) {
  return String(item?.id || item?.title || '');
}

function switchTab(nextTab, { diaryIndex } = {}) {
  const valid = TABS.some((t) => t.id === nextTab) ? nextTab : 'board';
  if (valid === 'settings' && ui.activeTab !== 'settings') {
    ui.prevTab = ui.activeTab;
  }
  ui.activeTab = valid;
  ui.confirmDeleteTrait = '';
  if (valid !== 'board' && ui.focusExpanded) {
    ui.focusExpanded = false;
    ui.focusDraftText = null;
    ui.focusDraftMode = null;
    focusComposing = false;
  }
  if (typeof diaryIndex === 'number' && diaryIndex >= 0) {
    ui.selectedDiaryIndex = diaryIndex;
    ui.mobileDiaryIndexOpen = false;
  }
  if (valid === 'settings') {
    void refreshWorldbookStatus();
    void refreshLatestTag({ force: true });
  }
  render({ resetScroll: true });
}

function jumpToDiary(diaryIndex) {
  switchTab('diary', { diaryIndex });
}

// ---------------------------------------------------------------------------
// 委托板：共用控制区与卷宗详情渲染
// ---------------------------------------------------------------------------

function buildFocusAndRescanControls(state, qb, regionDisplay) {
  const focus = qb.focus || { text: '', mode: 'long', active: false };
  const focusShort = focus.text.length > 8 ? `${focus.text.slice(0, 8)}…` : focus.text;
  const focusModeTag = focus.mode === 'once' ? '本次' : '长期';
  const focusToggleText = focus.active && focus.text
    ? `方向：${focusShort} · ${focusModeTag}`
    : '关注方向';
  const focusToggleTitle = focus.active && focus.text
    ? `当前关注方向（${focusModeTag}）：${focus.text}（点击展开编辑或清空）`
    : '设定下一回合情报生成倾向（默认折叠，留空=通用）';

  const triggerRescan = (isNullCore) => {
    ui.confirmDeleteTrait = '';
    const hasFocusChoice = ui.focusExpanded;
    const inputEl = hasFocusChoice && root ? root.querySelector('.qh-focus-input') : null;
    const pickedFocusText = hasFocusChoice
      ? (inputEl ? inputEl.value : (ui.focusDraftText ?? focus.text ?? ''))
      : undefined;
    const pickedFocusMode = hasFocusChoice
      ? (ui.focusDraftMode || (focus.active && focus.mode === 'once' ? 'once' : 'long'))
      : undefined;
    return run(
      '已预约重扫',
      (s) => requestQuestRescan(s, lastFloor(), chatCount(), {
        nullCore: isNullCore,
        chat: chatArray(),
        ...(hasFocusChoice ? { focusText: pickedFocusText, focusMode: pickedFocusMode } : {}),
      }),
      {
        redraw: true,
        after: () => {
          if (hasFocusChoice) {
            ui.focusDraftText = null;
            ui.focusDraftMode = null;
            ui.focusExpanded = false;
            focusComposing = false;
          }
        },
      },
    );
  };

  const regionCard = el('section', 'qh-region-header');
  const regionTop = el('div', 'qh-region-top');
  const regionInfo = el('div', 'qh-region-info', [
    el('div', 'qh-region-kicker', qb.updatedDay ? `当前驻地 · 更新于 ${qb.updatedDay}` : '当前驻地 · 地区委托卷宗'),
    el('div', 'qh-region-name-row', [
      el('span', 'qh-quest-region', regionDisplay),
      state.day ? el('span', 'qh-region-day-chip', state.day) : null,
    ]),
  ]);

  const acceptedBit = qb.counts.accepted > 0 ? ` · 进行中 ${qb.counts.accepted}` : '';
  const footText = qb.counts.total > 0
    ? `共 ${qb.counts.total} 份（剧情 ${qb.counts.story} · 主线 ${qb.counts.local} · 支线 ${qb.counts.side}）· 锁定 ${qb.counts.intent}${acceptedBit}`
    : '随剧情与跨区移动静默同步；同城走动不会误刷任务';
  regionInfo.append(el('div', qb.rescanPending ? 'qh-region-foot is-gold' : 'qh-region-foot', footText));
  regionTop.append(regionInfo);

  const actBox = el('div', 'qh-quest-rescan');
  actBox.append(
    el(
      'button',
      'qh-focus-toggle' + (focus.active ? ' is-active' : '') + (ui.focusExpanded ? ' is-open' : ''),
      focusToggleText,
      {
        type: 'button',
        title: focusToggleTitle,
        'aria-expanded': ui.focusExpanded ? 'true' : 'false',
      },
      {
        click: () => {
          if (!ui.focusExpanded && ui.focusDraftText === null) {
            ui.focusDraftText = focus.active ? focus.text : '';
          }
          if (!ui.focusExpanded && !ui.focusDraftMode) {
            ui.focusDraftMode = focus.active && focus.mode === 'once' ? 'once' : 'long';
          }
          ui.focusExpanded = !ui.focusExpanded;
          if (!ui.focusExpanded) {
            ui.focusDraftText = null;
            ui.focusDraftMode = null;
            focusComposing = false;
          }
          render();
          if (ui.focusExpanded && root) {
            const inp = root.querySelector('.qh-focus-input');
            if (inp && typeof inp.focus === 'function') {
              host.safeFocus(inp);
              try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* 忽略 */ }
            }
          }
        },
      },
    ),
  );

  if (qb.rescanPending) {
    actBox.append(el('button', 'qh-btn qh-btn--seal', '已预约重扫', { type: 'button', disabled: true }));
  } else if (qb.nullCore) {
    if (qb.rescanCooldownToday) {
      actBox.append(el('button', 'qh-btn qh-btn--seal', '今日已重扫', { type: 'button', disabled: true }));
    } else {
      actBox.append(
        el(
          'button',
          'qh-btn qh-btn--seal',
          '重扫 · 每日 1 次',
          { type: 'button', title: '每日免费重扫 1 次本地未锁定情报' },
          { click: () => triggerRescan(true) },
        ),
      );
    }
  } else if (state.fp < qb.rescanFp) {
    actBox.append(el('button', 'qh-btn qh-btn--seal', `FP 不足 (${qb.rescanFp})`, { type: 'button', disabled: true }));
  } else {
    actBox.append(
      el(
        'button',
        'qh-btn qh-btn--seal',
        `重扫 · ${qb.rescanFp} FP`,
        { type: 'button', title: `消耗 ${qb.rescanFp} FP 重扫未锁定的本地情报` },
        { click: () => triggerRescan(false) },
      ),
    );
  }
  regionTop.append(actBox);
  regionCard.append(regionTop);

  if (ui.focusExpanded) {
    const draftText = ui.focusDraftText !== null ? ui.focusDraftText : (focus.active ? focus.text : '');
    let draftMode = ui.focusDraftMode || (focus.active && focus.mode === 'once' ? 'once' : 'long');

    const submitFocus = (textVal, modeVal) => run(
      '已更新关注方向',
      (s) => setQuestFocus(s, textVal, {
        mode: modeVal,
        chatCount: chatCount(),
        chat: chatArray(),
        floor: lastFloor(),
      }),
      {
        redraw: true,
        after: () => {
          ui.focusDraftText = null;
          ui.focusDraftMode = null;
          ui.focusExpanded = false;
          focusComposing = false;
        },
      },
    );

    let clearBtn = null;
    const focusInput = el(
      'input',
      'qh-focus-input',
      null,
      {
        type: 'text',
        maxlength: '40',
        value: draftText,
        placeholder: '如：经营魔药铺 / 典狱长押运（留空=通用）',
        'aria-label': '关注方向输入',
      },
      {
        compositionstart: () => {
          focusComposing = true;
        },
        compositionend: (ev) => {
          focusComposing = false;
          ui.focusDraftText = ev.target.value;
          if (clearBtn) {
            clearBtn.hidden = !(ev.target.value.trim() || focus.active);
          }
          if (pendingDeferredRefresh) {
            pendingDeferredRefresh = false;
            render();
          }
        },
        input: (ev) => {
          ui.focusDraftText = ev.target.value;
          if (clearBtn) {
            clearBtn.hidden = !(ev.target.value.trim() || focus.active);
          }
        },
        keydown: (ev) => {
          if (ev.isComposing || ev.keyCode === 229) {
            if (ev.key === 'Escape') ev.stopPropagation();
            return;
          }
          if (ev.key === 'Enter') {
            ev.preventDefault();
            void submitFocus(focusInput.value, draftMode);
          } else if (ev.key === 'Escape') {
            ev.stopPropagation();
            resetTransientFocusUi({ focusToggle: true });
          }
        },
      },
    );

    const longModeBtn = el(
      'button',
      'qh-focus-mode' + (draftMode === 'long' ? ' is-active' : ''),
      '长期',
      { type: 'button', 'aria-pressed': draftMode === 'long' ? 'true' : 'false' },
    );
    const onceModeBtn = el(
      'button',
      'qh-focus-mode' + (draftMode === 'once' ? ' is-active' : ''),
      '仅本次',
      { type: 'button', 'aria-pressed': draftMode === 'once' ? 'true' : 'false' },
    );
    const setModeUI = (mode) => {
      draftMode = mode;
      ui.focusDraftMode = mode;
      longModeBtn.className = 'qh-focus-mode' + (mode === 'long' ? ' is-active' : '');
      longModeBtn.setAttribute('aria-pressed', mode === 'long' ? 'true' : 'false');
      onceModeBtn.className = 'qh-focus-mode' + (mode === 'once' ? ' is-active' : '');
      onceModeBtn.setAttribute('aria-pressed', mode === 'once' ? 'true' : 'false');
    };
    longModeBtn.addEventListener('click', () => setModeUI('long'));
    onceModeBtn.addEventListener('click', () => setModeUI('once'));

    clearBtn = el(
      'button',
      'qh-btn qh-btn--xs qh-btn--paper qh-focus-clear',
      '清空',
      {
        type: 'button',
        ...(draftText.trim() || focus.active ? {} : { hidden: '' }),
      },
      {
        click: () => {
          if (!focus.text && !focus.active) {
            focusInput.value = '';
            ui.focusDraftText = null;
            clearBtn.hidden = true;
            host.safeFocus(focusInput);
            return;
          }
          void run(
            '已清空关注方向',
            (s) => setQuestFocus(s, ''),
            {
              redraw: true,
              after: () => {
                ui.focusDraftText = null;
                ui.focusDraftMode = null;
                focusComposing = false;
              },
            },
          );
        },
      },
    );
    if (!(draftText.trim() || focus.active)) clearBtn.hidden = true;

    const saveBtn = el(
      'button',
      'qh-btn qh-btn--xs qh-btn--teal qh-focus-save',
      '保存',
      { type: 'button' },
      { click: () => void submitFocus(focusInput.value, draftMode) },
    );

    regionCard.append(
      el('div', 'qh-focus-bar', [
        focusInput,
        el('div', 'qh-focus-bar-row', [
          el('div', 'qh-focus-modes', [longModeBtn, onceModeBtn]),
          el('div', 'qh-focus-actions', [saveBtn, clearBtn]),
        ]),
      ]),
    );
  }

  return regionCard;
}

/** 渲染选中任务的完整卷宗内容（PC 右页与手机便签展开态共用）。 */
function renderQuestDossier(item, { canEditMode = false, inPocket = false } = {}) {
  const catCls = questCatClass(item.category);
  const diaryIdx = typeof item.diaryIndex === 'number' ? item.diaryIndex : -1;

  const dossier = el(
    'article',
    `qh-dossier ${catCls}${item.accepted ? ' is-accepted' : ''}${item.intent && !item.accepted ? ' is-intent' : ''}${item.staleRegion ? ' is-stale' : ''}${inPocket ? ' is-pocket-body' : ''}`,
  );

  // 顶部徽章与地点/时限纸条
  const badges = el('div', 'qh-quest-badges', [
    el('span', `qh-qbadge qh-qbadge--cat ${catCls}`, item.category),
    el('span', 'qh-qbadge qh-qbadge--rank', item.rank === '原版' ? '原版' : `${item.rank} 级`),
    el('span', 'qh-qbadge qh-qbadge--way', item.way || '委托接取'),
  ]);
  if (item.fromFormalOnly) badges.append(el('span', 'qh-qbadge qh-qbadge--sync', '剧情同步'));
  if (item.accepted) badges.append(el('span', 'qh-qbadge qh-qbadge--accepted', '进行中'));
  if (item.progress) badges.append(el('span', 'qh-qbadge qh-qbadge--progress', '局势变动'));
  if (item.intent && !item.accepted) badges.append(el('span', 'qh-qbadge qh-qbadge--intent', '★ 已锁定'));
  if (item.staleRegion) badges.append(el('span', 'qh-qbadge qh-qbadge--stale', '异地旧档'));

  const head = el('div', 'qh-dossier-head', [badges]);
  if (item.location || item.deadline) {
    const slips = el('div', 'qh-meta-slips', [
      item.location ? el('span', 'qh-meta-slip', `地点 · ${item.location}`) : null,
      item.deadline ? el('span', 'qh-meta-slip is-deadline', `时限 · ${item.deadline}`) : null,
    ]);
    head.append(slips);
  }
  dossier.append(head);

  // 标题与摘要（保留规范结构以严格展示 displayTitle）
  if (!inPocket) {
    dossier.append(el('h3', 'qh-quest-title', item.displayTitle || item.title));
  }
  if (item.summary) {
    dossier.append(el('p', 'qh-quest-summary', item.summary));
  }

  // 最新进展条
  if (item.progress) {
    const progMeta = item.accepted ? '同步自任务面板' : item.updatedDay;
    dossier.append(
      el('div', 'qh-quest-progress', [
        el('div', 'qh-quest-progress-head', [
          el('span', 'qh-quest-progress-label', '最新进展'),
          progMeta ? el('span', 'qh-quest-progress-day', progMeta) : null,
        ]),
        el('div', 'qh-quest-progress-text', item.progress),
      ]),
    );
  }

  // 切入指引纸条
  if (item.guide) {
    dossier.append(
      el('div', 'qh-quest-guide', [
        el('span', 'qh-quest-guide-label', item.guideLabel || '切入指引'),
        el('span', 'qh-quest-guide-text', item.guide),
      ]),
    );
  }

  // 预期收益印章勾选区
  const rewardItems = Array.isArray(item.rewardItems) && item.rewardItems.length > 0
    ? item.rewardItems
    : (item.rewards || []).map((rw, idx) => ({ slot: idx + 1, text: rw, claimed: false, lost: false }));
  const totalSlots = rewardItems.length || item.expectedSlots;
  const claimedCount = typeof item.claimedCount === 'number'
    ? item.claimedCount
    : rewardItems.filter((r) => r.claimed).length;
  const lostCount = typeof item.lostCount === 'number'
    ? item.lostCount
    : rewardItems.filter((r) => !r.claimed && r.lost).length;
  const rewardTitle = claimedCount > 0 && lostCount > 0
    ? `预期收益 · 共 ${totalSlots} 栏（兑现 ${claimedCount} · 失效 ${lostCount}）`
    : (lostCount > 0
      ? `预期收益 · 已失效 ${lostCount} / ${totalSlots} 栏`
      : (claimedCount > 0
        ? `预期收益 · 已兑现 ${claimedCount} / ${totalSlots} 栏`
        : `预期收益 · ${totalSlots} 栏`));
  const canEditThisQuest = !!(ui.questEditRewards && item.accepted && !item.fromFormalOnly);
  const rewardNote = item.fromFormalOnly
    ? '来自原版任务列表，只读展示'
    : (canEditThisQuest
      ? '修改模式：点击下方收益轮换（待获得 / 已兑现 ✓ / 已失效 ✕）'
      : (ui.questEditRewards
        ? '接取后可在修改模式中切换收益状态'
        : '模糊预告 · 兑现打 ✓ · 错失标 ✕'));

  const rewardHeadRight = el('div', 'qh-rewards-head-right');
  if (!inPocket && canEditMode && item.accepted && !item.fromFormalOnly) {
    rewardHeadRight.append(
      el(
        'button',
        'qh-quest-edit-toggle' + (ui.questEditRewards ? ' is-on' : ''),
        ui.questEditRewards ? '✓ 完成修改' : '✎ 修改收益',
        {
          type: 'button',
          title: ui.questEditRewards ? '退出修改模式' : '开启后可点击收益在待获得 / 已兑现 / 已失效间轮换',
        },
        {
          click: () => {
            ui.questEditRewards = !ui.questEditRewards;
            if (!ui.questEditRewards) ui.confirmDeleteTrait = '';
            render();
          },
        },
      ),
    );
  } else {
    rewardHeadRight.append(el('span', 'qh-quest-rewards-note', rewardNote));
  }

  const rewardBox = el('div', 'qh-quest-rewards' + (canEditThisQuest ? ' is-editing' : ''));
  rewardBox.append(
    el('div', 'qh-quest-rewards-head', [
      el('span', 'qh-quest-rewards-title', rewardTitle),
      rewardHeadRight,
    ]),
  );
  if (!inPocket && canEditThisQuest) {
    rewardBox.append(el('div', 'qh-quest-rewards-subnote', rewardNote));
  }

  if (rewardItems.length > 0) {
    const chips = el('div', 'qh-quest-reward-grid');
    rewardItems.forEach((rw) => {
      const isClaimed = !!rw.claimed;
      const isLost = !isClaimed && !!rw.lost;
      const stateCls = isClaimed ? ' is-claimed' : (isLost ? ' is-lost' : '');
      const statusStamp = isClaimed
        ? el('span', 'qh-reward-stamp is-claimed', '✓')
        : (isLost ? el('span', 'qh-reward-stamp is-lost', '✕') : el('span', 'qh-reward-stamp is-open', '□'));
      const children = [
        statusStamp,
        el('span', 'qh-quest-reward-idx', String(rw.slot).padStart(2, '0')),
        el('span', 'qh-quest-reward-text', rw.text),
      ];
      if (canEditThisQuest) {
        const nextTitle = isClaimed
          ? '点击切换为已失效 ✕'
          : (isLost ? '点击恢复为待获得 □' : '点击标记为已兑现 ✓');
        chips.append(
          el(
            'button',
            'qh-quest-reward-chip is-editable' + stateCls,
            children,
            { type: 'button', title: nextTitle },
            {
              click: () => run(
                '已更新收益状态',
                (s) => cycleQuestRewardState(s, item.id, rw.slot, item.title),
                { redraw: false },
              ),
            },
          ),
        );
      } else {
        chips.append(el('div', 'qh-quest-reward-chip' + stateCls, children));
      }
    });
    rewardBox.append(chips);
  } else {
    rewardBox.append(el('div', 'qh-quest-reward-empty', '待情报核实'));
  }
  dossier.append(rewardBox);

  // 底部操作栏
  if (item.fromFormalOnly) {
    dossier.append(
      el('div', 'qh-quest-accepted-bar', '✓ 来自原版任务列表，进度自动同步'),
    );
  } else if (item.accepted) {
    dossier.append(
      el('div', 'qh-quest-accepted-bar', '✓ 已接取并追踪中 · 进展同步自任务面板，收益随推进分批兑现'),
    );
  } else {
    const draftHint = item.wayKind === 'crisis'
      ? '将现场介入草稿填入输入框'
      : (item.wayKind === 'clue' ? '将线索行动草稿填入输入框' : '将寻人接取草稿填入输入框');
    dossier.append(
      el('div', 'qh-quest-foot', [
        el(
          'button',
          'qh-btn qh-btn--sm qh-btn--teal qh-btn--quest-accept',
          '接取委托',
          { type: 'button', title: draftHint },
          {
            click: () => {
              const draftText = buildQuestDraft(item);
              if (host.writeInput(draftText)) {
                host.toast('行动草稿已填入输入框，可微调后发送', 'ok');
                app.close({ focusInputBox: true });
              } else {
                toast('未能写入输入框，请在聊天框手动输入行动', 'err');
              }
            },
          },
        ),
        el(
          'button',
          'qh-btn qh-btn--sm qh-btn--paper' + (item.intent ? ' is-intent-on' : ''),
          item.intent ? '★ 取消锁定' : '☆ 锁定委托',
          { type: 'button', title: '锁定后不会被换区或重扫刷掉，只会因时限到期自动清除' },
          {
            click: () => run(
              item.intent ? '已取消锁定' : '已锁定任务',
              (s) => toggleQuestIntent(s, item.id, item.title),
              { redraw: false },
            ),
          },
        ),
        el(
          'button',
          'qh-btn qh-btn--sm qh-btn--ghost-ink',
          '✕ 忽略',
          { type: 'button' },
          {
            click: () => run('已忽略', (s) => ignoreQuest(s, item.id, item.title), { redraw: false }),
          },
        ),
      ]),
    );
  }

  // 右下折角跳转冒险日记
  if (diaryIdx >= 0) {
    dossier.append(
      el('div', 'qh-dossier-diary-corner', [
        el(
          'button',
          'qh-fold-jump-btn',
          '翻阅关联冒险日记 ↗',
          { type: 'button', title: '跳转至冒险日记对应篇章' },
          { click: () => jumpToDiary(diaryIdx) },
        ),
      ]),
    );
  }

  return dossier;
}

/** 渲染「委托板」视图（PC 双页手账 / Mobile 随身便签本）。 */
function renderBoardView(state, qb, { regionDisplay, canEditMode, compact }) {
  const activeCategory = ['全部', '剧情任务', '本地主线', '支线任务'].includes(ui.questCategory)
    ? ui.questCategory
    : '全部';
  const filtered = activeCategory === '全部'
    ? qb.items
    : qb.items.filter((it) => it.category === activeCategory);

  // 校验选中项
  let selectedItem = filtered.find((it) => questKeyOf(it) === ui.selectedQuestKey) || null;
  if (!selectedItem && filtered.length > 0) {
    selectedItem = filtered[0];
    ui.selectedQuestKey = questKeyOf(selectedItem);
  }
  if (compact) {
    const expandedMatch = filtered.find((it) => questKeyOf(it) === ui.mobileExpandedQuestKey);
    if (!expandedMatch && ui.mobileExpandedQuestKey !== '__none__') {
      ui.mobileExpandedQuestKey = filtered.length > 0 ? questKeyOf(filtered[0]) : '';
    }
  }

  const regionBlock = buildFocusAndRescanControls(state, qb, regionDisplay);
  const notices = [];
  if (qb.rescanPending) {
    notices.push(
      renderNoteCallout('地区情报重扫已预约：下一回合只重扫未锁定的本地主线与支线，剧情任务、已接取与已锁定委托原样保留。'),
    );
  } else if (qb.regionChanged) {
    notices.push(
      renderNoteCallout(
        `已进入新区域「${qb.regionName}」（板上仍为「${qb.boardRegionName}」旧情报），下一回合将自动同步本地区任务。`,
        'warn',
      ),
    );
  }

  const filterBar = el('div', 'qh-quest-filter');
  const catOptions = [
    { value: '全部', text: `全部 ${qb.counts.total}` },
    { value: '剧情任务', text: `剧情 ${qb.counts.story}` },
    { value: '本地主线', text: `主线 ${qb.counts.local}` },
    { value: '支线任务', text: `支线 ${qb.counts.side}` },
  ];
  catOptions.forEach((opt) => {
    filterBar.append(
      el(
        'button',
        'qh-quest-pill' + (activeCategory === opt.value ? ' is-active' : ''),
        opt.text,
        { type: 'button' },
        {
          click: () => {
            ui.questCategory = opt.value;
            ui.confirmDeleteTrait = '';
            render();
          },
        },
      ),
    );
  });
  if (compact && canEditMode) {
    filterBar.append(
      el(
        'button',
        'qh-quest-edit-toggle' + (ui.questEditRewards ? ' is-on' : ''),
        ui.questEditRewards ? '✓ 完成' : '✎ 修改',
        { type: 'button', title: '修改已接取任务收益状态' },
        {
          click: () => {
            ui.questEditRewards = !ui.questEditRewards;
            render();
          },
        },
      ),
    );
  }

  const receiptsNode = renderReceiptsStrip(qb.receipts, {
    onDismiss: (receiptId) => run(
      '已收起结案回执',
      (s) => dismissReceipt(s, receiptId, { chat: chatArray(), chatCount: chatCount() }),
      { redraw: false },
    ),
    onJumpDiary: (diaryIdx) => jumpToDiary(diaryIdx),
  });

  const rescanTip = qb.nullCore
    ? '也可以点击上方按钮每日免费重扫 1 次。'
    : `也可以点击上方按钮消耗 ${qb.rescanFp} FP 主动重扫。`;

  const buildEmptyQuestNote = () => el('div', 'qh-parchment-empty', [
    el('div', 'qh-parchment-empty-seal', '委'),
    el('div', 'qh-parchment-empty-title', qb.counts.total > 0 ? '该分类暂无委托' : '暂无地区委托'),
    el(
      'p',
      'qh-parchment-empty-desc',
      qb.counts.total > 0
        ? '当前筛选分类下没有任务情报，可切回「全部」查看其余委托。'
        : `推进下一回合后，手账会根据当前驻地与剧情自动收录剧情任务、本地主线与支线委托；${rescanTip}`,
    ),
  ]);

  // Mobile 随身便签本布局：单栏折叠便签卡
  if (compact) {
    const mobileList = el('div', 'qh-pocket-list');
    if (filtered.length === 0) {
      mobileList.append(buildEmptyQuestNote());
    } else {
      filtered.forEach((item) => {
        const key = questKeyOf(item);
        const catCls = questCatClass(item.category);
        const expanded = ui.mobileExpandedQuestKey === key;
        const card = el(
          'div',
          `qh-pocket-card ${catCls}${expanded ? ' is-expanded' : ''}${item.accepted ? ' is-accepted' : ''}${item.intent && !item.accepted ? ' is-intent' : ''}`,
        );

        const headerBtn = el(
          'button',
          'qh-pocket-card-head',
          [
            el('div', 'qh-pocket-head-top', [
              el('span', `qh-qbadge qh-qbadge--cat ${catCls}`, item.category),
              el('span', 'qh-qbadge qh-qbadge--rank', item.rank === '原版' ? '原版' : `${item.rank}级`),
              item.accepted ? el('span', 'qh-qbadge qh-qbadge--accepted', '进行中') : null,
              item.intent && !item.accepted ? el('span', 'qh-qbadge qh-qbadge--intent', '★锁定') : null,
              el('span', 'qh-pocket-chevron', expanded ? '▴' : '▾'),
            ]),
            el('h3', 'qh-quest-title', item.displayTitle || item.title),
            !expanded && (item.summary || item.location)
              ? el('div', 'qh-pocket-preview', item.summary || item.location)
              : null,
          ],
          { type: 'button', 'aria-expanded': expanded ? 'true' : 'false' },
          {
            click: () => {
              ui.mobileExpandedQuestKey = expanded ? '__none__' : key;
              ui.selectedQuestKey = key;
              render();
            },
          },
        );

        card.append(headerBtn);
        if (expanded) {
          card.append(renderQuestDossier(item, { canEditMode, inPocket: true }));
        }
        mobileList.append(card);
      });
    }

    return el('div', 'qh-mobile-scroll qh-pocket-board', [
      regionBlock,
      ...notices,
      filterBar,
      receiptsNode,
      mobileList,
    ]);
  }

  // PC 双页手账布局：左页目录 + 右页卷宗
  const indexList = el('div', 'qh-quest-index');
  if (filtered.length === 0) {
    indexList.append(buildEmptyQuestNote());
  } else {
    filtered.forEach((item) => {
      const key = questKeyOf(item);
      const catCls = questCatClass(item.category);
      const isSelected = selectedItem && questKeyOf(selectedItem) === key;
      const row = el(
        'div',
        `qh-index-item ${catCls}${isSelected ? ' is-selected' : ''}${item.accepted ? ' is-accepted' : ''}${item.intent && !item.accepted ? ' is-intent' : ''}${item.staleRegion ? ' is-stale' : ''}`,
        null,
        {
          role: 'button',
          tabindex: '0',
          'aria-current': isSelected ? 'true' : 'false',
        },
        {
          click: () => {
            ui.selectedQuestKey = key;
            render();
          },
          keydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              ui.selectedQuestKey = key;
              render();
            }
          },
        },
      );

      const rowTop = el('div', 'qh-index-top', [
        el('div', 'qh-index-tags', [
          el('span', `qh-qbadge qh-qbadge--cat ${catCls}`, item.category),
          el('span', 'qh-qbadge qh-qbadge--rank', item.rank === '原版' ? '原版' : `${item.rank}级`),
          item.accepted ? el('span', 'qh-qbadge qh-qbadge--accepted', '进行中') : null,
          item.progress ? el('span', 'qh-qbadge qh-qbadge--progress', '变动') : null,
          item.intent && !item.accepted ? el('span', 'qh-qbadge qh-qbadge--intent', '★') : null,
        ]),
      ]);

      // 未接取委托在目录上保留快捷锁定与忽略按钮
      if (!item.accepted && !item.fromFormalOnly) {
        const quickActs = el('div', 'qh-index-quick');
        quickActs.append(
          el(
            'button',
            'qh-icon-mini' + (item.intent ? ' is-on' : ''),
            item.intent ? '★' : '☆',
            {
              type: 'button',
              title: item.intent ? '取消锁定' : '锁定委托（防重扫/换区清除）',
              'aria-label': item.intent ? '取消锁定' : '锁定委托',
            },
            {
              click: (ev) => {
                ev.stopPropagation();
                void run(
                  item.intent ? '已取消锁定' : '已锁定任务',
                  (s) => toggleQuestIntent(s, item.id, item.title),
                  { redraw: false },
                );
              },
            },
          ),
          el(
            'button',
            'qh-icon-mini is-danger',
            '✕',
            { type: 'button', title: '忽略该委托', 'aria-label': '忽略该委托' },
            {
              click: (ev) => {
                ev.stopPropagation();
                void run('已忽略', (s) => ignoreQuest(s, item.id, item.title), { redraw: false });
              },
            },
          ),
        );
        rowTop.append(quickActs);
      }

      row.append(rowTop);
      row.append(el('div', 'qh-index-title', item.displayTitle || item.title));
      const subParts = [];
      if (item.location) subParts.push(item.location);
      if (item.deadline) subParts.push(`时限 ${item.deadline}`);
      const preview = item.progress || item.summary || subParts.join(' · ');
      if (preview) {
        row.append(el('div', 'qh-index-preview', preview));
      }
      indexList.append(row);
    });
  }

  const leftPage = el('section', 'qh-page-sheet qh-page-left', [
    regionBlock,
    ...notices,
    filterBar,
    receiptsNode,
    indexList,
  ]);

  const rightContent = selectedItem
    ? renderQuestDossier(selectedItem, { canEditMode, inPocket: false })
    : el('div', 'qh-parchment-empty qh-dossier-empty', [
        el('div', 'qh-parchment-empty-seal', '卷'),
        el('div', 'qh-parchment-empty-title', '右侧卷宗待展阅'),
        el('p', 'qh-parchment-empty-desc', '在左页点选任意一条委托情报，这里将展开完整线索、预期收益印章与行动操作。'),
      ]);

  const rightPage = el('section', 'qh-page-sheet qh-page-right', [rightContent]);

  return el('div', 'qh-spread qh-spread--board', [
    leftPage,
    el('div', 'qh-spine-crease', null, { 'aria-hidden': 'true' }),
    rightPage,
  ]);
}

// ---------------------------------------------------------------------------
// 嵌入式设置页（书页内双页 / 手机叠排）与版本/世界书状态同步
// ---------------------------------------------------------------------------

function getVersionMeta() {
  const fallback = {
    remoteManaged: false,
    canSwitchVersion: true,
    scriptVersion: SCRIPT_VERSION,
    defaultRef: DEFAULT_SCRIPT_REF,
    loadedRef: SCRIPT_VERSION,
    loadedOrigin: '',
    overrideRef: readScriptRef(host.readStorage),
    selfBooted: false,
  };
  if (typeof app?.getScriptMeta === 'function') {
    try {
      const meta = app.getScriptMeta();
      if (meta && typeof meta === 'object') return { ...fallback, ...meta };
    } catch {
      /* 退回默认元信息 */
    }
  }
  return fallback;
}

function syncVersionControls() {
  if (!root) return;
  const meta = getVersionMeta();
  const canSwitch = meta.canSwitchVersion !== false;
  const wbCheck = checkWorldbookCompatibility(ui.worldbookInfo, meta);
  const hasUpdate = hasNewerScriptVersion(ui.latestTag, meta);
  const showDot = !!wbCheck.mismatch;

  // 同步书签页签上的设置红点
  const settingsTabs = root.querySelectorAll('[data-tab="settings"]');
  settingsTabs.forEach((tabBtn) => {
    tabBtn.classList.toggle('has-update', showDot);
    const tip = showDot ? `设置（${wbCheck.message}）` : '任务助手设置';
    tabBtn.setAttribute('title', tip);
  });

  // 若当前未在设置页，DOM 中无设置表单元素，直接返回
  const metaEl = root.querySelector('.qh-setting-ver-meta');
  if (metaEl) {
    if (meta.remoteManaged || meta.selfBooted) {
      const originLabel = meta.loadedOrigin ? meta.loadedOrigin.replace(/^https?:\/\//, '') : 'jsDelivr';
      const customTag = meta.overrideRef ? ' · 已固定版本' : ' · 默认同步最新';
      metaEl.textContent = `当前加载：${meta.loadedRef}${customTag}（${originLabel}）`;
    } else {
      metaEl.textContent = `当前版本：${meta.scriptVersion}（直链 / 本地脚本）`;
    }
  }

  const input = root.querySelector('.qh-setting-ver-input');
  if (input && !ui.switchingRef && root.ownerDocument.activeElement !== input && ui.verDraftText === null) {
    input.value = meta.overrideRef || meta.loadedRef || meta.defaultRef;
  }
  if (input) input.disabled = !!ui.switchingRef;

  const applyBtn = root.querySelector('.qh-setting-ver-apply');
  if (applyBtn) {
    applyBtn.disabled = !!ui.switchingRef || !canSwitch;
    applyBtn.textContent = ui.switchingRef ? '切换中…' : '切换版本';
  }

  const wbVerEl = root.querySelector('.qh-setting-wb-ver');
  const wbBadgeEl = root.querySelector('.qh-setting-wb-badge');
  const wbSubEl = root.querySelector('.qh-setting-wb-sub');
  if (wbVerEl) {
    if (ui.worldbookState === 'loading' && !ui.worldbookInfo) {
      wbVerEl.textContent = '世界书版本：检测中…';
    } else if (wbCheck.worldbookVersion) {
      wbVerEl.textContent = `世界书版本：${wbCheck.worldbookVersion}`;
    } else if (ui.worldbookInfo?.found && !ui.worldbookInfo.enabled) {
      wbVerEl.textContent = '世界书版本：未启用';
    } else if (ui.worldbookInfo?.found) {
      wbVerEl.textContent = '世界书版本：未标注';
    } else {
      wbVerEl.textContent = '世界书版本：未检测到';
    }
  }
  if (wbBadgeEl) {
    wbBadgeEl.classList.remove('is-ok', 'is-warn', 'is-muted');
    const badge = worldbookCompatibilityBadge(wbCheck, ui.worldbookInfo, {
      loading: ui.worldbookState === 'loading' && !ui.worldbookInfo,
    });
    wbBadgeEl.textContent = badge.text;
    wbBadgeEl.classList.add(`is-${badge.tone}`);
  }
  if (wbSubEl) {
    if (wbCheck.mismatch || wbCheck.status === 'version_unannotated') {
      wbSubEl.textContent = wbCheck.message;
      wbSubEl.classList.add('is-warn');
    } else {
      wbSubEl.classList.remove('is-warn');
      if (ui.worldbookInfo?.found) {
        const bookSuffix = ui.worldbookInfo.bookName ? `（${ui.worldbookInfo.bookName}）` : '';
        if (ui.worldbookInfo.dualMode) {
          const titleList = Array.isArray(ui.worldbookInfo.titles) && ui.worldbookInfo.titles.length
            ? ui.worldbookInfo.titles.join(' + ')
            : (ui.worldbookInfo.title || '任务助手');
          wbSubEl.textContent = `当前识别双条目：${titleList}${bookSuffix}`;
        } else {
          wbSubEl.textContent = `当前识别条目：${ui.worldbookInfo.title || '任务助手'}${bookSuffix}`;
        }
      } else {
        wbSubEl.textContent = wbCheck.message;
      }
    }
  }

  const latestEl = root.querySelector('.qh-setting-latest');
  if (latestEl) {
    latestEl.classList.remove('is-newer', 'is-muted');
    if (ui.latestTagState === 'loading') {
      latestEl.textContent = '最新版本：查询中…';
      latestEl.classList.add('is-muted');
    } else if (ui.latestTag) {
      latestEl.textContent = hasUpdate ? `最新版本：${ui.latestTag}（有更新）` : `最新版本：${ui.latestTag}`;
      if (hasUpdate) latestEl.classList.add('is-newer');
    } else if (ui.latestTagState === 'error') {
      latestEl.textContent = '最新版本：暂未获取';
      latestEl.classList.add('is-muted');
    } else {
      latestEl.textContent = `最新版本：${meta.scriptVersion}`;
    }
  }

  const hintEl = root.querySelector('.qh-setting-ver-hint');
  if (hintEl) {
    const exampleRef = wbCheck.worldbookVersion || ui.latestTag || meta.scriptVersion || BASELINE_SCRIPT_TAG;
    hintEl.textContent = `请保证世界书与脚本版本号一致；对照上方「世界书版本」或「最新版本」输入目标版本号（如 ${exampleRef}）点击「切换版本」热重载。`;
  }
}

async function refreshWorldbookStatus() {
  if (worldbookFetchPromise) return worldbookFetchPromise;
  const reqSeq = ++worldbookFetchSeq;
  const startChatId = host.readChatId?.() || '';
  ui.worldbookState = 'loading';
  syncVersionControls();
  worldbookFetchPromise = (async () => {
    try {
      const info = await host.readActiveWorldbookInfo();
      if (reqSeq !== worldbookFetchSeq || (startChatId && (host.readChatId?.() || '') !== startChatId)) return;
      ui.worldbookInfo = info;
      ui.worldbookState = 'ready';
    } catch {
      if (reqSeq !== worldbookFetchSeq) return;
      ui.worldbookInfo = { supported: false, found: false, enabled: false, version: '', title: '', bookName: '' };
      ui.worldbookState = 'ready';
    } finally {
      if (reqSeq === worldbookFetchSeq) {
        worldbookFetchPromise = null;
        syncVersionControls();
      }
    }
  })();
  return worldbookFetchPromise;
}

async function refreshLatestTag({ force = false } = {}) {
  if (!force && ui.latestCheckedAt && Date.now() - ui.latestCheckedAt < TAG_CHECK_TTL_MS) {
    return;
  }
  if (tagFetchPromise) return tagFetchPromise;
  ui.latestTagState = 'loading';
  syncVersionControls();
  tagFetchPromise = (async () => {
    try {
      const tag = await fetchLatestScriptTag(globalThis.fetch);
      ui.latestTag = tag;
      ui.latestTagState = tag ? 'ready' : 'error';
      ui.latestCheckedAt = Date.now();
    } finally {
      tagFetchPromise = null;
      syncVersionControls();
    }
  })();
  return tagFetchPromise;
}

async function applyScriptRef(rawRef) {
  if (ui.switchingRef) return;
  const meta = getVersionMeta();
  if (meta.canSwitchVersion === false || typeof app?.onScriptRefChange !== 'function') {
    toast('当前运行环境暂不支持热切换版本', 'warn');
    return;
  }
  const normalized = normalizeScriptRef(rawRef);
  if (!normalized) {
    toast('请输入有效的版本号（如 v1.4.13 或 main）', 'err');
    return;
  }
  const defaultRef = meta.defaultRef || DEFAULT_SCRIPT_REF;
  const targetRef = normalized;
  if (
    targetRef === meta.loadedRef
    && (normalized === meta.overrideRef || (targetRef === defaultRef && !meta.overrideRef))
  ) {
    toast(`当前已处于版本 ${targetRef}`, 'info');
    return;
  }

  ui.switchingRef = true;
  syncVersionControls();
  try {
    await app.onScriptRefChange(normalized);
    ui.verDraftText = null;
    host.toast(`已切换至版本 ${targetRef}`, 'ok');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    toast(`切换版本 ${targetRef} 失败：${msg}`, 'err');
  } finally {
    ui.switchingRef = false;
    syncVersionControls();
  }
}

function switchEntryMode(nextMode) {
  const normalized = writeEntryMode(host.writeStorage, nextMode);
  const changed = normalized !== ui.entryMode;
  ui.entryMode = normalized;
  if (changed && typeof app?.onEntryModeChange === 'function') {
    app.onEntryModeChange(normalized);
  }
  render();
  if (changed) {
    toast(
      normalized === ENTRY_MODES.WAND
        ? '已切换为「魔法棒（扩展程序）」入口，可在左下角魔法棒菜单中打开'
        : '已切换为「牛皮手账悬浮本」入口',
      'ok',
    );
  }
}

function switchMotionPref(enabled) {
  const next = writeMotionEnabled(host.writeStorage, enabled);
  const changed = next !== ui.motionEnabled;
  ui.motionEnabled = next;
  if (root) root.classList.toggle('qh-no-motion', !ui.motionEnabled);
  if (changed && typeof app?.onMotionChange === 'function') {
    app.onMotionChange(next);
  }
  render();
  if (changed) {
    toast(next ? '已开启手账开合动画' : '已关闭手账开合动画（瞬时切换）', 'ok');
  }
}

function renderSettingsView({ compact }) {
  const meta = getVersionMeta();
  const verVal = ui.verDraftText !== null
    ? ui.verDraftText
    : (meta.overrideRef || meta.loadedRef || meta.defaultRef);

  const entryGroup = el('section', 'qh-setting-group', [
    el('div', 'qh-sheet-kicker', 'ENTRY & MOTION · 入口与翻页动效'),
    el('h2', 'qh-sheet-title', '外观与入口偏好'),
    el('div', 'qh-setting-label', '面板入口位置'),
    el('div', 'qh-setting-choices', [
      el(
        'button',
        'qh-setting-choice' + (ui.entryMode === ENTRY_MODES.FAB ? ' is-active' : ''),
        [
          el('div', 'qh-setting-choice-top', [
            el('span', 'qh-setting-choice-name', '牛皮手账悬浮本'),
            el('span', 'qh-setting-choice-badge', '默认'),
          ]),
          el('div', 'qh-setting-choice-desc', '在屏幕边缘显示可拖动的微缩牛皮手账图标'),
        ],
        {
          type: 'button',
          role: 'radio',
          'aria-checked': ui.entryMode === ENTRY_MODES.FAB ? 'true' : 'false',
          'data-mode': ENTRY_MODES.FAB,
        },
        { click: () => switchEntryMode(ENTRY_MODES.FAB) },
      ),
      el(
        'button',
        'qh-setting-choice' + (ui.entryMode === ENTRY_MODES.WAND ? ' is-active' : ''),
        [
          el('div', 'qh-setting-choice-top', [
            el('span', 'qh-setting-choice-name', '魔法棒（扩展程序）'),
          ]),
          el('div', 'qh-setting-choice-desc', '隐藏悬浮本，改由左下角魔法棒扩展菜单打开'),
        ],
        {
          type: 'button',
          role: 'radio',
          'aria-checked': ui.entryMode === ENTRY_MODES.WAND ? 'true' : 'false',
          'data-mode': ENTRY_MODES.WAND,
        },
        { click: () => switchEntryMode(ENTRY_MODES.WAND) },
      ),
    ]),
    el(
      'div',
      'qh-setting-hint',
      '切换为「魔法棒」后不再显示悬浮本；点击聊天输入框左下角魔法棒图标中的「任务情报」即可重新打开手账。',
    ),
    el('div', 'qh-setting-divider'),
    el('div', 'qh-setting-label', '手账开合动画'),
    el('div', 'qh-setting-choices', [
      el(
        'button',
        'qh-setting-choice' + (ui.motionEnabled ? ' is-active' : ''),
        [
          el('div', 'qh-setting-choice-top', [
            el('span', 'qh-setting-choice-name', '开启书脊展开'),
            el('span', 'qh-setting-choice-badge', '默认'),
          ]),
          el('div', 'qh-setting-choice-desc', 'PC 端播放约 300ms 对开合拢动效，移动端轻盈淡入'),
        ],
        {
          type: 'button',
          role: 'radio',
          'aria-checked': ui.motionEnabled ? 'true' : 'false',
          'data-motion': 'on',
        },
        { click: () => switchMotionPref(true) },
      ),
      el(
        'button',
        'qh-setting-choice' + (!ui.motionEnabled ? ' is-active' : ''),
        [
          el('div', 'qh-setting-choice-top', [
            el('span', 'qh-setting-choice-name', '关闭动画'),
          ]),
          el('div', 'qh-setting-choice-desc', '瞬时展开与关闭手账，零动效开销'),
        ],
        {
          type: 'button',
          role: 'radio',
          'aria-checked': !ui.motionEnabled ? 'true' : 'false',
          'data-motion': 'off',
        },
        { click: () => switchMotionPref(false) },
      ),
    ]),
  ]);

  const verInput = el(
    'input',
    'qh-setting-ver-input',
    null,
    {
      type: 'text',
      value: verVal,
      placeholder: `${DEFAULT_SCRIPT_REF} 或 ${BASELINE_SCRIPT_TAG}`,
      'aria-label': '输入脚本版本号',
    },
    {
      compositionstart: () => {
        verComposing = true;
      },
      compositionend: (ev) => {
        verComposing = false;
        ui.verDraftText = ev.target.value;
        if (pendingDeferredRefresh) {
          pendingDeferredRefresh = false;
          render();
        }
      },
      input: (ev) => {
        ui.verDraftText = ev.target.value;
      },
      keydown: (e) => {
        if (e.isComposing || e.keyCode === 229) {
          if (e.key === 'Escape') e.stopPropagation();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          void applyScriptRef(verInput.value);
        }
      },
    },
  );

  const verGroup = el('section', 'qh-setting-group', [
    el('div', 'qh-sheet-kicker', 'DIAGNOSTICS & VERSION · 世界书与脚本版本'),
    el('h2', 'qh-sheet-title', '兼容性检查与热切换'),
    el('div', 'qh-setting-wb-box', [
      el('div', 'qh-setting-wb-row', [
        el('div', 'qh-setting-wb-ver', '世界书版本：检测中…'),
        el('span', 'qh-setting-wb-badge is-muted', '检测中'),
      ]),
      el('div', 'qh-setting-wb-sub', '正在检查当前启用的世界书条目…'),
    ]),
    el('div', 'qh-setting-label-row', [
      el('div', 'qh-setting-label', '脚本版本（jsDelivr）'),
      el('span', 'qh-setting-latest', `最新版本：${SCRIPT_VERSION}`),
    ]),
    el('div', 'qh-setting-ver-meta', `当前版本：${SCRIPT_VERSION}`),
    el('div', 'qh-setting-ver-row', [
      verInput,
      el(
        'button',
        'qh-btn qh-btn--sm qh-btn--teal qh-setting-ver-apply',
        '切换版本',
        { type: 'button' },
        { click: () => void applyScriptRef(verInput.value) },
      ),
    ]),
    el('div', 'qh-setting-hint qh-setting-ver-hint'),
  ]);

  if (compact) {
    return el('div', 'qh-mobile-scroll qh-pocket-settings', [entryGroup, verGroup]);
  }

  return el('div', 'qh-spread qh-spread--settings', [
    el('section', 'qh-page-sheet qh-page-left', [entryGroup]),
    el('div', 'qh-spine-crease', null, { 'aria-hidden': 'true' }),
    el('section', 'qh-page-sheet qh-page-right', [verGroup]),
  ]);
}

// ---------------------------------------------------------------------------
// 书签页签同步与整体渲染
// ---------------------------------------------------------------------------

function syncTabBar(stateNow) {
  if (!root) return;
  const qb = stateNow?.questBoard || {};
  const receipts = Array.isArray(qb.receipts) ? qb.receipts : [];
  const localCount = Array.isArray(qb.aftermath?.localEntries) ? qb.aftermath.localEntries.length : 0;
  const worldCount = Array.isArray(qb.aftermath?.worldEntries) ? qb.aftermath.worldEntries.length : 0;
  const loreCount = localCount + worldCount;
  const diaryCount = typeof qb.diaryCount === 'number'
    ? qb.diaryCount
    : (Array.isArray(qb.diaryEntries) ? qb.diaryEntries.length : 0);
  const diarySig = qb.diarySignature || '';
  const diaryUnread = !!(diarySig && diarySig !== readSeenDiary());
  const boardHasReceipt = receipts.length > 0;

  const tabs = root.querySelectorAll('.qh-tab');
  tabs.forEach((btn) => {
    const id = btn.dataset.tab;
    const active = id === ui.activeTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');

    const badge = btn.querySelector('.qh-tab-badge');
    if (badge) {
      if (id === 'board') {
        badge.textContent = boardHasReceipt ? `+${receipts.length}` : '';
        badge.hidden = !boardHasReceipt;
        badge.classList.toggle('is-alert', (qb.unreadReceiptCount || 0) > 0);
      } else if (id === 'lore') {
        badge.textContent = loreCount > 0 ? String(loreCount) : '';
        badge.hidden = loreCount === 0;
        badge.classList.remove('is-alert');
      } else if (id === 'diary') {
        badge.textContent = diaryCount > 0 ? String(diaryCount) : '';
        badge.hidden = diaryCount === 0 && !diaryUnread;
        badge.classList.toggle('is-alert', diaryUnread);
      }
    }
  });
}

function render(options = {}) {
  if (!root) return;
  const doc = root.ownerDocument;
  const activeEl = doc?.activeElement;
  const activeIsFocusInput = !!(activeEl && activeEl.classList?.contains('qh-focus-input'));
  const activeIsVerInput = !!(activeEl && activeEl.classList?.contains('qh-setting-ver-input'));

  if (
    !options.force &&
    root.classList.contains('qh-open') &&
    ((focusComposing && activeIsFocusInput) || (verComposing && activeIsVerInput))
  ) {
    pendingDeferredRefresh = true;
    return;
  }

  const stat = currentStat();
  const curFloor = lastFloor();
  const curCount = chatCount();
  const chatSnapshot = chatArray();

  const curChatId = host.readChatId?.() || '';
  if (
    !sweeping &&
    !generating() &&
    !replySettleRemainingMs({ chatCount: curCount, chatId: curChatId }) &&
    hasPendingMaintenance(stat, {
      floor: curFloor,
      chatCount: curCount,
      chat: chatSnapshot,
    })
  ) {
    sweeping = true;
    commit(
      (statNow) => {
        const liveChat = chatArray();
        const liveFloor = lastFloor();
        const liveCount = chatCount();
        return maintainQuestBoard(statNow, {
          floor: liveFloor,
          chatCount: liveCount,
          chat: liveChat,
        });
      },
      { core: CORE_NAME, speaker: SPEAKER, redraw: false, expectedChatId: curChatId },
    )
      .then((result) => {
        sweeping = false;
        if (result && !result.error && !result.skipped) {
          render();
          app?.onUnreadSync?.();
        }
      })
      .catch(() => {
        sweeping = false;
      });
  }

  let selStart = null;
  let selEnd = null;
  if ((activeIsFocusInput || activeIsVerInput) && !options.skipInputRestore) {
    try {
      selStart = activeEl.selectionStart;
      selEnd = activeEl.selectionEnd;
      if (activeIsFocusInput) ui.focusDraftText = activeEl.value;
      if (activeIsVerInput) ui.verDraftText = activeEl.value;
    } catch {
      /* 忽略 */
    }
  }

  const body = root.querySelector('.qh-body');
  const preserveScroll = !options.resetScroll && lastRenderedTab === ui.activeTab;
  const prevScroll = preserveScroll
    ? {
        body: body.scrollTop,
        left: body.querySelector('.qh-page-left')?.scrollTop ?? 0,
        right: body.querySelector('.qh-page-right')?.scrollTop ?? 0,
        mobile: body.querySelector('.qh-mobile-scroll')?.scrollTop ?? 0,
      }
    : null;

  body.innerHTML = '';

  const compact = isCompactViewport();
  lastCompactState = compact;
  lastRenderedTab = ui.activeTab;

  let stateNow = null;
  let view = null;
  try {
    stateNow = readState(stat, {
      floor: curFloor,
      chatCount: curCount,
      geoData: currentGeoData(),
      chat: chatSnapshot,
      nullCore: host.isNullCore(),
    });
    const qb = stateNow.questBoard || {
      regionName: '',
      boardRegionName: '',
      regionChanged: false,
      updatedDay: '',
      rescanPending: false,
      rescanFp: DATA.questBoard.rescanFp,
      aftermath: { local: [], world: [], localEntries: [], worldEntries: [] },
      items: [],
      counts: { total: 0, story: 0, local: 0, side: 0, accepted: 0, editableAccepted: 0, intent: 0, progressed: 0 },
      receipts: [],
      unreadReceiptCount: 0,
      diaryEntries: [],
      diaryCount: 0,
      diarySignature: '',
    };
    const regionDisplay = qb.regionName || qb.boardRegionName || '未识别区域';
    const localEntries = Array.isArray(qb.aftermath?.localEntries) ? qb.aftermath.localEntries : [];
    const worldEntries = Array.isArray(qb.aftermath?.worldEntries) ? qb.aftermath.worldEntries : [];
    const editableAccepted = typeof qb.counts?.editableAccepted === 'number'
      ? qb.counts.editableAccepted
      : (qb.items || []).filter((x) => x.accepted && !x.fromFormalOnly).length;
    const canEditMode = editableAccepted > 0 || localEntries.length > 0 || worldEntries.length > 0;
    if (!canEditMode) {
      ui.questEditRewards = false;
      ui.confirmDeleteTrait = '';
    }

    if (ui.activeTab === 'lore') {
      view = renderLoreView(qb, {
        regionDisplay,
        editMode: ui.questEditRewards,
        canEditMode,
        confirmDeleteTrait: ui.confirmDeleteTrait,
        compact,
        onToggleEditMode: () => {
          ui.questEditRewards = !ui.questEditRewards;
          if (!ui.questEditRewards) ui.confirmDeleteTrait = '';
          render();
        },
        onToggleConfirm: (uid) => {
          ui.confirmDeleteTrait = uid;
          render();
        },
        onDeleteTrait: (entry) => run(
          '已删除词条',
          (s) => deleteAftermathEntry(s, entry.key, entry.index, entry.text),
          {
            redraw: true,
            after: () => {
              ui.confirmDeleteTrait = '';
            },
          },
        ),
      });
    } else if (ui.activeTab === 'diary') {
      view = renderDiaryView(qb, {
        selectedIndex: ui.selectedDiaryIndex,
        compact,
        mobileIndexOpen: ui.mobileDiaryIndexOpen,
        onSelectIndex: (idx) => {
          ui.selectedDiaryIndex = idx;
          ui.mobileDiaryIndexOpen = false;
          render();
        },
        onToggleMobileIndex: () => {
          ui.mobileDiaryIndexOpen = !ui.mobileDiaryIndexOpen;
          render();
        },
      });
    } else if (ui.activeTab === 'settings') {
      view = renderSettingsView({ compact });
    } else {
      view = renderBoardView(stateNow, qb, { regionDisplay, canEditMode, compact });
    }
  } catch (error) {
    console.error('[任务助手] 页面渲染失败：', error);
    view = el('div', 'qh-mobile-scroll', [
      renderNoteCallout(error && error.message ? error.message : String(error), 'warn'),
    ]);
  }

  if (view) body.append(view);

  // 独立还原左页、右页与移动端容器滚动位置
  if (prevScroll) {
    body.scrollTop = prevScroll.body;
    const nextLeft = body.querySelector('.qh-page-left');
    if (nextLeft) nextLeft.scrollTop = prevScroll.left;
    const nextRight = body.querySelector('.qh-page-right');
    if (nextRight) nextRight.scrollTop = prevScroll.right;
    const nextMobile = body.querySelector('.qh-mobile-scroll');
    if (nextMobile) nextMobile.scrollTop = prevScroll.mobile;
  }

  // 输入焦点与选区还原
  if (activeIsFocusInput && !options.skipInputRestore) {
    const nextInp = root.querySelector('.qh-focus-input');
    if (nextInp && typeof nextInp.focus === 'function') {
      host.safeFocus(nextInp);
      if (typeof selStart === 'number' && typeof selEnd === 'number') {
        try { nextInp.setSelectionRange(selStart, selEnd); } catch { /* 忽略 */ }
      }
    }
  } else if (activeIsVerInput && !options.skipInputRestore) {
    const nextVer = root.querySelector('.qh-setting-ver-input');
    if (nextVer && typeof nextVer.focus === 'function') {
      host.safeFocus(nextVer);
      if (typeof selStart === 'number' && typeof selEnd === 'number') {
        try { nextVer.setSelectionRange(selStart, selEnd); } catch { /* 忽略 */ }
      }
    }
  }

  // 更新顶部书眉 FP 与世界日
  const fpEl = root.querySelector('.qh-top-fp-val');
  if (fpEl && stateNow) fpEl.textContent = String(stateNow.fp);
  const subEl = root.querySelector('.qh-top-sub');
  if (subEl && stateNow) {
    subEl.textContent = stateNow.day ? `世界日 · ${stateNow.day}` : '冒险手账';
  }

  // 同步书签徽标与设置版本控件
  syncTabBar(stateNow);
  syncVersionControls();

  // 打开态下的未读标记（进展、结案回执静默标已阅、访问日记标记已阅）
  if (root.classList.contains('qh-open') && !root.classList.contains('qh-closing') && stateNow?.questBoard) {
    const qb = stateNow.questBoard;
    const sig = qb.progressSignature || '';
    if (sig) markSeenProgress(sig);

    if (ui.activeTab === 'diary' && qb.diarySignature) {
      markSeenDiary(qb.diarySignature);
      syncTabBar(stateNow);
      app?.onUnreadSync?.();
    }

    const unreadReceipts = typeof qb.unreadReceiptCount === 'number' ? qb.unreadReceiptCount : 0;
    if (ui.activeTab === 'board' && unreadReceipts > 0) {
      const receiptSig = (qb.receipts || []).map((r) => `${r.id}:${r.read ? 1 : 0}`).join('|');
      const swipeKey = lastSwipeId(chatSnapshot);
      const attemptKey = `${curChatId}:${curCount}:${swipeKey}:${receiptSig}`;
      if (
        !markingReceipts &&
        receiptMarkAttemptKey !== attemptKey &&
        !generating() &&
        !replySettleRemainingMs({ chatCount: curCount, chatId: curChatId })
      ) {
        markingReceipts = true;
        receiptMarkAttemptKey = attemptKey;
        commit(
          (s) => markReceiptsRead(s, { chat: chatArray(), chatCount: chatCount() }),
          { core: CORE_NAME, speaker: SPEAKER, redraw: false, expectedChatId: curChatId },
        )
          .then((result) => {
            markingReceipts = false;
            if (result && result.error) {
              if (receiptMarkAttemptKey === attemptKey) receiptMarkAttemptKey = '';
              return;
            }
            if (result && !result.skipped) {
              app?.onUnreadSync?.();
              if (root && root.classList.contains('qh-open') && !root.classList.contains('qh-closing')) {
                render();
              }
            }
          })
          .catch(() => {
            markingReceipts = false;
            if (receiptMarkAttemptKey === attemptKey) receiptMarkAttemptKey = '';
          });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 冒险手账外壳与开合动效
// ---------------------------------------------------------------------------

function buildShell() {
  const shell = el('div', 'qh');
  const backdrop = el('div', 'qh-backdrop', null, null, { click: () => app.close() });

  const room = el('div', 'qh-room', null, { role: 'dialog', 'aria-modal': 'true', 'aria-label': '冒险手账与任务情报' });

  // 黄铜包角装饰
  const corners = el('div', 'qh-brass-corners', [
    el('span', 'qh-brass-corner is-tl'),
    el('span', 'qh-brass-corner is-tr'),
    el('span', 'qh-brass-corner is-bl'),
    el('span', 'qh-brass-corner is-br'),
  ], { 'aria-hidden': 'true' });

  // 顶部紧凑书眉 + 书签导航栏（<= 44px）
  const nav = el('nav', 'qh-tabs', null, { role: 'tablist', 'aria-label': '冒险手账分页' });
  TABS.forEach((tab) => {
    const btn = el(
      'button',
      `qh-tab qh-tab--${tab.id}` + (tab.id === ui.activeTab ? ' is-active' : ''),
      [
        el('span', 'qh-tab-label-full', tab.label),
        el('span', 'qh-tab-label-short', tab.shortLabel),
        tab.id === 'settings'
          ? el('span', 'qh-tab-dot', null, { 'aria-hidden': 'true' })
          : el('span', 'qh-tab-badge', '', { hidden: '' }),
      ],
      {
        type: 'button',
        role: 'tab',
        'data-tab': tab.id,
        'aria-selected': tab.id === ui.activeTab ? 'true' : 'false',
      },
      {
        click: () => switchTab(tab.id),
      },
    );
    nav.append(btn);
  });

  const topbar = el('header', 'qh-topbar', [
    el('div', 'qh-top-left', [
      createCrestIcon(),
      el('div', 'qh-top-titles', [
        el('h1', 'qh-top-title', '冒险手账'),
        el('span', 'qh-top-sub', '世界日'),
      ]),
    ]),
    nav,
    el('div', 'qh-top-right', [
      el('div', 'qh-top-fp', [
        el('span', 'qh-top-fp-label', 'FP'),
        el('span', 'qh-top-fp-val', '0'),
      ]),
      el(
        'button',
        'qh-top-close',
        [
          el('span', 'qh-top-close-icon', '✕'),
          el('span', 'qh-top-close-text', '合上'),
        ],
        { type: 'button', title: '合上冒险手账 (Esc)', 'aria-label': '合上冒险手账' },
        { click: () => app.close() },
      ),
    ]),
  ]);

  // 手机端装订环装饰条（CSS 仅在 <=768px / 矮横屏显示）
  const padRings = el(
    'div',
    'qh-pad-rings',
    Array.from({ length: 7 }, () => el('span', 'qh-pad-ring')),
    { 'aria-hidden': 'true' },
  );

  const body = el('main', 'qh-body');
  const bookFrame = el('div', 'qh-book-frame', [padRings, topbar, body, corners]);
  room.append(bookFrame);

  const toastNode = el('div', 'qh-toast');
  shell.append(backdrop, room, toastNode);
  return shell;
}

function cancelOpen() {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (openCleanup) {
    openCleanup();
    openCleanup = null;
  }
  if (root) {
    const room = root.querySelector('.qh-room');
    if (room) room.classList.remove('enter');
  }
}

function cancelClose() {
  cancelOpen();
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (closeCleanup) {
    closeCleanup();
    closeCleanup = null;
  }
  if (root) {
    root.classList.remove('qh-closing');
    const room = root.querySelector('.qh-room');
    if (room) room.classList.remove('leave');
  }
}

function shouldAnimateMotion() {
  if (!ui.motionEnabled) return false;
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

app = {
  open() {
    if (!root) {
      try {
        mount();
      } catch (error) {
        console.error('[任务助手] 界面挂载失败', error);
        return;
      }
    }
    cancelClose();
    ui.questEditRewards = false;
    ui.confirmDeleteTrait = '';
    ui.entryMode = readEntryMode(host.readStorage);
    ui.motionEnabled = readMotionEnabled(host.readStorage);
    ui.verDraftText = null;
    if (ui.activeTab === 'settings') {
      ui.activeTab = ui.prevTab || 'board';
    }
    root.classList.toggle('qh-no-motion', !ui.motionEnabled);
    root.classList.add('qh-open');

    const room = root.querySelector('.qh-room');
    room.classList.remove('enter', 'leave');
    render({ resetScroll: true });
    if (shouldAnimateMotion()) {
      void room.offsetWidth;
      room.classList.add('enter');
      const onOpenEnd = (event) => {
        if (event.target !== room) return;
        if (event.animationName !== 'qh-book-open' && event.animationName !== 'qh-pad-open') return;
        cancelOpen();
      };
      room.addEventListener('animationend', onOpenEnd);
      openCleanup = () => room.removeEventListener('animationend', onOpenEnd);
      openTimer = setTimeout(cancelOpen, 340);
    }

    void refreshWorldbookStatus();
    void refreshLatestTag();

    // 桌面端聚焦关闭按钮方便键盘操作，移动端粗指针避免意外拉起软键盘
    if (!host.isCoarsePointer?.()) {
      const closeBtn = root.querySelector('.qh-top-close');
      if (closeBtn) host.safeFocus(closeBtn);
    }
  },

  close(closeOpts = {}) {
    if (!root || !root.classList.contains('qh-open') || root.classList.contains('qh-closing')) return;
    ui.confirmDeleteTrait = '';
    const finish = () => {
      cancelClose();
      ui.questEditRewards = false;
      ui.confirmDeleteTrait = '';
      ui.focusExpanded = false;
      ui.focusDraftText = null;
      ui.focusDraftMode = null;
      ui.verDraftText = null;
      focusComposing = false;
      verComposing = false;
      pendingDeferredRefresh = false;
      root.classList.remove('qh-open');
      if (typeof app.onClose === 'function') app.onClose(closeOpts);
    };
    if (!shouldAnimateMotion()) {
      finish();
      return;
    }
    const room = root.querySelector('.qh-room');
    if (!room) {
      finish();
      return;
    }
    cancelOpen();
    root.classList.add('qh-closing');
    room.classList.remove('enter');
    void room.offsetWidth;
    room.classList.add('leave');

    const onEnd = (event) => {
      if (event.target !== room) return;
      if (event.animationName !== 'qh-book-close' && event.animationName !== 'qh-pad-close') return;
      finish();
    };
    room.addEventListener('animationend', onEnd);
    closeCleanup = () => room.removeEventListener('animationend', onEnd);
    closeTimer = setTimeout(finish, 320);
  },

  refresh() {
    if (root && root.classList.contains('qh-open') && !root.classList.contains('qh-closing')) render();
  },

  hide() {
    if (!root) return;
    cancelClose();
    clearTimeout(toast.timer);
    const toastEl = root.querySelector('.qh-toast');
    if (toastEl) toastEl.className = 'qh-toast';
    ui.questEditRewards = false;
    ui.confirmDeleteTrait = '';
    ui.focusExpanded = false;
    ui.focusDraftText = null;
    ui.focusDraftMode = null;
    ui.verDraftText = null;
    focusComposing = false;
    verComposing = false;
    pendingDeferredRefresh = false;
    root.classList.remove('qh-open');
  },

  resetForChatChange() {
    ui.activeTab = 'board';
    ui.prevTab = 'board';
    ui.questCategory = '全部';
    ui.selectedQuestKey = '';
    ui.mobileExpandedQuestKey = '';
    ui.selectedDiaryIndex = -1;
    ui.mobileDiaryIndexOpen = false;
    ui.questEditRewards = false;
    ui.confirmDeleteTrait = '';
    ui.focusExpanded = false;
    ui.focusDraftText = null;
    ui.focusDraftMode = null;
    ui.verDraftText = null;
    focusComposing = false;
    verComposing = false;
    pendingDeferredRefresh = false;
    receiptMarkAttemptKey = '';
    markingReceipts = false;
    ui.worldbookInfo = null;
    ui.worldbookState = 'idle';
    worldbookFetchPromise = null;
    worldbookFetchSeq += 1;
    clearTimeout(toast.timer);
    if (root) {
      const toastEl = root.querySelector('.qh-toast');
      if (toastEl) toastEl.className = 'qh-toast';
    }
  },
};

window.questHelperPanel = app;

export function mount(options = {}) {
  if (mounted && root && root.isConnected) {
    render();
    if (options.autoOpen) app.open();
    return app;
  }
  const container = options.container || document.body;
  root = buildShell();
  ui.entryMode = readEntryMode(host.readStorage);
  ui.motionEnabled = readMotionEnabled(host.readStorage);
  root.classList.toggle('qh-no-motion', !ui.motionEnabled);
  container.append(root);
  if (!mounted) {
    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && root && root.classList.contains('qh-open')) {
        if (ui.focusExpanded) {
          resetTransientFocusUi({ focusToggle: true });
          return;
        }
        if (ui.activeTab === 'settings') {
          const backTab = ui.prevTab && ui.prevTab !== 'settings' ? ui.prevTab : 'board';
          switchTab(backTab);
          if (!host.isCoarsePointer?.()) {
            const tabBtn = root.querySelector(`.qh-tab[data-tab="${backTab}"]`);
            if (tabBtn) host.safeFocus(tabBtn);
          }
          return;
        }
        if (ui.confirmDeleteTrait) {
          ui.confirmDeleteTrait = '';
          render();
          return;
        }
        app.close();
      }
    });

    const onViewportChange = () => {
      if (!root || !root.classList.contains('qh-open')) return;
      const nowCompact = isCompactViewport();
      if (nowCompact !== lastCompactState) {
        render();
      }
    };
    window.addEventListener('resize', onViewportChange);
    window.visualViewport?.addEventListener('resize', onViewportChange);

    mounted = true;
  }
  render();
  if (options.autoOpen) app.open();
  return app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
} else {
  mount();
}

export default app;
