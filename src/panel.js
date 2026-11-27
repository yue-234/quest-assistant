// 独立任务助手单页界面。运行在同源 iframe 中，通过 host.js 读写酒馆数据，
// 点击操作经 commit.js 写回最新楼层 /事件/任务情报板。

import { DATA, SCRIPT_VERSION } from './data.js';
import { readState, CORE_NAME, SPEAKER } from './state.js';
import {
  toggleQuestIntent,
  cycleQuestRewardState,
  deleteAftermathEntry,
  ignoreQuest,
  requestQuestRescan,
  questRescanDone,
  hasClosedQuestLeftovers,
  hasExpiredAftermath,
  needsQuestAcceptedRecord,
  maintainQuestBoard,
} from './actions.js';
import { commit, extraAnalysisActive, generating, isMvuUpdateEndedFor } from './commit.js';
import * as host from './host.js';
import { ENTRY_MODES, readEntryMode, writeEntryMode } from './entryMode.js';
import {
  BASELINE_SCRIPT_TAG,
  DEFAULT_SCRIPT_REF,
  checkWorldbookCompatibility,
  fetchLatestScriptTag,
  hasNewerScriptVersion,
  normalizeScriptRef,
  readScriptRef,
} from './scriptRef.js';

const QUEST_SEEN_KEY = 'quest_helper_seen_progress_v1';
const TAG_CHECK_TTL_MS = 5 * 60 * 1000;

const ui = {
  questCategory: '全部',
  questEditRewards: false,
  confirmDeleteTrait: '',
  settingsOpen: false,
  entryMode: ENTRY_MODES.FAB,
  latestTag: '',
  latestTagState: 'idle',
  latestCheckedAt: 0,
  worldbookInfo: null,
  worldbookState: 'idle',
  switchingRef: false,
  traitsExpanded: {
    local: false,
    world: false,
  },
};

let tagFetchPromise = null;
let worldbookFetchPromise = null;

let root = null;
let app = null;
let mounted = false;
let busy = false;
let busySince = 0;
let sweeping = false;
let closeTimer = null;
let closeCleanup = null;

// ---------------------------------------------------------------------------
// 宿主读取
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
  const chat = chatArray();
  return chat ? chat.length : null;
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

function readSeenProgress() {
  return host.readStorage(seenProgressKey());
}

function markSeenProgress(sig) {
  if (!sig) return;
  host.writeStorage(seenProgressKey(), sig);
}

// ---------------------------------------------------------------------------
// DOM 工具与 Toast
// ---------------------------------------------------------------------------

