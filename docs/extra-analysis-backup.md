# MVU 额外模型变量更新支持 · 还原参考备份

> 本文档保留了在砍掉 MVU「额外模型更新变量」支持前的完整设计与实现源码快照，供日后需要重新接回额外模型（`[mvu_update]` 独立通道）时直接对照还原。

## 一、Git 完整基线快照

移除额外模型支持前的最后一个完整提交为：

- **Commit**：`34ea146`（在其之前的核心完善提交为 `f8d9758`）
- **基线范围**：支持双条目 `[mvu_plot]` + `[mvu_update]`、额外模型窗口协调、前端 `mag_variable_update_ended` 宽限轮询、以及主/副模型双视角盲演脱敏。

日后若要直接从 Git 对比或检出旧版实现，可执行：

```bash
# 查看任一文件在 34ea146 时的完整源码
git show 34ea146:build.mjs
git show 34ea146:src/commit.js
git show 34ea146:src/scriptRef.js
git show 34ea146:src/state.js
git show 34ea146:src/actions.js
git show 34ea146:src/runtime.js
git show 34ea146:src/panel.js
git show 34ea146:任务助手-世界书.ejs
```

---

## 二、为什么要暂时移除（恢复前必看前置条件）

- 外部《命定之诗》预设助手 `v3.19.0 ~ v3.20.1` 在总结预处理时，会收集世界书中名字匹配 `/\[mvu_update\]/i` 的条目全部原文 `E`，并直接构造单条巨型正则 `new RegExp("^[ \\t]*" + Kd(E) + "[ \\t]*(?:\\n|$)", "gm")`。
- 在 V8 引擎中，面对含中文的 `TwoByte` 世界书内容时，单条 `[mvu_update]` 条目原文超过约 `3.2 万 ~ 3.5 万` 字符即触发 `SyntaxError: Invalid regular expression: ...: Regular expression too large`（当前任务助手世界书条约 7.5 万字、极限压缩后仍约 6.2 万字）。
- **恢复前提**（满足其一即可恢复）：
  1. 外部预设助手已修复该正则构建缺陷（改为 `includes` 判断 + 纯字符串行边界裁剪，不再将整条条目传入 `new RegExp`）；或
  2. 将 `[mvu_update]` 变量更新规则拆分为 3 个以上各自低于 `2.5 万` 字符的子条目。

---

## 三、核心模块源码快照（来自 `34ea146`）

### 1. 世界书双条目导出（`build.mjs`）

```js
return {
  entries: {
    '0': createWorldbookEntry({
      uid: 0,
      comment: `[mvu_plot]任务助手-剧情引导${ver}`,
      order: 1150,
      content: renderRole('plot'),
    }),
    '1': createWorldbookEntry({
      uid: 1,
      comment: `[mvu_update]任务助手-变量更新${ver}`,
      order: 99999,
      content: renderRole('update'),
    }),
  },
};
```

### 2. 世界书 EJS 角色与额外模型窗口判定（`任务助手-世界书.ejs`）

```js
// 顶部角色控制
const _wbRole = 'all';
const _emitPlot = _wbRole !== 'update';
const _emitUpdate = _wbRole !== 'plot';

// 额外模型重扫 / 单次关注方向窗口判定（支持 nc + 1 到 nc + 2）
const _prevNonSysMsg = _nonSysMsgs.length >= 2 ? _nonSysMsgs[_nonSysMsgs.length - 2] : null;
const _hasExtraApi = typeof Mvu === 'object' && Mvu && typeof Mvu.isDuringExtraAnalysis === 'function';
const _skipRescanGenTypes = ['swipe', 'continue', 'append', 'appendFinal'];
const _isSkipRescanGen = _skipRescanGenTypes.includes(_genType);
const _extraRunning = _hasExtraApi ? !!Mvu.isDuringExtraAnalysis() : false;
const _inExtraUpdateTurn = (_extraRunning
  || (_wbRole === 'update' && !_hasExtraApi && !!_prevNonSysMsg && _prevNonSysMsg.is_user === true))
  && !_isSkipRescanGen
  && !!_lastNonSysMsg && _lastNonSysMsg.is_user === false;
const _isRescanWindowDue = (curVal, baseVal) => {
  if (curVal <= baseVal) return true;
  if (curVal === baseVal + 1) {
    return (_lastNonSysMsg && _lastNonSysMsg.is_user === false) ? _inExtraUpdateTurn : true;
  }
  if (curVal === baseVal + 2) return _inExtraUpdateTurn;
  return false;
};
```

