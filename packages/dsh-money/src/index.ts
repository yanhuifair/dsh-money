/**
 * dsh-money — Host 半段（静态插件版，适配 DeepSeek Harness 0.2.x）
 *
 * 以标准 DSH 静态插件形式提供：TypertRemoteService + @Remote 装饰器声明
 * 四个远端方法（config / balance / overview / workspacesAll），client 半段
 * 通过 ctx.remote.moneyCost.* 调用。
 *
 * 计价口径 —— DeepSeek 官方价格页 2026-11 版
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *  · 模型：deepseek-flash（旧名 deepseek-v4-flash 仍按 Flash 计费）、deepseek-v4-pro
 *  · 高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00，价格 = 空闲价 × 2
 *  · 账单 = 未命中输入(含 cache write) × miss 价 + 缓存命中 × hit 价 + 输出 × out 价
 *  · 中国法定节假日暂按工作日计（会略微高估，见 README）
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
 * 每百万 token 单价：人民币与美元两套价目（空闲时段，高峰 × 2）
 * 来源：DeepSeek 官方价格页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 更新日期：2026-11（官方调价时需同步更新并升级版本）
 */
const PRICES: Record<string, Record<string, { hit: number; miss: number; out: number }>> = {
  CNY: {
    'deepseek-flash': { hit: 0.02, miss: 1, out: 4 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
  },
  USD: {
    'deepseek-flash': { hit: 0.003, miss: 0.15, out: 0.6 },
    'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 },
  },
};

/** 旧模型名 → 当前计费模型（官方：旧名仍可调用，按 Flash 价计费） */
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 中国法定节假日（放假日，北京时间日期）。来源：国务院办公厅《关于2026年部分节假日安排的通知》
 * （国办发明电〔2025〕7号，https://www.gov.cn/zhengce/content/202511/content_7047090.htm）。
 * 官方调价与放假安排每年更新，新年度通知发布后在此追加区间即可；未列入的日期按工作日处理。
 */
const CN_HOLIDAY_RANGES: ReadonlyArray<readonly [string, string]> = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
];

const CN_HOLIDAYS: ReadonlySet<string> = (() => {
  const days = new Set<string>();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [from, to] of CN_HOLIDAY_RANGES) {
    const start = Date.parse(from + 'T00:00:00Z');
    const end = Date.parse(to + 'T00:00:00Z');
    for (let t = start; t <= end; t += DAY) days.add(new Date(t).toISOString().slice(0, 10));
  }
  return days;
})();

/** 北京时间（UTC+8，无夏令时）：星期、小时与日期键 */
function beijingClock(ms: number): { day: number; hour: number; date: string } {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    date: d.toISOString().slice(0, 10),
  };
}

/**
 * 高峰时段（官方口径）：北京时间周一至周五 9:00-12:00、14:00-18:00，
 * 且不含中国法定节假日——节假日全天、周末全天均为闲时（含调休上班的周末）。
 */
function isPeak(ms: number): boolean {
  const { day, hour, date } = beijingClock(ms);
  if (day === 0 || day === 6) return false;
  if (CN_HOLIDAYS.has(date)) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 下一次时段切换的时间戳：在未来的北京时间 0/9/12/14/18 点中找第一个状态不同者 */
function nextPeriodChange(ms: number): number {
  const current = isPeak(ms);
  const DAY = 24 * 60 * 60 * 1000;
  const dayStart = Math.floor((ms + BEIJING_OFFSET_MS) / DAY) * DAY - BEIJING_OFFSET_MS;
  for (let offset = 0; offset <= 8; offset++) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const at = dayStart + offset * DAY + hour * 60 * 60 * 1000;
      if (at <= ms) continue;
      if (isPeak(at) !== current) return at;
    }
  }
  return ms + DAY;
}

/** 当前时段快照（高峰/闲时 + 下次切换时间） */
function currentPeriod(ms: number = Date.now()): { peak: boolean; nextChangeAt: number } {
  return { peak: isPeak(ms), nextChangeAt: nextPeriodChange(ms) };
}

function modelOf(model: string): string {
  const key = (model || '').trim().toLowerCase();
  return MODEL_ALIASES[key] ?? key;
}

