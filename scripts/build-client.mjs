#!/usr/bin/env node
/**
 * 将 `src/client/*.js` 按文件名顺序拼装成 DSH 单文件客户端 `client.js`
 * （DSH 使用 `window.__ModuleLoader__.load` 单文件加载，不支持浏览器相对 ESM import）。
 *
 * 用法：
 *   node scripts/build-client.mjs          # 重新生成 client.js
 *   node scripts/build-client.mjs --check  # 校验 client.js 与 src/client/ 一致
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS_DIR = path.join(ROOT, 'src', 'client');
const OUT_FILE = path.join(ROOT, 'client.js');
const PART_WARN_BYTES = 65 * 1024;

const parts = fs.readdirSync(PARTS_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

if (parts.length === 0) {
  console.error('[build-client] src/client/ 下没有 .js 分片');
  process.exit(1);
}

const chunks = parts.map((f) => {
  const code = fs.readFileSync(path.join(PARTS_DIR, f), 'utf8');
  if (Buffer.byteLength(code, 'utf8') > PART_WARN_BYTES) {
    console.warn(`[build-client] 警告: ${f} 体积 ${(Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)} KB (>65 KB)，建议继续拆分`);
  }
  return code;
});

const built = chunks.join('');

try {
  new vm.Script(built, { filename: 'client.js' });
} catch (err) {
  console.error(`[build-client] 拼接后语法校验失败: ${err?.message ?? err}`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== built) {
    console.error('[build-client] client.js 与 src/client/ 不一致，请运行: npm run build:client');
    process.exit(1);
  }
  console.log(`[build-client] OK (${parts.length} parts, ${built.length} bytes)`);
} else {
  fs.writeFileSync(OUT_FILE, built, 'utf8');
  console.log(`[build-client] 已生成 client.js (${parts.length} parts, ${built.length} bytes)`);
}
