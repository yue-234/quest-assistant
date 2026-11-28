// 独立任务助手悬浮本（48×58 微缩立式牛皮冒险手账）
// 纯内联 SVG + CSS 绘制缝线书脊、暖米书页厚度、黄铜指南针星芒扣与可指示未读的绯红丝带书签。
// 支持自由拖拽、弱磁吸（SNAP_DISTANCE = 28）、按 xRatio/yRatio 记忆位置、visualViewport 安全边界与省电休眠。

const FAB_ID = 'quest-helper-fab';
const FAB_STYLE_ID = 'quest-helper-fab-style';
const STORAGE_KEY = 'quest_helper_fab_pos_v1';
const FAB_W = 48;
const FAB_H = 58;
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
  border: 0;
  border-radius: 6px 9px 9px 6px;
  background: transparent;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  overflow: visible;
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
  outline: 2px solid #ecd08b;
  outline-offset: 3px;
}
#${FAB_ID} .qh-fab-book {
  position: relative;
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 100%;
  border-radius: 5px 9px 9px 5px;
  background: linear-gradient(155deg, #4b301f 0%, #362013 54%, #22130b 100%);
  border: 1px solid rgba(207, 161, 84, 0.52);
  box-shadow:
    0 7px 18px rgba(14, 8, 4, 0.56),
    0 2px 5px rgba(14, 8, 4, 0.4),
    1px 1px 0 rgba(244, 214, 152, 0.22) inset,
    -2px 0 3px rgba(12, 6, 3, 0.45) inset;
  pointer-events: none;
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease;
}
#${FAB_ID}:hover .qh-fab-book {
  transform: translateY(-1px) scale(1.03);
  box-shadow:
    0 10px 22px rgba(14, 8, 4, 0.62),
    0 0 0 1px rgba(236, 208, 139, 0.35),
    1px 1px 0 rgba(255, 232, 178, 0.3) inset;
}
#${FAB_ID}:active:not(.is-dragging) .qh-fab-book {
  transform: scale(0.96);
  transition-duration: 70ms;
}
#${FAB_ID} .qh-fab-spine {
  position: relative;
  flex: 0 0 9px;
  border-radius: 4px 0 0 4px;
  background: linear-gradient(90deg, #1d1009 0%, #3a2316 55%, #1d1009 100%);
  border-right: 1px solid rgba(207, 161, 84, 0.28);
}
#${FAB_ID} .qh-fab-spine::after {
  content: "";
  position: absolute;
  top: 5px;
  bottom: 5px;
  left: 4px;
  width: 0;
  border-left: 1px dashed rgba(232, 198, 128, 0.52);
}
#${FAB_ID} .qh-fab-cover {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 4px 4px 2px;
  background:
    radial-gradient(110% 85% at 45% 22%, rgba(236, 208, 139, 0.14) 0%, rgba(236, 208, 139, 0) 68%),
    repeating-linear-gradient(125deg, rgba(255, 240, 210, 0.022) 0 2px, transparent 2px 5px);
}
#${FAB_ID} .qh-fab-cover::before,
#${FAB_ID} .qh-fab-cover::after {
  content: "";
  position: absolute;
  right: 2px;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid rgba(226, 185, 106, 0.72);
}
#${FAB_ID} .qh-fab-cover::before {
  top: 2px;
  border-top: 1.5px solid rgba(226, 185, 106, 0.72);
  border-top-right-radius: 4px;
}
#${FAB_ID} .qh-fab-cover::after {
  bottom: 2px;
  border-bottom: 1.5px solid rgba(226, 185, 106, 0.72);
  border-bottom-right-radius: 4px;
}
#${FAB_ID} .qh-fab-pages {
  position: relative;
  flex: 0 0 4px;
  margin: 3px 1px 3px 0;
  border-radius: 0 4px 4px 0;
  background: repeating-linear-gradient(
    90deg,
    #efe3c8 0 1px,
    #d5c098 1px 2px
  );
  box-shadow: -1px 0 1px rgba(24, 13, 6, 0.45);
}
#${FAB_ID} .qh-fab-clasp {
  display: block;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  filter: drop-shadow(0 1px 2px rgba(10, 5, 2, 0.72));
}
#${FAB_ID} .qh-fab-title {
  font-family: "PingFang SC", "Microsoft YaHei", "Songti SC", serif;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.14em;
  text-indent: 0.14em;
  color: #f3d99c;
  text-shadow: 0 1px 1px rgba(12, 6, 3, 0.9);
}
#${FAB_ID} .qh-fab-ribbon {
  position: absolute;
  top: -5px;
  right: 7px;
  z-index: 2;
  width: 11px;
  height: 15px;
  pointer-events: none;
  transform-origin: bottom center;
  transform: translateY(2px);
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), filter 220ms ease;
}
#${FAB_ID} .qh-fab-ribbon-svg {
  display: block;
  width: 100%;
  height: 100%;
}
#${FAB_ID} .qh-fab-ribbon-bead {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #ffdf9a 0%, #e04632 58%, #8f1d14 100%);
  border: 1px solid #2b170d;
  opacity: 0;
  transform: scale(0.4);
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
#${FAB_ID}.has-unread .qh-fab-ribbon {
  transform: translateY(-4px) scale(1.06);
  filter: drop-shadow(0 0 6px rgba(236, 170, 74, 0.85));
}
#${FAB_ID}.has-unread .qh-fab-ribbon-bead {
  opacity: 1;
  transform: scale(1);
}
#${FAB_ID}.has-unread:not(.is-paused):not(.is-hidden) .qh-fab-ribbon {
  animation: qh-fab-ribbon-glow 2.2s ease-in-out infinite;
}
#${FAB_ID}.has-unread:not(.is-paused):not(.is-hidden) .qh-fab-ribbon-bead {
  animation: qh-fab-bead-pulse 2.2s ease-in-out infinite;
}
@keyframes qh-fab-ribbon-glow {
  0%, 100% {
    transform: translateY(-4px) scale(1.06);
    filter: drop-shadow(0 0 5px rgba(236, 170, 74, 0.72));
  }
  50% {
    transform: translateY(-6px) scale(1.1);
    filter: drop-shadow(0 0 9px rgba(255, 198, 98, 0.96));
  }
}
@keyframes qh-fab-bead-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.72; transform: scale(1.22); }
}
@media (prefers-reduced-motion: reduce) {
  #${FAB_ID},
  #${FAB_ID} .qh-fab-book,
  #${FAB_ID} .qh-fab-ribbon,
  #${FAB_ID} .qh-fab-ribbon-bead {
    transition: none;
  }
  #${FAB_ID}.has-unread .qh-fab-ribbon,
  #${FAB_ID}.has-unread .qh-fab-ribbon-bead {
    animation: none;
  }
}
#${FAB_ID}.is-no-motion,
#${FAB_ID}.is-no-motion .qh-fab-book,
#${FAB_ID}.is-no-motion .qh-fab-ribbon,
#${FAB_ID}.is-no-motion .qh-fab-ribbon-bead {
  transition: none !important;
}
#${FAB_ID}.is-no-motion .qh-fab-ribbon,
#${FAB_ID}.is-no-motion .qh-fab-ribbon-bead {
  animation: none !important;
}
`;

const FAB_INNER_HTML = `
<span class="qh-fab-ribbon" aria-hidden="true">
  <svg class="qh-fab-ribbon-svg" viewBox="0 0 12 16" width="11" height="15" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="qh-fab-rib-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#c94032" />
        <stop offset="60%" stop-color="#a1291e" />
        <stop offset="100%" stop-color="#761a12" />
      </linearGradient>
    </defs>
    <path d="M1 1.5 C1 0.7 1.7 0.5 2.5 0.5 L9.5 0.5 C10.3 0.5 11 0.7 11 1.5 L11 15 L6 11.4 L1 15 Z"
      fill="url(#qh-fab-rib-grad)" stroke="#ecd08b" stroke-width="0.9" />
    <line x1="6" y1="1.5" x2="6" y2="9.8" stroke="rgba(246, 217, 149, 0.55)" stroke-width="0.7" />
  </svg>
  <span class="qh-fab-ribbon-bead"></span>
