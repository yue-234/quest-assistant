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
  stripTaskTitle,
  matchFormalTask,
  extractHistoryStats,
  wasInHistoryFormalTasks,
} from './src/state.js';
import {
  toggleQuestIntent,
  ignoreQuest,
  toggleQuestRewardClaimed,
  requestQuestRescan,
  questRescanDone,
  clearQuestRescan,
  needsQuestAcceptedRecord,
  recordAcceptedQuests,
  hasClosedQuestLeftovers,
  sweepClosedQuests,
  maintainQuestBoard,
} from './src/actions.js';

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
  assert.match(out, /未在上下文激活的事件链不得凭空捏造/);
  assert.doesNotMatch(out, /本区事件钩子|艾波丽斯|莉莉娅丝|素瓷密室|斯芬克斯/);
  assert.match(out, /生成规格/);
  assert.match(out, /B~S 级/);
  assert.match(out, /收益 10 栏/);
  assert.match(out, /途经数个城市\/区域/);
  assert.match(out, /严禁用 `→` 串联多站路线/);
  assert.match(out, /长期放任将导致局势失控并波及多地乃至世界/);
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
  assert.match(out, /待演进:已搁置 6 日/);
  assert.match(out, /静默同步至正式任务列表（不双写任务情报板），必要时在正文中通过当地传闻或情报渠道自然带出一句/);
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
  assert.match(outNoYear, /待演进:已搁置 10 日/);

  // 无连字符中文年月日：[488年3月12日] 距 3月-20日 搁置 8 日 -> 触发演进
  const outNoDash = renderEjs(makeStat('[488年3月12日] 追踪到码头'));
  assertCleanOutput(outNoDash, 'date-no-dash');
  assert.match(outNoDash, /待演进:已搁置 8 日/);

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
  assert.match(out, /待演进:已搁置 6 日/);
});

// ---------------------------------------------------------------------------
// 4. 最终构建产物校验
// ---------------------------------------------------------------------------

test('构建产物 ⭐粘这个-任务助手脚本.js 语法合法且无未转义 </script> 或 UNN 冲突', () => {
  assert.equal(fs.existsSync(builtScriptPath), true, '应先运行 build.mjs 生成最终脚本');
  const code = fs.readFileSync(builtScriptPath, 'utf8');
  assert.ok(code.length > 5000, '产物内容过短');
  assert.doesNotMatch(code, /<\/script>/i, '产物不得包含未转义 </script>');
  assert.doesNotMatch(code, /UNNCore|unn-core-studio|unn-core-fab|unn_studio_fab_pos_v1|unn_qb_seen_progress/, '不得与 UNN 命名空间冲突');
  assert.match(code, /QuestHelperApp/);
  assert.match(code, /quest-helper-studio/);
  assert.match(code, /quest-helper-fab/);
  assert.doesNotThrow(() => new Function(code), '产物必须通过 new Function 语法校验');
});
