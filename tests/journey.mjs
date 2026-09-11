/**
 * 全流程走查：T 日出信号 → T+1 日按时做 → T+2 日迟到补做。
 *
 * 这三条是日常最可能遇到的路径，所以不摆静态状态，而是**按 Worker 的真实
 * 状态机一天天推进**：执行昨日挂单 → 记账 → 算今日信号 → 生成新挂单，
 * 每一步产出的 state/ledger 和线上写进仓库的是同一个形状。
 *
 * 面板用真代码渲染。为了让「今天」跟着剧本走，整份脚本劫持了 Date.now ——
 * beijingDate(nowMs = Date.now()) 每次调用都会重新取，所以改一次时间，
 * 下一次 render 就活在那一天。
 *
 * 行情用真实历史：2026-05-28 是一次真的买入信号，T+1 是周五、T+2 是周一，
 * 顺带把「迟到 + 跨周末」一起验了。
 *
 * 用法：npm run journey（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---- 必须在 import harness 之前劫持时间：harness 一加载就会跑 load() ---- */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
/** 把「现在」设成北京时间的某天某时 */
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

const { H, el, store, ROOT, CORE } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, WEIGHTS, MA_LEN, orderAmount, COMMISSION, posPct } = CORE;

let fails = 0;
const bad = (msg) => { fails++; console.log(`    ✗ ${msg}`); };
const ok = (label, v) => console.log(`    · ${label.padEnd(10, '　')} ${v}`);

/* ---------------- 剧本 ---------------- */
const SERIES = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8')).rows;
const T_DATE = '2026-05-28';
const iT = SERIES.findIndex((r) => r.d === T_DATE);
const [T, T1, T2] = [SERIES[iT].d, SERIES[iT + 1].d, SERIES[iT + 2].d];
const LAUNCH = SERIES[iT - 40].d;
const ETF_PX = 1.46;
const PRINCIPAL = 1000000;

