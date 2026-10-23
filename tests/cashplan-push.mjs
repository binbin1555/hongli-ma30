/**
 * 推送里的「资金安排」：走 Worker 真正的 /run、/remind 入口。
 *
 * 外部全部换成内存假件：GitHub（能读能提交）、Bark、中证指数、基金净值、ETF 报价。
 * 推送里的金额不在这里另写一套算法去比 —— 跑完之后从假 GitHub 里取出 Worker
 * 实际提交的行情和账本，交给 shared/strategy.js 的 cashPlan 重算一遍，
 * 推送里的那几行必须和它一字不差。
 *
 * 另外两条硬约束：
 *   HTTP 返回和提交进仓库的文件里，一个金额都不能有（仓库是公开的，调用方会存响应体）
 *   资金安排算不出来、或者没配置、没本金时，记账和推送照常
 *
 * 用法：npm run cashplan-push（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cashPlan, cashPlanLines, dayLabel } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);

/* ---------------- 时钟（new Date() 和 Date.now 都要换，见 push-resend.mjs） ---------------- */
const RealDate = Date;
let fakeNow = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
  static now() { return fakeNow ?? RealDate.now(); }
};
const at = (bj) => { fakeNow = RealDate.parse(bj.replace(' ', 'T') + 'Z') - 8 * 3600000; };

/* ---------------- 真实数据 + 今天这一行 ---------------- */
const cal = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8'));
const series0 = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'));
const LAST = series0.rows[series0.rows.length - 1];                       // 仓库里最后一天
const TODAY = cal.tradingDays.find((d) => d > LAST.d);                     // 再往后一个交易日
const EXEC = cal.tradingDays.find((d) => d > TODAY);                       // 挂单执行日
const lastRows = series0.rows.slice(-29).map((r) => r.c);
const MA_TODAY_LOW = (lastRows.reduce((a, b) => a + b, 0) + 0) / 30;       // 粗估，下面让今天收盘远低于它
const CLOSE = +(LAST.c * 0.95).toFixed(2);                                 // 跌 5%：一定跌破 MA30×0.97
const NAV = +(LAST.b * 1.0001).toFixed(4);
const ETFP = 1.3;
const ymd8 = (d) => d.replace(/-/g, '');

/* ---------------- 假 GitHub ---------------- */
const BR = 'master';
let files, blobs, trees, commits, head, log;
function resetRepo(init) {
  files = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  blobs = new Map(); trees = new Map(); commits = new Map([['c0', { tree: 't0' }]]); head = 'c0'; log = [];
  trees.set('t0', { entries: [] });
}
let n = 0;
const sha = (p) => `${p}${++n}`;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
let barks = [];

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const m = opts.method || 'GET';
  if (url.startsWith('https://api.day.app/')) { barks.push(JSON.parse(opts.body)); return json({ code: 200 }); }
  if (url.startsWith('https://www.csindex.com.cn/')) {
    const q = new URL(url).searchParams;
    const a = q.get('startDate'), b = q.get('endDate');
    const rows = [...series0.rows.map((r) => ({ d: r.d, c: r.c })), { d: TODAY, c: CLOSE }];
    const data = rows.filter((r) => ymd8(r.d) >= a && ymd8(r.d) <= b).map((r, k, arr) => ({
      tradeDate: ymd8(r.d), close: r.c, changePct: k ? +((r.c / arr[k - 1].c - 1) * 100).toFixed(2) : 0,
    }));
    return json({ code: '200', data });
  }
  if (url.startsWith('https://fund.eastmoney.com/pingzhongdata/')) {
    const pts = [...series0.rows.filter((r) => r.b).map((r) => [r.d, r.b]), [TODAY, NAV]]
      .map(([d, v]) => [RealDate.parse(`${d}T00:00:00Z`) - 8 * 3600000, v]);
    return new Response(`var fS_name = "交银稳利中短债债券A";var Data_ACWorthTrend = ${JSON.stringify(pts)};`, { status: 200 });
  }
  if (url.startsWith('https://qt.gtimg.cn/')) {
    const f = Array(40).fill('0'); f[3] = String(ETFP); f[30] = `${ymd8(TODAY)}150000`;
    return new Response(`v_sh515180="${f.join('~')}";`, { status: 200 });
  }
  const gbase = 'https://api.github.com/repos/o/r';
  if (!url.startsWith(gbase)) throw new Error(`测试里不该请求 ${url}`);
  const p = url.slice(gbase.length);
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
const PRINCIPAL = 1860000;
const envOf = (extra = {}) => ({
  RUN_TOKEN: 'T', GITHUB_TOKEN: 'x', GH_OWNER: 'o', GH_REPO: 'r', GH_BRANCH: BR,
  BARK_KEY: 'k', PRINCIPAL: String(PRINCIPAL), BARK_TIMEOUT_MS: '200', ...extra,
});
const call = async (path, env) => {
  const r = await worker.fetch(new Request(`https://w${path}?token=T`), env, { waitUntil() {} });
  return { text: await r.text(), status: r.status };
};
const repoJSON = (p) => JSON.parse(files.get(p));

