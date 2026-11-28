import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import { DATA, SCRIPT_VERSION } from './src/data.js';
import {
  questBoardState,
  stripQuestBackendTags,
  effectiveChatCount,
  normalizeQuestFocus,
  isOnceFocusExpired,
  rescanFresh,
  lastNonSystemIsAssistant,
  readState,
  parseAftermathEntry,
  isAftermathEntryExpired,
  stripTaskTitle,
  matchFormalTask,
  extractHistoryStats,
  wasInHistoryFormalTasks,
  cleanRewardText,
  mergeRewardMapEntries,
  parseClaimedSet,
  parseLostSet,
  CLAIMED_MARK_RE,
  LOST_MARK_RE,
} from './src/state.js';
import {
  toggleQuestIntent,
  ignoreQuest,
  toggleQuestRewardClaimed,
  cycleQuestRewardState,
  deleteAftermathEntry,
  hasExpiredAftermath,
  sweepExpiredAftermath,
  setQuestFocus,
  hasExpiredOnceFocus,
  clearExpiredOnceFocus,
  hasExpiredDirectorLeads,
  sweepExpiredDirectorLeads,
  requestQuestRescan,
  questRescanDone,
  clearQuestRescan,
  needsQuestAcceptedRecord,
  recordAcceptedQuests,
  hasClosedQuestLeftovers,
  sweepClosedQuests,
  maintainQuestBoard,
} from './src/actions.js';
import {
  ENTRY_MODES,
  ENTRY_MODE_KEY,
  normalizeEntryMode,
  readEntryMode,
  writeEntryMode,
} from './src/entryMode.js';
import { mountWand } from './src/wand.js';
import {
  DEFAULT_SCRIPT_REF,
  SCRIPT_REF_KEY,
  CDN_ORIGIN_KEY,
  normalizeScriptRef,
  readScriptRef,
  writeScriptRef,
  compareSemverTags,
  fetchLatestScriptTag,
  hasNewerScriptVersion,
  extractVersionFromText,
  isQuestAssistantEntry,
  inspectWorldbookEntries,
  checkWorldbookCompatibility,
  fetchAvailableScriptRefs,
  fetchScriptByRef,
  worldbookCompatibilityBadge,
} from './src/scriptRef.js';
import {
  clearReplySettle,
  generating,
  markMvuSettled,
  markReplyReceived,
  replySettleRemainingMs,
} from './src/commit.js';
import {
  readMessages,
  readActiveWorldbookInfo,
} from './src/host.js';
import { buildWorldbookJson, worldbookFilename } from './build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadEjs() {
  if (process.env.EJS_PATH && fs.existsSync(process.env.EJS_PATH)) {
    return require(process.env.EJS_PATH);
  }
  try {
    return require('ejs');
  } catch {
    /* 继续尝试本地回退路径 */
  }
  const fallbackRoots = [
    path.resolve(__dirname, 'node_modules/.pnpm'),
    'f:/git/Destined-Poem-Card/node_modules/.pnpm',
  ];
  for (const pnpmRoot of fallbackRoots) {
    if (!fs.existsSync(pnpmRoot)) continue;
    const dirs = fs.readdirSync(pnpmRoot).filter((d) => d.startsWith('ejs@'));
    for (const d of dirs) {
      const candidate = path.join(pnpmRoot, d, 'node_modules', 'ejs', 'lib', 'ejs.js');
      if (fs.existsSync(candidate)) return require(candidate);
    }
  }
  const fallbackPkg = 'f:/git/Destined-Poem-Card';
  if (fs.existsSync(fallbackPkg)) {
    return require(require.resolve('ejs', { paths: [fallbackPkg] }));
  }
  throw new Error('未找到 ejs，请先安装 ejs 或设置环境变量 EJS_PATH');
}

const ejs = loadEjs();
const ejsSource = fs.readFileSync(path.join(__dirname, '任务助手-世界书.ejs'), 'utf8');
const builtScriptPath = path.join(__dirname, '⭐粘这个-任务助手脚本.js');
const builtScriptTxtPath = path.join(__dirname, '⭐粘这个-任务助手脚本.txt');
const builtDistScriptPath = path.join(__dirname, 'dist', 'quest-assistant.js');
const builtWorldbookName = worldbookFilename(SCRIPT_VERSION);
const builtWorldbookPath = path.join(__dirname, builtWorldbookName);
const remoteLoaderPath = path.join(__dirname, '⭐粘这个-远程自动更新脚本.js');

function renderEjs(statData, { chat = [], lastUserMessageId = 0, geoData = {}, systemCore = '', destinyImmersiveMode, generateType = '', Mvu, source = ejsSource } = {}) {
  const ctx = {
    getvar: (k) => {
      if (k === 'stat_data') return statData;
      if (k === '系统核心') return systemCore;
      return undefined;
    },
    getLocalVar: (k) => (k === 'runtime_geo_compact_data' ? geoData : {}),
    SillyTavern: { getContext: () => ({ chat }) },
    lastUserMessageId,
    ...(typeof destinyImmersiveMode === 'function' ? { destinyImmersiveMode } : {}),
    ...(generateType ? { generateType } : {}),
    ...(Mvu ? { Mvu } : {}),
  };
  return ejs.render(source, ctx);
}

