// 冒险手账辅助视图模块：公共 DOM 构建、待阅结案回执条、风物志（本区风物 + 世界余波剪报）与第一视角冒险日记。

export function el(tag, className, children, attrs, events) {
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

export function renderNoteCallout(textStr, tone = '') {
  const cls = tone === 'warn' ? ' is-warn' : tone === 'dim' ? ' is-dim' : '';
  return el('div', 'qh-note' + cls, [
    el('span', 'qh-note-icon', tone === 'warn' ? '!' : 'i'),
    el('span', 'qh-note-text', textStr),
  ]);
}

export function formatTraitCountdown(entry, compact = false) {
  if (!entry || !entry.isTemp) return '';
  if (entry.daysLeft === 0) return compact ? '今日' : '今日结束';
  if (typeof entry.daysLeft === 'number' && entry.daysLeft > 0) {
    return compact ? `剩${entry.daysLeft}天` : `剩 ${entry.daysLeft} 天`;
  }
  if (entry.until) return `至${entry.until}`;
  return '';
}

export function createCrestIcon() {
  const wrap = document.createElement('span');
  wrap.className = 'qh-crest-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="12" cy="12" r="9.4" fill="none" stroke="#cfa154" stroke-width="1.35" />' +
    '<circle cx="12" cy="12" r="6.2" fill="none" stroke="rgba(236,208,139,0.5)" stroke-width="0.7" stroke-dasharray="1.8 1.8" />' +
    '<polygon points="12,3.4 14,10.2 12,12 10,10.2" fill="#ecd08b" />' +
    '<polygon points="12,20.6 14,13.8 12,12 10,13.8" fill="#5ec2c6" />' +
    '<polygon points="3.8,12 10.2,10.3 12,12 10.2,13.7" fill="#cfa154" opacity="0.85" />' +
    '<polygon points="20.2,12 13.8,10.3 12,12 13.8,13.7" fill="#cfa154" opacity="0.85" />' +
    '<circle cx="12" cy="12" r="1.6" fill="#2c1a10" stroke="#fff1cc" stroke-width="0.8" />' +
    '</svg>';
  return wrap;
}

const OUTCOME_FALLBACK = {
  done: { label: '已完成', cls: 'is-done', glyph: '✓' },
  degraded: { label: '折损结案', cls: 'is-degraded', glyph: '✓' },
  failed: { label: '已失败', cls: 'is-failed', glyph: '✕' },
  abandoned: { label: '已放弃', cls: 'is-abandoned', glyph: '✕' },
};

function outcomeMeta(outcome, customLabel = '') {
  const key = String(outcome || '').trim().toLowerCase();
  const base = OUTCOME_FALLBACK[key] || { label: customLabel || '已结案', cls: 'is-done', glyph: '✓' };
  return {
    cls: base.cls,
    glyph: base.glyph,
    label: customLabel || base.label,
  };
}

function diaryOutcomeMeta(rawOutcome) {
  const text = String(rawOutcome || '').trim();
  if (!text) return null;
  if (/失败|错失|破产|覆灭|崩塌/.test(text)) return { cls: 'is-failed', text };
  if (/折损|止损|勉强|代价/.test(text)) return { cls: 'is-degraded', text };
  if (/放弃|撤离|中断/.test(text)) return { cls: 'is-abandoned', text };
  return { cls: 'is-done', text };
}

/** 渲染「待阅结案回执」区域；无回执时返回 null。 */
export function renderReceiptsStrip(receipts, { onDismiss, onJumpDiary } = {}) {
  const list = Array.isArray(receipts) ? receipts : [];
  if (list.length === 0) return null;

  const unreadCount = list.filter((r) => !r.read).length;
  const slot = el('section', 'qh-receipts-slot', [
    el('div', 'qh-receipts-head', [
      el('div', 'qh-receipts-title-wrap', [
        el('span', 'qh-receipts-wax', '印'),
        el('span', 'qh-receipts-title', '待阅结案回执'),
        el('span', 'qh-receipts-count', `${list.length} 份`),
        unreadCount > 0 ? el('span', 'qh-receipts-new', `${unreadCount} 新`) : null,
      ]),
      el('span', 'qh-receipts-hint', '下回合自动归档'),
    ]),
  ]);

  const cards = el('div', 'qh-receipts-list');
  list.forEach((r) => {
    const meta = outcomeMeta(r.outcome, r.outcomeLabel);
    const rewards = Array.isArray(r.rewards) ? r.rewards : [];
    const claimedCnt = rewards.filter((rw) => rw.claimed || rw.state === 'claimed').length;
    const lostCnt = rewards.filter((rw) => (!rw.claimed && rw.lost) || rw.state === 'lost').length;
    const hasDiary = typeof r.diaryIndex === 'number' && r.diaryIndex >= 0;

    const card = el('article', `qh-receipt-card ${meta.cls}${!r.read ? ' is-unread' : ''}`);
    const top = el('div', 'qh-receipt-top', [
      el('span', `qh-wax-stamp ${meta.cls}`, `${meta.glyph} ${meta.label}`),
      r.category ? el('span', 'qh-receipt-tag', r.category) : null,
      r.rank ? el('span', 'qh-receipt-tag', r.rank === '原版' ? '原版' : `${r.rank} 级`) : null,
      r.closedDay ? el('span', 'qh-receipt-day', r.closedDay) : null,
    ]);
    card.append(top);

    card.append(el('div', 'qh-receipt-name', r.displayTitle || r.title || '未命名委托'));
    if (r.reason) {
      card.append(el('p', 'qh-receipt-reason', r.reason));
    }

    if (rewards.length > 0) {
      const rwRow = el('div', 'qh-receipt-rewards');
      rewards.forEach((rw) => {
        const isClaimed = !!rw.claimed || rw.state === 'claimed';
        const isLost = !isClaimed && (!!rw.lost || rw.state === 'lost');
        const mark = isClaimed ? '✓' : (isLost ? '✕' : '□');
        const cls = isClaimed ? 'is-claimed' : (isLost ? 'is-lost' : 'is-open');
        rwRow.append(
          el('span', `qh-receipt-rw ${cls}`, [
            el('span', 'qh-receipt-rw-mark', mark),
            el('span', 'qh-receipt-rw-txt', rw.text || `收益 ${rw.slot || ''}`),
          ]),
        );
      });
      card.append(rwRow);
    } else if (claimedCnt > 0 || lostCnt > 0) {
      card.append(
        el('div', 'qh-receipt-rw-summary', `收益结算：兑现 ${claimedCnt} · 错失 ${lostCnt}`),
      );
    }

    const actions = el('div', 'qh-receipt-actions');
    if (hasDiary && typeof onJumpDiary === 'function') {
      actions.append(
        el(
          'button',
          'qh-link-btn qh-receipt-diary-btn',
          '翻阅手账日记 ↗',
          { type: 'button' },
          { click: () => onJumpDiary(r.diaryIndex) },
        ),
      );
    }
    if (typeof onDismiss === 'function') {
      actions.append(
        el(
          'button',
          'qh-btn qh-btn--xs qh-btn--paper qh-receipt-dismiss',
          '收起',
          { type: 'button', title: '确认已阅并立即移出待阅区' },
          { click: () => onDismiss(r.id) },
        ),
      );
    }
    card.append(actions);
    cards.append(card);
  });

  slot.append(cards);
  return slot;
}

/** 渲染单条风物/余波词条，支持墨水圆章、限时倒计时与修改模式两步删除。 */
function renderAftermathEntry(entry, kind, { editMode, confirmDeleteTrait, onToggleConfirm, onDeleteTrait }) {
  const traitUid = `${kind}:${entry.key}:${entry.index}:${entry.text}`;
  const confirming = !!(editMode && confirmDeleteTrait === traitUid);
  const tone = entry.tone || '';
  const toneCls = tone ? ` is-${tone}` : '';
  const ttlText = formatTraitCountdown(entry, false);
  const bodyText = entry.tag ? entry.body : (entry.body || entry.text);

  const item = el(
    'article',
    (kind === 'world' ? 'qh-clipping-card' : 'qh-lore-note') +
      toneCls +
      (entry.isTemp ? ' is-temp' : '') +
      (confirming ? ' is-confirming' : ''),
  );

  const head = el('div', 'qh-lore-item-head');
  const sealWrap = el('div', 'qh-lore-seals');
  if (entry.tag) {
    sealWrap.append(el('span', `qh-ink-seal${toneCls}`, entry.tag));
  } else {
    sealWrap.append(
      el(
        'span',
        `qh-ink-seal${toneCls}`,
        kind === 'world' ? '快报' : (entry.isTemp ? '限时' : '风物'),
      ),
    );
  }
  if (ttlText) {
    sealWrap.append(
      el('span', 'qh-lore-ttl' + (entry.daysLeft === 0 ? ' is-urgent' : ''), `⏳ ${ttlText}`, {
        title: entry.until ? `有效期至 ${entry.until}` : '',
      }),
    );
  }
  head.append(sealWrap);

  if (editMode) {
    const acts = el('div', 'qh-trait-actions');
    if (confirming) {
      acts.append(
        el(
          'button',
          'qh-trait-btn is-confirm',
          '确认删除',
          { type: 'button' },
          { click: () => onDeleteTrait?.(entry) },
        ),
        el(
          'button',
          'qh-trait-btn is-cancel',
          '取消',
          { type: 'button' },
          { click: () => onToggleConfirm?.('') },
        ),
      );
    } else {
      acts.append(
        el(
          'button',
          'qh-trait-btn is-delete',
          '删除',
          { type: 'button' },
          { click: () => onToggleConfirm?.(traitUid) },
        ),
      );
    }
    head.append(acts);
  }

  item.append(head);
  if (bodyText) {
    item.append(el('p', 'qh-lore-body', bodyText));
  }
  return item;
}

/** 渲染「风物志」双页（PC：左页本区风物 / 右页世界余波剪报；Mobile：纵向叠排）。 */
export function renderLoreView(
  qb,
  {
    regionDisplay = '未识别区域',
    editMode = false,
    canEditMode = false,
    confirmDeleteTrait = '',
    compact = false,
    onToggleEditMode,
    onToggleConfirm,
    onDeleteTrait,
  } = {},
) {
  const localEntries = Array.isArray(qb?.aftermath?.localEntries) ? qb.aftermath.localEntries : [];
  const worldEntries = Array.isArray(qb?.aftermath?.worldEntries) ? qb.aftermath.worldEntries : [];

  const buildLocalSection = () => {
    const perm = localEntries.filter((e) => !e.isTemp);
    const temp = localEntries.filter((e) => e.isTemp);
    const section = el('div', 'qh-lore-section');

    const head = el('div', 'qh-sheet-head', [
      el('div', 'qh-sheet-head-main', [
        el('div', 'qh-sheet-kicker', 'LOCAL CHRONICLE · 本区风物'),
        el('h2', 'qh-sheet-title', `${regionDisplay} · 城邦见闻`),
      ]),
      el('div', 'qh-sheet-head-right', [
        el('span', 'qh-sheet-badge', `${localEntries.length} 条`),
        canEditMode
          ? el(
              'button',
              'qh-quest-edit-toggle' + (editMode ? ' is-on' : ''),
              editMode ? '✓ 完成修改' : '✎ 修改模式',
              { type: 'button', title: editMode ? '退出修改模式' : '开启后可删除过时或误记的风物词条' },
              { click: () => onToggleEditMode?.() },
            )
          : null,
      ]),
    ]);
    section.append(head);

    if (localEntries.length === 0) {
      section.append(
        el('div', 'qh-parchment-empty', [
          el('div', 'qh-parchment-empty-seal', '风'),
          el('div', 'qh-parchment-empty-title', '此地尚未留下风物记事'),
          el(
            'p',
            'qh-parchment-empty-desc',
            '随本区委托推进、庆典异动或局势演化，常驻城邦印象与限时事件便签会自动收录至此页。',
          ),
        ]),
      );
      return section;
    }

    if (temp.length > 0) {
      section.append(el('div', 'qh-subhead', `限时活动与近期异动（${temp.length}）`));
      const tempList = el('div', 'qh-lore-list');
      temp.forEach((entry) => {
        tempList.append(
          renderAftermathEntry(entry, 'local', {
            editMode,
            confirmDeleteTrait,
            onToggleConfirm,
            onDeleteTrait,
          }),
        );
      });
      section.append(tempList);
    }

    if (perm.length > 0) {
      section.append(el('div', 'qh-subhead', `地区常驻词条与余波（${perm.length}）`));
      const permList = el('div', 'qh-lore-list');
      perm.forEach((entry) => {
        permList.append(
          renderAftermathEntry(entry, 'local', {
            editMode,
            confirmDeleteTrait,
            onToggleConfirm,
            onDeleteTrait,
          }),
        );
      });
      section.append(permList);
    }

    return section;
  };

  const buildWorldSection = () => {
    const section = el('div', 'qh-lore-section');
    section.append(
      el('div', 'qh-sheet-head', [
        el('div', 'qh-sheet-head-main', [
          el('div', 'qh-sheet-kicker', 'CONTINENTAL DISPATCH · 世界剪报'),
          el('h2', 'qh-sheet-title', '全大陆重大余波'),
        ]),
        el('span', 'qh-sheet-badge is-world', `${worldEntries.length} 篇`),
      ]),
    );

    if (worldEntries.length === 0) {
      section.append(
        el('div', 'qh-parchment-empty', [
          el('div', 'qh-parchment-empty-seal is-world', '闻'),
          el('div', 'qh-parchment-empty-title', '大陆局势尚无重大剪报'),
          el(
            'p',
            'qh-parchment-empty-desc',
            '跨越区域的重大战役、势力更迭与深远余波，将以剪报快讯的形式贴存到右页备查。',
          ),
        ]),
      );
      return section;
    }

    const list = el('div', 'qh-clipping-list');
    worldEntries.forEach((entry) => {
      list.append(
        renderAftermathEntry(entry, 'world', {
          editMode,
          confirmDeleteTrait,
          onToggleConfirm,
          onDeleteTrait,
        }),
      );
    });
    section.append(list);
    return section;
  };

  if (compact) {
    return el('div', 'qh-mobile-scroll qh-pocket-lore', [
      buildLocalSection(),
      buildWorldSection(),
    ]);
  }

  return el('div', 'qh-spread qh-spread--lore', [
    el('section', 'qh-page-sheet qh-page-left', [buildLocalSection()]),
    el('div', 'qh-spine-crease', null, { 'aria-hidden': 'true' }),
    el('section', 'qh-page-sheet qh-page-right', [buildWorldSection()]),
  ]);
}

/** 渲染「冒险日记」页（PC 双页目录+正文；Mobile 单卡翻阅+目录抽屉）。 */
export function renderDiaryView(
  qb,
  {
    selectedIndex = -1,
    compact = false,
    mobileIndexOpen = false,
    onSelectIndex,
    onToggleMobileIndex,
  } = {},
) {
  const entries = Array.isArray(qb?.diaryEntries) ? qb.diaryEntries : [];
  const total = entries.length;

  if (total === 0) {
    const emptyLeft = el('div', 'qh-parchment-empty qh-diary-empty', [
      el('div', 'qh-parchment-empty-seal is-diary', '记'),
      el('div', 'qh-parchment-empty-title', '冒险日记本尚为空白'),
      el(
        'p',
        'qh-parchment-empty-desc',
        '当委托尘埃落定或遭遇重大转折时，系统将以你的第一人称视角落笔成篇，并自动归档于此，供随时翻阅重温。',
      ),
    ]);
    const emptyRight = el('div', 'qh-diary-preface', [
      el('div', 'qh-sheet-kicker', 'ADVENTURER HAND-JOURNAL · 扉页说明'),
      el('h2', 'qh-sheet-title', '每一段旅途都值得留痕'),
      el(
        'p',
        'qh-diary-preface-p',
        '• 只记亲历细节、私下评价与心境起伏，不与冷冰冰的客观战报重复。',
      ),
      el(
        'p',
        'qh-diary-preface-p',
        '• 若旧案在数十回合后掀出余震后续，续篇会自动追加到同一篇日记下方，前后呼应。',
      ),
      el(
        'p',
        'qh-diary-preface-p',
        '• 已归档的历史手账仅保存在本地楼层状态中，供手账界面随时翻阅，不会占用后续对话上下文。',
      ),
    ]);
    if (compact) {
      return el('div', 'qh-mobile-scroll qh-pocket-diary', [emptyLeft, emptyRight]);
    }
    return el('div', 'qh-spread qh-spread--diary', [
      el('section', 'qh-page-sheet qh-page-left', [emptyLeft]),
      el('div', 'qh-spine-crease', null, { 'aria-hidden': 'true' }),
      el('section', 'qh-page-sheet qh-page-right', [emptyRight]),
    ]);
  }

  let activePos = entries.findIndex((e, idx) => (typeof e.index === 'number' ? e.index : idx) === selectedIndex);
  if (activePos < 0) activePos = total - 1;
  const activeEntry = entries[activePos];
  const prevEntry = activePos > 0 ? entries[activePos - 1] : null;
  const nextEntry = activePos < total - 1 ? entries[activePos + 1] : null;

  const entryKeyOf = (entry, pos) => (typeof entry.index === 'number' ? entry.index : pos);

  const buildIndexList = () => {
    const list = el('div', 'qh-diary-index-list');
    // 最新归档排在上方，便于第一时间翻阅
    for (let pos = total - 1; pos >= 0; pos -= 1) {
      const entry = entries[pos];
      const idxVal = entryKeyOf(entry, pos);
      const isSelected = pos === activePos;
      const out = diaryOutcomeMeta(entry.outcome);
      const sequels = Array.isArray(entry.sequels) ? entry.sequels : [];

      const row = el(
        'button',
        'qh-diary-index-item' + (isSelected ? ' is-selected' : ''),
        [
          el('div', 'qh-diary-index-top', [
            el('span', 'qh-diary-index-no', `No.${String(pos + 1).padStart(2, '0')}`),
            entry.date ? el('span', 'qh-diary-index-date', entry.date) : null,
            entry.region ? el('span', 'qh-diary-index-region', entry.region) : null,
          ]),
          el('div', 'qh-diary-index-title', entry.displayTitle || entry.title || '无题随笔'),
          el('div', 'qh-diary-index-foot', [
            out ? el('span', `qh-wax-mini ${out.cls}`, out.text) : null,
            entry.mood ? el('span', 'qh-diary-mood-chip', entry.mood) : null,
            sequels.length > 0 ? el('span', 'qh-diary-seq-chip', `+${sequels.length} 续篇`) : null,
          ]),
        ],
        {
          type: 'button',
          'aria-current': isSelected ? 'true' : 'false',
        },
        {
          click: () => onSelectIndex?.(idxVal),
        },
      );
      list.append(row);
    }
    return list;
  };

  const buildEntryPage = () => {
    const out = diaryOutcomeMeta(activeEntry.outcome);
    const sequels = Array.isArray(activeEntry.sequels) ? activeEntry.sequels : [];
    const page = el('article', 'qh-diary-entry');

    const metaRow = el('div', 'qh-diary-meta-row', [
      activeEntry.date ? el('span', 'qh-diary-meta-pill', activeEntry.date) : null,
      activeEntry.region ? el('span', 'qh-diary-meta-pill is-region', activeEntry.region) : null,
      activeEntry.category ? el('span', 'qh-diary-meta-pill', activeEntry.category) : null,
      out ? el('span', `qh-wax-stamp ${out.cls}`, out.text) : null,
      activeEntry.mood ? el('span', 'qh-diary-mood-stamp', `心境 · ${activeEntry.mood}`) : null,
    ]);
    page.append(metaRow);

    page.append(el('h2', 'qh-diary-entry-title', activeEntry.displayTitle || activeEntry.title || '无题随笔'));

    const bodyText = String(activeEntry.body || '').trim();
    const bodyWrap = el('div', 'qh-diary-body');
    if (bodyText) {
      bodyText.split(/\r?\n+/).forEach((para) => {
        const cleaned = para.trim();
        if (cleaned) bodyWrap.append(el('p', 'qh-diary-para', cleaned));
      });
    } else {
      bodyWrap.append(el('p', 'qh-diary-para is-muted', '（此页尚未写下正文）'));
    }
    page.append(bodyWrap);

    if (activeEntry.note) {
      page.append(
        el('aside', 'qh-diary-margin-note', [
          el('span', 'qh-diary-margin-label', '页边角注'),
          el('p', 'qh-diary-margin-text', activeEntry.note),
        ]),
      );
    }

    if (sequels.length > 0) {
      const seqWrap = el('div', 'qh-diary-sequels');
      sequels.forEach((sq, sIdx) => {
        const sqCard = el('section', 'qh-diary-sequel', [
          el('div', 'qh-diary-sequel-head', [
            el('span', 'qh-diary-sequel-stamp', sq.tag || `续篇 ${sIdx + 1}`),
            sq.date ? el('span', 'qh-diary-sequel-date', sq.date) : null,
            sq.mood ? el('span', 'qh-diary-mood-chip', sq.mood) : null,
          ]),
        ]);
        const sqBody = el('div', 'qh-diary-sequel-body');
        String(sq.body || '')
          .trim()
          .split(/\r?\n+/)
          .forEach((p) => {
            const c = p.trim();
            if (c) sqBody.append(el('p', 'qh-diary-para', c));
          });
        sqCard.append(sqBody);
        seqWrap.append(sqCard);
      });
      page.append(seqWrap);
    }

    const pager = el('div', 'qh-diary-pager', [
      el(
        'button',
        'qh-btn qh-btn--sm qh-btn--paper',
        '← 上一篇',
        { type: 'button', disabled: !prevEntry },
        { click: () => prevEntry && onSelectIndex?.(entryKeyOf(prevEntry, activePos - 1)) },
      ),
      el('span', 'qh-diary-pager-num', `第 ${activePos + 1} / ${total} 篇`),
      el(
        'button',
        'qh-btn qh-btn--sm qh-btn--paper',
        '下一篇 →',
        { type: 'button', disabled: !nextEntry },
        { click: () => nextEntry && onSelectIndex?.(entryKeyOf(nextEntry, activePos + 1)) },
      ),
    ]);
    page.append(pager);
    return page;
  };

  if (compact) {
    const topBar = el('div', 'qh-diary-mobile-bar', [
      el(
        'button',
        'qh-btn qh-btn--sm qh-btn--paper' + (mobileIndexOpen ? ' is-active' : ''),
        mobileIndexOpen ? '收起目录 ▴' : `目录（${total} 篇）▾`,
        { type: 'button', 'aria-expanded': mobileIndexOpen ? 'true' : 'false' },
        { click: () => onToggleMobileIndex?.() },
      ),
      el('div', 'qh-diary-mobile-nav', [
        el(
          'button',
          'qh-btn qh-btn--xs qh-btn--paper',
          '←',
          { type: 'button', disabled: !prevEntry, 'aria-label': '上一篇' },
          { click: () => prevEntry && onSelectIndex?.(entryKeyOf(prevEntry, activePos - 1)) },
        ),
        el('span', 'qh-diary-mobile-pos', `${activePos + 1}/${total}`),
        el(
          'button',
          'qh-btn qh-btn--xs qh-btn--paper',
          '→',
          { type: 'button', disabled: !nextEntry, 'aria-label': '下一篇' },
          { click: () => nextEntry && onSelectIndex?.(entryKeyOf(nextEntry, activePos + 1)) },
        ),
      ]),
    ]);
    return el('div', 'qh-mobile-scroll qh-pocket-diary', [
      topBar,
      mobileIndexOpen ? el('div', 'qh-diary-mobile-drawer', [buildIndexList()]) : null,
      buildEntryPage(),
    ]);
  }

  return el('div', 'qh-spread qh-spread--diary', [
    el('section', 'qh-page-sheet qh-page-left', [
      el('div', 'qh-sheet-head', [
        el('div', 'qh-sheet-head-main', [
          el('div', 'qh-sheet-kicker', 'HAND-JOURNAL INDEX · 手账目录'),
          el('h2', 'qh-sheet-title', '冒险日记归档'),
        ]),
        el('span', 'qh-sheet-badge', `${total} 篇`),
      ]),
      buildIndexList(),
    ]),
    el('div', 'qh-spine-crease', null, { 'aria-hidden': 'true' }),
    el('section', 'qh-page-sheet qh-page-right', [buildEntryPage()]),
  ]);
}