function priceOf(
  model: string,
  ms: number,
  currency: string,
): { hit: number; miss: number; out: number } | null {
  const table = PRICES[currency] || PRICES.CNY;
  const base = table[modelOf(model)];
  if (!base) return null;
  const k = isPeak(ms) ? 2 : 1;
  return { hit: base.hit * k, miss: base.miss * k, out: base.out * k };
}

/** 账单口径：未命中输入(含 cache write) x miss 价 + 命中 x hit 价 + 输出 x out 价 */
function costOf(
  usage: Record<string, unknown>,
  price: { hit: number; miss: number; out: number } | null,
): number | null {
  if (!usage || !price) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(usage.inputTokens) + num(usage.cacheWriteTokens);
  const hit = num(usage.cacheReadTokens);
  const out = num(usage.outputTokens);
  return (input * price.miss + hit * price.hit + out * price.out) / 1e6;
}

/** 从 settings 描述里按 provider.settingsPath 取当前值 */
function pickPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

interface AccountWalletLike {
  currency?: unknown;
  balance?: unknown;
}

interface AccountDetailsLike {
  status?: unknown;
  value?: unknown;
  bonusWallets?: unknown;
}

interface LlmProviderLike {
  provider?: unknown;
  settingsNs?: unknown;
  settingsPath?: unknown;
  defaultBaseURL?: unknown;
  nativeAuth?: { env?: unknown } | unknown;
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

