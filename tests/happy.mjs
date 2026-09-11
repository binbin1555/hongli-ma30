/**
 * 正常操作下的 T / T+1 / T+2 全流程。
 *
 * 这一份不找边角料，只走「你每一步都做对」的那条路，而且把两条新契约
 * 当成主角来验：
 *
 *   计算器只管算 —— 刷新一次就清空，绝不跨会话留着旧数字误报
 *   横幅只管盯   —— 不点确认就永远不消失，哪怕系统早已记完账
 *
 * 「刷新」是真刷新：把页面自己的 load() 再跑一遍（fetch 被接到本剧本的
 * 数据上），而不是手工清一下 localStorage 假装刷过。
 *
 * 用法：npm run happy（npm test 里也会跑）
 */
/* ---- 时刻钉在盘中 10:00，日期仍跟着今天走 ---- */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { H, el, store, ROOT, ROWS, CAL, CORE, fractionsIn } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, orderAmount, WEIGHTS, MA_LEN, COMMISSION, posPct } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`      ✗ ${m}`); };
const okline = (m) => console.log(`      ✓ ${m}`);

/* ---------------- 剧本 ---------------- */
const T = '2026-05-28', T1 = '2026-05-29', T2 = '2026-06-01';
const iT = ROWS.findIndex((r) => r.d === T);
const LAUNCH = ROWS[iT - 40].d;
const PRINCIPAL = 1000000, ETF = 1.46;