/** 仓库初始状态：空仓、没有挂单、数据停在 LAST */
function seed(cfg) {
  resetRepo({
    'data/state.json': { ...base, asof: LAST.d, lastRun: `${LAST.d} 21:00:40`, tier: 0, pending: null, push: { ok: true, at: `${LAST.d} 21:00:50` } },
    'data/ledger.json': { schema: 1, launchDate: base.launchDate, entries: [] },
    'data/series.json': series0,
    'calendar/2026.json': cal,
    ...(cfg ? { 'data/cashplan.json': cfg } : {}),
  });
  barks = [];
}
/** 拿 Worker 实际提交的数据，用核心函数重算一遍「应该说什么」 */
function expected(cfg, today = TODAY) {
  const st = repoJSON('data/state.json'), led = repoJSON('data/ledger.json'), ser = repoJSON('data/series.json');
  const cp = cashPlan({ rows: ser.rows.filter((r) => r.d <= st.asof), entries: led.entries, principal: PRINCIPAL,
    launchDate: st.launchDate, tradingDays: cal.tradingDays, cfg, pending: st.pending });
  return { cp, lines: cashPlanLines(cp, today), st };
}
const opBark = () => barks.find((b) => /买入第|卖出第/.test(b.title));
const noMoney = (txt, cp, where) => {
  const nums = [cp.next.actions, cp.next.short ? [cp.next.short] : []].flat()
    .flatMap((a) => [a.amount, a.gap, a.have]).filter((x) => x > 1000).map((x) => Math.round(x).toLocaleString('en-US'));
  const hit = nums.filter((s) => txt.includes(s) || txt.includes(s.replace(/,/g, '')));
  if (hit.length) bad(`${where} 里出现了金额 ${hit.join('、')}`); else ok(`${where} 里没有任何资金安排的金额`);
};

