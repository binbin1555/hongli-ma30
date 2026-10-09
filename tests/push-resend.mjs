/**
 * 补发推送：今天跑过了、账本提交了，但推送没送达 —— 再调一次 /run 时要照原样补发，
 * 而且绝不能重新记账、绝不能重复推送。
 *
 * 走的是 Worker 真正的 /run 入口，GitHub 和 Bark 用内存里的假件代替：
 * 假 GitHub 真的能读文件、真的能提交（blob → tree → commit → 改 ref），
 * 所以「有没有重新记账」「回填了什么」都能从它的提交记录里直接核对。
 *
 * 用法：npm run push-resend
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

/* ---------------- 时钟：钉在北京时间某一刻 ----------------
 * 只换 Date.now 不够：worker 的 beijingStamp() 用的是 new Date()，不经过 Date.now。
 * 只换一半的话，worker 看到的还是真实时间 —— 实测踩过：明明设在 22:30，
 * 它算出来离 21:00 是负几个小时，于是判定「那一轮还在发推送」，补发根本没发生，
 * 而「刚跑完 3 分钟不补发」那条反倒因为同一个错误蒙对了。
 */
const RealDate = Date;
let fakeNow = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
  static now() { return fakeNow ?? RealDate.now(); }
};
const at = (bj) => { fakeNow = RealDate.parse(bj.replace(' ', 'T') + 'Z') - 8 * 3600000; };
const REAL_RESET = () => { fakeNow = null; };

/* ---------------- 假 GitHub ---------------- */
const BR = 'master';
let files, blobs, trees, commits, head, log;
function resetRepo(init) {
  files = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  blobs = new Map(); trees = new Map(); commits = new Map([['c0', { tree: 't0' }]]); head = 'c0'; log = [];
  trees.set('t0', { entries: [] });
}
let n = 0;
const sha = (p) => `${p}${++n}`;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

