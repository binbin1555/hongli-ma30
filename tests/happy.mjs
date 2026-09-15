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
const { H, el, store, ROOT, ROWS, CAL, CORE, fractionsIn, banners } = await import('./harness.mjs');
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
    bond: { code: '008204', close: ROWS[idx].b },
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
  横幅: banners().length
    ? banners().map((b) => `${b.kick}｜${b.text}｜按钮「${b.btn.textContent}」`).join(' ∥ ')
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
 * 「刷新就重置」的定义：两个框变成空白，localStorage 里一个字不留。
 * 不再替你填账本推算值 —— 框里出现你没打过的数字，本身就是个误会源。
 */
const typedLeft = () => { const v = store.get('hlma30.calc'); return v && v !== 'null' ? v : null; };
function assertReset(typed, where) {
  const now = view().输入框;
  if (typedLeft()) bad(`${where}：刷新后 localStorage 里还留着计算器数字 ${typedLeft()}`);
  else if (now !== '｜') bad(`${where}：刷新后两个框该是空白，实际「${now}」`);
  else okline(`${where}：你打的 ${typed} 已清空，两个框空白`);
}

/**
 * 计算器之外的一切。空框时这些必须和「从没碰过计算器」一模一样 ——
 * 计算器只管算，不许把自己的状态漏到页面别处去。
 */
const outside = () => [
  `横幅 ${banners().length} 条`,
  ...banners().map((b) => `${b.kick}|${b.text}|${b.sub}|${b.btn.textContent}`),
  el('nextLine').textContent, el('nextSub').textContent,
  el('tierNum').textContent, el('pips').innerHTML,
  el('pnl').textContent, el('pnlCum').textContent, el('pnlTot').textContent,
].join('\n');

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
  if (v.输入框 !== '｜') bad(`打开时两个框该是空白，实际「${v.输入框}」`);
  else okline('打开时两个框空白 —— 没有替你预填任何数字');
  if (!/等你填/.test(v.算主)) bad(`空框时主位该说等你填，实际「${v.算主}」`);
}

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
  assertReset('1000000｜0', '隔夜刷新');
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
  const on = banners().length > 0;
  console.log(`  ${d} ${t}　横幅 ${on ? '仍在' : '不见了'}`);
  if (!on) bad(`${d} ${t} 没点确认，横幅却消失了`);
}
okline('三次刷新 + 跨日，横幅都还在');

console.log('\n  ── 点一下「我做了」');
// 横幅数量不对时要给出断言失败，不能让测试崩掉 —— 崩掉就看不出是哪条坏了
if (!banners().length) bad('该有一条横幅可点，实际一条都没有');
else banners()[0].btn.click();
console.log(`    点完：横幅 ${banners().length ? '还在' : '收起'}`);
if (banners().length) bad('点了确认横幅还不收');

await refresh(T2, '09:05');
console.log(`    再刷新：横幅 ${banners().length ? '又冒出来了' : '仍然收起'}`);
if (banners().length) bad('确认过的那笔，刷新后横幅又冒出来了');
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
  assertReset('1000000｜0', '跨日刷新');

  // 等待触发是绝大多数日子的常态，这张卡片天天都在。那几句「系统怎么运作」
  // 每天一模一样，必须收在折叠块里 —— 不然它会慢慢长回一屏说明书。
  const html = el('nextSub').innerHTML;
  const 默认可见 = html.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/<details/.test(html)) bad('等待状态的长说明没收进折叠块');
  else if (默认可见.length > 60) bad(`等待状态默认可见的说明太长（${默认可见.length} 字）：「${默认可见}」`);
  else okline(`等待状态默认只露 ${默认可见.length} 字，其余收在「这是怎么运作的」里`);
}

/* ---- 空框时必须彻底静默：计算器的状态不许漏到页面别处 ---- */
console.log('\n  ── 空框时页面上方长什么样，先记下来');
const quiet = outside();
console.log('     故意填一个和账本对不上的数：说自己全是现金（0%），而账本已记到 25%');
type(1000000, 0);
console.log(`     卡片变成 → ${el('nextLine').textContent.trim()}`);
if (outside() === quiet) bad('填了明显对不上的数字，页面上方却毫无反应 —— 这个检查本身测不出东西');
else okline('填了对不上的数字，页面上方确实会改口（说明这个检查有效）');

await refresh(T2, '09:10');
console.log(`     刷新后卡片 → ${el('nextLine').textContent.trim()}`);
if (outside() !== quiet) bad('刷新后页面上方没回到空框时的样子 —— 计算器把状态漏出去了');
else okline('刷新后页面上方逐字回到空框时的样子');
assertReset('1000000｜0', '漏没漏出去');

/* ---- 自动预填没了，改成一个按钮；按钮填的数字不算「实盘证据」---- */
console.log('\n  ── 懒得查券商时，点「用账本数字填入」');
if (el('resetBasis').hidden) bad('本金已设，按钮却藏着 —— 那就永远没人点得到');
el('resetBasis').click();
console.log(`     两个框 → ${view().输入框}　标签 → ${el('basisChip').textContent.trim()}`);
console.log(`     算主　 → ${el('oMain').textContent.trim()}`);
{
  if (view().输入框 === '｜') bad('点了按钮，两个框还是空的');
  if (!/账本/.test(el('basisChip').textContent)) bad(`标签该说明数字来自账本，实际「${el('basisChip').textContent}」`);
  if (/按你填的数字/.test(el('oSub').textContent)) bad('按钮填的数字被说成「按你填的数字」—— 那不是你填的');
  // 关键：账本推算值不是你券商里的真实持仓，不能拿它去判「实盘对不上」。
  // 行情一涨一跌，推算出的占比随时会跨过档位边界，凭空报一条假警报。
  if (outside() !== quiet) bad('按钮填的账本推算值影响了页面上方 —— 它不该被当成实盘证据');
  else okline('按钮填入后页面上方纹丝不动 —— 账本推算值没被当成实盘证据');
}
await refresh(T2, '09:15');
assertReset('账本推算值', '按钮填的也一样清空');

// 上面那条「纹丝不动」只说明这次没出事：本轮行情没漂移，账本推算值正好
// 落在账本档位上，就算闸门失灵也看不出来。所以直球验一下闸门本身 ——
// 塞一份明显对不上的数字、标成账本来源，判断实盘落后的那套必须照样闭嘴。
store.set('hlma30.calc', JSON.stringify({ cash: 1000000, hold: 0, at: `${T2} 09:15`, from: 'ledger' }));
if (H.behindState() !== null) bad('标成账本来源的数字仍被当成实盘证据 —— 行情一漂移就会报假警报');
else okline('标成账本来源的数字不参与「实盘对不上」判断');
store.set('hlma30.calc', 'null');
H.renderInputDependent();

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
  assertReset(typed2, '当晚刷新');
}

console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ 正常路径全程无误：文案、金额、计算器重置、横幅保持，全部符合预期'}\n`);
process.exitCode = fails ? 1 : 0;
