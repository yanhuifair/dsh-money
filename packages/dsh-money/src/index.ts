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
import z from '@deepseek-ai/schemastery';
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

/**
 * 显示设置：注册到 DSH settings 服务，写入用户层文档（$DSH_HOME/settings.yaml），
 * 因此重启后仍然生效；没有 settings 服务时退回组合入口（cordis.patch.yml）的 config。
 */
const SETTINGS_NS = 'dsh-money';

const SETTINGS_SCHEMA = z.object({
  currency: z.union(['auto', 'CNY', 'USD']).default('auto'),
  showBalance: z.boolean().default(true),
});

interface MoneySettings {
  currency: 'auto' | 'CNY' | 'USD';
  showBalance: boolean;
}

/** settings 服务所需的最小契约（只用到 update） */
interface SettingsWriter {
  update(ns: string, patch: object): Promise<void>;
}

/** installSection 所需的最小契约 */
interface SettingsSections {
  installSection(
    owner: Context,
    ns: string,
    schema: unknown,
    entry: MoneySettings,
    hooks: { setSource(current: () => MoneySettings): void; onChange(): void },
  ): void;
}

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
  /** 组合入口（cordis.patch.yml 的 config）作为 settings 的 base 与回退值 */
  static Config = SETTINGS_SCHEMA;

  /** 组合入口配置：无 settings 服务时的权威值 */
  private entry: MoneySettings = { currency: 'auto', showBalance: true };
  /** 已挂载 settings 时的实时读取器（persist 层优先，其次 entry） */
  private live: (() => MoneySettings) | null = null;
  /** 落盘失败时的进程内覆盖（优先级最高，直到下一次成功写入或外部变更） */
  private override: Partial<MoneySettings> = {};
  private balanceCache: { at: number; value: MoneyBalanceInfo | null } = { at: 0, value: null };

  constructor(ctx: Context, config?: Partial<MoneySettings>) {
    super(ctx, 'moneyCost');
    this.entry = {
      currency: config && (config.currency === 'CNY' || config.currency === 'USD' || config.currency === 'auto')
        ? config.currency
        : 'auto',
      showBalance: !(config && config.showBalance === false),
    };
    // settings 服务可能后于本插件挂载，故用动态 inject 等待
    ctx.inject(['settings'], (settingsCtx: Context) => {
      const provider = settingsCtx.get('settings') as (SettingsSections | undefined);
      if (!provider || typeof provider.installSection !== 'function') return;
      try {
        provider.installSection(ctx, SETTINGS_NS, SETTINGS_SCHEMA, this.entry, {
          setSource: (current: () => MoneySettings) => { this.live = current; },
          onChange: () => {
            // 外部（持久层）已提交新值：撤掉进程内覆盖，并清缓存按新口径重算
            this.override = {};
            this.balanceCache = { at: 0, value: null };
            if (this.foldCache) this.foldCache.clear();
          },
        });
      } catch (e) {
        // 注册失败（如命名空间冲突）时退回组合入口配置，不影响计价
        this.live = null;
      }
    });
  }

  /** 当前生效设置：外部持久层 → 进程内覆盖（仅在落盘失败时存在） */
  private settings(): MoneySettings {
    const base = this.live ? this.live() : this.entry;
    const merged = { ...base, ...this.override };
    return {
      currency: merged.currency === 'CNY' || merged.currency === 'USD' ? merged.currency : 'auto',
      showBalance: merged.showBalance !== false,
    };
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
    // 用宿主进程的 fetch，而不是 shell + curl：
    //  1) 与 @deepseek-ai/dsh-llm-deepseek 走同一条路径（globalThis.fetch + 全局
    //     undici dispatcher），因此遵守 DSH 的代理配置；
    //  2) shell 出网会被沙箱按部署默认策略（workspace-write）执行，Windows 受限
    //     令牌下 curl 的 Schannel 会 AcquireCredentialsHandle 失败
    //     （SEC_E_NO_CREDENTIALS），余额永远取不到；
    //  3) 免去 Windows 上 `curl` 被 PowerShell 别名成 Invoke-WebRequest 的坑。
    let resp: Response;
    try {
      resp = await fetch(`${baseURL.replace(/\/+$/, '')}/user/balance`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      return null;
    }
    if (!resp.ok) return null;
    let body: { balance_infos?: Array<Record<string, unknown>> };
    try {
      body = await resp.json() as { balance_infos?: Array<Record<string, unknown>> };
    } catch (e) {
      return null;
    }
    if (!body || !Array.isArray(body.balance_infos) || !body.balance_infos.length) return null;
    const currency = this.settings().currency;
    const wanted = currency === 'CNY' || currency === 'USD' ? currency : null;
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
    const currency = this.settings().currency;
    if (currency === 'CNY' || currency === 'USD') return currency;
    return balance && balance.currency === 'USD' ? 'USD' : 'CNY';
  }

  /** 会话折叠增量状态：记录最后处理的 seq，只折叠新增事件（key = sessionId + currency） */
  private foldCache = new Map<string, { replies: MoneyReplyCost[]; conversationCost: number | null; lastSeq: number }>();
  private readonly FOLD_TTL_MS = 60000;

  /** 折叠会话：增量处理（只读新增事件并追加，避免重复遍历整个日志） */
  private async foldSession(
    sessionId: string,
    currency: 'CNY' | 'USD',
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null }> {
    const key = sessionId + '::' + currency;
    const cached = this.foldCache.get(key);
    const sessionQuery = this.ctx.get('sessionQuery') as { readSession(id: string): Promise<{ events?: Array<Record<string, unknown> & { seq?: number }> } | undefined> } | undefined;
    if (!sessionQuery) return cached ? cached : { replies: [], conversationCost: null };
    let events: Array<Record<string, unknown> & { seq?: number }> = [];
    try {
      const snap = await sessionQuery.readSession(sessionId);
      events = snap && Array.isArray(snap.events) ? (snap.events as Array<Record<string, unknown> & { seq?: number }>) : [];
    } catch (e) {
      return cached ? { replies: cached.replies, conversationCost: cached.conversationCost } : { replies: [], conversationCost: null };
    }
    // 增量：从缓存的 lastSeq 之后继续；无缓存则全量
    const fromSeq = cached ? cached.lastSeq : -1;
    const freshReplies: MoneyReplyCost[] = cached ? [...cached.replies] : [];
    let total = cached ? (cached.conversationCost ?? 0) : 0;
    let hasCost = cached ? cached.conversationCost != null : false;
    // 只处理 seq > fromSeq 的新增事件
    const newEvents = fromSeq >= 0 ? events.filter((e) => (e && typeof e.seq === 'number') ? e.seq > fromSeq : true) : events;
    const fold = await this.foldEvents(newEvents, currency, freshReplies, total, hasCost, cached ? true : false);
    // 更新缓存（重置 TTL）
    this.foldCache.set(key, {
      replies: fold.replies,
      conversationCost: fold.conversationCost,
      lastSeq: this.maxSeq(events),
    });
    return { replies: fold.replies, conversationCost: fold.conversationCost };
  }

  /** 批量折叠事件（分片异步处理，避免长任务阻塞事件循环） */
  private async foldEvents(
    events: Array<Record<string, unknown> & { seq?: number }>,
    currency: 'CNY' | 'USD',
    replies: MoneyReplyCost[],
    total: number,
    hasCost: boolean,
    incremental: boolean,
  ): Promise<{ replies: MoneyReplyCost[]; conversationCost: number | null }> {
    const timer = this.ctx.get('timer') as { timeout(ms: number): Promise<void> } | undefined;
    let lastModel = 'deepseek-v4-flash';
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
      const model =
        typeof source.model === 'string' ? source.model : lastModel;
      const usage = (data.usage || {}) as Record<string, unknown>;
      const price = priceOf(model, typeof ev.time === 'number' ? ev.time : Date.now(), currency);
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

  private maxSeq(events: Array<Record<string, unknown> & { seq?: number }>): number {
    let m = -1;
    for (const e of events) {
      if (e && typeof e.seq === 'number' && e.seq > m) m = e.seq;
    }
    return m;
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

  /**
   * 读取/设置显示设置。
   * 传参即写入（持久化到 DSH settings 用户层）；不传参只读取。
   */
  @Remote("config")
  async config(args: { currency?: string; showBalance?: boolean }): Promise<MoneyConfigResult> {
    const a = args && typeof args === 'object' ? args : {};
    const patch: { currency?: 'auto' | 'CNY' | 'USD'; showBalance?: boolean } = {};
    if (a.currency === 'CNY' || a.currency === 'USD' || a.currency === 'auto') patch.currency = a.currency;
    if (typeof a.showBalance === 'boolean') patch.showBalance = a.showBalance;
    if (patch.currency !== undefined || patch.showBalance !== undefined) {
      const provider = this.ctx.get('settings') as (SettingsWriter | undefined);
      let persisted = false;
      if (provider && typeof provider.update === 'function') {
        try {
          await provider.update(SETTINGS_NS, patch);
          persisted = true;
        } catch (e) {
          // 落盘失败（如只读文档）
          persisted = false;
        }
      }
      if (persisted) {
        this.override = {};
      } else {
        // 保证开关当下生效；重启后回到持久值
        this.override = { ...this.override, ...patch };
        if (!provider) this.entry = { ...this.entry, ...patch };
      }
      this.balanceCache = { at: 0, value: null };
      if (this.foldCache) this.foldCache.clear();
    }
    const current = this.settings();
    return { currency: current.currency, showBalance: current.showBalance };
  }

  /** 侧边栏底部余额 */
  @Remote("balance")
  async balance(): Promise<{ balance: MoneyBalanceInfo | null }> {
    const balance = await this.cachedBalance();
    return { balance };
  }

  /** 单会话费用总览（余额与费用解耦：余额网络请求不阻塞费用计算） */
  @Remote("overview")
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
