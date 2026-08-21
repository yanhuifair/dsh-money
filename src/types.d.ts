/**
 * dsh-money — 类型声明（最小化）
 *
 * 本包以动态 Cordis 插件形式使用：host/client 代码通过 DSH 会话中的
 * cordis_define 加载。此声明仅满足 npm 发布时的 types 字段，不提供
 * 运行时类型检查。
 */

export interface MoneyBalanceInfo {
  currency: string;
  total: number;
}

export interface MoneyReplyCost {
  messageId: string | null;
  cost: number | null;
  model: string;
  tokens: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
}

export interface MoneyOverview {
  currency: 'CNY' | 'USD';
  balance: MoneyBalanceInfo | null;
  conversationCost: number | null;
  lastReplyCost: number | null;
  replies: MoneyReplyCost[];
}

declare const plugin: {
  name: string;
  apply(ctx: unknown): void;
};

export default plugin;
