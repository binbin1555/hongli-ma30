/**
 * Bark 服务器「既不成功也不报错、一直挂着」时，推送必须在有限时间内放弃，
 * 并留下一条「失败」记录 —— 而不是像 2026-09-18 那样无声消失。
 *
 * 用一个永远不回的假 Bark 复现那天的情形，把超时调短到 150 毫秒好让测试跑得快。
 * 再配一个看门狗：如果 bark() 6 秒内还没返回，就判定「推送请求挂死了，没有超时」。
 *
 * 用法：npm run push-timeout
 */
let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const { bark } = await import('../worker/src/index.js');
const env = { BARK_KEY: 'test-key-not-real', BARK_TIMEOUT_MS: 150 };

/** 假 Bark：mode 决定它怎么「坏」 */
let mode = 'hang', calls = 0;
globalThis.fetch = (url, opts = {}) => {
  calls++;
  if (!String(url).includes('api.day.app')) return Promise.reject(new Error('测试里不该请求别的地址'));
  if (mode === 'ok') return Promise.resolve(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
  if (mode === 'slow-then-ok' && calls >= 2) {
    return Promise.resolve(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
  }
  // 挂住：永远不 resolve 也不 reject —— 只有被 abort 时才结束
  return new Promise((_, reject) => {
    const sig = opts.signal;
    if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
};

const watchdog = (ms) => new Promise((r) => setTimeout(() => r('__挂死__'), ms));

console.log('\n【一】Bark 一直不回（09-18 那天的情形）');
mode = 'hang'; calls = 0;
let t = Date.now();
const r1 = await Promise.race([bark(env, { title: '测试', body: '测试' }), watchdog(6000)]);
const took = Date.now() - t;
if (r1 === '__挂死__') {
  bad('6 秒过去了 bark() 还没返回 —— 推送请求挂死，没有超时。线上就会一直等到被 Cloudflare 掐掉，什么都不留');
} else {
  console.log(`  ${took} 毫秒后返回，尝试了 ${calls} 次：ok=${r1.ok}　原因「${r1.reason}」`);
  if (r1.ok) bad('Bark 根本没回，却记成了成功');
  else if (!/没有响应/.test(r1.reason || '')) bad(`失败原因没说清是超时：「${r1.reason}」`);
  else ok('挂住的请求被及时放弃，并明确记成「超时没有响应」');
  if (calls !== 3) bad(`应当重试到 3 次，实际 ${calls} 次`);
  else ok('三次重试都用上了，不是第一次挂住就卡死');
}

console.log('\n【二】第一次挂住、第二次就通了（09-16 那种慢）');
mode = 'slow-then-ok'; calls = 0;
const r2 = await Promise.race([bark(env, { title: '测试', body: '测试' }), watchdog(6000)]);
if (r2 === '__挂死__') bad('第一次挂住就卡死，第二次没机会');
else if (!r2.ok) bad(`第二次本该成功，结果记成失败：「${r2.reason}」`);
else ok(`第 ${calls} 次成功送达 —— 超时让重试真正派上了用场`);

console.log('\n【三】正常情况不受影响');
mode = 'ok'; calls = 0;
const r3 = await bark(env, { title: '测试', body: '测试' });
if (!r3.ok || calls !== 1) bad(`正常推送该一次成功，实际 ok=${r3.ok}、请求 ${calls} 次`);
else ok('正常推送一次就成，没有多余请求');

console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ Bark 挂住时推送会在有限时间内放弃并留下失败记录'}\n`);
process.exitCode = fails ? 1 : 0;