/** 复刻 Worker 的一天：执行昨日待办 → 记账 → 算今日信号 → 生成新待办 */
function workerDay(idx, prev, ledger) {
  const closes = ROWS.slice(0, idx + 1).map((r) => r.c);
  const close = closes[closes.length - 1];
  const ma30 = ma(closes, MA_LEN);
  const today = ROWS[idx].d;
  let tier = prev.tier, executed = null;
  if (prev.pending && prev.pending.signalDate < today) {
    const p = prev.pending;
    executed = { seq: ledger.entries.length + 1, date: today, signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL', tierFrom: p.tierFrom, tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo], price: close, etfPrice: ETF, late: false,
      recordedAt: `${today} 21:00:45` };
    ledger.entries.push(executed);
    tier = p.tierTo;
  }
  const want = nextTier(tier, signal(close, ma30));
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' } : null;
  const tg = triggers(close, ma30);
  return { executed, pending, close, ma30, state: {
    schema: 1, launchDate: LAUNCH, asof: today, lastRun: `${today} 21:00:45`, tier, pending,
    index: { code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: +((close / closes[closes.length - 2] - 1) * 100).toFixed(2),
      buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
    bond: { code: 'H11001', close: ROWS[idx].b },
    etf: { code: '515180', close: ETF, asof: today, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${today} 21:00:45` },
  } };
}

/* ---------------- 真刷新：把 load() 再跑一遍 ---------------- */
let SERVE = null;                       // 当前这一刻仓库里是什么
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  if (SERVE && rel in SERVE) return { ok: true, json: async () => SERVE[rel] };
  return realFetch(u, o);
};
async function refresh(day, at) {
  goto(day, at);
  await H.load();                       // 页面自己的加载流程，含「清空计算器」
}

/** 用户在两个输入框里打字（走页面自己的保存逻辑） */
function type(cash, hold) {
  el('inCash').value = String(cash);
  el('inHold').value = String(hold);
  for (const f of (el('inCash')._ls && el('inCash')._ls.input) || []) f({});
  H.renderInputDependent();
}

const view = () => ({
  横幅: el('banner').classList.contains('on')
    ? `${el('bKick').textContent.trim()}｜${el('bText').textContent.trim()}｜按钮「${el('bDone').textContent.trim()}」`
    : null,
  卡片: el('nextLine').textContent.trim(),
  仓位: el('tierNum').textContent.trim(),
  输入框: `${el('inCash').value}｜${el('inHold').value}`,
  算主: el('oMain').textContent.trim(),
  时点: el('timing').textContent.trim(),
});
// 仓位一律用百分比。「2/5 档」会被读成「还差三档」，而那几档根本不存在。
const show = (o) => {
  for (const [k, v] of Object.entries(o)) {
    if (!v) continue;
    console.log(`    ${k.padEnd(3, '　')} ${v}`);
    const f = fractionsIn(v);
    if (f.length) bad(`${k} 里又出现分数写法 ${f.join('、')}：「${v}」`);
  }
};

/**
 * 「刷新就重置」到底该重置成什么：
 * 你亲手打的数字必须消失（localStorage 里不留），两个框回到账本按当前
 * 行情现算出来的值 —— 那个值每次加载都重算，不会隔夜变味。
 */
const typedLeft = () => { const v = store.get('hlma30.calc'); return v && v !== 'null' ? v : null; };
function assertReset(typed, derived, where) {
  const now = view().输入框;
  if (typedLeft()) bad(`${where}：刷新后 localStorage 里还留着计算器数字 ${typedLeft()}`);
  else if (now === typed) bad(`${where}：刷新后框里还是你打的 ${typed}`);
  else if (derived && now !== derived) bad(`${where}：该回到账本现算值 ${derived}，实际 ${now}`);
  else okline(`${where}：你打的 ${typed} 已清空，框里换回账本现算的 ${now}`);
}

/** 目标市值法独立验算 —— 不复用被测代码 */
const wantAmt = (cash, hold, tier) => {
  const S = cash + hold, w = WEIGHTS[tier], want = w * S;
  return want > hold ? { side: 'BUY', amount: (want - hold) / (1 + w * COMMISSION) }
    : { side: 'SELL', amount: (hold - want) / (1 - w * COMMISSION) };
};
const shownAmt = (s) => Number((s.match(/([\d,]+) 元/) || [])[1]?.replace(/,/g, ''));

/* ==================================================================== */
store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
const series = { rows: ROWS };
const cal2026 = { year: 2026, tradingDays: CAL };
const serveWith = (state) => { SERVE = {
  'data/state.json': state, 'data/ledger.json': JSON.parse(JSON.stringify(ledger)),
  'data/series.json': series, 'calendar/2026.json': cal2026 }; };

console.log(`\n本金 ${PRINCIPAL.toLocaleString('en-US')}　空仓起步　行情用真实历史`);
console.log(`T = ${T}（周四）　T+1 = ${T1}（周五）　T+2 = ${T2}（周一）`);

/* ---------------- T 日 ---------------- */
console.log(`\n${'═'.repeat(60)}\nT 日 ${T} —— 收盘后出信号\n${'═'.repeat(60)}`);
const d0 = workerDay(iT, { tier: 0, pending: null }, ledger);
console.log(`\n  21:00 系统：收盘 ${d0.close.toFixed(2)}　买入线 ${d0.state.index.buyTrigger}　→ 生成待办 ${posPct(0)} → ${posPct(1)}`);
if (!d0.pending) bad('T 日没出信号，剧本前提不成立');

serveWith(d0.state);
await refresh(T, '21:05');
console.log('\n  ── 21:05 收到推送，打开面板');
show(view());
{
  const v = view();
  if (!v.横幅) bad('T 日晚没有横幅');
  if (!v.卡片.includes('5 月 29 日')) bad(`卡片没写出执行日：「${v.卡片}」`);
  okline(`两个框账本已自动填好：${v.输入框}（本金 100 万按行情现算）`);
}
const derived = view().输入框;   // 账本现算值，刷新后该回到这里

console.log('\n  ── 在计算器里填入真实持仓：1000000 / 0');
type(1000000, 0);
show({ 算主: el('oMain').textContent.trim(), 时点: el('timing').textContent.trim() });
{
  const w = wantAmt(1000000, 0, 1);
  const g = shownAmt(el('oMain').textContent);
  if (Math.abs(g - w.amount) > 1) bad(`金额 ${g}，按目标市值法应为 ${Math.round(w.amount)}`);
  else okline(`金额和独立验算一致：${Math.round(w.amount).toLocaleString('en-US')} 元`);
}

/* ---------------- T+1 日 ---------------- */
console.log(`\n${'═'.repeat(60)}\nT+1 日 ${T1} —— 执行日，按时做\n${'═'.repeat(60)}`);
await refresh(T1, '10:00');
console.log('\n  ── 10:00 刷新打开（这是一次真刷新）');
show(view());
{
  const v = view();
  assertReset('1000000｜0', derived, '隔夜刷新');
  if (!v.卡片.includes('（今天')) bad(`执行日当天卡片该说「今天」：「${v.卡片}」`);
  if (!v.横幅) bad('执行日当天横幅不见了');
}

console.log('\n  ── 再填一次真实持仓，照它下单');
type(1000000, 0);
const buy = wantAmt(1000000, 0, 1).amount;
const hold = Math.floor(buy / ETF / 100) * 100 * ETF;
const cash = PRINCIPAL - hold * (1 + COMMISSION);
console.log(`    计算器：${el('oMain').textContent.trim()}`);
console.log(`    14:55 成交 ${Math.round(hold).toLocaleString('en-US')} 元，余现金 ${Math.round(cash).toLocaleString('en-US')}`);

const d1 = workerDay(iT + 1, d0.state, ledger);
console.log(`\n  21:00 系统记账：${d1.executed.date} ${posPct(d1.executed.tierFrom)}→${posPct(d1.executed.tierTo)}　新仓位 ${posPct(d1.state.tier)}`);
serveWith(d1.state);

await refresh(T1, '21:05');
console.log('\n  ── 21:05 记账后刷新');
show(view());
{
  const v = view();
  if (v.仓位 !== posPct(1)) bad(`仓位该是 ${posPct(1)}，实际「${v.仓位}」`);
  if (!v.横幅) bad('记账后横幅就消失了 —— 它该撑到你点确认为止');
  else if (!/你做了吗/.test(v.横幅)) bad(`记账后横幅没改口追问：「${v.横幅}」`);
  else okline('记账后横幅改口追问「你做了吗」，没有自行消失');
}

/* ---------------- 横幅：不点就不消失 ---------------- */
console.log(`\n${'═'.repeat(60)}\n横幅只管盯 —— 连刷三次、跨一天，不点就不消失\n${'═'.repeat(60)}`);
for (const [d, t] of [[T1, '21:10'], [T1, '23:00'], [T2, '09:00']]) {
  await refresh(d, t);
  const on = el('banner').classList.contains('on');
  console.log(`  ${d} ${t}　横幅 ${on ? '仍在' : '不见了'}`);
  if (!on) bad(`${d} ${t} 没点确认，横幅却消失了`);
}
okline('三次刷新 + 跨日，横幅都还在');

console.log('\n  ── 点一下「我做了」');
el('bDone').click();
console.log(`    点完：横幅 ${el('banner').classList.contains('on') ? '还在' : '收起'}`);
if (el('banner').classList.contains('on')) bad('点了确认横幅还不收');

await refresh(T2, '09:05');
console.log(`    再刷新：横幅 ${el('banner').classList.contains('on') ? '又冒出来了' : '仍然收起'}`);
if (el('banner').classList.contains('on')) bad('确认过的那笔，刷新后横幅又冒出来了');
else okline('确认一次就永久收起');

/* ---------------- T+2 日 ---------------- */
console.log(`\n${'═'.repeat(60)}\nT+2 日 ${T2} —— 一切正常的一天\n${'═'.repeat(60)}`);
console.log('\n  ── 09:05 打开（刚刷新过）');
show(view());
{
  const v = view();
  if (v.横幅) bad(`已确认过，不该再有横幅：「${v.横幅}」`);
  if (!/距离下一次/.test(v.卡片)) bad(`该回到等待态：「${v.卡片}」`);
  if (/欠着|还没做|补齐/.test(`${v.卡片}${v.时点}${v.算主}`)) bad(`一切正常却提示欠账：「${v.卡片}」`);
  assertReset('1000000｜0', null, '跨日刷新');
}

console.log('\n  ── 填入成交后的真实持仓，看它怎么说');
const typed2 = `${Math.round(cash)}｜${Math.round(hold)}`;
type(Math.round(cash), Math.round(hold));
show({ 算主: el('oMain').textContent.trim(), 时点: el('timing').textContent.trim() });
{
  const main = el('oMain').textContent.trim();
  if (!/预估/.test(main)) bad(`没有待执行的操作，计算器该标「预估」：「${main}」`);
  else okline('标了「预估」—— 不会被误当成今天要下的单');
  if (/欠着|补齐/.test(main)) bad(`实盘和账本对得上，却提示补齐：「${main}」`);
  const w = wantAmt(Math.round(cash), Math.round(hold), 2);
  const g = shownAmt(main);
  if (Math.abs(g - w.amount) > 1) bad(`下一档预估 ${g}，独立验算应为 ${Math.round(w.amount)}`);
  else okline(`下一档预估金额与独立验算一致：${Math.round(w.amount).toLocaleString('en-US')} 元`);
}

const d2 = workerDay(iT + 2, d1.state, ledger);
console.log(`\n  21:00 系统：仓位 ${posPct(d2.state.tier)}　新待办 ${d2.pending ? '有' : '无'}　账本 ${ledger.entries.length} 笔`);
serveWith(d2.state);
await refresh(T2, '21:05');
console.log('\n  ── 21:05 当晚最后看一眼');
show(view());
{
  const v = view();
  if (/欠着|还没做|补齐/.test(`${v.卡片}${v.时点}`)) bad(`当晚仍提示欠账：「${v.卡片}」`);
  assertReset(typed2, null, '当晚刷新');
}

console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ 正常路径全程无误：文案、金额、计算器重置、横幅保持，全部符合预期'}\n`);
process.exitCode = fails ? 1 : 0;
