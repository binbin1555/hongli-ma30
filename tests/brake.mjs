/**
 * 暴跌刹车：20 日波动率超过 40%、收盘又在年线下方时，买入信号不执行。
 *
 * 一、核心函数（shared/strategy.js 的 brakeState / brakeBlocks / brakeLine / brakeBlockedText）
 *   波动率 = 最近 20 个日对数收益率的样本标准差 × √250；年线和闸门同一条；40% 两侧判得对；
 *   波动率高但收盘在年线上方不拦；算不出时放行；起用日之前照算照显示、不拦；只拦买入；
 *   仓库里的真实行情算出来和回测引擎同一个数
 *
 * 二、走 Worker 真正的 /run 入口（外部全换成内存假件，同 chase.mjs）
 *   平常日子 → 照常出买入挂单，推送里有一行刹车状态
 *   连续大跌、波动率冲上 40% 以上又跌破年线 → 不出挂单、不进账本、记进 brakelog，推送单独成一条（会响铃）
 *   推送没送达 → 22:30 补发的那条和原来一字不差
 *
 * 用法：npm run brake（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brakeState, brakeBlocks, brakeLine, brakeBlockedText, gateState, chaseState, BRAKE, MAX_TIER, ma } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** 独立再算一遍：最近 20 个日对数收益率的样本标准差 × √250 */
function vol20(closes) {
  const n = closes.length, x = [];
  for (let i = n - 20; i < n; i++) x.push(Math.log(closes[i] / closes[i - 1]));
  const m = x.reduce((a, b) => a + b, 0) / 20;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / 19) * Math.sqrt(250);
}

/* ================================================================ 一、核心函数 */
console.log('\n【一】核心函数');

const AFTER = Date.parse(`${BRAKE.startDate}T00:00:00Z`) - 299 * 86400000;   // 让 300 天里的最后一天正好落在起用日
const dateAt = (start, i) => new Date(start + i * 86400000).toISOString().slice(0, 10);
/**
 * 300 天行情：前 279 天收盘都是 base，第 280 天落到 100，
 * 最后 20 天在 100 和 100·e^a 之间来回跳 —— 20 个收益率正好 10 个 +a、10 个 −a，
 * 波动率 = a × √(20/19) × √250，想要多少就能造多少。最后一天收在 100。
 */
function zigzag(base, vol, start = AFTER) {
  const a = vol / Math.sqrt(250 * 20 / 19);
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const c = i < 279 ? base : i === 279 ? 100 : ((i - 279) % 2 === 1 ? 100 * Math.exp(a) : 100);
    rows.push({ d: dateAt(start, i), c });
  }
  return rows;
}

{
  // 1. 波动率、年线都按定义算（收益率有大有小，窗口错一天就对不上）
  const rows = [];
  let lv = Math.log(1000);
  for (let i = 0; i < 300; i++) {
    lv += 0.012 * Math.sin(i * 0.7) + 0.004 * Math.cos(i * 1.9);
    rows.push({ d: dateAt(AFTER, i), c: Math.exp(lv) });
  }
  const s = brakeState(rows);
  const closes = rows.map((r) => r.c);
  const wantMa = closes.slice(-250).reduce((a, b) => a + b, 0) / 250;
  const wantVol = vol20(closes);
  if (s && near(s.ma250, wantMa, 1e-9)) ok(`年线 = 最近 250 个收盘的平均（${wantMa.toFixed(2)}）`); else bad(`年线 ${s && s.ma250}，应为 ${wantMa}`);
  if (s && near(s.vol, wantVol, 1e-12)) ok(`波动率 = 最近 20 个日对数收益率的样本标准差 × √250（${(wantVol * 100).toFixed(2)}%）`);
  else bad(`波动率 ${s && s.vol}，应为 ${wantVol}`);
}

{
  // 2. 40% 两侧：收盘在年线下方，波动率 39.9% 不拦、40.1% 拦
  const lo = brakeState(zigzag(120, 0.399)), hi = brakeState(zigzag(120, 0.401));
  if (lo.ok && lo.below && near(lo.vol, 0.399, 1e-9) && !lo.hot && !lo.blocking) ok(`波动率 ${(lo.vol * 100).toFixed(1)}%、收盘在年线下方：不拦`); else bad(`39.9%：${JSON.stringify(lo)}`);
  if (hi.ok && hi.below && near(hi.vol, 0.401, 1e-9) && hi.hot && hi.blocking) ok(`波动率 ${(hi.vol * 100).toFixed(1)}%、收盘在年线下方：拦`); else bad(`40.1%：${JSON.stringify(hi)}`);
  if (lo.active && hi.active) ok(`最后一天是 ${hi.asof}，已到起用日 ${BRAKE.startDate}`); else bad(`起用日没算对：${hi.asof}`);
}

