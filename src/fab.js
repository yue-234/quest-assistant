// 独立任务助手悬浮球（60×48 深空蓝 + 金边微方徽章）
// 纯几何 SVG 绘制指南针星标与「任务」字标，底部青金/琥珀细饰条，右上角未读脉冲红点。
// 支持自由拖拽、弱磁吸（SNAP_DISTANCE = 28）、按 xRatio/yRatio 记忆位置与省电休眠。

const FAB_ID = 'quest-helper-fab';
const FAB_STYLE_ID = 'quest-helper-fab-style';
const STORAGE_KEY = 'quest_helper_fab_pos_v1';
const FAB_W = 60;
const FAB_H = 48;
const EDGE_MARGIN = 10;
const SNAP_DISTANCE = 28;
const TOP_SAFE = 56;
const BOTTOM_SAFE = 72;
const DRAG_THRESHOLD = 6;
const DEFAULT_Y_RATIO = 0.45;

const FAB_CSS = `
#${FAB_ID} {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9984;
  display: inline-flex;
  align-items: stretch;
  justify-content: stretch;
  width: ${FAB_W}px;
  height: ${FAB_H}px;
  padding: 0;
  margin: 0;
  border: 1px solid rgba(240, 185, 76, 0.44);
  border-radius: 13px;
  background: transparent;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  box-shadow:
    0 6px 16px rgba(3, 9, 18, 0.56),
    0 1px 0 rgba(255, 244, 206, 0.22) inset;
  will-change: transform;
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease;
}
#${FAB_ID}.is-dragging {
  cursor: grabbing;
  transition: none !important;
}
#${FAB_ID}.is-hidden {
  opacity: 0;
  pointer-events: none;
}
#${FAB_ID}:focus-visible {
  outline: 2px solid #ffc757;
  outline-offset: 2px;
}
#${FAB_ID} .qh-fab-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  border-radius: 12px;
  overflow: hidden;
  background: #091424;
  pointer-events: none;
}
#${FAB_ID} .qh-fab-stage {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 4px;
  background:
    radial-gradient(115% 85% at 50% 0%, rgba(112, 178, 240, 0.25) 0%, rgba(112, 178, 240, 0) 68%),
    linear-gradient(170deg, #18304d 0%, #0f1f36 58%, #081221 100%);
}
#${FAB_ID} .qh-fab-stage::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 44%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0) 100%);
}
#${FAB_ID} .qh-fab-stage::after {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(
    90% 90% at 50% 35%,
    rgba(255, 232, 168, 0.22) 0%,
    rgba(72, 206, 184, 0.12) 56%,
    rgba(255, 255, 255, 0) 100%
  );
  opacity: 0;
  transition: opacity 180ms ease-out;
}
#${FAB_ID}:hover .qh-fab-stage::after {
  opacity: 1;
}
#${FAB_ID} .qh-fab-emblem {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
#${FAB_ID}:hover .qh-fab-emblem {
  transform: scale(1.04);
}
#${FAB_ID}:active:not(.is-dragging) .qh-fab-emblem {
  transform: scale(0.95);
  transition-duration: 70ms;
}
#${FAB_ID} .qh-fab-icon {
  display: block;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
#${FAB_ID} .qh-fab-label {
  font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #ffe8ad;
  text-shadow: 0 1px 2px rgba(4, 10, 20, 0.85);
}
#${FAB_ID} .qh-fab-bar {
  position: relative;
  flex: 0 0 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-top: 1px solid rgba(255, 218, 146, 0.38);
  background: linear-gradient(90deg, #1b5c6e 0%, #2a7c82 48%, #c9861e 100%);
}
#${FAB_ID} .qh-fab-dot {
  width: 3.5px;
  height: 3.5px;
  border-radius: 50%;
  background: #fff3d1;
  box-shadow: 0 0 0 1px rgba(255, 214, 128, 0.45);
  flex-shrink: 0;
}
#${FAB_ID} .qh-fab-tag {
  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 6.8px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.14em;
  color: #fdf6e4;
  text-indent: 0.14em;
}
#${FAB_ID} .qh-fab-unread {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid #0b1626;
  background: linear-gradient(135deg, #ff7a59 0%, #e02424 100%);
  opacity: 0;
  transform: scale(0.5);
  pointer-events: none;
  transition: opacity 180ms ease-out, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
#${FAB_ID} .qh-fab-unread::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1.5px solid #ff7a59;
  opacity: 0;
  transform: scale(0.85);
}
#${FAB_ID}.has-unread .qh-fab-unread {
  opacity: 1;
  transform: scale(1);
}
#${FAB_ID}.has-unread:not(.is-paused):not(.is-hidden) .qh-fab-unread::after {
  animation: qh-fab-unread-ring 2s cubic-bezier(0.2, 0.7, 0.3, 1) infinite;
}
#${FAB_ID}.has-unread:not(.is-paused):not(.is-hidden) .qh-fab-dot {
  animation: qh-fab-dot-pulse 1.5s ease-in-out infinite;
}
@keyframes qh-fab-unread-ring {
  0% { opacity: 0.85; transform: scale(0.9); }
  70%, 100% { opacity: 0; transform: scale(2.1); }
}
@keyframes qh-fab-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}
@media (prefers-reduced-motion: reduce) {
  #${FAB_ID}, #${FAB_ID} .qh-fab-emblem, #${FAB_ID} .qh-fab-stage::after, #${FAB_ID} .qh-fab-unread {
    transition: none;
  }
  #${FAB_ID}.has-unread .qh-fab-unread::after,
  #${FAB_ID}.has-unread .qh-fab-dot {
    animation: none;
  }
}
`;

