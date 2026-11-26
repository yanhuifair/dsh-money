/**
 * dsh-money — Client 半段（静态插件版，__ModuleLoader__ bundle 入口，适配 DSH 0.2.x）
 *
 * UI（全部走 Slot 注册，不再依赖已移除的 data-slot DOM 锚点）：
 *  - conversation.composer.dock：输入区下方统计行（本对话费用，金色徽章）
 *  - conversation.chat.assistant-actions：每条回复费用标签（点击弹明细）
 *  - settings.general.item：费用显示货币设置行
 *  - sidebar.footer.action：侧边栏底部余额徽章（设置按钮旁）
 *  - 侧边栏工作区行：按 data-row-key="workspace:<id>" 注入工作区总费用徽章
 *    （DSH 0.2.x 没有工作区行 Slot，只能用稳定的行标识做 DOM 注入，失败时静默降级）
 *
 * 与动态插件差异：无全局 host/styles/React；经 ctx.remote.moneyCost.* 调 Host，
 * React 由 require('react') 引入。
 *
 * 注意：本文件不直接声明 remote.moneyCost 依赖 —— 该命名空间由打包入口
 * client.entry.js 在 apply() 中先 ctx.remote.$mount(TYPERT_REMOTE) 挂载，
 * 挂载完成后此处 ctx.remote.moneyCost 才可用（inject 列表仅声明 remote）。
 *
 * 防卡死：MutationObserver 注入徽章时先 disconnect 再写 DOM、写毕重新 observe。
 */

const React = require('react');

/** 依赖注入：slots 槽位注册、remote 命名空间、timer 定时器（moneyCost 由入口挂载） */
const inject = ['slots', 'remote', 'timer'];

/**
 * 跨 apply / 跨模块实例的注册去重表：client 半段可能被多次 apply（热重载、
 * 插件开关、ctx.inject 回调重入），而 slot id 与全局监听器是进程级唯一资源。
 * 挂在 globalThis 上，模块被重新求值也不会丢失；卸载时由 cleanup 复位，允许再次注册。
 */
const REG = (function () {
  const host = typeof globalThis !== 'undefined' ? globalThis : {};
  const key = '__dshMoneyClientRegistry';
  return host[key] || (host[key] = { slots: new Set(), started: false });
})();

