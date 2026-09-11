/**
 * 一条命令回答「线上跑的是不是我本地这一版」。
 *
 *   npm run check:deploy -- https://你的worker地址.workers.dev
 *
 * 它拿本地源码算出 BUILD 指纹，再去请求线上的 /health 比对。
 * Cloudflare 的构建记录只能告诉你「某次构建成功了」，不能告诉你
 * 此刻在跑的到底是哪一版 —— 这个脚本能。
 *
 * Worker 地址不写进仓库：仓库是公开的，而 /health 不鉴权，
 * 写进去等于把一个免鉴权端点挂到搜索引擎上。所以每次从命令行传，
 * 或者设环境变量 WORKER_URL。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHash } from '../stamp.mjs';
import { posPct } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 这个脚本发过网络请求，之后一律不能调 process.exit()：
// Windows 上 undici 的 socket 还没关，libuv 会当场断言崩溃，
// 把真正的结论淹没在一行 C 语言报错里。改成设 exitCode 让进程自然退出。
const fail = (msg) => { console.log(msg); process.exitCode = 1; };

const raw = process.argv[2] || process.env.WORKER_URL;
if (!raw) {
  console.log(`
  用法：npm run check:deploy -- <worker 地址>

  例：  npm run check:deploy -- https://hongli-ma30.xxxxx.workers.dev

  也可以设环境变量 WORKER_URL 之后直接 npm run check:deploy。
`);
  process.exit(2);   // 还没联网，这里用 exit 是安全的
}
const base = raw.replace(/\/+$/, '').replace(/\/health$/, '');

const want = buildHash(
  readFileSync(join(ROOT, 'worker', 'src', 'index.js'), 'utf8'),
  readFileSync(join(ROOT, 'shared', 'strategy.js'), 'utf8'),
);

let res = null;
try {
  res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(20000) });
} catch (e) {
  fail(`\n  !!! 连不上 ${base}/health\n      ${String(e && e.message || e)}\n`);
}

if (res && !res.ok) {
  fail(`\n  !!! ${base}/health 返回 HTTP ${res.status}\n`);
} else if (res) {
  const h = await res.json();
  const got = h.build;

  console.log(`\n  本地源码 BUILD  ${want}`);
  console.log(`  线上 /health    ${got || '（这一版还没有 build 字段）'}`);
  console.log(`  线上北京时间    ${h.now}`);
  // 仓位一律用百分比，别写成「N/5 档」——「4/5」会被读成还差一档，其实已经满仓
  console.log(`  数据截至        ${h.stateAsof}　仓位 ${posPct(h.tier)}　挂单 `
    + (h.pending ? `${posPct(h.pending.tierFrom)}→${posPct(h.pending.tierTo)}（信号日 ${h.pending.signalDate}）` : '无'));
  if (h.checks) {
    const f = (h.checks.failed || []).map((x) => x.name).join('、');
    console.log(`  上次运行        ${h.checks.ranAt}　校验 ${h.checks.passed}/${h.checks.total}${f ? `　未过：${f}` : ''}`);
  }
  if (h.push && !h.push.ok) console.log(`  !!! 上次推送失败：${h.push.error || '原因未记录'}`);

  if (got === want) {
    console.log('\n  OK  线上跑的就是本地这一版 ✓\n');
  } else {
    fail(got
      ? '\n  !!! 版本对不上 —— 线上还是旧代码。去 Cloudflare 看构建记录，或跑 npm run deploy。\n'
      : '\n  !!! 线上这一版还没有 BUILD 字段，说明部署的是加版本号之前的代码。\n');
  }
}
