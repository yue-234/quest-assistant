import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  questBoardState,
  readState,
  stripTaskTitle,
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
} from './src/actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadEjs() {
  const pnpmRoot = 'f:/git/Destined-Poem-Card/node_modules/.pnpm';
  const dirs = fs.readdirSync(pnpmRoot).filter((d) => d.startsWith('ejs@'));
  for (const d of dirs) {
    const candidate = path.join(pnpmRoot, d, 'node_modules', 'ejs', 'lib', 'ejs.js');
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require(require.resolve('ejs', { paths: ['f:/git/Destined-Poem-Card'] }));
}

const ejs = loadEjs();
const ejsSource = fs.readFileSync(path.join(__dirname, '任务助手-世界书.ejs'), 'utf8');
const builtScriptPath = path.join(__dirname, '⭐粘这个-任务助手脚本.js');

function renderEjs(statData, { chat = [], lastUserMessageId = 0, geoData = {} } = {}) {
  const ctx = {
    getvar: (k) => (k === 'stat_data' ? statData : undefined),
    getLocalVar: (k) => (k === 'runtime_geo_compact_data' ? geoData : {}),
    SillyTavern: { getContext: () => ({ chat }) },
    lastUserMessageId,
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

test('EJS init 模式：首次初始化任务情报板 + 事件钩子命中', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '艾尔登大陆-巨龙山脉-铁炉堡-铁砧酒馆', 时间: '复兴纪元488年-3月-10日-12:00' },
    事件: {},
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'init');
  assert.match(out, /首次初始化任务情报板/);
  assert.match(out, /"op": "insert", "path": "\/事件\/任务情报板"/);
  assert.match(out, /艾波丽斯/);
  assert.match(out, /生成规格/);
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
  assert.match(out, /莉莉娅丝/);
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

test('EJS advance 模式：剧情任务搁置满 5 日自动演进', () => {
  const stat = {
    主角: { 等级: 5 },
    世界: { 地点: '白石镇', 时间: '复兴纪元488年-3月-16日-10:00' },
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
        ],
      },
    },
  };
  const out = renderEjs(stat);
  assertCleanOutput(out, 'advance');
  assert.match(out, /剧情任务搁置演进/);
  assert.match(out, /待演进:已搁置 6 日/);
  assert.match(out, /静默同步至任务情报板，必要时在正文中通过当地传闻或情报渠道自然带出一句/);
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

  // 100 FP 重扫 + 防重复 + 过期清理
  res = requestQuestRescan(stat, 10, 12);
  assert.ok(!res.error);
  stat = res.stat;
  assert.equal(stat['命运点数'], '150');
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
// 3. 最终构建产物校验
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
