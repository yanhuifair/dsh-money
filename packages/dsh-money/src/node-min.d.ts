// 最小 Node 内置模块声明：本插件只用到 fs/os/path 的少数函数，
// 避免为三个函数引入整套 @types/node（保持依赖与 types 配置轻量）。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function renameSync(from: string, to: string): void;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
}
declare module 'node:os' {
  export function homedir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}