</span>
<span class="qh-fab-book" aria-hidden="true">
  <span class="qh-fab-spine"></span>
  <span class="qh-fab-cover">
    <svg class="qh-fab-clasp" viewBox="0 0 26 26" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="qh-fab-brass" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fff0c2" />
          <stop offset="48%" stop-color="#d7a44e" />
          <stop offset="100%" stop-color="#8b5d21" />
        </linearGradient>
        <linearGradient id="qh-fab-teal" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#5ec2c6" />
          <stop offset="100%" stop-color="#1d6b73" />
        </linearGradient>
      </defs>
      <circle cx="13" cy="13" r="10.2" fill="rgba(26, 15, 9, 0.65)" stroke="url(#qh-fab-brass)" stroke-width="1.4" />
      <circle cx="13" cy="13" r="7.2" fill="none" stroke="rgba(236, 208, 139, 0.45)" stroke-width="0.7" stroke-dasharray="1.8 1.8" />
      <polygon points="13,3.6 15.2,11 13,13 10.8,11" fill="url(#qh-fab-brass)" />
      <polygon points="13,22.4 15.2,15 13,13 10.8,15" fill="url(#qh-fab-teal)" />
      <polygon points="4,13 11,11.1 13,13 11,14.9" fill="#e6c37d" opacity="0.82" />
      <polygon points="22,13 15,11.1 13,13 15,14.9" fill="#e6c37d" opacity="0.82" />
      <circle cx="13" cy="13" r="1.8" fill="#2c190f" stroke="#fff0c2" stroke-width="0.9" />
    </svg>
    <span class="qh-fab-title">任务</span>
  </span>
  <span class="qh-fab-pages"></span>
</span>
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
    return { setHidden() {}, setUnread() {}, setMotionEnabled() {}, destroy() {} };
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
  btn.setAttribute('aria-label', '打开冒险手账与任务情报板');
  btn.setAttribute('title', '冒险手账 · 任务情报（点击打开，按住可拖动）');
  btn.innerHTML = FAB_INNER_HTML;
  doc.body.append(btn);

  let saved = loadSavedPos(win);
  let curX = 0;
  let curY = 0;

  const bounds = () => {
    const vv = win.visualViewport;
    const rawW = (vv && Number.isFinite(vv.width) && vv.width > 0)
      ? vv.width
      : (win.innerWidth || doc.documentElement.clientWidth || 360);
    const rawH = (vv && Number.isFinite(vv.height) && vv.height > 0)
      ? vv.height
      : (win.innerHeight || doc.documentElement.clientHeight || 640);
    const vw = Math.max(FAB_W + EDGE_MARGIN * 2, rawW);
    const vh = Math.max(FAB_H + TOP_SAFE + BOTTOM_SAFE, rawH);
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
    setMotionEnabled(enabled) {
      btn.classList.toggle('is-no-motion', !enabled);
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
