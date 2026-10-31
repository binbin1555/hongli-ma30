/**
 * 追高线：收盘比年线高出 3% 以上（在「年线 × 1.03」上方）时，买入信号不执行。
 *
 * 一、核心函数（shared/strategy.js 的 chaseState / chaseBlocks / chaseLine / chaseBlockedText）
 *   年线 = 最近 250 个收盘的平均，和闸门同一条；3% 两侧判得对；算不出年线时放行；
 *   起用日之前照算照显示、不拦；只拦买入；仓库里的真实行情算出来和闸门同一条年线
 *
 * 二、走 Worker 真正的 /run 入口（外部全换成内存假件，同 gate.mjs）
 *   收盘在年线下方 → 照常出买入挂单，推送里有一行追高线状态
 *   大涨之后第一次回调、收盘仍在追高线上方 → 不出挂单、不进账本、记进 chaselog，推送单独成一条（会响铃）
 *   推送没送达 → 22:30 补发的那条和原来一字不差
 *
 * 用法：npm run chase（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chaseState, chaseBlocks, chaseLine, chaseBlockedText, gateState, CHASE, MAX_TIER, ma } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ================================================================ 一、核心函数 */
console.log('\n【一】核心函数');

/** n 天行情，前 n−1 天收盘都是 base，最后一天是 last；日期从 start 起逐日排 */
function flat(n, base, last, start = Date.UTC(2020, 0, 1)) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ d: new Date(start + i * 86400000).toISOString().slice(0, 10), c: i === n - 1 ? last : base });
  }
  return rows;
}
const AFTER = Date.parse(`${CHASE.startDate}T00:00:00Z`) - 299 * 86400000;   // 让最后一天正好落在起用日

{
  // 1. 年线、追高线、偏离都按定义算
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ d: new Date(AFTER + i * 86400000).toISOString().slice(0, 10), c: 1000 + i * 2 });
  const s = chaseState(rows);
  const want = rows.slice(-250).reduce((a, r) => a + r.c, 0) / 250;
  if (s && near(s.ma250, want, 1e-9)) ok(`年线 = 最近 250 个收盘的平均（${want.toFixed(2)}）`); else bad(`年线 ${s && s.ma250}，应为 ${want}`);
  if (s && near(s.line, want * 1.03, 1e-9)) ok(`追高线 = 年线 × 1.03（${(want * 1.03).toFixed(2)}）`); else bad(`追高线 ${s && s.line}`);
  if (s && near(s.dev, rows[299].c / want - 1, 1e-12)) ok(`偏离 = 收盘 ÷ 年线 − 1（${(s.dev * 100).toFixed(2)}%）`); else bad(`偏离 ${s && s.dev}`);
}

{
  // 2. 3% 两侧：前 249 天都是 100，最后一天 x。x 在 103.012 附近越线
  const below = chaseState(flat(250, 100, 103.0, AFTER + 50 * 86400000));
  const over = chaseState(flat(250, 100, 103.05, AFTER + 50 * 86400000));
  if (below.ok && !below.above && !below.blocking) ok(`高出 ${(below.dev * 100).toFixed(2)}%：在线下方，不拦`); else bad(`103.0：${JSON.stringify(below)}`);
  if (over.ok && over.above && over.blocking) ok(`高出 ${(over.dev * 100).toFixed(2)}%：在线上方，拦`); else bad(`103.05：${JSON.stringify(over)}`);
  if (below.active && over.active) ok(`最后一天是 ${below.asof}，已到起用日 ${CHASE.startDate}`); else bad(`起用日没算对：${below.asof}`);
}