/** 复刻 runDaily 的状态推进：执行昨日挂单 → 记账 → 算今日信号 → 生成新挂单 */
function workerRun(dayIdx, prev, ledger) {
  const upto = SERIES.slice(0, dayIdx + 1);
  const closes = upto.map((r) => r.c);
  const close = closes[closes.length - 1];
  const ma30 = ma(closes, MA_LEN);
  const today = SERIES[dayIdx].d;
  const prevClose = closes[closes.length - 2];

  let tier = prev.tier;
  let executed = null;
  if (prev.pending && prev.pending.signalDate < today) {
    const p = prev.pending;
    executed = {
      seq: ledger.entries.length + 1, date: today, signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL', tierFrom: p.tierFrom, tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo], price: close, etfPrice: ETF_PX, late: false,
      recordedAt: `${today} 21:00:45`,
    };
    ledger.entries.push(executed);
    tier = p.tierTo;
  }
  const sig = signal(close, ma30);
  const want = nextTier(tier, sig);
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' }
    : null;
  const tg = triggers(close, ma30);
  const state = {
    schema: 1, launchDate: LAUNCH, asof: today, lastRun: `${today} 21:00:45`, tier, pending,
    index: {
      code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: +((close / prevClose - 1) * 100).toFixed(2),
      buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2),
    },
    bond: { code: 'H11001', close: SERIES[dayIdx].b },
    etf: { code: '515180', close: ETF_PX, asof: today, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${today} 21:00:45` },
  };
  return { state, executed, pending, sig, close, ma30 };
}

/** 把状态装进面板并渲染 */
function show(state, ledger, calc) {
  if (calc) {
    store.set('hlma30.calc', JSON.stringify(calc));
    el('inCash').value = String(calc.cash);
    el('inHold').value = String(calc.hold);
  } else {
    store.delete('hlma30.calc');
    el('inCash').value = '';
    el('inHold').value = '';
  }
  H.S = { ...H.S, state: JSON.parse(JSON.stringify(state)), ledger: JSON.parse(JSON.stringify(ledger)) };
  H.render();
}

/** 打印这一刻面板上的全部操作相关文字 */
function panel() {
  const on = el('banner').classList.contains('on');
  const out = {
    横幅: on ? `${el('bKick').textContent}｜${el('bText').textContent}` : null,
    卡片: el('nextLine').textContent.trim(),
    卡片副: el('nextSub').textContent.trim(),
    仓位: el('tierNum').textContent.trim(),
    算主: el('oMain').textContent.trim(),
    算副: el('oSub').textContent.trim(),
    时点: el('timing').textContent.trim(),
    落差: el('mismatch').hidden === true ? null : el('mismatch').textContent.trim(),
  };
  for (const [k, v] of Object.entries(out)) if (v) console.log(`    ${k.padEnd(5, '　')} ${v}`);
  return out;
}

/** 目标市值法独立验算（不复用 calcCatchUp） */
function want(cash, hold, tier) {
  const S = cash + hold, V = hold, w = WEIGHTS[tier], c = COMMISSION;
  const t = w * S;
  if (Math.abs(t - V) < 0.005) return { side: 'NONE', amount: 0 };
  return t > V ? { side: 'BUY', amount: (t - V) / (1 + w * c) }
    : { side: 'SELL', amount: (V - t) / (1 - w * c) };
}
const shown = (s) => Number((s.match(/([\d,]+) 元/) || [])[1]?.replace(/,/g, ''));

/** 抓推送文案 */
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opt) => {
  if (String(u).includes('api.day.app')) {
    pushes.push(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ code: 200 }) };
  }
  return realFetch(u, opt);
};
const { pushDaily } = await import(`file://${join(ROOT, 'worker', 'src', 'index.js').replace(/\\/g, '/')}`);
const ENV = { BARK_KEY: 'x', ETF_CODE: '515180', PAGES_URL: 'https://example.invalid/' };
async function push(args) {
  pushes.length = 0;
  await pushDaily(ENV, args);
  for (const p of pushes) console.log(`    📱 ${p.title}\n       ${p.body.replace(/\n/g, '\n       ')}`);
  return pushes.slice();
}

store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
let st = { tier: 0, pending: null };

console.log(`\n剧本：本金 ${PRINCIPAL.toLocaleString('en-US')}　空仓起步　行情用真实历史`);
console.log(`  T = ${T}　T+1 = ${T1}　T+2 = ${T2}（T+1 是周五，T+2 是下周一）\n`);

/* ==================================================================== */
console.log('═════════════ T 日 ' + T + '：出信号 ═════════════\n');
const r0 = workerRun(iT, st, ledger);
st = r0.state;
console.log(`  21:00 Worker：收盘 ${r0.close.toFixed(2)}　MA30 ${r0.ma30.toFixed(2)}　买入线 ${st.index.buyTrigger}　信号 ${r0.sig}`);
console.log(`         挂单 ${r0.pending ? `${posPct(r0.pending.tierFrom)} → ${posPct(r0.pending.tierTo)}，执行日应为 ${T1}` : '无'}\n`);
if (!r0.pending) bad('T 日没生成挂单，剧本前提就不成立');

console.log('  ── 推送 ──');
await push({ today: T, newState: st, pending: r0.pending, execDay: T1, executed: null, plan: null, etf: st.etf, checks: [], late: false });

console.log('\n  ── 21:05 用户收到推送，点开面板（还没填过任何数字）──');
goto(T, '21:05');
show(st, ledger, null);
const pT = panel();
if (!pT.横幅) bad('T 日晚上没有触发横幅');
if (!pT.卡片.includes(`${+T1.slice(5, 7)} 月 ${+T1.slice(8, 10)} 日`)) bad(`T 日卡片没写出执行日 ${T1}：「${pT.卡片}」`);
if (/今天/.test(pT.卡片)) bad(`T 日卡片说「今天」，但执行日是 ${T1}：「${pT.卡片}」`);
if (pT.落差) bad(`T 日还没到执行日，落差框不该出现：「${pT.落差}」`);
if (/欠着|还没做/.test(pT.时点)) bad(`T 日被说成欠账：「${pT.时点}」`);

/* ==================================================================== */
console.log('\n\n═════════════ T+1 日 ' + T1 + '：按时操作 ═════════════\n');
console.log('  ── 10:00 盘中打开面板 ──');
goto(T1, '10:00');
show(st, ledger, null);
const p1 = panel();
if (!/今天/.test(p1.卡片)) bad(`T+1 当天卡片没说「今天」：「${p1.卡片}」`);
if (!p1.横幅.includes('今天')) bad(`T+1 横幅和卡片时点不一致：「${p1.横幅}」`);
if (p1.落差) bad(`T+1 当天做就是准时，落差框不该出现：「${p1.落差}」`);
if (/欠着|还没做/.test(p1.时点)) bad(`T+1 当天被说成欠账：「${p1.时点}」`);
if (!p1.时点.includes('尾盘')) bad('T+1 没给尾盘提示');

console.log('\n  ── 用户按面板填入真实持仓（还没买，全是现金）──');
const cash0 = PRINCIPAL;
show(st, ledger, { cash: cash0, hold: 0 });
const p1b = panel();
const w1 = want(cash0, 0, 1);
const got1 = shown(p1b.算主);
console.log(`\n    ✓ 独立验算：补到 ${posPct(1)} 应${w1.side === 'BUY' ? '买入' : '卖出'} ${Math.round(w1.amount).toLocaleString('en-US')} 元`);
if (Math.abs(got1 - w1.amount) > 1) bad(`计算器给 ${got1}，公式算出 ${Math.round(w1.amount)}`);
if (!p1b.算主.includes('买入')) bad(`方向不对：「${p1b.算主}」`);
if (p1b.算主.includes('预估')) bad('有挂单时不该标「预估」');
if (/欠着|补齐/.test(`${p1b.时点}${p1b.算主}`)) bad(`按时操作却提示欠账：「${p1b.时点}」`);

console.log('\n  ── 14:30 盘中提醒推送 ──');
goto(T1, '14:30');
{
  const o = orderAmount(cash0, 0, WEIGHTS[1]);
  console.log(`    📱 ⏰ ${+T1.slice(5, 7)} 月 ${+T1.slice(8, 10)} 日收盘前买入第 1 份`);
  console.log(`       仓位 ${posPct(0)} → ${posPct(1)}　估算约 ${Math.round(o.amount).toLocaleString('en-US')} 元`);
  console.log(`       信号出在 ${T}，执行日就是 ${T1}（周五）。`);
}

console.log('\n  ── 14:55 用户按计算器的数字下单成交 ──');
const buy1 = want(cash0, 0, 1).amount;
const realHold = Math.floor(buy1 / ETF_PX / 100) * 100 * ETF_PX;   // 100 股取整
const realCash = cash0 - realHold * (1 + COMMISSION);
console.log(`    成交 ${Math.round(realHold).toLocaleString('en-US')} 元（${Math.floor(buy1 / ETF_PX / 100) * 100} 股）`
  + `　余现金 ${Math.round(realCash).toLocaleString('en-US')}`);

console.log('\n  ── 21:00 Worker 记账 ──');
const r1 = workerRun(iT + 1, st, ledger);
st = r1.state;
console.log(`    账本 +1 笔：${r1.executed.date} ${r1.executed.side} ${posPct(r1.executed.tierFrom)}→${posPct(r1.executed.tierTo)}`
  + `　新仓位 ${posPct(st.tier)}　新挂单 ${r1.pending ? '有' : '无'}`);
if (!r1.executed) bad('T+1 晚上没有记账');
if (st.tier !== 1) bad(`T+1 记账后仓位应为 ${posPct(1)}，实际 ${posPct(st.tier)}`);
await push({ today: T1, newState: st, pending: r1.pending, execDay: T2, executed: r1.executed, plan: null, etf: st.etf, checks: [], late: false });

console.log('\n  ── 21:05 用户再打开面板，填入成交后的真实数字 ──');
goto(T1, '21:05');
show(st, ledger, { cash: Math.round(realCash), hold: Math.round(realHold) });
const p1c = panel();
if (p1c.横幅) bad('挂单已执行，横幅还挂着');
if (/欠着|还没做|对不上|补齐/.test(`${p1c.卡片}${p1c.时点}${p1c.算主}`)) {
  bad(`按时做完了却仍提示欠账：卡片「${p1c.卡片}」时点「${p1c.时点}」`);
}
if (p1c.仓位 !== posPct(1)) bad(`仓位卡片应显示 ${posPct(1)}，实际「${p1c.仓位}」`);
if (p1c.落差) bad(`实盘与账本一致，落差框不该出现：「${p1c.落差}」`);

/* ==================================================================== */
console.log('\n\n═════════════ T+2 日 ' + T2 + '：迟到一天的情形 ═════════════\n');
console.log('  设定：T+1 那天忘了下单，账本已在 T+1 晚记了账，实盘仍是空仓\n');
console.log('  ── 10:00 打开面板，先不填数字 ──');
goto(T2, '10:00');
show(st, ledger, null);
const p2 = panel();
if (p2.落差) bad(`没填数字时系统无从判断，不该弹落差框：「${p2.落差}」`);
if (/欠着|还没做/.test(p2.时点)) bad(`没填数字就说欠账：「${p2.时点}」`);

console.log('\n  ── 填入真实持仓（还是空仓，因为昨天忘了做）──');
show(st, ledger, { cash: cash0, hold: 0 });
const p2b = panel();
const w2 = want(cash0, 0, 1);
const got2 = shown(p2b.算主);
console.log(`\n    ✓ 独立验算：补到 ${posPct(1)} 应买入 ${Math.round(w2.amount).toLocaleString('en-US')} 元`);
if (Math.abs(got2 - w2.amount) > 1) bad(`补做金额给 ${got2}，公式算出 ${Math.round(w2.amount)}`);
if (!/欠着|还没做/.test(`${p2b.卡片}${p2b.时点}`)) bad(`迟到了却没提示欠账：卡片「${p2b.卡片}」时点「${p2b.时点}」`);
if (!p2b.卡片.includes('1 笔')) bad(`应说欠 1 笔：「${p2b.卡片}」`);
if (!/补齐到/.test(p2b.算主)) bad(`计算器主行应提示补齐：「${p2b.算主}」`);

console.log('\n  ── 用户当天尾盘补做 ──');
console.log(`    成交 ${Math.round(realHold).toLocaleString('en-US')} 元`);
console.log('\n  ── 补做后立刻在计算器里更新数字 ──');
show(st, ledger, { cash: Math.round(realCash), hold: Math.round(realHold) });
const p2c = panel();
if (/欠着|还没做|对不上|补齐/.test(`${p2c.卡片}${p2c.时点}${p2c.算主}`)) {
  bad(`补做完了仍提示欠账：卡片「${p2c.卡片}」时点「${p2c.时点}」算主「${p2c.算主}」`);
}
if (p2c.落差) bad(`补做后实盘与账本一致，落差框不该出现：「${p2c.落差}」`);

console.log('\n  ── 21:00 Worker 跑 T+2 ──');
const r2 = workerRun(iT + 2, st, ledger);
console.log(`    仓位 ${posPct(r2.state.tier)}　新挂单 ${r2.pending ? '有' : '无'}　账本共 ${ledger.entries.length} 笔`);
const T3 = SERIES[iT + 3].d;
await push({ today: T2, newState: r2.state, pending: r2.pending, execDay: T3, executed: r2.executed, plan: null, etf: r2.state.etf, checks: [], late: false });

/* ==================================================================== */
/*
 * 「无操作」推送的距离文案 —— 每个交易日都会发一条，读得最多的就是它。
 *
 * pctToBuy 和 pctToSell 的符号约定是相反的（见 triggers）：
 *   pctToBuy  正数 = 收盘已在买入线之下
 *   pctToSell 正数 = 还需再涨这么多
 * 照着卖出侧的写法套到买入侧，判断会整个反过来 —— 曾经就这么错过一次，
 * 在没破线的日子里播报「已跌破买入线」。所以这里按收盘价扫一遍全区间。
 */
console.log('\n═════════════ 每日「无操作」推送的距离文案 ═════════════\n');
{
  const MA = 12000, BUY = MA * 0.97, SELL = MA * 1.02;
  const spots = [
    ['远低于买入线', BUY * 0.95, '已跌破'],
    ['刚好在买入线上', BUY, '已跌破'],
    ['略高于买入线', BUY * 1.001, '还需跌'],
    ['正好等于均线', MA, '还需跌'],
    ['略低于卖出线', SELL * 0.999, '还需跌'],
    ['刚好在卖出线上', SELL, '还需跌'],
    ['远高于卖出线', SELL * 1.05, '还需跌'],
  ];
  for (const [name, close, expectBuy] of spots) {
    const tg = triggers(close, MA);
    const stx = {
      tier: 2,
      index: {
        close: +close.toFixed(2), ma30: MA,
        buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
        pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2),
        changePct: 0,
      },
    };
    const got = await push({
      today: T2, newState: stx, pending: null, execDay: null,
      executed: null, plan: null, etf: null, checks: [], late: false,
    });
    const body = got[0].body;
    const line = body.split('\n').find((l) => /买入线|卖出线|还需/.test(l)) || '';
    console.log(`    收盘 ${Math.round(close).toString().padStart(6)}（买入线 ${Math.round(tg.buyAt)}　卖出线 ${Math.round(tg.sellAt)}）`);
    console.log(`      ${line.trim()}`);

    // 买入侧
    const reallyBelowBuy = close <= tg.buyAt + 1e-9;
    const saysBrokeBuy = line.includes('已跌破买入线');
    if (saysBrokeBuy !== reallyBelowBuy) {
      bad(`${name}：收盘 ${Math.round(close)} ${reallyBelowBuy ? '确实' : '并未'}跌破买入线 ${Math.round(tg.buyAt)}，`
        + `文案却说「${saysBrokeBuy ? '已跌破' : '还需跌'}」`);
    }
    // 卖出侧
    const reallyAboveSell = close >= tg.sellAt - 1e-9;
    const saysBrokeSell = line.includes('已涨破卖出线');
    if (saysBrokeSell !== reallyAboveSell) {
      bad(`${name}：收盘 ${Math.round(close)} ${reallyAboveSell ? '确实' : '并未'}涨破卖出线 ${Math.round(tg.sellAt)}，`
        + `文案却说「${saysBrokeSell ? '已涨破' : '还需涨'}」`);
    }
    // 报出来的百分比不许是负数
    for (const m of line.matchAll(/还需[跌涨] (-?[\d.]+)%/g)) {
      if (Number(m[1]) < 0) bad(`${name}：文案里出现负的百分比「${m[0]}」`);
    }
    if (expectBuy === '已跌破' && !saysBrokeBuy) bad(`${name}：预期「已跌破」，实际「${line.trim()}」`);
  }
}

console.log(`\n${fails ? `✗ 全流程有 ${fails} 处问题` : '✓ T / T+1 / T+2 三条路径全程畅通，无错报'}\n`);
process.exitCode = fails ? 1 : 0;