function apply(ctx) {
  const remote = ctx && ctx.remote ? ctx.remote.moneyCost : null;
  if (!remote) return;

  const bySession = new Map();
  // 会话 replies 的 messageId → reply 索引（数据到达时构建一次，组件 O(1) 查找）
  const replyIndex = new Map();
  const listeners = new Set();
  const inflight = new Map();

  // 余额（侧边栏底部件共享状态：只请求一次，订阅者重渲染）
  const balanceListeners = new Set();
  let balance = null;
  let balancePeriod = null;
  let balanceLoaded = false;
  let balanceInflight = false;
  let periodTimer = null;
  /** 最近一次 overview 携带的 API 价目表（单条回复公式的 Flash 单价来源） */
  let lastPrices = null;

  let currencySetting = 'auto';
  const currencyListeners = new Set();
  function setCurrency(value) {
    currencySetting = value;
    for (const fn of Array.from(currencyListeners)) {
      try { fn(value); } catch (e) {}
    }
  }
  function subscribeCurrency(fn) {
    currencyListeners.add(fn);
    return () => currencyListeners.delete(fn);
  }

  // ---- 显示设置（localStorage 持久化，重启不丢；host 无公开 KV 存储 API）----
  let showBalanceSetting = true;
  const showBalanceListeners = new Set();
  function setShowBalance(value) {
    showBalanceSetting = value !== false;
    for (const fn of Array.from(showBalanceListeners)) {
      try { fn(showBalanceSetting); } catch (e) {}
    }
  }
  function subscribeShowBalance(fn) {
    showBalanceListeners.add(fn);
    return () => showBalanceListeners.delete(fn);
  }
  function lsGet(key) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch (e) {}
  }
  /** 启动时恢复上次的显示设置；币种还需推送 host，保持 host 计价口径与显示一致 */
  function loadUiSettings() {
    const saved = lsGet('dsh-money.currency');
    if (saved === 'CNY' || saved === 'USD') {
      setCurrency(saved);
      remote.config({ currency: saved }).catch(() => {});
    }
    if (lsGet('dsh-money.show-balance') === 'false') setShowBalance(false);
  }

  function notify(sessionId) {
    for (const fn of Array.from(listeners)) {
      try { fn(sessionId); } catch (e) {}
    }
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function getOverview(sessionId) {
    return bySession.get(sessionId);
  }
  function getReply(sessionId, messageId) {
    const idx = replyIndex.get(sessionId);
    return idx ? (idx.get(messageId) || null) : null;
  }
  function refresh(sessionId) {
    if (!sessionId || inflight.has(sessionId)) return;
    inflight.set(sessionId, true);
    remote.overview({ sessionId })
      .then((res) => {
        // RemoteResult：{ok:true,value} | {ok:false,error}
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object' && !value.error) {
          bySession.set(sessionId, value);
          if (value.period && Array.isArray(value.period.prices)) lastPrices = value.period.prices;
          // 预建 messageId 索引，避免每条回复渲染时线性遍历全部 replies
          const idx = new Map();
          if (Array.isArray(value.replies)) {
            for (const r of value.replies) {
              if (r && r.messageId != null) idx.set(r.messageId, r);
            }
          }
          replyIndex.set(sessionId, idx);
          notify(sessionId);
        }
      })
      .catch(() => {})
      .finally(() => { inflight.delete(sessionId); });
  }

  const GOLD = '#f0c11d';
  // 本地模型模拟徽章：独立于 API 计费徽章，白字，放 API 徽章右侧
  const simBadgeStyle = { color: 'var(--dsw-alias-label-primary,#f5f5f5)' };
  /** 单位与估算口径的灰色注释行（无冒号，全宽展示） */
  function moneyUnitNote(currency) {
    return (currency === 'USD' ? '美元' : '元') + '，按官方价目估算，不代表最终账单';
  }

  function simTip(total, count, currency, stats) {
    const lines = ['本地模型消费: ' + fmtMoney(total, currency) + (count > 0 ? '（' + count + ' 条）' : '')];
    if (stats && stats.prices) {
      // 公式说明行不含冒号 → 全宽灰注释；数值行按闲时/高峰分组，与逐条模拟口径一致
      lines.push('计算公式 =（未命中输入 × 未命中价 + 缓存命中 × 命中价 + 输出 × 输出价）÷ 1,000,000');
      const off = stats.off && stats.off.n ? simFormulaLine('闲时', stats.off, stats.prices, currency, false) : null;
      const pk = stats.peak && stats.peak.n ? simFormulaLine('高峰', stats.peak, stats.prices, currency, true) : null;
      if (off) lines.push(off);
      if (pk) lines.push(pk);
    }
    lines.push('本地模型无 API 账单，此金额按 DeepSeek API 规则（Flash 档，高峰 ×2）估算');
    lines.push('仅展示参考，不计入 API 消费、不从余额扣除');
    return { lines: lines };
  }

  /** token 短记数（公式内用，不带单位后缀）：2,000,000 → 2.0M */
  function fmtTokShort(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  /** Flash 基准单价：host 价目表优先，退回到内置口径 */
  function flashPrices(pricesArr, currency) {
    const ps = Array.isArray(pricesArr) ? pricesArr.find((t) => t && t.model === 'deepseek-flash') : null;
    return ps || (currency === 'USD' ? { hit: 0.003, miss: 0.15, out: 0.6 } : { hit: 0.02, miss: 1, out: 4 });
  }

  /** 公式演算：token 三项 × Flash 单价（高峰外层再乘 2）；0 量档位省略 */
  function formulaExpr(i, h, o, p, times2) {
    const u = (v) => String(parseFloat(Number(v).toFixed(6)));
    const terms = [];
    if (i > 0) terms.push(fmtTokShort(i) + '×' + u(p.miss));
    if (h > 0) terms.push(fmtTokShort(h) + '×' + u(p.hit));
    if (o > 0) terms.push(fmtTokShort(o) + '×' + u(p.out));
    if (!terms.length) return null;
    let expr = '(' + terms.join(' + ') + ') ÷ 1M';
    let val = (i * p.miss + h * p.hit + o * p.out) / 1e6;
    if (times2) { expr = '(' + expr + ') × 2'; val *= 2; }
    return { expr: expr, val: val };
  }

  /** 公式数值行：如「闲时 9 条: (22.1M×1 + 492.9K×0.02 + 8.2M×4) ÷ 1M ≈ ~¥ 1.87」 */
  function simFormulaLine(label, b, p, currency, times2) {
    const f = formulaExpr(b.i, b.h, b.o, p, times2);
    if (!f) return null;
    const nLabel = label + ' ' + b.n + ' 条' + (times2 ? '（单价 ×2）' : '');
    return nLabel + ': ' + f.expr + ' ≈ ' + fmtMoney(f.val, currency);
  }

  /** 汇总 sim 回复的 token（按真实时段分组）；未命中价按含 cache write 口径 */
  function simStatsOf(o, currency) {
    const replies = Array.isArray(o && o.replies) ? o.replies : [];
    const g = { off: { i: 0, h: 0, o: 0, n: 0 }, peak: { i: 0, h: 0, o: 0, n: 0 } };
    for (const r of replies) {
      if (!r || !r.sim || !r.tokens) continue;
      const b = r.peak ? g.peak : g.off;
      b.i += (r.tokens.input || 0) + (r.tokens.cacheWrite || 0);
      b.h += r.tokens.cacheRead || 0;
      b.o += r.tokens.output || 0;
      b.n += 1;
    }
    if (!g.off.n && !g.peak.n) return null;
    return { off: g.off, peak: g.peak, prices: flashPrices(o && o.period ? o.period.prices : null, currency) };
  }
  const badgeStyle = {
    color: GOLD,
    fontSize: '11px',
    padding: '5px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))',
    lineHeight: '11px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };

  // 时段徽章：高峰用暖色、闲时用绿色，与金色的金额徽章区分
  function periodBadgeStyle(peak) {
    return {
      ...badgeStyle,
      color: peak ? '#ff8f1f' : '#3fb950',
      background: peak ? 'rgba(255,143,31,0.12)' : 'rgba(63,185,80,0.12)',
    };
  }

  // ---- 自绘点击弹出细节 ----
  // DSH 桌面端不显示原生 title 提示；徽章点击后用自绘的单例浮层弹出多行细节，
  // 再次点击同一徽章 / 点击其它位置 / Esc 收起；滚动与窗口缩放时跟随重定位。
  // React 徽章与 DOM 注入徽章共用。
  let tipEl = null;
  let tipText = '';
  let tipAnchor = null;

  function ensureTip() {
    if (tipEl || typeof document === 'undefined') return tipEl;
    tipEl = document.createElement('div');
    tipEl.setAttribute('data-dsh-money-tip', '');
    // 与原生「点击弹出窗」（上下文/用量详情面板）同款：
    // menu 表面 + 毛玻璃 + radius-lg + elevation-prominent 描边阴影，正文 12px/18px label-secondary
    tipEl.style.cssText = [
      'position:fixed',
      'z-index:1100',
      'box-sizing:border-box',
      'width:max-content',
      'min-width:min(300px,calc(100vw - 24px))',
      'max-width:min(600px,calc(100vw - 24px))',
      'max-height:calc(100vh - 24px)',
      'overflow:hidden auto',
      'padding:16px',
      'border:0',
      'border-radius:var(--dsw-radius-lg,16px)',
      'background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,rgba(37,42,52,0.9)))',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%))',
      '-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%))',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(128,128,128,0.2))',
      'box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px var(--dsw-alias-border-l1,rgba(128,128,128,0.2)),0 3px 8px rgba(0,0,0,0.04),0 0 20px rgba(0,0,0,0.05))',
      'color:var(--dsw-alias-label-secondary,#a0a0a8)',
      'font-size:12px',
      'line-height:18px',
      'font-variant-numeric:tabular-nums',
      'user-select:text',
      '-webkit-app-region:no-drag',
      'display:none',
    ].join(';');
    try { document.body.appendChild(tipEl); } catch (e) { tipEl = null; }
    return tipEl;
  }

  /** 图表数值：统一两位小数（显示口径） */
  function fmtChartValue(cost) {
    return (Number.isFinite(cost) ? cost : 0).toFixed(2);
  }

  /** 近 7 天柱状图：金色柱、底部细基线、上数值下日期（原生弹窗内嵌图表风格） */
  function renderChart(el, chart) {
    const cur = chart.currency || 'CNY';
    const head = document.createElement('div');
    head.setAttribute('data-dsh-money-chart', '');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-top:12px;';
    const hl = document.createElement('span');
    hl.style.cssText = 'color:var(--dsw-alias-label-secondary,#a0a0a8);';
    hl.textContent = chart.title || '最近 7 天（估算）';
    const hv = document.createElement('span');
    hv.style.cssText = 'color:var(--dsw-alias-label-primary,#f5f5f5);font-variant-numeric:tabular-nums;';
    hv.textContent = fmtMoney(chart.total == null ? 0 : chart.total, cur);
    head.appendChild(hl);
    head.appendChild(hv);
    el.appendChild(head);
    // host 返回新→旧；柱状图按时间轴左旧右新渲染
    const days = (Array.isArray(chart.days) ? chart.days.slice() : []).slice(0, 7).reverse();
    if (!days.length) return;
    let max = 0;
    for (const d of days) { if (d && typeof d.cost === 'number' && d.cost > max) max = d.cost; }
    const wrap = document.createElement('div');
    wrap.setAttribute('data-dsh-money-bars', '');
    wrap.style.cssText = 'display:flex;align-items:flex-end;gap:6px;margin-top:6px;';
    for (const d of days) {
      const cost = d && typeof d.cost === 'number' ? d.cost : 0;
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0;';
      const v = document.createElement('div');
      v.style.cssText = 'color:var(--dsw-alias-label-secondary,#a0a0a8);font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;white-space:nowrap;';
      v.textContent = fmtChartValue(cost);
      const barArea = document.createElement('div');
      barArea.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;height:56px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.25));width:100%;';
      const bar = document.createElement('div');
      const h = cost > 0 ? Math.max(3, Math.round((cost / (max || 1)) * 54)) : 2;
      bar.style.cssText = 'width:16px;border-radius:3px 3px 0 0;background:'
        + (cost > 0 ? 'rgba(240,193,29,0.9)' : 'rgba(128,128,128,0.25)')
        + ';height:' + h + 'px;';
      barArea.appendChild(bar);
      const day = document.createElement('div');
      day.style.cssText = 'color:var(--dsw-alias-label-tertiary,#7a7a85);font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;';
      day.textContent = d && d.date ? d.date : '';
      col.appendChild(v);
      col.appendChild(barArea);
      col.appendChild(day);
      wrap.appendChild(col);
    }
    el.appendChild(wrap);
  }

  function spacerEl(h) {
    const sp = document.createElement('div');
    sp.style.cssText = 'height:' + h + 'px;';
    return sp;
  }

  /** 明细小表（价目对照）：注释行 + 表头三列 + 模型分组数据行；左灰标签右白色数字（原生风格） */
  function renderTable(el, table) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-dsh-money-table', '');
    wrap.style.cssText = 'margin-top:12px;';
    const notes = Array.isArray(table.note) ? table.note : (table.note ? [table.note] : []);
    for (const n of notes) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#7a7a85);';
      note.textContent = n;
      wrap.appendChild(note);
    }
    if (notes.length) wrap.appendChild(spacerEl(6));
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto auto;column-gap:18px;row-gap:3px;';
    (table.head || []).forEach(function (h, i) {
      const hd = document.createElement('div');
      hd.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#7a7a85);' + (i ? 'text-align:right;' : '');
      hd.textContent = h;
      grid.appendChild(hd);
    });
    for (const row of table.rows || []) {
      if (row && row.group) {
        const g = document.createElement('div');
        g.style.cssText = 'grid-column:1 / -1;font-weight:500;color:var(--dsw-alias-label-secondary,#a0a0a8);margin-top:6px;';
        g.textContent = row.group;
        grid.appendChild(g);
        continue;
      }
      row.forEach(function (cell, i) {
        const c = document.createElement('div');
        c.style.cssText = i
          ? 'color:var(--dsw-alias-label-primary,#f5f5f5);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;'
          : 'color:var(--dsw-alias-label-secondary,#a0a0a8);';
        c.textContent = cell;
        grid.appendChild(c);
      });
    }
    wrap.appendChild(grid);
    el.appendChild(wrap);
  }

  /** 当天时刻盘（SVG 实心饼，标准 12 小时钟面）：12 在正上方顺时针 1-11，
   *  每小时一个刻度与数字；闲时整圆绿底，高峰窗口橙色扇区，指针指向当前时刻 */
  function renderClock(el, clock) {
    const SVG = 'http://www.w3.org/2000/svg';
    const GREEN = '#3fb950';
    const ORANGE = '#ff8f1f';
    const TICK = 'var(--dsw-alias-label-tertiary,#7a7a85)';
    // 当天 0–24 小时横轴：绿轨=闲时、橙段=高峰、每小时刻度与数字、白线=当前时刻
    const X0 = 10, W = 340; // viewBox 360×46
    const X = (h) => X0 + (Math.max(0, Math.min(24, h)) / 24) * W;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('data-dsh-money-clock', '');
    svg.setAttribute('viewBox', '0 0 360 46');
    svg.style.cssText = 'display:block;width:100%;height:auto;margin:10px auto 2px;';
    const track = document.createElementNS(SVG, 'rect');
    track.setAttribute('x', String(X0)); track.setAttribute('y', '12');
    track.setAttribute('width', String(W)); track.setAttribute('height', '8');
    track.setAttribute('rx', '4'); track.setAttribute('fill', GREEN);
    svg.appendChild(track);
    const windows = Array.isArray(clock.windows) ? clock.windows.slice().sort((a, b) => a[0] - b[0]) : [];
    for (const w of windows) {
      const st = Math.max(0, Math.min(24, w[0]));
      const en = Math.max(0, Math.min(24, w[1]));
      if (en <= st) continue;
      const seg = document.createElementNS(SVG, 'rect');
      seg.setAttribute('x', X(st).toFixed(2)); seg.setAttribute('y', '12');
      seg.setAttribute('width', (X(en) - X(st)).toFixed(2)); seg.setAttribute('height', '8');
      seg.setAttribute('rx', '2'); seg.setAttribute('fill', ORANGE);
      svg.appendChild(seg);
    }
    // 每小时一个刻度 + 数字（0..24）
    for (let h = 0; h <= 24; h++) {
      const x = X(h).toFixed(2);
      const tick = document.createElementNS(SVG, 'line');
      tick.setAttribute('x1', x); tick.setAttribute('y1', '22');
      tick.setAttribute('x2', x); tick.setAttribute('y2', '26');
      tick.setAttribute('stroke', TICK); tick.setAttribute('stroke-width', '1');
      svg.appendChild(tick);
      const txt = document.createElementNS(SVG, 'text');
      txt.setAttribute('x', x); txt.setAttribute('y', '38');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('style', 'font-size:7.5px;fill:' + TICK + ';font-variant-numeric:tabular-nums;');
      txt.textContent = String(h);
      svg.appendChild(txt);
    }
    // 当前时刻竖线：颜色与当前计价状态一致（高峰橙 / 闲时绿）
    const DAY = 24 * 3600 * 1000;
    const now = typeof clock.now === 'number' ? clock.now : Date.now();
    const hour = Math.max(0, Math.min(24, (now - clock.midnight) / DAY * 24));
    const nx = X(hour).toFixed(2);
    const marker = document.createElementNS(SVG, 'line');
    marker.setAttribute('x1', nx); marker.setAttribute('y1', '7');
    marker.setAttribute('x2', nx); marker.setAttribute('y2', '25');
    marker.setAttribute('stroke', clock.peak ? '#ff8f1f' : '#3fb950');
    marker.setAttribute('stroke-width', '2');
    marker.setAttribute('stroke-linecap', 'round');
    svg.appendChild(marker);
    el.appendChild(svg);
    const caption = document.createElement('div');
    caption.style.cssText = 'text-align:center;font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary,#7a7a85);margin-bottom:2px;';
    caption.textContent = '当天 0–24 时（北京时间）：绿=闲时、橙=高峰、竖线=当前时刻（颜色随当前计费状态）';
    el.appendChild(caption);
  }

  /** 细节内容：字符串（多行文案）或 { lines, chart }；首行为标题（label-primary/500），
   *  其余按「标签: 值」渲染为原生详情网格；chart 存在时追加近 7 天柱状图 */
  function renderTip(payload) {
    const el = tipEl;
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    const spec = typeof payload === 'string' ? { lines: String(payload).split('\n') } : (payload || { lines: [] });
    el.__dshMoneyText = tipKey(payload);
    const lines = spec.lines || [];
    if (!lines.length) return;
    // 标题行：左标签右数值（原生「会话统计」弹窗同款，值 tabular-nums）
    const title = document.createElement('div');
    title.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:16px;color:var(--dsw-alias-label-primary,#f5f5f5);font-weight:500;';
    const tm = lines[0].match(/^(.{1,24}?)[:：]\s*([\s\S]+)$/);
    if (tm) {
      const tl = document.createElement('span');
      tl.textContent = tm[1];
      const tv = document.createElement('span');
      tv.style.cssText = 'font-variant-numeric:tabular-nums;white-space:nowrap;';
      if (spec.titleColor) tv.style.color = spec.titleColor;
      tv.textContent = tm[2];
      title.appendChild(tl);
      title.appendChild(tv);
    } else {
      title.textContent = lines[0];
    }
    el.appendChild(title);
    if (lines.length > 1) {
      const rule = document.createElement('div');
      rule.style.cssText = 'border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.25));margin:8px 0 10px;';
      el.appendChild(rule);
      // 明细行：左灰色标签、右白色数值（原生同款）；无标签的说明行占满整行
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:10px 16px;';
      for (const line of lines.slice(1)) {
        const m = line.match(/^(.{1,24}?)[:：]\s*([\s\S]*)$/);
        const dt = document.createElement('div');
        const dd = document.createElement('div');
        if (m) {
          dt.style.cssText = 'color:var(--dsw-alias-label-secondary,#a0a0a8);';
          dd.style.cssText = 'color:var(--dsw-alias-label-primary,#f5f5f5);text-align:right;overflow-wrap:normal;white-space:pre-line;font-variant-numeric:tabular-nums;';
          dt.textContent = m[1];
          dd.textContent = m[2];
        } else {
          dd.style.cssText = 'grid-column:1 / -1;color:var(--dsw-alias-label-secondary,#a0a0a8);white-space:pre-line;overflow-wrap:normal;';
          dd.textContent = line;
          grid.appendChild(dd);
          continue;
        }
        grid.appendChild(dt);
        grid.appendChild(dd);
      }
      el.appendChild(grid);
    }
    if (spec.clock) renderClock(el, spec.clock);
    if (spec.table) renderTable(el, spec.table);
    if (spec.chart) renderChart(el, spec.chart);
  }

  function isAttached(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return true; // DOM 桩未实现 isConnected 时按已挂载处理
  }

  /** 依据锚点徽章定位：优先贴在徽章下方，空间不足翻到上方，并夹紧到视口内 */
  function placeTip() {
    const el = tipEl;
    if (!el || !isAttached(tipAnchor) || typeof window === 'undefined') { hideTip(); return; }
    const rect = tipAnchor.getBoundingClientRect();
    const panel = el.getBoundingClientRect();
    const gap = 6;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (top + panel.height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - panel.height);
    if (left + panel.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - panel.width);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /** 浮层内容缓存键：字符串直接用，对象序列化（chart 数据小，JSON 足够廉价） */
  function tipKey(payload) {
    return typeof payload === 'string' ? payload : JSON.stringify(payload || null);
  }

  function showTip(text, anchor) {
    if (!text || !anchor) { hideTip(); return; }
    const el = ensureTip();
    if (!el) return;
    const key = tipKey(text);
    if (key !== tipText || tipAnchor !== anchor) { renderTip(text); tipText = key; }
    tipAnchor = anchor;
    el.style.display = 'block';
    placeTip();
  }

  function hideTip() {
    tipAnchor = null;
    if (!tipEl) return;
    elHide();
  }

  function elHide() {
    if (!tipEl) return;
    tipEl.style.display = 'none';
  }

  function toggleTip(text, anchor) {
    if (tipAnchor === anchor) hideTip();
    else showTip(text, anchor);
  }

  /** React 元素点击 props：点击弹出/收起细节（阻止冒泡避免触发所在行/按钮） */
  function tipProps(text) {
    return {
      role: 'button',
      tabIndex: 0,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onClick: (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        toggleTip(text, e && e.currentTarget ? e.currentTarget : e && e.target);
      },
      onKeyDown: (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
          toggleTip(text, e.currentTarget || e.target);
        }
      },
    };
  }

  // 兜底：点击浮层与锚点之外、按 Esc、滚动/缩放时收起或跟随（避免组件卸载后残留）
  function onDocPointerDown(e) {
    if (!tipAnchor || !tipEl) return;
    const target = e && e.target;
    if (target === tipEl || (tipEl.contains && tipEl.contains(target))) return;
    if (target === tipAnchor || (tipAnchor.contains && tipAnchor.contains(target))) return;
    hideTip();
  }
  function onDocKeyDown(e) {
    if (e && e.key === 'Escape') hideTip();
  }
  let reflowFrame = 0;
  function onReflow() {
    if (!tipAnchor) return;
    // 滚动/缩放事件密度高，逐事件 getBoundingClientRect 会强制回流；合并到每帧一次
    if (reflowFrame || typeof requestAnimationFrame !== 'function') {
      if (!reflowFrame) placeTip();
      return;
    }
    reflowFrame = requestAnimationFrame(() => {
      reflowFrame = 0;
      if (tipAnchor) placeTip();
    });
  }

  /** DOM 注入徽章的等价监听（一次性绑定，文案由 badge.__dshMoneyTip 提供） */
  function bindTip(badge) {
    if (badge.__dshMoneyBound) return;
    badge.__dshMoneyBound = true;
    try {
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.setAttribute('aria-haspopup', 'dialog');
      badge.setAttribute('aria-expanded', 'false');
    } catch (e) {}
    const open = (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      toggleTip(badge.__dshMoneyTip, badge);
    };
    badge.addEventListener('click', open);
    badge.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) open(e);
    });
  }

  /** 高峰徽章倒计时：距下次切换（进入闲时），格式「xx小时xx分钟」（不足 1 小时只显示分钟）；非高峰/缺数据为空 */
  function peakCountdownLabel(period, now) {
    if (!period || !period.peak) return '';
    const next = period.nextChangeAt;
    if (typeof next !== 'number' || !Number.isFinite(next)) return '';
    const mins = Math.max(0, Math.ceil((next - now) / 60000));
    if (mins <= 0) return ' 即将切换';
    if (mins < 60) return ' ' + mins + '分钟';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return ' ' + h + '小时' + (m > 0 ? m + '分钟' : '');
  }

  function periodLabel(period) {
    return period && period.peak ? '高峰' : '闲时';
  }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 详细时间：MM-DD（周X）HH:MM */
  function fmtDateTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return MM + '-' + DD + '（' + WEEKDAYS[d.getDay()] + '）' + hh + ':' + mm;
  }

  function periodTooltip(period, currency) {
    if (!period) return '计费时段未知';
    const since = fmtDateTime(period.since);
    const next = fmtDateTime(period.nextChangeAt);
    const lines = period.peak
      ? ['当前计费时段：高峰', '本次高峰：' + since + ' 起', '下次切换：' + next + ' 起为闲时']
      : ['当前计费时段：闲时', '本次闲时：' + since + ' 起', '下次切换：' + next + ' 起为高峰'];
    const out = { lines: lines.slice(), titleColor: period.peak ? '#ff8f1f' : '#3fb950' };
    // 当天时刻盘（host 1.5.2+ 提供 dayMidnightAt / dayPeakWindows）
    if (typeof period.dayMidnightAt === 'number' && Array.isArray(period.dayPeakWindows)) {
      const wins = period.dayPeakWindows;
      const two = (h) => String(h).padStart(2, '0');
      out.lines.push('今日高峰窗口：' + (wins.length ? wins.map((w) => two(w[0]) + ':00-' + two(w[1]) + ':00').join('、') : '全天闲时（周末/节假日）'));
      out.clock = { midnight: period.dayMidnightAt, windows: wins, now: Date.now(), peak: !!period.peak };
    }
    // API 单价表：闲时/高峰对照（host 1.7.1+ 提供 prices；旧 host 自动跳过）
    if (Array.isArray(period.prices) && period.prices.length) {
      const cur = currency === 'USD' ? 'USD' : 'CNY';
      const unit = cur === 'USD' ? '美元' : '元';
      const unitPrice = (v) => String(parseFloat(Number(v).toFixed(6)));
      const rows = [];
      for (const t of period.prices) {
        rows.push({ group: t.model });
        rows.push(['缓存命中', unitPrice(t.hit), unitPrice(t.hit * 2)]);
        rows.push(['未命中（含写）', unitPrice(t.miss), unitPrice(t.miss * 2)]);
        rows.push(['输出', unitPrice(t.out), unitPrice(t.out * 2)]);
      }
      out.table = {
        note: [
          'API 单价（' + unit + ' / 百万 token，高峰 = 闲时 × 2）',
          '计费规则：工作日 9:00-12:00、14:00-18:00 为高峰，周末与法定节假日全天基准价',
        ],
        head: ['计费档', '闲时', '高峰'],
        rows: rows,
      };
    }
    return out;
  }

  function moneySymbol(currency) {
    if (currency === 'CNY') return '¥ ';
    if (currency === 'USD') return '$';
    return '¥ ';
  }

  function fmtMoney(v, currency) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sym = moneySymbol(currency);
    // 显示统一两位小数（内部计算保留 8 位精度）
    return '~' + sym + v.toFixed(2);
  }
  function fmtBalance(b) {
    if (!b || b.total == null || !Number.isFinite(b.total)) return '—';
    const sym = b.currency === 'CNY' ? '¥ ' : b.currency === 'USD' ? '$' : (b.currency + ' ');
    return sym + b.total.toFixed(2);
  }
  function fmtTokens(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M token';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K token';
    return String(n) + ' token';
  }

  function replyTooltip(r, currency) {
    if (!r) return '本次回复费用';
    const lines = ['本次回复费用: ' + fmtMoney(r.cost, currency)];
    if (r.model) lines.push('模型: ' + r.model);
    lines.push('计价时段: ' + (r.peak ? '高峰（单价 ×2）' : '闲时（基准价）'));
    if (r.sim) lines.push('本地模型：无 API 账单，按 DeepSeek API 规则（Flash 档）估算，不计入 API 消费');
    if (r.tokens) {
      const t = r.tokens;
      lines.push('未命中输入: ' + fmtTokens(t.input));
      if (t.cacheRead > 0) lines.push('缓存命中: ' + fmtTokens(t.cacheRead));
      if (t.cacheWrite > 0) lines.push('缓存写入: ' + fmtTokens(t.cacheWrite));
      lines.push('输出: ' + fmtTokens(t.output));
      if (r.sim) {
        const f = formulaExpr(
          (t.input || 0) + (t.cacheWrite || 0), t.cacheRead || 0, t.output || 0,
          flashPrices(lastPrices, currency), !!r.peak,
        );
        if (f) lines.push('计算公式: ' + f.expr + ' ≈ ' + fmtMoney(f.val, currency));
      }
    }
    lines.push(moneyUnitNote(currency));
    return lines.join('\n');
  }

  /** API 计费徽章细节：本对话 API 总额 + 高峰/闲时分别合计（含条数） */
  function conversationTooltip(o, currency) {
    const lines = ['本对话累计费用: ' + fmtMoney(o.conversationCost, currency)];
    const replies = Array.isArray(o.replies) ? o.replies : [];
    let peakCount = 0;
    let simCount = 0;
    for (const r of replies) {
      if (r && r.peak && !r.sim) peakCount += 1;
      if (r && r.sim) simCount += 1;
    }
    const apiCount = replies.length - simCount;
    lines.push('高峰合计: ' + fmtMoney(o.peakCost == null ? 0 : o.peakCost, currency) + '（' + peakCount + ' 条）');
    lines.push('闲时合计: ' + fmtMoney(o.offPeakCost == null ? 0 : o.offPeakCost, currency) + '（' + Math.max(0, apiCount - peakCount) + ' 条）');
    if (simCount > 0) lines.push('本地模型消费以白色徽章单独显示，不计入此金额');
    lines.push(moneyUnitNote(currency));
    return lines.join('\n');
  }

  function simCountOf(o) {
    let n = 0;
    const replies = Array.isArray(o.replies) ? o.replies : [];
    for (const r of replies) { if (r && r.sim) n += 1; }
    return n;
  }

  // ---- 输入区下方统计行：仅本对话费用 ----
  function CostDock(props) {
    const sessionId = props.sessionId;
    const [overview, setOverview] = React.useState(undefined);
    React.useEffect(() => {
      // 只依赖 sessionId：订阅 + 刷新与对话快照变化解耦，
      // 避免流式渲染时快照高频变化导致 effect 反复重建（拖慢消息渲染）
      const apply = (sid) => { if (sid === sessionId) setOverview(getOverview(sid)); };
      const unsub = subscribe(apply);
      refresh(sessionId);
      const dispose = ctx.interval(() => refresh(sessionId), 30000);
      return () => { unsub(); dispose(); };
    }, [sessionId]);
    const o = overview || {};
    const currency = o.currency || 'CNY';
    const simCost = typeof o.simCost === 'number' ? o.simCost : 0;
    return React.createElement('div', {
      style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '11px', opacity: 0.85, padding: '2px 0', whiteSpace: 'nowrap' },
    },
      o.conversationCost != null
        ? React.createElement('span', {
          key: 'conv',
          'aria-label': '本对话累计费用（估算）',
          ...tipProps(conversationTooltip(o, currency)),
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
        },
          '本对话 ',
          React.createElement('span', { style: badgeStyle }, fmtMoney(o.conversationCost, currency)),
        )
        : null,
      simCost > 0
        ? React.createElement('span', {
          key: 'conv-sim',
          'aria-label': '本对话本地模型消费',
          ...tipProps(simTip(simCost, simCountOf(o), currency, simStatsOf(o, currency))),
          style: { ...badgeStyle, ...simBadgeStyle },
        }, '本地 ' + fmtMoney(simCost, currency))
        : null,
    );
  }

  // ---- 每条回复的费用标签（操作按钮行内）----
  // 性能：不独立请求/订阅（历史回复可能成百上千条，逐个请求+订阅会拖慢打开对话）。
  // 改为读取共享快照：由 CostDock 统一 refresh，数据到达后通过 notify 驱动本组件重渲染。
  function ReplyCost(props) {
    const sessionId = props.sessionId;
    const messageId = props.messageId;
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
      // 订阅共享数据更新（廉价：一个 setState 计数，不发起请求）
      const apply = (sid) => { if (sid === sessionId) setTick((t) => t + 1); };
      const unsub = subscribe(apply);
      return () => unsub();
    }, [sessionId]);
    const overview = getOverview(sessionId);
    if (!overview) return null;
    const reply = getReply(sessionId, messageId);
    const currency = typeof overview.currency === 'string' ? overview.currency : 'CNY';
    if (!reply || reply.cost == null) return null;
    return React.createElement('span', {
      className: 'dsh-cost-reply',
      'aria-label': reply.sim ? '本次回复本地模型费用' : '本次回复费用（估算）',
      ...tipProps(replyTooltip(reply, currency)),
      style: { ...badgeStyle, ...(reply.sim ? simBadgeStyle : null), marginLeft: '4px', marginRight: '2px' },
    }, (reply.sim ? '本地 ' : '') + fmtMoney(reply.cost, currency));
  }

  // ---- 侧边栏底部余额（sidebar.footer.action Slot）----
  function loadBalance() {
    if (balanceInflight) return;
    balanceInflight = true;
    remote.balance()
      .then((res) => {
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object' && !value.error) {
          balance = value.balance || null;
          if (value.period && typeof value.period.peak === 'boolean') balancePeriod = value.period;
          balanceLoaded = true;
          for (const fn of Array.from(balanceListeners)) {
            try { fn(balance); } catch (e) {}
          }
          schedulePeriodRefresh();
        }
      })
      .catch(() => {})
      .finally(() => { balanceInflight = false; });
  }

  // 在时段切换点后刷新一次，避免 60s 轮询跨过边界时状态滞后
  function schedulePeriodRefresh() {
    if (periodTimer) { clearTimeout(periodTimer); periodTimer = null; }
    if (!balancePeriod || typeof balancePeriod.nextChangeAt !== 'number') return;
    const delay = balancePeriod.nextChangeAt - Date.now() + 500;
    if (!Number.isFinite(delay) || delay < 1000 || delay > 12 * 3600 * 1000) return;
    periodTimer = setTimeout(() => { periodTimer = null; loadBalance(); }, delay);
  }

  function BalanceAction(props) {
    const [, force] = React.useState(0);
    const [visible, setVisible] = React.useState(showBalanceSetting);
    React.useEffect(() => {
      const fn = () => force((n) => n + 1);
      balanceListeners.add(fn);
      const unsubShow = subscribeShowBalance(setVisible);
      if (!balanceLoaded) loadBalance();
      if (!wsTable) loadWsTable();
      return () => { balanceListeners.delete(fn); unsubShow(); };
    }, []);
    if (!visible || !balanceLoaded) return null;
    const wide = !(props && props.wide === false);
    const amount = fmtBalance(balance);
    const tipLines = ['账号剩余金额: ' + amount];
    if (balance && balance.source === 'api-key') tipLines.push('来源: API Key 余额');
    tipLines.push('余额为实际值，每 60 秒自动刷新');
    let tip;
    if (wsDays && wsDays.length) {
      tipLines.push('最近 7 天按北京时间自然日估算，不含本地模型消费');
      const cur = wsTable && wsTable.currency ? wsTable.currency : 'CNY';
      let week = 0;
      for (const d of wsDays) { if (d && typeof d.cost === 'number') week += d.cost; }
      tip = { lines: tipLines, chart: { total: week, currency: cur, days: wsDays } };
    } else {
      tip = tipLines.join('\n');
    }
    if (!wide) {
      // 56px 折叠态：只显示币种符号，避免挤压设置按钮
      const sym = balance && balance.currency === 'USD' ? '$' : '¥';
      return React.createElement('span', { 'aria-label': '账号剩余金额', ...tipProps(tip), style: { ...badgeStyle, fontSize: '10px', padding: '4px', lineHeight: '10px' } }, sym);
    }
    const money = React.createElement('span', { key: 'money', 'aria-label': '账号剩余金额', ...tipProps(tip), style: badgeStyle }, '余额 ' + amount);
    // 本地模型模拟消费徽章（白色）：汇总各工作区 simCost，点击看说明
    let simTotal = 0;
    if (wsTable && Array.isArray(wsTable.workspaces)) {
      for (const w of wsTable.workspaces) { if (w && typeof w.simCost === 'number') simTotal += w.simCost; }
      // 已删除会话保留的本地费用也计入总账（钱已花出去）
      if (typeof wsTable.retainedSimCost === 'number') simTotal += wsTable.retainedSimCost;
    }
    const simCur = wsTable && wsTable.currency ? wsTable.currency : 'CNY';
    let simTip = { lines: [
      '本地模型消费: ' + fmtMoney(simTotal, simCur),
      '本地模型无 API 账单，此金额按 DeepSeek API 规则（Flash 档，高峰 ×2）估算',
      '仅展示参考，不计入 API 消费、不从余额扣除',
    ] };
    if (wsSimDays && wsSimDays.length) {
      let simWeek = 0;
      for (const d of wsSimDays) { if (d && typeof d.cost === 'number') simWeek += d.cost; }
      simTip = { lines: simTip.lines, chart: { total: simWeek, currency: simCur, days: wsSimDays, title: '最近 7 天本地（估算）' } };
    }
    const simBadge = simTotal > 0
      ? React.createElement('span', {
        key: 'sim',
        'aria-label': '本地模型消费',
        ...tipProps(simTip),
        style: { ...badgeStyle, ...simBadgeStyle },
      }, '本地 ' + fmtMoney(simTotal, simCur))
      : null;
    const period = balancePeriod
      ? React.createElement('span', {
        key: 'period',
        'aria-label': periodLabel(balancePeriod) + '时段' + peakCountdownLabel(balancePeriod, Date.now()),
        ...tipProps(periodTooltip(balancePeriod, wsTable && wsTable.currency ? wsTable.currency : 'CNY')),
        style: periodBadgeStyle(balancePeriod.peak),
      }, periodLabel(balancePeriod) + peakCountdownLabel(balancePeriod, Date.now()))
      : null;
    // 两行排版：第一行金额徽章，第二行计价时段徽章（含倒计时），互不挤压
    return React.createElement('span', {
      style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '3px' },
    },
      React.createElement('span', { key: 'row-amounts', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, money, simBadge),
      period);
  }

  // ---- 侧边栏工作区行费用（DOM 注入：0.2.x 无工作区行 Slot）----
  let observer = null;
  let applying = false;
  let wsTable = null;
  let wsDays = null; // 最近 7 天消费（host workspacesAll 顺路返回）
  let wsSimDays = null; // 最近 7 天本地模型模拟费用（同一返回的 simDays）

  /** 工作区费用表加载：远程失败/未就绪（reject 或 ok:false）时短退避重试，
   *  否则重启 DSH 后首帧拉取失败要空等 60 秒轮询——期间本地总花费徽章缺失 */
  let wsRetry = 0;
  let wsRetryTimer = null;
  function scheduleWsRetry() {
    if (wsTable || wsRetry >= 5 || wsRetryTimer) return;
    wsRetry += 1;
    wsRetryTimer = setTimeout(() => { wsRetryTimer = null; loadWsTable(); }, 2000 * wsRetry);
  }
  function loadWsTable() {
    remote.workspacesAll()
      .then((res) => {
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object' && !value.error) {
          wsTable = value;
          wsRetry = 0;
          wsDays = Array.isArray(value.days) ? value.days : null;
          wsSimDays = Array.isArray(value.simDays) ? value.simDays : null;
          // 让余额弹窗能用上近 7 天数据：驱动 BalanceAction 重渲染
          for (const fn of Array.from(balanceListeners)) { try { fn(balance); } catch (e) {} }
          applyBadges();
        } else {
          scheduleWsRetry();
        }
      })
      .catch(() => { scheduleWsRetry(); });
  }

  function applyBadges() {
    if (applying) return;
    applying = true;
    if (observer) { try { observer.disconnect(); } catch (e) {} }
    try {
      if (typeof document === 'undefined' || !wsTable || !Array.isArray(wsTable.workspaces)) return;
      const byId = new Map();
      for (const entry of wsTable.workspaces) {
        if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
      }
      const rows = document.querySelectorAll('[data-row-key^="workspace:"]');
      for (const row of rows) {
        const key = row.getAttribute('data-row-key') || '';
        const id = key.slice('workspace:'.length);
        const entry = byId.get(id);
        const sim = entry && typeof entry.simCost === 'number' && entry.simCost > 0 ? entry.simCost : 0;
        // API 计费徽章（金色）：仅在有 API 费用时显示
        let badge = row.querySelector('.dsh-money-ws-badge');
        const text = entry && entry.cost != null ? fmtMoney(entry.cost, wsTable.currency) : null;
        const tip = text == null ? null
          : '工作区 API 费用: ' + text
            + '\n高峰合计: ' + fmtMoney(entry.peakCost == null ? 0 : entry.peakCost, wsTable.currency)
            + '\n闲时合计: ' + fmtMoney(entry.offPeakCost == null ? 0 : entry.offPeakCost, wsTable.currency)
            + '\n会话数: ' + (entry.sessionCount != null ? entry.sessionCount : 0)
            + '\n「' + (entry.title || id) + '」· ' + moneyUnitNote(wsTable.currency);
        if (text == null) {
          if (badge) badge.remove();
        } else {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'dsh-money-ws-badge';
            badge.style.cssText = 'color:#f0c11d;font-size:11px;padding:4px;line-height:11px;border-radius:8px;background:rgba(128,128,128,0.12);margin-left:4px;flex:none;white-space:nowrap;cursor:pointer;';
            bindTip(badge);
            row.appendChild(badge);
          }
          if (badge.textContent !== text) badge.textContent = text;
          if (badge.__dshMoneyTip !== tip) badge.__dshMoneyTip = tip;
        }
        // 本地模拟徽章（白色）：独立，紧跟 API 徽章右侧
        let simBadgeEl = row.querySelector('.dsh-money-ws-sim');
        const simText = sim > 0 ? '本地 ' + fmtMoney(sim, wsTable.currency) : null;
        const simTipText = sim > 0 ? simTip(sim, 0, wsTable.currency).lines.join('\n') : null;
        if (simText == null) {
          if (simBadgeEl) simBadgeEl.remove();
        } else {
          if (!simBadgeEl) {
            simBadgeEl = document.createElement('span');
            simBadgeEl.className = 'dsh-money-ws-sim';
            simBadgeEl.style.cssText = 'color:var(--dsw-alias-label-primary,#f5f5f5);font-size:11px;padding:4px;line-height:11px;border-radius:8px;background:rgba(128,128,128,0.12);margin-left:4px;flex:none;white-space:nowrap;cursor:pointer;';
            bindTip(simBadgeEl);
            row.appendChild(simBadgeEl);
          }
          if (simBadgeEl.textContent !== simText) simBadgeEl.textContent = simText;
          if (simBadgeEl.__dshMoneyTip !== simTipText) simBadgeEl.__dshMoneyTip = simTipText;
        }
      }
    } catch (e) {
      // 忽略 DOM 竞态
    } finally {
      applying = false;
      if (observer && typeof document !== 'undefined') {
        try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      }
    }
  }

  function startSidebarObserver() {
    if (REG.started) return;
    REG.started = true;
    loadUiSettings();
    loadWsTable();
    loadBalance();
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      // 节流：侧边栏高频 DOM 变化（滚动/展开/流式渲染）合并为一次 applyBadges
      let badgeTimer = null;
      const scheduleBadges = () => {
        if (badgeTimer) return;
        badgeTimer = setTimeout(() => {
          badgeTimer = null;
          applyBadges();
        }, 150);
      };
      observer = new MutationObserver(() => { scheduleBadges(); });
      try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      ctx.effect(() => () => { if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; } });
    }
    ctx.effect(() => () => { if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; } });
    // 高峰徽章倒计时的分钟级刷新：只驱动重渲染，数据到达另有 60 秒轮询与切换点定时器
    const disposeMinute = ctx.interval(() => {
      for (const fn of Array.from(balanceListeners)) { try { fn(balance); } catch (e) {} }
    }, 60000);
    const disposeWs = ctx.interval(() => loadWsTable(), 60000);
    const disposeBalance = ctx.interval(() => loadBalance(), 60000);
    ctx.effect(() => () => { disposeWs(); disposeBalance(); disposeMinute(); });
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    document.addEventListener('scroll', onReflow, true);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', onReflow);
    }
  }

  ctx.effect(() => () => {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      document.removeEventListener('scroll', onReflow, true);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onReflow);
    }
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (periodTimer) { clearTimeout(periodTimer); periodTimer = null; }
    // 注入到宿主行的徽章连同其节点监听器（旧闭包）一起移除，否则禁用/热重载后
    // 残留徽章会继续显示陈旧金额，且点击弹出的浮层因全局监听已解绑而关不掉
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      try {
        const injected = document.querySelectorAll('.dsh-money-ws-badge, .dsh-money-ws-sim');
        for (const node of Array.from(injected)) {
          node.__dshMoneyBound = false;
          node.__dshMoneyTip = undefined;
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      } catch (e) {}
    }
    REG.started = false;
    REG.slots.clear();
    hideTip();
    if (tipEl && tipEl.parentNode) { try { tipEl.parentNode.removeChild(tipEl); } catch (e) {} }
    tipEl = null;
  });

  // ---- 设置面板：费用显示货币 ----
  const CURRENCY_LABELS = {
    auto: '自动（跟随余额）',
    CNY: '人民币 ¥',
    USD: '美元 $',
  };
  const CURRENCY_DESCS = {
    auto: '余额为美元则按美元价目显示，否则按人民币',
    CNY: '费用按人民币价目表计算（¥ / 元）',
    USD: '费用按美元价目表计算（$ / 美元）',
  };
  function CurrencySettingRow() {
    const [value, setValue] = React.useState(currencySetting);
    const [showBalance, setShowBalanceState] = React.useState(showBalanceSetting);
    React.useEffect(() => {
      const unsub = subscribeCurrency((v) => setValue(v));
      if (!lsGet('dsh-money.currency')) {
        remote.config({}).then((res) => {
          const r = res && res.ok === true ? res.value : (res && res.error ? null : res);
          if (r && r.currency) setValue(r.currency);
        }).catch(() => {});
      }
      return unsub;
    }, []);
    const onToggleBalance = (e) => {
      const next = !(e && e.target && e.target.checked === false);
      setShowBalanceState(next);
      setShowBalance(next);
      lsSet('dsh-money.show-balance', next ? 'true' : 'false');
    };
    const onChange = (e) => {
      const next = e && e.target && e.target.value ? e.target.value : 'auto';
      setValue(next);
      lsSet('dsh-money.currency', next);
      remote.config({ currency: next })
        .then(() => {
          setCurrency(next);
          loadWsTable();
          balanceLoaded = false;
          loadBalance();
          for (const sid of Array.from(bySession.keys())) refresh(sid);
        })
        .catch(() => {});
    };
    const select = React.createElement('select', {
      value,
      onChange,
      style: {
        background: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.08))',
        height: '36px',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '18px',
        alignItems: 'center',
        gap: '12px',
        padding: '0 14px',
        fontSize: '14px',
        lineHeight: '22px',
        outline: 'none',
        appearance: 'auto',
      },
    },
      React.createElement('option', { value: 'auto' }, CURRENCY_LABELS.auto),
      React.createElement('option', { value: 'CNY' }, CURRENCY_LABELS.CNY),
      React.createElement('option', { value: 'USD' }, CURRENCY_LABELS.USD),
    );
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '16px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))',
    };
    const titleStyle = { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: '14px', fontWeight: '400', lineHeight: '22px' };
    const descStyle = { color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))', fontSize: '12px', lineHeight: '18px' };
    return React.createElement(React.Fragment, null,
      React.createElement('div', { style: rowStyle },
        React.createElement('div', { style: { flexDirection: 'column', flex: '1', gap: '4px', minWidth: '0', paddingRight: '48px', display: 'flex' } },
          React.createElement('div', { style: titleStyle }, '费用显示货币'),
          React.createElement('div', { style: descStyle }, CURRENCY_DESCS[value] || CURRENCY_DESCS.auto),
        ),
        select,
      ),
      React.createElement('div', { style: rowStyle },
        React.createElement('div', { style: { flexDirection: 'column', flex: '1', gap: '4px', minWidth: '0', paddingRight: '48px', display: 'flex' } },
          React.createElement('div', { style: titleStyle }, '显示账号余额'),
          React.createElement('div', { style: descStyle }, '侧边栏底部的余额、本地消费与高峰/闲时徽章；费用标签不受影响'),
        ),
        React.createElement('input', {
          type: 'checkbox',
          checked: showBalance,
          onChange: onToggleBalance,
          style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-interactive-primary, #4c8dff)', cursor: 'pointer', flex: 'none' },
        }),
      ),
    );
  }

  // 注册 UI（去重表挂在 globalThis，跨 apply 生效：重复注册同 id 会抛冲突并中断后续注入）
  function injectSlot(name, id, order, factory) {
    const key = name + '::' + id;
    if (REG.slots.has(key)) return;
    REG.slots.add(key);
    ctx.slots.inject(name, () => ctx.slots.register(
      { name, id, order },
      factory,
    ));
  }

  injectSlot('conversation.composer.dock', 'cost-meter', 5, (props) => React.createElement(CostDock, props));
  injectSlot('conversation.chat.assistant-actions', 'reply-cost', 20, (props) => React.createElement(ReplyCost, props));
  injectSlot('settings.general.item', 'cost-currency', 30, () => React.createElement(CurrencySettingRow));
  injectSlot('sidebar.footer.action', 'money-balance', 10, (props) => React.createElement(BalanceAction, props));

  startSidebarObserver();
}

module.exports = { apply, inject };
