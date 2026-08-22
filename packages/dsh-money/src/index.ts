/**
 * dsh-money — Host 半段（静态插件版）
 *
 * 以标准 DSH 静态插件形式提供：TypertRemoteService + @Remote 装饰器声明
 * 四个远端方法（config / balance / overview / workspacesAll），client 半段
 * 通过 ctx.remote.moneyCost.* 调用。
 *
 * 计价口径（DeepSeek 官方价格页 2026-08 版，高峰价 = 空闲价 × 2）：
 *  高峰时段 = 北京时间 9:00-12:00、14:00-18:00（即 UTC 01:00-04:00、06:00-10:00）
 *  账单 = 未命中输入(含 cache write) × miss 价 + 缓存命中 × hit 价 + 输出 × out 价
 */

import { Context, Service } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {
  MoneyBalanceInfo,
  MoneyBalanceResult,
  MoneyConfigResult,
  MoneyCostOverview,
  MoneyReplyCost,
  MoneyWorkspaceCost,
  MoneyWorkspacesAll,
} from './types.js';

/**
 * 每百万 token 单价：人民币与美元两套价目
 * 来源：DeepSeek 官方价格页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 更新日期：2026-08（官方调价时需同步更新并升级版本）
 */
const PRICES: Record<string, Record<string, { hit: number; miss: number; out: number }>> = {
  CNY: {
    'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
  },
  USD: {
    'deepseek-v4-flash': { hit: 0.007, miss: 0.22, out: 0.66 },
    'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 },
  },
};

