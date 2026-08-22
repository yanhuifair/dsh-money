/**
 * dsh-money — Client 半段类型入口（静态插件版）
 *
 * 构建时被打包为 lib/client.js（window.__ModuleLoader__.load 格式）。
 * 此 TS 入口仅用于 typert-generator 的 client face 分析占位；
 * 真正的客户端逻辑在 client.static.js（CommonJS，require('react')）。
 */

/** 依赖注入：slots 槽位注册、remote 命名空间、timer 定时器 */
export const inject: string[] = ['slots', 'remote', 'remote.moneyCost', 'timer'];

/** Client 插件入口 */
export function apply(ctx: any): void {
  // 运行时实现由 client.static.js 打包提供
  void ctx;
}
