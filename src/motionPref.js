// 冒险手账开合动效配置：默认开启（'on'），可切换为关闭（'off'）。

export const MOTION_PREF_KEY = 'quest_helper_motion_v1';

export const MOTION_PREFS = Object.freeze({
  ON: 'on',
  OFF: 'off',
});

/** 归一化动效配置，仅显式关闭值返回 'off'，其余默认返回 'on'。 */
export function normalizeMotionPref(value) {
  if (value === false || value === 0) return MOTION_PREFS.OFF;
  const cleaned = String(value ?? '').trim().toLowerCase();
  if (cleaned === MOTION_PREFS.OFF || cleaned === 'false' || cleaned === '0') {
    return MOTION_PREFS.OFF;
  }
  return MOTION_PREFS.ON;
}

/** 从宿主存储读取是否启用开合动效，默认返回 true。 */
export function readMotionEnabled(readStorage) {
  if (typeof readStorage !== 'function') return true;
  try {
    return normalizeMotionPref(readStorage(MOTION_PREF_KEY)) === MOTION_PREFS.ON;
  } catch {
    return true;
  }
}

/** 将开合动效偏好持久化到宿主存储并返回归一化后的布尔状态。 */
export function writeMotionEnabled(writeStorage, enabled) {
  const pref = normalizeMotionPref(enabled);
  if (typeof writeStorage === 'function') {
    try {
      writeStorage(MOTION_PREF_KEY, pref);
    } catch {
      /* 忽略存储异常 */
    }
  }
  return pref === MOTION_PREFS.ON;
}
