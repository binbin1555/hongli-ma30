/**
 * 闸门：红利变贵（利差跌破 −0.25%，回到 +0.25% 以上才解除）、而且收盘跌破年线时，买入信号不执行。
 *
 * 一、核心函数（shared/strategy.js 的 gateState / gateBlocks / gateLine）
 *   股息率的推算和手算一致；回差按规矩开关；数据缺 1–4 天沿用旧值、缺满 5 天按未上膛放行；
 *   全收益和价格指数对不上的那天当作没取到；只拦买入；仓库里的真实行情算出来和回测同一个数
 *
 * 二、走 Worker 真正的 /run 入口（外部全换成内存假件，同 cashplan-push.mjs）
 *   没上膛 → 照常出买入挂单，推送里有一行闸门状态
 *   上膛又跌破年线 → 不出挂单、不进账本、记进 gatelog，推送单独成一条（会响铃）
 *   推送没送达 → 22:30 补发的那条和原来一字不差
 *   国债收益率连续 5 个交易日取不到 → 按未上膛放行，第 11 项检查亮红、推送里说清楚
 *
 * 用法：npm run gate（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateState, gateBlocks, gateLine, gateBlockedText, GATE, MAX_TIER } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ================================================================ 一、核心函数 */
console.log('\n【一】核心函数');

/** 造一段行情：n 天，全收益每天涨 r，除息日全收益比价格多涨 div；y 是国债收益率（%） */
function synth(n, { r = 0.0002, divDays = {}, y = () => 2.0 } = {}) {
  const rows = [];
  let c = 10000, p = 5000;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    if (i) { const dv = divDays[i] || 0; c *= 1 + r; p *= (1 + r) / (1 + dv); }
    rows.push({ d, c: +c.toFixed(4), p: +p.toFixed(4), y: y(i) });
  }
  return rows;
}

{
  // 1. 股息率：最近 250 天里两次除息，各 2% 和 1.5%（按除息前一天的价格点位算分红点数）
  const rows = synth(400, { divDays: { 100: 0.03, 300: 0.02, 350: 0.015 } });
  const g = gateState(rows);
  // 窗口是最近 250 行（第 150–399 行）：300、350 两次在里面，100 那次在窗口外
  const pts = (i, dv) => rows[i - 1].p * dv;
  const want = (pts(300, 0.02) + pts(350, 0.015)) / rows[399].p;
  if (g && near(g.dy, want, 1e-4)) ok(`股息率和手算一致：${(g.dy * 100).toFixed(3)}%（窗口外那次除息不算）`);
  else bad(`股息率 ${g && g.dy}，手算 ${want}`);
  if (g && near(g.ma250, rows.slice(-250).reduce((a, x) => a + x.c, 0) / 250, 1e-6)) ok('年线 = 最近 250 个收盘的平均');
  else bad('年线算错了');
}

{
  // 2. 回差：利差 +1% → −0.10%（还在中间，不上膛）→ −0.30%（上膛）→ 0%（仍上膛）→ +0.30%（解除）
  //    股息率固定 ≈ 0（不除息），用国债收益率推利差：利差 = 0 − y
  const path = [[0, -1.0], [300, 0.10], [310, 0.30], [320, 0.0], [330, -0.30]];
  const yAt = (i) => { let v = -1.0; for (const [k, val] of path) if (i >= k) v = val; return v <= 0 ? 0.0001 : v; };
  // 利差 = 0 − y：y = 0.10 → −0.10%；0.30 → −0.30%；0.0001 → ≈0；而「+0.30%」做不出来（y 不能为负）——
  // 解除那一步改用分红把股息率抬上去
  const rows = synth(340, { y: yAt, divDays: { 335: 0.012 } });
  const at = (k) => gateState(rows, rows[k].d);
  const s305 = at(305), s315 = at(315), s325 = at(325), s339 = at(339);
  if (s305 && !s305.armed) ok(`利差 ${(s305.spread * 100).toFixed(2)}%：还在 −0.25% 上方，不上膛`); else bad(`305：${JSON.stringify(s305)}`);
  if (s315 && s315.armed) ok(`利差 ${(s315.spread * 100).toFixed(2)}%：跌破 −0.25%，上膛`); else bad(`315：${JSON.stringify(s315)}`);
  if (s325 && s325.armed) ok(`利差 ${(s325.spread * 100).toFixed(2)}%：回到 0 附近但没过 +0.25%，仍上膛（回差）`); else bad(`325：${JSON.stringify(s325)}`);
  if (s339 && !s339.armed && s339.spread > GATE.disarmAbove) ok(`利差 ${(s339.spread * 100).toFixed(2)}%：回到 +0.25% 以上，解除`); else bad(`339：${JSON.stringify(s339)}`);
}

