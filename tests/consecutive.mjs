/**
 * 连着两天触发：T 日买第 1 份，T+1 日又买第 2 份。
 *
 * 这是最容易打架的一种走法 —— T+1 晚上，「刚记账、还没确认的第 1 份」和
 * 「新生成、明天要做的第 2 份」同时存在，而横幅只有一个位置。
 *
 * 这份不预设答案，先把每一屏原样打出来，再逐条检查有没有自相矛盾、
 * 有没有哪一笔被悄悄吃掉。用法：npm run consecutive
 */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

const { H, el, store, ROWS, CAL, CORE, fractionsIn, banners } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, WEIGHTS, MA_LEN, COMMISSION, posPct } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`      ✗ ${m}`); };
const ok = (m) => console.log(`      ✓ ${m}`);

/* ---------------- 剧本 ---------------- */
const T = '2026-06-26', T1 = '2026-06-29', T2 = '2026-06-30';
const iT = ROWS.findIndex((r) => r.d === T);
const LAUNCH = ROWS[iT - 40].d;
const PRINCIPAL = 1000000, ETF = 1.46;

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

/* ---------------- 真刷新 ---------------- */
let SERVE = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  if (SERVE && rel in SERVE) return { ok: true, json: async () => SERVE[rel] };
  return realFetch(u, o);
};
const refresh = async (day, at) => { goto(day, at); await H.load(); };

function type(cash, hold) {
  el('inCash').value = String(cash); el('inHold').value = String(hold);
  for (const f of (el('inCash')._ls && el('inCash')._ls.input) || []) f({});
  H.renderInputDependent();
}

const txt = (id) => el(id).textContent.replace(/\s+/g, ' ').trim();
const on = () => banners().length > 0;
function screen(label) {
  console.log(`\n  ── ${label}`);
  const rows = {
    横幅: on() ? banners().map((b, k) => `第${k + 1}条 ${b.kick}　${b.text}　[${b.btn.textContent}]`)
      .join('\n     　　　 ') : '（无）',
    横幅说明: on() ? banners().map((b, k) => `第${k + 1}条 ${b.sub}`).join('\n     　　　　 ') : '',
    卡片: txt('nextLine'),
    卡片副: txt('nextSub'),
    仓位: txt('tierNum'),
    输入框: `${el('inCash').value || '空'}｜${el('inHold').value || '空'}`,
    算主: txt('oMain'),
    时点: txt('timing'),
  };
  for (const [k, v] of Object.entries(rows)) {
    if (!v) continue;
    console.log(`     ${k.padEnd(4, '　')} ${v}`);
    const f = fractionsIn(v);
    if (f.length) bad(`${k} 出现分数写法 ${f.join('、')}`);
  }
  return rows;
}

/** 目标市值法独立验算 */
const wantAmt = (cash, hold, tier) => {
  const S = cash + hold, w = WEIGHTS[tier], want = w * S;
  return want > hold ? { side: 'BUY', amount: (want - hold) / (1 + w * COMMISSION) }
    : { side: 'SELL', amount: (hold - want) / (1 - w * COMMISSION) };
};
const shownAmt = (s) => Number((s.match(/([\d,]+) 元/) || [])[1]?.replace(/,/g, ''));

/* ==================================================================== */
store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
const serveWith = (state) => { SERVE = {
  'data/state.json': state, 'data/ledger.json': JSON.parse(JSON.stringify(ledger)),
  'data/series.json': { rows: ROWS }, 'calendar/2026.json': { year: 2026, tradingDays: CAL } }; };

console.log(`\n连着两天触发：T 日买第 1 份，T+1 日又买第 2 份`);
console.log(`T = ${T}（周五）　T+1 = ${T1}（周一）　T+2 = ${T2}（周二）　本金 ${PRINCIPAL.toLocaleString('en-US')}　空仓起步`);

/* ---------------- T 日 ---------------- */
console.log(`\n${'═'.repeat(64)}\nT 日 ${T} —— 第 1 次触发\n${'═'.repeat(64)}`);
const d0 = workerDay(iT, { tier: 0, pending: null }, ledger);
console.log(`\n  21:00 系统：收盘 ${d0.close.toFixed(2)} < 买入线 ${d0.state.index.buyTrigger}　→ 待办 ${posPct(0)} → ${posPct(1)}`);
if (!d0.pending || d0.pending.tierTo !== 1) bad('T 日没生成买第 1 份的待办，剧本前提不成立');
serveWith(d0.state);

await refresh(T, '21:05');
screen('21:05 收到推送，打开面板');

console.log('\n     填入真实持仓 1000000 / 0');
type(1000000, 0);
console.log(`     算主　 ${txt('oMain')}`);
{
  const g = shownAmt(txt('oMain')), w = wantAmt(1000000, 0, 1).amount;
  if (Math.abs(g - w) > 1) bad(`第 1 份金额 ${g}，独立验算应为 ${Math.round(w)}`);
  else ok(`第 1 份金额与独立验算一致：${Math.round(w).toLocaleString('en-US')} 元`);
}

/* ---------------- T+1 日 ---------------- */
console.log(`\n${'═'.repeat(64)}\nT+1 日 ${T1} —— 执行第 1 份，当晚又触发第 2 次\n${'═'.repeat(64)}`);
await refresh(T1, '10:00');
const s1 = screen('10:00 打开（周末过去了，今天是执行日）');
if (!s1.卡片.includes('（今天')) bad(`执行日当天卡片该说「今天」：「${s1.卡片}」`);
if (!on()) bad('执行日当天横幅不见了');