{
  // 3. 算不出年线：行情不足 250 天，或窗口里有缺失 —— 一律放行
  const short = chaseState(flat(200, 100, 120, AFTER + 100 * 86400000));
  if (short && !short.ok && !short.above && !short.blocking && /不足 250/.test(short.problem)) ok(`行情不足一年：${short.problem}，放行`); else bad(`行情不足：${JSON.stringify(short)}`);
  const holes = flat(300, 100, 120, AFTER).map((r, i) => (i === 280 ? { ...r, c: null } : r));
  const h = chaseState(holes);
  if (h && !h.ok && !h.above && !h.blocking && /缺失/.test(h.problem)) ok(`窗口里缺一天：${h.problem}，放行`); else bad(`窗口缺数：${JSON.stringify(h)}`);
  if (/暂不拦截，买入照常执行/.test(chaseLine(h, h.asof))) ok(`状态行说清楚了：${chaseLine(h, h.asof)}`); else bad(`状态行：${chaseLine(h, h.asof)}`);
}

{
  // 4. 起用日之前：照算照显示，但不拦
  const rows = flat(300, 100, 120);   // 2020 年，早于起用日
  const s = chaseState(rows);
  if (s.above && !s.active && !s.blocking) ok(`起用日（${CHASE.startDate}）之前：在线上方照显示，不拦`); else bad(`起用日之前：${JSON.stringify(s)}`);
  if (/起生效/.test(chaseLine(s, s.asof))) ok(`状态行注明了起用日：${chaseLine(s, s.asof)}`); else bad(`状态行没写起用日：${chaseLine(s, s.asof)}`);
}

{
  // 5. 只拦买入；满仓不会再有买入；没在拦截时不拦
  const blocking = { blocking: true };
  const t = [
    [chaseBlocks('BUY', 0, blocking), true, '拦截时的买入'],
    [chaseBlocks('SELL', 2, blocking), false, '拦截时的卖出'],
    [chaseBlocks(null, 2, blocking), false, '没有信号'],
    [chaseBlocks('BUY', MAX_TIER, blocking), false, '满仓（本来就不会再买）'],
    [chaseBlocks('BUY', 1, { blocking: false }), false, '没在拦截'],
    [chaseBlocks('BUY', 1, null), false, '算不出追高线'],
  ];
  const wrong = t.filter(([got, want]) => got !== want);
  if (!wrong.length) ok('只拦买入：卖出、满仓、未拦截、算不出时一律放行'); else bad(`chaseBlocks 判错：${wrong.map((x) => x[2]).join('、')}`);
}

{
  // 6. 两种状态的说法，以及拦下那笔的说法
  const today = '2026-11-03';
  const base = { asof: today, close: 12000, ma250: 11500, line: 11845, dev: 12000 / 11500 - 1, ok: true, problem: null, active: true };
  const up = chaseLine({ ...base, above: true, blocking: true }, today);
  const dn = chaseLine({ ...base, close: 11700, dev: 11700 / 11500 - 1, above: false, blocking: false }, today);
  if (/追高线 11,845（年线 × 1\.03）：收盘比年线（11,500）高 4\.3%，已在线上方，这时出现的买入信号不会执行/.test(up)) ok(`在线上方：${up}`); else bad(`在线上方的说法：${up}`);
  if (/在线下方，买入信号照常执行/.test(dn)) ok(`在线下方：${dn}`); else bad(`在线下方的说法：${dn}`);
  const b = { signalDate: today, tierFrom: 1, tierTo: 2, close: 11900, ma250: 11500, line: 11845 };
  const txt = chaseBlockedText(b, '2026-11-04', today);
  const need = ['11,900', '11,500', '11,845', '买入第 2 份', '高 3.5%', '仓位仍是 25%', '11 月 4 日'];
  const miss = need.filter((x) => !txt.includes(x));
  if (!miss.length) ok(`拦下那笔的说法：${txt}`); else bad(`拦下那笔的说法缺了 ${miss.join('、')}：${txt}`);
}