/* ---------------- 假 Bark ---------------- */
let barkMode = 'ok', barks = [];

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const m = opts.method || 'GET';
  if (url.startsWith('https://api.day.app/')) {
    const body = JSON.parse(opts.body);
    barks.push(body);
    if (barkMode === 'ok') return json({ code: 200 });
    if (barkMode === 'err') return json({ code: 400, message: 'device key 无效' });
    return new Promise((_, rej) => opts.signal && opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  const base = 'https://api.github.com/repos/o/r';
  if (!url.startsWith(base)) throw new Error(`测试里不该请求 ${url}`);
  const p = url.slice(base.length);
  let mm;
  if ((mm = p.match(/^\/contents\/(.+)\?ref=/))) {
    const f = files.get(mm[1]);
    if (f == null) return json({ message: 'Not Found' }, 404);
    return json({ content: Buffer.from(f, 'utf8').toString('base64') });
  }
  if (p === `/git/ref/heads/${BR}`) return json({ object: { sha: head } });
  if ((mm = p.match(/^\/git\/commits\/(\w+)$/))) return json({ tree: { sha: commits.get(mm[1]).tree } });
  const b = opts.body ? JSON.parse(opts.body) : null;
  if (p === '/git/blobs' && m === 'POST') { const s = sha('b'); blobs.set(s, Buffer.from(b.content, 'base64').toString('utf8')); return json({ sha: s }); }
  if (p === '/git/trees' && m === 'POST') { const s = sha('t'); trees.set(s, { entries: b.tree }); return json({ sha: s }); }
  if (p === '/git/commits' && m === 'POST') { const s = sha('c'); commits.set(s, { tree: b.tree, message: b.message, parent: b.parents[0] }); return json({ sha: s }); }
  if (p === `/git/refs/heads/${BR}` && m === 'PATCH') {
    const c = commits.get(b.sha);
    if (c.parent !== head) return json({ message: 'not fast-forward' }, 422);
    for (const e of trees.get(c.tree).entries) files.set(e.path, blobs.get(e.sha));
    head = b.sha; log.push(c.message);
    return json({ ok: true });
  }
  throw new Error(`假 GitHub 不认识：${m} ${p}`);
};

const { default: worker } = await import('../worker/src/index.js');
const env = {
  RUN_TOKEN: 'T', GITHUB_TOKEN: 'x', GH_OWNER: 'o', GH_REPO: 'r', GH_BRANCH: BR,
  BARK_KEY: 'k', PRINCIPAL: '1200000', BARK_TIMEOUT_MS: '100',
};
const run = async () => (await worker.fetch(new Request('https://w/run?token=T'), env, { waitUntil() {} })).json();
const state = () => JSON.parse(files.get('data/state.json'));
const ledgerLen = () => JSON.parse(files.get('data/ledger.json')).entries.length;

/* ---------------- 剧本：今天 21:00 已经跑完、账本已经提交 ---------------- */
const TODAY = '2026-10-09';
const cal = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8'));
const series = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'));

/** 一个触发了「买入第 1 份」的晚上 —— 推送里会带估算金额，最能看出重建得对不对 */
function scenario(push, lastRun = `${TODAY} 21:00:43`) {
  const st = {
    ...base, asof: TODAY, lastRun, tier: 0,
    pending: { signalDate: TODAY, tierFrom: 0, tierTo: 1, side: 'BUY' },
    index: { ...base.index, close: 11700, ma30: 12100, buyTrigger: 11737, sellTrigger: 12342, pctToBuy: 0.32, pctToSell: 5.48, changePct: -1.2 },
    push, prevPush: { ok: true, at: '2026-10-08 21:00:41' },
  };
  resetRepo({
    'data/state.json': st,
    'data/ledger.json': { schema: 1, launchDate: base.launchDate, entries: [] },
    'data/series.json': series,
    'calendar/2026.json': cal,
    [`audit/${TODAY}.json`]: {
      today: TODAY, ranAt: lastRun, executed: null, pending: st.pending,
      etf: { d: TODAY, c: 1.422 },
      checks: Array.from({ length: 10 }, (_, k) => ({ id: k + 1, name: `检查${k + 1}`, ok: true })),
    },
  });
  barks = [];
}

/* ================================================================ */
console.log('\n【一】21:00 推送没送达（push 为空，已过去 90 分钟）→ 22:30 补发');
scenario(null); barkMode = 'ok'; at(`${TODAY} 22:30:05`);
let r = await run();
console.log(`  /run 返回：${JSON.stringify(r.resend)}`);
console.log(`  补发的推送：${barks[0] ? barks[0].title : '（没有）'}`);
if (barks[0]) console.log(`              ${barks[0].body.replace(/\n/g, '\n              ')}`);
if (barks.length !== 1) bad(`应当恰好补发 1 条，实际 ${barks.length} 条`);
else {
  if (!/买入第 1 份/.test(barks[0].title)) bad('补发的标题不是原本那条「买入第 1 份」');
  if (!/估算约 [\d,]+ 元/.test(barks[0].body)) bad('补发里丢了估算金额 —— 没照原样重建');
  if (!/补发/.test(barks[0].body)) bad('没说明这是补发，会被当成新信号');
  if (!/21:00 那轮的推送没有送达/.test(barks[0].body)) bad('没说清是哪一轮没送达');
  else ok('照原样补发：标题、估算金额都在，末尾注明是补发');
  // 「照原样」要落到数字上：用策略核心独立重放一遍，金额必须和补发里写的一致
  const { replay, plannedOrder } = await import('../shared/strategy.js');
  const rows = series.rows.filter((x) => x.d <= TODAY);
  const s0 = replay(rows, [], 1200000, base.launchDate);
  const want = Math.round(plannedOrder(s0.V, s0.cash, 1).amount);
  const got = +(barks[0].body.match(/估算约 ([\d,]+) 元/) || [, '0'])[1].replace(/,/g, '');
  if (got !== want) bad(`补发里的估算 ${got} 元，独立重放应为 ${want} 元 —— 没有照原样重建`);
  else ok(`估算金额 ${want.toLocaleString('en-US')} 元与独立重放一致`);
}
if (ledgerLen() !== 0) bad(`补发时动了账本：现在有 ${ledgerLen()} 笔`);
else ok('账本一笔没动');
if (log.length !== 1 || !/推送补发成功/.test(log[0])) bad(`回填提交不对：${JSON.stringify(log)}`);
else ok(`回填提交：「${log[0]}」`);
if (!(state().push && state().push.ok === true && state().push.resent === true)) bad(`state.push 没回填好：${JSON.stringify(state().push)}`);
else ok('state.push 回填为送达（标了 resent），面板上的「没有推送记录」警告会消失');

console.log('\n【二】再调一次 /run（比如手动又点了一下）→ 已送达，什么都不做');
barks = []; r = await run();
if (barks.length) bad(`已经补发成功了，又推了 ${barks.length} 条`);
else if (log.length !== 1) bad(`不该再有提交，现在 ${log.length} 次`);
else ok('不重复推送、不重复提交');

console.log('\n【三】21:00 推送明确失败过（push.ok=false）→ 补发');
scenario({ ok: false, at: `${TODAY} 21:00:51`, reason: 'Bark 请求失败：超过 8 秒没有响应' }); barkMode = 'ok';
r = await run();
if (barks.length !== 1) bad(`应当补发 1 条，实际 ${barks.length} 条`);
else if (!/超过 8 秒没有响应/.test(barks[0].body)) bad('补发里没带上次失败的原因');
else ok('补发成功，并写明上次失败是因为超时');

console.log('\n【四】那一轮刚跑完 3 分钟、push 还没回填 → 先不补发（防止和原推送撞车）');
scenario(null, `${TODAY} 21:00:43`); at(`${TODAY} 21:03:40`);
r = await run();
console.log(`  /run 返回：${JSON.stringify(r.resend)}`);
if (barks.length) bad('那一轮可能还在发推送，这时补发就重复了');
else if (log.length) bad('不该提交任何东西');
else ok('等满 10 分钟才认定丢失，不和正在发的推送撞车');

console.log('\n【五】补发时 Bark 还是不回 → 记成补发失败，不抛错、不重新记账');
scenario(null); barkMode = 'hang'; at(`${TODAY} 22:30:05`);
r = await run();
console.log(`  /run 返回：${JSON.stringify(r.resend)}`);
if (r.ok !== true) bad('补发失败不该让整个 /run 报错');
if (!(r.resend && r.resend.ok === false)) bad('应当报告补发失败');
if (!/推送补发失败/.test(log[0] || '')) bad(`没有记下「补发失败」：${JSON.stringify(log)}`);
else if (state().push.ok !== false) bad('state.push 该记成失败');
else ok('补发失败也明着记下来，面板会继续显示警告');
if (ledgerLen() !== 0) bad('补发失败时动了账本');

console.log('\n【六】不需要补发的那天：push 本来就送达了');
scenario({ ok: true, at: `${TODAY} 21:00:46` }); barkMode = 'ok'; at(`${TODAY} 22:30:05`);
r = await run();
if (barks.length || log.length) bad('已经送达了，却又推送或提交');
else if (r.resend) bad('不需要补发时，返回里不该出现 resend');
else ok('静默跳过，和以前一模一样');

REAL_RESET();
console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ 补发只在推送没送达时发生，照原样重建，绝不动账本、绝不重复'}\n`);
process.exitCode = fails ? 1 : 0;
