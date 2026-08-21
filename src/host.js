/**
 * dsh-money — Host 半段
 *
 * 功能：
 *  - 账号余额：GET {baseURL}/user/balance（60 秒缓存）
 *  - 会话费用：折叠会话日志 assistant/message 事件的 token usage，按官方价目表计价
 *  - RPC：cost/overview（费用总览）、cost/config（显示币种设置）
 *
 * 计价口径（DeepSeek 官方价格页 2026-08 版，高峰价 = 空闲价 × 2）：
 *  高峰时段 = 北京时间 9:00-12:00、14:00-18:00（即 UTC 01:00-04:00、06:00-10:00）
 *  账单 = 未命中输入(含 cache write) × miss 价 + 缓存命中 × hit 价 + 输出 × out 价
 */

export default {
  name: 'dsh-money',
  apply(ctx) {
    // 每百万 token 单价：人民币与美元两套价目
    const PRICES = {
      CNY: {
        'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
        'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
      },
      USD: {
        'deepseek-v4-flash': { hit: 0.007, miss: 0.22, out: 0.66 },
        'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 },
      },
    };

    // 显示货币设置（进程内记忆，动态插件不持久化）：'auto' | 'CNY' | 'USD'
    let currencySetting = 'auto';

    function isPeakUtc(ms) {
      const h = new Date(ms).getUTCHours();
      return (h >= 1 && h < 4) || (h >= 6 && h < 10);
    }

    function priceOf(model, ms, currency) {
      const table = PRICES[currency] || PRICES.CNY;
      const base = table[model];
      if (!base) return null;
      const k = isPeakUtc(ms) ? 2 : 1;
      return { hit: base.hit * k, miss: base.miss * k, out: base.out * k };
    }

    // 账单口径：未命中输入(含 cache write) x miss 价 + 命中 x hit 价 + 输出 x out 价
    function costOf(usage, price) {
      if (!usage || !price) return null;
      const input = (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0)
        + (typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0);
      const hit = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
      const out = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
      return (input * price.miss + hit * price.hit + out * price.out) / 1e6;
    }

    // ---- 账号余额：GET {baseURL}/user/balance ----
    let balanceCache = { at: 0, value: null };

    function normalizeBalanceInfo(info) {
      if (!info) return null;
      const total = Number(info.total_balance);
      if (!Number.isFinite(total)) return null;
      return {
        currency: typeof info.currency === 'string' ? info.currency : 'CNY',
        total,
      };
    }

    async function fetchBalance() {
      let baseURL = 'https://api.deepseek.com';
      let apiKeyEnv = 'DEEPSEEK_API_KEY';
      try {
        const settings = ctx.get('settings');
        if (settings) {
          const cfg = settings.get('llm-deepseek');
          if (cfg && typeof cfg === 'object') {
            if (typeof cfg.baseURL === 'string' && cfg.baseURL) baseURL = cfg.baseURL;
            if (typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv) apiKeyEnv = cfg.apiKeyEnv;
          }
        }
      } catch (e) {}
      let key = null;
      try {
        const credentials = ctx.get('credentials');
        if (credentials) {
          const hit = await credentials.resolve(apiKeyEnv);
          if (hit && typeof hit.value === 'string' && hit.value) key = hit.value;
        }
      } catch (e) {}
      if (!key) return null;
      const shell = ctx.get('shell');
      if (!shell) return null;
      let result;
      try {
        const spec = shell.resolve({
          command: 'curl -sS -m 10 -H "Authorization: Bearer ' + key + '" "' + baseURL + '/user/balance"',
          timeoutMs: 15000,
          stdoutMaxBytes: 1048576,
        });
        result = await shell.run(spec);
      } catch (e) {
        return null;
      }
      if (!result || result.exitCode !== 0) return null;
      let body;
      try { body = JSON.parse(result.stdout.text); } catch (e) { return null; }
      if (!body || !Array.isArray(body.balance_infos) || !body.balance_infos.length) return null;
      const wanted = currencySetting === 'CNY' || currencySetting === 'USD' ? currencySetting : null;
      const matched = wanted ? body.balance_infos.find((i) => i && i.currency === wanted) : undefined;
      return normalizeBalanceInfo(matched || body.balance_infos[0]);
    }

    async function cachedBalance() {
      const now = Date.now();
      if (balanceCache.value && now - balanceCache.at < 60000) return balanceCache.value;
      let value = null;
      try { value = await fetchBalance(); } catch (e) {}
      balanceCache = { at: now, value };
      return value;
    }

    // 解析实际显示币种：手动设置优先，自动则跟随余额币种（非美元一律人民币）
    function resolveCurrency(balance) {
      if (currencySetting === 'CNY' || currencySetting === 'USD') return currencySetting;
      return balance && balance.currency === 'USD' ? 'USD' : 'CNY';
    }

    // ---- 会话费用：折叠 assistant/message 事件 ----
    async function foldSession(sessionId, currency) {
      const sessionQuery = ctx.get('sessionQuery');
      if (!sessionQuery) return { replies: [], conversationCost: null };
      let events = [];
      try {
        const snap = await sessionQuery.readSession(sessionId);
        events = (snap && Array.isArray(snap.events)) ? snap.events : [];
      } catch (e) {
        return { replies: [], conversationCost: null };
      }
      let lastModel = 'deepseek-v4-flash';
      const replies = [];
      let total = 0;
      let hasCost = false;
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'request/context' && ev.data && typeof ev.data.model === 'string') {
          lastModel = ev.data.model;
          continue;
        }
        if (ev.type !== 'assistant/message') continue;
        const data = ev.data || {};
        const message = data.message || {};
        const model = (message.source && typeof message.source.model === 'string')
          ? message.source.model
          : lastModel;
        const usage = data.usage || {};
        const price = priceOf(model, ev.time, currency);
        const cost = costOf(usage, price);
        if (cost != null) { total += cost; hasCost = true; }
        replies.push({
          messageId: typeof message.id === 'string' ? message.id : null,
          turn: data.turn,
          step: data.step,
          model,
          cost,
          tokens: {
            input: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
            cacheRead: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
            cacheWrite: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
            output: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
          },
        });
      }
      return { replies, conversationCost: hasCost ? total : null };
    }

    // 客户端读取/设置显示货币
    harness.handle('cost/config', async (args) => {
      const value = args && typeof args === 'object' ? args.currency : undefined;
      if (value === 'CNY' || value === 'USD' || value === 'auto') {
        currencySetting = value;
        balanceCache = { at: 0, value: null };
      }
      return { currency: currencySetting };
    });

    harness.handle('cost/overview', async (args) => {
      const sessionId = args && typeof args === 'object' && typeof args.sessionId === 'string'
        ? args.sessionId
        : null;
      if (!sessionId) return { error: 'missing sessionId' };
      const balance = await cachedBalance();
      const currency = resolveCurrency(balance);
      const fold = await foldSession(sessionId, currency);
      const last = fold.replies.length ? fold.replies[fold.replies.length - 1] : null;
      return {
        currency,
        balance,
        conversationCost: fold.conversationCost,
        lastReplyCost: last ? last.cost : null,
        replies: fold.replies.map((r) => ({
          messageId: r.messageId,
          cost: r.cost,
          model: r.model,
          tokens: r.tokens,
        })),
      };
    });
  },
};