{
  // 3. 数据缺失：国债收益率先一直很高（利差远低于 −0.25%，上膛），最后几天取不到
  const base = synth(300, { y: () => 6.0 });
  const cut = (k) => base.map((r, i) => (i >= base.length - k ? { ...r, y: null } : r));
  const g4 = gateState(cut(4)), g5 = gateState(cut(5));
  if (g4.dataOk && g4.armed && g4.staleY === 4) ok('国债收益率缺 4 天：沿用旧值，照样上膛'); else bad(`缺 4 天：${JSON.stringify(g4)}`);
  if (!g5.dataOk && !g5.armed && g5.memArmed && !g5.blocking) ok('缺满 5 天：按未上膛放行（回差记着的状态不丢，数据回来接着用）'); else bad(`缺 5 天：${JSON.stringify(g5)}`);
  if (/暂按「未上膛」处理/.test(gateLine(g5, base[299].d))) ok(`状态行说清楚了：${gateLine(g5, base[299].d)}`); else bad(`状态行：${gateLine(g5, base[299].d)}`);
  const pCut = base.map((r, i) => (i >= base.length - 5 ? { ...r, p: null } : r));
  const gp = gateState(pCut);
  if (!gp.dataOk && /价格指数已连续 5 个交易日/.test(gp.problem)) ok('价格指数缺满 5 天：同样放行'); else bad(`价格指数缺 5 天：${JSON.stringify(gp)}`);
  const short = gateState(synth(200));
  if (!short.dataOk && /不足 250/.test(short.problem)) ok('行情不足一年：算不出，放行'); else bad(`行情不足：${JSON.stringify(short)}`);
}

{
  // 4. 全收益和价格指数对不上（价格指数抄成了别的数）：那天当作没取到，不让它混进股息率
  const rows = synth(300, { divDays: { 120: 0.02 } });
  const clean = gateState(rows);
  const dirty = rows.map((r, i) => (i === 299 ? { ...r, p: r.p * 2.1 } : r));
  const g = gateState(dirty);
  if (g.staleP === 1 && near(g.dy, clean.dy * rows[299].p / rows[298].p, 1e-6)) ok('错配的那天被剔除，股息率按前一天的价格指数算');
  else bad(`错配没被剔除：staleP=${g.staleP} dy=${g.dy} vs ${clean.dy}`);
}

{
  // 5. 只拦买入；满仓不会再有买入；没拦截时不拦
  const blocking = { blocking: true };
  const t = [
    [gateBlocks('BUY', 0, blocking), true, '拦截时的买入'],
    [gateBlocks('SELL', 2, blocking), false, '拦截时的卖出'],
    [gateBlocks(null, 2, blocking), false, '没有信号'],
    [gateBlocks('BUY', MAX_TIER, blocking), false, '满仓（本来就不会再买）'],
    [gateBlocks('BUY', 1, { blocking: false }), false, '没在拦截'],
    [gateBlocks('BUY', 1, null), false, '算不出闸门'],
  ];
  const wrong = t.filter(([got, want]) => got !== want);
  if (!wrong.length) ok('只拦买入：卖出、满仓、未拦截、算不出时一律放行'); else bad(`gateBlocks 判错：${wrong.map((x) => x[2]).join('、')}`);
  // 起用日之前照算照显示，但不拦
  const rows = synth(300, { y: () => 6.0 });
  const g = gateState(rows);   // 合成行情在 2020 年，早于起用日
  if (g.armed && !g.active && !g.blocking) ok(`起用日（${GATE.startDate}）之前：上膛照显示，不拦`); else bad(`起用日之前：${JSON.stringify(g)}`);
}

