// SillyTavern「魔法棒（扩展程序）」菜单入口挂载器。
// 负责在 #extensionsMenu 中挂载「任务情报」菜单项、同步未读红点与监听延迟挂载。

const WAND_ITEM_ID = 'quest-helper-wand-item';
const WAND_STYLE_ID = 'quest-helper-wand-style';
const WAND_MENU_ID = 'extensionsMenu';
const WAND_TRIGGER_ID = 'extensionsMenuButton';

const WAND_CSS = `
#${WAND_ITEM_ID} {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
#${WAND_ITEM_ID} .qh-wand-label {
  flex: 1 1 auto;
  min-width: 0;
}
#${WAND_ITEM_ID} .qh-wand-unread {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: linear-gradient(135deg, #ff7a59 0%, #e02424 100%);
  box-shadow: 0 0 6px rgba(255, 122, 89, 0.72);
  opacity: 0;
  transform: scale(0.6);
  pointer-events: none;
  transition: opacity 180ms ease, transform 180ms ease;
}
#${WAND_ITEM_ID}.has-unread .qh-wand-unread {
  opacity: 1;
  transform: scale(1);
}
`;

function hideExtensionsMenu(doc, win) {
  const menu = doc.getElementById(WAND_MENU_ID);
  if (!menu) return;
  try {
    const display = win?.getComputedStyle?.(menu)?.display ?? menu.style.display;
    if (display === 'none') return;
    if (typeof win?.jQuery === 'function') {
      win.jQuery(menu).hide();
    } else {
      menu.style.display = 'none';
    }
  } catch {
    menu.style.display = 'none';
  }
}

export function mountWand(doc, win, { onOpen } = {}) {
  if (!doc || !doc.body || !doc.head) {
    return { setHidden() {}, setUnread() {}, destroy() {} };
  }

  doc.getElementById(WAND_ITEM_ID)?.remove();
  doc.getElementById(WAND_STYLE_ID)?.remove();

  const style = doc.createElement('style');
  style.id = WAND_STYLE_ID;
  style.textContent = WAND_CSS;
  doc.head.append(style);

  let destroyed = false;
  let currentUnread = false;
  let itemEl = null;
  let observer = null;

  const triggerOpen = () => {
    if (destroyed) return;
    hideExtensionsMenu(doc, win);
    if (typeof onOpen === 'function') onOpen();
  };

  const buildItem = () => {
    const item = doc.createElement('div');
    item.id = WAND_ITEM_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', '打开任务情报板');
    item.setAttribute('title', '打开任务情报板');

    const icon = doc.createElement('i');
    icon.className = 'fa-solid fa-compass extensionsMenuExtensionButton';
    icon.setAttribute('aria-hidden', 'true');

    const label = doc.createElement('span');
    label.className = 'qh-wand-label';
    label.textContent = '任务情报';

    const dot = doc.createElement('span');
    dot.className = 'qh-wand-unread';
    dot.setAttribute('aria-hidden', 'true');

    item.append(icon, label, dot);
    item.classList.toggle('has-unread', currentUnread);

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerOpen();
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        triggerOpen();
      }
    });
    return item;
  };

  const attach = () => {
    if (destroyed) return;
    const menu = doc.getElementById(WAND_MENU_ID);
    if (!menu) return;
    const existing = doc.getElementById(WAND_ITEM_ID);
    if (existing && existing.parentElement === menu) {
      itemEl = existing;
      itemEl.classList.toggle('has-unread', currentUnread);
      return;
    }
    if (existing) existing.remove();
    itemEl = buildItem();
    menu.append(itemEl);
  };

  attach();

  // 若宿主扩展菜单尚未创建或后续被重建，自动补挂菜单项（带轻量节流避免流式高频回调）
  let observeTimer = null;
  const ObserverCtor = win?.MutationObserver || globalThis.MutationObserver;
  if (typeof ObserverCtor === 'function') {
    observer = new ObserverCtor(() => {
      if (destroyed || observeTimer) return;
      const existing = doc.getElementById(WAND_ITEM_ID);
      if (existing && existing.isConnected) return;
      observeTimer = setTimeout(() => {
        observeTimer = null;
        if (destroyed) return;
        const cur = doc.getElementById(WAND_ITEM_ID);
        if (cur && cur.isConnected) return;
        attach();
      }, 60);
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  const onDocClick = (e) => {
    if (destroyed) return;
    const target = e.target;
    if (target && typeof target.closest === 'function' && target.closest(`#${WAND_TRIGGER_ID}`)) {
      attach();
    }
  };
  doc.addEventListener('click', onDocClick, true);

  return {
    setHidden() {
      /* 魔法棒菜单项无需在面板打开时隐藏 */
    },
    setUnread(unread) {
      currentUnread = !!unread;
      const target = itemEl && itemEl.isConnected ? itemEl : doc.getElementById(WAND_ITEM_ID);
      if (target) target.classList.toggle('has-unread', currentUnread);
    },
    destroy() {
      destroyed = true;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      doc.removeEventListener('click', onDocClick, true);
      doc.getElementById(WAND_ITEM_ID)?.remove();
      doc.getElementById(WAND_STYLE_ID)?.remove();
      itemEl = null;
    },
  };
}
