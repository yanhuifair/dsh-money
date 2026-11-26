/**
 * Host 侧回归测试（纯 node，无框架；需先 npm run build 产出 lib/）
 *
 * 覆盖历史上真出过问题的地方：
 *  1) workspacesAll 出口字段完整性（1.10.0 曾把 retainedSimCost 算出来却在 @Remote 出口丢掉，
 *     导致「已删除会话费用不从总账消失」端到端失效）
 *  2) API / 本地模拟分桶不串（本地费用不得进 API 总额与峰/闲分项）
 *  3) 时段边界：长假（2026 春节连休）必须能扫到真正的下一个切换点，而不是回落 ±DAY 兜底
 *  4) 增量折叠：缺 seq 的事件不得被重复累加；增量结果必须等于全量重折
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';

// 隔离 retained 账本：host 会把账本写到 homedir()/.dsh-money，
// 测试必须在临时 HOME 下跑，否则会污染用户真实账本
process.env.HOME = '/tmp/dsh-money-host-test-home';
process.env.USERPROFILE = '/tmp/dsh-money-host-test-home';
mkdirSync(process.env.HOME, { recursive: true });

const LIB = new URL('../packages/dsh-money/lib/index.js', import.meta.url).href;
if (!existsSync(new URL(LIB))) {
  console.error('缺少 packages/dsh-money/lib/index.js —— 先执行 npm run build 再跑测试');
  process.exit(1);
}
const mod = await import(LIB);
const MoneyCostService = mod.default;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' → ' + (e && e.message ? e.message : e)); fail++; }
}

const DAY = 24 * 3600 * 1000;
const BJT = (y, m, d, h) => Date.UTC(y, m - 1, d, h) - 8 * 3600 * 1000; // 北京时间 → UTC 毫秒

// ---------- 1) 时段边界纯函数 ----------
check('工作日高峰：北京 11-26 10:00 为高峰，下次切换 12:00', () => {
  const ms = BJT(2026, 11, 26, 10);
  assert.equal(mod.isPeak(ms), true);
  assert.equal(mod.nextPeriodChange(ms), BJT(2026, 11, 26, 12));
  assert.equal(mod.periodStart(ms), BJT(2026, 11, 26, 9));
});
check('午间低谷：12:30 闲时，下次切换 14:00', () => {
  const ms = BJT(2026, 11, 26, 12) + 30 * 60000;
  assert.equal(mod.isPeak(ms), false);
  assert.equal(mod.nextPeriodChange(ms), BJT(2026, 11, 26, 14));
});
check('周末全天闲时且下次切换为下周一 09:00', () => {
  const sat = BJT(2026, 11, 28, 15); // 周六
  assert.equal(mod.isPeak(sat), false);
  assert.equal(mod.nextPeriodChange(sat), BJT(2026, 11, 30, 9)); // 周一
});
check('春节长假（10.6 天连续闲时）能扫到真实切换点，不回落 ±DAY 兜底', () => {
  const mid = BJT(2026, 2, 20, 12); // 假期正中（2026-02-15~02-23 放假 + 前后周末）
  assert.equal(mod.isPeak(mid), false);
  // 真实下一个切换点：2026-02-24（周二）09:00
  assert.equal(mod.nextPeriodChange(mid), BJT(2026, 2, 24, 9));
  // 真实本段起点：2026-02-13（周五）18:00
  assert.equal(mod.periodStart(mid), BJT(2026, 2, 13, 18));
});
check('假日表未覆盖的 2027 年：工作日仍按高峰（已知限制，行为需显式固定）', () => {
  assert.equal(mod.isPeak(BJT(2027, 2, 17, 10)), true); // 2027 春节实际放假，但表未录入 → 按工作日
});
check('今日高峰窗口：工作日 9-12/14-18，周末空数组', () => {
  assert.deepEqual(mod.dayPeakWindows(BJT(2026, 11, 26, 0)), [[9, 12], [14, 18]]);
  assert.deepEqual(mod.dayPeakWindows(BJT(2026, 11, 29, 0)), []); // 周日
});

// ---------- 2) 计费口径 ----------
const usage = (input, cacheRead, output, cacheWrite) => ({
  inputTokens: input, cacheReadTokens: cacheRead || 0, cacheWriteTokens: cacheWrite || 0, outputTokens: output,
});
check('账单口径：未命中(含写)×miss + 命中×hit + 输出×out，单位每百万 token', () => {
  const price = { hit: 0.02, miss: 1, out: 4 };
  // (1000+0)*1 + 9000*0.02 + 500*4 = 1000 + 180 + 2000 = 3180 → /1e6 = 0.00318
  assert.equal(mod.costOf(usage(1000, 9000, 500), price), 0.00318);
});
check('高峰单价 = 闲时 × 2', () => {
  const peak = mod.priceOf('deepseek-flash', BJT(2026, 11, 26, 10), 'CNY');
  const off = mod.priceOf('deepseek-flash', BJT(2026, 11, 28, 10), 'CNY');
  assert.equal(peak.miss, off.miss * 2);
  assert.equal(peak.out, off.out * 2);
});
check('未知模型无价（走本地模拟，不得按 Flash 计入 API）', () => {
  assert.equal(mod.priceOf('ollama/qwen3', BJT(2026, 11, 26, 10), 'CNY'), null);
});
check('旧模型名按 Flash 计费', () => {
  assert.deepEqual(
    mod.priceOf('deepseek-v4-flash', BJT(2026, 11, 28, 10), 'CNY'),
    mod.priceOf('deepseek-flash', BJT(2026, 11, 28, 10), 'CNY'),
  );
});

// ---------- 3) 端到端：workspacesAll 出口契约 ----------
const ev = (seq, model, u) => ({
  seq,
  time: BJT(2026, 11, 26, 10), // 高峰时段
  type: 'assistant/message',
  data: { message: { id: 'm' + seq, source: { model } }, usage: u },
});
function runService(events, sessionIds, mutateRegistry) {
  // cordis 启动为异步：等 apply 真正执行、服务实例构造完成后再返回
  return new Promise((resolve, reject) => {
    const app = new Context();
    app.plugin({ name: 'host-test', apply(ctx) {
      ctx.provide('credentials', { resolve: async () => undefined });
      ctx.provide('deepseekAccount', { getBalance: async () => null });
      ctx.provide('sessionQuery', { readSession: async () => (events == null ? undefined : { events }) });
      ctx.provide('workspaceRegistry', { list: () => (mutateRegistry ? [] : [{ id: 'w1', title: 'W', sessionIds }]) });
      ctx.provide('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) });
      resolve(new MoneyCostService(ctx));
    } });
    const p = app.start?.();
    if (p && typeof p.catch === 'function') p.catch(reject);
    setTimeout(() => reject(new Error('cordis 启动超时（apply 未执行）')), 5000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mixedEvents = [
  ev(1, 'deepseek-flash', usage(1000000, 0, 100000)),   // API 高峰
  ev(2, 'ollama/qwen3', usage(1000000, 0, 100000)),     // 本地模拟
  ev(3, 'deepseek-flash', usage(500000, 500000, 50000)), // API 高峰
];

let lastTotal = null;
const svc1 = await runService(mixedEvents, ['s1']);
const w1 = await svc1.workspacesAll({});
lastTotal = w1;

check('出口契约：workspacesAll 必含 retainedSimCost（number）与 7 天 days/simDays', () => {
  assert.equal(typeof w1.retainedSimCost, 'number', 'retainedSimCost 缺失或类型错误');
  assert.equal(w1.days.length, 7);
  assert.equal(w1.simDays.length, 7);
});
check('分桶不串：API 总额 = 峰 + 闲；本地模拟不进 API 桶', () => {
  const ws = w1.workspaces[0];
  assert.equal(ws.simCost != null, true, '应有本地模拟费用');
  const peakOffSum = (ws.peakCost || 0) + (ws.offPeakCost || 0);
  assert.ok(Math.abs(peakOffSum - ws.cost) < 1e-8, `峰+闲 ${peakOffSum} 应等于 API 总额 ${ws.cost}`);
  // 高峰价 flash = {hit .04, miss 2, out 8}
  // ev1 (1e6,0,1e5)   → (1e6*2 + 1e5*8)/1e6       = 2.8
  // ev3 (5e5,5e5,5e4) → (5e5*2 + 5e5*0.04 + 5e4*8)/1e6 = 1.42
  assert.ok(Math.abs(ws.cost - 4.22) < 1e-6, `API 总额应约 4.22，实际 ${ws.cost}`);
  // 本地模型按 Flash 同规则同价：ev2 与 ev1 同用量 → 2.8（且不得进 API 桶）
  assert.ok(Math.abs(ws.simCost - 2.8) < 1e-6, `本地合计应约 2.8，实际 ${ws.simCost}`);
});
check('按北京自然日归桶：今日 API 与本地都有值，其余为 0', () => {
  const today = w1.days[0];
  const todaySim = w1.simDays[0];
  assert.ok(today.cost > 0, '今日 API 桶应有值');
  assert.ok(todaySim.cost > 0, '今日本地桶应有值');
  assert.equal(w1.days[3].cost, 0);
});

// ---------- 4) 删除会话后总账保留（1.10.0 承诺） ----------
const svc2 = await runService(mixedEvents, [], true); // 注册表已无该工作区/会话
const w2 = await svc2.workspacesAll({});
check('已删除会话的本地费用仍计入 retainedSimCost 与本地 7 天图', () => {
  assert.equal(w2.workspaces.length, 0, '注册表已空，不应出现工作区行');
  assert.ok(w2.retainedSimCost > 0, `retainedSimCost 应保留上一步记下的本地费用，实际 ${w2.retainedSimCost}`);
  assert.ok(w2.simDays[0].cost > 0, '本地 7 天图今日桶应包含已删除会话的费用');
});

// ---------- 5) 增量折叠等值性与缺 seq 防重 ----------
const svc3 = await runService(mixedEvents, ['s1']);
const a1 = await svc3.workspacesAll({});
const a2 = await svc3.workspacesAll({});
check('连续两次统计结果一致（增量不重复累加）', () => {
  assert.equal(a2.workspaces[0].cost, a1.workspaces[0].cost);
  assert.equal(a2.workspaces[0].simCost, a1.workspaces[0].simCost);
});
const noSeq = mixedEvents.map((e) => { const c = { ...e }; delete c.seq; return c; });
const svc4 = await runService(noSeq, ['s1']);
const b1 = await svc4.workspacesAll({});
const b2 = await svc4.workspacesAll({});
check('事件缺 seq 时不翻倍（整段重折而非追加缓存）', () => {
  assert.equal(b2.workspaces[0].cost, b1.workspaces[0].cost, `二次统计费用翻倍：${b1.workspaces[0].cost} → ${b2.workspaces[0].cost}`);
});
check('无 sessionQuery 时降级为空账且不抛错', () => {
  assert.equal(lastTotal.workspaces.length, 1);
});

console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
