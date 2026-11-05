# @deepseek-ai/dsh-typert-protocol（类型副本，仅用于代码生成）

`packages/typert-protocol` 不是发布包，也不会进入 `lib/` 产物。它是
`@deepseek-ai/dsh-typert-protocol` 的**类型声明副本**，`src/*.ts` 直接来自
已安装的 `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/*.d.ts`
（把 `.d.ts` 改名为 `.ts`，以支持其内部的 `./x.ts` 引用写法）。

为什么需要它：`@deepseek-ai/dsh-typert-generator` 按「工作区 packages/ 下的
TS 工程」识别 Typert 元数据；`@Remote` / `TypertRemoteService` 的声明必须位于
`tsconfig.host.json` 引用且位于 `packages/` 下的工程里，生成器才会把
`MoneyCostService` 的方法识别为 Remote 方法。

升级 DSH 时（例如 0.2.2）：

```bash
cp node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/*.d.ts packages/typert-protocol/src/
cd packages/typert-protocol/src && for f in *.d.ts; do mv "$f" "${f%.d.ts}.ts"; done
```

并把 `package.json` 的 `version` 与 `packages/dsh-money/package.json` 里的
`devDependencies` / `engines.dsh` 一起更新。`src/owned-value.ts` 里的
`TypertOwnedValue` 已把 `extends Disposable` 展开为显式 `[Symbol.dispose]()`，
因为生成器无法解析全局 `Disposable` 的 heritage 子句。
