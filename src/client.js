/**
 * dsh-money — Client 半段
 *
 * UI：
 *  - conversation.composer.dock：输入区下方统计行（余额 / 本对话 / 上次回复，金色徽章）
 *  - conversation.chat.assistant-actions：每条回复费用标签（紧跟分支按钮右侧，悬停显示明细）
 *  - settings.general.item：费用显示货币设置行
 *
 * 布局技巧：renderSlot 的插槽容器是 div[data-slot=...]（display: contents），
 * 费用 span 在其内部，与时间戳（外层 flex 容器最后一个子元素）不是兄弟；
 * 用 :has() 从插槽容器出发选中外层 flex 容器的最后子元素（时间戳），把 order 提到费用之上，
 * 得到 [复制][反馈][分支][费用][时间戳]。
 */

export default {
  name: 'dsh-money',
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (!slots) return;

    // 布局目标：[复制][反馈][分支][费用][时间戳]
    const insertCss = styles.insert(
      'div[data-slot="conversation.chat.assistant-actions"]:has(.dsh-cost-reply) ~ :last-child { order: 101; }'
    );
    ctx.effect(() => insertCss);

    // 模块级共享 store：一次拉取，dock 与每条回复 chip 共用
    const bySession = new Map();
    const listeners = new Set();
    const inflight = new Map();

    // 显示币种设置：'auto' | 'CNY' | 'USD'（进程内记忆）
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
    function refresh(sessionId) {
      if (!sessionId || inflight.has(sessionId)) return;
      inflight.set(sessionId, true);
      host.call('cost/overview', { sessionId })
        .then((res) => {
          if (res && typeof res === 'object' && !res.error) {
            bySession.set(sessionId, res);
            notify(sessionId);
          }
        })
        .catch(() => {})
        .finally(() => { inflight.delete(sessionId); });
    }

    // 所有金钱文字统一金色 + 标签（徽章）风格
    const GOLD = '#d4af37';
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
      if (currency === 'CNY') return '¥';
      if (currency === 'USD') return '$';
      return '¥';
    }

    // 费用按 overview 解析出的币种格式化
    function fmtMoney(v, currency) {
      if (v == null || !Number.isFinite(v)) return '—';
      const sym = moneySymbol(currency);
      if (v === 0) return sym + '0.00';
      if (v >= 1) return sym + v.toFixed(2);
      if (v >= 0.01) return sym + v.toFixed(4);
      return sym + v.toFixed(6).replace(/0+$/, '');
    }
    function fmtBalance(b) {
      if (!b || b.total == null || !Number.isFinite(b.total)) return '—';
      const sym = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : (b.currency + ' ');
      return sym + b.total.toFixed(2);
    }
    function fmtTokens(n) {
      if (n == null || !Number.isFinite(n)) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    // 每次回复的悬停明细：模型 + token 拆分
    function replyTooltip(r, currency) {
      if (!r) return '本次回复费用';
      const lines = ['本次回复费用: ' + fmtMoney(r.cost, currency)];
      if (r.model) lines.push('模型: ' + r.model);
      if (r.tokens) {
        lines.push('输入(未命中): ' + fmtTokens(r.tokens.input));
        lines.push('输入(缓存命中): ' + fmtTokens(r.tokens.cacheRead));
        lines.push('输入(缓存写入): ' + fmtTokens(r.tokens.cacheWrite));
        lines.push('输出: ' + fmtTokens(r.tokens.output));
      }
      return lines.join('\n');
    }

    // 输入区下方的读出行：余额 / 本对话费用 / 上次回复费用（全部为金色标签风格）
    function CostDock(props) {
      const sessionId = props.sessionId;
      const session = props.session;
      const turns = session && session.turnEnds ? session.turnEnds.size : 0;
      const nodes = session && session.nodes ? session.nodes.length : 0;
      const [overview, setOverview] = React.useState(undefined);
      React.useEffect(() => {
        const apply = (sid) => { if (sid === sessionId) setOverview(getOverview(sid)); };
        const unsub = subscribe(apply);
        refresh(sessionId);
        const dispose = ctx.interval(() => refresh(sessionId), 30000);
        return () => { unsub(); dispose(); };
      }, [sessionId, turns, nodes]);
      const o = overview || {};
      const currency = o.currency || 'CNY';
      const replies = o.replies || [];
      const lastReply = replies.length ? replies[replies.length - 1] : null;
      const last = o.lastReplyCost != null ? o.lastReplyCost : (lastReply ? lastReply.cost : null);
      const children = [
        React.createElement('span', {
          key: 'bal',
          title: '账号剩余金额（自动刷新）',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
        },
          '余额 ',
          React.createElement('span', { style: badgeStyle }, fmtBalance(o.balance)),
        ),
        React.createElement('span', { key: 'sep1', style: { opacity: 0.4 } }, '·'),
        React.createElement('span', {
          key: 'conv',
          title: '本对话累计费用（估算）',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
        },
          '本对话 ',
          React.createElement('span', { style: badgeStyle }, fmtMoney(o.conversationCost, currency)),
        ),
        React.createElement('span', { key: 'sep2', style: { opacity: 0.4 } }, '·'),
        React.createElement('span', {
          key: 'last',
          title: lastReply ? replyTooltip(lastReply, currency) : '上次回复费用（估算）',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
        },
          '上次回复 ',
          React.createElement('span', { style: badgeStyle }, fmtMoney(last, currency)),
        ),
      ];
      return React.createElement('div', {
        style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '11px', opacity: 0.85, padding: '2px 0', whiteSpace: 'nowrap' },
      }, children);
    }

    // 每条回复旁的本次费用：紧跟分支按钮右侧（时间戳仍最右），金色标签
    function ReplyCost(props) {
      const sessionId = props.sessionId;
      const messageId = props.messageId;
      const [overview, setOverview] = React.useState(undefined);
      React.useEffect(() => {
        const apply = (sid) => { if (sid === sessionId) setOverview(getOverview(sid)); };
        const unsub = subscribe(apply);
        refresh(sessionId);
        return () => unsub();
      }, [sessionId]);
      let reply = null;
      let currency = 'CNY';
      if (overview) {
        if (overview.currency) currency = overview.currency;
        if (Array.isArray(overview.replies)) {
          for (const r of overview.replies) {
            if (r.messageId === messageId) { reply = r; break; }
          }
        }
      }
      if (!reply || reply.cost == null) return null;
      return React.createElement('span', {
        className: 'dsh-cost-reply',
        title: replyTooltip(reply, currency),
        style: { ...badgeStyle, order: 100, marginLeft: '2px' },
      }, fmtMoney(reply.cost, currency));
    }

    // 设置行：费用显示货币（自动 / 人民币 / 美元）
    function CurrencySettingRow() {
      const [value, setValue] = React.useState(currencySetting);
      React.useEffect(() => {
        const unsub = subscribeCurrency((v) => setValue(v));
        host.call('cost/config', {}).then((res) => {
          if (res && typeof res === 'object' && res.currency) setValue(res.currency);
        }).catch(() => {});
        return unsub;
      }, []);
      const onChange = (e) => {
        const next = e && e.target && e.target.value ? e.target.value : 'auto';
        setValue(next);
        host.call('cost/config', { currency: next })
          .then(() => {
            setCurrency(next);
            for (const sid of Array.from(bySession.keys())) refresh(sid);
          })
          .catch(() => {});
      };
      const select = React.createElement('select', {
        value,
        onChange,
        style: { background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: '4px', padding: '2px 4px', fontSize: '12px' },
      },
        React.createElement('option', { value: 'auto' }, '自动（跟随余额）'),
        React.createElement('option', { value: 'CNY' }, '人民币 ¥'),
        React.createElement('option', { value: 'USD' }, '美元 $'),
      );
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' } },
        React.createElement('span', null, '费用显示货币'),
        select,
      );
    }

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'cost-meter', order: 5 },
      (props) => React.createElement(CostDock, props),
    ));
    slots.inject('conversation.chat.assistant-actions', () => slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'reply-cost', order: 20 },
      (props) => React.createElement(ReplyCost, props),
    ));
    slots.inject('settings.general.item', () => slots.register(
      { name: 'settings.general.item', id: 'cost-currency', order: 30 },
      () => React.createElement(CurrencySettingRow),
    ));
  },
};
