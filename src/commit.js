// 将 actions.js 的结果写回酒馆最新楼层的 MVU 变量并存档。
import { parentWindow } from './host.js';

const QUEUE_KEY = '__questHelperCommitQueue';

/** 当前宿主是否正在运行 MVU 额外模型变量解析。 */
export function extraAnalysisActive() {
  try {
    return !!parentWindow.Mvu?.isDuringExtraAnalysis?.();
  } catch {
    return false;
  }
}

/** 回复或 MVU 额外模型解析正在进行时禁止写变量，避免并发踩踏与覆盖。 */
export function generating() {
  if (extraAnalysisActive()) return true;
  try {
    const stop = parentWindow.document.getElementById('mes_stop');
    return !!stop && parentWindow.getComputedStyle(stop).display !== 'none';
  } catch {
    return false;
  }
}

/**
 * 串行化提交操作：队列挂载在宿主窗口上，确保 runtime.js 与 panel.js 共享同一把写锁，
 * 每次真正轮到自己执行时才调用 mvu.getMvuData 读取最新状态。
 * @param {(stat: object) => ({stat: object, done: string} | {skip: true} | {error: string})} action
 * @param {{core?: string, speaker?: string, redraw?: boolean}} [options]
 * @returns {Promise<{done?: string, skipped?: boolean, error?: string}>}
 */
export function commit(action, { core = '任务助手', speaker = '任务助手', redraw = true } = {}) {
  const exec = async () => {
    const mvu = parentWindow.Mvu;
    if (!mvu?.getMvuData || !mvu?.replaceMvuData) return { error: '没有找到 MVU，变量写不进去' };
    if (generating()) return { error: '回复还在生成，等它写完再操作' };
    const option = { type: 'message', message_id: 'latest' };
    let data;
    try {
      data = JSON.parse(JSON.stringify(mvu.getMvuData(option) ?? {}));
    } catch (error) {
      console.error(`[${core}] 读取变量失败:`, error);
      return { error: '读取变量失败' };
    }
    if (!data.stat_data || typeof data.stat_data !== 'object' || !('主角' in data.stat_data)) {
      return { error: `最新楼层没有变量，等下一轮回复之后再操作（${speaker}）` };
    }
    const result = action(data.stat_data);
    if (!result || result.skip) return { skipped: true };
    if (result.error) return result;
    data.stat_data = result.stat;
    try {
      await mvu.replaceMvuData(data, option);
    } catch (error) {
      console.error(`[${core}] 写入变量失败:`, error);
      return { error: '写入变量失败' };
    }
    try {
      await parentWindow.SillyTavern?.getContext?.()?.saveChat?.();
    } catch (error) {
      console.warn(`[${core}] 存档失败，下次发送时会一起保存:`, error);
    }
    if (redraw) {
      try {
        const helper = parentWindow.TavernHelper;
        const id = helper?.getLastMessageId?.();
        if (typeof id === 'number' && id >= 0) await helper.refreshOneMessage?.(id);
      } catch (error) {
        console.warn(`[${core}] 重绘楼层失败:`, error);
      }
    }
    return { done: result.done };
  };

  const prev = parentWindow[QUEUE_KEY] || Promise.resolve();
  const nextTask = prev.catch(() => {}).then(exec);
  parentWindow[QUEUE_KEY] = nextTask.catch(() => {});
  return nextTask;
}
