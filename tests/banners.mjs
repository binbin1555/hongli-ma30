/**
 * 三个怀疑，直接验（修复后这三条都该翻绿）：
 *
 * 一、待办状态下横幅说「无论点不点，系统都已按规则把这笔操作写进不可更改的
 *     记录」—— 可这时候账本里一笔都没有，这句话是假的。
 *
 * 二、T 日晚上按钮就写着「已完成」。那时你根本做不了（收盘了，操作是下一个
 *     交易日的）。照字面点下去，真正该下单那天还有没有提醒？
 *
 * 三、连着触发时旧的那笔排不上横幅，「另有 N 笔没确认过」还清得掉吗？
 */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

const { H, el, store, ROWS, CAL, CORE, banners, bannerText } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, WEIGHTS, MA_LEN, posPct } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const T = '2026-06-26', T1 = '2026-06-29', T2 = '2026-06-30';
const iT = ROWS.findIndex((r) => r.d === T);
const LAUNCH = ROWS[iT - 40].d;
const PRINCIPAL = 1000000, ETF = 1.46;

function workerDay(idx, prev, ledger) {
  const closes = ROWS.slice(0, idx + 1).map((r) => r.c);
  const close = closes[closes.length - 1], ma30 = ma(closes, MA_LEN), today = ROWS[idx].d;
  let tier = prev.tier;
  if (prev.pending && prev.pending.signalDate < today) {
    const p = prev.pending;
    ledger.entries.push({ seq: ledger.entries.length + 1, date: today, signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL', tierFrom: p.tierFrom, tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo], price: close, etfPrice: ETF, late: false,
      recordedAt: `${today} 21:00:45` });
    tier = p.tierTo;
  }
  const want = nextTier(tier, signal(close, ma30));
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' } : null;
  const tg = triggers(close, ma30);
  return { pending, state: {
    schema: 1, launchDate: LAUNCH, asof: today, lastRun: `${today} 21:00:45`, tier, pending,
    index: { code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: 0, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
    bond: { code: '008204', close: ROWS[idx].b },
    etf: { code: '515180', close: ETF, asof: today, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${today} 21:00:45` },
  } };
}

let SERVE = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  if (SERVE && rel in SERVE) return { ok: true, json: async () => SERVE[rel] };
  return realFetch(u, o);
};
const refresh = async (d, t) => { goto(d, t); await H.load(); };

store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
const serveWith = (st) => { SERVE = {
  'data/state.json': st, 'data/ledger.json': JSON.parse(JSON.stringify(ledger)),
  'data/series.json': { rows: ROWS }, 'calendar/2026.json': { year: 2026, tradingDays: CAL } }; };

/* ============ 一、待办时账本里到底有没有这笔 ============ */
console.log('\n【一】T 日晚上，横幅是怎么说「记账」这件事的');
const d0 = workerDay(iT, { tier: 0, pending: null }, ledger);
serveWith(d0.state);
await refresh(T, '21:05');
const b0 = banners();
console.log(`  横幅共 ${b0.length} 条，第 1 条说：`);
console.log(`    ${b0[0].sub}`);
console.log(`  此刻账本里有 ${ledger.entries.length} 笔记录，pending = ${posPct(d0.pending.tierFrom)} → ${posPct(d0.pending.tierTo)}`);
if (ledger.entries.length === 0 && /都已(按规则)?把这笔操作?写进不可更改的记录/.test(b0[0].sub)) {
  bad('账本里一笔都没有，横幅却说「已经写进不可更改的记录」—— 这句在待办状态下是假的');
} else if (!/不管你有没有真的下单/.test(b0[0].sub)) {
  bad('没说清「系统照记不误，跟你有没有下单无关」—— 这是最该说的那句警告');
} else ok('待办状态下没谎称已记账，而且把「照记不误」这句警告说出来了');

/* ============ 二、执行日还没到时点一下，执行日当天还提醒吗 ============ */
console.log('\n【二】T 日 21:05 点一下按钮，再看真正该下单的 T+1 日');
console.log(`  按钮文字：「${b0[0].btn.textContent}」　此刻 ${T} 21:05 早收盘了，这笔要 ${T1} 才做`);
if (b0[0].btn.textContent === '已完成') bad('执行日还没到，按钮却写「已完成」—— 那一刻根本无事可完成');
else ok(`按钮改叫「${b0[0].btn.textContent}」，没有诱导你宣称完成了做不到的事`);
b0[0].btn.click();
console.log(`  点完：横幅 ${banners().length ? '还在' : '收起'}`);
await refresh(T1, '10:00');
console.log(`  ${T1} 10:00（执行日当天）打开：横幅 ${banners().length ? '回来了' : '不见了'}`);
if (!banners().length) bad('执行日当天横幅没了 —— 前一晚那一下把真正需要提醒的那天也关掉了');
else {
  ok('执行日当天横幅照常回来');
  console.log(`    按钮现在是「${banners()[0].btn.textContent}」`);
  if (banners()[0].btn.textContent !== '已完成') bad('到了执行日，按钮该变成「已完成」');
}

/* ============ 三、连着触发，旧的那笔清得掉吗 ============ */
console.log('\n【三】连着触发：第 1 份刚记账、第 2 份又来了');
store.delete(`hlma30.ack.${T}`);
const d1 = workerDay(iT + 1, d0.state, ledger);
serveWith(d1.state);
await refresh(T1, '21:05');
const b1 = banners();
console.log(`  横幅共 ${b1.length} 条：`);
b1.forEach((b, k) => console.log(`    ${k + 1}. ${b.text}　[${b.btn.textContent}]　—— ${b.kick}`));
if (b1.length !== 2) bad(`该排 2 条（明天要买的第 2 份 + 刚记账待确认的第 1 份），实际 ${b1.length} 条`);
else ok('两笔各占一条，都摆在明面上');
if (!/第 2 份/.test(b1[0].text)) bad('最上面一条该是眼下要做的第 2 份');
if (!/第 1 份/.test(bannerText())) bad('刚记账的第 1 份不见了');

console.log('\n  只点第 2 条（确认第 1 份做过了），第 1 条应当留着');
if (!b1[1]) bad('只排了一条横幅 —— 早先那笔又被吞掉了，无从点起');
else b1[1].btn.click();
const b2 = banners();
console.log(`  点完剩 ${b2.length} 条：${b2.map((b) => b.text).join('　|　')}`);
if (b2.length !== 1) bad(`该只收起被点的那条，实际剩 ${b2.length} 条`);
else if (!/第 2 份/.test(b2[0].text)) bad('收错了条 —— 留下的该是还没做的第 2 份');
else ok('点哪条收哪条，没点的原样留着');

const d2 = workerDay(iT + 2, d1.state, ledger);
serveWith(d2.state);
await refresh(T2, '21:05');
const b3 = banners();
console.log(`\n  T+2 晚（第 2 份已记账${d2.pending ? '、第 3 份又触发' : ''}）：共 ${b3.length} 条`);
b3.forEach((b, k) => console.log(`    ${k + 1}. ${b.text}　[${b.btn.textContent}]`));
if (/另有 \d+ 笔/.test(bannerText())) bad('还在说「另有 N 笔没确认过」—— 那句话已经没有存在理由了');
else ok('不再有清不掉的「另有 N 笔」');

// 上面只点过「唯一一条可确认的」，就算点一下把别条也收了也看不出来。
// 把两笔都放回未确认，再点中间那条 —— 剩下的必须一条不少。
console.log('\n  两笔都恢复成未确认，只点其中一条，另一条必须原样留着');
store.delete(`hlma30.ack.${T}`);
store.delete(`hlma30.ack.${T1}`);
await refresh(T2, '21:05');
const b4 = banners();
console.log(`  共 ${b4.length} 条：${b4.map((b) => b.text).join('　|　')}`);
const before = b4.map((b) => b.text);
const pick = b4.findIndex((b) => /第 1 份/.test(b.text));
if (pick < 0) bad('找不到「第 1 份」那条，没法验');
else {
  b4[pick].btn.click();
  const after = banners().map((b) => b.text);
  const gone = before.filter((t) => !after.includes(t));
  console.log(`  点掉「第 1 份」后剩 ${after.length} 条：${after.join('　|　')}`);
  if (gone.length !== 1) bad(`只点了一条，却少了 ${gone.length} 条：${gone.join('、')}`);
  else ok('只收起被点的那一条，其余一条不少');
}

console.log(`\n${fails ? `✗ 还有 ${fails} 处没修好` : '✓ 三处都修好了'}\n`);
process.exitCode = fails ? 1 : 0;
