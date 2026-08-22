/**
 * dsh-money — Client 打包入口（esbuild 聚合）
 *
 * 职责：把 typert-generator 生成的 TYPERT_REMOTE 远端贡献（lib/typert.remote-client.js）
 * 与 client.static.js 的 UI 逻辑合入单一 __ModuleLoader__ bundle。
 *
 * 为什么需要这一层：
 *  - 客户端 remote.<namespace> 服务（如 remote.moneyCost）必须由插件显式调用
 *    ctx.remote.$mount(contribution) 挂载后才存在；
 *  - 因此 inject 不能声明 remote.moneyCost（挂载前它不存在，会导致启动死锁
 *    "waiting for service: remote.moneyCost"）；
 *  - 正确顺序：apply() 内先 await 挂载，再使用 ctx.remote.moneyCost。
 *
 * 构建产物与 @deepseek-ai/dsh-api-remotes 的 client bundle 同构：
 * esbuild bundle:true 会把 zod v4 schema 内联进包，仅 react 走外部 require。
 */

import { TYPERT_REMOTE } from '../lib/typert.remote-client.js';
import * as clientStatic from './client.static.cjs';

/** 依赖注入：slots 槽位注册、remote 命名空间服务、timer 定时器 */
export const inject = ['slots', 'remote', 'timer'];

/** Client 插件入口：先挂载 moneyCost 远端命名空间，再启动 UI 逻辑 */
export async function apply(ctx) {
  // 挂载 dsh-money 的远端贡献 → 创建 remote.moneyCost 命名空间服务
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  // 委托给静态 UI 实现（内部使用 ctx.remote.moneyCost.*）
  const clientDispose = clientStatic.apply(ctx);
  // 返回组合 disposer：卸载时先摘除远端命名空间，再清理 UI
  return async () => {
    try {
      await disposeRemote();
    } catch (e) {
      // 忽略卸载竞态
    }
    if (typeof clientDispose === 'function') {
      try {
        await clientDispose();
      } catch (e) {
        // 忽略卸载竞态
      }
    }
  };
}