function assertCleanOutput(out, label) {
  assert.match(out, /\/事件\/任务情报板/, `${label}: 应使用 /事件/任务情报板 路径`);
  assert.doesNotMatch(out, /UNN|多尼|凯特|<unn>|演播室/i, `${label}: 不得包含任何 UNN 相关残留`);
  const boldMatches = out.match(/\*\*[^*]+\*\*/g) || [];
  assert.equal(boldMatches.length, 1, `${label}: ** 加粗应恰好只有 1 处，实际为 ${boldMatches.length} 处: ${boldMatches.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 1. EJS 六种模式渲染测试
// ---------------------------------------------------------------------------

test('EJS init 模式：首次初始化任务情报板 + 通用事件链承接提示词', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '艾尔登大陆-巨龙山脉-铁炉堡-铁砧酒馆', 时间: '复兴纪元488年-3月-10日-12:00' },
    事件: {},
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'init');
  assert.match(out, /首次初始化任务情报板/);
  assert.match(out, /"op": "insert", "path": "\/事件\/任务情报板"/);
  assert.match(out, /事件承接/);
  assert.match(out, /创意工坊自制事件链/);
  assert.match(out, /未在上下文中激活的事件链不得凭空捏造/);
  assert.doesNotMatch(out, /本区事件钩子|艾波丽斯|莉莉娅丝|素瓷密室|斯芬克斯/);
  assert.match(out, /生成规格/);
  assert.match(out, /B~S 级/);
  assert.match(out, /收益 10 栏/);
  assert.match(out, /串联多个城市或区域/);
  assert.match(out, /禁止用 `→` 串联多站路线/);
  assert.match(out, /长期放任会导致局势失控并波及多个区域与世界/);
});

test('EJS maintain 模式：常规停留 + 已接取透传打勾Patch与结案移出', () => {
  const stat = {
    主角: { 等级: 8 },
    世界: { 地点: '雾晶港-北码头', 时间: '复兴纪元488年-3月-12日-09:00' },
    任务列表: {
      '雾港走私案（个人）': { 状态: '进行中', 进展: '[3月-12日] 已追踪到仓库' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '复兴纪元488年-3月-11日',
        列表: [
          {
            id: 'q1',
            类别: '剧情任务',
            等级: 'B',
            标题: '雾港走私案',
            方式: '调查',
            摘要: '港口货船夜间异动',
            真相: '商盟幕后转移禁运魔导核',
            预期收益: ['史诗级武器 ×1', '稀有级材料 ×3'],
            更新日: '复兴纪元488年-3月-11日',
          },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '灯塔熄灭', 方式: '探索', 预期收益: ['金币 ×500'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '失踪渔船', 方式: '委托', 预期收益: ['药剂 ×2'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '码头鼠患', 方式: '悬赏', 预期收益: ['金币 ×200'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '修补渔网', 方式: '委托', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'maintain');
  assert.match(out, /同区域常规停留/);
  assert.match(out, /已接取:雾港走私案（个人）/);
  assert.match(out, /"path": "\/事件\/任务情报板\/已兑现"/);
  assert.match(out, /"op": "remove", "path": "\/事件\/任务情报板\/列表\/0"/);
  assert.doesNotMatch(out, /生成规格/);
});

test('EJS relocate 模式：跨城迁移保留剧情任务与已锁定项', () => {
  const stat = {
    主角: { 等级: 6 },
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-15日-14:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        意向: ['q2'],
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '群山远征', 方式: '委托', 预期收益: ['传说武器 ×1'], 更新日: '复兴纪元488年-3月-10日' },
          { id: 'q2', 类别: '本地主线', 等级: 'B', 标题: '熔炉异变', 方式: '危机', 预期收益: ['史诗护甲 ×1'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '酒馆杂务', 方式: '委托', 预期收益: ['金币 ×80'] },
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'relocate');
  assert.match(out, /已跨区域迁入「瓦伦蒂亚」/);
  assert.match(out, /群山远征/);
  assert.match(out, /熔炉异变/);
  assert.doesNotMatch(out, /酒馆杂务/);
  assert.match(out, /事件承接/);
  assert.doesNotMatch(out, /本区事件钩子|艾波丽斯|莉莉娅丝|素瓷密室|斯芬克斯/);
});

test('EJS refill 模式：未接取不足 4 条时触发补足空缺', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '铁炉堡-商业街', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        忽略: ['讨伐哥布林'],
        列表: [
          { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '修补矿车', 方式: '委托', 预期收益: ['金币 ×100'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '护送矿石', 方式: '委托', 预期收益: ['金币 ×150'] },
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'refill');
  assert.match(out, /补足空缺/);
  assert.match(out, /已忽略（不重复生成同类任务）: 讨伐哥布林/);
});

test('EJS rescan 模式：100 FP 地区情报重扫（仅保留剧情/已接取/锁定，隐藏待淘汰旧任务）', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '铁炉堡-东区', 时间: '复兴纪元488年-3月-11日-10:00' },
    任务列表: {
      '进行中主线': { 状态: '进行中', 进展: '[3月-10日] 已调查一半' },
    },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        意向: ['q3'],
        待重扫: { 楼层: '4', 消息数: '5' },
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '群山远征', 方式: '委托', 预期收益: ['传说武器 ×1'], 更新日: '复兴纪元488年-3月-10日' },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '旧委托', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '已锁定支线', 方式: '委托', 预期收益: ['金币 ×80'] },
          { id: 'q4', 类别: '本地主线', 等级: 'C', 标题: '进行中主线', 方式: '调查', 预期收益: ['稀有装备 ×1'] },
        ],
      },
    },
  };
  const out = renderEjs(stat, { chat: new Array(6).fill({}), lastUserMessageId: 5 });
  assertCleanOutput(out, 'rescan');
  assert.match(out, /已支付 100 FP 启动地区情报重扫/);
  assert.match(out, /群山远征/);
  assert.match(out, /已锁定支线/);
  assert.match(out, /进行中主线/);
  assert.doesNotMatch(out, /旧委托/);
  assert.match(out, /保持原 `id`\/等级\/内容\/更新日不变，不重编、不添 `进展`/);
  assert.match(out, /未列出的旧未接取未锁定本地任务不保留，整表 `replace` 写入 `列表`/);
  assert.match(out, /未接取时不写 `进展` 字段/);
  assert.doesNotMatch(out, /进展（接取后演进填写）/);
  assert.match(out, /OTHER SPECIFIC REQUIREMENTS/);

  // 无任何需保留旧任务 + 同回合提及待淘汰旧支线：plot/update 同步不展示，状态栏注明 需保留：0 条，指令直接全新生成
  const allDroppedRescanStat = {
    世界: { 地点: '铁炉堡-东区', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        待重扫: { 楼层: '4', 消息数: '5' },
        列表: [
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '校准风向仪', 方式: '委托', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  const chatMentionUserTurn = [
    ...new Array(5).fill({ is_user: false, mes: '' }),
    { is_user: true, is_system: false, mes: '我想顺手看看校准风向仪的任务。' },
  ];
  const allDropAll = renderEjs(allDroppedRescanStat, { chat: chatMentionUserTurn, lastUserMessageId: 5 });
  const allDropPlot = renderEjs(allDroppedRescanStat, {
    chat: chatMentionUserTurn,
    lastUserMessageId: 5,
    source: ejsSource.replace("const _wbRole = 'all';", "const _wbRole = 'plot';").replace('// @role all', '// @role plot'),
  });
  const allDropUpdate = renderEjs(allDroppedRescanStat, {
    chat: chatMentionUserTurn,
    lastUserMessageId: 5,
    source: ejsSource.replace("const _wbRole = 'all';", "const _wbRole = 'update';").replace('// @role all', '// @role update'),
  });
  assert.doesNotMatch(allDropPlot, /校准风向仪/);
  assert.doesNotMatch(allDropUpdate, /校准风向仪/);
  assert.doesNotMatch(allDropAll, /校准风向仪/);
  assert.match(allDropUpdate, /在板任务：1 条（需保留：0 条）/);
  assert.match(allDropUpdate, /当前没有需保留的旧任务，按当前区域全新生成/);
});

test('EJS 未接取冻结：未接取任务不演进且常规不展示给 AI，用户主动提及后按需透传', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-16日-10:00' },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-10日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 摘要: '远方商路异动', 真相: '教团跨城筹备仪式', 预期收益: ['史诗护符 ×1'], 更新日: '复兴纪元488年-3月-10日' },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '商队失联', 方式: '调查', 预期收益: ['金币 ×300'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '信件投递', 方式: '委托', 预期收益: ['金币 ×80'] },
        ],
      },
    },
  };
  const frozenOut = renderEjs(stat);
  assertCleanOutput(frozenOut, 'frozen');
  assert.match(frozenOut, /同区域常规停留/);
  assert.doesNotMatch(frozenOut, /待演进/);
  assert.doesNotMatch(frozenOut, /白石暗潮/);
  assert.doesNotMatch(frozenOut, /商队失联/);

  const mentionedOut = renderEjs(stat, {
    chat: [{ mes: '根据手头的地区情报，我顺着线索动身前往「白石暗潮」。' }],
    lastUserMessageId: 0,
  });
  assertCleanOutput(mentionedOut, 'mentioned');
  assert.match(mentionedOut, /白石暗潮/);
  assert.match(mentionedOut, /教团跨城筹备仪式/);
  assert.doesNotMatch(mentionedOut, /商队失联/);
});

test('EJS advance 模式：已接取剧情任务搁置满 5 日自动演进', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-16日-10:00' },
    任务列表: {
      '白石暗潮': { 状态: '进行中', 进展: '[488年-3月-10日] 取得初步线索' },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-10日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 预期收益: ['史诗护符 ×1'], 更新日: '复兴纪元488年-3月-10日' },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '商队失联', 方式: '调查', 预期收益: ['金币 ×300'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '信件投递', 方式: '委托', 预期收益: ['金币 ×80'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '修缮栅栏', 方式: '委托', 预期收益: ['金币 ×60'] },
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'advance');
  assert.match(out, /剧情任务搁置演进/);
  assert.match(out, /待演进:已搁置 6 天/);
  assert.match(out, /静默同步至 `\/任务列表`（不双写任务情报板），需要时在正文中通过当地传闻或情报渠道自然带出一句/);
  assert.doesNotMatch(out, /商队失联/);
});

// ---------------------------------------------------------------------------
// 2. actions 与 state 全流程测试
// ---------------------------------------------------------------------------

test('actions 全流程：锁定、忽略、100 FP 重扫、修改模式打勾', () => {
  let stat = {
    命运点数: '250',
    世界: { 地点: '白石镇-旅馆', 时间: '复兴纪元488年-3月-10日-08:00' },
    任务列表: {
      '白石暗潮（团队）': { 状态: '进行中', 进展: '已潜入酒窖' },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-10日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 预期收益: ['史诗武器 ×1', '金币 ×1000'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '商队失联', 方式: '调查', 预期收益: ['稀有材料 ×3'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
        ],
      },
    },
  };

  // 去后缀匹配
  assert.equal(stripTaskTitle('白石暗潮（团队）'), '白石暗潮');
  let st = readState(stat);
  assert.equal(st.questBoard.items.find((x) => x.id === 'q1').accepted, true);

  // 锁定与取消锁定
  let res = toggleQuestIntent(stat, 'q2', '商队失联');
  assert.ok(!res.error);
  stat = res.stat;
  assert.deepEqual(stat['事件']['任务情报板']['意向'], ['q2']);

  res = toggleQuestIntent(stat, 'q2', '商队失联');
  stat = res.stat;
  assert.deepEqual(stat['事件']['任务情报板']['意向'], []);

  // 修改模式打勾与取消
  res = toggleQuestRewardClaimed(stat, 'q1', 1, '白石暗潮');
  assert.ok(!res.error);
  stat = res.stat;
  assert.deepEqual(stat['事件']['任务情报板']['已兑现']['q1'], [1]);
  st = questBoardState(stat);
  assert.equal(st.items.find((x) => x.id === 'q1').claimedCount, 1);

  res = toggleQuestRewardClaimed(stat, 'q1', 1, '白石暗潮');
  stat = res.stat;
  assert.equal(stat['事件']['任务情报板']['已兑现']['q1'], undefined);

  // 忽略任务
  res = ignoreQuest(stat, 'q3', '草药采集');
  assert.ok(!res.error);
  stat = res.stat;
  assert.equal(stat['事件']['任务情报板']['列表'].length, 2);
  assert.deepEqual(stat['事件']['任务情报板']['忽略'], ['草药采集']);

  // 100 FP 重扫 + 防重复 + 过期清理（普通核心命运点数写回为数字）
  res = requestQuestRescan(stat, 10, 12);
  assert.ok(!res.error);
  stat = res.stat;
  assert.strictEqual(stat['命运点数'], 150);
  assert.equal(typeof stat['命运点数'], 'number');
  assert.equal(questBoardState(stat, { floor: 10, chatCount: 12 }).rescanPending, true);

  const dup = requestQuestRescan(stat, 10, 12);
  assert.ok(dup.error);

  // 主模型单轮重扫语义：chatCount <= 12 或 13 且末尾为用户消息时保持待重扫；AI 回复落楼（chatCount = 13 AI 尾）或 >= 14 时清理
  assert.equal(rescanFresh(stat['事件']['任务情报板']['待重扫'], { floor: 10, chatCount: 12 }), true);
  assert.equal(questRescanDone(stat, 10, 12), false);
  assert.equal(rescanFresh(stat['事件']['任务情报板']['待重扫'], { floor: 12, chatCount: 14 }), false);
  assert.equal(questRescanDone(stat, 12, 14), true);

  // 用户消息之后点重扫再 Regenerate（atCount = 12 → AI 回复落楼 chatCount = 13，末尾 is_user: false）同样可结束与清理
  const waitUserChat13 = [{ is_user: true, is_system: false, mes: '用户刚发消息等AI' }];
  const aiTailChat13 = [{ is_user: true, is_system: false, mes: '问' }, { is_user: false, is_system: false, mes: 'AI已恢复' }];
  assert.equal(lastNonSystemIsAssistant(waitUserChat13), false);
  assert.equal(lastNonSystemIsAssistant(aiTailChat13), true);
  assert.equal(rescanFresh(stat['事件']['任务情报板']['待重扫'], { chatCount: 13, chat: waitUserChat13 }), true);
  assert.equal(rescanFresh(stat['事件']['任务情报板']['待重扫'], { chatCount: 13, chat: aiTailChat13 }), false);
  assert.equal(questRescanDone(stat, 11, 13, { chat: waitUserChat13 }), false);
  assert.equal(questRescanDone(stat, 11, 13, { chat: aiTailChat13 }), true);

  stat = clearQuestRescan(stat).stat;
  assert.equal(stat['事件']['任务情报板']['待重扫'], undefined);
});

test('0 打勾单环支线：曾接取印记 + 历史楼层反查自动隐藏与清扫', () => {
  const boardList = [
    { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '找回丢失钥匙', 方式: '委托', 预期收益: ['金币 ×50'] },
    { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '清理地窖史莱姆', 方式: '悬赏', 预期收益: ['金币 ×80'] },
    { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '送信给铁匠', 方式: '委托', 预期收益: ['金币 ×40'] },
  ];

  // 场景 A：通过「曾接取」印记自动隐藏并清扫（0 打勾）
  const activeStat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-10日' },
    任务列表: { '找回丢失钥匙（个人）': { 状态: '进行中', 进展: '正在寻找' } },
    事件: { 任务情报板: { 区域键: '白石镇', 区域: '白石镇', 列表: boardList } },
  };
  assert.equal(needsQuestAcceptedRecord(activeStat), true);
  const recorded = recordAcceptedQuests(activeStat).stat;
  assert.deepEqual(recorded['事件']['任务情报板']['曾接取'], ['找回丢失钥匙']);

  // 下一轮任务已完成并从正式任务列表移除（且未打勾任何收益）
  const afterDone = JSON.parse(JSON.stringify(recorded));
  afterDone['任务列表'] = {};
  const viewA = questBoardState(afterDone);
  assert.equal(viewA.items.some((x) => x.title === '找回丢失钥匙'), false);
  assert.equal(hasClosedQuestLeftovers(afterDone), true);
  const sweptA = sweepClosedQuests(afterDone).stat;
  assert.equal(sweptA['事件']['任务情报板']['列表'].some((x) => x['标题'] === '找回丢失钥匙'), false);
  assert.equal(sweptA['事件']['任务情报板']['曾接取'], undefined);

  // 场景 B：玩家从未打开面板（无曾接取印记、0 打勾），仅靠历史楼层反查自动隐藏与清扫
  const historyChat = [
    {
      swipe_id: 0,
      variables: [
        {
          stat_data: {
            任务列表: { '清理地窖史莱姆（个人）': { 状态: '进行中' } },
            事件: { 任务情报板: { 列表: boardList } },
          },
        },
      ],
    },
  ];
  const currentWithoutRecord = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-10日' },
    任务列表: {},
    事件: { 任务情报板: { 区域键: '白石镇', 区域: '白石镇', 列表: boardList } },
  };
  const histStats = extractHistoryStats(historyChat);
  assert.equal(wasInHistoryFormalTasks(histStats, 'q2', '清理地窖史莱姆'), true);
  const viewB = questBoardState(currentWithoutRecord, { chat: historyChat });
  assert.equal(viewB.items.some((x) => x.title === '清理地窖史莱姆'), false);
  assert.equal(viewB.items.some((x) => x.title === '送信给铁匠'), true);
  assert.equal(hasClosedQuestLeftovers(currentWithoutRecord, { chat: historyChat }), true);
  const sweptB = sweepClosedQuests(currentWithoutRecord, { chat: historyChat }).stat;
  assert.equal(sweptB['事件']['任务情报板']['列表'].some((x) => x['标题'] === '清理地窖史莱姆'), false);
});

// ---------------------------------------------------------------------------
// 3. 配置一致性与边界回归测试
// ---------------------------------------------------------------------------

test('配置一致性：EJS @data-begin..@data-end 与 src/data.js 的 DATA 完全一致', () => {
  const m = ejsSource.match(/\/\/\s*@data-begin\s*\r?\nconst\s+_data\s*=\s*(\{[\s\S]*?\});\s*\r?\n\/\/\s*@data-end/);
  assert.ok(m, '未在 EJS 中找到 @data-begin..@data-end 区块');
  const ejsData = JSON.parse(m[1]);
  assert.deepEqual(ejsData, DATA);
});

test('null核心 1 天 CD 免费重扫：不扣 FP、同日限 1 次、次日恢复、EJS 提示免费重扫', () => {
  const baseStat = {
    命运点数: 20,
    世界: { 地点: '铁炉堡-东区', 时间: '复兴纪元488年-3月-10日-10:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        列表: [
          { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '旧委托', 方式: '委托', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };

  const st0 = readState(baseStat, { floor: 4, chatCount: 5, nullCore: true });
  assert.equal(st0.questBoard.nullCore, true);
  assert.equal(st0.questBoard.rescanCooldownToday, false);

  // 首次免费重扫：不扣 FP，即使 FP < 100 也放行，写入 上次重扫日
  const r1 = requestQuestRescan(baseStat, 4, 5, { nullCore: true });
  assert.ok(!r1.error);
  assert.strictEqual(r1.stat['命运点数'], 20);
  assert.equal(r1.stat['事件']['任务情报板']['上次重扫日'], '复兴纪元488年-3月-10日');

  // EJS 渲染 rescan 模式提示每日 1 次免费重扫，且保留 上次重扫日
  const out = renderEjs(r1.stat, { chat: new Array(6).fill({}), lastUserMessageId: 5, systemCore: 'null核心' });
  assertCleanOutput(out, 'nullcore-rescan');
  assert.match(out, /已启动今日免费地区情报重扫（每日 1 次）/);
  assert.match(out, /上次重扫日/);
  assert.doesNotMatch(out, /已支付 100 FP/);

  // 当 destinyImmersiveMode() 明确返回 false 时，即使聊天变量残留 'null核心' 也不再误判为 null核心
  const outOverridden = renderEjs(r1.stat, {
    chat: new Array(6).fill({}),
    lastUserMessageId: 5,
    systemCore: 'null核心',
    destinyImmersiveMode: () => false,
  });
  assert.match(outOverridden, /已支付 100 FP/);
  assert.doesNotMatch(outOverridden, /今日免费地区情报重扫/);

  // 兼容 SillyTavern variables 对象映射形态（Record<swipeId, vars>）
  const objVarHist = extractHistoryStats([
    {
      swipe_id: 1,
      variables: {
        1: { stat_data: { 任务列表: { '旧委托': { 状态: '进行中' } } } },
      },
    },
  ]);
  assert.equal(objVarHist.length, 1);
  assert.equal(objVarHist[0]['任务列表']['旧委托']['状态'], '进行中');

  // 清理 待重扫 后，同一天再次重扫应被 1 天 CD 拒绝
  const clearedSameDay = clearQuestRescan(r1.stat).stat;
  const stSame = readState(clearedSameDay, { floor: 6, chatCount: 8, nullCore: true });
  assert.equal(stSame.questBoard.rescanCooldownToday, true);
  const r2 = requestQuestRescan(clearedSameDay, 6, 8, { nullCore: true });
  assert.match(r2.error || '', /今日已重扫/);

  // 次日解除 CD，允许再次免费重扫
  const nextDayStat = JSON.parse(JSON.stringify(clearedSameDay));
  nextDayStat['世界']['时间'] = '复兴纪元488年-3月-11日-08:00';
  const stNext = readState(nextDayStat, { floor: 8, chatCount: 10, nullCore: true });
  assert.equal(stNext.questBoard.rescanCooldownToday, false);
  const r3 = requestQuestRescan(nextDayStat, 8, 10, { nullCore: true });
  assert.ok(!r3.error);
  assert.equal(r3.stat['事件']['任务情报板']['上次重扫日'], '复兴纪元488年-3月-11日');
});

test('空壳任务情报板（仅含 待重扫）时区分 insert/replace，不对不存在键输出 replace', () => {
  const shellStat = {
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-3月-11日-09:00' },
    事件: {
      任务情报板: {
        待重扫: { 楼层: '4', 消息数: '5' },
      },
    },
  };
  const out = renderEjs(shellStat, { chat: new Array(6).fill({}), lastUserMessageId: 5 });
  assertCleanOutput(out, 'shell-rescan');
  assert.match(out, /仅含控制字段，分别用 `insert` 写入 `\/事件\/任务情报板` 下的 `区域键`/);
  assert.doesNotMatch(out, /分别用 `replace` 更新 `\/事件\/任务情报板`/);

  const partialStat = {
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-3月-11日-09:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        待重扫: { 楼层: '4', 消息数: '5' },
      },
    },
  };
  const outPartial = renderEjs(partialStat, { chat: new Array(6).fill({}), lastUserMessageId: 5 });
  assertCleanOutput(outPartial, 'partial-shell');
  assert.match(outPartial, /对已存在键（`区域键`）用 `replace`、对缺失键（`区域`、`更新日`、`列表`）用 `insert`/);
});

test('收紧 matchFormalTask 防误杀 & 历史空板不误杀', () => {
  const formal = [{ key: '调查古堡密室', status: '进行中' }];
  // 短标题「调查」(< 4 字) 与长度比 < 0.75 的子串均不得误匹配
  assert.equal(matchFormalTask(formal, '调查'), null);
  assert.equal(matchFormalTask(formal, '调查古堡'), null); // 4/6 = 0.667 < 0.75
  // 长度均 >= 4 且比例 >= 0.75 可正常匹配
  assert.ok(matchFormalTask(formal, '调查古堡密室事件')); // 6/8 = 0.75
  // 去后缀精确匹配仍正常
  assert.ok(matchFormalTask([{ key: '短任务（个人）', status: '进行中' }], '短任务'));

  // 历史楼层有正式任务但无任务情报板列表时，不得误判已完结
  const histEmptyBoard = [
    {
      任务列表: { '护送商队': { 状态: '进行中' } },
      事件: {},
    },
  ];
  assert.equal(wasInHistoryFormalTasks(histEmptyBoard, 'q1', '护送商队'), false);

  // 未接取任务即使携带 进展:"尚未接取" 等占位/残留字段，前端也不得渲染「局势变动 / 最新进展」或触发红点
  const fakeProgStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-24日' },
    任务列表: {
      '已接主线': { 状态: '进行中', 进展: '[6月-24日] 已取得港口日志' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q_story', 类别: '剧情任务', 等级: 'B', 标题: '失踪的紫雾匣', 方式: '悬赏', 进展: '尚未接取', 更新日: '复兴纪元488年-6月-24日' },
          { id: 'q_main', 类别: '本地主线', 等级: 'C', 标题: '已接主线', 方式: '调查' },
        ],
      },
    },
  };
  const fakeProgBoard = questBoardState(fakeProgStat);
  assert.equal(fakeProgBoard.items[0].accepted, false);
  assert.equal(fakeProgBoard.items[0].progress, '');
  assert.equal(fakeProgBoard.items[1].accepted, true);
  assert.equal(fakeProgBoard.items[1].progress, '[6月-24日] 已取得港口日志');
  assert.doesNotMatch(fakeProgBoard.progressSignature, /尚未接取/);
});

test('EJS 日期解析：支持无年份/无连字符中文日期，拒绝版本号与无效月日', () => {
  const makeStat = (progress) => ({
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-20日-10:00' },
    任务列表: {
      '白石暗潮': { 状态: '进行中', 进展: progress },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-19日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 预期收益: ['史诗护符 ×1'], 更新日: '复兴纪元488年-3月-19日' },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '商队失联', 方式: '调查', 预期收益: ['金币 ×300'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '信件投递', 方式: '委托', 预期收益: ['金币 ×80'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '修缮栅栏', 方式: '委托', 预期收益: ['金币 ×60'] },
        ],
      },
    },
  });

  // 无年份中文月日：[3月-10日] 距 3月-20日 搁置 10 日 -> 触发演进
  const outNoYear = renderEjs(makeStat('[3月-10日] 取得初步线索'));
  assertCleanOutput(outNoYear, 'date-no-year');
  assert.match(outNoYear, /待演进:已搁置 10 天/);

  // 无连字符中文年月日：[488年3月12日] 距 3月-20日 搁置 8 日 -> 触发演进
  const outNoDash = renderEjs(makeStat('[488年3月12日] 追踪到码头'));
  assertCleanOutput(outNoDash, 'date-no-dash');
  assert.match(outNoDash, /待演进:已搁置 8 天/);

  // 版本号 v1.2.3 与无效月日 488-13-40 不应被误判为旧日期（回退到更新日 3月-19日，仅 1 日不演进）
  const outVer = renderEjs(makeStat('检查了装置 v1.2.3 与编号 488-13-40'));
  assertCleanOutput(outVer, 'date-version-guard');
  assert.doesNotMatch(outVer, /待演进/);
});

test('字符串形态 已兑现/预期收益 切换与校验 & 重扫有效期前后端一致', () => {
  let stat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-10日' },
    任务列表: { '白石暗潮': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        已兑现: { q1: '1、金币 ×500' },
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 预期收益: '史诗武器 ×1、金币 ×500' },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '未命中收益测试', 方式: '委托', 预期收益: '药剂 ×2' },
        ],
      },
    },
  };

  // 字符串形态 已兑现 也能被 toggleQuestRewardClaimed 正确识别并取消勾选
  const res1 = toggleQuestRewardClaimed(stat, 'q1', 1, '白石暗潮');
  assert.ok(!res1.error);
  assert.deepEqual(res1.stat['事件']['任务情报板']['已兑现']['q1'], ['金币 ×500']);

  // 已兑现 写了不存在的栏号/无效文本时，isQuestEntryClosed 不得误判未接取任务已完结
  const invalidClaimStat = JSON.parse(JSON.stringify(stat));
  invalidClaimStat['事件']['任务情报板']['已兑现']['q2'] = ['不存在的奖励'];
  assert.equal(hasClosedQuestLeftovers(invalidClaimStat), false);

  // 重扫有效期前后端一致：atCount = 5 -> nowCount = 6 有效，nowCount = 7 失效
  const rescanStat = {
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-3月-10日' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        待重扫: { 楼层: '4', 消息数: '5' },
        列表: [
          { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '旧委托', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '旧委托2', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '旧委托3', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '旧委托4', 方式: '委托', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  assert.equal(questBoardState(rescanStat, { floor: 5, chatCount: 6 }).rescanPending, true);
  assert.match(renderEjs(rescanStat, { chat: new Array(6).fill({}), lastUserMessageId: 5 }), /启动地区情报重扫/);
  assert.equal(questBoardState(rescanStat, { floor: 6, chatCount: 7 }).rescanPending, false);
  assert.doesNotMatch(renderEjs(rescanStat, { chat: new Array(7).fill({}), lastUserMessageId: 6 }), /启动地区情报重扫/);
});

test('对象型列表 rawKey 保留、RFC 6901 转义、多条结案倒序提示与单次合并维护', () => {
  const stat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-10日' },
    任务列表: {
      '特殊键任务': { 状态: '进行中' },
      '已完结任务': { 状态: '已完成' },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-10日',
        待重扫: { 楼层: '1', 消息数: '2' },
        已兑现: {},
        列表: {
          'a/b~c': { id: 'inner_should_not_override', 类别: '支线任务', 等级: 'D', 标题: '特殊键任务', 方式: '委托', 预期收益: ['金币 ×50'] },
          'done_key': { 类别: '支线任务', 等级: 'D', 标题: '已完结任务', 方式: '委托', 预期收益: ['金币 ×30'] },
        },
      },
    },
  };

  // 对象型列表外层键名保留为 id，不被内层 id 覆盖
  const st = questBoardState(stat);
  const item = st.items.find((x) => x.title === '特殊键任务');
  assert.equal(item.id, 'a/b~c');

  // EJS 对 / 和 ~ 进行 RFC 6901 转义，且输出结案倒序规则与对象键名
  const out = renderEjs(stat, { chat: new Array(10).fill({}), lastUserMessageId: 9 });
  assertCleanOutput(out, 'obj-list-escape');
  assert.match(out, /\/事件\/任务情报板\/已兑现\/a~1b~0c/);
  assert.match(out, /\/事件\/任务情报板\/列表\/a~1b~0c/);
  assert.match(out, /按索引从大到小倒序 `remove`/);
  assert.match(out, /已完结任务\(键done_key\)/);

  // maintainQuestBoard 单次顺序完成清重扫 + 扫完结 + 登记曾接取
  const maintained = maintainQuestBoard(stat, { floor: 9, chatCount: 10 });
  assert.ok(!maintained.skip);
  assert.equal(maintained.stat['事件']['任务情报板']['待重扫'], undefined);
  assert.equal(maintained.stat['事件']['任务情报板']['列表']['done_key'], undefined);
  assert.deepEqual(maintained.stat['事件']['任务情报板']['曾接取'], ['特殊键任务']);
});

test('跨年无年份日期借用上年，正确触发搁置演进', () => {
  const crossYearStat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元489年-1月-2日-09:00' },
    任务列表: {
      '极夜裂隙': { 状态: '进行中', 进展: '[12月-26日] 发现裂隙扩散' },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-12月-26日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '极夜裂隙', 方式: '异象', 预期收益: ['传说武器 ×1'], 更新日: '复兴纪元488年-12月-26日' },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '商队失联', 方式: '调查', 预期收益: ['金币 ×300'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '信件投递', 方式: '委托', 预期收益: ['金币 ×80'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '修缮栅栏', 方式: '委托', 预期收益: ['金币 ×60'] },
        ],
      },
    },
  };
  const out = renderEjs(crossYearStat);
  assertCleanOutput(out, 'cross-year-md');
  assert.match(out, /剧情任务搁置演进/);
  assert.match(out, /待演进:已搁置 7 天/);
});

test('区域与世界词条持久化：按当前区域精准注入、异区 0 注入、新区域默认词条提示与格式规则', () => {
  const baseBoard = {
    区域键: '铁炉堡',
    区域: '铁炉堡',
    更新日: '复兴纪元488年-3月-10日',
    列表: [
      { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '修补矿车', 方式: '委托', 预期收益: ['金币 ×50'] },
      { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '运送炭火', 方式: '委托', 预期收益: ['金币 ×60'] },
      { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '巡查矿道', 方式: '委托', 预期收益: ['金币 ×70'] },
      { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '清点铁锭', 方式: '委托', 预期收益: ['金币 ×80'] },
    ],
  };

  // 1) 无余波节点：0 注入 当前词条，且提示首次写入用 insert /事件/任务情报板/余波
  const noAftermathStat = {
    世界: { 地点: '铁炉堡-商业街', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: { 任务情报板: baseBoard },
  };
  const outNone = renderEjs(noAftermathStat);
  assertCleanOutput(outNone, 'aftermath-none');
  assert.doesNotMatch(outNone, /当前词条（持续生效的客观现状）/);
  assert.match(outNone, /区域与世界词条:/);
  assert.match(outNone, /\[绿\/黄\/红\]【2~6字短标签】30~50字客观现状/);
  assert.doesNotMatch(outNone, /默认写入 3 条常驻词条/, 'maintain 常规停留不应冗余注入初始 3 条词条规则');
  assert.doesNotMatch(outNone, /离开满 14 天/, 'maintain 常规停留不应冗余注入 14 天重返规则');
  assert.match(outNone, /禁止以 <user> 或冒险者为主语写战绩记录/);
  assert.match(outNone, /支线任务与日常琐事不改写词条/);
  assert.match(outNone, /非任务的重大剧情与事件链变故（如敌对势力袭击城镇/);
  assert.match(outNone, /并随局势同步升降色阶（恶化转黄或升红，好转降黄或转绿/);
  assert.match(outNone, /发生重大剧情或事件链变故时按规则更新区域或世界词条/);
  assert.match(outNone, /`世界` 词条同样使用 `\[绿\/黄\/红\]` 色阶，不默认生成，仅剧情任务或重大剧情与事件链引发的跨大区或全大陆级重大后果允许写入或改写 `世界`/);
  assert.match(outNone, /禁止整块覆写 `\/事件` 或 `\/事件\/任务情报板`/);
  assert.match(outNone, /"op": "insert", "path": "\/事件\/任务情报板\/余波"/);

  // 1.5) init 与 relocate 且当前区域无词条时，注入初始 3 条差异化色阶与叠加限时规则，并提示记录区域访问日
  const outInit = renderEjs({
    世界: { 地点: '霜语城-港口', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {},
  });
  assertCleanOutput(outInit, 'aftermath-init-hint');
  assert.match(outInit, /默认写入 3 条常驻词条/);
  assert.match(outInit, /分属不同维度.*彼此逻辑自洽，不重复、不自相矛盾/);
  assert.match(outInit, /禁止 3 绿、3 黄、3 红/);
  assert.match(outInit, /不得每区机械套用 1 绿 1 黄 1 红/);
  assert.match(outInit, /当地正有短期活动时应先写满 3 条常驻词条，再额外追加 1~2 条限时词条/);
  assert.match(outInit, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时额外叠加 1~2 条限时词条），并记录区域访问日/);
  assert.match(outInit, /"区域访问日": \{ "港口": "复兴纪元488年-3月-11日" \}/);

  // 1.6) relocate 返回旧区域时，保留字段清单与 14 天重返规则均应注入
  const outRelocBack = renderEjs({
    世界: { 地点: '雾晶港-码头', 时间: '复兴纪元488年-3月-28日-10:00' },
    事件: {
      任务情报板: {
        ...baseBoard,
        余波: { 雾晶港: ['[绿]【港口畅通】商船往来频繁。'] },
        区域访问日: { 雾晶港: '复兴纪元488年-3月-10日' },
      },
    },
  });
  assertCleanOutput(outRelocBack, 'aftermath-reloc-back');
  assert.match(outRelocBack, /离开满 14 天/);
  assert.match(outRelocBack, /明确剧情变故、已到期的预告事件/);
  assert.match(outRelocBack, /保留「意向」「忽略」「已兑现」「已失效」「曾接取」「上次重扫日」「余波」「区域访问日」/);

  const outRelocateNoTrait = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outRelocateNoTrait, 'aftermath-relocate-hint');
  assert.match(outRelocateNoTrait, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时额外叠加 1~2 条限时词条），并记录区域访问日/);
  assert.match(outRelocateNoTrait, /"op": "insert", "path": "\/事件\/任务情报板\/区域访问日"/);

  const outRelocateHasTrait = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        ...baseBoard,
        余波: {
          瓦伦蒂亚: ['[黄]【商税上调】城邦议会提高外港关税，城内香料与布匹零售价普涨两成。'],
        },
      },
    },
  });
  assertCleanOutput(outRelocateHasTrait, 'aftermath-relocate-has-trait');
  assert.doesNotMatch(outRelocateHasTrait, /为当前区域写入 3 条差异化色阶的初始常驻词条/);
  assert.match(outRelocateHasTrait, /返回旧区域（首次记录访问日）：无明确剧情变故或到期预告事件时保持原词条不变，并记录区域访问日/);

  // 2) 有地区词条但处于异区且无世界词条：异区 0 token 注入
  const otherRegionStat = {
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        ...baseBoard,
        区域键: '瓦伦蒂亚',
        区域: '瓦伦蒂亚',
        余波: {
          铁炉堡: ['【矿区封禁】旧铸造区坍塌封禁，城内精铁与武器收购价上涨三成，卫兵在南门设卡盘查外乡人。'],
        },
      },
    },
  };
  const outOther = renderEjs(otherRegionStat);
  assertCleanOutput(outOther, 'aftermath-other-region');
  assert.doesNotMatch(outOther, /当前词条（持续生效的客观现状）/);
  assert.doesNotMatch(outOther, /旧铸造区坍塌封禁/);
  assert.match(outOther, /对已有区域键用 `replace`、新区域键用 `insert` 更新 `\/事件\/任务情报板\/余波\/<区域名或世界>`/);
  const stOther = questBoardState(otherRegionStat);
  assert.deepEqual(stOther.aftermath, { local: [], world: [], localEntries: [], worldEntries: [] });

  // 3) 处于本区且含世界词条：精准注入本区 + 世界，且不混入其他城市，单类最多 3 条
  const localAndWorldStat = {
    世界: { 地点: '铁炉堡-铁砧酒馆', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        ...baseBoard,
        余波: {
          铁炉堡: [
            '旧条1',
            '【税卡增设】旧条2',
            '旧条3',
            '【高炉重启】南门高炉重启后黑烟终日不散，城防军接管矿业税局，铁锭价格回落但走私案激增。',
          ],
          雾晶港: ['【灯塔损毁】雾晶港灯塔损毁，夜航商船被迫改道北湾。'],
          世界: ['【霜潮封路】北境商路因霜潮封冻中断，各大主城魔导燃料配给收紧，边境流民向南涌入。'],
        },
      },
    },
  };
  const outLocal = renderEjs(localAndWorldStat);
  assertCleanOutput(outLocal, 'aftermath-local-world');
  assert.match(outLocal, /当前词条（持续生效的客观现状）:/);
  assert.match(outLocal, /本区词条（键: `铁炉堡`，已存在）:/);
  assert.match(outLocal, /世界词条:/);
  assert.match(outLocal, /南门高炉重启后黑烟终日不散/);
  assert.match(outLocal, /北境商路因霜潮封冻中断/);
  assert.doesNotMatch(outLocal, /旧条1/);
  assert.doesNotMatch(outLocal, /雾晶港灯塔损毁/);

  const stLocal = questBoardState(localAndWorldStat);
  assert.equal(stLocal.aftermath.local.length, 3);
  assert.deepEqual(stLocal.aftermath.local, [
    '【税卡增设】旧条2',
    '旧条3',
    '【高炉重启】南门高炉重启后黑烟终日不散，城防军接管矿业税局，铁锭价格回落但走私案激增。',
  ]);
  assert.deepEqual(stLocal.aftermath.world, [
    '【霜潮封路】北境商路因霜潮封冻中断，各大主城魔导燃料配给收紧，边境流民向南涌入。',
  ]);
  assert.deepEqual(stLocal.aftermath.localEntries, [
    {
      key: '铁炉堡',
      index: 1,
      text: '【税卡增设】旧条2',
      tone: '',
      tag: '税卡增设',
      body: '旧条2',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
    {
      key: '铁炉堡',
      index: 2,
      text: '旧条3',
      tone: '',
      tag: '',
      body: '旧条3',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
    {
      key: '铁炉堡',
      index: 3,
      text: '【高炉重启】南门高炉重启后黑烟终日不散，城防军接管矿业税局，铁锭价格回落但走私案激增。',
      tone: '',
      tag: '高炉重启',
      body: '南门高炉重启后黑烟终日不散，城防军接管矿业税局，铁锭价格回落但走私案激增。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  ]);
  assert.deepEqual(stLocal.aftermath.worldEntries, [
    {
      key: '世界',
      index: 0,
      text: '【霜潮封路】北境商路因霜潮封冻中断，各大主城魔导燃料配给收紧，边境流民向南涌入。',
      tone: '',
      tag: '霜潮封路',
      body: '北境商路因霜潮封冻中断，各大主城魔导燃料配给收紧，边境流民向南涌入。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  ]);
});

test('返回旧区域 14 天演变防抖：离开 < 14 天保持稳定（保留剧情变故例外），>= 14 天触发演进，且同步更新旧区离开日', () => {
  const baseBoard = {
    区域键: '铁炉堡',
    区域: '铁炉堡',
    更新日: '复兴纪元488年-3月-12日',
    区域访问日: {
      铁炉堡: '复兴纪元488年-3月-12日',
      瓦伦蒂亚: '复兴纪元488年-3月-10日',
    },
    余波: {
      瓦伦蒂亚: [
        '[绿]【海贸兴旺】外港商船泊位满载，香料与织物交易量持续走高。',
        '[黄]【税卡增设】城邦议会在南门增设稽查税卡，入城商队排队耗时拉长。',
      ],
    },
    列表: [
      { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '修补矿车', 方式: '委托', 预期收益: ['金币 ×50'] },
    ],
  };

  // 1) 离开 3 天（< 14 天）：保持原词条不变，保留明确剧情变故例外，且同时 replace 更新旧区与新区区域访问日
  const outShort = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-13日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outShort, 'revisit-short');
  assert.match(outShort, /返回旧区域（离开不足 14 天）：无明确剧情变故或到期预告事件时保持原词条不变，并更新区域访问日/);
  assert.match(outShort, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/铁炉堡", "value": "复兴纪元488年-3月-13日"/);
  assert.match(outShort, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/瓦伦蒂亚", "value": "复兴纪元488年-3月-13日"/);

  // 2) 离开 16 天（>= 14 天）：触发演进提示，且同时更新旧区与新区区域访问日
  const outLong = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-26日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outLong, 'revisit-long');
  assert.match(outLong, /返回旧区域（已离开 16 天）：按上方词条规则演进或改写本区最多 1 条词条（没有明显变化时保持不变），并更新区域访问日/);
  assert.match(outLong, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/铁炉堡", "value": "复兴纪元488年-3月-26日"/);
  assert.match(outLong, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/瓦伦蒂亚", "value": "复兴纪元488年-3月-26日"/);

  // 3) 已有区域访问日对象但迁入从未访问过的新城：旧区 replace、新区 insert
  const outNewCity = renderEjs({
    世界: { 地点: '雾晶港-北码头', 时间: '复兴纪元488年-3月-26日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outNewCity, 'revisit-new-city');
  assert.match(outNewCity, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时额外叠加 1~2 条限时词条），并记录区域访问日/);
  assert.match(outNewCity, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/铁炉堡", "value": "复兴纪元488年-3月-26日"/);
  assert.match(outNewCity, /"op": "insert", "path": "\/事件\/任务情报板\/区域访问日\/雾晶港", "value": "复兴纪元488年-3月-26日"/);

  // 4) 无区域访问日对象时换区：合并写入旧区与新区到同一个 insert 对象
  const noVisitBoard = { ...baseBoard };
  delete noVisitBoard['区域访问日'];
  const outNoVisitRelocate = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-20日-10:00' },
    事件: { 任务情报板: noVisitBoard },
  });
  assertCleanOutput(outNoVisitRelocate, 'revisit-no-visit-map');
  assert.match(outNoVisitRelocate, /返回旧区域（首次记录访问日）：无明确剧情变故或到期预告事件时保持原词条不变，并记录区域访问日/);
  assert.match(
    outNoVisitRelocate,
    /"op": "insert", "path": "\/事件\/任务情报板\/区域访问日", "value": \{ "铁炉堡": "复兴纪元488年-3月-20日", "瓦伦蒂亚": "复兴纪元488年-3月-20日" \}/,
  );
});

test('精确历法 31 日跨月差值、首次建板空日期与空壳板 rescan 补写区域访问日', () => {
  // 1) 3 月有 31 天：3月18日 -> 4月1日 真实间隔 14 天（刚好触发 >= 14 天演进）
  const board31 = {
    区域键: '铁炉堡',
    区域: '铁炉堡',
    更新日: '复兴纪元488年-3月-31日',
    区域访问日: {
      铁炉堡: '复兴纪元488年-3月-31日',
      瓦伦蒂亚: '复兴纪元488年-3月-18日',
    },
    余波: {
      瓦伦蒂亚: ['[黄]【商税上调】城邦议会提高外港关税，布匹零售价普涨两成。'],
    },
    列表: [
      { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '修补矿车', 方式: '委托', 预期收益: ['金币 ×50'] },
    ],
  };
  const out14 = renderEjs({
    世界: { 地点: '瓦伦蒂亚-广场', 时间: '复兴纪元488年-4月-1日-09:00' },
    事件: { 任务情报板: board31 },
  });
  assertCleanOutput(out14, 'calendar-31-exact-14');
  assert.match(out14, /返回旧区域（已离开 14 天）/);

  // 3月31日 -> 4月1日 仅隔 1 天（旧 30 天近似会算成 0 或 2 天，现应准确为不足 14 天）
  const board1 = {
    ...board31,
    区域访问日: { 铁炉堡: '复兴纪元488年-3月-31日', 瓦伦蒂亚: '复兴纪元488年-3月-31日' },
  };
  const out1 = renderEjs({
    世界: { 地点: '瓦伦蒂亚-广场', 时间: '复兴纪元488年-4月-1日-09:00' },
    事件: { 任务情报板: board1 },
  });
  assertCleanOutput(out1, 'calendar-31-exact-1');
  assert.match(out1, /返回旧区域（离开不足 14 天）/);

  // 2) 首次建板时若世界时间为空，省略 "区域访问日" 字段且 JSON 合法转义
  const outEmptyDay = renderEjs({
    世界: { 地点: '带"引号"之城', 时间: '' },
    事件: {},
  });
  assertCleanOutput(outEmptyDay, 'init-empty-day-escape');
  assert.doesNotMatch(outEmptyDay, /"区域访问日":/);
  assert.match(outEmptyDay, /"区域": "带\\"引号\\"之城"/);

  // 3) 空壳板 rescan 补齐基础键时同样输出区域访问日 Patch，且 update 正确显示未建立并使用 insert
  const shellRescanStat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-4月-2日-10:00' },
    事件: { 任务情报板: { 待重扫: { 消息数: '5' } } },
  };
  const outShellRescan = renderEjs(
    shellRescanStat,
    { chat: Array.from({ length: 5 }, () => ({ mes: '' })) },
  );
  assertCleanOutput(outShellRescan, 'shell-rescan-visit-day');
  assert.match(outShellRescan, /"op": "insert", "path": "\/事件\/任务情报板\/区域访问日", "value": \{ "白石镇": "复兴纪元488年-4月-2日" \}/);
  assert.match(outShellRescan, /整表 `insert` 写入 `列表`/);
  const shellUpdateOut = renderEjs(shellRescanStat, {
    chat: Array.from({ length: 5 }, () => ({ mes: '' })),
    source: ejsSource.replace("const _wbRole = 'all';", "const _wbRole = 'update';").replace('// @role all', '// @role update'),
  });
  assert.match(shellUpdateOut, /列表形态：未建立/);
  assert.match(shellUpdateOut, /整表 `insert` 写入 `列表`/);
});

test('parseAftermathEntry 与 deleteAftermathEntry：三色前缀与短标签兼容解析、精准删除与空节点清理', () => {
  assert.deepEqual(
    parseAftermathEntry('[绿]【商队云集】东门集市日夜不息，药材与魔导晶供应充裕。'),
    {
      text: '[绿]【商队云集】东门集市日夜不息，药材与魔导晶供应充裕。',
      tone: 'green',
      tag: '商队云集',
      body: '东门集市日夜不息，药材与魔导晶供应充裕。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('[黄]【商税上调】城邦议会提高外港关税，布匹零售价普涨两成。'),
    {
      text: '[黄]【商税上调】城邦议会提高外港关税，布匹零售价普涨两成。',
      tone: 'yellow',
      tag: '商税上调',
      body: '城邦议会提高外港关税，布匹零售价普涨两成。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('[红]【城门戒严】北境魔潮逼近，入城须逐车盘查并实行宵禁。'),
    {
      text: '[红]【城门戒严】北境魔潮逼近，入城须逐车盘查并实行宵禁。',
      tone: 'red',
      tag: '城门戒严',
      body: '北境魔潮逼近，入城须逐车盘查并实行宵禁。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('【红】 城外突发异变，南门暂时关闭。'),
    {
      text: '【红】 城外突发异变，南门暂时关闭。',
      tone: 'red',
      tag: '',
      body: '城外突发异变，南门暂时关闭。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('【港口戒严】 夜间禁止商船靠岸，入城货物须经海军检查。'),
    {
      text: '【港口戒严】 夜间禁止商船靠岸，入城货物须经海军检查。',
      tone: '',
      tag: '港口戒严',
      body: '夜间禁止商船靠岸，入城货物须经海军检查。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('旧版纯文本余波词条无短标签。'),
    {
      text: '旧版纯文本余波词条无短标签。',
      tone: '',
      tag: '',
      body: '旧版纯文本余波词条无短标签。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );

  const stat = {
    世界: { 地点: '铁炉堡-商业街' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        余波: {
          铁炉堡: ['【高炉重启】黑烟不散。', '【矿区封禁】精铁涨价三成。'],
          世界: ['【霜潮封路】北境商路中断。'],
        },
      },
    },
  };

  // 1) 精准删除数组第 0 项
  const r1 = deleteAftermathEntry(stat, '铁炉堡', 0, '【高炉重启】黑烟不散。');
  assert.equal(r1.done, '已删除词条');
  assert.deepEqual(r1.stat.事件.任务情报板.余波.铁炉堡, ['【矿区封禁】精铁涨价三成。']);
  assert.deepEqual(r1.stat.事件.任务情报板.余波.世界, ['【霜潮封路】北境商路中断。']);

  // 2) 下标偏移时按 expectedText 兜底查找删除，数组删空时移除空键
  const r2 = deleteAftermathEntry(r1.stat, '铁炉堡', 99, '【矿区封禁】精铁涨价三成。');
  assert.equal(r2.done, '已删除词条');
  assert.equal(Object.prototype.hasOwnProperty.call(r2.stat.事件.任务情报板.余波, '铁炉堡'), false);
  assert.deepEqual(r2.stat.事件.任务情报板.余波.世界, ['【霜潮封路】北境商路中断。']);

  // 3) 余波对象删空时移除整个 余波 字段
  const r3 = deleteAftermathEntry(r2.stat, '世界', 0, '【霜潮封路】北境商路中断。');
  assert.equal(r3.done, '已删除词条');
  assert.equal(Object.prototype.hasOwnProperty.call(r3.stat.事件.任务情报板, '余波'), false);

  // 4) 目标不存在返回错误
  const r4 = deleteAftermathEntry(r3.stat, '世界', 0, '【霜潮封路】北境商路中断。');
  assert.equal(r4.error, '未找到要删除的词条');
  const r5 = deleteAftermathEntry(stat, '铁炉堡', 5, '不存在的词条');
  assert.equal(r5.error, '未找到要删除的词条');

  // 5) 多行正文与空正文不丢标签
  assert.deepEqual(
    parseAftermathEntry('[黄]【商路受阻】第一行现状。\n第二行补充说明。'),
    {
      text: '[黄]【商路受阻】第一行现状。\n第二行补充说明。',
      tone: 'yellow',
      tag: '商路受阻',
      body: '第一行现状。\n第二行补充说明。',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );
  assert.deepEqual(
    parseAftermathEntry('[红]【全城戒严】'),
    {
      text: '[红]【全城戒严】',
      tone: 'red',
      tag: '全城戒严',
      body: '',
      until: '',
      isTemp: false,
      daysLeft: null,
      expired: false,
    },
  );

  // 6) 带前后空白的异常区域键：questBoardState 保留原始 key，deleteAftermathEntry 精确匹配与 trim 回退均可删除
  const paddedKeyStat = {
    世界: { 地点: '铁炉堡-商业街' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        余波: {
          ' 铁炉堡 ': ['[绿]【矿脉丰收】新矿道产出稳定。'],
        },
      },
    },
  };
  const qbPadded = questBoardState(paddedKeyStat);
  assert.equal(qbPadded.aftermath.localEntries.length, 1);
  assert.equal(qbPadded.aftermath.localEntries[0].key, ' 铁炉堡 ');
  const delRaw = deleteAftermathEntry(paddedKeyStat, ' 铁炉堡 ', 0, '[绿]【矿脉丰收】新矿道产出稳定。');
  assert.equal(delRaw.done, '已删除词条');
  assert.equal(Object.prototype.hasOwnProperty.call(delRaw.stat.事件.任务情报板, '余波'), false);
  const delTrimFallback = deleteAftermathEntry(paddedKeyStat, '铁炉堡', 0, '[绿]【矿脉丰收】新矿道产出稳定。');
  assert.equal(delTrimFallback.done, '已删除词条');
  assert.equal(Object.prototype.hasOwnProperty.call(delTrimFallback.stat.事件.任务情报板, '余波'), false);
});

test('剧情追加规则与参考配额非硬上限断言', () => {
  const stat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-10日-12:00' },
    事件: {},
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'story-on-wall');
  assert.match(out, /剧情追加/);
  assert.match(out, /不受参考配额限制/);
  assert.match(out, /\/事件\/任务情报板\/列表\/-/);
  assert.match(out, /按体量定级：剧情任务/);
  assert.match(out, /剧情任务与本地主线附加 `真相`/);
  assert.match(out, /下列条数为参考配额，剧情追加不受上限限制/);
});

test('EJS 长线波折结构（init）：分级波折、三要素暗牌真相与余波衍生任务', () => {
  const stat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日-12:00' },
    事件: {},
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'twist-init');
  assert.match(out, /①表里落差/);
  assert.match(out, /②多方筹码/);
  assert.match(out, /③未解代价/);
  assert.match(out, /采用三段式波折/);
  assert.match(out, /多线轮换悬疑反转、多方竞速、灾变探索、护送破局等骨架/);
  assert.match(out, /含 1 次认知偏差或利益取舍/);
  assert.match(out, /直接推进不设反转/);
  assert.match(out, /优先从本区与世界现有 `\[黄\]\/\[红\]` 词条矛盾中衍生委托或线索/);
  assert.match(out, /可在对应区域同步写入 1 条 `\[黄\]` 隐患词条/);
});

test('EJS 长线波折结构（maintain）：波折节拍、失败前进、禁空降反派且不引入选择题', () => {
  const stat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日-12:00' },
    任务列表: {
      '暗潮港湾': { 状态: '进行中', 进展: '[488年-6月-12日] 刚接触码头工团。' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-12日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '暗潮港湾', 方式: '调查', 摘要: '港口账册失窃', 真相: '三方争夺潮闸钥匙', 更新日: '488年-6月-12日', 预期收益: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
          { id: 'q2', 类别: '本地主线', 等级: 'B', 标题: '仓库暗影', 方式: '探索', 摘要: '旧仓库异响', 真相: '走私与商会共谋', 预期收益: ['1', '2', '3', '4', '5'] },
          { id: 'q3', 类别: '支线任务', 等级: 'C', 标题: '找回商船日志', 方式: '委托', 摘要: '船长丢了日志', 预期收益: ['1', '2', '3'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '清理水鬼', 方式: '悬赏', 摘要: '南码头出现水鬼', 预期收益: ['1', '2', '3'] },
          { id: 'q5', 类别: '支线任务', 等级: 'C', 标题: '运送灯油', 方式: '委托', 摘要: '灯塔缺油', 预期收益: ['1', '2', '3'] },
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'twist-maintain');
  assert.doesNotMatch(out, /生成规格/);
  assert.match(out, /已接取的剧情任务按跨城\/跨大区三段式长线推进/);
  assert.match(out, /波折节拍:/);
  assert.match(out, /按 `预期收益` 累计已结算份额（已兑现与已失效合计，栏位高价值在前、基础在后）控制节奏/);
  assert.match(out, /NPC 不首轮揭示 `真相`/);
  assert.match(out, /中段（累计已结算 3~6 栏 \/ 本地主线 2~3 栏份额）触发旧线索重新解释或第三方争夺筹码/);
  assert.match(out, /终局前（累计已结算 7~9 栏 \/ 本地主线 4 栏份额）触发不可逆代价取舍/);
  assert.match(out, /以替代战利品置换约定尾款，守住剩余有效收益底线/);
  assert.match(out, /终局不临时引入缺乏铺垫的反派或万能解法/);
  assert.match(out, /交涉破裂、潜入暴露或击杀关键 NPC 时不阻断推进/);
  assert.match(out, /限时项拖过关键节点关闭最优窗口转入补救/);
  assert.doesNotMatch(out, /选择题|决策卡|quest_choice/);
});

test('EJS 长线波折结构（advance）与全模式去古风/语体回归', () => {
  const initOut = renderEjs({ 世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' }, 事件: {} });
  const advOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-20日' },
    任务列表: {
      '暗潮港湾': { 状态: '进行中', 进展: '[488年-6月-10日] 刚拿到第一份证词。' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-10日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '暗潮港湾', 方式: '调查', 摘要: '港口账册失窃', 真相: '三方争夺潮闸钥匙', 更新日: '488年-6月-10日', 预期收益: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
          { id: 'q2', 类别: '本地主线', 等级: 'B', 标题: '仓库暗影', 方式: '探索', 摘要: '旧仓库异响', 真相: '走私与商会共谋', 预期收益: ['1', '2', '3', '4', '5'] },
          { id: 'q3', 类别: '支线任务', 等级: 'C', 标题: '找回商船日志', 方式: '委托', 摘要: '船长丢了日志', 预期收益: ['1', '2', '3'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '清理水鬼', 方式: '悬赏', 摘要: '南码头出现水鬼', 预期收益: ['1', '2', '3'] },
          { id: 'q5', 类别: '支线任务', 等级: 'C', 标题: '运送灯油', 方式: '委托', 摘要: '灯塔缺油', 预期收益: ['1', '2', '3'] },
        ],
      },
    },
  });
  assertCleanOutput(advOut, 'twist-advance');
  assert.match(advOut, /第 1 步筹码转移或原路失效；第 2 步冲突公开化、中间站恶化；第 3 步造成不可逆后果/);
  assert.match(advOut, /继续搁置按失败结案并移出 `\/任务列表` 与任务情报板/);
  assert.match(advOut, /静默同步至 `\/任务列表`（不双写任务情报板），需要时在正文中通过当地传闻或情报渠道自然带出一句/);

  for (const sample of [initOut, advOut]) {
    assert.doesNotMatch(sample, /玩家|白嫖|刷好感|一口气|找乐子/);
    assert.doesNotMatch(sample, /皆|亦|乃|均可|血气|斗气|以太|灵气|渡劫|飞升/);
    assert.doesNotMatch(sample, /选择题|决策卡|quest_choice/);
  }
});

test('前端自动聚合未上墙的原版 /任务列表 进行中任务（去重、过滤已完结、只读标记）', () => {
  const stat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-12日-10:00' },
    任务列表: {
      '白石暗潮（个人）': {
        状态: '进行中',
        详情: '已在板上接取的任务',
        目标: '潜入仓库',
        进展: '拿到钥匙',
        奖励: '金币 ×500',
      },
      '星辉遗迹的呼唤': {
        状态: '进行中',
        详情: '剧情向突发事件，A级高危遗迹调查。',
        目标: '前往星辉谷入口会合',
        进展: '已获得残破星图',
        奖励: '传说级法杖 ×1、星辰结晶 ×3',
      },
      '镇长失踪之谜': {
        状态: '进行中',
        详情: '本地主线调查，B 级难度。',
        目标: '盘问酒馆掌柜',
        进展: '锁定嫌疑人',
        奖励: '金币 ×800',
      },
      '帮铁匠送铁锤': {
        状态: '进行中',
        详情: '顺手帮铁匠铺送货到城门哨所。',
        目标: '交给北门卫兵',
        进展: '',
        奖励: '银币 ×30',
      },
      '已完成的旧委托': {
        状态: '已完成',
        详情: '应该被过滤掉',
        目标: '无',
        进展: '已交差',
        奖励: '金币 ×100',
      },
      '已失败的护送': {
        状态: '已失败',
        详情: '应该被过滤掉',
      },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        更新日: '复兴纪元488年-3月-10日',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '白石暗潮', 方式: '调查', 预期收益: ['史诗武器 ×1'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '草药采集', 方式: '委托', 预期收益: ['药剂 ×2'] },
        ],
      },
    },
  };

  const qb = questBoardState(stat);
  // 2 条板上任务 + 3 条未上墙进行中原版任务 = 5 条（2 条已完结不聚合，1 条已上墙不重复）
  assert.equal(qb.items.length, 5);
  assert.equal(qb.counts.total, 5);
  assert.equal(qb.counts.accepted, 4);
  assert.equal(qb.counts.editableAccepted, 1);

  const boardAccepted = qb.items.find((x) => x.id === 'q1');
  assert.equal(boardAccepted.accepted, true);
  assert.equal(boardAccepted.fromFormalOnly, false);

  const formalStory = qb.items.find((x) => x.id === 'formal:星辉遗迹的呼唤');
  assert.ok(formalStory);
  assert.equal(formalStory.fromFormalOnly, true);
  assert.equal(formalStory.accepted, true);
  assert.equal(formalStory.category, '剧情任务');
  assert.equal(formalStory.rank, 'A');
  assert.equal(formalStory.way, '剧情触发');
  assert.equal(formalStory.guideLabel, '任务目标');
  assert.equal(formalStory.guide, '前往星辉谷入口会合');
  assert.equal(formalStory.progress, '已获得残破星图');
  assert.deepEqual(formalStory.rewards, ['传说级法杖 ×1', '星辰结晶 ×3']);

  const formalLocal = qb.items.find((x) => x.id === 'formal:镇长失踪之谜');
  assert.ok(formalLocal);
  assert.equal(formalLocal.category, '本地主线');
  assert.equal(formalLocal.rank, 'B');

  const formalSide = qb.items.find((x) => x.id === 'formal:帮铁匠送铁锤');
  assert.ok(formalSide);
  assert.equal(formalSide.category, '支线任务');
  assert.equal(formalSide.rank, '原版');

  assert.equal(qb.items.some((x) => x.title === '已完成的旧委托'), false);
  assert.equal(qb.items.some((x) => x.title === '已失败的护送'), false);

  // actions.recordAcceptedQuests / sweepClosedQuests 只处理板上真实条目，不被合成项污染
  const rec = recordAcceptedQuests(stat).stat;
  assert.deepEqual(rec['事件']['任务情报板']['曾接取'], ['白石暗潮']);
  assert.equal(hasClosedQuestLeftovers(stat), false);

  // 原版任务等级推断左边界：Boss级魔物 / NPC级 不误判为 S级 / C级
  const boundaryStat = {
    世界: { 地点: '白石镇' },
    任务列表: {
      '讨伐洞穴首领': { 状态: '进行中', 详情: '击败洞穴深处的Boss级魔物，保障商路安全。' },
      '护送重要学者': { 状态: '进行中', 详情: '护送NPC级关键人物抵达城门。' },
    },
    事件: { 任务情报板: { 区域键: '白石镇', 区域: '白石镇', 列表: [] } },
  };
  const qbBoundary = questBoardState(boundaryStat);
  assert.equal(qbBoundary.items.find((x) => x.title === '讨伐洞穴首领').rank, '原版');
  assert.equal(qbBoundary.items.find((x) => x.title === '护送重要学者').rank, '原版');
});

test('限时 Buff 词条：解析、常驻3+限时2共存、过期隐藏/0注入与跨区域全地图自动清理', () => {
  // 1) 标准顺序与互换顺序、无年份跨年、当天有效与次日过期
  const parsedStd = parseAftermathEntry(
    '[绿][至488年-7月-15日]【踏星盛会】全港挂起星灯，观礼商船云集码头。',
    '复兴纪元488年-6月-24日',
  );
  assert.deepEqual(parsedStd, {
    text: '[绿][至488年-7月-15日]【踏星盛会】全港挂起星灯，观礼商船云集码头。',
    tone: 'green',
    tag: '踏星盛会',
    body: '全港挂起星灯，观礼商船云集码头。',
    until: '488年-7月-15日',
    isTemp: true,
    daysLeft: 21,
    expired: false,
  });

  const parsedSwapped = parseAftermathEntry(
    '[至488-07-15][黄]【临时戒严】外城关卡加派巡逻，夜间盘查趋严。',
    '复兴纪元488年-7月-15日',
  );
  assert.equal(parsedSwapped.tone, 'yellow');
  assert.equal(parsedSwapped.tag, '临时戒严');
  assert.equal(parsedSwapped.until, '488-07-15');
  assert.equal(parsedSwapped.isTemp, true);
  assert.equal(parsedSwapped.daysLeft, 0);
  assert.equal(parsedSwapped.expired, false);
  assert.equal(
    isAftermathEntryExpired('[至488-07-15][黄]【临时戒严】外城关卡加派巡逻。', '复兴纪元488年-7月-15日'),
    false,
  );
  assert.equal(
    isAftermathEntryExpired('[至488-07-15][黄]【临时戒严】外城关卡加派巡逻。', '复兴纪元488年-7月-16日'),
    true,
  );

  // 无年份年末跨年初到期日（12月25日 -> 至1月10日 = 剩 16 天）
  const parsedCrossYear = parseAftermathEntry(
    '【红】【至1月10日】【寒潮封港】港湾浮冰未消，大型商船暂缓出航。',
    '复兴纪元488年-12月-25日',
  );
  assert.equal(parsedCrossYear.tone, 'red');
  assert.equal(parsedCrossYear.isTemp, true);
  assert.equal(parsedCrossYear.daysLeft, 16);
  assert.equal(parsedCrossYear.expired, false);

  // 2) 3 条常驻 + 2 条限时同时存在，且夹杂 1 条已过期限时词条：前端与 EJS 均保留 5 条，过期词条隐藏/0 注入
  const coexistStat = {
    世界: { 地点: '雾晶港-主港区', 时间: '复兴纪元488年-7月-10日-12:00' },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '复兴纪元488年-7月-10日',
        列表: [
          { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '核对仓单', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '修补缆绳', 方式: '委托', 预期收益: ['金币 ×60'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '护送货箱', 方式: '委托', 预期收益: ['金币 ×70'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '巡查灯塔', 方式: '委托', 预期收益: ['金币 ×80'] },
        ],
        余波: {
          雾晶港: [
            '[绿]【商路畅通】南北航线稳定通航，香料与药材供应充裕。',
            '[黄]【关税波动】港务司调整外商卸货费，部分货栈观望。',
            '[红]【暗礁频现】外海浓雾增多，夜航船只多次触礁。',
            '[绿][至488年-7月-15日]【踏星盛会】全港挂起星灯，各国旅人与商船云集。',
            '[黄][至488年-7月-10日]【学院招生】星海学院在港口广场设点考核新学员。',
            '[红][至488年-7月-05日]【旧日封港】前期风暴封锁已成过去，不应再展示。',
          ],
          世界: [
            '[绿]【大陆通商】各大城邦签署临时护航协定，陆海商路回暖。',
            '[黄][至488年-7月-20日]【星象大潮】各地魔力潮汐活跃，炼金工坊加紧采晶。',
            '[红][至488年-7月-01日]【过期灾厄】早已消退的旧灾厄，不应再注入。',
          ],
        },
      },
    },
  };

  const qbCoexist = questBoardState(coexistStat);
  assert.equal(qbCoexist.aftermath.localEntries.length, 5);
  assert.deepEqual(
    qbCoexist.aftermath.localEntries.map((e) => e.tag),
    ['商路畅通', '关税波动', '暗礁频现', '踏星盛会', '学院招生'],
  );
  assert.equal(qbCoexist.aftermath.localEntries[3].daysLeft, 5);
  assert.equal(qbCoexist.aftermath.localEntries[4].daysLeft, 0);
  assert.equal(qbCoexist.aftermath.worldEntries.length, 2);
  assert.deepEqual(
    qbCoexist.aftermath.worldEntries.map((e) => e.tag),
    ['大陆通商', '星象大潮'],
  );

  const outCoexist = renderEjs(coexistStat);
  assertCleanOutput(outCoexist, 'temp-aftermath-coexist');
  assert.match(outCoexist, /限时词条/);
  assert.match(outCoexist, /最多额外叠加 2 条/);
  assert.match(outCoexist, /\[绿\/黄\/红\]\[至YYYY年-M月-D日\]【2~6字短标签】30~50字客观现状/);
  assert.match(outCoexist, /【商路畅通】/);
  assert.match(outCoexist, /【关税波动】/);
  assert.match(outCoexist, /【暗礁频现】/);
  assert.match(outCoexist, /【踏星盛会】/);
  assert.match(outCoexist, /【学院招生】/);
  assert.doesNotMatch(outCoexist, /【旧日封港】/);
  assert.match(outCoexist, /【大陆通商】/);
  assert.match(outCoexist, /【星象大潮】/);
  assert.doesNotMatch(outCoexist, /【过期灾厄】/);

  // 3) 跨区域全地图自动清理：主角在铁炉堡，雾晶港的过期「踏星盛会」与白石镇全过期区域均被自动清除
  const crossRegionStat = {
    世界: { 地点: '铁炉堡-商业街', 时间: '复兴纪元488年-7月-20日-09:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-7月-20日',
        列表: [],
        余波: {
          铁炉堡: [
            '[绿]【高炉满产】主熔炉群日夜运转，精铁产量稳步上升。',
            '[黄][至488年-7月-25日]【锻造大比】铁匠行会举办公开锻造赛，城内旅店爆满。',
          ],
          雾晶港: [
            '[绿]【商路畅通】南北航线稳定通航，香料与药材供应充裕。',
            '[绿][至488年-7月-15日]【踏星盛会】全港挂起星灯，观礼商船云集码头。',
          ],
          白石镇: [
            '[红][至488年-7月-10日]【临时宵禁】镇门夜间封闭，行旅受限。',
          ],
          世界: [
            '[黄][至488年-7月-18日]【过期天象】旧星象已退散。',
            '[绿][至488年-7月-20日]【今日盛典】今日恰为最后一天，仍应保留。',
          ],
        },
      },
    },
  };

  assert.equal(hasExpiredAftermath(crossRegionStat), true);
  const maintained = maintainQuestBoard(crossRegionStat, {});
  assert.equal(maintained.skip, undefined);
  assert.equal(hasExpiredAftermath(maintained.stat), false);
  // 铁炉堡常驻与未过期限时均完好保留
  assert.equal(maintained.stat.事件.任务情报板.余波.铁炉堡.length, 2);
  // 雾晶港仅移除过期的踏星盛会，常驻词条完好保留
  assert.deepEqual(maintained.stat.事件.任务情报板.余波.雾晶港, [
    '[绿]【商路畅通】南北航线稳定通航，香料与药材供应充裕。',
  ]);
  // 白石镇全部过期后，空区域键被自动删除
  assert.equal(Object.prototype.hasOwnProperty.call(maintained.stat.事件.任务情报板.余波, '白石镇'), false);
  // 世界移除过期项，保留当日到期的有效项
  assert.deepEqual(maintained.stat.事件.任务情报板.余波.世界, [
    '[绿][至488年-7月-20日]【今日盛典】今日恰为最后一天，仍应保留。',
  ]);
  // 再次维护应返回 skip: true
  assert.deepEqual(maintainQuestBoard(maintained.stat, {}), { skip: true });

  // 全部词条都过期时，sweepExpiredAftermath 清空整个 余波 字段
  const allExpiredStat = {
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-8月-01日' },
    事件: {
      任务情报板: {
        余波: {
          雾晶港: '[绿][至488年-7月-15日]【踏星盛会】已结束。',
        },
      },
    },
  };
  const sweptAll = sweepExpiredAftermath(allExpiredStat);
  assert.equal(Object.prototype.hasOwnProperty.call(sweptAll.stat.事件.任务情报板, '余波'), false);
});

test('EJS 收益高→低分层、4 档失败折损、追回边界与 [n✓]/[n✕]/[n□] 渲染', () => {
  // 1) init 输出：收益高→低分层规格（剧情 1~3 / 4~7 / 8~10；本地主线 1 / 2~3 / 4~5）
  const initOut = renderEjs({
    世界: { 地点: '雾晶港-主城', 时间: '复兴纪元488年-6月-10日-12:00' },
    事件: {},
  });
  assertCleanOutput(initOut, 'reward-tier-init');
  assert.match(initOut, /生成规格（品质与禁项沿用<任务与委托规则>，仅核心层可\+1 档，其余按原等级；下列条数为参考配额，剧情追加不受上限限制）/);
  assert.match(initOut, /支线任务（2~3 条，限本区｜数小时~7 天｜全栏原等级，无\+1 档｜收益 3 栏）/);
  assert.match(initOut, /剧情任务（10 栏）与本地主线（5 栏）按高价值在前、基础在后排布（剧情第 1~3 栏为核心层、第 4~7 栏为中坚层进阶装备\/配方\/实用资源、第 8~10 栏为基础层金币\/常规材料\/补给\/普通声望；本地主线第 1 栏为核心层、第 2~3 栏为中坚层、第 4~5 栏为基础层），仅核心层可\+1 档且不得超限，中坚层、基础层与全部支线任务（3 栏）均按任务原等级品质发放/);
  assert.match(initOut, /写法上与普通支线保持一致，不泄露幕后真相；不得在结尾用「但\/可\/却……私下……」点破异常疑点、暗中插手的势力或内部隐患，疑点留到接取后的实地接触中暴露/);
  assert.match(initOut, /层级匹配: 任务等级与正面敌对生命层级对应（D一层\/C二层\/B三层\/A四层\/S五层）/);
  assert.match(initOut, /更高层级的人物与势力只作为背景存在、幕后授意者或线索来源，留作后续高阶任务引子/);
  assert.match(initOut, /总兑现不低于剩余有效栏位底线/);

  // 2) maintain 输出：4 档折损与失效、已兑现不倒扣、追回边界、失效Patch 范围（剧情+主线有，支线无）与三态标记渲染
  const maintainStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日-12:00' },
    任务列表: {
      '潮汐密钥': { 状态: '进行中', 进展: '[488年-6月-12日] 刚拿到码头密信。' },
      '旧仓库谜案': { 状态: '进行中', 进展: '[488年-6月-12日] 发现密室暗门。' },
      '清点海盐': { 状态: '进行中', 进展: '[488年-6月-12日] 清点第一批货箱。' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-12日',
        意向: ['q4', 'q5'],
        已兑现: { q1: [1, 2] },
        已失效: { q1: [2, 5] },
        列表: [
          {
            id: 'q1',
            类别: '剧情任务',
            等级: 'A',
            标题: '潮汐密钥',
            方式: '调查',
            摘要: '潮闸钥匙失窃',
            真相: '三方势力竞逐控制权',
            更新日: '488年-6月-12日',
            预期收益: [
              '传说潮汐权杖 ×1',
              '古龙鳞片 ×2',
              '[已失效] 暗影典籍 ×1',
              '[✕] 秘银锭 ×3',
              '星辉药水×3',
              '金币 ×500',
              '药水×3',
              '精炼盐晶 ×4',
              '港务通行证 ×1',
              '商会声望 +15',
            ],
          },
          {
            id: 'q2',
            类别: '本地主线',
            等级: 'B',
            标题: '旧仓库谜案',
            方式: '探索',
            摘要: '旧仓库深夜响动',
            真相: '走私商与港口官员勾结',
            预期收益: ['史诗短刀 ×1', '秘银甲片 ×2', '稀有图纸 ×1', '金币 ×240', '补给包 ×2'],
          },
          {
            id: 'q3',
            类别: '支线任务',
            等级: 'D',
            标题: '清点海盐',
            方式: '委托',
            摘要: '帮商行核对海盐仓单',
            预期收益: ['金币 ×80', '药水×2', '码头好感 +5'],
          },
          {
            id: 'q4',
            类别: '本地主线',
            等级: 'B',
            标题: '灯塔熄火',
            方式: '危机',
            摘要: '外港主灯塔突然熄灭',
            真相: '海雾教团破坏镜片',
            预期收益: ['史诗棱镜 ×1', '魔导透镜 ×2', '秘银灯油 ×3', '金币 ×200', '港务嘉奖 ×1'],
          },
          {
            id: 'q5',
            类别: '支线任务',
            等级: 'D',
            标题: '修补渔网',
            方式: '委托',
            摘要: '帮老渔夫修补破网',
            预期收益: ['金币 ×50', '海鱼干 ×4', '渔村声望 +3'],
          },
          { id: 'q6', 类别: '支线任务', 等级: 'D', 标题: '搬运缆绳', 方式: '委托', 摘要: '搬运码头缆绳', 预期收益: ['金币 ×40', '麻绳 ×3', '体力药水×1'] },
          { id: 'q7', 类别: '支线任务', 等级: 'D', 标题: '送达信件', 方式: '委托', 摘要: '给灯塔守望者送信', 预期收益: ['金币 ×45', '草药×2', '声望 +2'] },
        ],
      },
    },
  };
  // 用户消息主动提及已锁定的本地主线「灯塔熄火」与已锁定支线「修补渔网」，使两者一并在 maintain 中展示
  const maintainOut = renderEjs(maintainStat, {
    chat: [{ is_user: true, mes: '我想先顺路打听一下灯塔熄火和修补渔网的事。' }],
  });
  assertCleanOutput(maintainOut, 'reward-loss-maintain');

  // 4 档折损规则与边界口径
  assert.match(maintainOut, /折损与失效: 剧情任务与本地主线（剧情 1~3 核心 \/ 4~7 中坚 \/ 8~10 基础，本地主线 1 \/ 2~3 \/ 4~5）/);
  assert.match(maintainOut, /已标记 `\[✓\]` 不转为失效/);
  assert.match(maintainOut, /轻度折损划除剧情 2 栏（中坚 1 \+ 基础 1）或本地主线 1 栏（中坚优先）/);
  assert.match(maintainOut, /层级与串联: 任务中正面敌对、阻拦、主动攻击或追杀 <user> 的角色，生命层级不得超过任务对应层级（D一层\/C二层\/B三层\/A四层\/S五层）/);
  assert.match(maintainOut, /如果 <user> 主动挑衅、袭击或强闯高于本任务等级的人物与核心禁地，对方按真实生命层级反击/);
  assert.match(maintainOut, /高于任务等级的人物与势力只作为背景存在、幕后授意者或线索来源（不主动下场攻击），任务推进或完结时可借他们留下的动向或线索，按「剧情追加」引出高一级的新任务/);
  assert.match(maintainOut, /中度折损划除剧情 2~3 栏或本地主线 2 栏，跨层混合（核心层保留至少 1 栏，也不只划基础）/);
  assert.match(maintainOut, /重度折损（濒临失败转入止损）划至剧情仅留 2~3 栏、本地主线仅留 1~2 栏，优先剥离核心与大部分中坚，仅留基础栏位或次要补给/);
  assert.match(maintainOut, /彻底失败将剩余 `\[□\]` 全部视为失效，零新收益结案、直接移出 `\/任务列表` 与任务情报板并写入 `\[黄\/红\]` 词条，无需更新进展或写 `失效Patch`/);
  assert.match(maintainOut, /标记 `\[✕\]` 的栏位本任务不再发放，剩余有效 `\[□\]` 照常兑现/);
  assert.match(maintainOut, /如果 <user> 后续在剧情外另行设法追回对应物件，按正常剧情判定成败，不得因曾标记 `\[✕\]` 而强行判定失败/);
  assert.match(maintainOut, /无需再写 `兑现Patch` 或 `失效Patch`/);
  assert.match(maintainOut, /发生折损失效时按 `失效Patch` 写入/);

  const lines = maintainOut.split('\n');
  const q1Line = lines.find((l) => l.includes('[q1｜剧情任务'));
  const q2Line = lines.find((l) => l.includes('[q2｜本地主线'));
  const q3Line = lines.find((l) => l.includes('[q3｜支线任务'));
  const q4Line = lines.find((l) => l.includes('[q4｜本地主线'));
  const q5Line = lines.find((l) => l.includes('[q5｜支线任务'));
  assert.ok(q1Line && q2Line && q3Line && q4Line && q5Line, '5 条相关任务均应展示');

  // [n✓] / [n✕] / [n□] 渲染，同栏位同时在已兑现与已失效时强制 [2✓]，行内 [已失效]/[✕] 剥离，且不误伤 ×500 / ×3
  assert.match(q1Line, /\[1✓\]传说潮汐权杖 ×1/);
  assert.match(q1Line, /\[2✓\]古龙鳞片 ×2/);
  assert.doesNotMatch(q1Line, /\[2✕\]/);
  assert.match(q1Line, /\[3✕\]暗影典籍 ×1/);
  assert.match(q1Line, /\[4✕\]秘银锭 ×3/);
  assert.match(q1Line, /\[5✕\]星辉药水×3/);
  assert.match(q1Line, /\[6□\]金币 ×500/);
  assert.match(q1Line, /\[7□\]药水×3/);
  assert.doesNotMatch(q1Line, /\[已失效\]|\[✕\]/);

  // 失效Patch：已接取剧情(replace)、已接取本地主线(insert)、★已锁定本地主线(insert)均带，支线（已接取与已锁定）均不带
  assert.match(q1Line, /｜失效Patch：\{ "op": "replace", "path": "\/事件\/任务情报板\/已失效\/q1", "value": \[累计失效栏号\] \}/);
  assert.match(q2Line, /｜失效Patch：\{ "op": "insert", "path": "\/事件\/任务情报板\/已失效\/q2", "value": \[累计失效栏号\] \}/);
  assert.match(q4Line, /｜★已锁定\].*｜失效Patch：\{ "op": "insert", "path": "\/事件\/任务情报板\/已失效\/q4", "value": \[累计失效栏号\] \}/);
  assert.doesNotMatch(q3Line, /失效Patch/);
  assert.doesNotMatch(q5Line, /失效Patch/);

  // 3) _qbLostMergeNote 在 maintain 模式下：无 已失效 且 >= 2 条可失效非支线任务时恰好出现 1 次
  const maintainNoLost = JSON.parse(JSON.stringify(maintainStat));
  delete maintainNoLost.事件.任务情报板.已失效;
  const maintainNoLostOut = renderEjs(maintainNoLost);
  const mergeNoteRe = /同轮首次记录多条任务时，合并写入同一个 `insert \/事件\/任务情报板\/已失效` 对象，不要重复 `insert` 同一路径/g;
  assert.equal((maintainNoLostOut.match(mergeNoteRe) || []).length, 1, 'maintain 有 2 条可失效非支线任务且无 已失效 时应恰好提示 1 次合并写入');

  // 4) 正则防回溯与前后端对齐：× 2 宝石 / [已作废] / × 宝石 / 宝石 × / [✓] 在 EJS 与前端一致
  const alignStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日-12:00' },
    任务列表: { '对齐校验任务': { 状态: '进行中', 进展: '[488年-6月-12日] 测试中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-12日',
        已兑现: { qAlign: [8], '对齐校验任务': [9] },
        已失效: { qAlign: [10] },
        列表: [
          {
            id: 'qAlign',
            类别: '剧情任务',
            等级: 'A',
            标题: '对齐校验任务',
            方式: '调查',
            摘要: '校验两端解析一致性',
            真相: '内部测试',
            更新日: '488年-6月-12日',
            预期收益: [
              '× 2 宝石',
              '[已作废] 龙晶',
              '× 宝石',
              '宝石 ×',
              '[✓] 圣杯',
              '金币 ×500',
              '药水×3',
              '双键兑现甲',
              '双键兑现乙',
              '双键失效丙',
            ],
          },
          { id: 's1', 类别: '支线任务', 等级: 'D', 标题: '支线一', 方式: '委托', 预期收益: ['金币 ×10'] },
          { id: 's2', 类别: '支线任务', 等级: 'D', 标题: '支线二', 方式: '委托', 预期收益: ['金币 ×20'] },
          { id: 's3', 类别: '支线任务', 等级: 'D', 标题: '支线三', 方式: '委托', 预期收益: ['金币 ×30'] },
          { id: 's4', 类别: '支线任务', 等级: 'D', 标题: '支线四', 方式: '委托', 预期收益: ['金币 ×40'] },
        ],
      },
    },
  };
  const alignEjsOut = renderEjs(alignStat);
  assertCleanOutput(alignEjsOut, 'reward-align-ejs');
  const alignLine = alignEjsOut.split('\n').find((l) => l.includes('[qAlign｜剧情任务'));
  assert.ok(alignLine);
  assert.match(alignLine, /\[1□\]× 2 宝石/);
  assert.match(alignLine, /\[2✕\]龙晶/);
  assert.match(alignLine, /\[3✕\]宝石/);
  assert.match(alignLine, /\[4✕\]宝石/);
  assert.match(alignLine, /\[5✓\]圣杯/);
  assert.match(alignLine, /\[6□\]金币 ×500/);
  assert.match(alignLine, /\[7□\]药水×3/);
  assert.match(alignLine, /\[8✓\]双键兑现甲/);
  assert.match(alignLine, /\[9✓\]双键兑现乙/);
  assert.match(alignLine, /\[10✕\]双键失效丙/);

  const alignFrontItem = questBoardState(alignStat).items.find((x) => x.id === 'qAlign');
  assert.deepEqual(
    alignFrontItem.rewardItems.map((r) => `[${r.slot}${r.claimed ? '✓' : (r.lost ? '✕' : '□')}]${r.text}`),
    [
      '[1□]× 2 宝石',
      '[2✕]龙晶',
      '[3✕]宝石',
      '[4✕]宝石',
      '[5✓]圣杯',
      '[6□]金币 ×500',
      '[7□]药水×3',
      '[8✓]双键兑现甲',
      '[9✓]双键兑现乙',
      '[10✕]双键失效丙',
    ],
  );
});

test('EJS 安全版日常条件门控：0 接取/仅支线/原版活跃任务护栏与 Token 瘦身验证', () => {
  const boardItems = [
    { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '银月长线', 方式: '危机', 摘要: '港口传闻', 真相: '暗中转运', 更新日: '488年-6月-24日', 预期收益: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
    { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '防波堤蟹潮', 方式: '委托', 摘要: '清理巨钳蟹', 真相: '泄漏晶簇', 预期收益: ['1', '2', '3', '4', '5'] },
    { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '校准风向仪', 方式: '委托', 摘要: '灯塔校准', 预期收益: ['1', '2', '3'] },
    { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '收集旧图谱', 方式: '探索', 摘要: '补全图谱', 预期收益: ['1', '2', '3'] },
    { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '清点货箱', 方式: '委托', 摘要: '核对货单', 预期收益: ['1', '2', '3'] },
    { id: 'q6', 类别: '支线任务', 等级: 'D', 标题: '修补缆绳', 方式: '委托', 摘要: '修补绳索', 预期收益: ['1', '2', '3'] },
  ];
  const baseStat = (formalTasks = {}) => ({
    世界: { 地点: '雾晶港-巨浪港区', 时间: '复兴纪元488年-6月-24日' },
    任务列表: formalTasks,
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-24日',
        区域访问日: { 雾晶港: '488年-6月-24日' },
        列表: boardItems,
        余波: {
          雾晶港: [
            '[绿]【法环护持】城墙魔导法环稳定运行。',
            '[黄]【海雾残渣】外港残留偏高。',
            '[黄]【黑市暗涌】旧货交易增多。',
          ],
        },
      },
    },
  });

  // 1) 0 接取、无提及闲聊：大幅瘦身（<2200 字符），关闭波折/折损/默认3条/14天重返/锁定与换区，但保留层级护栏与双红线
  const outIdle = renderEjs(baseStat({}));
  assertCleanOutput(outIdle, 'gating-idle');
  assert.ok(outIdle.length < 2200, `0 接取日常渲染应瘦身至 2200 字符以内，实际为 ${outIdle.length}`);
  assert.match(outIdle, /层级护栏:/);
  assert.match(outIdle, /禁止整块覆写 `\/事件` 或 `\/事件\/任务情报板`/);
  assert.match(outIdle, /剧情追加:/);
  assert.match(outIdle, /未接取支线单回合接取并完结时从 `\/事件\/任务情报板\/列表` 移除/);
  assert.doesNotMatch(outIdle, /波折节拍:|折损与失效:|默认写入 3 条常驻词条|离开满 14 天|锁定与换区:/);

  // 2) 仅 1 条支线已接取：关闭波折/演化/4档折损，但保留支线节奏、层级与串联及分批兑现
  const outSideOnly = renderEjs(baseStat({ 校准风向仪: { 状态: '进行中' } }));
  assertCleanOutput(outSideOnly, 'gating-side-only');
  assert.match(outSideOnly, /支线任务限本区单点闭环直接推进，不设反转/);
  assert.match(outSideOnly, /层级与串联:/);
  assert.match(outSideOnly, /分批兑现:/);
  assert.doesNotMatch(outSideOnly, /波折节拍:|演化与完结:|折损与失效:/);

  // 3) 板上 0 接取但原版 /任务列表 有未上墙进行中任务：护栏生效，开启完整 推进与兑现
  const outFormalOnly = renderEjs(baseStat({ 学院突发委托: { 状态: '进行中', 进展: '正在调查' } }));
  assertCleanOutput(outFormalOnly, 'gating-formal-only');
  assert.match(outFormalOnly, /波折节拍:/);
  assert.match(outFormalOnly, /折损与失效:/);
  assert.match(outFormalOnly, /层级与串联:/);
});

test('EJS 待演进确定性分层抽签：4 阶段全覆盖、Patch 分支与非 10 栏老存档降级', () => {
  const storyRewards10 = [
    '传说圣剑 ×1',
    '神话核心 ×1',
    '古龙心核 ×1',
    '史诗护甲 ×1',
    '秘银配方 ×1',
    '稀有魔晶 ×4',
    '星辉锻石 ×3',
    '金币 ×600',
    '治疗药水×5',
    '公会声望 +20',
  ];
  const makeAdvanceStat = ({ claimedMap, lostMap, extraStory, rewards = storyRewards10 } = {}) => ({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-20日-12:00' },
    任务列表: {
      '暗潮港湾': { 状态: '进行中', 进展: '[488年-6月-10日] 拿到初步证词。' },
      ...(extraStory ? { [extraStory.标题]: { 状态: '进行中', 进展: '[488年-6月-10日] 刚介入调查。' } } : {}),
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        更新日: '488年-6月-10日',
        ...(claimedMap ? { 已兑现: claimedMap } : {}),
        ...(lostMap ? { 已失效: lostMap } : {}),
        列表: [
          {
            id: 'q1',
            类别: '剧情任务',
            等级: 'A',
            标题: '暗潮港湾',
            方式: '调查',
            摘要: '港口账册失窃',
            真相: '三方争夺潮闸钥匙',
            更新日: '488年-6月-10日',
            预期收益: rewards,
          },
          ...(extraStory ? [extraStory] : []),
          { id: 's1', 类别: '支线任务', 等级: 'D', 标题: '搬运货箱', 方式: '委托', 摘要: '搬货', 预期收益: ['金币 ×50'] },
          { id: 's2', 类别: '支线任务', 等级: 'D', 标题: '巡查码头', 方式: '委托', 摘要: '巡查', 预期收益: ['金币 ×60'] },
          { id: 's3', 类别: '支线任务', 等级: 'D', 标题: '清理藤壶', 方式: '委托', 摘要: '清理', 预期收益: ['金币 ×70'] },
          { id: 's4', 类别: '支线任务', 等级: 'D', 标题: '运送灯油', 方式: '委托', 摘要: '运油', 预期收益: ['金币 ×80'] },
        ],
      },
    },
  });

  const parseAdvLine = (out, id) => {
    const line = out.split('\n').find((l) => l.includes(`[${id}｜剧情任务`));
    assert.ok(line, `应存在任务 ${id} 的输出行`);
    const patchMatch = line.match(/｜失效Patch：(\{[^｜]+\})/);
    const patch = patchMatch ? JSON.parse(patchMatch[1]) : null;
    const lossMatch = line.match(/｜本步失效（(轻度演进|中度演进|重度止损|尾声折损)）：([^｜]+)/);
    if (lossMatch) {
      const slots = [...lossMatch[2].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      return { line, failClose: false, stageLabel: lossMatch[1], newlyLost: slots, patch };
    }
    const failMatch = line.match(/｜本步演进：彻底失败（([^）]+)）/);
    if (failMatch) {
      const slots = [...failMatch[1].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      return { line, failClose: true, stageLabel: '彻底失败', newlyLost: slots, failDetail: failMatch[1], patch };
    }
    assert.fail(`未能解析 ${id} 的演进失效片段: ${line}`);
  };

  const mergeNoteRe = /同轮首次记录多条任务时，合并写入同一个 `insert \/事件\/任务情报板\/已失效` 对象，不要重复 `insert` 同一路径/g;

  // 阶段 1（lostCount=0）：抽 2 栏 = 中坚 1（4~7）+ 基础 1（8~10），不动核心（1~3）；确定性一致；单条可失效任务时 _qbLostMergeNote 为 0 次
  const statS1 = makeAdvanceStat();
  const outS1A = renderEjs(statS1);
  const outS1B = renderEjs(statS1);
  const outS1C = renderEjs(statS1);
  assertCleanOutput(outS1A, 'adv-stage1');
  assert.equal(outS1A, outS1B, '同状态多次渲染必须完全一致（确定性 RNG）');
  assert.equal(outS1B, outS1C, '同状态多次渲染必须完全一致（确定性 RNG）');
  assert.equal((outS1A.match(mergeNoteRe) || []).length, 0, '单条可失效任务时不应注入合并写入提示');

  const s1 = parseAdvLine(outS1A, 'q1');
  assert.equal(s1.stageLabel, '轻度演进');
  assert.equal(s1.newlyLost.length, 2);
  assert.equal(s1.newlyLost.filter((n) => n >= 1 && n <= 3).length, 0, '阶段 1 不动核心层（1~3）');
  assert.equal(s1.newlyLost.filter((n) => n >= 4 && n <= 7).length, 1, '阶段 1 应抽中 1 栏中坚层（4~7）');
  assert.equal(s1.newlyLost.filter((n) => n >= 8 && n <= 10).length, 1, '阶段 1 应抽中 1 栏基础层（8~10）');
  assert.deepEqual(s1.patch, {
    op: 'insert',
    path: '/事件/任务情报板/已失效',
    value: { q1: s1.newlyLost },
  });

  // 2 条可失效任务且无 已失效 时，_qbLostMergeNote 恰好出现 1 次（不会在 折损与失效 与 剧情演进 重复出现）
  const extraStory = {
    id: 'q2',
    类别: '剧情任务',
    等级: 'B',
    标题: '霜脉裂隙',
    方式: '异象',
    摘要: '北境地脉异常',
    真相: '封印柱松动',
    更新日: '488年-6月-10日',
    预期收益: storyRewards10,
  };
  const outTwoNoLost = renderEjs(makeAdvanceStat({ extraStory }));
  assertCleanOutput(outTwoNoLost, 'adv-two-no-lost');
  assert.equal((outTwoNoLost.match(mergeNoteRe) || []).length, 1, '2 条可失效任务且无 已失效 时合并提示应恰好出现 1 次');

  // 2 条待演进任务但其中 1 条彻底失败（不写失效Patch）时，可写失效Patch任务数仅 1，合并提示为 0 次
  const outOneFailOneAdv = renderEjs(makeAdvanceStat({
    rewards: ['唯一遗物 ×1'],
    extraStory,
  }));
  assert.equal((outOneFailOneAdv.match(mergeNoteRe) || []).length, 0, '仅有 1 条非彻底失败任务需写 失效Patch 时不注入合并提示');

  // 阶段 2（lostCount=2，沿用阶段 1 抽出的 1 中 1 基）：抽 2 栏含核心 1（1~3），且已有 已失效 时区分 replace/insert
  const outS2 = renderEjs(makeAdvanceStat({ lostMap: { q1: s1.newlyLost }, extraStory }));
  assertCleanOutput(outS2, 'adv-stage2');
  const s2 = parseAdvLine(outS2, 'q1');
  assert.equal(s2.stageLabel, '中度演进');
  assert.equal(s2.newlyLost.length, 2);
  assert.equal(s2.newlyLost.filter((n) => n >= 1 && n <= 3).length, 1, '阶段 2 应抽中 1 栏核心层（1~3）且不清空核心');
  const expectedS2Next = [...new Set([...s1.newlyLost, ...s2.newlyLost])].sort((a, b) => a - b);
  assert.deepEqual(s2.patch, {
    op: 'replace',
    path: '/事件/任务情报板/已失效/q1',
    value: expectedS2Next,
  });
  const s2Extra = parseAdvLine(outS2, 'q2');
  assert.equal(s2Extra.patch.op, 'insert', '已存在 已失效 对象但缺少 q2 键时应使用 insert');
  assert.equal(s2Extra.patch.path, '/事件/任务情报板/已失效/q2');
  assert.deepEqual(s2Extra.patch.value, s2Extra.newlyLost);

  // 阶段 2 边界（lostCount=2，仅剩 1 栏核心 [3] 且非核心充足时，核心层至少保留 1 栏不清空）
  const outS2KeepCore = renderEjs(makeAdvanceStat({ lostMap: { q1: [1, 2] } }));
  const s2KeepCore = parseAdvLine(outS2KeepCore, 'q1');
  assert.equal(s2KeepCore.stageLabel, '中度演进');
  assert.equal(s2KeepCore.newlyLost.length, 2);
  assert.equal(s2KeepCore.newlyLost.includes(3), false, '阶段 2 非空核心在非核心充足时应至少保留 1 栏');

  // 阶段 3（lostCount=4）：累计划至仅留 2~3 栏，优先剥离剩余核心
  const outS3 = renderEjs(makeAdvanceStat({ lostMap: { q1: expectedS2Next } }));
  assertCleanOutput(outS3, 'adv-stage3');
  const s3 = parseAdvLine(outS3, 'q1');
  assert.equal(s3.stageLabel, '重度止损');
  const remainingAfterS3 = 10 - s3.patch.value.length;
  assert.ok(remainingAfterS3 === 2 || remainingAfterS3 === 3, `阶段 3 结束后应仅留 2~3 栏，实际剩 ${remainingAfterS3} 栏`);
  const remainingCoreBeforeS3 = [1, 2, 3].filter((n) => !expectedS2Next.includes(n));
  for (const coreSlot of remainingCoreBeforeS3) {
    assert.equal(s3.newlyLost.includes(coreSlot), true, `阶段 3 应优先剥离剩余核心栏位 ${coreSlot}`);
  }
  assert.deepEqual(
    s3.patch.value,
    [...new Set([...expectedS2Next, ...s3.newlyLost])].sort((a, b) => a - b),
    '阶段 3 Patch value 应为历史+本步去重升序',
  );

  // 阶段 4（lostCount=7，剩余 3 栏无核心继续搁置）：彻底失败且不再输出 失效Patch，直接移出两板
  const s4PrevLost = [1, 2, 3, 4, 5, 6, 8];
  const outS4 = renderEjs(makeAdvanceStat({ lostMap: { q1: s4PrevLost } }));
  assertCleanOutput(outS4, 'adv-stage4');
  const s4 = parseAdvLine(outS4, 'q1');
  assert.equal(s4.failClose, true);
  assert.match(s4.failDetail, /剩余全失效/);
  assert.match(s4.failDetail, /直接移出 \/任务列表 并执行完结移出，无需再写兑现Patch或失效Patch/);
  assert.deepEqual(s4.newlyLost, [7, 9, 10]);
  assert.equal(s4.patch, null, '彻底失败不应再输出 失效Patch，避免留下孤儿 已失效 键');
  assert.doesNotMatch(s4.line, /｜失效Patch：/);

  // 阶段 4 兜底（已全失效无剩余开放栏位）：同样无 失效Patch
  const outS4Empty = renderEjs(makeAdvanceStat({ lostMap: { q1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }));
  const s4Empty = parseAdvLine(outS4Empty, 'q1');
  assert.equal(s4Empty.failClose, true);
  assert.match(s4Empty.failDetail, /剩余无可兑现栏位，直接移出 \/任务列表 并执行完结移出，无需再写兑现Patch或失效Patch/);
  assert.equal(s4Empty.patch, null);

  // P0 回归：10 栏先兑现 8~10（剩 1~7）完整经过 S1 → S2 → S3（剥离核心保留非核心）→ S4（无 失效Patch），绝不跳过 S3
  const claimedBase = { q1: [8, 9, 10] };
  const cS1 = parseAdvLine(renderEjs(makeAdvanceStat({ claimedMap: claimedBase })), 'q1');
  assert.equal(cS1.stageLabel, '轻度演进');
  assert.equal(cS1.newlyLost.length, 2);
  assert.equal(cS1.newlyLost.every((n) => n >= 4 && n <= 7), true, '先兑现 8~10 后 S1 应只划中坚 4~7，不动核心 1~3');

  const cS2 = parseAdvLine(renderEjs(makeAdvanceStat({ claimedMap: claimedBase, lostMap: { q1: cS1.patch.value.q1 } })), 'q1');
  assert.equal(cS2.stageLabel, '中度演进');
  assert.equal(cS2.newlyLost.length, 2);
  assert.equal(cS2.newlyLost.filter((n) => n >= 1 && n <= 3).length, 1, 'S2 应抽 1 核心 + 1 中坚');
  assert.equal(cS2.newlyLost.filter((n) => n >= 4 && n <= 7).length, 1);

  const cS3 = parseAdvLine(renderEjs(makeAdvanceStat({ claimedMap: claimedBase, lostMap: { q1: cS2.patch.value } })), 'q1');
  assert.equal(cS3.stageLabel, '重度止损', '剩 2 核心 + 1 中坚时必须进入 S3 重度止损，绝不跳过 S3');
  assert.equal(cS3.failClose, false);
  const remainCoreAfterCS2 = [1, 2, 3].filter((n) => !cS2.patch.value.includes(n));
  assert.deepEqual(cS3.newlyLost, remainCoreAfterCS2, 'S3 应剥离全部剩余核心并保留最后 1 栏非核心');
  assert.ok(cS3.patch, 'S3 仍应输出 失效Patch');

  const cS4 = parseAdvLine(renderEjs(makeAdvanceStat({ claimedMap: claimedBase, lostMap: { q1: cS3.patch.value } })), 'q1');
  assert.equal(cS4.failClose, true, '仅剩最后 1 栏非核心时进入 S4 彻底失败');
  assert.equal(cS4.newlyLost.length, 1);
  assert.equal(cS4.patch, null, 'S4 彻底失败不应输出 失效Patch');

  // 非 10 栏老存档（5 栏、2 栏、1 栏）安全降级：不报错、不越界、不一步清零、无僵尸态
  const outLegacy5 = renderEjs(makeAdvanceStat({
    rewards: ['核心神器 ×1', '中坚护符 ×1', '中坚宝石 ×2', '金币 ×200', '药水×3'],
  }));
  assertCleanOutput(outLegacy5, 'adv-legacy-5');
  const leg5 = parseAdvLine(outLegacy5, 'q1');
  assert.equal(leg5.stageLabel, '轻度演进');
  assert.equal(leg5.newlyLost.length, 2);
  assert.ok(leg5.newlyLost.every((n) => n >= 1 && n <= 5));
  assert.equal(leg5.newlyLost.includes(1), false, '5 栏老存档阶段 1 不动第 1 栏核心');

  // 2 栏老存档（open.length === 2 && lostCount === 0）：S1 仅划 1 栏不一步清零；再推进（open.length === 1）直接进 S4 无 失效Patch
  const legacy2Rewards = ['核心遗物 ×1', '金币 ×100'];
  const outLegacy2Step1 = renderEjs(makeAdvanceStat({ rewards: legacy2Rewards }));
  assertCleanOutput(outLegacy2Step1, 'adv-legacy-2-s1');
  const leg2S1 = parseAdvLine(outLegacy2Step1, 'q1');
  assert.equal(leg2S1.stageLabel, '轻度演进');
  assert.equal(leg2S1.failClose, false);
  assert.equal(leg2S1.newlyLost.length, 1, 'open.length === 2 且 lostCount === 0 时 S1 应仅划 1 栏，不一步清零');
  assert.deepEqual(leg2S1.newlyLost, [2], '应优先划除基础/非核心栏位 2');
  assert.deepEqual(leg2S1.patch, {
    op: 'insert',
    path: '/事件/任务情报板/已失效',
    value: { q1: [2] },
  });

  const outLegacy2Step2 = renderEjs(makeAdvanceStat({ rewards: legacy2Rewards, lostMap: { q1: [2] } }));
  assertCleanOutput(outLegacy2Step2, 'adv-legacy-2-s4');
  const leg2S2 = parseAdvLine(outLegacy2Step2, 'q1');
  assert.equal(leg2S2.failClose, true, 'open.length === 1 应直接进入 S4 彻底失败，避免 rem=0 僵尸态');
  assert.deepEqual(leg2S2.newlyLost, [1]);
  assert.equal(leg2S2.patch, null, 'open.length === 1 彻底失败不应输出 失效Patch');

  // 1 栏老存档（open.length === 1 && lostCount === 0 && claimedCount === 0）：直接进入 S4 彻底失败且无 失效Patch
  const outLegacy1 = renderEjs(makeAdvanceStat({ rewards: ['唯一宝物 ×1'] }));
  assertCleanOutput(outLegacy1, 'adv-legacy-1');
  const leg1 = parseAdvLine(outLegacy1, 'q1');
  assert.equal(leg1.failClose, true);
  assert.deepEqual(leg1.newlyLost, [1]);
  assert.equal(leg1.patch, null);

  // 回归：已完成 9/10 栏（claimed=2..10, lost=0）仅剩 1 栏压轴核心时搁置，不直接误杀为彻底失败，先走尾声折损保留任务收尾；再次搁置才彻底失败结案
  const claimedNine = { q1: [2, 3, 4, 5, 6, 7, 8, 9, 10] };
  const outNineStep1 = renderEjs(makeAdvanceStat({ claimedMap: claimedNine }));
  assertCleanOutput(outNineStep1, 'adv-nine-claimed-s1');
  const nineS1 = parseAdvLine(outNineStep1, 'q1');
  assert.equal(nineS1.failClose, false, '已完成 9/10 且从未折损时，首次搁置不得直接误判彻底失败');
  assert.equal(nineS1.stageLabel, '尾声折损');
  assert.deepEqual(nineS1.newlyLost, [1]);
  assert.deepEqual(nineS1.patch, {
    op: 'insert',
    path: '/事件/任务情报板/已失效',
    value: { q1: [1] },
  });
  const outNineStep2 = renderEjs(makeAdvanceStat({ claimedMap: claimedNine, lostMap: { q1: [1] } }));
  assertCleanOutput(outNineStep2, 'adv-nine-claimed-s4');
  const nineS2 = parseAdvLine(outNineStep2, 'q1');
  assert.equal(nineS2.failClose, true, '尾声折损后再继续搁置应正常彻底失败结案');
  assert.equal(nineS2.patch, null);
});

test('前端 已失效 解析、三态循环切换与 ignoreQuest / sweepClosedQuests 清理联动', () => {
  // 1) 正则防回溯与文本清理边界：数量乘号（含 × 2 宝石）不被误判或误删；[已作废] / × 宝石 / 宝石 × / [✓] 正确识别清理
  assert.equal(LOST_MARK_RE.test('金币 ×500'), false);
  assert.equal(LOST_MARK_RE.test('药水×3'), false);
  assert.equal(LOST_MARK_RE.test('秘银矿 × 12'), false);
  assert.equal(LOST_MARK_RE.test('× 2 宝石'), false);
  assert.equal(LOST_MARK_RE.test(`宝石${' '.repeat(80)}× 12`), false);
  assert.equal(cleanRewardText('金币 ×500'), '金币 ×500');
  assert.equal(cleanRewardText('药水×3'), '药水×3');
  assert.equal(cleanRewardText('× 2 宝石'), '× 2 宝石');
  assert.equal(LOST_MARK_RE.test('[已失效] 暗影典籍 ×1'), true);
  assert.equal(LOST_MARK_RE.test('[已作废] 龙晶'), true);
  assert.equal(LOST_MARK_RE.test('× 宝石'), true);
  assert.equal(LOST_MARK_RE.test('宝石 ×'), true);
  assert.equal(LOST_MARK_RE.test('[✕] 秘银锭 ×3'), true);
  assert.equal(LOST_MARK_RE.test('[4✕] 星辰碎屑 ×2'), true);
  assert.equal(cleanRewardText('[已失效] 暗影典籍 ×1'), '暗影典籍 ×1');
  assert.equal(cleanRewardText('[已作废] 龙晶'), '龙晶');
  assert.equal(cleanRewardText('× 宝石'), '宝石');
  assert.equal(cleanRewardText('宝石 ×'), '宝石');
  assert.equal(cleanRewardText('[4✕] 星辰碎屑 ×2'), '星辰碎屑 ×2');
  assert.equal(CLAIMED_MARK_RE.test('[1✓] 传说权杖 ×1'), true);
  assert.equal(CLAIMED_MARK_RE.test('[ 1 ✓ ] 传说权杖 ×1'), true);
  assert.equal(CLAIMED_MARK_RE.test('[✓] 圣杯'), true);
  assert.equal(cleanRewardText('[✓] 圣杯'), '圣杯');
  assert.equal(LOST_MARK_RE.test('宝石2×'), false);
  assert.equal(cleanRewardText('宝石2×'), '宝石2×');
  assert.equal(parseClaimedSet('1、3').slots.has(3), true);
  assert.equal(parseLostSet([2, '4']).slots.has(4), true);

  // 2) 旧存档无 已失效 字段：默认 lost=false, lostCount=0
  const oldStat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-12日' },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'B', 标题: '旧档任务', 方式: '委托', 预期收益: ['金币 ×500', '药水×3'] },
        ],
      },
    },
  };
  const oldQb = questBoardState(oldStat);
  assert.equal(oldQb.items.length, 1);
  assert.equal(oldQb.items[0].lostCount, 0);
  assert.deepEqual(oldQb.items[0].rewardItems.map((r) => r.lost), [false, false]);

  // 3) questBoardState 解析 已失效 + 已兑现优先 + 数量乘号免疫 + 未接取仅含已失效不被隐藏/不被判已完结
  const mixedStat = {
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-12日' },
    任务列表: {
      '进行中剧情': { 状态: '进行中', 进展: '调查中' },
      '原版突发任务': { 状态: '进行中', 详情: '本地主线', 奖励: '[已失效] 秘宝 ×1、金币 ×500' },
    },
    事件: {
      任务情报板: {
        区域键: '白石镇',
        区域: '白石镇',
        已兑现: { q1: [1, 2] },
        已失效: { q1: [2, 3], qOpenLost: [1] },
        列表: [
          {
            id: 'q1',
            类别: '剧情任务',
            等级: 'A',
            标题: '进行中剧情',
            方式: '调查',
            预期收益: ['传说武器 ×1', '古龙鳞片 ×2', '秘银锭 ×3', '[已失效] 失窃卷轴 ×1', '金币 ×500', '药水×3'],
          },
          {
            id: 'qOpenLost',
            类别: '本地主线',
            等级: 'B',
            标题: '未接取但含失效收益',
            方式: '探索',
            预期收益: ['史诗护符 ×1', '[✕] 稀有矿石 ×2', '金币 ×300'],
          },
        ],
      },
    },
  };
  const mixedQb = questBoardState(mixedStat);
  const q1 = mixedQb.items.find((x) => x.id === 'q1');
  assert.ok(q1);
  assert.equal(q1.claimedCount, 2);
  assert.equal(q1.lostCount, 2);
  assert.deepEqual(
    q1.rewardItems.map((r) => ({ slot: r.slot, text: r.text, claimed: r.claimed, lost: r.lost })),
    [
      { slot: 1, text: '传说武器 ×1', claimed: true, lost: false },
      { slot: 2, text: '古龙鳞片 ×2', claimed: true, lost: false }, // 已兑现优先于已失效
      { slot: 3, text: '秘银锭 ×3', claimed: false, lost: true },
      { slot: 4, text: '失窃卷轴 ×1', claimed: false, lost: true },
      { slot: 5, text: '金币 ×500', claimed: false, lost: false },
      { slot: 6, text: '药水×3', claimed: false, lost: false },
    ],
  );

  // 未上墙原版进行中任务也能正确解析 [已失效] 且不误伤 金币 ×500
  const formalOnly = mixedQb.items.find((x) => x.id === 'formal:原版突发任务');
  assert.ok(formalOnly);
  assert.equal(formalOnly.lostCount, 1);
  assert.deepEqual(formalOnly.rewardItems.map((r) => ({ text: r.text, lost: r.lost })), [
    { text: '秘宝 ×1', lost: true },
    { text: '金币 ×500', lost: false },
  ]);

  // 未接取任务仅含 已失效 时，不被隐藏、不被 hasClosedQuestLeftovers/isQuestEntryClosed 误判为已完结
  const openLost = mixedQb.items.find((x) => x.id === 'qOpenLost');
  assert.ok(openLost, '未接取任务仅含 已失效 收益时不应被 questBoardState 隐藏');
  assert.equal(openLost.accepted, false);
  assert.equal(openLost.claimedCount, 0);
  assert.equal(openLost.lostCount, 2);
  assert.equal(hasClosedQuestLeftovers(mixedStat), false, '仅含 已失效 不应被判定为已完结残留');
  const sweptNoop = sweepClosedQuests(mixedStat);
  assert.equal(sweptNoop.stat.事件.任务情报板.列表.some((x) => x.id === 'qOpenLost'), true);
  assert.deepEqual(sweptNoop.stat.事件.任务情报板.已失效.qOpenLost, [1]);

  // 4) cycleQuestRewardState 三态循环：待获得 → 已兑现 ✓ → 已失效 ✕ → 待获得（含数组与对象型列表、title 别名键与行内清理、空数组删键）
  assert.ok(cycleQuestRewardState(oldStat, '', 1).error);
  assert.ok(cycleQuestRewardState(oldStat, 'q1', 0).error);

  const c1 = cycleQuestRewardState(oldStat, 'q1', 1, '旧档任务');
  assert.match(c1.done, /已兑现 ✓/);
  assert.deepEqual(c1.stat.事件.任务情报板.已兑现.q1, [1]);
  assert.equal(c1.stat.事件.任务情报板.已失效, undefined);

  const c2 = cycleQuestRewardState(c1.stat, 'q1', 1, '旧档任务');
  assert.match(c2.done, /已失效 ✕/);
  assert.equal(Object.prototype.hasOwnProperty.call(c2.stat.事件.任务情报板.已兑现, 'q1'), false, '已兑现删空后应删除键');
  assert.deepEqual(c2.stat.事件.任务情报板.已失效.q1, [1]);

  const c3 = cycleQuestRewardState(c2.stat, 'q1', 1, '旧档任务');
  assert.match(c3.done, /待获得/);
  assert.equal(Object.prototype.hasOwnProperty.call(c3.stat.事件.任务情报板.已失效, 'q1'), false, '已失效删空后应删除键');
  assert.equal(questBoardState(c3.stat).items[0].rewardItems[0].claimed, false);
  assert.equal(questBoardState(c3.stat).items[0].rewardItems[0].lost, false);

  // 对象型列表 + title 别名键 + 行内 [已失效] 清理
  const objListStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已失效: { '潮汐神殿': [1, 2] },
        列表: {
          'boss/1': {
            类别: '剧情任务',
            等级: 'A',
            标题: '潮汐神殿',
            方式: '探索',
            预期收益: ['[已失效] 圣物 ×1', '金币 ×500'],
          },
        },
      },
    },
  };
  const o1 = cycleQuestRewardState(objListStat, 'boss/1', 1, '潮汐神殿');
  assert.match(o1.done, /待获得/);
  assert.equal(o1.stat.事件.任务情报板.列表['boss/1'].预期收益[0], '圣物 ×1', '行内 [已失效] 应被清理干净');
  assert.equal(Object.prototype.hasOwnProperty.call(o1.stat.事件.任务情报板.已失效, '潮汐神殿'), false, '应清理 title 别名键');
  assert.deepEqual(o1.stat.事件.任务情报板.已失效['boss/1'], [2], '剩余栏位应规范迁移到主 key');

  const o2 = cycleQuestRewardState(o1.stat, 'boss/1', 2, '潮汐神殿');
  assert.match(o2.done, /待获得/);
  assert.equal(Object.prototype.hasOwnProperty.call(o2.stat.事件.任务情报板.已失效, 'boss/1'), false, '空数组应删除键');
  assert.equal(o2.stat.事件.任务情报板.列表['boss/1'].预期收益[1], '金币 ×500');

  const o3 = cycleQuestRewardState(o2.stat, 'boss/1', 2, '潮汐神殿');
  assert.match(o3.done, /已兑现 ✓/);
  assert.deepEqual(o3.stat.事件.任务情报板.已兑现['boss/1'], [2]);
  const o4 = cycleQuestRewardState(o3.stat, 'boss/1', 2, '潮汐神殿');
  assert.match(o4.done, /已失效 ✕/);
  assert.deepEqual(o4.stat.事件.任务情报板.已失效['boss/1'], [2]);
  assert.equal(o4.stat.事件.任务情报板.列表['boss/1'].预期收益[1], '金币 ×500');

  // 5) ignoreQuest 同步清理 board['已失效'] 对应 id 与 title 键，不影响其他任务
  const ignoreStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已兑现: { q1: [1], '要忽略的任务': [1] },
        已失效: { q1: [2], '要忽略的任务': [3], qKeep: [1] },
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'B', 标题: '要忽略的任务', 方式: '委托', 预期收益: ['甲', '乙', '丙'] },
          { id: 'qKeep', 类别: '本地主线', 等级: 'B', 标题: '保留的任务', 方式: '委托', 预期收益: ['丁', '戊'] },
        ],
      },
    },
  };
  const ignored = ignoreQuest(ignoreStat, 'q1', '要忽略的任务');
  assert.equal(Object.prototype.hasOwnProperty.call(ignored.stat.事件.任务情报板.已失效, 'q1'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ignored.stat.事件.任务情报板.已失效, '要忽略的任务'), false);
  assert.deepEqual(ignored.stat.事件.任务情报板.已失效.qKeep, [1]);

  // 6) sweepClosedQuests（数组型 + 对象型列表）同步清理 board['已失效'] 对应键，保留未完结任务
  const sweepArrStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {
      '已完结剧情': { 状态: '已失败', 进展: '结案' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        曾接取: ['曾接取已结案'],
        已兑现: { qDone1: [1], qDone2: [1] },
        已失效: { qDone1: [2, 3], '已完结剧情': [4], '曾接取已结案': [2], qOpen: [1] },
        列表: [
          { id: 'qDone1', 类别: '剧情任务', 等级: 'A', 标题: '已完结剧情', 方式: '调查', 预期收益: ['一', '二', '三', '四'] },
          { id: 'qDone2', 类别: '本地主线', 等级: 'B', 标题: '曾接取已结案', 方式: '探索', 预期收益: ['甲', '乙'] },
          { id: 'qOpen', 类别: '本地主线', 等级: 'B', 标题: '未完结任务', 方式: '探索', 预期收益: ['丙', '丁'] },
        ],
      },
    },
  };
  assert.equal(hasClosedQuestLeftovers(sweepArrStat), true);
  const sweptArr = sweepClosedQuests(sweepArrStat);
  assert.deepEqual(sweptArr.stat.事件.任务情报板.列表.map((x) => x.id), ['qOpen']);
  assert.deepEqual(sweptArr.stat.事件.任务情报板.已失效, { qOpen: [1] });

  const sweepObjStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {
      '对象型已完结': { 状态: '已完成' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已失效: { 'k/done': [1], '对象型已完结': [2], 'k/open': [1] },
        列表: {
          'k/done': { 类别: '本地主线', 等级: 'B', 标题: '对象型已完结', 方式: '调查', 预期收益: ['甲', '乙'] },
          'k/open': { 类别: '本地主线', 等级: 'B', 标题: '对象型未完结', 方式: '调查', 预期收益: ['丙', '丁'] },
        },
      },
    },
  };
  const sweptObj = sweepClosedQuests(sweepObjStat);
  assert.deepEqual(Object.keys(sweptObj.stat.事件.任务情报板.列表), ['k/open']);
  assert.deepEqual(sweptObj.stat.事件.任务情报板.已失效, { 'k/open': [1] });

  // 回归：LLM 完结移出后残留的孤儿 已兑现/已失效 键应被 hasClosedQuestLeftovers 检出并由 sweepClosedQuests 清扫，防后续复用 q1 串台
  const orphanKeyStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {
      '进行中任务': { 状态: '进行中' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已兑现: { qOld: [1, 2], qOpen: [1] },
        已失效: { qOld: [3], '已删除旧任务': [2], qOpen: [2] },
        列表: [
          { id: 'qOpen', 类别: '本地主线', 等级: 'B', 标题: '进行中任务', 方式: '探索', 预期收益: ['丙', '丁'] },
        ],
      },
    },
  };
  assert.equal(hasClosedQuestLeftovers(orphanKeyStat), true, '应检测到已脱离列表的孤儿 已兑现/已失效 键');
  const sweptOrphan = sweepClosedQuests(orphanKeyStat);
  assert.deepEqual(sweptOrphan.stat.事件.任务情报板.已兑现, { qOpen: [1] });
  assert.deepEqual(sweptOrphan.stat.事件.任务情报板.已失效, { qOpen: [2] });
  assert.equal(hasClosedQuestLeftovers(sweptOrphan.stat), false, '清扫孤儿键后不应再误报残留');

  // 7) P0 回归：id 与 title 双键并存时合并保留双方栏号，写回归并到 id 并删除 title 键不丢数据
  const dualKeyStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '双键合并任务': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已兑现: { qDual: [1], '双键合并任务': [2] },
        已失效: { qDual: [3], '双键合并任务': [4] },
        列表: [
          {
            id: 'qDual',
            类别: '本地主线',
            等级: 'B',
            标题: '双键合并任务',
            方式: '调查',
            预期收益: ['甲', '乙', '丙', '丁', '戊'],
          },
        ],
      },
    },
  };
  assert.deepEqual(mergeRewardMapEntries(dualKeyStat.事件.任务情报板.已兑现, 'qDual', '双键合并任务'), [1, 2]);
  assert.deepEqual(mergeRewardMapEntries(dualKeyStat.事件.任务情报板.已失效, 'qDual', '双键合并任务'), [3, 4]);
  const dualQb = questBoardState(dualKeyStat).items[0];
  assert.deepEqual(
    dualQb.rewardItems.map((r) => ({ slot: r.slot, claimed: r.claimed, lost: r.lost })),
    [
      { slot: 1, claimed: true, lost: false },
      { slot: 2, claimed: true, lost: false },
      { slot: 3, claimed: false, lost: true },
      { slot: 4, claimed: false, lost: true },
      { slot: 5, claimed: false, lost: false },
    ],
  );
  // 栏 5 打勾：已兑现归并 [1, 2, 5] 到 qDual 并删 title 键，不丢栏 2
  const dualClaim5 = cycleQuestRewardState(dualKeyStat, 'qDual', 5, '双键合并任务');
  assert.deepEqual(dualClaim5.stat.事件.任务情报板.已兑现.qDual, [1, 2, 5]);
  assert.equal(Object.prototype.hasOwnProperty.call(dualClaim5.stat.事件.任务情报板.已兑现, '双键合并任务'), false);
  // 栏 3 从已失效恢复待获得：已失效归并保留栏 4 到 qDual 并删 title 键，不丢栏 4
  const dualRestore3 = cycleQuestRewardState(dualClaim5.stat, 'qDual', 3, '双键合并任务');
  assert.deepEqual(dualRestore3.stat.事件.任务情报板.已失效.qDual, [4]);
  assert.equal(Object.prototype.hasOwnProperty.call(dualRestore3.stat.事件.任务情报板.已失效, '双键合并任务'), false);

  // 8) P0 回归：原 预期收益 数组含空串时，清除行内标记索引不错位
  const sparseRewardsStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '含空项收益任务': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          {
            id: 'qSparse',
            类别: '本地主线',
            等级: 'B',
            标题: '含空项收益任务',
            方式: '委托',
            预期收益: ['', '史诗武器 [✓]', '   ', '[已失效] 秘银 ×2'],
          },
        ],
      },
    },
  };
  const sparseQb = questBoardState(sparseRewardsStat).items[0];
  assert.deepEqual(
    sparseQb.rewardItems.map((r) => ({ slot: r.slot, text: r.text, claimed: r.claimed, lost: r.lost })),
    [
      { slot: 1, text: '史诗武器', claimed: true, lost: false },
      { slot: 2, text: '秘银 ×2', claimed: false, lost: true },
    ],
  );
  // toggleQuestRewardClaimed 取消栏 1 行内 [✓] 时不发生索引错位
  const sparseUntoggle = toggleQuestRewardClaimed(sparseRewardsStat, 'qSparse', 1, '含空项收益任务');
  assert.deepEqual(sparseUntoggle.stat.事件.任务情报板.列表[0].预期收益, ['史诗武器', '[已失效] 秘银 ×2']);
  // cycleQuestRewardState 对栏 1（待获得 -> 已兑现 -> 已失效）及栏 2（已失效 -> 待获得）索引完全准确
  const sparseCycle1 = cycleQuestRewardState(sparseRewardsStat, 'qSparse', 1, '含空项收益任务');
  assert.deepEqual(sparseCycle1.stat.事件.任务情报板.列表[0].预期收益, ['史诗武器', '[已失效] 秘银 ×2']);
  assert.deepEqual(sparseCycle1.stat.事件.任务情报板.已失效.qSparse, [1]);
  const sparseCycle2 = cycleQuestRewardState(sparseCycle1.stat, 'qSparse', 2, '含空项收益任务');
  assert.deepEqual(sparseCycle2.stat.事件.任务情报板.列表[0].预期收益, ['史诗武器', '秘银 ×2']);

  // 9) P0 回归：toggleQuestRewardClaimed 给已失效栏位打勾后同步清掉 已失效，再次取消打勾不会“复活”为已失效
  const reviveGuardStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '防复活校验': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已失效: { qGuard: [1] },
        列表: [
          {
            id: 'qGuard',
            类别: '本地主线',
            等级: 'B',
            标题: '防复活校验',
            方式: '调查',
            预期收益: ['传说护符 ×1', '[已失效] 古董 ×1'],
          },
        ],
      },
    },
  };
  const guardClaim1 = toggleQuestRewardClaimed(reviveGuardStat, 'qGuard', 1, '防复活校验');
  assert.deepEqual(guardClaim1.stat.事件.任务情报板.已兑现.qGuard, [1]);
  assert.equal(Object.prototype.hasOwnProperty.call(guardClaim1.stat.事件.任务情报板.已失效, 'qGuard'), false, '打勾后应同步清除 已失效 对应栏位并删空键');
  const guardUnclaim1 = toggleQuestRewardClaimed(guardClaim1.stat, 'qGuard', 1, '防复活校验');
  const guardItem1 = questBoardState(guardUnclaim1.stat).items[0].rewardItems[0];
  assert.equal(guardItem1.claimed, false);
  assert.equal(guardItem1.lost, false, '取消打勾后不得复活为已失效');

  // 行内 [已失效] 栏位打勾再取消同样不会复活为已失效
  const guardClaim2 = toggleQuestRewardClaimed(guardUnclaim1.stat, 'qGuard', 2, '防复活校验');
  assert.equal(guardClaim2.stat.事件.任务情报板.列表[0].预期收益[1], '古董 ×1');
  const guardUnclaim2 = toggleQuestRewardClaimed(guardClaim2.stat, 'qGuard', 2, '防复活校验');
  const guardItem2 = questBoardState(guardUnclaim2.stat).items[0].rewardItems[1];
  assert.equal(guardItem2.claimed, false);
  assert.equal(guardItem2.lost, false, '行内 [已失效] 栏位打勾再取消后不得复活为已失效');
});

test('入口模式配置：默认悬浮框、读写归一化与持久化', () => {
  const mem = new Map();
  const read = (k) => mem.get(k) || '';
  const write = (k, v) => mem.set(k, v);

  assert.equal(readEntryMode(read), ENTRY_MODES.FAB);
  assert.equal(normalizeEntryMode('WAND'), ENTRY_MODES.WAND);
  assert.equal(normalizeEntryMode('invalid'), ENTRY_MODES.FAB);

  assert.equal(writeEntryMode(write, 'wand'), ENTRY_MODES.WAND);
  assert.equal(mem.get(ENTRY_MODE_KEY), 'wand');
  assert.equal(readEntryMode(read), ENTRY_MODES.WAND);

  assert.equal(writeEntryMode(write, 'anything-else'), ENTRY_MODES.FAB);
  assert.equal(mem.get(ENTRY_MODE_KEY), 'fab');
  assert.equal(readEntryMode(read), ENTRY_MODES.FAB);
});

function createMiniDom() {
  const byId = new Map();
  const docListeners = new Map();
  const makeClassList = (el) => ({
    contains: (c) => el._classes.has(c),
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    toggle: (c, force) => {
      const next = force === undefined ? !el._classes.has(c) : !!force;
      if (next) el._classes.add(c);
      else el._classes.delete(c);
      return next;
    },
  });
  const createEl = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      _id: '',
      _classes: new Set(),
      _attrs: new Map(),
      _listeners: new Map(),
      children: [],
      parentElement: null,
      style: {},
      textContent: '',
      set id(v) {
        if (this._id && byId.get(this._id) === this) byId.delete(this._id);
        this._id = String(v || '');
        if (this._id && this.isConnected) byId.set(this._id, this);
      },
      get id() {
        return this._id;
      },
      set className(v) {
        this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
      },
      get className() {
        return Array.from(this._classes).join(' ');
      },
      get isConnected() {
        let cur = this;
        while (cur) {
          if (cur === doc.documentElement) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      setAttribute(k, v) {
        this._attrs.set(k, String(v));
      },
      getAttribute(k) {
        return this._attrs.get(k) ?? null;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (!n) continue;
          n.parentElement = this;
          this.children.push(n);
          const registerTree = (cur) => {
            if (cur._id && cur.isConnected) byId.set(cur._id, cur);
            cur.children?.forEach(registerTree);
          };
          registerTree(n);
        }
      },
      remove() {
        const unregisterTree = (cur) => {
          if (cur._id && byId.get(cur._id) === cur) byId.delete(cur._id);
          cur.children?.forEach(unregisterTree);
        };
        unregisterTree(this);
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
          this.parentElement = null;
        }
      },
      closest(sel) {
        if (sel.startsWith('#') && this._id === sel.slice(1)) return this;
        return null;
      },
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const list = this._listeners.get(ev.type) || [];
        for (const fn of list) fn(ev);
      },
    };
    node.classList = makeClassList(node);
    return node;
  };
  const doc = {
    documentElement: null,
    head: null,
    body: null,
    createElement: createEl,
    getElementById: (id) => byId.get(id) || null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!docListeners.has(type)) return;
      docListeners.set(type, docListeners.get(type).filter((x) => x !== fn));
    },
    dispatchDocClick(target) {
      const list = docListeners.get('click') || [];
      for (const fn of list) fn({ target });
    },
  };
  doc.documentElement = createEl('html');
  doc.head = createEl('head');
  doc.body = createEl('body');
  doc.documentElement.append(doc.head, doc.body);
  return doc;
}

test('魔法棒菜单入口：挂载 #extensionsMenu、同步未读、点击收起并打开、销毁清理', () => {
  const doc = createMiniDom();
  const win = { getComputedStyle: (el) => ({ display: el.style.display || 'block' }) };

  const menu = doc.createElement('div');
  menu.id = 'extensionsMenu';
  menu.style.display = 'block';
  const triggerBtn = doc.createElement('div');
  triggerBtn.id = 'extensionsMenuButton';
  doc.body.append(menu, triggerBtn);

  let opened = 0;
  const wand = mountWand(doc, win, { onOpen: () => { opened += 1; } });

  const item = doc.getElementById('quest-helper-wand-item');
  assert.ok(item, '应挂载到 #extensionsMenu');
  assert.equal(item.parentElement, menu);
  assert.ok(doc.getElementById('quest-helper-wand-style'), '应注入样式节点');

  wand.setUnread(true);
  assert.equal(item.classList.contains('has-unread'), true);

  item.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  assert.equal(opened, 1);
  assert.equal(menu.style.display, 'none', '点击后应顺手收起魔法棒菜单');

  // 若 #extensionsMenu 晚于挂载出现，点击魔法棒触发按钮时自动补挂并保留未读状态
  item.remove();
  assert.equal(doc.getElementById('quest-helper-wand-item'), null);
  doc.dispatchDocClick(triggerBtn);
  const reattached = doc.getElementById('quest-helper-wand-item');
  assert.ok(reattached, '点击魔法棒按钮时应自动补挂缺失菜单项');
  assert.equal(reattached.classList.contains('has-unread'), true);

  wand.destroy();
  assert.equal(doc.getElementById('quest-helper-wand-item'), null);
  assert.equal(doc.getElementById('quest-helper-wand-style'), null);
});

// ---------------------------------------------------------------------------
// 4. 最终构建产物校验
// ---------------------------------------------------------------------------

test(`构建产物 ⭐粘这个-任务助手脚本.js、.txt、dist/quest-assistant.js 与 ${builtWorldbookName} 合法且一致`, () => {
  assert.equal(fs.existsSync(builtScriptPath), true, '应先运行 build.mjs 生成最终脚本');
  assert.equal(fs.existsSync(builtScriptTxtPath), true, '应同步生成 .txt 脚本产物');
  assert.equal(fs.existsSync(builtDistScriptPath), true, '应同步生成 dist/quest-assistant.js 供 jsDelivr 分发');
  assert.equal(fs.existsSync(builtWorldbookPath), true, `应同步生成 ${builtWorldbookName} 交付物`);
  assert.equal(fs.existsSync(path.join(__dirname, '⭐导入这个-命定任务助手世界书.json')), false, '旧版固定名称世界书文件应已清理');
  const strayWb = fs.readdirSync(__dirname).filter(
    (name) => /^命定任务助手世界书v\d+\.\d+\.\d+.*\.json$/i.test(name) && name !== builtWorldbookName,
  );
  assert.deepEqual(strayWb, [], '不应残留历史版本的世界书交付 JSON');
  const code = fs.readFileSync(builtScriptPath, 'utf8');
  const txtCode = fs.readFileSync(builtScriptTxtPath, 'utf8');
  const distCode = fs.readFileSync(builtDistScriptPath, 'utf8');
  const wbJson = JSON.parse(fs.readFileSync(builtWorldbookPath, 'utf8'));
  assert.equal(txtCode, code, '⭐粘这个-任务助手脚本.txt 应与 .js 产物完全一致');
  assert.equal(distCode, code, 'dist/quest-assistant.js 应与 .js 产物完全一致');
  const builtWbJson = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  assert.deepEqual(wbJson, builtWbJson, `${builtWorldbookName} 应与 buildWorldbookJson 产物完全一致`);
  assert.equal(wbJson?.entries?.['0']?.comment, `[mvu_plot]任务助手-剧情引导${SCRIPT_VERSION}`);
  assert.equal(wbJson?.entries?.['0']?.order, 1150);
  assert.equal(wbJson?.entries?.['0']?.constant, true);
  assert.equal(wbJson?.entries?.['0']?.disable, false);
  assert.equal(wbJson?.entries?.['1']?.comment, `[mvu_plot]任务助手-变量更新${SCRIPT_VERSION}`);
  assert.equal(wbJson?.entries?.['1']?.order, 99999);
  assert.equal(wbJson?.entries?.['1']?.constant, true);
  assert.equal(wbJson?.entries?.['1']?.disable, false);
  assert.ok(code.length > 5000, '产物内容过短');
  assert.doesNotMatch(code, /<\/script>/i, '产物不得包含未转义 </script>');
  assert.doesNotMatch(code, /UNNCore|unn-core-studio|unn-core-fab|unn_studio_fab_pos_v1|unn_qb_seen_progress/, '不得与 UNN 命名空间冲突');
  assert.match(code, /QuestHelperApp/);
  assert.match(code, /quest-helper-studio/);
  assert.match(code, /quest-helper-fab/);
  assert.match(code, /quest-helper-wand-item/);
  assert.match(code, /quest_helper_entry_mode_v1/);
  assert.match(code, /quest_helper_script_ref_v1/);
  assert.match(code, /v1\.4\.0/);
  assert.match(code, new RegExp(SCRIPT_VERSION.replace(/\./g, '\\.')));
  assert.doesNotThrow(() => new Function(code), '产物必须通过 new Function 语法校验');
  assert.doesNotThrow(() => new Function(`"use strict";\n${code}`), '产物必须兼容严格模式 / ES Module import');
});

test('脚本版本号配置与实时最新版本拉取：归一化、Semver排序与 GitHub / jsDelivr 回退', async () => {
  assert.equal(DEFAULT_SCRIPT_REF, 'main');
  assert.equal(normalizeScriptRef(' @v1.4.0 '), 'v1.4.0');
  assert.equal(normalizeScriptRef('main'), 'main');
  assert.equal(normalizeScriptRef('../evil'), '');
  assert.equal(normalizeScriptRef('/v1.4.0'), '');
  assert.equal(normalizeScriptRef('v1.4.0?x=1'), '');
  assert.ok(compareSemverTags('v1.10.0', 'v1.4.2') < 0);
  assert.ok(compareSemverTags('v1.4.2', 'v1.4.1') < 0);

  // 更新红点判定边界
  assert.equal(hasNewerScriptVersion('v1.4.4', { loadedRef: 'v1.4.3', scriptVersion: 'v1.4.3' }), true);
  assert.equal(hasNewerScriptVersion('v1.4.4', { loadedRef: 'v1.4.4', scriptVersion: 'v1.4.4' }), false);
  assert.equal(hasNewerScriptVersion('v1.4.4', { loadedRef: 'main', scriptVersion: 'v1.4.3' }), true);
  assert.equal(hasNewerScriptVersion('v1.4.4', { loadedRef: 'main', scriptVersion: 'v1.4.4' }), false);
  assert.equal(hasNewerScriptVersion('', { loadedRef: 'v1.4.3', scriptVersion: 'v1.4.3' }), false);

  // 世界书子标题识别与脚本版本匹配校验（决定红点提醒）
  assert.equal(extractVersionFromText('任务助手v1.4.4'), 'v1.4.4');
  assert.equal(extractVersionFromText('任务助手 1.4.5'), 'v1.4.5');
  assert.equal(extractVersionFromText('任务助手'), '');

  const wbMatched = inspectWorldbookEntries([
    {
      bookName: '其他世界书',
      entries: [{ name: '无关设定', enabled: true, content: '一些设定' }],
    },
    {
      bookName: '命定任务助手v1.4.4',
      entries: [
        { name: '任务助手v1.4.3', enabled: false, content: '/事件/任务情报板' },
        { name: '任务助手v1.4.4', enabled: true, content: '/事件/任务情报板' },
      ],
    },
  ]);
  assert.equal(wbMatched.found, true);
  assert.equal(wbMatched.enabled, true);
  assert.equal(wbMatched.version, 'v1.4.4');
  assert.equal(wbMatched.title, '任务助手v1.4.4');

  // 兜底从正文 @version 或世界书书名读取版本
  const wbContentVer = inspectWorldbookEntries([
    { bookName: '自定义世界书', entries: [{ name: '自定义标题', enabled: true, content: '// @version v1.4.5\n/事件/任务情报板' }] },
  ]);
  assert.equal(wbContentVer.version, 'v1.4.5');

  // 匹配时不显示红点，不匹配时亮红点建议更新
  assert.deepEqual(
    checkWorldbookCompatibility(wbMatched, { loadedRef: '1.4.4', scriptVersion: 'v1.4.5' }).mismatch,
    false,
  );
  assert.equal(
    checkWorldbookCompatibility(wbMatched, { loadedRef: '1.4.4', scriptVersion: 'v1.4.5' }).status,
    'matched',
  );
  const wbMismatch = checkWorldbookCompatibility(wbMatched, { loadedRef: 'v1.4.5', scriptVersion: 'v1.4.5' });
  assert.equal(wbMismatch.status, 'mismatch');
  assert.equal(wbMismatch.mismatch, true);
  const wbMainMatched = checkWorldbookCompatibility(wbContentVer, { loadedRef: 'main', scriptVersion: 'v1.4.5' });
  assert.equal(wbMainMatched.status, 'matched');
  assert.equal(wbMainMatched.mismatch, false);
  assert.equal(
    checkWorldbookCompatibility({ supported: true, found: false }, { loadedRef: 'v1.4.5' }).mismatch,
    false,
  );
  assert.equal(
    checkWorldbookCompatibility({ supported: true, found: true, enabled: false, version: 'v1.4.5' }, { loadedRef: 'v1.4.5' }).mismatch,
    true,
  );

  // 双条目世界书（双 [mvu_plot]）检测：完整匹配 / 半启用提醒 / 旧 [mvu_update] 迁移提醒 / 版本冲突提醒
  const wbDualOk = inspectWorldbookEntries([
    {
      bookName: '命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.8', enabled: true, content: '// @role update\n<任务情报板变量更新协议>\n/事件/任务情报板' },
      ],
    },
  ]);
  assert.equal(wbDualOk.dualMode, true);
  assert.equal(wbDualOk.enabled, true);
  assert.equal(wbDualOk.legacyMvuUpdate, undefined);
  assert.equal(wbDualOk.version, 'v1.4.8');
  assert.deepEqual(wbDualOk.titles, ['[mvu_plot]任务助手-剧情引导v1.4.8', '[mvu_plot]任务助手-变量更新v1.4.8']);
  assert.equal(checkWorldbookCompatibility(wbDualOk, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' }).status, 'matched');

  const wbDualLegacyUpdate = inspectWorldbookEntries([
    {
      bookName: '旧版命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_update]任务助手-变量更新v1.4.8', enabled: true, content: '// @role update\n<任务情报板变量更新协议>\n/事件/任务情报板' },
      ],
    },
  ]);
  assert.equal(wbDualLegacyUpdate.dualMode, true);
  assert.equal(wbDualLegacyUpdate.legacyMvuUpdate, true);
  const compatLegacyUpdate = checkWorldbookCompatibility(wbDualLegacyUpdate, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' });
  assert.equal(compatLegacyUpdate.status, 'legacy_mvu_update');
  assert.equal(compatLegacyUpdate.mismatch, true);

  const wbDualPartial = inspectWorldbookEntries([
    {
      bookName: '命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.8', enabled: false, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbDualPartial.partialDisabled, true);
  assert.equal(wbDualPartial.missingRole, 'update');
  const compatPartial = checkWorldbookCompatibility(wbDualPartial, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' });
  assert.equal(compatPartial.status, 'partial_disabled');
  assert.equal(compatPartial.mismatch, true);

  // 旧版已禁用 + 仅启用半边双条目时，仍应报 partial_disabled
  const wbDisabledLegacyPlusHalfDual = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '[mvu_plot][mvu_update]任务助手v1.4.8', enabled: false, content: '// @version v1.4.8\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-剧情引导v1.4.9', enabled: true, content: '// @role plot\n/事件/任务情报板' },
      ],
    },
  ]);
  assert.equal(wbDisabledLegacyPlusHalfDual.partialDisabled, true);
  assert.equal(wbDisabledLegacyPlusHalfDual.missingRole, 'update');

  // 旧版联合条目与分拆条目混开：报 legacy_dual_mixed
  const wbLegacyMixed = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '[mvu_plot][mvu_update]任务助手v1.4.8', enabled: true, content: '// @version v1.4.8\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.9', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbLegacyMixed.legacyDualMixed, true);
  assert.equal(checkWorldbookCompatibility(wbLegacyMixed, { loadedRef: 'v1.4.9', scriptVersion: 'v1.4.9' }).status, 'legacy_dual_mixed');

  // 同角色条目重复启用：报 duplicate_role
  const wbDupRole = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.9', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.9', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
        { name: '[mvu_plot]任务助手-变量更新副本', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbDupRole.duplicateConflict, true);
  assert.equal(checkWorldbookCompatibility(wbDupRole, { loadedRef: 'v1.4.9', scriptVersion: 'v1.4.9' }).status, 'duplicate_role');

  // 双条目其中一条缺版本号：报 version_unannotated（不再误判 matched）
  const wbMissingRoleVer = inspectWorldbookEntries([
    {
      bookName: '命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.9', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbMissingRoleVer.missingRoleVersion, true);
  const compatUnannotated = checkWorldbookCompatibility(wbMissingRoleVer, { loadedRef: 'v1.4.9', scriptVersion: 'v1.4.9' });
  assert.equal(compatUnannotated.status, 'version_unannotated');
  assert.equal(compatUnannotated.mismatch, true);

  const wbDualConflict = inspectWorldbookEntries([
    {
      bookName: '命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.9', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbDualConflict.versionConflict, true);
  const compatConflict = checkWorldbookCompatibility(wbDualConflict, { loadedRef: 'v1.4.9', scriptVersion: 'v1.4.9' });
  assert.equal(compatConflict.status, 'mismatch');
  assert.equal(compatConflict.mismatch, true);

  // 主世界书防误伤 & 版本提取边界（多数字标题取末段、主世界书书名不污染、缺 [mvu_plot] 标签告警、多书合并、partial_disabled 指明角色）
  assert.equal(extractVersionFromText('2.0版 任务助手v1.4.8'), 'v1.4.8');
  assert.equal(isQuestAssistantEntry({ name: '事件链路与任务情报板适配说明', enabled: true, content: '请勿手改 /事件/任务情报板 字段。' }), false);
  // 命定之诗原版主世界书自带的 [mvu_update] 条目（含"变量更新"字样）绝不能被误判为任务助手条目
  assert.equal(
    isQuestAssistantEntry({
      name: '[本体][变量][mvu_update]变量更新规则',
      enabled: true,
      content: 'variables_update_rules: ...',
    }),
    false,
  );
  assert.equal(
    isQuestAssistantEntry({
      name: '[DLC][扩展][边陲之国][mvu_update]莉莉变量更新规则',
      enabled: true,
      content: 'variables_update_rules: ...',
    }),
    false,
  );
  const wbMainBookSafe = inspectWorldbookEntries([
    {
      bookName: '命定之诗v4.3.4',
      entries: [
        { name: '[本体][变量][mvu_update]变量更新规则', enabled: true, content: 'variables_update_rules: ...' },
        { name: '[DLC][扩展][边陲之国][mvu_update]莉莉变量更新规则', enabled: true, content: 'variables_update_rules: ...' },
        { name: '事件适配备忘', enabled: true, content: '可参考 /事件/任务情报板 与 任务情报板 路径' },
        { name: '[mvu_plot]任务助手-剧情引导', enabled: true, content: '// @role plot\n<任务情报板>...</任务情报板>' },
      ],
    },
    {
      bookName: '自建补充书',
      entries: [
        { name: '[mvu_plot]任务助手-变量更新', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbMainBookSafe.version, '');
  assert.equal(wbMainBookSafe.duplicateConflict, undefined);
  assert.equal(wbMainBookSafe.legacyDualMixed, undefined);
  assert.equal(wbMainBookSafe.bookName, '命定之诗v4.3.4 / 自建补充书');

  const wbMissingMvuTag = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '剧情引导v1.4.8', enabled: true, content: '// @role plot\n<任务情报板>...</任务情报板>' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.8', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(wbMissingMvuTag.missingMvuTag, true);
  const compatMissingTag = checkWorldbookCompatibility(wbMissingMvuTag, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' });
  assert.equal(compatMissingTag.status, 'missing_mvu_tag');
  assert.equal(compatMissingTag.mismatch, true);
  assert.match(compatPartial.message, /变量更新 \[mvu_plot\]/);

  // buildWorldbookJson 双 [mvu_plot] 子条目派生、版本一致性校验、角色隔离、主模型单轮重扫时序与标准协议校验
  assert.throws(() => buildWorldbookJson('no role marker', SCRIPT_VERSION), /_wbRole/);
  assert.throws(() => buildWorldbookJson(ejsSource, 'v9.9.9'), /@version/);
  const dualJson = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  assert.equal(dualJson.entries['0'].comment, `[mvu_plot]任务助手-剧情引导${SCRIPT_VERSION}`);
  assert.equal(dualJson.entries['0'].order, 1150);
  assert.equal(dualJson.entries['1'].comment, `[mvu_plot]任务助手-变量更新${SCRIPT_VERSION}`);
  assert.equal(dualJson.entries['1'].order, 99999);
  assert.doesNotMatch(dualJson.entries['0'].comment, /\[mvu_update\]/i);
  assert.doesNotMatch(dualJson.entries['1'].comment, /\[mvu_update\]/i);

  // 边界兼容补充：无 @role 单条目不因 [mvu_plot] 误报半启用、禁用旧 [mvu_update] 不误报、legacy_mvu_update 优先及徽章全覆盖
  const wbSingleWithPlotTag = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '[mvu_plot]任务助手v1.4.8', enabled: true, content: '<任务情报板>...</任务情报板>\n任务情报板变量更新规则' },
      ],
    },
  ]);
  assert.equal(checkWorldbookCompatibility(wbSingleWithPlotTag, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' }).status, 'matched');

  const wbSingleLegacyUpdateTag = inspectWorldbookEntries([
    {
      bookName: '主世界书',
      entries: [
        { name: '[mvu_update]任务助手v1.4.8', enabled: true, content: '// @version v1.4.8\n/事件/任务情报板' },
      ],
    },
  ]);
  assert.equal(checkWorldbookCompatibility(wbSingleLegacyUpdateTag, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' }).status, 'legacy_mvu_update');

  const wbDualWithDisabledLegacy = inspectWorldbookEntries([
    {
      bookName: '命定任务助手世界书',
      entries: [
        { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n/事件/任务情报板' },
        { name: '[mvu_plot]任务助手-变量更新v1.4.8', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
        { name: '[mvu_update]任务助手-变量更新v1.4.7', enabled: false, content: '// @role update\n<任务情报板变量更新协议>' },
      ],
    },
  ]);
  assert.equal(checkWorldbookCompatibility(wbDualWithDisabledLegacy, { loadedRef: 'v1.4.8', scriptVersion: 'v1.4.8' }).status, 'matched');

  assert.deepEqual(
    worldbookCompatibilityBadge({ status: 'legacy_mvu_update', mismatch: true }, {}),
    { text: '含旧 [mvu_update] 前缀', tone: 'warn' },
  );
  assert.deepEqual(
    worldbookCompatibilityBadge({ status: 'missing_mvu_tag', mismatch: true }, {}),
    { text: '缺少 [mvu_plot] 标签', tone: 'warn' },
  );
  assert.deepEqual(
    worldbookCompatibilityBadge({ status: 'matched', mismatch: false }, {}),
    { text: '✓ 与脚本匹配', tone: 'ok' },
  );

  const plotSrc = dualJson.entries['0'].content;
  const updateSrc = dualJson.entries['1'].content;

  // 主模型单轮重扫时序：点重扫时消息数=10，用户发消息后消息数=11（末尾 is_user: true）→ plot 与 update 同步命中 rescan 且空板补剧情与词条
  const mainTurnChat11 = Array.from({ length: 11 }, (_, idx) => ({
    is_user: idx % 2 === 0,
    is_system: false,
    mes: idx === 10 ? '我们先打听一下潮汐后续的情况。' : '对话',
  }));
  const extraChat12 = [
    ...mainTurnChat11,
    { is_user: false, is_system: false, mes: 'AI 正文刚落地' },
  ];
  const extraRescanStat = {
    世界: { 地点: '卡拉什利亚斯-巡天王庭', 时间: '复兴纪元488年-5月-26日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-5月-26日',
        意向: ['q_locked'],
        待重扫: { 楼层: '9', 消息数: '10' },
        列表: [
          {
            id: 'q_locked',
            类别: '支线任务',
            等级: 'B',
            标题: '潮汐后续',
            方式: '调查',
            摘要: '港务官密报异常',
          },
          {
            id: 'q_old_side',
            类别: '支线任务',
            等级: 'D',
            标题: '旧城巡逻',
            方式: '委托',
            摘要: '常规巡防工作',
          },
        ],
      },
    },
  };
  const storyRelocateStat = {
    世界: { 地点: '卡拉什利亚斯-巡天王庭', 时间: '复兴纪元488年-5月-26日' },
    任务列表: {
      '王庭裂隙': { 状态: '进行中', 进展: '[5月-25日] 收到王庭密函' },
    },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-5月-26日',
        列表: [
          {
            id: 'q_story',
            类别: '剧情任务',
            等级: 'A',
            标题: '王庭裂隙',
            方式: '调查',
            摘要: '王庭深处魔力紊乱',
            真相: '旧日封印松动',
            预期收益: ['传说王庭徽章 ×1', '金币 ×300'],
          },
        ],
      },
    },
  };
  const plotOut = renderEjs(storyRelocateStat, { chat: extraChat12, lastUserMessageId: 10, source: plotSrc });
  const plotRescanOut = renderEjs(extraRescanStat, { chat: mainTurnChat11, lastUserMessageId: 10, source: plotSrc });
  const updateOut = renderEjs(extraRescanStat, { chat: mainTurnChat11, lastUserMessageId: 10, source: updateSrc });

  // plot 零加粗、零 Patch、零变量协议，且在 relocate + 活跃剧情任务下仍保留波折节拍、收益边界与当前环境
  assert.equal((plotOut.match(/\*\*[^*]+\*\*/g) || []).length, 0, 'plot 模式不得包含加粗红线');
  assert.doesNotMatch(plotOut, /variables_update_rules|任务情报板变量更新协议|兑现Patch|失效Patch|完结移出|生成规格|严禁/);
  assert.match(plotOut, /当前环境:/);
  assert.match(plotOut, /波折节拍:/);
  assert.match(plotOut, /收益边界:/);
  assert.match(plotOut, /支线限本区单点闭环直接推进，不设反转/);
  assert.match(plotRescanOut, /已启动地区情报重扫|已预约地区情报重扫|正在刷新本区情报/);

  // update 严格 1 处加粗、含标准隐形节点变量更新协议、零纯剧情波折重复、能识别用户消息提及的锁定任务、精准命中 rescan 且补剧情与词条
  assert.equal((updateOut.match(/\*\*[^*]+\*\*/g) || []).length, 1, 'update 模式应严格保留 1 处加粗红线');
  assert.match(updateOut, /<任务情报板变量更新协议>/);
  assert.match(updateOut, /<任务情报板当前状态>/);
  assert.match(updateOut, /当前区余波键：未建立/);
  assert.match(updateOut, /任务情报板变量更新规则（路径为 `事件\.任务情报板`）:/);
  assert.doesNotMatch(updateOut, /^variables_update_rules:/m);
  assert.doesNotMatch(updateOut, /波折节拍:|演化与完结:|层级与串联:|层级护栏:/);
  assert.match(updateOut, /潮汐后续/);
  assert.match(updateOut, /启动地区情报重扫：保留剧情任务、已接取与 `★已锁定` 项，按当前区域重新生成 1~2 条本地主线 \+ 2~3 条支线任务/);
  assert.match(updateOut, /没有剧情任务时补 1 条剧情任务/);
  assert.match(updateOut, /为当前区域写入 3 条差异化色阶的初始常驻词条/);
  assert.match(updateOut, /"op": "remove", "path": "\/事件\/任务情报板\/待重扫"/);
  assert.match(updateOut, /不在单次遭遇内完结/);
  assert.match(updateOut, /不在击败敌方或处理表象后草率完结/);

  // maintain 模式下正文未直呼锁定任务标题时，update 轮仍保留 ★已锁定 项与兑现Patch，且不重复输出词条正文
  const maintainLockedStat = {
    世界: { 地点: '铁炉堡-北区', 时间: '复兴纪元488年-5月-26日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-5月-26日',
        意向: ['q_locked'],
        余波: { 铁炉堡: ['[绿]【矿炉稳产】高炉运转稳定，武器工坊供应充足。'] },
        列表: [
          { id: 'q_locked', 类别: '支线任务', 等级: 'D', 标题: '潮汐后续', 方式: '调查', 摘要: '港务官密报异常', 预期收益: ['金币 ×60'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '北区巡防', 方式: '委托', 摘要: '核查夜巡班次' },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '修理风箱', 方式: '委托', 摘要: '铁匠铺需要修风箱' },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '核对矿单', 方式: '委托', 摘要: '清点今日运矿清单' },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '清理炉灰', 方式: '委托', 摘要: '清理炉膛积灰' },
        ],
      },
    },
  };
  const maintainLockedUpdateOut = renderEjs(maintainLockedStat, {
    chat: [{ is_user: true, is_system: false, mes: '我去港务官办公室直接看一眼情况。' }],
    lastUserMessageId: 0,
    source: updateSrc,
  });
  assert.match(maintainLockedUpdateOut, /潮汐后续/);
  assert.match(maintainLockedUpdateOut, /兑现Patch/);
  assert.match(maintainLockedUpdateOut, /当前区余波键：已存在（铁炉堡）/);
  assert.match(maintainLockedUpdateOut, /本区词条（键: `铁炉堡`，已存在）:/);
  assert.doesNotMatch(maintainLockedUpdateOut, /高炉运转稳定，武器工坊供应充足/);

  // init 模式下将首批余波并入整板 insert 示例，不重复要求独立 insert 余波，并保留生成完结约束
  const initUpdateOut = renderEjs({ 世界: { 地点: '雾晶港', 时间: '复兴纪元488年-5月-26日' }, 事件: {} }, { source: updateSrc });
  assert.match(initUpdateOut, /"余波": \{ "雾晶港": /);
  assert.match(initUpdateOut, /不再单独 `insert \/事件\/任务情报板\/余波`/);
  assert.match(initUpdateOut, /不在单次遭遇内完结/);

  // 续写（continue/append/appendFinal）与重Roll（swipe）在 nc+1 与 nc+2 下均不得触发重扫
  const extraChat11Ai = extraChat12.slice(0, 11);
  extraChat11Ai[10] = { is_user: false, is_system: false, mes: 'AI在nc+1直接落地' };
  for (const genType of ['continue', 'swipe', 'append', 'appendFinal']) {
    const gatedPlotOut = renderEjs(extraRescanStat, {
      chat: mainTurnChat11,
      lastUserMessageId: 10,
      generateType: genType,
      source: plotSrc,
    });
    const gatedUpdateOut = renderEjs(extraRescanStat, {
      chat: mainTurnChat11,
      lastUserMessageId: 10,
      generateType: genType,
      source: updateSrc,
    });
    const gatedWithinWindow = renderEjs(extraRescanStat, {
      chat: extraChat11Ai,
      lastUserMessageId: 9,
      generateType: genType,
      source: updateSrc,
    });
    assert.doesNotMatch(gatedPlotOut, /已预约地区情报重扫/, `${genType} 不应误触发 plot 重扫提示`);
    assert.doesNotMatch(gatedUpdateOut, /启动地区情报重扫/, `${genType} 不应放宽 update 重扫窗口`);
    assert.doesNotMatch(gatedWithinWindow, /启动地区情报重扫/, `${genType} 在 <= nc+1 内同样不应触发重扫`);
  }
  // nc+1 末尾为 AI 回复或 nc+2 时，plot 与 update 均不再触发重扫（单主模型窗口，不再放宽到额外模型）
  assert.doesNotMatch(
    renderEjs(extraRescanStat, { chat: extraChat11Ai, lastUserMessageId: 9, Mvu: { isDuringExtraAnalysis: () => true }, source: updateSrc }),
    /启动地区情报重扫/,
  );
  assert.doesNotMatch(
    renderEjs(extraRescanStat, { chat: extraChat12, lastUserMessageId: 10, Mvu: { isDuringExtraAnalysis: () => true }, source: updateSrc }),
    /启动地区情报重扫/,
  );

  // plot 通用规则兼容原版 <task_info> 单据
  assert.match(plotOut, /正文不打印任务情报板清单/);

  // 仅有 楼层 字段（无 消息数）的旧待重扫也应在 swipe/continue 时被屏蔽
  const floorOnlyRescanStat = {
    世界: { 地点: '卡拉什利亚斯-巡天王庭', 时间: '复兴纪元488年-5月-26日' },
    任务列表: {},
    事件: { 任务情报板: { 区域键: '铁炉堡', 区域: '铁炉堡', 待重扫: { 楼层: '9' }, 列表: [] } },
  };
  assert.doesNotMatch(
    renderEjs(floorOnlyRescanStat, { chat: mainTurnChat11, lastUserMessageId: 10, generateType: 'swipe', source: updateSrc }),
    /启动地区情报重扫/,
  );

  // 下一轮玩家再发消息（消息数=13，末尾 is_user: true）时 rescan 正常过期，不重复触发
  const extraChat13 = [...extraChat12, { is_user: true, is_system: false, mes: '下一轮' }];
  const updateNextOut = renderEjs(extraRescanStat, { chat: extraChat13, lastUserMessageId: 12, source: updateSrc });
  assert.doesNotMatch(updateNextOut, /启动地区情报重扫/);

  // 语体红线回归：plot / update / all 输出均不得出现已清理的冗余防备或文言残余
  const allOut = renderEjs(extraRescanStat, { chat: mainTurnChat11, lastUserMessageId: 10 });
  assert.doesNotMatch(
    `${plotOut}\n${updateOut}\n${allOut}`,
    /属于必执行的|另行额外|严禁|务必|切勿|大部中坚|不泄真相|不另行重复|无可用线索时|一并移出/,
  );

  // effectiveChatCount & EJS system 隐藏消息排除 + rescan 保留同区 地点/引导/更新日 及 预期收益 去前缀说明
  const chatWithHiddenSys = [
    ...mainTurnChat11,
    { is_user: false, is_system: true, mes: '系统摘要提示' },
  ];
  assert.equal(effectiveChatCount(chatWithHiddenSys), 11);
  const rescanAfterSysOut = renderEjs(extraRescanStat, {
    chat: chatWithHiddenSys,
    generateType: 'normal',
    source: updateSrc,
  });
  assert.match(rescanAfterSysOut, /启动地区情报重扫/, '结尾 is_system 隐藏楼层不得破坏消息计数窗口');
  const rescanAiRecoveredChat = Array.from({ length: 11 }, (_, idx) => ({
    is_user: idx !== 10 && idx % 2 === 0,
    is_system: false,
    mes: '对话',
  }));
  const allowRetryRescan = requestQuestRescan(
    {
      命运点数: 200,
      事件: { 任务情报板: { 区域键: '铁炉堡', 区域: '铁炉堡', 待重扫: { 楼层: '9', 消息数: '10' }, 列表: [] } },
    },
    10,
    11,
    { chat: rescanAiRecoveredChat },
  );
  assert.ok(!allowRetryRescan.error, '上一轮 nc+1 AI 落楼结束后，应允许再次预约重扫');
  const rescanPreserveFieldStat = {
    世界: { 地点: '铁炉堡-东区', 时间: '复兴纪元488年-5月-26日' },
    任务列表: { '铁炉旧案': { 状态: '进行中', 进展: '[5月-25日] 已接触线人' } },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        待重扫: { 楼层: '9', 消息数: '10' },
        已兑现: { q_keep: [1] },
        列表: [
          {
            id: 'q_keep',
            类别: '本地主线',
            等级: 'C',
            标题: '铁炉旧案',
            方式: '调查',
            引导: '下城区酒馆接头人',
            地点: '铁炉堡',
            摘要: '旧案档案出现缺页',
            更新日: '复兴纪元488年-5月-20日',
            预期收益: ['稀有护腕 ×1', '金币 ×200'],
          },
        ],
      },
    },
  };
  const rescanPreserveOut = renderEjs(rescanPreserveFieldStat, {
    chat: mainTurnChat11,
    lastUserMessageId: 10,
    source: updateSrc,
  });
  assert.match(rescanPreserveOut, /铁炉堡，更新日 复兴纪元488年-5月-20日/, '整表 replace 时应保留同区域 地点 与非剧情保留项 更新日');
  assert.match(rescanPreserveOut, /引导：下城区酒馆接头人/, '整表 replace 时应保留已接取任务的原始 引导');
  assert.match(rescanPreserveOut, /写回 `预期收益` 时去掉 `\[n□\]`\/`\[n✓\]`\/`\[n✕\]` 前缀/);

  // host 边界回归：空聊天（getLastMessageId=-1）不调用 0--1；readActiveWorldbookInfo 读取人设世界书且排除命定原版规则条目
  const prevGetChat = globalThis.getChatMessages;
  const prevGetLast = globalThis.getLastMessageId;
  const prevGetCharBooks = globalThis.getCharWorldbookNames;
  const prevGetGlobalBooks = globalThis.getGlobalWorldbookNames;
  const prevGetPersona = globalThis.getPersona;
  const prevGetWorldbook = globalThis.getWorldbook;
  try {
    globalThis.getLastMessageId = () => -1;
    globalThis.getChatMessages = () => {
      throw new Error('空聊天不得请求 getChatMessages');
    };
    assert.deepEqual(readMessages(10), []);

    globalThis.getCharWorldbookNames = () => ({ primary: '命定之诗v4.3.4', additional: [] });
    globalThis.getGlobalWorldbookNames = () => [];
    globalThis.getPersona = () => ({ lorebook: '人设绑定任务书' });
    globalThis.getWorldbook = async (name) => {
      if (name === '命定之诗v4.3.4') {
        return [{ name: '[本体][变量][mvu_update]变量更新规则', enabled: true, content: 'variables_update_rules: ...' }];
      }
      if (name === '人设绑定任务书') {
        return [
          { name: '[mvu_plot]任务助手-剧情引导v1.4.8', enabled: true, content: '// @role plot\n<任务情报板>...</任务情报板>' },
          { name: '[mvu_plot]任务助手-变量更新v1.4.8', enabled: true, content: '// @role update\n<任务情报板变量更新协议>' },
        ];
      }
      return [];
    };
    const personaWbInfo = await readActiveWorldbookInfo();
    assert.equal(personaWbInfo.found, true);
    assert.equal(personaWbInfo.dualMode, true);
    assert.equal(personaWbInfo.legacyMvuUpdate, undefined);
    assert.equal(personaWbInfo.version, 'v1.4.8');
    assert.equal(personaWbInfo.duplicateConflict, undefined);
    assert.equal(personaWbInfo.bookName, '人设绑定任务书');
  } finally {
    if (prevGetChat === undefined) delete globalThis.getChatMessages;
    else globalThis.getChatMessages = prevGetChat;
    if (prevGetLast === undefined) delete globalThis.getLastMessageId;
    else globalThis.getLastMessageId = prevGetLast;
    if (prevGetCharBooks === undefined) delete globalThis.getCharWorldbookNames;
    else globalThis.getCharWorldbookNames = prevGetCharBooks;
    if (prevGetGlobalBooks === undefined) delete globalThis.getGlobalWorldbookNames;
    else globalThis.getGlobalWorldbookNames = prevGetGlobalBooks;
    if (prevGetPersona === undefined) delete globalThis.getPersona;
    else globalThis.getPersona = prevGetPersona;
    if (prevGetWorldbook === undefined) delete globalThis.getWorldbook;
    else globalThis.getWorldbook = prevGetWorldbook;
  }

  const mem = new Map();
  const read = (k) => mem.get(k) || '';
  const write = (k, v) => mem.set(k, v);
  assert.equal(readScriptRef(read), '');
  assert.equal(writeScriptRef(write, '@v1.4.2'), 'v1.4.2');
  assert.equal(mem.get(SCRIPT_REF_KEY), 'v1.4.2');
  assert.equal(readScriptRef(read), 'v1.4.2');
  assert.equal(writeScriptRef(write, ''), '');
  assert.equal(readScriptRef(read), '');

  // 优先实时查询 GitHub Tags API 并按语义化版本号取最高 Tag
  const latestFromGh = await fetchLatestScriptTag(async (url) => {
    if (url.includes('api.github.com')) {
      return {
        ok: true,
        json: async () => ([{ name: 'v1.4.0' }, { name: 'v1.10.0' }, { name: 'v1.4.2' }]),
      };
    }
    return { ok: false };
  });
  assert.equal(latestFromGh, 'v1.10.0');

  // GitHub API 失败或返回空时自动回退 jsDelivr 版本接口
  const latestFromJsd = await fetchLatestScriptTag(async (url) => {
    if (url.includes('api.github.com')) return { ok: false, status: 403 };
    return {
      ok: true,
      json: async () => ({ versions: [{ version: 'v1.4.0' }, { version: 'v1.4.2' }] }),
    };
  });
  assert.equal(latestFromJsd, 'v1.4.2');

  const refs = await fetchAvailableScriptRefs(async (url) => {
    if (url.includes('api.github.com')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({ versions: [{ version: 'v1.4.0' }, { version: 'v1.4.2' }] }) };
  });
  assert.deepEqual(refs, ['main', 'v1.4.2', 'v1.4.0']);

  const offlineLatest = await fetchLatestScriptTag(async () => {
    throw new Error('offline');
  });
  assert.equal(offlineLatest, '');

  const fallbackRefs = await fetchAvailableScriptRefs(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(fallbackRefs, ['main', 'v1.4.0']);
});

test('内置 fetchScriptByRef：四节点回退、内容校验与记住可用节点', async () => {
  const mem = new Map([[CDN_ORIGIN_KEY, 'https://gcore.jsdelivr.net']]);
  const urls = [];
  const res = await fetchScriptByRef('@v1.4.0', {
    readStorage: (k) => mem.get(k) || '',
    writeStorage: (k, v) => mem.set(k, v),
    fetchFn: async (url) => {
      urls.push(url);
      if (url.startsWith('https://gcore.jsdelivr.net')) {
        return { ok: false, status: 502, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => 'window.QuestHelperApp = {};',
      };
    },
  });
  assert.equal(res.ref, 'v1.4.0');
  assert.equal(res.origin, 'https://testingcf.jsdelivr.net');
  assert.equal(mem.get(CDN_ORIGIN_KEY), 'https://testingcf.jsdelivr.net');
  assert.deepEqual(urls, [
    'https://gcore.jsdelivr.net/gh/yue-234/quest-assistant@v1.4.0/dist/quest-assistant.js',
    'https://testingcf.jsdelivr.net/gh/yue-234/quest-assistant@v1.4.0/dist/quest-assistant.js',
  ]);
});

test('jsDelivr 远程自动更新脚本：默认 main 追新、多节点回退、热切固定老版本与失效回退', async () => {
  assert.equal(fs.existsSync(remoteLoaderPath), true, '应存在远程自动更新脚本');
  const loaderCode = fs.readFileSync(remoteLoaderPath, 'utf8');
  assert.doesNotThrow(() => new Function(loaderCode), '远程加载器必须语法合法');
  assert.match(loaderCode, /DEFAULT_REF = 'main'/);
  assert.match(loaderCode, /testingcf\.jsdelivr\.net/);
  assert.match(loaderCode, /cdn\.jsdelivr\.net/);
  assert.match(loaderCode, /fastly\.jsdelivr\.net/);
  assert.match(loaderCode, /gcore\.jsdelivr\.net/);
  assert.match(loaderCode, /dist\/quest-assistant\.js/);

  // 场景 1：默认拉取 main，前两节点异常/返回伪装页面，自动回退第三节点并支持 switchRef 固定老版本
  const storage = new Map();
  const requestedUrls = [];
  const errors = [];
  let stopCalls = 0;
  let openCalls = 0;
  let loadedTags = [];
  const ctx1 = {
    console: { error: () => {} },
    setTimeout,
    clearTimeout,
    AbortController,
    window: {
      localStorage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
      },
    },
    toastr: { error: (m) => errors.push(m) },
    fetch: async (url) => {
      requestedUrls.push(url);
      if (url.includes('@main/') && url.startsWith('https://testingcf.jsdelivr.net')) {
        return { ok: false, status: 503, text: async () => '' };
      }
      if (url.includes('@main/') && url.startsWith('https://cdn.jsdelivr.net')) {
        return { ok: true, status: 200, text: async () => '<html>blocked</html>' };
      }
      if (url.includes('@missing-tag/')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      const tagMatch = url.match(/@([^/]+)\//);
      const tag = tagMatch ? tagMatch[1] : '';
      return {
        ok: true,
        status: 200,
        text: async () =>
          `window.QuestHelperApp = { stop: () => __onStop(), open: () => __onOpen() }; __onLoad(${JSON.stringify(tag)});`,
      };
    },
    __onStop: () => { stopCalls += 1; },
    __onOpen: () => { openCalls += 1; },
    __onLoad: (tag) => { loadedTags.push(tag); },
  };
  ctx1.globalThis = ctx1;
  ctx1.window.parent = ctx1.window;
  vm.runInNewContext(loaderCode, ctx1);
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(loadedTags, ['main']);
  assert.equal(errors.length, 0);
  assert.deepEqual(requestedUrls, [
    'https://testingcf.jsdelivr.net/gh/yue-234/quest-assistant@main/dist/quest-assistant.js',
    'https://cdn.jsdelivr.net/gh/yue-234/quest-assistant@main/dist/quest-assistant.js',
    'https://fastly.jsdelivr.net/gh/yue-234/quest-assistant@main/dist/quest-assistant.js',
  ]);
  assert.equal(storage.get('quest_helper_cdn_origin_v1'), 'https://fastly.jsdelivr.net');
  assert.equal(ctx1.window.__QuestHelperRemoteLoader.loadedRef, 'main');

  // 热切换并固定至老版本 v1.4.0（应先拉取校验，停止旧实例并重新执行和打开）
  const switched = await ctx1.window.__QuestHelperRemoteLoader.switchRef('v1.4.0', { reopen: true });
  assert.equal(switched.ref, 'v1.4.0');
  assert.equal(stopCalls, 1);
  assert.equal(openCalls, 1);
  assert.deepEqual(loadedTags, ['main', 'v1.4.0']);
  assert.equal(storage.get(SCRIPT_REF_KEY), 'v1.4.0');

  // 切换到一个不存在的 tag 应抛错且保留原有固定版本 v1.4.0
  await assert.rejects(() => ctx1.window.__QuestHelperRemoteLoader.switchRef('missing-tag'));
  assert.equal(storage.get(SCRIPT_REF_KEY), 'v1.4.0');
  assert.equal(ctx1.window.__QuestHelperRemoteLoader.loadedRef, 'v1.4.0');

  // 切换到 eval 顶层抛错的脚本版本时，应回滚配置、重新加载并恢复弹窗、提示错误
  const origFetch = ctx1.fetch;
  ctx1.fetch = async (url) => {
    if (url.includes('@broken-eval/')) {
      return {
        ok: true,
        status: 200,
        text: async () => '/* QuestHelperApp */ throw new Error("boom in new build");',
      };
    }
    return origFetch(url);
  };
  await assert.rejects(
    () => ctx1.window.__QuestHelperRemoteLoader.switchRef('broken-eval', { reopen: true }),
    /boom in new build/,
  );
  assert.equal(storage.get(SCRIPT_REF_KEY), 'v1.4.0');
  assert.equal(ctx1.window.__QuestHelperRemoteLoader.loadedRef, 'v1.4.0');
  assert.deepEqual(loadedTags, ['main', 'v1.4.0', 'v1.4.0']);
  assert.equal(openCalls, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /回退 v1\.4\.0/);

  // 切回 DEFAULT_REF（main）时应清空 SCRIPT_REF_KEY 为空串（默认同步最新）
  const backMain = await ctx1.window.__QuestHelperRemoteLoader.switchRef('main');
  assert.equal(backMain.ref, 'main');
  assert.equal(storage.get(SCRIPT_REF_KEY), '');

  // 场景 2：启动时保存的自定义版本失效（全节点 404），应自动清除并回退默认 main
  const fallbackStorage = new Map([[SCRIPT_REF_KEY, 'bad-tag']]);
  const fallbackErrors = [];
  const fallbackLoaded = [];
  const ctx2 = {
    console: { error: () => {} },
    setTimeout,
    clearTimeout,
    AbortController,
    window: {
      localStorage: {
        getItem: (k) => fallbackStorage.get(k) ?? null,
        setItem: (k, v) => fallbackStorage.set(k, String(v)),
      },
    },
    toastr: { error: (m) => fallbackErrors.push(m) },
    fetch: async (url) => {
      if (url.includes('@bad-tag/')) return { ok: false, status: 404, text: async () => '' };
      return {
        ok: true,
        status: 200,
        text: async () => 'window.QuestHelperApp = {}; __record("main");',
      };
    },
    __record: (v) => fallbackLoaded.push(v),
  };
  ctx2.globalThis = ctx2;
  ctx2.window.parent = ctx2.window;
  vm.runInNewContext(loaderCode, ctx2);
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(fallbackLoaded, ['main']);
  assert.equal(fallbackStorage.get(SCRIPT_REF_KEY), '');
  assert.equal(fallbackErrors.length, 1);
  assert.match(fallbackErrors[0], /main/);

  // 场景 3：所有节点彻底不可达时触发 toastr.error 提醒改用离线版
  const failErrors = [];
  const ctx3 = {
    console: { error: () => {} },
    setTimeout,
    clearTimeout,
    AbortController,
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    toastr: { error: (m) => failErrors.push(m) },
    fetch: async () => {
      throw new Error('network down');
    },
  };
  ctx3.globalThis = ctx3;
  ctx3.window.parent = ctx3.window;
  vm.runInNewContext(loaderCode, ctx3);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(failErrors.length, 1);
  assert.match(failErrors[0], /jsDelivr/);
  assert.match(failErrors[0], /⭐粘这个-任务助手脚本\.js/);
});

test('轻量关注方向：归一化、重扫联动提交、仅本次宽限期保护与过期自动清理', () => {
  // 1) normalizeQuestFocus：字符串/对象兼容、换行压缩与 40 字截断
  assert.deepEqual(normalizeQuestFocus('  经营\n魔药铺  '), { text: '经营 魔药铺', mode: 'long', messageCount: '' });
  const longText = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出';
  assert.equal(normalizeQuestFocus({ 文本: longText, 模式: 'once', 消息数: '8' }).text.length, 40);
  assert.equal(normalizeQuestFocus({ 文本: '  \n ', 模式: 'once' }).text, '');

  // 2) setQuestFocus 写入与清空、requestQuestRescan 协同保存/刷新消息数
  let stat = {
    命运点数: 300,
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    事件: { 任务情报板: { 区域键: '雾晶港', 区域: '雾晶港', 列表: [] } },
  };
  stat = setQuestFocus(stat, '典狱长追捕与押运', { mode: 'long' }).stat;
  assert.deepEqual(stat['事件']['任务情报板']['关注方向'], { 文本: '典狱长追捕与押运', 模式: 'long' });
  assert.deepEqual(questBoardState(stat).focus, { text: '典狱长追捕与押运', mode: 'long', active: true });

  // 不传 focusText 时，requestQuestRescan 不得误删原有长期关注方向
  stat = requestQuestRescan(stat, 9, 10).stat;
  assert.equal(stat['事件']['任务情报板']['关注方向']['文本'], '典狱长追捕与押运');
  stat = clearQuestRescan(stat).stat;

  // 传入 focusText & focusMode: 'once' 时，在单次重扫内原子切换
  stat = requestQuestRescan(stat, 9, 10, {
    focusText: '魔药铺供货',
    focusMode: 'once',
  }).stat;
  assert.deepEqual(stat['事件']['任务情报板']['关注方向'], { 文本: '魔药铺供货', 模式: 'once', 消息数: '10' });

  // 在 nc+1 用户尾等待回复时，仅本次方向不得提前清空；AI 回复落地成 nc+1 AI 尾后立即清理
  const waitUserChat11 = Array.from({ length: 11 }, (_, idx) => ({
    is_user: idx % 2 === 0,
    is_system: false,
    mes: 'x',
  }));
  const aiTailChat11 = Array.from({ length: 11 }, (_, idx) => ({
    is_user: idx !== 10 && idx % 2 === 0,
    is_system: false,
    mes: 'x',
  }));
  assert.equal(
    isOnceFocusExpired(stat['事件']['任务情报板'], {
      chat: waitUserChat11,
      chatCount: 11,
    }),
    false,
  );
  assert.equal(
    isOnceFocusExpired(stat['事件']['任务情报板'], {
      chat: aiTailChat11,
      chatCount: 11,
    }),
    true,
  );
  // 主模型回复落地成 AI 尾后，maintainQuestBoard 同步清掉 待重扫 与 once 关注方向
  const maint = maintainQuestBoard(stat, {
    floor: 10,
    chatCount: 11,
    chat: aiTailChat11,
  });
  assert.ok(!maint.skip);
  assert.equal(maint.stat['事件']['任务情报板']['待重扫'], undefined);
  assert.equal(maint.stat['事件']['任务情报板']['关注方向'], undefined);

  // 空文本调用 setQuestFocus 删除关注方向节点
  const cleared = setQuestFocus(setQuestFocus(stat, '测试').stat, '').stat;
  assert.equal(Object.prototype.hasOwnProperty.call(cleared['事件']['任务情报板'], '关注方向'), false);
});

test('隐藏导演状态：完结自动截获引信、假象余震冷却隔离与过期引信清理（零界面暴露）', () => {
  const baseStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: {
      '守门人正名': { 状态: '已完成' },
      '普通城防': { 状态: '已完成' },
      '港口急信': { 状态: '已完成' },
      '密库后续': { 状态: '已完成' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          {
            id: 'q_shock',
            类别: '本地主线',
            等级: 'C',
            标题: '守门人正名',
            方式: '调查',
            地点: '雾晶港-西门',
            真相: '【假象余震】【护送破局】镇长与治安官共同裁剪了档案｜余震引信：守门人账本造册早于案发前三日，真正被害另有其人',
            预期收益: ['金币 ×150'],
          },
          {
            id: 'q_seq1',
            类别: '本地主线',
            等级: 'C',
            标题: '普通城防',
            方式: '委托',
            真相: '【护送破局】押运途中遭遇夜袭｜后续引信：没收的暗纹箱被秘密转送往王都某密库',
            预期收益: ['金币 ×120'],
          },
          {
            id: 'q_seq2',
            类别: '支线任务',
            等级: 'D',
            标题: '港口急信',
            方式: '委托',
            真相: '后续引信：不应突破上限 2 的第三条引信',
            预期收益: ['金币 ×50'],
          },
          {
            id: 'q_shock2',
            类别: '本地主线',
            等级: 'C',
            标题: '密库后续',
            方式: '调查',
            真相: '【假象余震】另一条余震｜余震引信：只能保留 1 条假象余震',
            预期收益: ['金币 ×100'],
          },
        ],
      },
    },
  };

  // questBoardState 不暴露 导演状态 与 真相/骨架/引信
  const beforeState = questBoardState(baseStat);
  assert.equal(beforeState.director, undefined);
  assert.equal(beforeState.items[0]?.truth, undefined);

  // sweepClosedQuests 截获引信：上限最多 2 条、假象余震至多 1 条，并采用两段式顺序无关计算（同轮新种 假象余震 置冷却 3，不被同轮 q_seq1 误扣）
  const swept = sweepClosedQuests(baseStat, { chatCount: 10 }).stat;
  const director = swept['事件']['任务情报板']['导演状态'];
  assert.ok(director);
  assert.equal(director['余震冷却'], 3);
  assert.equal(director['待引爆'].length, 2);
  assert.equal(director['待引爆'][0]['标题'], '守门人正名');
  assert.equal(director['待引爆'][0]['类型'], '假象余震');
  assert.equal(director['待引爆'][0]['区域'], '雾晶港');
  assert.equal(director['待引爆'][0]['触发后消息数'], '13');
  assert.equal(director['待引爆'][0]['过期消息数'], '23');
  assert.equal(director['待引爆'][0]['触发日'], '复兴纪元488年-6月-11日');
  assert.equal(director['待引爆'][1]['标题'], '普通城防');
  assert.equal(director['待引爆'][1]['类型'], '因果后续');

  // 消息数未超过期窗口（23 <= 23）时不清理；超窗（24 > 23）时清理待引爆并保留余震冷却
  assert.equal(hasExpiredDirectorLeads(swept, { chatCount: 13 }), false);
  assert.equal(hasExpiredDirectorLeads(swept, { chatCount: 23 }), false);
  assert.equal(hasExpiredDirectorLeads(swept, { chatCount: 24 }), true);
  const expSwept = sweepExpiredDirectorLeads(swept, { chatCount: 24 }).stat;
  assert.equal(expSwept['事件']['任务情报板']['导演状态']['待引爆'], undefined);
  assert.equal(expSwept['事件']['任务情报板']['导演状态']['余震冷却'], 3);

  // 2 条普通主线结案递减冷却（3 -> 1），再结案 1 条降至 0 且队列为空时自动销毁整个 导演状态 节点
  const objCleanStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '主线乙': { 状态: '已完成' }, '主线丙': { 状态: '已完成' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: expSwept['事件']['任务情报板']['导演状态'],
        列表: {
          a: { 类别: '本地主线', 等级: 'C', 标题: '主线乙', 真相: '【灾变探索】普通主线一' },
          b: { 类别: '剧情任务', 等级: 'B', 标题: '主线丙', 真相: '【多方竞速】普通剧情二' },
          c: { 类别: '本地主线', 等级: 'C', 标题: '主线丁', 真相: '【护送破局】普通主线三' },
        },
      },
    },
  };
  const stepOneCd = sweepClosedQuests(objCleanStat, { chatCount: 25 }).stat;
  assert.equal(stepOneCd['事件']['任务情报板']['导演状态']['余震冷却'], 1);
  stepOneCd['任务列表'] = { '主线丁': { 状态: '已完成' } };
  const zeroCd = sweepClosedQuests(stepOneCd, { chatCount: 26 }).stat;
  assert.equal(zeroCd['事件']['任务情报板']['导演状态'], undefined);
});

test('EJS 关注方向、多骨架避重轮盘、假象余震 plot 物理盲演与延迟引爆', () => {
  const dual = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  const plotSrc = dual.entries['0'].content;
  const updateSrc = dual.entries['1'].content;

  // 1) gatingIdle（日常 0 接取）下即使挂着 关注方向 也必须 0 字节注入（不污染日常上下文）
  const idleBaseStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '迷雾港湾', 方式: '调查', 预期收益: ['史诗杖 ×1'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '港务核账', 方式: '委托', 预期收益: ['金币 ×150'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '修补缆绳', 方式: '委托', 预期收益: ['金币 ×40'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '清点海货', 方式: '委托', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  const idleFocusStat = JSON.parse(JSON.stringify(idleBaseStat));
  idleFocusStat['事件']['任务情报板']['关注方向'] = { 文本: '经营魔药铺', 模式: 'long' };
  const chat2 = [{ is_user: true, mes: '四处逛逛' }, { is_user: false, mes: '海风阵阵' }];
  assert.equal(
    renderEjs(idleFocusStat, { chat: chat2, lastUserMessageId: 1, source: plotSrc }),
    renderEjs(idleBaseStat, { chat: chat2, lastUserMessageId: 1, source: plotSrc }),
  );
  assert.equal(
    renderEjs(idleFocusStat, { chat: chat2, lastUserMessageId: 1, source: updateSrc }),
    renderEjs(idleBaseStat, { chat: chat2, lastUserMessageId: 1, source: updateSrc }),
  );

  // 2) 生成期：存在 关注方向 时输出定量软倾斜规则 + 避重轮盘推荐未使用骨架 + 控制键保留 关注方向/导演状态
  const genStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: { '已接旧案': { 状态: '进行中', 进展: '[6月-10日] 刚刚接取' } },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        关注方向: { 文本: '经营魔药铺', 模式: 'long' },
        待重扫: { 楼层: '1', 消息数: '2' },
        列表: [
          {
            id: 'q_keep',
            类别: '剧情任务',
            等级: 'A',
            标题: '已接旧案',
            方式: '调查',
            真相: '【悬疑反转】王庭线另有隐情',
            预期收益: ['传说武器 ×1'],
          },
        ],
      },
    },
  };
  const genOut = renderEjs(genStat, { chat: chat2, lastUserMessageId: 1, source: updateSrc });
  assertCleanOutput(genOut, 'gen-focus-skeleton');
  assert.equal((genOut.match(/\*\*[^*]+\*\*/g) || []).length, 1);
  assert.match(genOut, /关注方向（经营魔药铺）:/);
  assert.match(genOut, /支线任务安排 1~2 条贴合该方向，至少保留 1 条常规本地委托/);
  assert.match(genOut, /当前保留任务已占骨架：【悬疑反转】，新生成尽量错开/);
  assert.match(genOut, /保留「意向」「忽略」「已兑现」「已失效」「曾接取」「上次重扫日」「余波」「区域访问日」「关注方向」「导演状态」/);

  // 3) 一阶段 plot 物理盲演：活跃任务带 【假象余震】+ 余震引信 时，plot 不露标签/引信且走正面推进节奏；update/all 附带若本轮结案留种
  const aftershockStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '守门人风波': { 状态: '进行中', 进展: '[6月-11日] 正在查验文书' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          {
            id: 'q_as',
            类别: '本地主线',
            等级: 'C',
            标题: '【假象余震】守门人风波',
            方式: '调查',
            摘要: '治安官委托调查西门失职守门人。',
            真相: '【假象余震】所有证词与档案表面自洽｜余震引信：守门人账本早于案发前三日',
            预期收益: ['稀有披风 ×1', '金币 ×200'],
          },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '清理货栈', 方式: '委托', 预期收益: ['金币 ×50'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '运送炭石', 方式: '委托', 预期收益: ['金币 ×60'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '修补渔网', 方式: '委托', 预期收益: ['金币 ×40'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '清点海盐', 方式: '委托', 预期收益: ['金币 ×45'] },
        ],
      },
    },
  };
  const blindPlotOut = renderEjs(aftershockStat, { chat: chat2, lastUserMessageId: 1, source: plotSrc });
  assert.doesNotMatch(blindPlotOut, /undefined|NaN|variables_update_rules|兑现Patch|失效Patch/);
  assert.equal((blindPlotOut.match(/\*\*[^*]+\*\*/g) || []).length, 0);
  assert.doesNotMatch(blindPlotOut, /假象余震|余震引信|守门人账本早于案发前三日|只露疑点/);
  assert.match(blindPlotOut, /守门人风波/);
  assert.match(blindPlotOut, /正面推进/);

  const blindUpdateOut = renderEjs(aftershockStat, { chat: chat2, lastUserMessageId: 1, source: updateSrc });
  assertCleanOutput(blindUpdateOut, 'aftershock-update');
  assert.equal((blindUpdateOut.match(/\*\*[^*]+\*\*/g) || []).length, 1);
  assert.doesNotMatch(blindUpdateOut, /【假象余震】守门人风波|幕后真相：[^｜\n]*(?:假象余震|余震引信)/);
  assert.match(blindUpdateOut, /若本轮结案留种：.*"op":"insert","path":"\/事件\/任务情报板\/导演状态".*正文正面推进，不提前点破引信/);

  // 4) 推进期多骨架精准匹配：场上只有 【多方竞速】 与 【护送破局】 时，只输出该两种骨架节拍且无 悬疑反转 阴谋要求
  const multiSkelStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {
      '商路争锋': { 状态: '进行中', 进展: '[6月-11日] 两家商会开始竞价' },
      '北境押运': { 状态: '进行中', 进展: '[6月-11日] 车队启程' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '商路争锋', 真相: '【多方竞速】南北航线权争夺', 预期收益: ['史诗罗盘 ×1'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '北境押运', 真相: '【护送破局】暴雪前赶过山口', 预期收益: ['稀有重铠 ×1'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '修灯塔', 预期收益: ['金币 ×50'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '取海图', 预期收益: ['金币 ×50'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '购干粮', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  const multiPlotOut = renderEjs(multiSkelStat, { chat: chat2, lastUserMessageId: 1, source: plotSrc });
  assert.match(multiPlotOut, /【多方竞速】/);
  assert.match(multiPlotOut, /【护送破局】/);
  assert.doesNotMatch(multiPlotOut, /【悬疑反转】|【灾变探索】/);

  // 5) 延迟引爆：到触发消息数后 plot 输出无加粗异常细节，update 输出 因果引爆 与清理 导演状态 Patch（swipe 时屏蔽）
  const dueStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-14日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 0,
          待引爆: [
            {
              标题: '守门人风波',
              类型: '假象余震',
              引信: '守门人私印账簿造册早于案发前三日',
              触发后消息数: '4',
              过期消息数: '14',
            },
          ],
        },
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '其他剧情线', 预期收益: ['史诗饰品 ×1'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '其他主线', 预期收益: ['稀有盾 ×1'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '支线A', 预期收益: ['金币 ×40'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '支线B', 预期收益: ['金币 ×40'] },
        ],
      },
    },
  };
  const chat5 = Array.from({ length: 5 }, (_, idx) => ({ is_user: idx % 2 === 0, is_system: false, mes: '日常走动' }));
  const duePlotOut = renderEjs(dueStat, { chat: chat5, lastUserMessageId: 4, source: plotSrc });
  const dueUpdateOut = renderEjs(dueStat, { chat: chat5, lastUserMessageId: 4, source: updateSrc });
  const dueSwipeOut = renderEjs(dueStat, { chat: chat5, lastUserMessageId: 4, generateType: 'swipe', source: updateSrc });
  assert.equal((duePlotOut.match(/\*\*[^*]+\*\*/g) || []).length, 0);
  assert.match(duePlotOut, /异常细节: 原已结案的「守门人风波」在无关日常细节、战利品或环境变化中露出物理裂痕/);
  assert.match(dueUpdateOut, /因果引爆: 原已结案的「守门人风波」露出物理裂痕.*【假象余震二段】.*remove.*"path": "\/事件\/任务情报板\/导演状态"/);
  assert.doesNotMatch(dueSwipeOut, /因果引爆:/);

  // 语体红线终检
  assert.doesNotMatch(
    `${genOut}\n${blindPlotOut}\n${blindUpdateOut}\n${duePlotOut}\n${dueUpdateOut}`,
    /严禁|务必|切勿|属于必执行的|另行额外|大部中坚|截胡|虐心|耍赖|以便与日常任务区分|多方竞价|危机倒计时/,
  );
});

test('审计回归：前端导演/关注方向契约（displayTitle、顺序无关冷却、二段识别、失败过滤与空once保留）', () => {
  // 1) stripQuestBackendTags 与 questBoardState displayTitle（不泄露骨架/余震标签且保留原始 title 供匹配）
  assert.equal(stripQuestBackendTags('【假象余震】【护送破局】押运旧档'), '押运旧档');
  assert.equal(stripQuestBackendTags('【假象余震二段】暗账源头'), '暗账源头');
  const displayStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: { '【假象余震】守门人风波': { 状态: '进行中' }, '【假象余震二段】未入板追查': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'C', 标题: '【假象余震】守门人风波', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  };
  const uiState = readState(displayStat);
  assert.equal(uiState.questBoard.items.length, 2);
  const boardEntry = uiState.questBoard.items.find((x) => x.id === 'q1');
  const formalOnlyEntry = uiState.questBoard.items.find((x) => x.id.startsWith('formal:'));
  assert.equal(boardEntry.title, '【假象余震】守门人风波');
  assert.equal(boardEntry.displayTitle, '守门人风波');
  assert.equal(formalOnlyEntry.displayTitle, '未入板追查');

  // 2) updateDirectorAfterSweep 顺序无关：先普通后余震 vs 先余震后普通，冷却均应准确停在 3
  const orderA = sweepClosedQuests({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: { '余震甲': { 状态: '已完成' }, '普通乙': { 状态: '已完成' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'qa', 类别: '本地主线', 等级: 'C', 标题: '余震甲', 真相: '【假象余震】一阶段｜余震引信：账册年份错配', 预期收益: ['金币 ×100'] },
          { id: 'qb', 类别: '本地主线', 等级: 'C', 标题: '普通乙', 真相: '【灾变探索】一般清理', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  }, { chatCount: 10 }).stat['事件']['任务情报板']['导演状态'];
  const orderB = sweepClosedQuests({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: { '余震甲': { 状态: '已完成' }, '普通乙': { 状态: '已完成' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'qb', 类别: '本地主线', 等级: 'C', 标题: '普通乙', 真相: '【灾变探索】一般清理', 预期收益: ['金币 ×100'] },
          { id: 'qa', 类别: '本地主线', 等级: 'C', 标题: '余震甲', 真相: '【假象余震】一阶段｜余震引信：账册年份错配', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  }, { chatCount: 10 }).stat['事件']['任务情报板']['导演状态'];
  assert.equal(orderA['余震冷却'], 3);
  assert.equal(orderB['余震冷却'], 3);

  // 3) 【假象余震二段】归入正常主线结案，递减冷却而不触发 Stage-1 保护；彻底失败/取消的一阶段假象余震不写余震引信
  const stage2AndFail = sweepClosedQuests({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {
      '二段追查': { 状态: '已完成' },
      '中途失败的一阶段': { 状态: '已失败' },
      '放弃的一阶段': { 状态: '已取消' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: { 余震冷却: 2 },
        列表: [
          { id: 'q2nd', 类别: '本地主线', 等级: 'B', 标题: '二段追查', 真相: '【假象余震二段】彻查幕后账房', 预期收益: ['史诗印章 ×1'] },
          { id: 'qfail', 类别: '本地主线', 等级: 'C', 标题: '中途失败的一阶段', 真相: '【假象余震】｜余震引信：失败不应写引信', 预期收益: ['金币 ×100'] },
          { id: 'qcancel', 类别: '本地主线', 等级: 'C', 标题: '放弃的一阶段', 真相: '【假象余震】｜余震引信：取消不应写引信', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  }, { chatCount: 15 }).stat['事件']['任务情报板']['导演状态'];
  assert.equal(stage2AndFail['余震冷却'], 1);
  assert.equal(stage2AndFail['待引爆'], undefined);

  // 4) 空 消息数 的 once 关注方向在不伴随 待重扫 时不自杀；已过期 once 在 maintainQuestBoard 清空后不复活
  const emptyOnceStat = setQuestFocus({
    命运点数: 300,
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    事件: { 任务情报板: { 区域键: '雾晶港', 区域: '雾晶港', 列表: [] } },
  }, '炼金采集', { mode: 'once' }).stat;
  assert.equal(isOnceFocusExpired(emptyOnceStat['事件']['任务情报板'], { chatCount: 10 }), false);
  assert.deepEqual(maintainQuestBoard(emptyOnceStat, { floor: 9, chatCount: 10 }), { skip: true });
  const notExpOnce = clearExpiredOnceFocus(emptyOnceStat, { chatCount: 10 });
  assert.equal(notExpOnce.done, '关注方向尚未过期');
  assert.equal(notExpOnce.stat['事件']['任务情报板']['关注方向']['文本'], '炼金采集');

  const expiredOnceWithRescan = requestQuestRescan(emptyOnceStat, 2, 3, {
    focusText: '限时工坊',
    focusMode: 'once',
  }).stat;
  assert.ok(expiredOnceWithRescan);
  const wipedOnce = maintainQuestBoard(expiredOnceWithRescan, {
    floor: 6,
    chatCount: 8,
    chat: Array.from({ length: 8 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })),
  }).stat;
  assert.equal(wipedOnce['事件']['任务情报板']['待重扫'], undefined);
  assert.equal(wipedOnce['事件']['任务情报板']['关注方向'], undefined);
});

test('审计回归：EJS 全审计修复（update零泄漏、all盲演与推进并存、二段、多引信合并与跨区引爆）', () => {
  const dual = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  const plotSrc = dual.entries['0'].content;
  const updateSrc = dual.entries['1'].content;
  const chat2 = [{ is_user: true, mes: '日常走动' }, { is_user: false, mes: '街道安静' }];

  // 1) update gatingIdle（0 接取/0 锁定）+ 存在未到期 导演状态 时，必须 0 字节泄漏
  const idleNoDir = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '迷雾港湾', 预期收益: ['史诗杖 ×1'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '港务核账', 预期收益: ['金币 ×150'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '修补缆绳', 预期收益: ['金币 ×40'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '清点海货', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  const idleWithDir = JSON.parse(JSON.stringify(idleNoDir));
  idleWithDir['事件']['任务情报板']['导演状态'] = {
    余震冷却: 3,
    待引爆: [{ 标题: '旧案', 类型: '假象余震', 引信: '封条印章错位', 触发后消息数: '9', 过期消息数: '19' }],
  };
  assert.equal(
    renderEjs(idleWithDir, { chat: chat2, lastUserMessageId: 1, source: updateSrc }),
    renderEjs(idleNoDir, { chat: chat2, lastUserMessageId: 1, source: updateSrc }),
  );

  // 2) all 模式一阶段盲演遮蔽标签/引信 + 多骨架 护送破局/灾变探索 不强制阴谋暗线 + 生成期仍保留 推进与兑现
  const allBlindStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '守门人风波': { 状态: '进行中', 进展: '[6月-12日] 正在勘查' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: { 余震冷却: 2 },
        列表: [
          {
            id: 'q_as',
            类别: '本地主线',
            等级: 'C',
            标题: '【假象余震】守门人风波',
            方式: '调查',
            地点: '雾晶港-西门',
            摘要: '治安官委托排查西门门禁失职。',
            真相: '【假象余震】所有证词与档案表面自洽｜余震引信：守门人账本早于案发前三日',
            预期收益: ['稀有披风 ×1', '金币 ×200'],
          },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '搬木箱', 预期收益: ['金币 ×40'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '买海盐', 预期收益: ['金币 ×40'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '送急信', 预期收益: ['金币 ×40'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '刷船壳', 预期收益: ['金币 ×40'] },
        ],
      },
    },
  };
  const allBlindOut = renderEjs(allBlindStat, { chat: chat2, lastUserMessageId: 1 });
  assert.doesNotMatch(allBlindOut, /direct|直接介入暗线|含 1 次偏差或取舍/);
  assert.doesNotMatch(allBlindOut, /幕后真相：[^｜\n]*(?:假象余震|余震引信)/);
  assert.match(allBlindOut, /已接取:守门人风波/);
  assert.doesNotMatch(allBlindOut, /【假象余震】守门人风波/);
  assert.match(allBlindOut, /幕后真相：所有证词与档案表面自洽/);
  assert.match(allBlindOut, /（仅正常完结写入，彻底失败或放弃时不写；正文正面推进，不提前点破引信）/);
  assert.match(allBlindOut, /"标题":"守门人风波".*"触发后消息数":5.*"过期消息数":15.*"区域":"雾晶港-西门"/);

  // 单轮 all 模式在 重扫/迁入 同时保留活跃主线时，仍必须输出 波折节拍 与 折损与失效
  const allRescanActive = renderEjs({
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '王庭密档': { 状态: '进行中', 进展: '[6月-10日] 刚刚接入' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          {
            id: 'q1',
            类别: '剧情任务',
            等级: 'A',
            标题: '王庭密档',
            真相: '【护送破局】全程护送密使过境',
            预期收益: ['传说武器 ×1'],
          },
        ],
      },
    },
  }, { chat: chat2, lastUserMessageId: 1 });
  assert.match(allRescanActive, /生成规格/);
  assert.match(allRescanActive, /波折节拍:/);
  assert.match(allRescanActive, /折损与失效:/);
  assert.doesNotMatch(allRescanActive, /直接介入暗线|含 1 次偏差或取舍/);

  // 3) 多条带引信任务同轮 + 非余震降冷却 + 跨区 因果引爆 + relocate 推迟 + 同轮留种防 remove 冲突
  const multiLeadUpdateOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-14日' },
    任务列表: {
      '余震案A': { 状态: '进行中' },
      '后续案B': { 状态: '进行中' },
      '普通主线C': { 状态: '进行中' },
    },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 2,
          待引爆: [
            { 标题: '【假象余震】旧港旧案', 区域: '旧港城', 类型: '假象余震', 引信: '来信印泥发黑', 触发后消息数: '4', 过期消息数: '14' },
          ],
        },
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'C', 标题: '【假象余震】余震案A', 真相: '【假象余震】一阶段｜余震引信：账本错页', 预期收益: ['金币 ×100'] },
          { id: 'q2', 类别: '本地主线', 等级: 'C', 标题: '后续案B', 真相: '【护送破局】正统护送｜后续引信：密函流向王都', 预期收益: ['金币 ×100'] },
          { id: 'q3', 类别: '本地主线', 等级: 'C', 标题: '普通主线C', 真相: '【灾变探索】治理潮闸', 预期收益: ['金币 ×100'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '支线四', 预期收益: ['金币 ×50'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '支线五', 预期收益: ['金币 ×50'] },
          { id: 'q6', 类别: '支线任务', 等级: 'D', 标题: '支线六', 预期收益: ['金币 ×50'] },
          { id: 'q7', 类别: '支线任务', 等级: 'D', 标题: '支线七', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  }, { chat: Array.from({ length: 5 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 4, source: updateSrc });
  assert.match(multiLeadUpdateOut, /多条带引信任务同轮结案留种时合并写入同一个 `待引爆` 数组/);
  assert.match(multiLeadUpdateOut, /只要同轮包含一阶段 `假象余震` 留种，`余震冷却` 统一置 `3`/);
  assert.match(multiLeadUpdateOut, /非余震主线正常结案同步降冷却：.*"value":1/);
  assert.match(multiLeadUpdateOut, /本轮另有待引爆因果线，按下方「因果引爆」追加追查任务并清理引信/);
  assert.doesNotMatch(multiLeadUpdateOut, /没有变动时跳过写板/);
  assert.match(multiLeadUpdateOut, /因果引爆: 原在「旧港城」结案的「旧港旧案」通过旧物、来信或跨区传闻露出物理裂痕（来信印泥发黑）/);
  assert.match(multiLeadUpdateOut, /类别视格局定为 `本地主线`（5 栏）或 `剧情任务`（跨区用，10 栏）/);
  assert.match(multiLeadUpdateOut, /"path": "\/事件\/任务情报板\/导演状态\/待引爆\/0"/);

  // 同轮 relocate 不得引爆旧引信
  const relocateLeadOut = renderEjs({
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-6月-14日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 0,
          待引爆: [{ 标题: '旧港旧案', 区域: '旧港城', 类型: '假象余震', 引信: '印泥异常', 触发后消息数: '4', 过期消息数: '14' }],
        },
        列表: [{ id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '主线', 预期收益: ['史诗盾 ×1'] }],
      },
    },
  }, { chat: Array.from({ length: 5 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 4, source: updateSrc });
  assert.doesNotMatch(relocateLeadOut, /因果引爆:/);

  // 4) 【假象余震二段】与过期 once 关注方向在 EJS 中的表现
  const stage2PlotOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-16日' },
    任务列表: { '案卷重核': { 状态: '进行中', 进展: '[6月-15日] 启动二段追查' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        关注方向: { 文本: '过期单次关注', 模式: 'once', 消息数: '1' },
        待重扫: { 楼层: '5', 消息数: '6' },
        列表: [
          {
            id: 'q2nd',
            类别: '本地主线',
            等级: 'B',
            标题: '【假象余震二段】案卷重核',
            真相: '【假象余震二段】幕后总管借旧案掩盖军械失踪',
            预期收益: ['史诗披风 ×1', '金币 ×200'],
          },
        ],
      },
    },
  }, { chat: Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 5, source: plotSrc });
  assert.doesNotMatch(stage2PlotOut, /假象余震二段|关注方向（过期单次关注）/);
  assert.match(stage2PlotOut, /【悬疑反转】/);
  assert.match(stage2PlotOut, /推进并含 1 次偏差或取舍/);

  // 过期 once 关注方向在 update 生成模板中也不再透出
  const expOnceUpdate = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-16日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        关注方向: { 文本: '过期单次关注', 模式: 'once', 消息数: '1' },
        待重扫: { 楼层: '5', 消息数: '6' },
        列表: [],
      },
    },
  }, { chat: Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 5, source: updateSrc });
  assert.doesNotMatch(expOnceUpdate, /关注方向（过期单次关注）/);

  // 5) 同日同区多次 rescan（不同 待重扫.消息数）不会锁死同一骨架推荐/伏笔判定
  const makeRescanAt = (mc) => renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-16日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        待重扫: { 楼层: String(mc - 1), 消息数: String(mc) },
        列表: [{ id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '老剧情', 预期收益: ['史诗甲 ×1'] }],
      },
    },
  }, { chat: Array.from({ length: mc }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: mc - 1, source: updateSrc });
  const recLines = new Set(
    [2, 4, 6, 8, 10, 12]
      .map((mc) => (makeRescanAt(mc).match(/本轮优先推荐骨架：[^\n]+/) || [])[0] || '')
      .filter(Boolean),
  );
  assert.ok(recLines.size >= 2);
});

test('二轮终审回归：多前缀映射、余震二段降冷、僵尸导演状态、边界与全语体收口', async () => {
  // 1) stripTaskTitle 剥离串联多前缀标签，恢复 接取 / 留种 / 完结清扫 全链路闭合
  assert.equal(stripTaskTitle('【假象余震】【护送破局】调查古井（团队）'), '调查古井');
  const multiTagStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    任务列表: { '调查古井': { 状态: '进行中', 进展: '[6月-10日] 勘查古井井台' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          {
            id: 'q_井',
            类别: '本地主线',
            等级: 'C',
            标题: '【假象余震】【护送破局】调查古井（团队）',
            方式: '调查',
            真相: '【假象余震】【护送破局】水面无波｜余震引信：井底刻痕比城史更古老',
            预期收益: ['金币 ×120'],
          },
        ],
      },
    },
  };
  const multiState = questBoardState(multiTagStat);
  assert.equal(multiState.items.length, 1);
  assert.equal(multiState.items[0].accepted, true);
  assert.equal(multiState.items[0].displayTitle, '调查古井（团队）');

  const dual = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  const plotSrc = dual.entries['0'].content;
  const updateSrc = dual.entries['1'].content;
  const chat2 = [{ is_user: true, mes: '查看古井' }, { is_user: false, mes: '井水平静' }];
  const multiPlotOut = renderEjs(multiTagStat, { chat: chat2, lastUserMessageId: 1, source: plotSrc });
  assert.match(multiPlotOut, /已接取:调查古井/);
  assert.doesNotMatch(multiPlotOut, /假象余震|余震引信/);

  // 结案后 sweepClosedQuests 必须准确清扫并抽取引信
  const multiDoneStat = JSON.parse(JSON.stringify(multiTagStat));
  multiDoneStat['任务列表']['调查古井'].状态 = '已完成';
  const multiSwept = sweepClosedQuests(multiDoneStat, { chatCount: 10 }).stat;
  assert.equal(multiSwept['事件']['任务情报板']['列表'].length, 0);
  assert.equal(multiSwept['事件']['任务情报板']['导演状态']['余震冷却'], 3);
  assert.equal(multiSwept['事件']['任务情报板']['导演状态']['待引爆'][0]['引信'], '井底刻痕比城史更古老');

  // 2) isAftershockQuestEntry 对同时含 来源:'余震衍生' 与 【假象余震二段】 正常递减冷却；toggleQuestIntent/ignoreQuest Toast 去标签
  const stage2DerivSwept = sweepClosedQuests({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '二段深挖': { 状态: '已完成' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: { 余震冷却: 2 },
        列表: [
          {
            id: 'q_d2',
            类别: '本地主线',
            等级: 'B',
            来源: '余震衍生',
            标题: '【假象余震二段】二段深挖',
            真相: '【假象余震二段】追踪旧印来源',
            预期收益: ['史诗印戒 ×1'],
          },
        ],
      },
    },
  }, { chatCount: 12 }).stat;
  assert.equal(stage2DerivSwept['事件']['任务情报板']['导演状态']['余震冷却'], 1);

  const intentRes = toggleQuestIntent(multiTagStat, 'q_井', '【假象余震】【护送破局】调查古井（团队）');
  assert.doesNotMatch(intentRes.done, /假象余震|护送破局/);
  assert.match(intentRes.done, /调查古井（团队）/);
  const ignoreSpaced = ignoreQuest({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: { ' spaced ': { 类别: '支线任务', 等级: 'D', 标题: '【 悬疑反转 】空白键委托' } },
      },
    },
  }, ' spaced ', '【 悬疑反转 】空白键委托');
  assert.equal(Object.keys(ignoreSpaced.stat['事件']['任务情报板']['列表']).length, 0);
  assert.doesNotMatch(ignoreSpaced.done, /悬疑反转/);

  // 3) 僵尸/畸形 导演状态 自愈清理
  for (const zombieDir of [
    { 待引爆: [] },
    { 余震冷却: 0 },
    { 待引爆: 'bad_str', 余震冷却: 'bad' },
    { 待引爆: [null, { 引信: '' }], 余震冷却: 0 },
    'corrupted',
  ]) {
    const zStat = {
      世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
      事件: { 任务情报板: { 区域键: '雾晶港', 区域: '雾晶港', 导演状态: zombieDir, 列表: [] } },
    };
    assert.equal(hasExpiredDirectorLeads(zStat, { chatCount: 10 }), true);
    const cleaned = sweepExpiredDirectorLeads(zStat, { chatCount: 10 }).stat;
    assert.equal(cleaned['事件']['任务情报板']['导演状态'], undefined);
  }

  // 4) 空 消息数 once 关注方向：带 楼层 回退 + 伴随已过期 待重扫 时前后端一致判定过期；relocate 消费清理 Patch
  const floorOnceStat = setQuestFocus({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-10日' },
    事件: { 任务情报板: { 区域键: '雾晶港', 区域: '雾晶港', 列表: [] } },
  }, '楼层兜底测试', { mode: 'once', floor: 2 }).stat;
  assert.equal(floorOnceStat['事件']['任务情报板']['关注方向']['楼层'], '2');
  assert.equal(isOnceFocusExpired(floorOnceStat['事件']['任务情报板'], { floor: 5 }), true);

  const emptyOnceExpiredRescan = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        关注方向: { 文本: '遗留单次关注', 模式: 'once', 消息数: '' },
        待重扫: { 楼层: '1', 消息数: '2' },
        列表: [],
      },
    },
  };
  assert.equal(questBoardState(emptyOnceExpiredRescan, { chatCount: 10, floor: 9 }).focus.active, false);
  const expEmptyOnceUpdate = renderEjs(
    emptyOnceExpiredRescan,
    { chat: Array.from({ length: 10 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 9, source: updateSrc },
  );
  assert.doesNotMatch(expEmptyOnceUpdate, /关注方向（遗留单次关注）/);

  const relocateEmptyOnce = renderEjs({
    世界: { 地点: '铁炉堡', 时间: '复兴纪元488年-6月-12日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        关注方向: { 文本: '锻造委托', 模式: 'once', 消息数: '' },
        列表: [{ id: 'q1', 类别: '剧情任务', 等级: 'B', 标题: '主线', 预期收益: ['史诗剑 ×1'] }],
      },
    },
  }, { chat: chat2, lastUserMessageId: 1, source: updateSrc });
  assert.match(relocateEmptyOnce, /关注方向（锻造委托）:.*remove.*"path": "\/事件\/任务情报板\/关注方向"/);

  // 5) commit.js 跨聊天 chatId / swipe_id 写锁保护
  const { commit } = await import('./src/commit.js');
  const savedGlobals = {
    Mvu: globalThis.Mvu,
    TavernHelper: globalThis.TavernHelper,
    SillyTavern: globalThis.SillyTavern,
  };
  try {
    let curChatId = 'chat-A';
    let curSwipeId = 0;
    let replacedCount = 0;
    globalThis.TavernHelper = { getLastMessageId: () => 5, refreshOneMessage: async () => {} };
    globalThis.SillyTavern = {
      getContext: () => ({
        chatId: curChatId,
        chat: Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0, swipe_id: curSwipeId, mes: 'm' })),
        saveChat: async () => {},
      }),
    };
    globalThis.Mvu = {
      getMvuData: () => ({ stat_data: { 主角: {}, 事件: { 任务情报板: { 列表: [] } } } }),
      replaceMvuData: async () => { replacedCount += 1; },
    };
    const swipeAbort = await commit((s) => {
      curSwipeId = 1;
      return { stat: s, done: 'ok' };
    }, { redraw: false, expectedChatId: 'chat-A' });
    assert.match(swipeAbort.error || '', /已变化/);
    const chatAbort = await commit((s) => ({ stat: s, done: 'ok' }), { redraw: false, expectedChatId: 'chat-B' });
    assert.match(chatAbort.error || '', /聊天已切换/);
    assert.equal(replacedCount, 0);
  } finally {
    globalThis.Mvu = savedGlobals.Mvu;
    globalThis.TavernHelper = savedGlobals.TavernHelper;
    globalThis.SillyTavern = savedGlobals.SillyTavern;
  }

  // 6) panel.js 使用 displayTitle 渲染卡片标题且含 IME isComposing 守卫
  const panelCode = fs.readFileSync(path.join(__dirname, 'src', 'panel.js'), 'utf8');
  assert.match(panelCode, /el\('h3', 'qh-quest-title', item\.displayTitle \|\| item\.title\)/);
  assert.equal((panelCode.match(/isComposing/g) || []).length >= 2, true);

  // 7) 语体去古风与同轮去重终检（初段 主线 0~1 栏、因果后续区分、待引爆>=2禁止追加、无明牌/抢跑/断链/正直自洽/软倾斜/抓走）
  const seqDueOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-14日' },
    任务列表: {},
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 2,
          待引爆: [
            { 标题: '普通后续案', 区域: '旧港城', 类型: '因果后续', 引信: '商队暗纹箱去向王都', 触发后消息数: '4', 过期消息数: '14' },
            { 标题: '另一条引信', 类型: '因果后续', 引信: '尚未到期', 触发后消息数: '99', 过期消息数: '120' },
          ],
        },
        列表: [
          { id: 'q1', 类别: '支线任务', 等级: 'D', 标题: '支线A', 预期收益: ['金币 ×40'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '支线B', 预期收益: ['金币 ×40'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '支线C', 预期收益: ['金币 ×40'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '支线D', 预期收益: ['金币 ×40'] },
        ],
      },
    },
  }, { chat: Array.from({ length: 5 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 4, source: plotSrc });
  assert.match(seqDueOut, /显露后续异动（商队暗纹箱去向王都）/);
  assert.doesNotMatch(seqDueOut, /露出物理裂痕|假象余震/);

  const seqDueUpdate = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-14日' },
    任务列表: { '已满队列测试': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 2,
          待引爆: [
            { 标题: '待引爆A', 类型: '因果后续', 引信: '线索A', 触发后消息数: '99', 过期消息数: '120' },
            { 标题: '待引爆B', 类型: '假象余震', 引信: '线索B', 触发后消息数: '99', 过期消息数: '120' },
          ],
        },
        列表: [
          { id: 'q_full', 类别: '本地主线', 等级: 'C', 标题: '已满队列测试', 真相: '【假象余震】一阶段｜余震引信：满2条时不应再留种', 预期收益: ['金币 ×100'] },
        ],
      },
    },
  }, { chat: chat2, lastUserMessageId: 1, source: updateSrc });
  assert.doesNotMatch(seqDueUpdate, /若本轮结案留种：/);

  const allAllOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '护送线': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'C', 标题: '护送线', 真相: '【护送破局】车队过境', 预期收益: ['史诗甲 ×1'] },
        ],
      },
    },
  }, { chat: chat2, lastUserMessageId: 1 });
  assert.match(allAllOut, /初段 0~2 栏或主线 0~1 栏/);
  assert.equal((allAllOut.match(/实际发放某栏收益时/g) || []).length, 1);
  assert.doesNotMatch(allAllOut, /明牌|抢跑|断链变数|正派立场|完全正直自洽|软倾斜|抓走|多方竞价|危机倒计时/);
});

test('三轮收口回归：toastr.ok映射、入队队列级swipe锁、额外键导演不死循环、空格键贯通与EJS分支同步', async () => {
  const { commit } = await import('./src/commit.js');
  const hostMod = await import('./src/host.js');

  // 1) host.toast 映射 ok -> success / err -> error；focusInput 在桌面带 preventScroll、触屏不弹键盘
  const saved = {
    toastr: globalThis.toastr,
    window: globalThis.window,
    Mvu: globalThis.Mvu,
    TavernHelper: globalThis.TavernHelper,
    SillyTavern: globalThis.SillyTavern,
  };
  try {
    const calls = [];
    let focusOpts = null;
    let coarse = false;
    const fakeBox = { focus: (opts) => { focusOpts = opts; } };
    globalThis.toastr = {
      success: (m) => calls.push(['success', m]),
      error: (m) => calls.push(['error', m]),
      info: (m) => calls.push(['info', m]),
    };
    assert.equal(hostMod.toast('填入成功', 'ok'), true);
    assert.equal(hostMod.toast('出错了', 'err'), true);
    assert.deepEqual(calls, [['success', '填入成功'], ['error', '出错了']]);

    if (typeof globalThis.window === 'undefined') {
      globalThis.window = {
        document: { querySelector: () => fakeBox },
        matchMedia: (q) => ({
          matches: q === '(pointer: coarse)' ? coarse : false,
        }),
      };
    }
    if (hostMod.parentWindow === globalThis.window) {
      globalThis.window.document = { querySelector: () => fakeBox };
      globalThis.window.matchMedia = (q) => ({
        matches: q === '(pointer: coarse)' ? coarse : false,
      });
      assert.equal(hostMod.focusInput(), true);
      assert.deepEqual(focusOpts, { preventScroll: true });
      coarse = true;
      assert.equal(hostMod.focusInput(), false);
    }

    // 2) commit.js 入队排队期间发生的 swipe_id 切换也必须被拦截
    let curSwipe = 0;
    let replaceCount = 0;
    let gateResolve;
    const gate = new Promise((res) => { gateResolve = res; });
    globalThis.TavernHelper = { getLastMessageId: () => 5, refreshOneMessage: async () => {} };
    globalThis.SillyTavern = {
      getContext: () => ({
        chatId: 'chat-queue',
        chat: Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0, swipe_id: curSwipe, mes: 'm' })),
        saveChat: async () => {},
      }),
    };
    globalThis.Mvu = {
      getMvuData: () => ({ stat_data: { 主角: {}, 事件: { 任务情报板: { 列表: [] } } } }),
      replaceMvuData: async () => {
        replaceCount += 1;
        await gate;
      },
    };
    const p1 = commit((s) => ({ stat: s, done: 'first' }), { redraw: false });
    const p2 = commit((s) => ({ stat: s, done: 'second' }), { redraw: false });
    await new Promise((r) => setTimeout(r, 15));
    curSwipe = 1; // 在 p1 持锁等待写入期间用户切了 swipe
    gateResolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.done, 'first');
    assert.match(r2.error || '', /已变化/);
    assert.equal(replaceCount, 1);
  } finally {
    globalThis.toastr = saved.toastr;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    globalThis.Mvu = saved.Mvu;
    globalThis.TavernHelper = saved.TavernHelper;
    globalThis.SillyTavern = saved.SillyTavern;
  }

  // 3) 导演状态含额外未知键时彻底删除节点，二次 maintainQuestBoard 返回 skip 绝不死循环
  const extraKeyDirStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: { 余震冷却: 0, 异常备注: 'legacy' },
        列表: [],
      },
    },
  };
  assert.equal(hasExpiredDirectorLeads(extraKeyDirStat, { chatCount: 10 }), true);
  const firstMaint = maintainQuestBoard(extraKeyDirStat, { chatCount: 10 });
  assert.equal(firstMaint.stat['事件']['任务情报板']['导演状态'], undefined);
  const secondMaint = maintainQuestBoard(firstMaint.stat, { chatCount: 10 });
  assert.equal(secondMaint.skip, true);

  // 4) requestQuestRescan 保留并透传 once 关注方向的 楼层 兜底锚点
  const rescanFloorFocus = requestQuestRescan({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    命运点数: 200,
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        关注方向: { 文本: '旧关注', 模式: 'once', 消息数: '', 楼层: '2' },
        列表: [],
      },
    },
  }, 5, null, { focusText: '新矿脉', focusMode: 'once' });
  assert.equal(rescanFloorFocus.stat['事件']['任务情报板']['关注方向']['楼层'], '5');

  // 5) 对象型 列表 带空格键名贯通：read + 已兑现[' spaced '] + 锁定/取消 + EJS 完结移出路径
  const spacedObjStat = {
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '带空格任务': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        已兑现: { ' spaced ': [1] },
        列表: {
          ' spaced ': { 类别: '本地主线', 等级: 'C', 标题: '【护送破局】带空格任务', 预期收益: ['金币 ×100'] },
        },
      },
    },
  };
  const spacedState = questBoardState(spacedObjStat);
  assert.equal(spacedState.items[0].id, 'spaced');
  assert.equal(spacedState.items[0].rewardItems[0].claimed, true);
  const lockedSpaced = toggleQuestIntent(spacedObjStat, spacedState.items[0].id, spacedState.items[0].title);
  assert.equal(questBoardState(lockedSpaced.stat).items[0].intent, true);
  const unlockedSpaced = toggleQuestIntent(lockedSpaced.stat, spacedState.items[0].id, spacedState.items[0].title);
  assert.equal(questBoardState(unlockedSpaced.stat).items[0].intent, false);

  const ejsSource = fs.readFileSync(path.join(__dirname, '任务助手-世界书.ejs'), 'utf8');
  const dual = buildWorldbookJson(ejsSource, SCRIPT_VERSION);
  const updateSrc = dual.entries['1'].content;
  const spacedUpdateOut = renderEjs(spacedObjStat, { chat: [{ is_user: true, mes: 'hi' }], lastUserMessageId: 0, source: updateSrc });
  assert.match(spacedUpdateOut, /\[1✓\]金币 ×100/);
  assert.match(spacedUpdateOut, /\/事件\/任务情报板\/列表\/ spaced /);

  // 6) 纯支线 refill 不误发 失效Patch；因果后续引爆 update/all 口径同步；引爆+降冷却合并；5处语体收口
  const sideRefillOut = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-12日' },
    任务列表: { '找猫': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        列表: [
          { id: 'q_cat', 类别: '支线任务', 等级: 'D', 标题: '找猫', 预期收益: ['金币 ×20'] },
        ],
      },
    },
  }, { chat: [{ is_user: true, mes: 'hi' }], lastUserMessageId: 0 });
  assert.doesNotMatch(sideRefillOut, /因失败或局势恶化折损未兑现栏位时/);

  const causalDueAll = renderEjs({
    世界: { 地点: '雾晶港', 时间: '复兴纪元488年-6月-14日' },
    任务列表: { '普通线': { 状态: '进行中' } },
    事件: {
      任务情报板: {
        区域键: '雾晶港',
        区域: '雾晶港',
        导演状态: {
          余震冷却: 1,
          待引爆: [
            { 标题: '走私案', 区域: '旧港城', 类型: '因果后续', 引信: '水手持有南境通行牌', 触发后消息数: '4', 过期消息数: '14' },
          ],
        },
        列表: [
          { id: 'q1', 类别: '本地主线', 等级: 'C', 标题: '普通线', 真相: '【灾变探索】常规治理', 预期收益: ['金币 ×100'] },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '支A', 预期收益: ['金币 ×30'] },
          { id: 'q3', 类别: '支线任务', 等级: 'D', 标题: '支B', 预期收益: ['金币 ×30'] },
          { id: 'q4', 类别: '支线任务', 等级: 'D', 标题: '支C', 预期收益: ['金币 ×30'] },
          { id: 'q5', 类别: '支线任务', 等级: 'D', 标题: '支D', 预期收益: ['金币 ×30'] },
        ],
      },
    },
  }, { chat: Array.from({ length: 5 }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, mes: 'x' })), lastUserMessageId: 4 });
  assert.match(causalDueAll, /因果引爆:.*显露后续异动（水手持有南境通行牌）.*后续线索/);
  assert.doesNotMatch(causalDueAll, /露出物理裂痕/);
  assert.match(causalDueAll, /同轮多处涉及「导演状态」变更时合并处理/);
  assert.doesNotMatch(causalDueAll, /拿满核心奖励|属 `OTHER SPECIFIC REQUIREMENTS`|改写替换|另含多地脉络|全额发齐/);

  // 7) 防抢跑短窗口信号与 generating()
  const savedCommitGlobals = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  try {
    globalThis.document = { getElementById: () => ({ id: 'mes_stop' }) };
    globalThis.getComputedStyle = () => ({ display: 'inline-block' });
    assert.equal(generating(), true);
    globalThis.getComputedStyle = () => ({ display: 'none' });
    assert.equal(generating(), false);

    clearReplySettle();
    assert.equal(replySettleRemainingMs({ chatCount: 10, chatId: 'c1' }), 0);
    markReplyReceived(10, 'c1');
    assert.ok(replySettleRemainingMs({ chatCount: 10, chatId: 'c1', waitMs: 1200 }) > 0);
    assert.equal(replySettleRemainingMs({ chatCount: 11, chatId: 'c1', waitMs: 1200 }), 0);
    assert.equal(replySettleRemainingMs({ chatCount: 10, chatId: 'c2', waitMs: 1200 }), 0);
    markMvuSettled(10, 'c1');
    assert.equal(replySettleRemainingMs({ chatCount: 10, chatId: 'c1', waitMs: 1200 }), 0);
    // 删楼重发回到相同 chatCount=10 时，新一轮 markReplyReceived 必须清除旧 MVU 信号并重新生效
    markReplyReceived(10, 'c1');
    assert.ok(replySettleRemainingMs({ chatCount: 10, chatId: 'c1', waitMs: 1200 }) > 0);
    clearReplySettle();
  } finally {
    if (savedCommitGlobals.document === undefined) delete globalThis.document;
    else globalThis.document = savedCommitGlobals.document;
    if (savedCommitGlobals.getComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = savedCommitGlobals.getComputedStyle;
  }
});
