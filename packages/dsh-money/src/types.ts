/**
 * dsh-money — Remote 边界类型（公开导出，供 typert-generator 生成 wire schema）
 *
 * 这些类型同时被 Host 的 @Remote 方法与 Client 的调用方引用。
 */

/** 余额信息 */
export interface MoneyBalanceInfo {
  currency: string;
  total: number;
  /** 余额来源：登录账号（Platform）或 API Key；缺失时客户端按未知处理 */
  source?: 'account' | 'api-key';
}

/** 当前计费时段（按 DeepSeek 官方规则：北京时间周一至周五 9-12、14-18，法定节假日除外） */
export interface MoneyPeriod {
  /** 当前是否高峰时段（三档单价 ×2） */
  peak: boolean;
  /** 当前时段开始的时间戳（毫秒）：最近一次时段切换点 */
  since: number;
  /** 今天（北京时间自然日）0 点的时间戳（毫秒），时刻盘指针角度基准 */
  dayMidnightAt: number;
  /** 今天的高峰小时区间（0-24，如 [[9,12],[14,18]]；节假日/周末为 []） */
  dayPeakWindows: number[][];
  /** 下一次时段切换的时间戳（毫秒），客户端据此安排刷新 */
  nextChangeAt: number;
  /**
   * API 单价表（当前显示币种，闲时基准价，每百万 token）；高峰单价为 2 倍。
   * 时段/高峰弹窗展示价目用；旧版 host 未提供时弹窗退化为纯文字。
   */
  prices?: Array<{ model: string; hit: number; miss: number; out: number }> | undefined;
}

/** 单条回复 token 用量 */
export interface MoneyTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** 单条回复费用 */
export interface MoneyReplyCost {
  messageId: string | null;
  cost: number | null;
  model: string;
  /** 该条回复发生时段是否为高峰（单价 ×2） */
  peak: boolean;
  /** 本地/未计价模型：cost 按 Flash 规则（同时段，高峰 ×2）模拟，不计入 API 消费 */
  sim: boolean;
  tokens: MoneyTokens;
}

/** 会话费用总览 */
export interface MoneyCostOverview {
  currency: string;
  balance: MoneyBalanceInfo | null;
  conversationCost: number | null;
  /** 本地模型模拟费用合计（不计入 API 消费/7 天柱状图） */
  simCost: number | null;
  /** 高峰时段部分的费用合计 */
  peakCost: number | null;
  /** 闲时部分的费用合计 */
  offPeakCost: number | null;
  lastReplyCost: number | null;
  period: MoneyPeriod;
  replies: Array<{
    messageId: string | null;
    cost: number | null;
    model: string;
    peak: boolean;
    tokens: MoneyTokens;
  }>;
}

/** 工作区费用条目 */
export interface MoneyWorkspaceCost {
  /** 工作区 id（侧边栏行的 data-row-key 使用同一 id） */
  id: string;
  title: string;
  cost: number | null;
  /** 本地模型模拟费用合计（不计入 API 消费） */
  simCost: number | null;
  /** 高峰时段部分的费用合计 */
  peakCost: number | null;
  /** 闲时部分的费用合计 */
  offPeakCost: number | null;
  sessionCount: number;
}

/** 全量工作区费用表 */
/** 单日消费（date = MM-DD，按北京时间自然日） */
export interface MoneyDayCost {
  date: string;
  cost: number;
}

export interface MoneyWorkspacesAll {
  /** 最近 7 个自然日（含今天，新→旧）的总消费，缺数据的日子为 0 */
  days: MoneyDayCost[];
  /** 最近 7 天本地模型模拟费用（与 days 同日序，供「本地」弹窗柱状图） */
  simDays: MoneyDayCost[];
  /** 已删除会话保留下来的本地消费（总账不因删除会话而减少） */
  retainedSimCost?: number;
  currency: string;
  workspaces: MoneyWorkspaceCost[];
}

/** 显示币种设置 */
export interface MoneyConfigResult {
  currency: 'auto' | 'CNY' | 'USD';
}

/** 余额查询结果 */
export interface MoneyBalanceResult {
  balance: MoneyBalanceInfo | null;
  period: MoneyPeriod;
}