当时主/副模型双视角区分方式：
- `seedTail`：`_emitPlot ? '（仅正常完结写入，彻底失败或放弃时不写；正文正面推进，不提前点破引信）' : '（仅正常完结写入，彻底失败或放弃时不写）'`
- `因果引爆`（L1351）：由 `<% if (_emitPlot) { %>` 控制是否向文本层补充「正文在无关日常细节、战利品或环境变化中自然带出...」
- `板上任务`（L1365-1366）：`const _dispTitle = _emitPlot ? (_stripBackendTags(it.title) || it.title) : it.title;` 与 `const _dispTruth = _emitPlot ? _stripPlotTruth(it.truth) : it.truth;`（独立额外更新模型保留原始后台标签，主模型剥除剧透）。

### 3. 世界书角色与 `[mvu_update]` 诊断（`src/scriptRef.js`）

```js
function detectEntryRole(entry) {
  const title = String(entry?.name ?? entry?.comment ?? '').trim();
  const content = String(entry?.content ?? '');
  const hasPlotTag = /\[mvu_plot\]/i.test(title);
  const hasUpdateTag = /\[mvu_update\]/i.test(title);
  if (hasPlotTag && hasUpdateTag) return { role: 'all', hasMvuTag: true };
  if (hasPlotTag) return { role: 'plot', hasMvuTag: true };
  if (hasUpdateTag) return { role: 'update', hasMvuTag: true };
  const roleMeta = content.match(/\/\/\s*@role\s+(plot|update|all)\b/i);
  if (roleMeta) {
    const r = roleMeta[1].toLowerCase();
    return { role: r === 'plot' || r === 'update' ? r : 'all', hasMvuTag: false };
  }
  const roleConst = content.match(/const\s+_wbRole\s*=\s*['"](plot|update|all)['"]/);
  if (roleConst) {
    const r = roleConst[1];
    return { role: r === 'plot' || r === 'update' ? r : 'all', hasMvuTag: false };
  }
  if (title.includes('剧情引导')) return { role: 'plot', hasMvuTag: false };
  if (title.includes('变量更新')) return { role: 'update', hasMvuTag: false };
  return { role: 'all', hasMvuTag: false };
}
```

兼容状态提示分支：
- `partial_disabled`：缺少 `「剧情引导 [mvu_plot]」` 或 `「变量更新 [mvu_update]」`；
- `missing_mvu_tag`：分拆条目标题缺少 `[mvu_plot]` 或 `[mvu_update]` 前缀，MVU 无法自动分流。

### 4. 宿主共享信号与写锁协同（`src/commit.js`）

```js
const MVU_END_KEY = '__questHelperMvuEnd';
const MSG_RECV_KEY = '__questHelperMsgRecv';
const DEFAULT_MSG_RECV_GRACE_MS = 1800;

export function recordMvuUpdateEnded(chatCount = null, chatId = '') { /* 写入 parentWindow[MVU_END_KEY] */ }
export function clearMvuUpdateEnded() { /* delete parentWindow[MVU_END_KEY] */ }
export function recordMsgReceived(chatCount = null, chatId = '') { /* 写入 parentWindow[MSG_RECV_KEY] */ }
export function clearMsgReceived() { /* delete parentWindow[MSG_RECV_KEY] */ }
export function msgRecvGraceRemainingMs({ chatCount = null, chatId = '', graceMs = DEFAULT_MSG_RECV_GRACE_MS } = {}) { /* 计算 1800ms 剩余宽限 */ }
export function isMsgRecvWithinGrace(opts = {}) { return msgRecvGraceRemainingMs(opts) > 0; }
export function isMvuUpdateEndedFor({ chatCount = null, chatId = '' } = {}) { /* 按 chatId 与 chatCount 匹配 */ }
export function extraAnalysisActive() {
  try { return !!parentWindow.Mvu?.isDuringExtraAnalysis?.(); } catch { return false; }
}
export function generating() {
  if (extraAnalysisActive()) return true;
  /* 检查 #mes_stop */
}
```

### 5. 前端宽限状态窗口（`src/state.js` & `src/actions.js`）

