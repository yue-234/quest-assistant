import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { DATA } from './src/data.js';
import {
  questBoardState,
  readState,
  parseAftermathEntry,
  isAftermathEntryExpired,
  stripTaskTitle,
  matchFormalTask,
  extractHistoryStats,
  wasInHistoryFormalTasks,
} from './src/state.js';
import {
  toggleQuestIntent,
  ignoreQuest,
  toggleQuestRewardClaimed,
  deleteAftermathEntry,
  hasExpiredAftermath,
  sweepExpiredAftermath,
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

function renderEjs(statData, { chat = [], lastUserMessageId = 0, geoData = {}, systemCore = '', destinyImmersiveMode } = {}) {
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
  };
  return ejs.render(ejsSource, ctx);
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

test('EJS rescan 模式：100 FP 地区情报重扫', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '铁炉堡-东区', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {
      任务情报板: {
        区域键: '铁炉堡',
        区域: '铁炉堡',
        更新日: '复兴纪元488年-3月-10日',
        待重扫: { 楼层: '4', 消息数: '5' },
        列表: [
          { id: 'q1', 类别: '剧情任务', 等级: 'A', 标题: '群山远征', 方式: '委托', 预期收益: ['传说武器 ×1'], 更新日: '复兴纪元488年-3月-10日' },
          { id: 'q2', 类别: '支线任务', 等级: 'D', 标题: '旧委托', 方式: '委托', 预期收益: ['金币 ×50'] },
        ],
      },
    },
  };
  const out = renderEjs(stat, { chat: new Array(6).fill({}), lastUserMessageId: 5 });
  assertCleanOutput(out, 'rescan');
  assert.match(out, /已支付 100 FP 启动地区情报重扫/);
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

  assert.equal(questRescanDone(stat, 12, 14), true);
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
  assert.match(outNone, /默认写入 3 条常驻词条/);
  assert.match(outNone, /分属不同维度.*彼此逻辑自洽，不重复、不自相矛盾/);
  assert.match(outNone, /禁止 3 绿、3 黄、3 红/);
  assert.match(outNone, /不得每区机械套用 1 绿 1 黄 1 红/);
  assert.match(outNone, /当地正有短期活动时应先写满 3 条常驻词条，再额外追加 1~2 条限时词条/);
  assert.match(outNone, /离开满 14 天/);
  assert.match(outNone, /明确剧情变故、已到期的预告事件/);
  assert.match(outNone, /禁止以 `<user>` 或冒险者为主语写战绩记录/);
  assert.match(outNone, /支线任务与日常琐事不改写词条/);
  assert.match(outNone, /非任务的重大剧情与事件链变故（如敌对势力袭击城镇/);
  assert.match(outNone, /并随局势同步升降色阶（恶化转黄或升红，好转降黄或转绿/);
  assert.match(outNone, /发生重大剧情或事件链变故时按规则更新区域或世界词条/);
  assert.match(outNone, /`世界` 词条同样使用 `\[绿\/黄\/红\]` 色阶，不默认生成，仅剧情任务或重大剧情与事件链引发的跨大区或全大陆级重大后果允许写入或改写 `世界`/);
  assert.match(outNone, /保留「意向」「忽略」「已兑现」「曾接取」「上次重扫日」「余波」「区域访问日」/);
  assert.match(outNone, /"op": "insert", "path": "\/事件\/任务情报板\/余波"/);

  // 1.5) init 与 relocate 且当前区域无词条时，本轮指令提示写入 3 条差异化色阶初始区域词条并记录区域访问日
  const outInit = renderEjs({
    世界: { 地点: '霜语城-港口', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: {},
  });
  assertCleanOutput(outInit, 'aftermath-init-hint');
  assert.match(outInit, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时另行额外叠加 1~2 条限时词条）并记录区域访问日/);
  assert.match(outInit, /"区域访问日": \{ "港口": "复兴纪元488年-3月-11日" \}/);

  const outRelocateNoTrait = renderEjs({
    世界: { 地点: '瓦伦蒂亚-城门广场', 时间: '复兴纪元488年-3月-11日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outRelocateNoTrait, 'aftermath-relocate-hint');
  assert.match(outRelocateNoTrait, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时另行额外叠加 1~2 条限时词条）并记录区域访问日/);
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
  assert.match(outLocal, /本区词条（铁炉堡）:/);
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
  assert.match(outLong, /返回旧区域（已离开 16 天）：按上方词条规则演进或改写本区最多 1 条词条（无明显变化则保持不变），并更新区域访问日/);
  assert.match(outLong, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/铁炉堡", "value": "复兴纪元488年-3月-26日"/);
  assert.match(outLong, /"op": "replace", "path": "\/事件\/任务情报板\/区域访问日\/瓦伦蒂亚", "value": "复兴纪元488年-3月-26日"/);

  // 3) 已有区域访问日对象但迁入从未访问过的新城：旧区 replace、新区 insert
  const outNewCity = renderEjs({
    世界: { 地点: '雾晶港-北码头', 时间: '复兴纪元488年-3月-26日-10:00' },
    事件: { 任务情报板: baseBoard },
  });
  assertCleanOutput(outNewCity, 'revisit-new-city');
  assert.match(outNewCity, /为当前区域写入 3 条差异化色阶的初始常驻词条（禁止纯色；当地正有短期活动时另行额外叠加 1~2 条限时词条）并记录区域访问日/);
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

  // 3) 空壳板 rescan 补齐基础键时同样输出区域访问日 Patch
  const outShellRescan = renderEjs(
    {
      世界: { 地点: '白石镇', 时间: '复兴纪元488年-4月-2日-10:00' },
      事件: { 任务情报板: { 待重扫: { 消息数: '5' } } },
    },
    { chat: Array.from({ length: 5 }, () => ({ mes: '' })) },
  );
  assertCleanOutput(outShellRescan, 'shell-rescan-visit-day');
  assert.match(outShellRescan, /"op": "insert", "path": "\/事件\/任务情报板\/区域访问日", "value": \{ "白石镇": "复兴纪元488年-4月-2日" \}/);
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
  assert.match(out, /不受默认参考配额限制/);
  assert.match(out, /\/事件\/任务情报板\/列表\/-/);
  assert.match(out, /优先按体量定级为「剧情任务」/);
  assert.match(out, /剧情任务与本地主线附带后台隐藏 `真相`/);
  assert.match(out, /下列条数为自动生成与补缺的参考配额，非硬上限/);
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

test('构建产物 ⭐粘这个-任务助手脚本.js 与 .txt 语法合法且无未转义 </script> 或 UNN 冲突', () => {
  assert.equal(fs.existsSync(builtScriptPath), true, '应先运行 build.mjs 生成最终脚本');
  assert.equal(fs.existsSync(builtScriptTxtPath), true, '应同步生成 .txt 脚本产物');
  const code = fs.readFileSync(builtScriptPath, 'utf8');
  const txtCode = fs.readFileSync(builtScriptTxtPath, 'utf8');
  assert.equal(txtCode, code, '⭐粘这个-任务助手脚本.txt 应与 .js 产物完全一致');
  assert.ok(code.length > 5000, '产物内容过短');
  assert.doesNotMatch(code, /<\/script>/i, '产物不得包含未转义 </script>');
  assert.doesNotMatch(code, /UNNCore|unn-core-studio|unn-core-fab|unn_studio_fab_pos_v1|unn_qb_seen_progress/, '不得与 UNN 命名空间冲突');
  assert.match(code, /QuestHelperApp/);
  assert.match(code, /quest-helper-studio/);
  assert.match(code, /quest-helper-fab/);
  assert.match(code, /quest-helper-wand-item/);
  assert.match(code, /quest_helper_entry_mode_v1/);
  assert.doesNotThrow(() => new Function(code), '产物必须通过 new Function 语法校验');
});
