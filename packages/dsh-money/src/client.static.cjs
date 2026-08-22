/**
 * dsh-money — Client 半段（静态插件版，__ModuleLoader__ bundle 入口）
 *
 * UI：
 *  - conversation.composer.dock：输入区下方统计行（仅本对话费用，金色徽章）
 *  - conversation.chat.assistant-actions：每条回复费用标签（分支按钮右侧，悬停明细）
 *  - settings.general.item：费用显示货币设置行
 *  - 侧边栏 DOM 注入：工作区行（div[role=treeitem][aria-expanded]）总费用徽章
 *  - 侧边栏底部余额：DOM 注入行，插在设置按钮之后（最底部，左对齐，背景包裹文字）
 *
 * 与动态插件差异：无全局 host/styles/React；经 ctx.remote.moneyCost.* 调 Host，
 * React 由 require('react') 引入，CSS 手动注入 <style>。
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
  const remote = (ctx && ctx.remote) ? ctx.remote.moneyCost : null;
  if (!remote) return;

  // 手动注入布局 CSS（静态插件无 styles 全局）
  const CSS_ID = 'dsh-money-layout-css';
  if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-money="' + CSS_ID + '"]')) {
    const tag = document.createElement('style');
    tag.dataset.dshMoney = CSS_ID;
    tag.textContent =
      ''; // TEMP: :has CSS 临时禁用（性能对照），布局待重新设计
    document.head.appendChild(tag);
  }

  const bySession = new Map();
  // 会话 replies 的 messageId → reply 索引（数据到达时构建一次，组件 O(1) 查找）
  const replyIndex = new Map();
  const listeners = new Set();
  const inflight = new Map();

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
    if (r.tokens) {
      lines.push('输入(未命中): ' + fmtTokens(r.tokens.input));
      lines.push('输入(缓存命中): ' + fmtTokens(r.tokens.cacheRead));
      lines.push('输入(缓存写入): ' + fmtTokens(r.tokens.cacheWrite));
      lines.push('输出: ' + fmtTokens(r.tokens.output));
    }
    return lines.join('\n');
  }

  // ---- 输入区下方统计行：仅本对话费用 ----
  function CostDock(props) {
    const sessionId = props.sessionId;
    const session = props.session;
    const turns = session && session.turnEnds ? session.turnEnds.size : 0;
    const nodes = session && session.nodes ? session.nodes.length : 0;
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
    return React.createElement('div', {
      style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '11px', opacity: 0.85, padding: '2px 0', whiteSpace: 'nowrap' },
    },
      React.createElement('span', {
        key: 'conv',
        title: '本对话累计费用（估算）',
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
      },
        '本对话 ',
        React.createElement('span', { style: badgeStyle }, fmtMoney(o.conversationCost, currency)),
      ),
    );
  }

  // ---- 每条回复的费用标签（分支按钮右侧）----
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
      title: replyTooltip(reply, currency),
      style: { ...badgeStyle, order: 100, marginLeft: '2px' },
    }, fmtMoney(reply.cost, currency));
  }

  // ---- 侧边栏 DOM 注入（工作区行徽章 + 底部余额行）----
  let observer = null;
  let injected = false;
  let applying = false;
  let wsTable = null;
  let wsContainer = null;
  let balance = null;
  let balanceLoaded = false;

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

  function loadBalance() {
    remote.balance()
      .then((res) => {
        const value = res && res.ok === true ? res.value : (res && res.error ? null : res);
        if (value && typeof value === 'object') {
          balance = value.balance || null;
          balanceLoaded = true;
          applyBadges();
        }
      })
      .catch(() => {});
  }

  // 余额行：插到 settingsArea（设置）之后，即侧边栏最底部；左对齐，背景包裹文字
  function renderBalanceRow() {
    if (!balanceLoaded) return;
    const brandName = document.querySelector('[data-slot="sidebar.brand.name"]');
    const settingsSlot = document.querySelector('[data-slot="sidebar.settings"]');
    let row = document.querySelector('.dsh-money-balance-row');
    if (!brandName || !settingsSlot || !settingsSlot.parentElement || !settingsSlot.parentElement.parentElement) {
      if (row) row.remove();
      return;
    }
    const settingsArea = settingsSlot.parentElement;
    const footArea = settingsArea.parentElement;
    const text = '余额 ' + fmtBalance(balance);
    const tip = '账号剩余金额（自动刷新）';
    if (!row) {
      row = document.createElement('div');
      row.className = 'dsh-money-balance-row';
      row.style.cssText = 'color:#f0c11d;font-size:11px;padding:2px 12px;border-radius:8px;background:rgba(128,128,128,0.12);margin:2px 0 0;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;text-align:left;align-self:flex-start;max-width:100%;';
      footArea.insertBefore(row, settingsArea.nextSibling);
    }
    if (row.textContent !== text) row.textContent = text;
    if (row.title !== tip) row.title = tip;
  }

  function applyBadges() {
    if (applying) return;
    applying = true;
    if (observer) { try { observer.disconnect(); } catch (e) {} }
    try {
      if (typeof document === 'undefined') return;
      renderBalanceRow();
      if (!wsTable || !Array.isArray(wsTable.workspaces)) return;
      wsContainer = document.querySelector('[data-slot="sidebar.workspaces"]') || document.body;
      const rows = wsContainer.querySelectorAll('div[role="treeitem"][aria-expanded]');
      const byTitle = new Map(wsTable.workspaces.map((w) => [w.title, w]));
      for (const row of rows) {
        let label = '';
        const spans = row.querySelectorAll('span');
        for (const sp of spans) {
          const t = (sp.textContent || '').trim();
          if (t && t.length > 1 && !t.includes('¥') && !t.includes('$')) { label = t; break; }
        }
        if (!label) continue;
        const entry = byTitle.get(label);
        let badge = row.querySelector('.dsh-money-ws-badge');
        if (!entry || entry.cost == null) {
          if (badge) badge.remove();
          continue;
        }
        const text = fmtMoney(entry.cost, wsTable.currency);
        const tip = '工作区「' + label + '」总费用: ' + text + '（估算）\n会话数: ' + (entry.sessionCount != null ? entry.sessionCount : 0);
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'dsh-money-ws-badge';
          badge.style.cssText = 'color:#f0c11d;font-size:11px;padding:0 4px;border-radius:8px;background:rgba(128,128,128,0.12);margin-left:4px;flex:none;white-space:nowrap;';
          row.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.title !== tip) badge.title = tip;
      }
    } catch (e) {
      // 忽略 DOM 竞态
    } finally {
      applying = false;
      if (observer && wsContainer) {
        try { observer.observe(wsContainer, { childList: true, subtree: true }); } catch (e) {}
      }
    }
  }

  function startSidebarObserver() {
    if (injected) return;
    injected = true;
    loadWsTable();
    loadBalance();
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      // 节流：侧边栏高频 DOM 变化（滚动/展开）合并为一次 applyBadges，避免频繁全量扫描
      let badgeTimer = null;
      const scheduleBadges = () => {
        if (badgeTimer) return;
        badgeTimer = setTimeout(() => {
          badgeTimer = null;
          applyBadges();
        }, 150);
      };
      observer = new MutationObserver(() => { scheduleBadges(); });
      const root = document.querySelector('[data-slot="sidebar"]') || document.body;
      wsContainer = root;
      observer.observe(root, { childList: true, subtree: true });
      ctx.effect(() => () => { if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; } });
    }
    const disposeRefresh = ctx.interval(() => loadBalance(), 60000);
    ctx.effect(() => disposeRefresh);
  }

  ctx.effect(() => () => {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
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

  startSidebarObserver();
}

module.exports = { apply, inject };
