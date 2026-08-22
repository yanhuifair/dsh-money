/**
 * dsh-money — Client 打包入口（esbuild 聚合）
 *
 * 职责：把 typert-generator 生成的 TYPERT_REMOTE 远端贡献（lib/typert.remote-client.js）
 * 与 client.static.cjs 的 UI 逻辑合入单一 __ModuleLoader__ bundle。
 *
 * 为什么需要这一层（cordis 服务注入机制）：
 *  - 客户端 remote.<namespace> 服务（如 remote.moneyCost）必须由插件显式调用
 *    ctx.remote.$mount(contribution) 挂载后才存在（provide 写入 root 共享的
 *    reflect store，所有 ctx 可见）；
 *  - 但 `ctx.remote.moneyCost` 属性访问走 fiber 链 store 查找，仅当该服务被
 *    inject 绑定到当前 fiber 的 store 才可命中 —— 因此不能在顶层 inject 里声明
 *    remote.moneyCost（挂载前会死锁），而要在 $mount 之后用 ctx.inject 动态注入；
 *  - 该模式与官方 @deepseek-ai/dsh-client-ui-commands 的
 *    inject ['remote.commands'] + ctx.remote.commands.* 完全一致。
 *
 * 构建产物与 @deepseek-ai/dsh-api-remotes 的 client bundle 同构：
 * esbuild bundle:true 会把 zod v4 schema 内联进包，仅 react 走外部 require。
 */

import { TYPERT_REMOTE } from '../lib/typert.remote-client.js';
import * as clientStatic from './client.static.cjs';

/** 顶层依赖注入：slots 槽位、remote 命名空间服务、timer 定时器（不含 remote.moneyCost） */
export const inject = ['slots', 'remote', 'timer'];

/** Client 插件入口：先挂载 moneyCost 远端命名空间，再动态注入后启动 UI 逻辑 */
export async function apply(ctx) {
  // 1. 挂载 dsh-money 的远端贡献 → 创建 remote.moneyCost 命名空间服务
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  // 2. 挂载完成后动态注入 remote.moneyCost：其回调 scope 的 fiber store 已绑定
  //    该服务，scope.remote.moneyCost 可安全访问（UI 实现内部使用它）
  ctx.inject(['remote.moneyCost'], (scope) => {
    try {
      clientStatic.apply(scope);
    } catch (e) {
      console.error('[dsh-money] client UI error:', e);
    }
  });
  // 3. 返回 disposer：卸载时摘除远端命名空间（UI 子 fiber 随父级自动卸载）
  return async () => {
    try {
      await disposeRemote();
    } catch (e) {
      // 忽略卸载竞态
    }
  };
}