{
  // 6. 仓库里的真实行情：和分析时算出来的同一个数（2026-10-28：股息率 4.47%、国债 1.63%、利差 +2.84%、年线 11,864）
  const series = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
  const g = gateState(series.rows, '2026-10-28');
  if (g && near(g.dy, 0.0447, 0.0002) && near(g.y10, 0.016345, 1e-6) && near(g.spread, 0.0284, 0.0002) && near(g.ma250, 11863.73, 0.05) && !g.armed) {
    ok(`2026-10-28：${gateLine(g, '2026-10-28')}`);
  } else bad(`真实行情算出来不对：${JSON.stringify(g)}`);
  const miss = series.rows.filter((r) => r.p == null || r.y == null).map((r) => r.d);
  if (!miss.length) ok(`行情 ${series.rows.length} 行都有价格指数和国债收益率`); else bad(`这些天缺数：${miss.slice(0, 5).join('、')}`);
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
const LAST = series0.rows[series0.rows.length - 1];
const TODAY = cal.tradingDays.find((d) => d > LAST.d);
const EXEC = cal.tradingDays.find((d) => d > TODAY);
const ymd8 = (d) => d.replace(/-/g, '');
const CLOSE = +(LAST.c * 0.95).toFixed(2);   // 跌 5%：一定跌破 MA30×0.97，也一定在年线下（年线 ≈ 11,864）

/* 场景开关 */
let yieldMode = 'normal';   // normal：照仓库里的数；high：最近 30 天都是 6%（利差远低于 −0.25%）；fail：接口报错
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
    const rows = [...series0.rows.map((r) => ({ d: r.d, c: px ? r.p : r.c })),
      { d: TODAY, c: px ? +(LAST.p * CLOSE / LAST.c).toFixed(2) : CLOSE }];
    const data = rows.filter((r) => ymd8(r.d) >= a && ymd8(r.d) <= b).map((r, k, arr) => ({
      tradeDate: ymd8(r.d), close: r.c, changePct: k ? +((r.c / arr[k - 1].c - 1) * 100).toFixed(2) : 0,
    }));
    return json({ code: '200', data });
  }
  if (url.startsWith('https://datacenter-web.eastmoney.com/')) {
    if (yieldMode === 'fail') return json({ message: 'err' }, 500);
    const data = series0.rows.slice(-30).reverse()
      .map((r) => ({ SOLAR_DATE: `${r.d} 00:00:00`, EMM00166466: yieldMode === 'high' ? 6.0 : r.y }));
    return json({ result: { data } });
  }
  if (url.startsWith('https://fund.eastmoney.com/pingzhongdata/')) {
    const pts = [...series0.rows.filter((r) => r.b).map((r) => [r.d, r.b]), [TODAY, LAST.b]]
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
function seed(rows = series0.rows) {
  resetRepo({
    'data/state.json': { ...base, asof: LAST.d, lastRun: `${LAST.d} 21:00:40`, tier: 0, pending: null, push: { ok: true, at: `${LAST.d} 21:00:50` } },
    'data/ledger.json': { schema: 1, launchDate: base.launchDate, entries: [] },
    'data/series.json': { ...series0, rows },
    'calendar/2026.json': cal,
  });
  barks = [];
}
const show = (b) => (b ? `${b.title}｜${b.body.replace(/\n/g, '⏎')}` : '（没有推送）');

{
  console.log('\n● 没上膛：照常出买入挂单');
  seed(); yieldMode = 'normal'; at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const st = repoJSON('data/state.json'), b = barks[0];
  if (st.pending && st.pending.side === 'BUY' && st.pending.tierTo === 1) ok(`出了买入挂单（${EXEC} 执行）`); else bad(`应出买入挂单：${JSON.stringify(st.pending)}`);
  if (st.gate && st.gate.dataOk && !st.gate.armed && !st.gate.blocked && st.gate.below) ok(`state.gate：未上膛，收盘在年线下（${st.gate.ma250}），没有拦截`); else bad(`state.gate：${JSON.stringify(st.gate)}`);
  if (b && /闸门未上膛：利差 \+/.test(b.body)) ok(`推送里有闸门状态：${b.body.split('\n').find((x) => x.includes('闸门'))}`); else bad(`推送里没有闸门状态：${show(b)}`);
  const c11 = JSON.parse(r.text).checks.find((c) => c.id === 11);
  if (c11 && c11.ok && !c11.fatal) ok(`第 11 项检查：${c11.detail}`); else bad(`第 11 项检查：${JSON.stringify(c11)}`);
  if (!files.has('data/gatelog.json')) ok('没拦截就不写 gatelog'); else bad('没拦截却写了 gatelog');
  const row = repoJSON('data/series.json').rows.find((x) => x.d === TODAY);
  if (row && row.p > 0 && row.y === null) ok(`今天这行写进了价格指数 ${row.p}；国债收益率还没出，留空等下一轮补`); else bad(`今天这行：${JSON.stringify(row)}`);
  const prev = repoJSON('data/series.json').rows.find((x) => x.d === LAST.d);
  if (prev && prev.p === LAST.p && prev.y === LAST.y) ok('已有的 p、y 没被盖掉'); else bad(`已有的行被改了：${JSON.stringify(prev)}`);
}

{
  console.log('\n● 上膛又跌破年线：买入被拦下');
  seed(); yieldMode = 'high'; at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const res = JSON.parse(r.text);
  const st = repoJSON('data/state.json'), led = repoJSON('data/ledger.json'), glog = repoJSON('data/gatelog.json');
  const b = barks[0];
  if (!st.pending && st.tier === 0 && led.entries.length === 0) ok('没出挂单、没进账本，仓位仍是 0%'); else bad(`不该有挂单 / 账本：${JSON.stringify({ p: st.pending, n: led.entries.length })}`);
  if (st.gate && st.gate.armed && st.gate.blocking && st.gate.blocked && st.gate.blocked.signalDate === TODAY && st.gate.blocked.tierTo === 1) {
    ok(`state.gate.blocked 记下了：利差 ${(st.gate.spread * 100).toFixed(2)}%，年线 ${st.gate.ma250}`);
  } else bad(`state.gate：${JSON.stringify(st.gate)}`);
  if (glog && glog.entries.length === 1 && glog.entries[0].signalDate === TODAY) ok('gatelog 记了一笔'); else bad(`gatelog：${JSON.stringify(glog)}`);
  if (b && b.title.startsWith('⛔') && b.title.includes('被闸门拦下') && b.level === 'timeSensitive' && b.group === '红利MA30·操作') {
    ok(`推送单独成一条、会响铃：${b.title}`);
  } else bad(`推送：${show(b)}`);
  const want = st.gate && st.gate.blocked ? gateBlockedText(st.gate.blocked, EXEC, TODAY) : null;
  if (want && b && b.body.startsWith(want)) ok('推送正文和 gateBlockedText 一字不差（面板横幅用的是同一句）'); else bad(`推送正文：${show(b)}\n      应以：${want || '（state 里没有拦截记录）'}`);
  if (b && b.body.includes(`${+EXEC.slice(5, 7)} 月 ${+EXEC.slice(8, 10)} 日`) && /无需操作/.test(b.body)) ok('写出了哪天不用操作'); else bad(`没写哪天不用操作：${show(b)}`);
  if (/被闸门拦下/.test(log.join('|'))) ok(`提交说明：${log[0]}`); else bad(`提交说明：${log.join('|')}`);
  if (res.gate && res.gate.blocked === true && !/[\d,]{7,}/.test(JSON.stringify(res.gate))) ok('HTTP 返回只说拦没拦，不带金额'); else bad(`HTTP 返回：${JSON.stringify(res.gate)}`);

  console.log('\n● 这条推送没送达：补发的和原来一字不差');
  const first = b;
  const s2 = { ...repoJSON('data/state.json'), push: { ok: false, at: `${TODAY} 21:00:52`, reason: '超时' } };
  files.set('data/state.json', JSON.stringify(s2));
  barks = []; at(`${TODAY} 22:30:05`);
  await call('/run');
  const again = barks[0];
  if (again && again.title === first.title && again.body.startsWith(first.body.split('\n↻')[0].slice(0, 120))) ok(`补发：${again.title}`); else bad(`补发不一致：${show(again)}`);
}

{
  console.log('\n● 国债收益率缺 4 天：沿用旧值，照样拦');
  const rows = series0.rows.map((r, i) => (i >= series0.rows.length - 3 ? { ...r, y: null } : { ...r, y: 6.0 }));
  seed(rows); yieldMode = 'fail'; at(`${TODAY} 21:00:30`);
  await call('/run');
  const st = repoJSON('data/state.json');
  if (st.gate && st.gate.dataOk && st.gate.staleY === 4 && st.gate.blocked) ok('缺 4 天（最近 3 行 + 今天）：沿用 4 天前的 6%，照样拦下'); else bad(`缺 4 天：${JSON.stringify(st.gate)}`);
}

{
  console.log('\n● 国债收益率缺满 5 天：按未上膛放行');
  const rows = series0.rows.map((r, i) => (i >= series0.rows.length - 4 ? { ...r, y: null } : { ...r, y: 6.0 }));
  seed(rows); yieldMode = 'fail'; at(`${TODAY} 21:00:30`);
  const r = await call('/run');
  const st = repoJSON('data/state.json'), b = barks[0];
  if (st.pending && st.pending.side === 'BUY' && st.gate && !st.gate.dataOk && st.gate.memArmed && !st.gate.armed) ok('照常出了买入挂单（回差记着上膛，但数据太旧，放行）'); else bad(`应放行：${JSON.stringify({ p: st.pending, g: st.gate })}`);
  const c11 = JSON.parse(r.text).checks.find((c) => c.id === 11);
  if (c11 && !c11.ok && !c11.fatal && /暂按未上膛处理/.test(c11.detail)) ok(`第 11 项亮红但不致命：${c11.detail}`); else bad(`第 11 项：${JSON.stringify(c11)}`);
  if (b && /闸门要用的数据是新的/.test(b.body) && /暂按「未上膛」处理/.test(b.body)) ok('推送里点名了没通过的检查，也说了按未上膛处理'); else bad(`推送：${show(b)}`);
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 闸门全部通过'}\n`);
process.exit(fails ? 1 : 0);