{
  // 3. 波动率很高，但收盘在年线上方（比如急涨）：不拦
  const s = brakeState(zigzag(80, 0.6));
  if (s.ok && s.hot && !s.below && !s.blocking) ok(`波动率 ${(s.vol * 100).toFixed(0)}% 但收盘比年线高 ${((s.close / s.ma250 - 1) * 100).toFixed(0)}%：不拦`); else bad(`年线上方：${JSON.stringify(s)}`);
  if (/已超过 40%，但收盘在年线（[\d,]+）上方 [\d.]+%，买入信号照常执行/.test(brakeLine(s, s.asof))) ok(`状态行：${brakeLine(s, s.asof)}`); else bad(`状态行：${brakeLine(s, s.asof)}`);
}

{
  // 4. 算不出：行情不足 250 天，或窗口里有缺失 —— 一律放行
  const short = brakeState(zigzag(120, 0.6).slice(-200));
  if (short && !short.ok && !short.hot && !short.blocking && /不足 250/.test(short.problem)) ok(`行情不足一年：${short.problem}，放行`); else bad(`行情不足：${JSON.stringify(short)}`);
  const holes = zigzag(120, 0.6).map((r, i) => (i === 290 ? { ...r, c: null } : r));
  const h = brakeState(holes);
  if (h && !h.ok && !h.hot && !h.blocking && /缺失/.test(h.problem)) ok(`窗口里缺一天：${h.problem}，放行`); else bad(`窗口缺数：${JSON.stringify(h)}`);
  if (/暂不拦截，买入照常执行/.test(brakeLine(h, h.asof))) ok(`状态行说清楚了：${brakeLine(h, h.asof)}`); else bad(`状态行：${brakeLine(h, h.asof)}`);
}

{
  // 5. 起用日之前：照算照显示，但不拦
  const s = brakeState(zigzag(120, 0.6, Date.UTC(2020, 0, 1)));
  if (s.hot && s.below && !s.active && !s.blocking) ok(`起用日（${BRAKE.startDate}）之前：条件满足照显示，不拦`); else bad(`起用日之前：${JSON.stringify(s)}`);
  if (/起生效/.test(brakeLine(s, s.asof))) ok(`状态行注明了起用日：${brakeLine(s, s.asof)}`); else bad(`状态行没写起用日：${brakeLine(s, s.asof)}`);
}

{
  // 6. 只拦买入；满仓不会再有买入；没在拦截时不拦
  const blocking = { blocking: true };
  const t = [
    [brakeBlocks('BUY', 0, blocking), true, '拦截时的买入'],
    [brakeBlocks('SELL', 2, blocking), false, '拦截时的卖出'],
    [brakeBlocks(null, 2, blocking), false, '没有信号'],
    [brakeBlocks('BUY', MAX_TIER, blocking), false, '满仓（本来就不会再买）'],
    [brakeBlocks('BUY', 1, { blocking: false }), false, '没在拦截'],
    [brakeBlocks('BUY', 1, null), false, '算不出刹车状态'],
  ];
  const wrong = t.filter(([got, want]) => got !== want);
  if (!wrong.length) ok('只拦买入：卖出、满仓、未拦截、算不出时一律放行'); else bad(`brakeBlocks 判错：${wrong.map((x) => x[2]).join('、')}`);
}

{
  // 7. 几种状态的说法，以及拦下那笔的说法
  const today = '2026-11-03';
  const base = { asof: today, close: 10500, ma250: 11500, ok: true, problem: null, active: true };
  const calm = brakeLine({ ...base, vol: 0.161, hot: false, below: true, blocking: false }, today);
  const on = brakeLine({ ...base, vol: 0.523, hot: true, below: true, blocking: true }, today);
  if (calm === '暴跌刹车未触发：20 日波动率 16.1%，超过 40% 且收盘跌破年线才拦') ok(`没触发：${calm}`); else bad(`没触发的说法：${calm}`);
  if (/^暴跌刹车已踩下：20 日波动率 52\.3%，超过 40%，收盘在年线（11,500）下方 8\.7% —— 这时出现的买入信号不会执行$/.test(on)) ok(`踩下：${on}`); else bad(`踩下的说法：${on}`);
  const b = { signalDate: today, tierFrom: 1, tierTo: 2, close: 10500, ma250: 11500, vol: 0.523 };
  const txt = brakeBlockedText(b, '2026-11-04', today);
  const need = ['10,500', '11,500', '买入第 2 份', '52.3%', '下方 8.7%', '仓位仍是 25%', '11 月 4 日'];
  const miss = need.filter((x) => !txt.includes(x));
  if (!miss.length) ok(`拦下那笔的说法：${txt}`); else bad(`拦下那笔的说法缺了 ${miss.join('、')}：${txt}`);
}

