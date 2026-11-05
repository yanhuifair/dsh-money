/**
 * dsh-money — Client 半段（静态插件版，__ModuleLoader__ bundle 入口，适配 DSH 0.2.x）
 *
 * UI（全部走 Slot 注册，不再依赖已移除的 data-slot DOM 锚点）：
 *  - conversation.composer.dock：输入区下方统计行（本对话费用，金色徽章）
 *  - conversation.chat.assistant-actions：每条回复费用标签（悬停明细）
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
  const badgeStyle = {
    color: GOLD,
    fontSize: '11px',
    padding: '0 6px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))',
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    cursor: 'default',
  };

  // 时段徽章：高峰用暖色、闲时用绿色，与金色的金额徽章区分
  function periodBadgeStyle(peak) {
    return {
      ...badgeStyle,
      color: peak ? '#ff8f1f' : '#3fb950',
      background: peak ? 'rgba(255,143,31,0.12)' : 'rgba(63,185,80,0.12)',
    };
  }

  // ---- 自绘悬停提示 ----
  // DSH 桌面端不显示原生 title 提示（浏览器/Electron 窗口内均不可靠），
  // 这里用自建的单例浮层渲染多行明细；React 徽章与 DOM 注入徽章共用。
  let tipEl = null;
  let tipText = '';
  let tipVisible = false;

  function ensureTip() {
    if (tipEl || typeof document === 'undefined') return tipEl;
    tipEl = document.createElement('div');
    tipEl.setAttribute('data-dsh-money-tip', '');
    tipEl.style.cssText = [
      'position:fixed',
      'z-index:2147483000',
      'pointer-events:none',
      'max-width:360px',
      'padding:8px 10px',
      'border-radius:8px',
      'font-size:12px',
      'line-height:18px',
      'white-space:pre-line',
      'word-break:break-word',
      'color:var(--dsw-alias-label-primary,#f5f5f5)',
      'background:var(--dsw-alias-bg-elevated,rgba(32,32,36,0.96))',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12))',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      'opacity:0',
      'transform:translateY(2px)',
      'transition:opacity 120ms ease, transform 120ms ease',
    ].join(';');
    try { document.body.appendChild(tipEl); } catch (e) { tipEl = null; }
    return tipEl;
  }

  function placeTip(x, y) {
    const el = ensureTip();
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const pad = 12;
    let left = x + pad;
    let top = y + pad + 4;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - pad - rect.width);
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - pad - rect.height);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function showTip(text, ev) {
    if (!text) { hideTip(); return; }
    const el = ensureTip();
    if (!el || !ev || typeof ev.clientX !== 'number') return;
    if (text !== tipText) { el.textContent = text; tipText = text; }
    placeTip(ev.clientX, ev.clientY);
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    tipVisible = true;
  }

  function hideTip() {
    if (!tipEl) return;
    tipEl.style.opacity = '0';
    tipEl.style.transform = 'translateY(2px)';
    tipVisible = false;
  }

  /** React 元素悬停 props：进入显示、移动跟随、离开隐藏 */
  function tipProps(text) {
    return {
      onMouseEnter: (e) => showTip(text, e),
      onMouseMove: (e) => { if (tipVisible) placeTip(e.clientX, e.clientY); },
      onMouseLeave: hideTip,
    };
  }

  // 兜底：点击或滚动时收起浮层，避免组件卸载/行重建后提示残留
  const hideOnAny = () => hideTip();

  /** DOM 注入徽章的等价监听（一次性绑定，文案由 badge.__dshMoneyTip 提供） */
  function bindTip(badge) {
    badge.addEventListener('mouseenter', (e) => showTip(badge.__dshMoneyTip, e));
    badge.addEventListener('mousemove', (e) => { if (tipVisible) placeTip(e.clientX, e.clientY); });
    badge.addEventListener('mouseleave', hideTip);
  }

  function periodLabel(period) {
    return period && period.peak ? '高峰' : '闲时';
  }

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function periodTooltip(period) {
    if (!period) return '计费时段未知';
    const next = fmtClock(period.nextChangeAt);
    return period.peak
      ? '当前为高峰时段（北京时间 周一至周五 9:00-12:00、14:00-18:00，法定节假日除外）\n三档单价 ×2\n下次切换：' + next + ' 起为闲时'
      : '当前为闲时（含周末与中国法定节假日）\n三档单价为基准价\n下次切换：' + next + ' 起为高峰';
  }

  function moneySymbol(currency) {
    if (currency === 'CNY') return '¥ ';
    if (currency === 'USD') return '$';
    return '¥ ';
  }

  function fmtMoney(v, currency) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sym = moneySymbol(currency);
    if (v === 0) return '~' + sym + '0.00';
    if (v >= 1) return '~' + sym + v.toFixed(2);
    if (v >= 0.01) return '~' + sym + v.toFixed(4);
    return '~' + sym + v.toFixed(6).replace(/0+$/, '');
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
    const sym = moneySymbol(currency);
    const lines = ['本次回复费用: ' + fmtMoney(r.cost, currency) + (currency === 'CNY' ? '（元，估算）' : '（美元，估算）')];
    if (r.model) lines.push('模型: ' + r.model);
    lines.push('计价时段: ' + (r.peak ? '高峰（单价 ×2）' : '闲时'));
    if (r.tokens) {
      lines.push('输入(未命中): ' + fmtTokens(r.tokens.input));
      lines.push('输入(缓存命中): ' + fmtTokens(r.tokens.cacheRead));
      lines.push('输入(缓存写入): ' + fmtTokens(r.tokens.cacheWrite));
      lines.push('输出: ' + fmtTokens(r.tokens.output));
    }
    return lines.join('\n');
  }

  /** 悬停明细：本对话总额 + 高峰/闲时分别合计（含条数） */
  function conversationTooltip(o, currency) {
    const lines = ['本对话累计费用（估算）: ' + fmtMoney(o.conversationCost, currency)];
    const replies = Array.isArray(o.replies) ? o.replies : [];
    let peakCount = 0;
    for (const r of replies) { if (r && r.peak) peakCount += 1; }
    lines.push('高峰合计: ' + fmtMoney(o.peakCost == null ? 0 : o.peakCost, currency) + '（' + peakCount + ' 条）');
    lines.push('闲时合计: ' + fmtMoney(o.offPeakCost == null ? 0 : o.offPeakCost, currency) + '（' + (replies.length - peakCount) + ' 条）');
    return lines.join('\n');
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
    const parts = [];
    if (o.peakCost != null && o.peakCost > 0) {
      parts.push(React.createElement('span', {
        key: 'peak',
        'aria-label': '高峰时段累计费用（估算）',
        ...tipProps('高峰时段（北京时间 周一至周五 9:00-12:00、14:00-18:00，法定节假日除外）的累计费用（估算）'),
        style: periodBadgeStyle(true),
      }, '高峰 ' + fmtMoney(o.peakCost, currency)));
    }
    if (o.offPeakCost != null && o.offPeakCost > 0) {
      parts.push(React.createElement('span', {
        key: 'offpeak',
        'aria-label': '闲时累计费用（估算）',
        ...tipProps('闲时（含周末与法定节假日）的累计费用（估算）'),
        style: periodBadgeStyle(false),
      }, '闲时 ' + fmtMoney(o.offPeakCost, currency)));
    }
    return React.createElement('div', {
      style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '11px', opacity: 0.85, padding: '2px 0', whiteSpace: 'nowrap' },
    },
      React.createElement('span', {
        key: 'conv',
        'aria-label': '本对话累计费用（估算）',
        ...tipProps(conversationTooltip(o, currency)),
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
      },
        '本对话 ',
        React.createElement('span', { style: badgeStyle }, fmtMoney(o.conversationCost, currency)),
      ),
      parts,
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
      'aria-label': '本次回复费用（估算）',
      ...tipProps(replyTooltip(reply, currency)),
      style: { ...badgeStyle, marginLeft: '4px', marginRight: '2px' },
    }, fmtMoney(reply.cost, currency));
  }

  // ---- 侧边栏底部余额（sidebar.footer.action Slot）----
  function loadBalance() {
    if (balanceInflight) return;
    balanceInflight = true;
    remote.balance()
      .then((res) => {
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object') {
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
    React.useEffect(() => {
      const fn = () => force((n) => n + 1);
      balanceListeners.add(fn);
      if (!balanceLoaded) loadBalance();
      return () => { balanceListeners.delete(fn); };
    }, []);
    if (!balanceLoaded) return null;
    const wide = !(props && props.wide === false);
    const amount = fmtBalance(balance);
    const tip = '账号剩余金额（自动刷新）' + (balance && balance.source === 'api-key' ? '\n来源: API Key 余额' : '');
    if (!wide) {
      // 56px 折叠态：只显示币种符号，避免挤压设置按钮
      const sym = balance && balance.currency === 'USD' ? '$' : '¥';
      return React.createElement('span', { 'aria-label': '账号剩余金额', ...tipProps(tip), style: { ...badgeStyle, fontSize: '10px', padding: '0 4px' } }, sym);
    }
    const money = React.createElement('span', { key: 'money', 'aria-label': '账号剩余金额', ...tipProps(tip), style: badgeStyle }, amount);
    const period = balancePeriod
      ? React.createElement('span', {
        key: 'period',
        'aria-label': periodLabel(balancePeriod) + '时段',
        ...tipProps(periodTooltip(balancePeriod)),
        style: { ...periodBadgeStyle(balancePeriod.peak), marginLeft: '4px' },
      }, periodLabel(balancePeriod))
      : null;
    return React.createElement('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
    }, money, period);
  }

  // ---- 侧边栏工作区行费用（DOM 注入：0.2.x 无工作区行 Slot）----
  let observer = null;
  let started = false;
  let applying = false;
  let wsTable = null;

  function loadWsTable() {
    remote.workspacesAll()
      .then((res) => {
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object' && !value.error) {
          wsTable = value;
          applyBadges();
        }
      })
      .catch(() => {});
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
        let badge = row.querySelector('.dsh-money-ws-badge');
        if (!entry || entry.cost == null) {
          if (badge) badge.remove();
          continue;
        }
        const text = fmtMoney(entry.cost, wsTable.currency);
        const tip = '工作区「' + (entry.title || id) + '」总费用: ' + text + '（估算）'
          + '\n高峰合计: ' + fmtMoney(entry.peakCost == null ? 0 : entry.peakCost, wsTable.currency)
          + '\n闲时合计: ' + fmtMoney(entry.offPeakCost == null ? 0 : entry.offPeakCost, wsTable.currency)
          + '\n会话数: ' + (entry.sessionCount != null ? entry.sessionCount : 0);
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'dsh-money-ws-badge';
          badge.style.cssText = 'color:#f0c11d;font-size:11px;padding:0 4px;border-radius:8px;background:rgba(128,128,128,0.12);margin-left:4px;flex:none;white-space:nowrap;';
          bindTip(badge);
          row.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.__dshMoneyTip !== tip) badge.__dshMoneyTip = tip;
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
    if (started) return;
    started = true;
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
    const disposeWs = ctx.interval(() => loadWsTable(), 60000);
    const disposeBalance = ctx.interval(() => loadBalance(), 60000);
    ctx.effect(() => () => { disposeWs(); disposeBalance(); });
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('mousedown', hideOnAny, true);
    document.addEventListener('scroll', hideOnAny, true);
  }

  ctx.effect(() => () => {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('mousedown', hideOnAny, true);
      document.removeEventListener('scroll', hideOnAny, true);
    }
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (periodTimer) { clearTimeout(periodTimer); periodTimer = null; }
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
    React.useEffect(() => {
      const unsub = subscribeCurrency((v) => setValue(v));
      remote.config({}).then((res) => {
        const r = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (r && r.currency) setValue(r.currency);
      }).catch(() => {});
      return unsub;
    }, []);
    const onChange = (e) => {
      const next = e && e.target && e.target.value ? e.target.value : 'auto';
      setValue(next);
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
    return React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '16px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))',
      },
    },
      React.createElement('div', { style: { flexDirection: 'column', flex: '1', gap: '4px', minWidth: '0', paddingRight: '48px', display: 'flex' } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: '14px', fontWeight: '400', lineHeight: '22px' } }, '费用显示货币'),
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))', fontSize: '12px', lineHeight: '18px' } }, CURRENCY_DESCS[value] || CURRENCY_DESCS.auto),
      ),
      select,
    );
  }

  // 注册 UI（防重复：client 插件可能被多次 apply，重复注册会抛 id 冲突）
  const registeredSlots = new Set();
  function injectSlot(name, id, order, factory) {
    const key = name + '::' + id;
    if (registeredSlots.has(key)) return;
    registeredSlots.add(key);
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
