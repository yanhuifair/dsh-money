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
src = src.replace(ANCHOR, '  __DSH_MONEY_TEST_HOOK__ && __DSH_MONEY_TEST_HOOK__({ ensureTip, renderTip, periodTooltip, tipKey });\n' + ANCHOR);
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
assert(tipOff.table.note.includes('元 / 百万 token') && tipOff.table.note.includes('2 倍'), 'note 单位与 2 倍说明');
assert(tipOff.table.rows.length === 6, '6 行（2 模型 × 3 档）');
assert(tipOff.table.rows[0].join(',') === 'deepseek-flash 缓存命中,0.02,0.04', 'flash 命中 0.02 → 高峰 0.04');
assert(tipOff.table.rows[1].join(',') === 'deepseek-flash 未命中（含写）,1,2', 'flash 未命中 1 → 2');
assert(tipOff.table.rows[5].join(',') === 'deepseek-v4-pro 输出,13.5,27', 'pro 输出 13.5 → 27');
assert(!tipOff.lines.some((l) => l.includes('三档单价')), '原「三档单价」行已由表格取代');
assert(tipOff.lines[0].includes('闲时'), '闲时标题');
const tipPeak = tip.periodTooltip(periodOf(true), 'CNY');
assert(tipPeak.lines[0].includes('高峰'), '高峰标题');
const tipUsd = tip.periodTooltip({ ...periodOf(false), prices: [{ model: 'deepseek-flash', hit: 0.003, miss: 0.15, out: 0.6 }] }, 'USD');
assert(tipUsd.table.note.includes('美元'), 'USD 单位');
assert(tipUsd.table.rows[0].join(',') === 'deepseek-flash 缓存命中,0.003,0.006', 'USD flash 命中 0.003 → 0.006');
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
const children = tipEl.children;
const iTable = children.findIndex((c) => c.attrs && c.attrs['data-dsh-money-table'] !== undefined);
const iSvg = children.findIndex((c) => c.tag === 'svg');
assert(iTable > -1 && iSvg > -1 && iTable < iSvg, '表格渲染在时刻盘之前');
assert(!!dfs(tipEl, (n) => n.tag === 'svg')[0], '时刻盘仍渲染');
tip.renderTip('纯字符串 tip');
assert(dfs(tipEl, (n) => n.attrs && n.attrs['data-dsh-money-table'] !== undefined).length === 0, '字符串 tip 不带表格');

console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
