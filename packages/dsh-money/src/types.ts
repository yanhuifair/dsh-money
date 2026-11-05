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
  /** 下一次时段切换的时间戳（毫秒），客户端据此安排刷新 */
  nextChangeAt: number;
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
  tokens: MoneyTokens;
}

/** 会话费用总览 */
export interface MoneyCostOverview {
  currency: string;
  balance: MoneyBalanceInfo | null;
  conversationCost: number | null;
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
  sessionCount: number;
}

/** 全量工作区费用表 */
export interface MoneyWorkspacesAll {
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
