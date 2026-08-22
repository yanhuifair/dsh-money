/**
 * dsh-money 构建脚本：
 *  1. typert-generator 从 packages/dsh-money/src 分析生成
 *     packages/dsh-money/lib/typert.host.js + typert.remote-client.js
 *  2. tsc 编译 host 半段 → packages/dsh-money/lib/index.js + index.d.ts
 *  3. 生成 client bundle packages/dsh-money/lib/client.js（__ModuleLoader__ 格式）
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, 'packages', 'dsh-money');
const lib = join(pkg, 'lib');

// 1. typert-generator 生成 remote 产物
console.log('[1/3] typert-generator 生成 remote 产物 → lib/');
rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
const { WorkspaceTypertGenerator } = await import('@deepseek-ai/dsh-typert-generator');
const generator = new WorkspaceTypertGenerator(root);
const results = generator.generate(['dsh-money']);
let remoteEmitted = false;
let hostEmitted = false;
for (const result of results) {
  if (result.face !== 'host') continue;
  writeFileSync(join(lib, 'typert.host.js'), result.js);
  writeFileSync(join(lib, 'typert.host.d.ts'), result.dts);
  if (result.remote) {
    writeFileSync(join(lib, 'typert.remote-client.js'), result.remote.js);
    writeFileSync(join(lib, 'typert.remote-client.d.ts'), result.remote.dts);
    writeFileSync(join(lib, 'typert.remote-client.d.ts.map'), result.remote.dtsMap);
    remoteEmitted = true;
  }
  hostEmitted = true;
  console.log(`  emitted: ${result.package} (${result.face}) js=${result.js.length} remote=${result.remote ? result.remote.js.length : 'none'}`);
}
if (!hostEmitted) console.warn('  ⚠️ 未生成任何 host 产物，检查 tsconfig.host.json 引用与 @Remote 声明');
if (!remoteEmitted) console.warn('  ⚠️ 未生成 remote-client 产物');

// 2. tsc 编译 host 半段（types 保留给 generator 已验证的源码）
console.log('[2/3] tsc 编译 host 半段 → lib/');
execSync('npx tsc -p packages/dsh-money/tsconfig.json', { cwd: root, stdio: 'inherit' });

// 3. client bundle
console.log('[3/3] 生成 client bundle → lib/client.js');
const clientSrc = readFileSync(join(pkg, 'src', 'client.static.js'), 'utf8');
const bundle = `window.__ModuleLoader__.load({
	id: "dsh-money",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${clientSrc.split('\n').map((l) => '\t\t' + l).join('\n')}
		return module.exports;
	}
});
`;
writeFileSync(join(lib, 'client.js'), bundle);
writeFileSync(join(lib, 'client.d.ts'), `export declare const inject: string[];\nexport declare function apply(ctx: any): void;\n`);
console.log('  打包完成，大小: ' + bundle.length + ' bytes');

console.log('\n✅ 构建完成 → ' + lib);
