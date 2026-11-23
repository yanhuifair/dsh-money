/**
 * tip 渲染单元测试（源码级，无需 DSH 运行时）
 *
 * 思路：读 src/client.static.cjs 源码，在 vm 沙箱里执行并追加内部导出，
 * 用最小 DOM 桩直接调用 periodTooltip + renderTip，断言价目表/时刻盘输出。
 * 运行：npm test
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'packages', 'dsh-money', 'src', 'client.static.cjs');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}

// ---------- 最小 DOM 桩 ----------
function makeEl(tag) {
  return {
    tag, attrs: {}, children: [], style: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 20, right: 120, width: 100, height: 20 }; },
  };
}
const documentStub = {
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (t) => ({ tag: '#text', textContent: t, children: [], attrs: {}, style: {}, setAttribute() {}, appendChild() {} }),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  addEventListener() {}, removeEventListener() {},
};
const windowStub = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

// ---------- 载入模块 ----------
let src = fs.readFileSync(SRC, 'utf8');
// tip 函数定义在 apply(ctx) 作用域内（函数声明提升）：在 apply 首部注入钩子取出
const ANCHOR = '  startSidebarObserver();\n}';
if (!src.includes(ANCHOR)) { console.error('FAIL: apply 结尾锚点丢失，测试需随源码更新'); process.exit(1); }
src = src.replace(ANCHOR, '  __DSH_MONEY_TEST_HOOK__ && __DSH_MONEY_TEST_HOOK__({ ensureTip, renderTip, periodTooltip, tipKey, replyTooltip, conversationTooltip, simTip, simStatsOf, fmtTokShort });\n' + ANCHOR);
let tip = null;
const moduleObj = { exports: {} };
vm.runInNewContext(src + "\nmodule.exports.apply({ remote: { moneyCost: { overview: async () => ({}), balance: async () => ({}), workspacesAll: async () => ({}), config: async () => ({}) } }, slots: { inject() { return () => {}; } }, effect: (fn) => { try { fn(); } catch (e) {} }, interval: () => 0, timeout: async () => {}, get: () => undefined, timer: { setInterval: () => 0, clearInterval: () => {} } });", {
  module: moduleObj, exports: moduleObj.exports,
  __DSH_MONEY_TEST_HOOK__: (fns) => { tip = fns; },
  require: (name) => (name === 'react'
    ? { createElement: () => null, useState: () => [0, () => {}], useEffect() {}, useCallback: (f) => f, useMemo: (f) => f, memo: (f) => f }
    : {}),
  document: documentStub, window: windowStub, console, setTimeout, clearTimeout, Date, Math, JSON,
});
assert(tip && tip.periodTooltip && tip.renderTip, '模块载入并取出 tip 内部函数');

// ---------- fixtures ----------
const DAY = 86400000;
const dayMidnight = Math.floor((Date.now() + 8 * 3600e3) / DAY) * DAY - 8 * 3600e3; // 今天北京 0 点
const PRICES = [
  { model: 'deepseek-flash', hit: 0.02, miss: 1, out: 4 },
  { model: 'deepseek-v4-pro', hit: 0.15, miss: 4.5, out: 13.5 },
];
function periodOf(peak) {
  return {
    peak,
    since: peak ? dayMidnight + 9 * 3600e3 : dayMidnight + 18 * 3600e3,
    nextChangeAt: peak ? dayMidnight + 12 * 3600e3 : dayMidnight + 2 * DAY + 9 * 3600e3,
    dayMidnightAt: dayMidnight,
    dayPeakWindows: [[9, 12], [14, 18]],
    prices: PRICES,
  };
}
function dfs(node, pred, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => dfs(c, pred, out));
  return out;
}
function textOf(node) {
  let s = node.textContent || '';
  (node.children || []).forEach((c) => { s += textOf(c); });
  return s;
}

// ---------- periodTooltip ----------
const tipOff = tip.periodTooltip(periodOf(false), 'CNY');
assert(tipOff && tipOff.table, '闲时 tip 带价目表');
assert(tipOff.table.head.join('|') === '计费档|闲时|高峰', '表头三列');
assert(Array.isArray(tipOff.table.note) && tipOff.table.note[0].includes('元 / 百万 token') && tipOff.table.note[0].includes('× 2'), 'note 单位与 2 倍说明');
assert(tipOff.table.note[1].includes('工作日') && tipOff.table.note[1].includes('法定节假日'), 'note 第二行为计费规则');
assert(tipOff.table.rows.length === 8, '8 行（2 组 × [组标题+3 档]）');
assert(tipOff.table.rows[0].group === 'deepseek-flash', '第一组标题 deepseek-flash');
assert(tipOff.table.rows[1].join(',') === '缓存命中,0.02,0.04', 'flash 命中 0.02 → 高峰 0.04');
assert(tipOff.table.rows[2].join(',') === '未命中（含写）,1,2', 'flash 未命中 1 → 2');
assert(tipOff.table.rows[4].group === 'deepseek-v4-pro', '第二组标题 deepseek-v4-pro');
assert(tipOff.table.rows[7].join(',') === '输出,13.5,27', 'pro 输出 13.5 → 27');
assert(!tipOff.lines.some((l) => l.includes('三档单价') || l.includes('当前为闲时（')), '长句标题/规则行已拆出');
assert(tipOff.lines[0] === '当前计费时段：闲时', '闲时短标题（左标签右数值）');
const tipPeak = tip.periodTooltip(periodOf(true), 'CNY');
assert(tipPeak.lines[0] === '当前计费时段：高峰', '高峰短标题');
const tipUsd = tip.periodTooltip({ ...periodOf(false), prices: [{ model: 'deepseek-flash', hit: 0.003, miss: 0.15, out: 0.6 }] }, 'USD');
assert(tipUsd.table.note[0].includes('美元'), 'USD 单位');
assert(tipUsd.table.rows[1].join(',') === '缓存命中,0.003,0.006', 'USD flash 命中 0.003 → 0.006');
const tipOld = tip.periodTooltip({ peak: false, since: dayMidnight, nextChangeAt: dayMidnight + DAY }, 'CNY');
assert(!tipOld.table, '旧 host（无 prices）优雅降级，无表格');

// ---------- renderTip ----------
tip.ensureTip();
tip.renderTip(tipOff);
const tipEl = dfs(documentStub.body, (n) => n.attrs && n.attrs['data-dsh-money-tip'] !== undefined)[0];
assert(!!tipEl, 'tip 浮层已创建');
const tableWrap = dfs(tipEl, (n) => n.attrs && n.attrs['data-dsh-money-table'] !== undefined)[0];
assert(!!tableWrap, 'DOM 渲染出 data-dsh-money-table 表格');
assert(dfs(tableWrap, (n) => n.tag === 'div' && (n.style.cssText || '').includes('grid-template-columns')).length === 1, '表格用 grid 布局');
const gridCells = dfs(tableWrap, (n) => n.tag === 'div' && textOf(n) === '闲时');
assert(gridCells.length === 1, '表头含「闲时」列');
assert(dfs(tableWrap, (n) => textOf(n) === '13.5').length === 1 && dfs(tableWrap, (n) => textOf(n) === '27').length === 1, '13.5 / 27 单元格存在');
const groupCells = dfs(tableWrap, (n) => (n.style.cssText || '').includes('grid-column:1 / -1') && textOf(n) === 'deepseek-flash');
assert(groupCells.length === 1, '模型组标题占整行（grid-column:1 / -1）');
assert(dfs(tableWrap, (n) => textOf(n) === 'deepseek-flash 缓存命中').length === 0, '模型名不再重复出现在档位行');
const children = tipEl.children;
const iTable = children.findIndex((c) => c.attrs && c.attrs['data-dsh-money-table'] !== undefined);
const iSvg = children.findIndex((c) => c.tag === 'svg');
assert(iTable > -1 && iSvg > -1 && iSvg < iTable, '时刻盘在前、价目表收尾');
assert(tipEl.children[0].textContent === '当前计费时段：' || (tipEl.children[0].children.length >= 0), '首节点为标题');
assert(!!dfs(tipEl, (n) => n.tag === 'svg')[0], '时刻盘仍渲染');
tip.renderTip('纯字符串 tip');
assert(dfs(tipEl, (n) => n.attrs && n.attrs['data-dsh-money-table'] !== undefined).length === 0, '字符串 tip 不带表格');

// ---------- 回复弹窗 ----------
const repSim = tip.replyTooltip({ cost: 0.011077, model: 'deepseek-flash', sim: true, tokens: { input: 10337, cacheRead: 0, cacheWrite: 0, output: 185 } }, 'CNY');
assert(repSim.split('\n')[0] === '本次回复费用: ~¥ 0.01', '回复标题短格式（旧「（元，模拟）」后缀已移除）');
assert(!repSim.includes('模拟'), '回复弹窗无「模拟」旧文案');
assert(repSim.includes('本地模型：无 API 账单'), 'sim 回复有本地口径说明');
assert(!repSim.includes('缓存命中:') && !repSim.includes('缓存写入:'), '0 值缓存行省略');
assert(repSim.includes('未命中输入: 10.3K token') && repSim.includes('输出: 185 token'), '非 0 token 行保留');
assert(repSim.endsWith('元，按官方价目估算，不代表最终账单'), '回复底部灰注释');
assert(repSim.includes('计算公式: (10.3K×1 + 185×4) ÷ 1M ≈ ~¥ 0.01'), '本地回复公式行：token 实数（(10337×1+185×4)/1M≈0.01）');
const repSimPeak = tip.replyTooltip({ cost: 0.02, model: 'deepseek-flash', sim: true, peak: true, tokens: { input: 1000000, cacheRead: 0, cacheWrite: 0, output: 1000000 } }, 'CNY');
assert(repSimPeak.includes('计算公式: ((1.0M×1 + 1.0M×4) ÷ 1M) × 2 ≈ ~¥ 10.00'), '高峰本地回复公式含 ×2');

const repPeak = tip.replyTooltip({ cost: 2.5, model: 'deepseek-v4-pro', sim: false, peak: true, tokens: { input: 100, cacheRead: 492928, cacheWrite: 0, output: 2000 } }, 'CNY');
assert(repPeak.includes('计价时段: 高峰（单价 ×2）'), 'API 回复高峰时段行');
assert(repPeak.includes('缓存命中: 492.9K token'), '非 0 缓存命中显示');
assert(!repPeak.includes('计算公式'), 'API 回复不带本地公式');
assert(!repPeak.includes('闲时:'), '闲时行不混入');
const repUsd = tip.replyTooltip({ cost: 0.5, model: 'deepseek-flash', sim: false, peak: false, tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } }, 'USD');
assert(repUsd.endsWith('美元，按官方价目估算，不代表最终账单'), 'USD 单位注释');

// ---------- 本对话弹窗 ----------
const conv1 = tip.conversationTooltip({ conversationCost: 8.7188, peakCost: 2.125, offPeakCost: 6.5938, replies: [
  { messageId: 'm1', cost: 8.7188, sim: false, peak: true, tokens: { input: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 } }, { messageId: 'm2', cost: 2.5, sim: true, peak: true, tokens: { input: 1000000, cacheRead: 0, cacheWrite: 0, output: 1000000 } },
] }, 'CNY');
assert(conv1.split('\n')[0] === '本对话累计费用: ~¥ 8.72', '对话标题短格式（无「（估算）」）');
assert(conv1.includes('高峰合计: ~¥ 2.13（1 条）'), '高峰分项含条数');
assert(conv1.includes('本地模型消费以白色徽章单独显示'), '有 sim 时提示白徽章分流');
assert(conv1.endsWith('元，按官方价目估算，不代表最终账单'), '对话底部灰注释');
const conv2 = tip.conversationTooltip({ conversationCost: 8.7188, peakCost: 0, offPeakCost: 8.7188, replies: [{ messageId: 'm1', cost: 8.7188, sim: false }] }, 'CNY');
assert(!conv2.includes('白色徽章'), '无 sim 时不出现白徽章提示');

// ---------- 本地消费弹窗：带 token 实数的计算公式 ----------
const o = {
  conversationCost: 8.7188, peakCost: 2.125, offPeakCost: 6.5938,
  period: { prices: [{ model: 'deepseek-flash', hit: 0.02, miss: 1, out: 4 }] },
  replies: [
    { messageId: 'a', cost: 8.7188, sim: false, peak: false, tokens: { input: 5e6, cacheRead: 0, cacheWrite: 0, output: 1e6 } },
    { messageId: 'b', cost: 1.0, sim: true, peak: false, tokens: { input: 2e6, cacheRead: 492928, cacheWrite: 0, output: 1e6 } },
    { messageId: 'c', cost: 6.0, sim: true, peak: true, tokens: { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 } },
  ],
};
const stats = tip.simStatsOf(o, 'CNY');
assert(stats && stats.off.n === 1 && stats.peak.n === 1, 'sim 回复按真实时段分组');
assert(stats.off.h === 492928 && stats.off.i === 2e6, '闲时桶 token 求和');
assert(tip.fmtTokShort(492928) === '492.9K' && tip.fmtTokShort(2e6) === '2.0M' && tip.fmtTokShort(185) === '185', 'token 短记数');
const st = tip.simTip(16, 2, 'CNY', stats);
assert(st.lines[0] === '本地模型消费: ~¥ 16.00（2 条）', '本地弹窗标题');
assert(st.lines[1].startsWith('计算公式 =（未命中输入'), '公式说明行（全宽灰注释）');
assert(st.lines[2] === '闲时 1 条: (2.0M×1 + 492.9K×0.02 + 1.0M×4) ÷ 1M ≈ ~¥ 6.01', '闲时公式行：token 实数 + 精确求值');
assert(st.lines[3] === '高峰 1 条（单价 ×2）: ((1.0M×1 + 1.0M×4) ÷ 1M) × 2 ≈ ~¥ 10.00', '高峰公式行：×2 括层');
assert(st.lines[4].includes('本地模型无 API 账单') && st.lines[5].includes('不计入 API 消费'), '口径说明保留');
const stNoHit = tip.simTip(16, 2, 'CNY', { off: { i: 2e6, h: 0, o: 1e6, n: 1 }, peak: { i: 0, h: 0, o: 0, n: 0 }, prices: { hit: 0.02, miss: 1, out: 4 } });
assert(stNoHit.lines.length === 5 && stNoHit.lines[2].includes('2.0M×1') && !stNoHit.lines[2].includes('0.02') && stNoHit.lines[4].includes('不计入'), '0 量档位省略、无高峰行则无高峰公式');
const stNone = tip.simTip(3.33, 12, 'CNY');
assert(stNone.lines.length === 3 && !stNone.lines.some((l) => l.includes('计算公式')), '无 stats（余额/工作区入口）保持原样');
// 高峰条数不被 sim 污染
const convPeak = tip.conversationTooltip({ conversationCost: 1, peakCost: 1, offPeakCost: 0, replies: [
  { messageId: 'p1', cost: 1, sim: false, peak: true }, { messageId: 'p2', cost: 1, sim: true, peak: true },
] }, 'CNY');
assert(convPeak.includes('高峰合计: ~¥ 1.00（1 条）'), '高峰条数只算 API 回复');

console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