/* ================================================================ */
console.log(`\n① 缓冲垫早已备好：${TODAY} 收盘跌破买入线，挂单 ${EXEC} 买入第 1 份`);
{
  const cfg = { schema: 1, startDate: base.launchDate, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
  seed(cfg);
  at(`${TODAY} 21:00:30`);
  const r = await call('/run', envOf());
  const { cp, lines, st } = expected(cfg);
  const b = opBark();
  if (!st.pending || st.pending.side !== 'BUY') bad(`剧本没造出买入挂单：${JSON.stringify(st.pending)}`);
  else if (!b) bad(`没有发出操作推送：${barks.map((x) => x.title).join(' / ')}`);
  else {
    const want = `资金安排：\n${lines.map((x) => `· ${x}`).join('\n')}`;
    if (b.body.includes(want)) ok(`推送里的资金安排与核心函数一字不差：\n        ${lines.join('\n        ')}`);
    else bad(`推送里的资金安排不对。\n应为：\n${want}\n实际推送：\n${b.body}`);
    const red = cp.next.actions.find((a) => a.kind === 'REDEEM');
    const L = dayLabel(EXEC, TODAY).label;
    if (red && red.day === EXEC && lines[0].startsWith(`${L}15:00 前赎回交银稳利约`)) ok(`赎回放在执行日 ${EXEC} 15:00 前，到账 ${red.arrive}`);
    else bad(`赎回日期不对：${JSON.stringify(red)}`);
    if (!cp.next.short) ok('缓冲垫够付这笔，没有报警'); else bad(`不该报警：${JSON.stringify(cp.next.short)}`);
  }
  noMoney(r.text, cp, 'HTTP 返回');
  if (JSON.parse(r.text).cashPlan === 'ok') ok('HTTP 返回只说「资金安排已算出」（cashPlan: ok）'); else bad(`HTTP 返回 cashPlan 字段不对：${r.text.slice(0, 200)}`);
  noMoney([...files.entries()].filter(([k]) => !k.startsWith('calendar/')).map(([, v]) => v).join('\n'), cp, '提交进仓库的文件');
}

console.log(`\n② 今天才起用（${TODAY}），当晚就出买入信号 —— 缓冲垫的钱还在路上`);
{
  const cfg = { schema: 1, startDate: TODAY, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
  seed(cfg);
  at(`${TODAY} 21:00:30`);
  await call('/run', envOf());
  const { cp, lines } = expected(cfg);
  const b = opBark();
  const arrive = cal.tradingDays[cal.tradingDays.indexOf(TODAY) + 2];
  if (!b) bad('没有发出操作推送');
  else if (cp.next.short && cp.next.short.until === arrive && b.body.includes(`要等 ${dayLabel(arrive, TODAY).label}赎回款到账后再补买`)) {
    ok(`推送明确报警：${lines.find((x) => x.startsWith('⚠️'))}`);
  } else bad(`应报警「缓冲垫的钱 ${arrive} 才到」：\n${b.body}`);
  if (cp.transit.length === 1 && cp.transit[0].apply === TODAY && cp.transit[0].arrive === arrive) ok(`起用当天那笔赎回 ${arrive} 到账（已计入在途）`);
  else bad(`起用当天的在途款不对：${JSON.stringify(cp.transit)}`);
}

console.log('\n③ 没有 cashplan.json / 没设本金：推送照旧，不带资金安排');
for (const [label, cfg, env] of [['没有配置文件', null, envOf()], ['没设本金', { startDate: base.launchDate }, envOf({ PRINCIPAL: '' })]]) {
  seed(cfg);
  at(`${TODAY} 21:00:30`);
  const r = await call('/run', env);
  const b = opBark();
  const body = JSON.parse(r.text);
  if (b && !b.body.includes('资金安排') && body.ok && body.cashPlan === 'off') ok(`${label}：照常记账和推送，cashPlan: off`);
  else bad(`${label}：${r.text.slice(0, 160)} / ${b && b.body}`);
}

console.log(`\n④ ${EXEC} 14:30 盘中提醒：买入日 15:00 前还要赎回`);
{
  const cfg = { schema: 1, startDate: base.launchDate, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
  seed(cfg);
  at(`${TODAY} 21:00:30`);
  await call('/run', envOf());
  barks = [];
  at(`${EXEC} 14:30:00`);
  await call('/remind', envOf());
  const { lines } = expected(cfg, EXEC);
  const b = barks[0];
  const want = `资金安排：\n${lines.map((x) => `· ${x}`).join('\n')}`;
  if (b && b.body.includes(want) && /今天/.test(lines[0])) ok(`提醒里同样写着：${lines[0]}`);
  else bad(`盘中提醒里资金安排不对。\n应为：\n${want}\n实际：\n${b && b.body}`);
}

console.log('\n⑤ 推送没送达、22:30 补发：资金安排照原样');
{
  const cfg = { schema: 1, startDate: base.launchDate, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
  seed(cfg);
  at(`${TODAY} 21:00:30`);
  await call('/run', envOf());
  const first = opBark();
  // 把推送记录改成失败，模拟那条没送达
  const st = repoJSON('data/state.json');
  files.set('data/state.json', JSON.stringify({ ...st, push: { ok: false, at: st.lastRun, reason: '测试：假装没送达' } }));
  barks = [];
  at(`${TODAY} 22:30:00`);
  await call('/run', envOf());
  const again = opBark();
  const block = (t) => (t.match(/资金安排：[\s\S]*?(?=\n指数)/) || [''])[0];
  if (first && again && block(first.body) && block(again.body) === block(first.body)) ok('补发的资金安排和原推送一字不差');
  else bad(`补发不一致：\n原：${first && block(first.body)}\n补：${again && block(again.body)}`);
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exitCode = fails ? 1 : 0;