const FAB_INNER_HTML = `
<span class="qh-fab-shell" aria-hidden="true">
  <span class="qh-fab-stage">
    <span class="qh-fab-emblem">
      <svg class="qh-fab-icon" viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="qh-fab-gold" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#fff4cc" />
            <stop offset="48%" stop-color="#ffc757" />
            <stop offset="100%" stop-color="#d98718" />
          </linearGradient>
          <linearGradient id="qh-fab-teal" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#8cf0df" />
            <stop offset="100%" stop-color="#2fd19f" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r="9.2" fill="none" stroke="url(#qh-fab-gold)" stroke-width="1.35" opacity="0.9" />
        <circle cx="12" cy="12" r="6.4" fill="none" stroke="#6eb5ff" stroke-width="0.7" stroke-dasharray="2 2" opacity="0.55" />
        <polygon points="12,3.2 14.3,10.2 12,12 9.7,10.2" fill="url(#qh-fab-gold)" />
        <polygon points="12,20.8 14.3,13.8 12,12 9.7,13.8" fill="url(#qh-fab-teal)" opacity="0.92" />
        <polygon points="3.6,12 10.2,10.3 12,12 10.2,13.7" fill="#9bc9ff" opacity="0.78" />
        <polygon points="20.4,12 13.8,10.3 12,12 13.8,13.7" fill="#9bc9ff" opacity="0.78" />
        <circle cx="12" cy="12" r="1.6" fill="#091424" stroke="#fff4cc" stroke-width="0.9" />
      </svg>
      <span class="qh-fab-label">任务</span>
    </span>
  </span>
  <span class="qh-fab-bar">
    <span class="qh-fab-dot"></span>
    <span class="qh-fab-tag">QUEST</span>
  </span>
</span>
<span class="qh-fab-unread" aria-hidden="true"></span>
`;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function loadSavedPos(win) {
  try {
    const raw = win.localStorage && win.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { xRatio: 1, yRatio: DEFAULT_Y_RATIO };
    const parsed = JSON.parse(raw);
    const yRatio = typeof parsed?.yRatio === 'number' && Number.isFinite(parsed.yRatio)
      ? clamp(parsed.yRatio, 0, 1)
      : DEFAULT_Y_RATIO;
    if (typeof parsed?.xRatio === 'number' && Number.isFinite(parsed.xRatio)) {
      return { xRatio: clamp(parsed.xRatio, 0, 1), yRatio };
    }
    return { xRatio: parsed && parsed.side === 'left' ? 0 : 1, yRatio };
  } catch {
    return { xRatio: 1, yRatio: DEFAULT_Y_RATIO };
  }
}

function savePos(win, pos) {
  try {
    win.localStorage?.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* 忽略 */
  }
}