{
  // 7. 仓库里的真实行情：年线和闸门是同一条
  const series = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
  const d = series.rows[series.rows.length - 1].d;
  const c = chaseState(series.rows, d), g = gateState(series.rows, d);
  if (c && g && c.ok && near(c.ma250, g.ma250, 1e-6)) ok(`${d}：和闸门同一条年线 ${c.ma250.toFixed(2)}；${chaseLine(c, d)}`);
  else bad(`年线和闸门对不上：追高线 ${c && c.ma250}，闸门 ${g && g.ma250}`);
  const c30 = chaseState(series.rows, '2026-10-30');
  if (c30 && near(c30.ma250, 11867.2, 0.05) && near(c30.dev, 12193.55 / c30.ma250 - 1, 1e-9) && !c30.above) ok(`2026-10-30：比年线高 ${(c30.dev * 100).toFixed(2)}%，在线下方`);
  else bad(`2026-10-30 算出来不对：${JSON.stringify(c30)}`);
}

/* ================================================================ 二、Worker /run */
console.log('\n【二】走 Worker 真正的 /run');

const RealDate = Date;
let fakeNow = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
  static now() { return fakeNow ?? RealDate.now(); }
};
const at = (bj) => { fakeNow = RealDate.parse(bj.replace(' ', 'T') + 'Z') - 8 * 3600000; };

const cal = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8'));
const series0 = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'));
const LAST0 = series0.rows[series0.rows.length - 1];
const TODAY = cal.tradingDays.find((d) => d > LAST0.d);
const EXEC = cal.tradingDays.find((d) => d > TODAY);
const ymd8 = (d) => d.replace(/-/g, '');

/*
 * 两段行情：
 *   原样    今天跌 5%：一定跌破买入线，也一定在年线下（年线 ≈ 11,900），追高线不管
 *   大涨后  最近 60 天里前 30 天逐步抬高到 +20%、后 30 天持平（全收益和价格指数一起抬，股息率不受影响；
 *           逐步抬是为了不触发「单日涨跌超过 ±11%」那项检查），今天跌到 30 日均线的 93%：
 *           跌破了买入线，却仍在年线 × 1.03 上方
 */
const N = series0.rows.length;
const RAISED = series0.rows.map((r, i) => {
  const j = i - (N - 60);
  if (j < 0) return r;
  const f = j >= 30 ? 1.2 : 1 + 0.2 * (j + 1) / 30;
  return { ...r, c: +(r.c * f).toFixed(2), p: +(r.p * f).toFixed(2) };
});
const scen = {
  plain: { rows: series0.rows, close: +(LAST0.c * 0.95).toFixed(2) },
  raised: { rows: RAISED, close: +(RAISED.slice(-29).reduce((a, r) => a + r.c, 0) / 29 * 0.93).toFixed(2) },
};
// 先验算前提：大涨后那段今天确实「跌破买入线」且「在追高线上方」，不然后面的断言测的不是这件事
{
  const R = scen.raised;
  const closes = [...R.rows.map((r) => r.c), R.close];
  const m30 = ma(closes, 30), m250 = closes.slice(-250).reduce((a, b) => a + b, 0) / 250;
  if (R.close < m30 * 0.97 && R.close > m250 * 1.03) ok(`前提成立：大涨后那段今天 ${R.close} < 买入线 ${(m30 * 0.97).toFixed(0)}，且 > 追高线 ${(m250 * 1.03).toFixed(0)}`);
  else bad(`前提不成立：收盘 ${R.close}，买入线 ${(m30 * 0.97).toFixed(0)}，追高线 ${(m250 * 1.03).toFixed(0)}`);
}