```js
// src/state.js -> rescanFresh(pending, current = {})
const atCount = toNum(pending['消息数']);
const nowCount = toNum(effectiveChatCount(current.chat, current.chatCount));
if (atCount !== null && nowCount !== null) {
  if (nowCount <= atCount) return true;
  if (nowCount === atCount + 1) {
    return isAssistantTail === true ? !!current.extraAnalyzing : true;
  }
  if (nowCount === atCount + 2) return !!current.extraAnalyzing;
  return false;
}
// 楼层分支同上支持 +1（AI尾看 extraAnalyzing）与 +2（extraAnalyzing）

// src/state.js -> isOnceFocusExpired(board, current = {})
const inGrace = (atVal, nowVal) => (
  current.allowGrace === false
  && !current.extraFinished
  && (nowVal === atVal + 2
    || (nowVal === atVal + 1 && lastNonSystemIsAssistant(current.chat) === true))
);

// src/actions.js -> questRescanDone(...)
const settled = extraFinished || allowGrace;
if (atCount !== null && nowCount !== null) {
  if (nowCount > atCount + 2) return true;
  if (nowCount === atCount + 2) return settled;
  if (nowCount === atCount + 1 && isAssistantTail === true) return settled;
  return false;
}
```

### 6. 运行时事件与轮询协调（`src/runtime.js` & `src/panel.js`）

- `RESCAN_GRACE_MS = 1800`
- `evalGrace(curCount, extraFinished, extraAnalyzing, curChatId)`：在 `extraAnalyzing || extraFinished` 时关闭等待；若在消息落楼 1800ms 宽限期内返回 `allowGrace: false, waitGraceMs: rem + 50`。
- 事件监听：`listen('mag_variable_update_ended', () => scheduleMaintenance(true))`；在 `scheduleMaintenance(fromMvuEnd)` 中区分 `MESSAGE_RECEIVED`（调 `recordMsgReceived`）与 `mag_variable_update_ended`（调 `recordMvuUpdateEnded`）；在 `onSwipeRefresh` / `onPassiveRefresh` / `CHAT_CHANGED` 中按聊天协调清除或延续宽限；在 `runQuestBoardMaintenance` 中遇到 `generating()` 或返回 `'生成'` 错误时最多重试 `graceRetry < 60`（前 20 次每 1.5s，之后每 5s，覆盖长时额外模型分析）。
- `src/panel.js`：在 `render()` 与 `renderContent()` 内部重扫提交闭包中读取 `extraAnalysisActive()`、`isMvuUpdateEndedFor(...)`、`isMsgRecvWithinGrace(...)` 并传入 `requestQuestRescan`、`maintainQuestBoard` 与 `readState`。

---

## 四、还原步骤速查

1. 用 `git diff <当前提交> 34ea146 -- build.mjs 任务助手-世界书.ejs src/ test.mjs` 审阅当时全部改动点；
2. 恢复 `build.mjs` 第二条目 `comment` 为 `[mvu_update]任务助手-变量更新${ver}`（或拆成多条 `[mvu_update]` 以满足正则字数限制）；
3. 恢复 `src/scriptRef.js` 中的 `[mvu_update]` 角色判定与 `missing_mvu_tag` 检查（并清理取消额外模型后新增的 `hasLegacyUpdateTag` / `legacyMvuUpdate` / `legacy_mvu_update` 检测分支及 `src/panel.js` 对应徽章文案）；
4. 恢复 `src/commit.js`、`src/state.js`、`src/actions.js`（含 `requestQuestRescan`、`maintainQuestBoard` 与 `focusOpts` 对 `extraAnalyzing`/`extraFinished`/`allowGrace` 的透传）、`src/runtime.js`、`src/panel.js` 中的额外模型信号、1800ms 宽限期与 `mag_variable_update_ended` 监听；
5. 恢复 `任务助手-世界书.ejs` 中 `_inExtraUpdateTurn` 与 `Mvu.isDuringExtraAnalysis()` 窗口判定及 `_emitPlot` / `update` 双视角差异；
6. 参照 `34ea146:test.mjs` 补回 `isDuringExtraAnalysis`、双条目 `[mvu_plot]+[mvu_update]`、1800ms 宽限与 `recordMvuUpdateEnded` 测试断言并运行 `node --test test.mjs`。
