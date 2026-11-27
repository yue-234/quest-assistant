// 任务情报板入口方式配置：默认「悬浮框（fab）」，可切换为「魔法棒扩展菜单（wand）」。

export const ENTRY_MODE_KEY = 'quest_helper_entry_mode_v1';

export const ENTRY_MODES = Object.freeze({
  FAB: 'fab',
  WAND: 'wand',
});

/** 归一化入口模式，仅 'wand' 切换至魔法棒菜单，其余默认返回 'fab'。 */
export function normalizeEntryMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === ENTRY_MODES.WAND
    ? ENTRY_MODES.WAND
    : ENTRY_MODES.FAB;
}

/** 从宿主存储读取入口模式，默认返回 'fab'。 */
export function readEntryMode(readStorage) {
  if (typeof readStorage !== 'function') return ENTRY_MODES.FAB;
  try {
    return normalizeEntryMode(readStorage(ENTRY_MODE_KEY));
  } catch {
    return ENTRY_MODES.FAB;
  }
}

/** 将入口模式持久化到宿主存储并返回归一化后的模式。 */
export function writeEntryMode(writeStorage, mode) {
  const normalized = normalizeEntryMode(mode);
  if (typeof writeStorage === 'function') {
    try {
      writeStorage(ENTRY_MODE_KEY, normalized);
    } catch {
      /* 忽略存储异常 */
    }
  }
  return normalized;
}
