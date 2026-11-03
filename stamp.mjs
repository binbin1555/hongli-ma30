/**
 * 盖两个章：
 *
 * 1. CORE_VERSION —— shared/strategy.js 的内容指纹，写进 index.html。
 *    index.html 用动态 import 加载核心模块，URL 上带着这个指纹。不带的话
 *    浏览器会一直用缓存里的旧模块 —— 改了核心逻辑推上线后，页面会因为
 *    「找不到导出」直接白屏，而且刷新也不一定好。
 *
 * 2. BUILD —— worker 源码 + 两个核心模块的联合指纹，写回 worker/src/index.js。
 *    /health 会返回它，用来从外面确认线上跑的到底是哪一版。
 *
 * 3. REBOUND_VERSION —— shared/rebound.js 的内容指纹，写进 rebound.html（创业板50 那页），
 *    理由同 1。
 *
 * 改完 shared/strategy.js、shared/rebound.js 或 worker/src/index.js 跑一次 `npm run stamp`；
 * 忘了跑的话 `npm test` 会报错。
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

const BUILD_RE = /const BUILD = '[^']*';/;

/**
 * Worker 的构建指纹。
 * 算之前先把 BUILD 那一行本身抹平 —— 否则写回去的动作会改变文件内容，
 * 下一次算出来又是另一个值，永远盖不稳。
 */
export function buildHash(workerText, coreText, reboundText = '') {
  const CR = String.fromCharCode(13);
  const flat = (t) => t.split(CR).join('');
  const norm = flat(workerText).replace(BUILD_RE, "const BUILD = '';");
  // 创业板50 那一路的核心（shared/rebound.js）也打进 Worker，一样算进指纹
  const rb = reboundText ? `\u0000${flat(reboundText)}` : '';
  return createHash('sha1').update(`${norm}\u0000${flat(coreText)}${rb}`).digest('hex').slice(0, 10);
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
  console.log('CORE_VERSION =', hash, ' → index.html');

  const rb = readFileSync(join(HERE, 'shared', 'rebound.js'), 'utf8');
  const rbHash = coreHash(rb);
  const rp = join(HERE, 'rebound.html');
  const rhtml = readFileSync(rp, 'utf8');
  if (!/const REBOUND_VERSION = '[^']*';/.test(rhtml)) {
    console.error('rebound.html 里找不到 REBOUND_VERSION，结构变了？');
    process.exit(1);
  }
  writeFileSync(rp, rhtml.replace(/const REBOUND_VERSION = '[^']*';/, `const REBOUND_VERSION = '${rbHash}';`));
  console.log('REBOUND_VERSION =', rbHash, ' → rebound.html');

  const wp = join(HERE, 'worker', 'src', 'index.js');
  const worker = readFileSync(wp, 'utf8');
  if (!BUILD_RE.test(worker)) {
    console.error('worker/src/index.js 里找不到 BUILD，结构变了？');
    process.exit(1);
  }
  const bh = buildHash(worker, core, rb);
  writeFileSync(wp, worker.replace(BUILD_RE, `const BUILD = '${bh}';`));
  console.log('BUILD        =', bh, ' → worker/src/index.js（/health 会返回它）');
}