console.log('\n     填入真实持仓，照它下单');
type(1000000, 0);
const buy1 = wantAmt(1000000, 0, 1).amount;
const hold1 = Math.floor(buy1 / ETF / 100) * 100 * ETF;
const cash1 = PRINCIPAL - hold1 * (1 + COMMISSION);
console.log(`     14:55 成交 ${Math.round(hold1).toLocaleString('en-US')} 元，余现金 ${Math.round(cash1).toLocaleString('en-US')}`);

const d1 = workerDay(iT + 1, d0.state, ledger);
console.log(`\n  21:00 系统：记账 ${d1.executed.date} ${posPct(d1.executed.tierFrom)}→${posPct(d1.executed.tierTo)}　`
  + `收盘 ${d1.close.toFixed(2)} < 买入线 ${d1.state.index.buyTrigger}　→ 又生成待办 ${d1.pending ? `${posPct(d1.pending.tierFrom)} → ${posPct(d1.pending.tierTo)}` : '无'}`);
if (!d1.pending || d1.pending.tierTo !== 2) bad('T+1 日没生成买第 2 份的待办，剧本前提不成立');
serveWith(d1.state);

await refresh(T1, '21:05');
console.log(`\n${'─'.repeat(64)}\n  ★ 关键时刻：第 1 份刚记账（你还没确认），第 2 份又来了\n${'─'.repeat(64)}`);
const s2 = screen('21:05 记账后刷新');

/* 这一屏必须同时说清两件事，任何一件被吃掉都算问题 */
const all2 = Object.values(s2).join(' ');
if (!on()) bad('这一屏没有横幅 —— 明天要买第 2 份，必须有');
if (!/第 2 份/.test(all2)) bad('整屏没提到「第 2 份」—— 明天该做的事不见了');
if (!/第 1 份|更早|1 笔/.test(all2)) bad('整屏没提到第 1 份 —— 刚记的账被悄悄吃掉了');
if (!s2.卡片.includes(`${+T2.slice(5, 7)} 月 ${+T2.slice(8, 10)} 日`)) bad(`卡片没写出第 2 份的执行日：「${s2.卡片}」`);

console.log('\n     填入成交后的真实持仓，看第 2 份该买多少');
type(Math.round(cash1), Math.round(hold1));
console.log(`     算主　 ${txt('oMain')}`);
console.log(`     时点　 ${txt('timing')}`);
{
  const g = shownAmt(txt('oMain')), w = wantAmt(Math.round(cash1), Math.round(hold1), 2).amount;
  if (Math.abs(g - w) > 1) bad(`第 2 份金额 ${g}，独立验算应为 ${Math.round(w)}`);
  else ok(`第 2 份金额与独立验算一致：${Math.round(w).toLocaleString('en-US')} 元`);
  if (/补齐|欠着|还没做/.test(txt('oMain'))) bad(`已照做却说欠账：「${txt('oMain')}」`);
}

/* ---------------- T+2 日 ---------------- */
console.log(`\n${'═'.repeat(64)}\nT+2 日 ${T2} —— 执行第 2 份\n${'═'.repeat(64)}`);
await refresh(T2, '10:00');
const s3 = screen('10:00 打开');
if (!s3.卡片.includes('（今天')) bad(`执行日当天卡片该说「今天」：「${s3.卡片}」`);

console.log('\n     填入真实持仓，照它下单');
type(Math.round(cash1), Math.round(hold1));
const buy2 = wantAmt(Math.round(cash1), Math.round(hold1), 2).amount;
const hold2 = hold1 + Math.floor(buy2 / ETF / 100) * 100 * ETF;
const cash2 = cash1 - Math.floor(buy2 / ETF / 100) * 100 * ETF * (1 + COMMISSION);
console.log(`     14:55 成交 ${Math.round(hold2 - hold1).toLocaleString('en-US')} 元，累计持有 ${Math.round(hold2).toLocaleString('en-US')}，余现金 ${Math.round(cash2).toLocaleString('en-US')}`);

const d2 = workerDay(iT + 2, d1.state, ledger);
console.log(`\n  21:00 系统：记账 ${d2.executed ? `${d2.executed.date} ${posPct(d2.executed.tierFrom)}→${posPct(d2.executed.tierTo)}` : '无'}　`
  + `仓位 ${posPct(d2.state.tier)}　新待办 ${d2.pending ? `${posPct(d2.pending.tierFrom)} → ${posPct(d2.pending.tierTo)}` : '无'}　账本 ${ledger.entries.length} 笔`);
serveWith(d2.state);

await refresh(T2, '21:05');
const s4 = screen('21:05 当晚最后看一眼');
if (s4.仓位 !== posPct(2)) bad(`两笔都做完了，仓位该是 ${posPct(2)}，实际 ${s4.仓位}`);
type(Math.round(cash2), Math.round(hold2));
console.log(`     填入真实持仓后：${txt('oMain')}`);
if (/补齐|欠着|还没做/.test(txt('oMain'))) bad(`两笔都照做了，却说欠账：「${txt('oMain')}」`);
else ok('两笔都照做，计算器没有误报欠账');

console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ 连续触发全程走通，没有自相矛盾'}\n`);
process.exitCode = fails ? 1 : 0;