function isPeakUtc(ms: number): boolean {
  const h = new Date(ms).getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function priceOf(
  model: string,
  ms: number,
  currency: string,
): { hit: number; miss: number; out: number } | null {
  const table = PRICES[currency] || PRICES.CNY;
  const base = table[model];
  if (!base) return null;
  const k = isPeakUtc(ms) ? 2 : 1;
  return { hit: base.hit * k, miss: base.miss * k, out: base.out * k };
}

/** 账单口径：未命中输入(含 cache write) x miss 价 + 命中 x hit 价 + 输出 x out 价 */
function costOf(
  usage: Record<string, unknown>,
  price: { hit: number; miss: number; out: number } | null,
): number | null {
  if (!usage || !price) return null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const input = num(usage.inputTokens) + num(usage.cacheWriteTokens);
  const hit = num(usage.cacheReadTokens);
  const out = num(usage.outputTokens);
  return (input * price.miss + hit * price.hit + out * price.out) / 1e6;
}

/**
 * dsh-money Host 服务：余额、会话/工作区费用折叠。
 * 远端命名空间 = moneyCost（client 经 ctx.remote.moneyCost.* 调用）。
 */
export default class MoneyCostService extends TypertRemoteService {
  /** 显示货币设置（进程内记忆）：'auto' | 'CNY' | 'USD' */
  private currencySetting: 'auto' | 'CNY' | 'USD' = 'auto';
  private balanceCache: { at: number; value: MoneyBalanceInfo | null } = { at: 0, value: null };

  constructor(ctx: Context) {
    super(ctx, 'moneyCost');
  }

  private normalizeBalanceInfo(info: Record<string, unknown> | null | undefined): MoneyBalanceInfo | null {
    if (!info) return null;
    const total = Number(info.total_balance);
    if (!Number.isFinite(total)) return null;
    return {
      currency: typeof info.currency === 'string' ? info.currency : 'CNY',
      total,
    };
  }

  private async fetchBalance(): Promise<MoneyBalanceInfo | null> {
    let baseURL = 'https://api.deepseek.com';
    let apiKeyEnv = 'DEEPSEEK_API_KEY';
    try {
      const settings = this.ctx.get('settings') as { get(ns: string): unknown } | undefined;
      if (settings) {
        const cfg = settings.get('llm-deepseek') as Record<string, unknown> | null;
        if (cfg && typeof cfg === 'object') {
          if (typeof cfg.baseURL === 'string' && cfg.baseURL) baseURL = cfg.baseURL;
          if (typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv) apiKeyEnv = cfg.apiKeyEnv;
        }
      }
    } catch (e) {
      // 忽略设置读取失败
    }
    let key: string | null = null;
    try {
      const credentials = this.ctx.get('credentials') as { resolve(ref: string): Promise<{ value?: unknown } | undefined> } | undefined;
      if (credentials) {
        const hit = await credentials.resolve(apiKeyEnv);
        if (hit && typeof hit.value === 'string' && hit.value) key = hit.value;
      }
    } catch (e) {
      // 忽略凭据解析失败
    }
    if (!key) return null;
    const shell = this.ctx.get('shell') as { resolve(spec: object): { run(spec: object): Promise<{ exitCode?: number; stdout?: { text: string } }> }; run(spec: object): Promise<{ exitCode?: number; stdout?: { text: string } }> } | undefined;
    if (!shell) return null;
    let result: { exitCode?: number; stdout?: { text: string } };
    try {
      const spec = shell.resolve({
        command: `curl -sS -m 10 -H "Authorization: Bearer ${key}" "${baseURL}/user/balance"`,
        timeoutMs: 15000,
        stdoutMaxBytes: 1048576,
      });
      result = await shell.run(spec);
    } catch (e) {
      return null;
    }
    if (!result || result.exitCode !== 0) return null;
    let body: { balance_infos?: Array<Record<string, unknown>> };
    try {
      body = JSON.parse(result.stdout?.text || '{}');
    } catch (e) {
      return null;
    }
    if (!body || !Array.isArray(body.balance_infos) || !body.balance_infos.length) return null;
    const wanted = this.currencySetting === 'CNY' || this.currencySetting === 'USD' ? this.currencySetting : null;
    const matched = wanted
      ? body.balance_infos.find((i) => i && i.currency === wanted)
      : undefined;
    return this.normalizeBalanceInfo(matched || body.balance_infos[0]);
  }

  private async cachedBalance(): Promise<MoneyBalanceInfo | null> {
    const now = Date.now();
    if (this.balanceCache.value && now - this.balanceCache.at < 60000) return this.balanceCache.value;
    let value: MoneyBalanceInfo | null = null;
    try {
      value = await this.fetchBalance();
    } catch (e) {
      value = null;
    }
    this.balanceCache = { at: now, value };
    return value;
  }

  /** 解析实际显示币种：手动设置优先，自动则跟随余额币种（非美元一律人民币） */
  private resolveCurrency(balance: MoneyBalanceInfo | null): 'CNY' | 'USD' {
    if (this.currencySetting === 'CNY' || this.currencySetting === 'USD') return this.currencySetting;
    return balance && balance.currency === 'USD' ? 'USD' : 'CNY';
  }

  /** 会话折叠结果缓存：避免反复读取大会话日志（key = sessionId + currency） */
  private foldCache = new Map<string, { at: number; value: { replies: MoneyReplyCost[]; conversationCost: number | null } }>();
  private readonly FOLD_TTL_MS = 60000;

  /** 折叠会话：逐条 assistant/message 计价并求和（带 60s 缓存） */
  private async foldSession(
    sessionId: string,
    currency: 'CNY' | 'USD',
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null }> {
    const key = sessionId + '::' + currency;
    const cached = this.foldCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < this.FOLD_TTL_MS) return cached.value;
    const value = await this.foldSessionUncached(sessionId, currency);
    // 清理过期项，防止无限增长
    if (this.foldCache.size > 200) {
      for (const [k, v] of this.foldCache) {
        if (now - v.at >= this.FOLD_TTL_MS) this.foldCache.delete(k);
      }
    }
    this.foldCache.set(key, { at: now, value });
    return value;
  }

  /** 无缓存折叠实现 */
  private async foldSessionUncached(
    sessionId: string,
    currency: 'CNY' | 'USD',
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null }> {
    const sessionQuery = this.ctx.get('sessionQuery') as { readSession(id: string): Promise<{ events?: unknown[] } | undefined> } | undefined;
    if (!sessionQuery) return { replies: [], conversationCost: null };
    let events: unknown[] = [];
    try {
      const snap = await sessionQuery.readSession(sessionId);
      events = snap && Array.isArray(snap.events) ? snap.events : [];
    } catch (e) {
      return { replies: [], conversationCost: null };
    }
    let lastModel = 'deepseek-v4-flash';
    const replies: MoneyReplyCost[] = [];
    let total = 0;
    let hasCost = false;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const event = ev as Record<string, unknown>;
      if (event.type === 'request/context' && event.data && typeof (event.data as Record<string, unknown>).model === 'string') {
        lastModel = (event.data as Record<string, unknown>).model as string;
        continue;
      }
      if (event.type !== 'assistant/message') continue;
      const data = (event.data || {}) as Record<string, unknown>;
      const message = (data.message || {}) as Record<string, unknown>;
      const source = (message.source || {}) as Record<string, unknown>;
      const model =
        typeof source.model === 'string' ? source.model : lastModel;
      const usage = (data.usage || {}) as Record<string, unknown>;
      const price = priceOf(model, typeof event.time === 'number' ? event.time : Date.now(), currency);
      const cost = costOf(usage, price);
      if (cost != null) {
        total += cost;
        hasCost = true;
      }
      const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
      replies.push({
        messageId: typeof message.id === 'string' ? message.id : null,
        cost,
        model,
        tokens: {
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        },
      });
    }
    return { replies, conversationCost: hasCost ? total : null };
  }

  /** 全量工作区费用表 */
  private async allWorkspaceCosts(currency: 'CNY' | 'USD'): Promise<MoneyWorkspaceCost[]> {
    const registry = this.ctx.get('workspaceRegistry') as { list(): Array<{ title?: unknown; sessionIds?: unknown }> } | undefined;
    if (!registry) return [];
    let list: Array<{ title?: unknown; sessionIds?: unknown }> = [];
    try {
      list = registry.list();
    } catch (e) {
      return [];
    }
    const workspaces: MoneyWorkspaceCost[] = [];
    for (const w of list) {
      const sessionIds = Array.isArray(w.sessionIds) ? (w.sessionIds as string[]) : [];
      let total = 0;
      let hasCost = false;
      for (const sid of sessionIds) {
        const fold = await this.foldSession(sid, currency);
        if (fold.conversationCost != null) {
          total += fold.conversationCost;
          hasCost = true;
        }
      }
      workspaces.push({
        title: typeof w.title === 'string' ? w.title : '',
        cost: hasCost ? total : null,
        sessionCount: sessionIds.length,
      });
    }
    return workspaces;
  }

  /** 读取/设置显示币种 */
  @Remote("config")
  async config(args: { currency?: string }): Promise<MoneyConfigResult> {
    const value = args && typeof args === 'object' ? args.currency : undefined;
    if (value === 'CNY' || value === 'USD' || value === 'auto') {
      this.currencySetting = value;
      this.balanceCache = { at: 0, value: null };
      this.foldCache.clear();
    }
    return { currency: this.currencySetting };
  }

  /** 侧边栏底部余额 */
  @Remote("balance")
  async balance(): Promise<{ balance: MoneyBalanceInfo | null }> {
    const balance = await this.cachedBalance();
    return { balance };
  }

  /** 单会话费用总览 */
  @Remote("overview")
  async overview(args: { sessionId?: string }): Promise<MoneyCostOverview | { error: string }> {
    const sessionId = args && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : null;
    if (!sessionId) return { error: 'missing sessionId' };
    const balance = await this.cachedBalance();
    const currency = this.resolveCurrency(balance);
    const fold = await this.foldSession(sessionId, currency);
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
  }

  /** 全量工作区费用表（侧边栏工作区行注入） */
  @Remote("workspacesAll")
  async workspacesAll(): Promise<MoneyWorkspacesAll> {
    const balance = await this.cachedBalance();
    const currency = this.resolveCurrency(balance);
    const workspaces = await this.allWorkspaceCosts(currency);
    return { currency, workspaces };
  }
}

// 供 cordis Service 类型增强（可选）
declare module '@deepseek-ai/cordis' {
  interface Context {
    moneyCost: MoneyCostService;
  }
}