{
  // 8. 仓库里的真实行情：年线和闸门、追高线同一条；波动率和独立算法一致
  const series = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
  const d = series.rows[series.rows.length - 1].d;
  const b = brakeState(series.rows, d), g = gateState(series.rows, d), c = chaseState(series.rows, d);
  const closes = series.rows.filter((r) => r.d <= d).map((r) => r.c);
  if (b && g && c && b.ok && near(b.ma250, g.ma250, 1e-6) && near(b.ma250, c.ma250, 1e-6)) ok(`${d}：和闸门、追高线同一条年线 ${b.ma250.toFixed(2)}`);
  else bad(`年线对不上：刹车 ${b && b.ma250}，闸门 ${g && g.ma250}，追高线 ${c && c.ma250}`);
  if (b && near(b.vol, vol20(closes), 1e-12)) ok(`${d}：${brakeLine(b, d)}`); else bad(`波动率对不上：${b && b.vol} vs ${vol20(closes)}`);
  // 回测引擎（scratchpad 里独立写的那套）在 2026-10-28 算出 16.0755%
  const b28 = brakeState(series.rows, '2026-10-28');
  if (b28 && near(b28.vol, 0.1607545654, 1e-9) && !b28.hot) ok(`2026-10-28：波动率 ${(b28.vol * 100).toFixed(4)}%，和回测引擎同一个数`);
  else bad(`2026-10-28 算出来不对：${JSON.stringify(b28)}`);
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
 *   平常    今天跌 5%：跌破买入线，但 20 日波动率只有二十几（远不到 40%），刹车不管
 *   暴跌    最近 25 天一天跌 6%、一天涨 3% 交替（全收益和价格指数一起乘，股息率不受影响；
 *           单日都在 ±11% 以内，不触发那项数据检查），今天再跌 4%：
 *           跌破买入线、跌破年线，20 日波动率七十多
 */
const N = series0.rows.length;
const steps = Array.from({ length: 25 }, (_, j) => (j % 2 === 0 ? 0.94 : 1.03));
let acc = 1;
const factor = steps.map((s) => (acc *= s));
const CRASH = series0.rows.map((r, i) => {
  const j = i - (N - 25);
  if (j < 0) return r;
  return { ...r, c: +(r.c * factor[j]).toFixed(2), p: +(r.p * factor[j]).toFixed(2) };
});
const scen = {
  plain: { rows: series0.rows, close: +(LAST0.c * 0.95).toFixed(2) },
  crash: { rows: CRASH, close: +(CRASH[N - 1].c * 0.96).toFixed(2) },
};
// 先验算前提，不然后面的断言测的不是这件事
{
  for (const [name, R, wantHot] of [['平常', scen.plain, false], ['暴跌', scen.crash, true]]) {
    const closes = [...R.rows.map((r) => r.c), R.close];
    const m30 = ma(closes, 30), m250 = closes.slice(-250).reduce((a, b) => a + b, 0) / 250, v = vol20(closes);
    const good = R.close < m30 * 0.97 && R.close < m250 && (v > 0.40) === wantHot;
    if (good) ok(`前提成立（${name}）：今天 ${R.close} < 买入线 ${(m30 * 0.97).toFixed(0)}，< 年线 ${m250.toFixed(0)}，20 日波动率 ${(v * 100).toFixed(1)}%`);
    else bad(`前提不成立（${name}）：收盘 ${R.close}，买入线 ${(m30 * 0.97).toFixed(0)}，年线 ${m250.toFixed(0)}，波动率 ${(v * 100).toFixed(1)}%`);
  }
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
  console.log('\n● 平常日子：刹车不管，照常出买入挂单');
  seed(scen.plain); at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const res = JSON.parse(r.text);
  const st = repoJSON('data/state.json'), b = barks[0];
  if (st.pending && st.pending.side === 'BUY' && st.pending.tierTo === 1) ok(`出了买入挂单（${EXEC} 执行）`); else bad(`应出买入挂单：${JSON.stringify(st.pending)}`);
  if (st.brake && st.brake.ok && !st.brake.hot && st.brake.below && !st.brake.blocked && st.brake.active) ok(`state.brake：波动率 ${(st.brake.vol * 100).toFixed(1)}%，收盘在年线（${st.brake.ma250}）下方，没有拦截`);
  else bad(`state.brake：${JSON.stringify(st.brake)}`);
  if (b && /暴跌刹车未触发：20 日波动率 [\d.]+%，超过 40% 且收盘跌破年线才拦/.test(b.body)) ok(`推送里有刹车状态：${b.body.split('\n').find((x) => x.includes('暴跌刹车'))}`);
  else bad(`推送里没有刹车状态：${show(b)}`);
  if (!files.has('data/brakelog.json')) ok('没拦截就不写 brakelog'); else bad('没拦截却写了 brakelog');
  if (res.brake && res.brake.ok === true && res.brake.blocked === false) ok('HTTP 返回带了刹车的结论'); else bad(`HTTP 返回：${JSON.stringify(res.brake)}`);
}

{
  console.log('\n● 连续大跌、波动率冲上 40% 以上又跌破年线：买入被拦下');
  seed(scen.crash); at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const res = JSON.parse(r.text);
  const st = repoJSON('data/state.json'), led = repoJSON('data/ledger.json'), blog = repoJSON('data/brakelog.json');
  const b = barks[0];
  if (res.ok === true) ok('运行成功（数据检查全部放行）'); else bad(`运行失败：${r.text.slice(0, 300)}`);
  if (st && !st.pending && st.tier === 0 && led.entries.length === 0) ok('没出挂单、没进账本，仓位仍是 0%'); else bad(`不该有挂单 / 账本：${JSON.stringify({ p: st && st.pending, n: led && led.entries.length })}`);
  if (st && st.brake && st.brake.hot && st.brake.below && st.brake.blocking && st.brake.blocked && st.brake.blocked.signalDate === TODAY && st.brake.blocked.tierTo === 1) {
    ok(`state.brake.blocked 记下了：收盘 ${st.brake.blocked.close}，年线 ${st.brake.blocked.ma250}，波动率 ${(st.brake.blocked.vol * 100).toFixed(1)}%`);
  } else bad(`state.brake：${JSON.stringify(st && st.brake)}`);
  if (st && st.gate && !st.gate.blocked && st.chase && !st.chase.blocked) ok('闸门、追高线都没插手（闸门没上膛，追高线只管年线上方）'); else bad(`闸门 / 追高线不该拦：${JSON.stringify({ g: st && st.gate, c: st && st.chase })}`);
  if (blog && blog.entries.length === 1 && blog.entries[0].signalDate === TODAY) ok('brakelog 记了一笔'); else bad(`brakelog：${JSON.stringify(blog)}`);
  if (!files.has('data/gatelog.json') && !files.has('data/chaselog.json')) ok('gatelog、chaselog 都没被碰'); else bad('刹车拦下的却记进了别的日志');
  if (b && b.title.startsWith('⛔') && b.title.includes('被暴跌刹车拦下') && b.level === 'timeSensitive' && b.group === '红利MA30·操作') {
    ok(`推送单独成一条、会响铃：${b.title}`);
  } else bad(`推送：${show(b)}`);
  const want = st && st.brake && st.brake.blocked ? brakeBlockedText(st.brake.blocked, EXEC, TODAY) : null;
  if (want && b && b.body.startsWith(want)) ok('推送正文和 brakeBlockedText 一字不差（面板横幅用的是同一句）'); else bad(`推送正文：${show(b)}\n      应以：${want || '（state 里没有拦截记录）'}`);
  if (b && b.body.includes(`${+EXEC.slice(5, 7)} 月 ${+EXEC.slice(8, 10)} 日`) && /无需操作/.test(b.body)) ok('写出了哪天不用操作'); else bad(`没写哪天不用操作：${show(b)}`);
  if (/被暴跌刹车拦下/.test(log.join('|'))) ok(`提交说明：${log[0]}`); else bad(`提交说明：${log.join('|')}`);
  if (res.brake && res.brake.blocked === true && !/[\d,]{7,}/.test(JSON.stringify(res.brake))) ok('HTTP 返回只说拦没拦，不带金额'); else bad(`HTTP 返回：${JSON.stringify(res.brake)}`);

  console.log('\n● 这条推送没送达：补发的和原来一字不差');
  const first = b;
  const s2 = { ...repoJSON('data/state.json'), push: { ok: false, at: `${TODAY} 21:00:52`, reason: '超时' } };
  files.set('data/state.json', JSON.stringify(s2));
  barks = []; at(`${TODAY} 22:30:05`);
  await call('/run');
  const again = barks[0];
  if (again && first && again.title === first.title && again.body.startsWith(first.body.split('\n↻')[0].slice(0, 120))) ok(`补发：${again.title}`); else bad(`补发不一致：${show(again)}`);
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 暴跌刹车全部通过'}\n`);
process.exit(fails ? 1 : 0);