export function mountFab(doc, win, { onOpen } = {}) {
  if (!doc || !doc.body || !doc.head) {
    return { setHidden() {}, setUnread() {}, destroy() {} };
  }

  doc.getElementById(FAB_ID)?.remove();
  doc.getElementById(FAB_STYLE_ID)?.remove();

  const style = doc.createElement('style');
  style.id = FAB_STYLE_ID;
  style.textContent = FAB_CSS;
  doc.head.append(style);

  const btn = doc.createElement('button');
  btn.id = FAB_ID;
  btn.type = 'button';
  btn.setAttribute('aria-label', '打开任务情报板');
  btn.setAttribute('title', '任务情报板（点击打开，按住可拖动）');
  btn.innerHTML = FAB_INNER_HTML;
  doc.body.append(btn);

  let saved = loadSavedPos(win);
  let curX = 0;
  let curY = 0;

  const bounds = () => {
    const vw = Math.max(FAB_W + EDGE_MARGIN * 2, win.innerWidth || doc.documentElement.clientWidth || 360);
    const vh = Math.max(FAB_H + TOP_SAFE + BOTTOM_SAFE, win.innerHeight || doc.documentElement.clientHeight || 640);
    const minY = Math.min(TOP_SAFE, Math.max(EDGE_MARGIN, vh - FAB_H - EDGE_MARGIN));
    const maxY = Math.max(minY, vh - FAB_H - BOTTOM_SAFE);
    return { vw, vh, minX: EDGE_MARGIN, maxX: Math.max(EDGE_MARGIN, vw - FAB_W - EDGE_MARGIN), minY, maxY };
  };

  const applyPos = (x, y) => {
    curX = Math.round(x);
    curY = Math.round(y);
    btn.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
  };

  const placeFromSaved = () => {
    const b = bounds();
    const x = b.minX + (b.maxX - b.minX) * saved.xRatio;
    const y = b.minY + (b.maxY - b.minY) * saved.yRatio;
    applyPos(clamp(x, b.minX, b.maxX), clamp(y, b.minY, b.maxY));
  };

  placeFromSaved();

  let pointerId = null;
  let startClientX = 0;
  let startClientY = 0;
  let originX = 0;
  let originY = 0;
  let dragged = false;

  const onPointerMove = (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startClientX;
    const dy = e.clientY - startClientY;
    if (!dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      dragged = true;
      btn.classList.add('is-dragging');
    }
    if (!dragged) return;
    const b = bounds();
    applyPos(
      clamp(originX + dx, EDGE_MARGIN, b.maxX),
      clamp(originY + dy, EDGE_MARGIN, Math.max(EDGE_MARGIN, b.vh - FAB_H - EDGE_MARGIN)),
    );
  };

  const finishDrag = (e, cancelled = false) => {
    if (e.pointerId !== pointerId) return;
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('pointercancel', onPointerCancel);
    try {
      btn.releasePointerCapture(pointerId);
    } catch {
      /* 忽略 */
    }
    const wasDragged = dragged;
    pointerId = null;
    dragged = false;
    btn.classList.remove('is-dragging');

    if (wasDragged) {
      const b = bounds();
      let finalX = clamp(curX, b.minX, b.maxX);
      if (finalX - b.minX <= SNAP_DISTANCE) finalX = b.minX;
      else if (b.maxX - finalX <= SNAP_DISTANCE) finalX = b.maxX;
      const finalY = clamp(curY, b.minY, b.maxY);
      const spanX = Math.max(1, b.maxX - b.minX);
      const spanY = Math.max(1, b.maxY - b.minY);
      saved = {
        xRatio: clamp((finalX - b.minX) / spanX, 0, 1),
        yRatio: clamp((finalY - b.minY) / spanY, 0, 1),
      };
      savePos(win, saved);
      applyPos(finalX, finalY);
    } else if (!cancelled && typeof onOpen === 'function') {
      onOpen();
    }
  };

  const onPointerUp = (e) => finishDrag(e, false);
  const onPointerCancel = (e) => finishDrag(e, true);

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    startClientX = e.clientX;
    startClientY = e.clientY;
    originX = curX;
    originY = curY;
    dragged = false;
    try {
      btn.setPointerCapture(pointerId);
    } catch {
      /* 忽略 */
    }
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    win.addEventListener('pointercancel', onPointerCancel);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (typeof onOpen === 'function') onOpen();
    }
  };

  const onResize = () => {
    if (dragged) return;
    placeFromSaved();
  };

  const onVisibility = () => {
    btn.classList.toggle('is-paused', !!doc.hidden);
  };

  btn.addEventListener('pointerdown', onPointerDown);
  btn.addEventListener('keydown', onKeyDown);
  win.addEventListener('resize', onResize);
  win.visualViewport?.addEventListener('resize', onResize);
  doc.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return {
    setHidden(hidden) {
      btn.classList.toggle('is-hidden', !!hidden);
    },
    setUnread(unread) {
      btn.classList.toggle('has-unread', !!unread);
    },
    destroy() {
      btn.removeEventListener('pointerdown', onPointerDown);
      btn.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerup', onPointerUp);
      win.removeEventListener('pointercancel', onPointerCancel);
      win.removeEventListener('resize', onResize);
      win.visualViewport?.removeEventListener('resize', onResize);
      doc.removeEventListener('visibilitychange', onVisibility);
      btn.remove();
      style.remove();
    },
  };
}
