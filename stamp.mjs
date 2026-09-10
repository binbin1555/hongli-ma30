/**
 * 把 shared/strategy.js 的内容指纹写进 index.html 的 CORE_VERSION。
 *
 * 为什么需要它：index.html 用动态 import 加载核心模块，URL 上带着这个指纹。
 * 不带的话浏览器会一直用缓存里的旧模块 —— 改了核心逻辑推上线后，
 * 页面会因为「找不到导出」直接白屏，而且刷新也不一定好。
 *
 * 改完 shared/strategy.js 跑一次 `npm run stamp`；忘了跑的话 `npm test` 会报错。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 指纹对行尾符不敏感：Windows/Git 的 CRLF 转换不该让版本号跳变 */
export function coreHash(text) {
  const CR = String.fromCharCode(13);
  const stripped = text.split(CR).join('');
  return createHash('sha1').update(stripped).digest('hex').slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stamp.mjs')) {
  const core = readFileSync(join(HERE, 'shared', 'strategy.js'), 'utf8');
  const hash = coreHash(core);
  const p = join(HERE, 'index.html');
  const html = readFileSync(p, 'utf8');
  if (!/const CORE_VERSION = '[^']*';/.test(html)) {
    console.error('index.html 里找不到 CORE_VERSION，结构变了？');
    process.exit(1);
  }
  writeFileSync(p, html.replace(/const CORE_VERSION = '[^']*';/, `const CORE_VERSION = '${hash}';`));
  console.log('CORE_VERSION =', hash);
}