function el(tag, className, children, attrs, events) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    for (const key in attrs) {
      if (attrs[key] !== undefined && attrs[key] !== null) {
        if (key === 'disabled') {
          if (attrs[key]) {
            node.disabled = true;
            node.setAttribute('disabled', '');
          }
        } else if (key === 'value') {
          node.value = attrs[key];
        } else {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
  }
  if (events) {
    for (const evt in events) {
      if (events[evt]) node.addEventListener(evt, events[evt]);
    }
  }
  if (children !== undefined && children !== null) {
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c !== null && c !== undefined) {
          node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
      }
    } else {
      node.appendChild(typeof children === 'string' ? document.createTextNode(children) : children);
    }
  }
  return node;
}

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

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

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
  try {
    const result = await commit(action, { core: CORE_NAME, speaker: SPEAKER, redraw });
    if (result && result.error) {
      toast(result.error, 'err');
    } else {
      if (typeof after === 'function') after();
      toast((result && result.done) || label, 'ok');
      render();
    }
  } catch (error) {
    toast(`操作失败：${error && error.message ? error.message : error}`, 'err');
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// 业务组装与渲染
// ---------------------------------------------------------------------------

function buildQuestDraft(item) {
  const place = item.guide || item.location || '情报指明的地点';
  if (item.wayKind === 'crisis') {
    return `根据手头的地区情报，我立刻赶往现场介入「${item.title}」（切入：${place}）。`;
  }
  if (item.wayKind === 'clue') {
    return `根据手头的地区情报，我顺着线索动身前往「${item.title}」（线索：${place}）。`;
  }
  const guide = item.guide ? `（指引：${item.guide}）` : '';
  return `根据手头的地区情报，我前往打听并接取「${item.title}」${guide}。`;
}

function questCatClass(category) {
  if (category === '剧情任务') return 'is-story';
  if (category === '本地主线') return 'is-local';
  return 'is-side';
}

function renderNoteCallout(textStr, tone = '') {
  const cls = tone === 'warn' ? ' is-warn' : tone === 'dim' ? ' is-dim' : '';
  return el('div', 'qh-note' + cls, [
    el('span', 'qh-note-icon', tone === 'warn' ? '⚠' : 'ℹ'),
    el('span', 'qh-note-text', textStr),
  ]);
}

function formatTraitCountdown(entry, compact = false) {
  if (!entry || !entry.isTemp) return '';
  if (entry.daysLeft === 0) return compact ? '今日' : '今日结束';
  if (typeof entry.daysLeft === 'number' && entry.daysLeft > 0) {
    return compact ? `剩${entry.daysLeft}天` : `剩 ${entry.daysLeft} 天`;
  }
  if (entry.until) return `至${entry.until}`;
  return '';
}

function renderContent(state) {
  const wrap = el('div', 'qh-page');
  const qb = state.questBoard || {
    regionName: '',
    boardRegionName: '',
    regionChanged: false,
    updatedDay: '',
    rescanPending: false,
    rescanFp: DATA.questBoard.rescanFp,
    aftermath: { local: [], world: [], localEntries: [], worldEntries: [] },
    items: [],
    counts: { total: 0, story: 0, local: 0, side: 0, accepted: 0, editableAccepted: 0, intent: 0, progressed: 0 },
  };

  const regionDisplay = qb.regionName || qb.boardRegionName || '未识别区域';
  const activeCategory = ['全部', '剧情任务', '本地主线', '支线任务'].includes(ui.questCategory)
    ? ui.questCategory
    : '全部';
  const filtered = activeCategory === '全部'
    ? qb.items
    : qb.items.filter((it) => it.category === activeCategory);

  // 第一层：当前区域与重扫控制带
  const band = el('section', 'qh-band');
  const bandMain = el('div', 'qh-band-main');
  const eyebrow = qb.updatedDay ? `当前覆盖区域 · 更新于 ${qb.updatedDay}` : '当前覆盖区域 · 地区任务情报';
  bandMain.append(el('div', 'qh-eyebrow', eyebrow));
  bandMain.append(
    el('div', 'qh-band-value', [
      el('span', 'qh-quest-region', regionDisplay),
    ]),
  );
  const acceptedBit = qb.counts.accepted > 0 ? ` · 已接取 ${qb.counts.accepted} 条` : '';
  const footText = qb.counts.total > 0
    ? `共 ${qb.counts.total} 条情报（剧情 ${qb.counts.story} · 本地主线 ${qb.counts.local} · 支线 ${qb.counts.side}）· 已锁定 ${qb.counts.intent} 条${acceptedBit}`
    : '随剧情与跨区移动静默同步；同城内部走动不会误刷任务';
  bandMain.append(el('div', qb.rescanPending ? 'qh-stat-foot is-gold' : 'qh-stat-foot', footText));
  band.append(bandMain);

  const actBox = el('div', 'qh-quest-rescan');
  if (qb.rescanPending) {
    actBox.append(el('button', 'qh-btn qh-btn--primary', '已预约重扫，等待下一回合', { type: 'button', disabled: true }));
  } else if (qb.nullCore) {
    if (qb.rescanCooldownToday) {
      actBox.append(el('button', 'qh-btn qh-btn--primary', '今日已重扫（次日可用）', { type: 'button', disabled: true }));
    } else {
      actBox.append(
        el(
          'button',
          'qh-btn qh-btn--primary',
          '重扫本地情报 · 每日 1 次',
          { type: 'button' },
          {
            click: () => {
              ui.confirmDeleteTrait = '';
              return run(
                '已预约重扫',
                (s) => requestQuestRescan(s, lastFloor(), chatCount(), { nullCore: true }),
                { redraw: true },
              );
            },
          },
        ),
      );
    }
  } else if (state.fp < qb.rescanFp) {
    actBox.append(el('button', 'qh-btn qh-btn--primary', `命运点数不足（需 ${qb.rescanFp} FP）`, { type: 'button', disabled: true }));
  } else {
    actBox.append(
      el(
        'button',
        'qh-btn qh-btn--primary',
        `重扫本地情报 · ${qb.rescanFp} FP`,
        { type: 'button' },
        {
          click: () => {
            ui.confirmDeleteTrait = '';
            return run(
              '已预约重扫',
              (s) => requestQuestRescan(s, lastFloor(), chatCount(), { nullCore: false }),
              { redraw: true },
            );
          },
        },
      ),
    );
  }
  band.append(actBox);
  wrap.append(band);

  // 状态提示
  if (qb.rescanPending) {
    wrap.append(
      renderNoteCallout('地区情报重扫已预约：下一回合只重扫未锁定的本地主线与支线任务，剧情任务及已锁定任务将原样保留。'),
    );
  } else if (qb.regionChanged) {
    wrap.append(
      renderNoteCallout(
        `已进入新区域「${qb.regionName}」（板上为「${qb.boardRegionName}」旧情报），下一回合将自动同步本地区任务。`,
        'warn',
      ),
    );
  }

  const localEntries = qb.aftermath && Array.isArray(qb.aftermath.localEntries)
    ? qb.aftermath.localEntries
    : [];
  const worldEntries = qb.aftermath && Array.isArray(qb.aftermath.worldEntries)
    ? qb.aftermath.worldEntries
    : [];
  const editableAccepted = typeof qb.counts.editableAccepted === 'number'
    ? qb.counts.editableAccepted
    : qb.items.filter((x) => x.accepted && !x.fromFormalOnly).length;
  const canEditMode = editableAccepted > 0 || localEntries.length > 0 || worldEntries.length > 0;
  if (!canEditMode) {
    ui.questEditRewards = false;
    ui.confirmDeleteTrait = '';
  }

  // 独立词条双栏区块：当前区域词条 / 世界区域词条
  if (localEntries.length > 0 || worldEntries.length > 0) {
    const hasBothTraits = localEntries.length > 0 && worldEntries.length > 0;
    const traitsGrid = el('section', 'qh-traits-grid' + (hasBothTraits ? '' : ' is-single'));

    const renderTraitCard = (kind, titleText, badgeText, entries) => {
      const expanded = !!ui.traitsExpanded[kind];
      const card = el('div', `qh-trait-card is-${kind}${expanded ? '' : ' is-collapsed'}`);
      const titleWrap = el('div', 'qh-trait-title-wrap', [
        el('span', 'qh-trait-title', titleText),
      ]);
      if (expanded) {
        titleWrap.append(el('span', 'qh-trait-badge', badgeText));
      } else {
        const tagStrip = el('div', 'qh-trait-summary-tags');
        entries.forEach((entry) => {
          const fallback = (entry.body || entry.text || '').trim();
          const label = entry.tag || (fallback.length > 6 ? `${fallback.slice(0, 6)}…` : fallback);
          const toneClass = entry.tone ? ` is-${entry.tone}` : '';
          const ttlCompact = formatTraitCountdown(entry, true);
          const ttlFull = formatTraitCountdown(entry, false);
          const tagChildren = ttlCompact
            ? [label, el('span', 'qh-trait-summary-ttl', ` · ${ttlCompact}`)]
            : label;
          const tipBase = entry.body || entry.text || label;
          const tipText = ttlFull ? `${tipBase}（${ttlFull}）` : tipBase;
          tagStrip.append(
            el('span', `qh-trait-tag qh-trait-summary-tag${toneClass}${entry.isTemp ? ' is-temp' : ''}`, tagChildren, {
              title: tipText,
            }),
          );
        });
        titleWrap.append(tagStrip);
      }

      const headRight = el('div', 'qh-trait-head-right');
      if (expanded && ui.questEditRewards) {
        headRight.append(el('span', 'qh-trait-edit-hint', '修改模式：可删除词条'));
      }
      headRight.append(el('span', 'qh-trait-toggle', expanded ? '收起 ▴' : '展开 ▾'));

      const head = el(
        'div',
        'qh-trait-head',
        [titleWrap, headRight],
        { role: 'button', tabindex: '0', 'aria-expanded': expanded ? 'true' : 'false' },
        {
          click: () => {
            ui.traitsExpanded[kind] = !ui.traitsExpanded[kind];
            if (!ui.traitsExpanded[kind]) ui.confirmDeleteTrait = '';
            render();
          },
          keydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              ui.traitsExpanded[kind] = !ui.traitsExpanded[kind];
              if (!ui.traitsExpanded[kind]) ui.confirmDeleteTrait = '';
              render();
            }
          },
        },
      );
      card.append(head);

      if (!expanded) return card;

      const list = el('div', 'qh-trait-list');
      entries.forEach((entry) => {
        const traitUid = `${kind}:${entry.key}:${entry.index}:${entry.text}`;
        const confirming = ui.questEditRewards && ui.confirmDeleteTrait === traitUid;
        const toneClass = entry.tone ? ` is-${entry.tone}` : '';
        const item = el(
          'div',
          'qh-trait-item' + toneClass + (entry.isTemp ? ' is-temp' : '') + (confirming ? ' is-confirming' : ''),
        );
        const main = el('div', 'qh-trait-main');
        if (entry.tag) {
          main.append(el('span', 'qh-trait-tag', entry.tag));
        } else if (entry.tone) {
          main.append(el('span', 'qh-trait-dot'));
        }
        const ttlText = formatTraitCountdown(entry, false);
        if (ttlText) {
          main.append(
            el('span', 'qh-trait-ttl' + (entry.daysLeft === 0 ? ' is-urgent' : ''), `⏳ ${ttlText}`, {
              title: entry.until ? `有效期至 ${entry.until}` : '',
            }),
          );
        }
        const bodyText = entry.tag ? entry.body : (entry.body || entry.text);
        if (bodyText) {
          main.append(el('span', 'qh-trait-body', bodyText));
        }
        item.append(main);

        if (ui.questEditRewards) {
          const acts = el('div', 'qh-trait-actions');
          if (confirming) {
            acts.append(
              el(
                'button',
                'qh-trait-btn is-confirm',
                '确认删除',
                { type: 'button' },
                {
                  click: () => run(
                    '已删除词条',
                    (s) => deleteAftermathEntry(s, entry.key, entry.index, entry.text),
                    {
                      redraw: true,
                      after: () => {
                        ui.confirmDeleteTrait = '';
                      },
                    },
                  ),
                },
              ),
              el(
                'button',
                'qh-trait-btn is-cancel',
                '取消',
                { type: 'button' },
                {
                  click: () => {
                    ui.confirmDeleteTrait = '';
                    render();
                  },
                },
              ),
            );
          } else {
            acts.append(
              el(
                'button',
                'qh-trait-btn is-delete',
                '删除',
                { type: 'button' },
                {
                  click: () => {
                    ui.confirmDeleteTrait = traitUid;
                    render();
                  },
                },
              ),
            );
          }
          item.append(acts);
        }

        list.append(item);
      });
      card.append(list);
      return card;
    };

    if (localEntries.length > 0) {
      traitsGrid.append(
        renderTraitCard('local', '当前区域词条', `${regionDisplay} · ${localEntries.length} 条`, localEntries),
      );
    }
    if (worldEntries.length > 0) {
      traitsGrid.append(
        renderTraitCard('world', '世界区域词条', `全大陆 · ${worldEntries.length} 条`, worldEntries),
      );
    }
    wrap.append(traitsGrid);
  }

  // 第二层：分类筛选胶囊 + 修改模式开关
  const filterBar = el('div', 'qh-quest-filter');
  const catOptions = [
    { value: '全部', text: `全部 (${qb.counts.total})` },
    { value: '剧情任务', text: `剧情任务 (${qb.counts.story})` },
    { value: '本地主线', text: `本地主线 (${qb.counts.local})` },
    { value: '支线任务', text: `支线任务 (${qb.counts.side})` },
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
  if (canEditMode) {
    filterBar.append(
      el(
        'button',
        'qh-quest-edit-toggle' + (ui.questEditRewards ? ' is-on' : ''),
        ui.questEditRewards ? '✓ 完成修改' : '✎ 修改模式',
        {
          type: 'button',
          title: ui.questEditRewards
            ? '退出修改模式'
            : '开启后可点击收益在待获得 / 已兑现 ✓ / 已失效 ✕ 间切换，或删除区域/世界词条',
        },
        {
          click: () => {
            ui.questEditRewards = !ui.questEditRewards;
            if (ui.questEditRewards) {
              if (localEntries.length > 0) ui.traitsExpanded.local = true;
              if (worldEntries.length > 0) ui.traitsExpanded.world = true;
            } else {
              ui.confirmDeleteTrait = '';
            }
            render();
          },
        },
      ),
    );
  }
  wrap.append(filterBar);

  // 第三层：情报卡片列表
  if (filtered.length === 0) {
    const rescanTip = qb.nullCore
      ? '也可以点击上方按钮每日免费重扫 1 次。'
      : `也可以点击上方按钮消耗 ${qb.rescanFp} FP 主动重扫。`;
    const emptyCard = el('section', 'qh-card', [
      el('div', 'qh-card-head', [
        el('h3', 'qh-card-title', '暂无任务情报'),
        el('span', 'qh-card-sub', '下一回合自动静默同步'),
      ]),
      el(
        'div',
        'qh-empty',
        qb.counts.total > 0
          ? '当前分类下暂时没有任务情报，可以切回「全部」查看。'
          : `任务情报板已就绪。推进下一回合后，系统会根据当前所在区域与剧情自动同步剧情任务、本地主线与支线委托；${rescanTip}`,
      ),
    ]);
    wrap.append(emptyCard);
    return wrap;
  }

  const grid = el('div', 'qh-quest-list');
  filtered.forEach((item) => {
    const catCls = questCatClass(item.category);
    const card = el(
      'article',
      `qh-card qh-quest-card ${catCls}${item.accepted ? ' is-accepted' : ''}${item.intent && !item.accepted ? ' is-intent' : ''}${item.staleRegion ? ' is-stale' : ''}`,
    );

    // 卡片顶栏
    const head = el('div', 'qh-quest-head');
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
    head.append(badges);

    const metaParts = [];
    if (item.location) metaParts.push(item.location);
    if (item.deadline) metaParts.push(`时限 ${item.deadline}`);
    if (metaParts.length) head.append(el('span', 'qh-quest-meta', metaParts.join(' · ')));
    card.append(head);

    // 标题与摘要
    card.append(el('h3', 'qh-quest-title', item.title));
    if (item.summary) card.append(el('p', 'qh-quest-summary', item.summary));

    // 最新进展条
    if (item.progress) {
      const progMeta = item.accepted ? '同步自任务面板' : item.updatedDay;
      card.append(
        el('div', 'qh-quest-progress', [
          el('div', 'qh-quest-progress-head', [
            el('span', 'qh-quest-progress-label', '最新进展'),
            progMeta ? el('span', 'qh-quest-progress-day', progMeta) : null,
          ]),
          el('div', 'qh-quest-progress-text', item.progress),
        ]),
      );
    }

    // 切入指引
    if (item.guide) {
      card.append(
        el('div', 'qh-quest-guide', [
          el('span', 'qh-quest-guide-label', item.guideLabel || '切入指引'),
          el('span', 'qh-quest-guide-text', item.guide),
        ]),
      );
    }

    // 预期收益栏
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
      ? `预期收益 · 共 ${totalSlots} 栏（已兑现 ${claimedCount} · 已失效 ${lostCount}）`
      : (lostCount > 0
        ? `预期收益 · 已失效 ${lostCount} / ${totalSlots} 栏`
        : (claimedCount > 0
          ? `预期收益 · 已兑现 ${claimedCount} / ${totalSlots} 栏`
          : `预期收益 · ${totalSlots} 栏`));
    const canEditRewards = !!(ui.questEditRewards && item.accepted && !item.fromFormalOnly);
    const rewardNote = item.fromFormalOnly
      ? '来自原版任务列表，只读展示'
      : (canEditRewards
        ? '修改模式：点击下方收益可切换（待获得 / 已兑现 ✓ / 已失效 ✕）'
        : (ui.questEditRewards
          ? '接取后可在修改模式中切换收益（待获得 / 已兑现 ✓ / 已失效 ✕）'
          : '模糊预告，兑现打 ✓，错失标 ✕'));

    const rewardBox = el('div', 'qh-quest-rewards' + (canEditRewards ? ' is-editing' : ''));
    rewardBox.append(
      el('div', 'qh-quest-rewards-head', [
        el('span', 'qh-quest-rewards-title', rewardTitle),
        el('span', 'qh-quest-rewards-note', rewardNote),
      ]),
    );
    if (rewardItems.length > 0) {
      const chips = el('div', 'qh-quest-reward-grid');
      rewardItems.forEach((rw) => {
        const isClaimed = !!rw.claimed;
        const isLost = !isClaimed && !!rw.lost;
        const stateCls = isClaimed ? ' is-claimed' : (isLost ? ' is-lost' : '');
        const statusIcon = isClaimed
          ? el('span', 'qh-quest-reward-check', '✓')
          : (isLost ? el('span', 'qh-quest-reward-lost', '✕') : null);
        const children = [
          el('span', 'qh-quest-reward-idx', String(rw.slot).padStart(2, '0')),
          el('span', 'qh-quest-reward-text', rw.text),
          statusIcon,
        ];
        if (canEditRewards) {
          const nextTitle = isClaimed
            ? '点击切换为已失效 ✕'
            : (isLost ? '点击恢复为待获得' : '点击标记为已兑现 ✓');
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
    card.append(rewardBox);

    // 底部操作
    if (item.fromFormalOnly) {
      card.append(
        el('div', 'qh-quest-accepted-bar', '✓ 来自原版任务列表，进度自动同步'),
      );
    } else if (item.accepted) {
      card.append(
        el('div', 'qh-quest-accepted-bar', '✓ 已接取并追踪中 · 进展同步自任务面板，上方预期收益将随推进分批兑现'),
      );
    } else {
      const draftHint = item.wayKind === 'crisis'
        ? '将现场介入草稿填入输入框'
        : (item.wayKind === 'clue' ? '将线索行动草稿填入输入框' : '将寻人接取草稿填入输入框');
      card.append(
        el('div', 'qh-quest-foot', [
          el(
            'button',
            'qh-btn qh-btn--sm qh-btn--quest-accept',
            '接取任务',
            { type: 'button', title: draftHint },
            {
              click: () => {
                const draftText = buildQuestDraft(item);
                if (host.writeInput(draftText)) {
                  toast('行动草稿已填入输入框，可微调后发送', 'ok');
                  app.close();
                } else {
                  toast('未能写入输入框，请在聊天框手动输入行动', 'err');
                }
              },
            },
          ),
          el(
            'button',
            'qh-btn qh-btn--sm qh-btn--quest-sub' + (item.intent ? ' is-intent-on' : ''),
            item.intent ? '★ 取消锁定' : '☆ 锁定任务',
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
            'qh-btn qh-btn--sm qh-btn--ghost',
            '✕ 忽略',
            { type: 'button' },
            {
              click: () => run('已忽略', (s) => ignoreQuest(s, item.id, item.title), { redraw: false }),
            },
          ),
        ]),
      );
    }

    grid.append(card);
  });

  wrap.append(grid);
  return wrap;
}

// ---------------------------------------------------------------------------
// 渲染与静默清理
// ---------------------------------------------------------------------------

function render() {
  if (!root) return;
  const stat = currentStat();
  const curFloor = lastFloor();
  const curCount = chatCount();
  const chatSnapshot = chatArray();

  const extraAnalyzing = extraAnalysisActive();
  const extraFinished = isMvuUpdateEndedFor({
    chatCount: curCount,
    chatId: host.readChatId?.() || '',
  });
  if (
    !sweeping &&
    !generating() &&
    (questRescanDone(stat, curFloor, curCount, { extraFinished, extraAnalyzing, chat: chatSnapshot })
      || hasClosedQuestLeftovers(stat, { chat: chatSnapshot })
      || needsQuestAcceptedRecord(stat)
      || hasExpiredAftermath(stat))
  ) {
    sweeping = true;
    commit(
      (statNow) => {
        const liveChat = chatArray();
        const liveFloor = lastFloor();
        const liveCount = chatCount();
        const liveAnalyzing = extraAnalysisActive();
        const liveExtraFinished = isMvuUpdateEndedFor({
          chatCount: liveCount,
          chatId: host.readChatId?.() || '',
        });
        return maintainQuestBoard(statNow, {
          floor: liveFloor,
          chatCount: liveCount,
          chat: liveChat,
          extraFinished: liveExtraFinished,
          extraAnalyzing: liveAnalyzing,
        });
      },
      { core: CORE_NAME, speaker: SPEAKER, redraw: false },
    )
      .then((result) => {
        sweeping = false;
        if (result && !result.error && !result.skipped) render();
      })
      .catch(() => {
        sweeping = false;
      });
  }

  const body = root.querySelector('.qh-body');
  const scroll = body.scrollTop;
  body.innerHTML = '';

  let stateNow = null;
  let view;
  try {
    stateNow = readState(stat, {
      floor: curFloor,
      chatCount: curCount,
      geoData: currentGeoData(),
      chat: chatSnapshot,
      nullCore: host.isNullCore(),
      extraAnalyzing,
    });
    view = renderContent(stateNow);
  } catch (error) {
    console.error('[任务助手] 页面渲染失败：', error);
    view = el('div', 'qh-page', [
      renderNoteCallout(error && error.message ? error.message : String(error), 'warn'),
    ]);
  }

  body.append(view);
  body.scrollTop = scroll;

  // 更新顶栏 FP 与日期显示
  const fpEl = root.querySelector('.qh-top-fp-val');
  if (fpEl && stateNow) fpEl.textContent = `${stateNow.fp} FP`;
  const subEl = root.querySelector('.qh-top-sub');
  if (subEl && stateNow) {
    subEl.textContent = stateNow.day ? `世界日 · ${stateNow.day}` : '独立地区情报面板';
  }

  // 打开面板即自动标记已读
  const sig = stateNow && stateNow.questBoard ? stateNow.questBoard.progressSignature : '';
  if (sig && root.classList.contains('qh-open')) {
    markSeenProgress(sig);
  }
}

// ---------------------------------------------------------------------------
// 单页外壳与动画控制
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
  const metaEl = root.querySelector('.qh-setting-ver-meta');
  if (metaEl) {
    if (meta.remoteManaged || meta.selfBooted) {
      const originLabel = meta.loadedOrigin ? meta.loadedOrigin.replace(/^https?:\/\//, '') : 'jsDelivr';
      const customTag = meta.overrideRef ? ` · 已固定版本` : ` · 默认同步最新`;
      metaEl.textContent = `当前加载：${meta.loadedRef}${customTag}（${originLabel}）`;
    } else {
      metaEl.textContent = `当前版本：${meta.scriptVersion}（直链 / 本地脚本）`;
    }
  }

  const input = root.querySelector('.qh-setting-ver-input');
  if (input && !ui.switchingRef && root.ownerDocument.activeElement !== input) {
    input.value = meta.overrideRef || meta.loadedRef || meta.defaultRef;
  }
  if (input) input.disabled = !!ui.switchingRef;

  const applyBtn = root.querySelector('.qh-setting-ver-apply');
  if (applyBtn) {
    applyBtn.disabled = !!ui.switchingRef || !canSwitch;
    applyBtn.textContent = ui.switchingRef ? '切换中…' : '切换版本';
  }

  const wbCheck = checkWorldbookCompatibility(ui.worldbookInfo, meta);
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
    if (ui.worldbookState === 'loading' && !ui.worldbookInfo) {
      wbBadgeEl.textContent = '检测中';
      wbBadgeEl.classList.add('is-muted');
    } else if (wbCheck.status === 'matched') {
      wbBadgeEl.textContent = '✓ 与脚本匹配';
      wbBadgeEl.classList.add('is-ok');
    } else if (wbCheck.mismatch) {
      if (wbCheck.status === 'disabled') wbBadgeEl.textContent = '条目未启用';
      else if (wbCheck.status === 'partial_disabled') wbBadgeEl.textContent = '双条目未全开';
      else if (wbCheck.status === 'duplicate_role') wbBadgeEl.textContent = '同角色条目重复';
      else if (wbCheck.status === 'legacy_dual_mixed') wbBadgeEl.textContent = '新旧条目混用';
      else if (wbCheck.status === 'missing_mvu_tag') wbBadgeEl.textContent = '缺少 [mvu_*] 标签';
      else if (wbCheck.status === 'version_unannotated') wbBadgeEl.textContent = '部分未标版本';
      else if (ui.worldbookInfo?.versionConflict) wbBadgeEl.textContent = '双条目版本不一致';
      else wbBadgeEl.textContent = '版本不匹配 · 建议更新';
      wbBadgeEl.classList.add('is-warn');
    } else {
      wbBadgeEl.textContent = wbCheck.status === 'unversioned' ? '无版本号' : '未识别';
      wbBadgeEl.classList.add('is-muted');
    }
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

  const hasUpdate = hasNewerScriptVersion(ui.latestTag, meta);
  const showDot = !!wbCheck.mismatch;
  const toggleBtn = root.querySelector('.qh-top-settings');
  if (toggleBtn) {
    toggleBtn.classList.toggle('has-update', showDot);
    const tip = showDot ? `任务助手设置（${wbCheck.message}）` : '任务助手设置';
    toggleBtn.setAttribute('title', tip);
    toggleBtn.setAttribute('aria-label', tip);
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
  ui.worldbookState = 'loading';
  syncVersionControls();
  worldbookFetchPromise = (async () => {
    try {
      ui.worldbookInfo = await host.readActiveWorldbookInfo();
      ui.worldbookState = 'ready';
    } catch {
      ui.worldbookInfo = { supported: false, found: false, enabled: false, version: '', title: '', bookName: '' };
      ui.worldbookState = 'ready';
    } finally {
      worldbookFetchPromise = null;
      syncVersionControls();
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
    toast('请输入有效的版本号（如 v1.4.3 或 main）', 'err');
    return;
  }
  const targetRef = normalized;
  if (targetRef === meta.loadedRef && normalized === meta.overrideRef) {
    toast(`当前已处于版本 ${targetRef}`, 'info');
    return;
  }

  ui.switchingRef = true;
  syncVersionControls();
  try {
    await app.onScriptRefChange(normalized);
    toast(`已切换至版本 ${targetRef}`, 'ok');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    toast(`切换版本 ${targetRef} 失败：${msg}`, 'err');
  } finally {
    ui.switchingRef = false;
    syncVersionControls();
  }
}

function syncSettingsLayer() {
  if (!root) return;
  const layer = root.querySelector('.qh-settings-layer');
  const toggleBtn = root.querySelector('.qh-top-settings');
  if (layer) {
    layer.classList.toggle('is-open', !!ui.settingsOpen);
    layer.setAttribute('aria-hidden', ui.settingsOpen ? 'false' : 'true');
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('is-active', !!ui.settingsOpen);
    toggleBtn.setAttribute('aria-expanded', ui.settingsOpen ? 'true' : 'false');
  }
  const choices = root.querySelectorAll('.qh-setting-choice');
  choices.forEach((btn) => {
    const active = btn.dataset.mode === ui.entryMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  syncVersionControls();
}

function setSettingsOpen(open) {
  ui.settingsOpen = !!open;
  syncSettingsLayer();
  if (ui.settingsOpen) {
    void refreshWorldbookStatus();
    void refreshLatestTag({ force: true });
  }
}

function switchEntryMode(nextMode) {
  const normalized = writeEntryMode(host.writeStorage, nextMode);
  const changed = normalized !== ui.entryMode;
  ui.entryMode = normalized;
  syncSettingsLayer();
  if (changed && typeof app?.onEntryModeChange === 'function') {
    app.onEntryModeChange(normalized);
  }
  if (changed) {
    toast(
      normalized === ENTRY_MODES.WAND
        ? '已切换为「魔法棒（扩展程序）」入口，可在左下角魔法棒菜单中打开'
        : '已切换为「悬浮框」入口',
      'ok',
    );
  }
}

function buildSettingsLayer() {
  const layer = el('div', 'qh-settings-layer', null, { 'aria-hidden': 'true' });
  const backdrop = el('div', 'qh-settings-backdrop', null, null, {
    click: () => setSettingsOpen(false),
  });
  const card = el('div', 'qh-settings-card', null, {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '任务助手设置',
  });

  const head = el('div', 'qh-settings-head', [
    el('div', 'qh-settings-title', [
      el('span', 'qh-settings-title-icon', '⚙'),
      el('span', null, '任务助手设置'),
    ]),
    el(
      'button',
      'qh-settings-close',
      '✕',
      { type: 'button', title: '关闭设置', 'aria-label': '关闭设置' },
      { click: () => setSettingsOpen(false) },
    ),
  ]);

  const choices = el('div', 'qh-setting-choices', [
    el(
      'button',
      'qh-setting-choice',
      [
        el('div', 'qh-setting-choice-top', [
          el('span', 'qh-setting-choice-name', '悬浮框'),
          el('span', 'qh-setting-choice-badge', '默认'),
        ]),
        el('div', 'qh-setting-choice-desc', '在屏幕边缘显示可拖动「任务」悬浮球'),
      ],
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'true',
        'data-mode': ENTRY_MODES.FAB,
      },
      { click: () => switchEntryMode(ENTRY_MODES.FAB) },
    ),
    el(
      'button',
      'qh-setting-choice',
      [
        el('div', 'qh-setting-choice-top', [
          el('span', 'qh-setting-choice-name', '魔法棒（扩展程序）'),
        ]),
        el('div', 'qh-setting-choice-desc', '隐藏悬浮球，改由左下角魔法棒扩展菜单打开'),
      ],
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'data-mode': ENTRY_MODES.WAND,
      },
      { click: () => switchEntryMode(ENTRY_MODES.WAND) },
    ),
  ]);

  const entryGroup = el('div', 'qh-setting-group', [
    el('div', 'qh-setting-label', '面板入口位置'),
    choices,
    el(
      'div',
      'qh-setting-hint',
      '切换为「魔法棒」后不再显示悬浮框；点击聊天输入框左下角魔法棒图标中的「任务情报」即可重新打开面板并修改设置。',
    ),
  ]);

  const verInput = el(
    'input',
    'qh-setting-ver-input',
    null,
    { type: 'text', placeholder: `${DEFAULT_SCRIPT_REF} 或 v1.4.1`, 'aria-label': '输入脚本版本号' },
    {
      keydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void applyScriptRef(verInput.value);
        }
      },
    },
  );

  const verGroup = el('div', 'qh-setting-group qh-setting-group--sep', [
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
        'qh-btn qh-btn--sm qh-btn--primary qh-setting-ver-apply',
        '切换版本',
        { type: 'button' },
        { click: () => void applyScriptRef(verInput.value) },
      ),
    ]),
    el('div', 'qh-setting-hint qh-setting-ver-hint'),
  ]);

  card.append(head, entryGroup, verGroup);
  layer.append(backdrop, card);
  return layer;
}

function buildShell() {
  const shell = el('div', 'qh');
  const backdrop = el('div', 'qh-backdrop', null, null, { click: () => app.close() });

  const room = el('div', 'qh-room');
  const topbar = el('header', 'qh-topbar', [
    el('div', 'qh-top-left', [
      el('span', 'qh-top-badge', '◈'),
      el('div', 'qh-top-titles', [
        el('h1', 'qh-top-title', '任务情报'),
        el('span', 'qh-top-sub', '独立地区情报面板'),
      ]),
    ]),
    el('div', 'qh-top-right', [
      el('div', 'qh-top-fp', [
        el('span', 'qh-top-fp-label', '命运点数'),
        el('span', 'qh-top-fp-val', '0 FP'),
      ]),
      el(
        'button',
        'qh-top-settings',
        [
          el('span', 'qh-top-settings-icon', '⚙'),
          el('span', 'qh-top-settings-text', '设置'),
          el('span', 'qh-top-settings-dot', null, { 'aria-hidden': 'true' }),
        ],
        {
          type: 'button',
          title: '任务助手设置',
          'aria-label': '任务助手设置',
          'aria-expanded': 'false',
        },
        {
          click: (e) => {
            e.stopPropagation();
            setSettingsOpen(!ui.settingsOpen);
          },
        },
      ),
      el(
        'button',
        'qh-top-close',
        [
          el('span', 'qh-top-close-icon', '✕'),
          el('span', 'qh-top-close-text', '关闭'),
        ],
        { type: 'button', title: '关闭任务情报板', 'aria-label': '关闭任务情报板' },
        { click: () => app.close() },
      ),
    ]),
  ]);

  const body = el('main', 'qh-body');
  const settingsLayer = buildSettingsLayer();
  const holoCorners = el('div', 'qh-holo-corners', null, { 'aria-hidden': 'true' });
  const holoVeil = el('div', 'qh-holo-veil', null, { 'aria-hidden': 'true' });

  room.append(topbar, body, settingsLayer, holoCorners, holoVeil);

  const toastNode = el('div', 'qh-toast');
  toastNode.style.position = 'absolute';
  toastNode.style.pointerEvents = 'none';

  shell.append(backdrop, room, toastNode);
  return shell;
}

function cancelClose() {
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

function shouldAnimateClose() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return (
    window.matchMedia('(min-width: 769px)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
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
    ui.settingsOpen = false;
    ui.entryMode = readEntryMode(host.readStorage);
    syncSettingsLayer();
    root.classList.add('qh-open');
    const room = root.querySelector('.qh-room');
    room.classList.remove('enter', 'leave');
    void room.offsetWidth;
    room.classList.add('enter');
    render();
    void refreshWorldbookStatus();
    void refreshLatestTag();
    const closeBtn = root.querySelector('.qh-top-close');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  },

  close() {
    if (!root || !root.classList.contains('qh-open') || root.classList.contains('qh-closing')) return;
    ui.confirmDeleteTrait = '';
    setSettingsOpen(false);
    const finish = () => {
      cancelClose();
      ui.questEditRewards = false;
      ui.confirmDeleteTrait = '';
      setSettingsOpen(false);
      root.classList.remove('qh-open');
      if (typeof app.onClose === 'function') app.onClose();
    };
    if (!shouldAnimateClose()) {
      finish();
      return;
    }
    const room = root.querySelector('.qh-room');
    if (!room) {
      finish();
      return;
    }
    root.classList.add('qh-closing');
    room.classList.remove('enter');
    void room.offsetWidth;
    room.classList.add('leave');

    const onEnd = (event) => {
      if (event.target !== room || event.animationName !== 'qh-holo-close') return;
      finish();
    };
    room.addEventListener('animationend', onEnd);
    closeCleanup = () => room.removeEventListener('animationend', onEnd);
    closeTimer = setTimeout(finish, 340);
  },

  refresh() {
    if (root && root.classList.contains('qh-open')) render();
  },

  hide() {
    if (!root) return;
    cancelClose();
    ui.questEditRewards = false;
    ui.confirmDeleteTrait = '';
    setSettingsOpen(false);
    root.classList.remove('qh-open');
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
  syncSettingsLayer();
  container.append(root);
  if (!mounted) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && root.classList.contains('qh-open')) {
        if (ui.settingsOpen) {
          setSettingsOpen(false);
          const settingsBtn = root.querySelector('.qh-top-settings');
          if (settingsBtn && settingsBtn.focus) settingsBtn.focus();
          return;
        }
        app.close();
      }
    });
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