  /** 登录账号余额：ctx.deepseekAccount（DSH 0.2.x 的内置账号服务） */
  private async accountBalance(): Promise<MoneyBalanceInfo | null> {
    const account = this.ctx.get('deepseekAccount') as
      | { getBalance(client: { version: string; locale: string; timezoneOffsetSeconds: number }): Promise<AccountDetailsLike | null> }
      | undefined;
    if (!account || typeof account.getBalance !== 'function') return null;
    let details: AccountDetailsLike | null = null;
    try {
      details = await account.getBalance({
        version: '1.3.2',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
    } catch (e) {
      return null;
    }
    if (!details || details.status !== 'ready' || !Array.isArray(details.value)) return null;
    const wallets: AccountWalletLike[] = [
      ...(details.value as AccountWalletLike[]),
      ...(Array.isArray(details.bonusWallets) ? (details.bonusWallets as AccountWalletLike[]) : []),
    ].filter((w): w is AccountWalletLike => !!w && typeof w === 'object');
    if (!wallets.length) return null;
    const wanted = this.currencySetting === 'auto' ? null : this.currencySetting;
    const currencyOf = (w: AccountWalletLike): string => (typeof w.currency === 'string' ? w.currency : 'CNY');
    const currency = wanted ?? currencyOf(wallets[0]);
    let total = 0;
    let found = false;
    for (const wallet of wallets) {
      if (currencyOf(wallet) !== currency) continue;
      const value = Number(wallet.balance);
      if (!Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
    if (!found) return null;
    return { currency, total, source: 'account' };
  }

  /** 当前 DeepSeek provider 的目录项（用于 baseURL / API Key 环境变量） */
  private deepseekProvider(): LlmProviderLike | undefined {
    const llm = this.ctx.get('llm') as { listConfigurableProviders?(): LlmProviderLike[] } | undefined;
    if (!llm || typeof llm.listConfigurableProviders !== 'function') return undefined;
    let entries: LlmProviderLike[] = [];
    try {
      entries = llm.listConfigurableProviders();
    } catch (e) {
      return undefined;
    }
    if (!Array.isArray(entries)) return undefined;
    const envOf = (entry: LlmProviderLike): string[] => {
      const nativeAuth = entry.nativeAuth;
      const env = nativeAuth && typeof nativeAuth === 'object' ? (nativeAuth as { env?: unknown }).env : undefined;
      return Array.isArray(env) ? env.filter((name): name is string => typeof name === 'string') : [];
    };
    return (
      entries.find((entry) => entry.provider === 'deepseek') ??
      entries.find((entry) => envOf(entry).includes('DEEPSEEK_API_KEY')) ??
      entries.find((entry) => envOf(entry).length > 0)
    );
  }

  /** 读取 provider 当前生效的 baseURL（settings 覆盖 → provider 默认值） */
  private providerBaseURL(provider: LlmProviderLike | undefined): string {
    const fallback =
      provider && typeof provider.defaultBaseURL === 'string' && provider.defaultBaseURL
        ? provider.defaultBaseURL
        : 'https://api.deepseek.com';
    const settingsNs = provider && typeof provider.settingsNs === 'string' ? provider.settingsNs : undefined;
    if (!settingsNs) return fallback;
    const settings = this.ctx.get('settings') as
      | { describe?(): Array<{ ns?: unknown; value?: unknown }> }
      | undefined;
    if (!settings || typeof settings.describe !== 'function') return fallback;
    try {
      const descriptor = settings.describe().find((entry) => entry && entry.ns === settingsNs);
      const path = Array.isArray(provider?.settingsPath)
        ? (provider.settingsPath as unknown[]).filter((key): key is string => typeof key === 'string')
        : [];
      const value = pickPath(descriptor?.value, path);
      return typeof value === 'string' && value.trim() ? value.trim() : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** API Key 余额：credentials 解析 + GET /user/balance（DSH 0.2.x 无 shell.run） */
  private async apiKeyBalance(): Promise<MoneyBalanceInfo | null> {
    const provider = this.deepseekProvider();
    const envOfProvider = (() => {
      const nativeAuth = provider?.nativeAuth;
      const env = nativeAuth && typeof nativeAuth === 'object' ? (nativeAuth as { env?: unknown }).env : undefined;
      const list = Array.isArray(env) ? env.filter((name): name is string => typeof name === 'string') : [];
      return list[0] ?? 'DEEPSEEK_API_KEY';
    })();
    const credentials = this.ctx.get('credentials') as
      | { resolve(ref: string): Promise<{ value?: unknown } | undefined> }
      | undefined;
    if (!credentials || typeof credentials.resolve !== 'function') return null;
    let key: string | null = null;
    try {
      const hit = await credentials.resolve(envOfProvider);
      if (hit && typeof hit.value === 'string' && hit.value) key = hit.value;
    } catch (e) {
      return null;
    }
    if (!key) return null;
    const baseURL = this.providerBaseURL(provider).replace(/\/+$/, '');
    let body: { balance_infos?: unknown };
    try {
      const response = await fetch(`${baseURL}/user/balance`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      body = (await response.json()) as { balance_infos?: unknown };
    } catch (e) {
      return null;
    }
    const list = body && Array.isArray(body.balance_infos) ? (body.balance_infos as Array<Record<string, unknown>>) : [];
    if (!list.length) return null;
    const wanted = this.currencySetting === 'CNY' || this.currencySetting === 'USD' ? this.currencySetting : null;
    const matched = wanted ? list.find((item) => item && item.currency === wanted) : undefined;
    const info = this.normalizeBalanceInfo(matched || list[0]);
    return info ? { ...info, source: 'api-key' } : null;
  }

  private async fetchBalance(): Promise<MoneyBalanceInfo | null> {
    const account = await this.accountBalance();
    if (account) return account;
    return this.apiKeyBalance();
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

  /** 会话折叠增量状态：记录最后处理的 seq，只折叠新增事件（key = sessionId + currency） */
  private foldCache = new Map<
    string,
    { replies: MoneyReplyCost[]; conversationCost: number | null; peakCost: number | null; offPeakCost: number | null; lastSeq: number }
  >();

  /** 折叠会话：增量处理（只读新增事件并追加，避免重复遍历整个日志） */
  private async foldSession(
    sessionId: string,
    currency: 'CNY' | 'USD',
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null; peakCost: number | null; offPeakCost: number | null }> {
    const key = sessionId + '::' + currency;
    const cached = this.foldCache.get(key);
    const empty = { replies: [] as MoneyReplyCost[], conversationCost: null, peakCost: null, offPeakCost: null };
    const sessionQuery = this.ctx.get('sessionQuery') as
      | { readSession(id: string): Promise<{ events?: Array<Record<string, unknown> & { seq?: number }> } | undefined> }
      | undefined;
    if (!sessionQuery) return cached ? cached : empty;
    let events: Array<Record<string, unknown> & { seq?: number }> = [];
    try {
      const snap = await sessionQuery.readSession(sessionId);
      events = snap && Array.isArray(snap.events) ? (snap.events as Array<Record<string, unknown> & { seq?: number }>) : [];
    } catch (e) {
      return cached
        ? { replies: cached.replies, conversationCost: cached.conversationCost, peakCost: cached.peakCost, offPeakCost: cached.offPeakCost }
        : empty;
    }
    // 增量：从缓存的 lastSeq 之后继续；无缓存则全量
    const fromSeq = cached ? cached.lastSeq : -1;
    const freshReplies: MoneyReplyCost[] = cached ? [...cached.replies] : [];
    const carried = {
      conversationCost: cached ? cached.conversationCost : null,
      peakCost: cached ? cached.peakCost : null,
      offPeakCost: cached ? cached.offPeakCost : null,
    };
    // 只处理 seq > fromSeq 的新增事件
    const newEvents = fromSeq >= 0 ? events.filter((e) => (e && typeof e.seq === 'number' ? e.seq > fromSeq : true)) : events;
    const fold = await this.foldEvents(newEvents, currency, freshReplies, carried);
    // 更新缓存（重置 TTL）
    this.foldCache.set(key, {
      replies: fold.replies,
      conversationCost: fold.conversationCost,
      peakCost: fold.peakCost,
      offPeakCost: fold.offPeakCost,
      lastSeq: this.maxSeq(events),
    });
    return fold;
  }

  /** 批量折叠事件（分片异步处理，避免长任务阻塞事件循环） */
  private async foldEvents(
    events: Array<Record<string, unknown> & { seq?: number }>,
    currency: 'CNY' | 'USD',
    replies: MoneyReplyCost[],
    carried: { conversationCost: number | null; peakCost: number | null; offPeakCost: number | null },
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null; peakCost: number | null; offPeakCost: number | null }> {
    const timer = this.ctx.get('timer') as { timeout(ms: number): Promise<void> } | undefined;
    let lastModel = 'deepseek-flash';
    let total = carried.conversationCost ?? 0;
    let peakTotal = carried.peakCost ?? 0;
    let offPeakTotal = carried.offPeakCost ?? 0;
    let hasCost = carried.conversationCost != null;
    let hasPeak = carried.peakCost != null;
    let hasOffPeak = carried.offPeakCost != null;
    const CHUNK = 5000;
    for (let i = 0; i < events.length; i++) {
      if (i % CHUNK === 0 && i > 0) {
        // 让出事件循环，使对话渲染等其他请求能穿插执行
        if (timer) await timer.timeout(0);
      }
      const ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'request/context' && ev.data && typeof (ev.data as Record<string, unknown>).model === 'string') {
        lastModel = (ev.data as Record<string, unknown>).model as string;
        continue;
      }
      if (ev.type !== 'assistant/message') continue;
      const data = (ev.data || {}) as Record<string, unknown>;
      const message = (data.message || {}) as Record<string, unknown>;
      const source = (message.source || {}) as Record<string, unknown>;
      const model = typeof source.model === 'string' ? source.model : lastModel;
      const usage = (data.usage || {}) as Record<string, unknown>;
      const time = typeof ev.time === 'number' ? ev.time : Date.now();
      const peak = isPeak(time);
      const price = priceOf(model, time, currency);
      const cost = costOf(usage, price);
      if (cost != null) {
        total += cost;
        hasCost = true;
        if (peak) {
          peakTotal += cost;
          hasPeak = true;
        } else {
          offPeakTotal += cost;
          hasOffPeak = true;
        }
      }
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      replies.push({
        messageId: typeof message.id === 'string' ? message.id : null,
        cost,
        model,
        peak,
        tokens: {
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        },
      });
    }
    return {
      replies,
      conversationCost: hasCost ? total : null,
      peakCost: hasPeak ? peakTotal : null,
      offPeakCost: hasOffPeak ? offPeakTotal : null,
    };
  }

  private maxSeq(events: Array<Record<string, unknown> & { seq?: number }>): number {
    let m = -1;
    for (const e of events) {
      if (e && typeof e.seq === 'number' && e.seq > m) m = e.seq;
    }
    return m;
  }

  /** 全量工作区费用表 */
  private async allWorkspaceCosts(currency: 'CNY' | 'USD'): Promise<MoneyWorkspaceCost[]> {
    const registry = this.ctx.get('workspaceRegistry') as
      | { list(): Array<{ id?: unknown; title?: unknown; sessionIds?: unknown }> }
      | undefined;
    if (!registry || typeof registry.list !== 'function') return [];
    let list: Array<{ id?: unknown; title?: unknown; sessionIds?: unknown }> = [];
    try {
      list = registry.list();
    } catch (e) {
      return [];
    }
    const workspaces: MoneyWorkspaceCost[] = [];
    for (const w of list) {
      const sessionIds = Array.isArray(w.sessionIds) ? (w.sessionIds as string[]) : [];
      let total = 0;
      let peakTotal = 0;
      let offPeakTotal = 0;
      let hasCost = false;
      let hasPeak = false;
      let hasOffPeak = false;
      for (const sid of sessionIds) {
        const fold = await this.foldSession(sid, currency);
        if (fold.conversationCost != null) {
          total += fold.conversationCost;
          hasCost = true;
        }
        if (fold.peakCost != null) {
          peakTotal += fold.peakCost;
          hasPeak = true;
        }
        if (fold.offPeakCost != null) {
          offPeakTotal += fold.offPeakCost;
          hasOffPeak = true;
        }
      }
      workspaces.push({
        id: typeof w.id === 'string' ? w.id : '',
        title: typeof w.title === 'string' ? w.title : '',
        cost: hasCost ? total : null,
        peakCost: hasPeak ? peakTotal : null,
        offPeakCost: hasOffPeak ? offPeakTotal : null,
        sessionCount: sessionIds.length,
      });
    }
    return workspaces;
  }

  /** 读取/设置显示币种 */
  @Remote('config')
  async config(args: { currency?: string }): Promise<MoneyConfigResult> {
    const value = args && typeof args === 'object' ? args.currency : undefined;
    if (value === 'CNY' || value === 'USD' || value === 'auto') {
      this.currencySetting = value;
      this.balanceCache = { at: 0, value: null };
      this.foldCache.clear();
    }
    return { currency: this.currencySetting };
  }

  /** 侧边栏底部余额 + 当前时段（高峰/闲时） */
  @Remote('balance')
  async balance(): Promise<MoneyBalanceResult> {
    const balance = await this.cachedBalance();
    return { balance, period: currentPeriod() };
  }

  /** 单会话费用总览（余额与费用解耦：余额网络请求不阻塞费用计算） */
  @Remote('overview')
  async overview(args: { sessionId?: string }): Promise<MoneyCostOverview | { error: string }> {
    const sessionId = args && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : null;
    if (!sessionId) return { error: 'missing sessionId' };
    // 余额：只读缓存（未过期立即返回；否则后台刷新，不等待）
    const balance = this.balanceCache.value && Date.now() - this.balanceCache.at < 60000
      ? this.balanceCache.value
      : null;
    if (!this.balanceCache.value || Date.now() - this.balanceCache.at >= 60000) {
      // 后台刷新余额（不阻塞费用响应）
      this.cachedBalance().catch(() => {});
    }
    // 币种：用当前余额缓存解析；无缓存时默认跟随（非美元 → 人民币）
    const currency = this.resolveCurrency(this.balanceCache.value || null);
    const fold = await this.foldSession(sessionId, currency);
    const last = fold.replies.length ? fold.replies[fold.replies.length - 1] : null;
    return {
      currency,
      balance,
      conversationCost: fold.conversationCost,
      peakCost: fold.peakCost,
      offPeakCost: fold.offPeakCost,
      lastReplyCost: last ? last.cost : null,
      period: currentPeriod(),
      replies: fold.replies.map((r) => ({
        messageId: r.messageId,
        cost: r.cost,
        model: r.model,
        peak: r.peak,
        tokens: r.tokens,
      })),
    };
  }

  /** 全量工作区费用表（侧边栏工作区行注入） */
  @Remote('workspacesAll')
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