let cur = scen.plain;
const BR = 'master';
let files, blobs, trees, commits, head, log, barks = [];
function resetRepo(init) {
  files = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  blobs = new Map(); trees = new Map(); commits = new Map([['c0', { tree: 't0' }]]); head = 'c0'; log = [];
  trees.set('t0', { entries: [] });
}
let n = 0;
const sha = (p) => `${p}${++n}`;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const m = opts.method || 'GET';
  if (url.startsWith('https://api.day.app/')) { barks.push(JSON.parse(opts.body)); return json({ code: 200 }); }
  if (url.startsWith('https://www.csindex.com.cn/')) {
    const q = new URL(url).searchParams;
    const a = q.get('startDate'), b = q.get('endDate'), px = q.get('indexCode') === '000922';
    const last = cur.rows[cur.rows.length - 1];
    const rows = [...cur.rows.map((r) => ({ d: r.d, c: px ? r.p : r.c })),
      { d: TODAY, c: px ? +(last.p * cur.close / last.c).toFixed(2) : cur.close }];
    const data = rows.filter((r) => ymd8(r.d) >= a && ymd8(r.d) <= b).map((r, k, arr) => ({
      tradeDate: ymd8(r.d), close: r.c, changePct: k ? +((r.c / arr[k - 1].c - 1) * 100).toFixed(2) : 0,
    }));
    return json({ code: '200', data });
  }
  if (url.startsWith('https://datacenter-web.eastmoney.com/')) {
    const data = series0.rows.slice(-30).reverse().map((r) => ({ SOLAR_DATE: `${r.d} 00:00:00`, EMM00166466: r.y }));
    return json({ result: { data } });
  }
  if (url.startsWith('https://fund.eastmoney.com/pingzhongdata/')) {
    const pts = [...series0.rows.filter((r) => r.b).map((r) => [r.d, r.b]), [TODAY, LAST0.b]]
      .map(([d, v]) => [RealDate.parse(`${d}T00:00:00Z`) - 8 * 3600000, v]);
    return new Response(`var fS_name = "交银稳利中短债债券A";var Data_ACWorthTrend = ${JSON.stringify(pts)};`, { status: 200 });
  }
  if (url.startsWith('https://qt.gtimg.cn/')) {
    const f = Array(40).fill('0'); f[3] = '1.3'; f[30] = `${ymd8(TODAY)}150000`;
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
const env = { RUN_TOKEN: 'T', GITHUB_TOKEN: 'x', GH_OWNER: 'o', GH_REPO: 'r', GH_BRANCH: BR, BARK_KEY: 'k', PRINCIPAL: '1000000', BARK_TIMEOUT_MS: '200' };
const call = async (path) => {
  const r = await worker.fetch(new Request(`https://w${path}?token=T`), env, { waitUntil() {} });
  return { text: await r.text(), status: r.status };
};
const repoJSON = (p) => (files.has(p) ? JSON.parse(files.get(p)) : null);
function seed(s) {
  cur = s;
  const last = s.rows[s.rows.length - 1];
  resetRepo({
    'data/state.json': { ...base, asof: last.d, lastRun: `${last.d} 21:00:40`, tier: 0, pending: null, push: { ok: true, at: `${last.d} 21:00:50` } },
    'data/ledger.json': { schema: 1, launchDate: base.launchDate, entries: [] },
    'data/series.json': { ...series0, rows: s.rows },
    'calendar/2026.json': cal,
  });
  barks = [];
}
const show = (b) => (b ? `${b.title}｜${b.body.replace(/\n/g, '⏎')}` : '（没有推送）');

{
  console.log('\n● 收盘在年线下方：追高线不管，照常出买入挂单');
  seed(scen.plain); at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const res = JSON.parse(r.text);
  const st = repoJSON('data/state.json'), b = barks[0];
  if (st.pending && st.pending.side === 'BUY' && st.pending.tierTo === 1) ok(`出了买入挂单（${EXEC} 执行）`); else bad(`应出买入挂单：${JSON.stringify(st.pending)}`);
  if (st.chase && st.chase.ok && !st.chase.above && !st.chase.blocked && st.chase.active && st.chase.dev < 0) ok(`state.chase：比年线（${st.chase.ma250}）低 ${Math.abs(st.chase.dev * 100).toFixed(1)}%，没有拦截`);
  else bad(`state.chase：${JSON.stringify(st.chase)}`);
  if (b && /追高线 [\d,]+（年线 × 1\.03）：收盘比年线（[\d,]+）低 [\d.]+%，在线下方/.test(b.body)) ok(`推送里有追高线状态：${b.body.split('\n').find((x) => x.includes('追高线'))}`);
  else bad(`推送里没有追高线状态：${show(b)}`);
  if (!files.has('data/chaselog.json')) ok('没拦截就不写 chaselog'); else bad('没拦截却写了 chaselog');
  if (res.chase && res.chase.ok === true && res.chase.blocked === false) ok('HTTP 返回带了追高线的结论'); else bad(`HTTP 返回：${JSON.stringify(res.chase)}`);
}

{
  console.log('\n● 大涨后第一次回调、收盘仍在追高线上方：买入被拦下');
  seed(scen.raised); at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const res = JSON.parse(r.text);
  const st = repoJSON('data/state.json'), led = repoJSON('data/ledger.json'), clog = repoJSON('data/chaselog.json');
  const b = barks[0];
  if (!st.pending && st.tier === 0 && led.entries.length === 0) ok('没出挂单、没进账本，仓位仍是 0%'); else bad(`不该有挂单 / 账本：${JSON.stringify({ p: st.pending, n: led.entries.length })}`);
  if (st.chase && st.chase.above && st.chase.blocking && st.chase.blocked && st.chase.blocked.signalDate === TODAY && st.chase.blocked.tierTo === 1) {
    ok(`state.chase.blocked 记下了：收盘 ${st.chase.blocked.close}，年线 ${st.chase.blocked.ma250}，追高线 ${st.chase.blocked.line}`);
  } else bad(`state.chase：${JSON.stringify(st.chase)}`);
  if (st.gate && !st.gate.blocked) ok('闸门没有插手（它只在年线下方拦）'); else bad(`闸门不该拦：${JSON.stringify(st.gate)}`);
  if (clog && clog.entries.length === 1 && clog.entries[0].signalDate === TODAY) ok('chaselog 记了一笔'); else bad(`chaselog：${JSON.stringify(clog)}`);
  if (!files.has('data/gatelog.json')) ok('gatelog 没被碰'); else bad('追高线拦下的却记进了 gatelog');
  if (b && b.title.startsWith('⛔') && b.title.includes('被追高线拦下') && b.level === 'timeSensitive' && b.group === '红利MA30·操作') {
    ok(`推送单独成一条、会响铃：${b.title}`);
  } else bad(`推送：${show(b)}`);
  const want = st.chase && st.chase.blocked ? chaseBlockedText(st.chase.blocked, EXEC, TODAY) : null;
  if (want && b && b.body.startsWith(want)) ok('推送正文和 chaseBlockedText 一字不差（面板横幅用的是同一句）'); else bad(`推送正文：${show(b)}\n      应以：${want || '（state 里没有拦截记录）'}`);
  if (b && b.body.includes(`${+EXEC.slice(5, 7)} 月 ${+EXEC.slice(8, 10)} 日`) && /无需操作/.test(b.body)) ok('写出了哪天不用操作'); else bad(`没写哪天不用操作：${show(b)}`);
  if (/被追高线拦下/.test(log.join('|'))) ok(`提交说明：${log[0]}`); else bad(`提交说明：${log.join('|')}`);
  if (res.chase && res.chase.blocked === true && !/[\d,]{7,}/.test(JSON.stringify(res.chase))) ok('HTTP 返回只说拦没拦，不带金额'); else bad(`HTTP 返回：${JSON.stringify(res.chase)}`);

  console.log('\n● 这条推送没送达：补发的和原来一字不差');
  const first = b;
  const s2 = { ...repoJSON('data/state.json'), push: { ok: false, at: `${TODAY} 21:00:52`, reason: '超时' } };
  files.set('data/state.json', JSON.stringify(s2));
  barks = []; at(`${TODAY} 22:30:05`);
  await call('/run');
  const again = barks[0];
  if (again && first && again.title === first.title && again.body.startsWith(first.body.split('\n↻')[0].slice(0, 120))) ok(`补发：${again.title}`); else bad(`补发不一致：${show(again)}`);
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 追高线全部通过'}\n`);
process.exit(fails ? 1 : 0);
