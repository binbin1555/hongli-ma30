/**
 * 「每份该是多少钱」板块的时间线测试。
 *
 * 回答一个具体问题：不管我是 T 日、T+1 日还是 T+N 日打开面板输入实际金额，
 * 它给的操作提示对不对？
 *
 * 金额的预期值**不用 calcCatchUp 算**，直接按说明文档 3.5 的目标市值法
 * 手写一遍公式 —— 拿被测代码去验被测代码，等于什么都没验。
 *
 * 用法：npm run calc（npm test 里也会跑）
 */
import { H, el, put, at, pend, D, CAL, TODAY, CORE, fractionsIn } from './harness.mjs';

const { WEIGHTS, COMMISSION } = CORE;

let fails = 0;
const bad = (msg) => { fails++; console.log(`    ✗ ${msg}`); };

/** 说明文档 3.5：买 X =（w×S − V）÷（1 + w×c），卖 X =（V − w×S）÷（1 − w×c） */
function expectAmount(cash, hold, targetTier) {
  const S = cash + hold, V = hold, w = WEIGHTS[targetTier], c = COMMISSION;
  const want = w * S;
  if (Math.abs(want - V) < 0.005) return { side: 'NONE', amount: 0 };
  return want > V
    ? { side: 'BUY', amount: (want - V) / (1 + w * c) }
    : { side: 'SELL', amount: (V - want) / (1 - w * c) };
}

/* 时间线：账本 0→1，实盘也在 1 档（25%）。T 日出信号要加到 2 档。 */
const M = 6000;
const TOTAL = 1000000;
const at25 = { cash: 750000, hold: 250000 };   // 1/5 档
const at50 = { cash: 500000, hold: 500000 };   // 2/5 档

const CHAIN1 = [[40, 0, 1]];                    // 账本停在 1 档
const CHAIN2 = [[40, 0, 1], [12, 1, 2]];        // 账本已走到 2 档
const CHAIN3 = [[40, 0, 1], [12, 1, 2], [6, 2, 3]]; // 账本已走到 3 档

const CASES = [
  {
    name: 'T 日晚上看（信号今天出，执行日是下一个交易日）',
    setup: { tier: 1, chain: CHAIN1, pending: pend(CAL.filter((d) => d >= TODAY)[0], 1, 2), index: at(M, M * 0.96), calc: at25 },
    target: 2, holding: at25, expectBehindWording: false,
    why: '还没到执行日，不该说「你欠着操作」',
  },
  {
    name: 'T+1 日盘中看（今天就是执行日，还没下单）',
    setup: { tier: 1, chain: CHAIN1, pending: pend(CAL.filter((d) => d < TODAY).slice(-1)[0], 1, 2), index: at(M, M * 0.96), calc: at25 },
    target: 2, holding: at25, expectBehindWording: false,
    why: '今天做就是准时，不算欠账',
  },
  {
    name: 'T+1 日晚上看（已经按提示做了）',
    setup: { tier: 2, chain: CHAIN2, index: at(M, M), calc: at50 },
    target: null, holding: at50, expectBehindWording: false,
    why: '实盘和账本对上了，应该回到「尚未触发」的预估态',
  },
  {
    name: 'T+1 日晚上看（忘了做）',
    setup: { tier: 2, chain: CHAIN2, index: at(M, M), calc: at25 },
    target: 2, holding: at25, expectBehindWording: true,
    why: '执行日已过还没做，这才是真欠账',
  },
  {
    name: 'T+3 日看（一直没做，账本又走了一档）',
    setup: { tier: 3, chain: CHAIN3, index: at(M, M), calc: at25 },
    target: 3, holding: at25, expectBehindWording: true,
    why: '要一次补两档，不能只补一档',
  },
  {
    name: 'T+3 日看（一直没做，而且今天又出了新信号）',
    setup: { tier: 3, chain: CHAIN3, pending: pend(CAL.filter((d) => d >= TODAY)[0], 3, 4), index: at(M, M * 0.96), calc: at25 },
    target: 4, holding: at25, expectBehindWording: true,
    why: '欠账 + 新挂单，目标是挂单落点',
  },
];

console.log('\n================ 「每份该是多少钱」时间线 ================\n');

for (const c of CASES) {
  put({ ...c.setup, etf: null });
  H.renderInputDependent();

  const main = el('oMain').textContent.trim();
  const sub = el('oSub').textContent.trim();
  const timing = el('timing').textContent.trim();
  const card = el('nextLine').textContent.trim();
  const cardSub = el('nextSub').textContent.trim();
  const behind = H.behindState();

  console.log(`【${c.name}】`);
  console.log(`  顶部  ${card}`);
  console.log(`  主行  ${main}`);
  console.log(`  副行  ${sub}`);
  console.log(`  时点  ${timing}`);

  // ---- 金额对不对（独立算一遍公式）----
  if (c.target === null) {
    if (/补齐/.test(main)) bad(`实盘已经对上账本，却仍在提示补齐：「${main}」`);
  } else {
    const want = expectAmount(c.holding.cash, c.holding.hold, c.target);
    const shown = Number((main.match(/([\d,]+) 元/) || [])[1]?.replace(/,/g, ''));
    if (!isFinite(shown)) {
      bad(`主行里读不出金额：「${main}」`);
    } else if (Math.abs(shown - want.amount) > 1) {
      bad(`金额不对：显示 ${shown}，按目标市值法补到 ${c.target}/5 档应为 ${Math.round(want.amount)}`);
    }
    const saysBuy = main.includes('买入');
    if (saysBuy !== (want.side === 'BUY')) {
      bad(`方向不对：显示${saysBuy ? '买入' : '卖出'}，应为${want.side === 'BUY' ? '买入' : '卖出'}`);
    }
    // 欠账态才由 behindState 定目标；准时态的目标在 calc 里，靠上面的金额验
    if (c.expectBehindWording && (!behind || behind.target !== c.target)) {
      bad(`目标档位不对：behindState 给的是 ${behind ? behind.target : '无'}，应为 ${c.target}`);
    }
    if (!c.expectBehindWording && behind) {
      bad(`实盘和账本对得上（都在 ${behind.ledgerTier}/5 档），不该判成欠账`);
    }
  }

  // ---- 仓位不许以分数出现 ----
  // 顶部卡片的副行也要查 —— 漏掉它的话，注入回一处「N/5 档」这个测试抓不到
  const fr = fractionsIn(`${card}｜${cardSub}｜${main}｜${sub}｜${timing}`);
  if (fr.length) bad(`文案里出现了分数「${fr.join('、')}」—— 仓位一律用百分比`);

  // ---- 措辞对不对：没到执行日就不该说「欠着」----
  // 注意别误伤 CLOSE_TIP 里的「买太早会和账本对不上」，那是提示不是指责
  const scolds = /你还欠着|笔操作还没做|实盘仓位和账本对不上/.test(timing) || /补齐到 /.test(main);
  if (scolds !== c.expectBehindWording) {
    bad(scolds
      ? `不该说成欠账（${c.why}）—— 时点行：「${timing}」`
      : `应该提示欠账却没提示（${c.why}）`);
  }
  // 准时态必须明确告诉你「这就是本次要执行的金额」
  if (!c.expectBehindWording && c.target !== null && !timing.includes('本次要执行的金额')) {
    bad(`准时态没说「这就是本次要执行的金额」—— 时点行：「${timing}」`);
  }

  // ---- 有挂单时，这个板块里必须看得见执行日和尾盘提示 ----
  // 你是在这里算金额、照着它下单的，不知道哪天下、几点下，等于没说
  const st = H.S.state;
  if (st.pending) {
    const anywhere = `${main}｜${sub}｜${timing}`;
    if (!/\d+ 月 \d+ 日/.test(anywhere)) bad('有挂单却没给出执行日期 —— 你不知道该哪天下单');
    if (!anywhere.includes('尾盘')) bad('有挂单却没给尾盘提示 —— 你不知道该几点下单');
  }
  console.log('');
}

/* ---------------- 仓位卡片：别再用分数 ---------------- */
/*
 * 原先写「N/5 档」，并画 5 个圆点按 k < tier 点亮 ——
 * 满仓显示成「4/5 档」、永远剩一个暗点，看着像「还能再买一次」，
 * 而那一次根本不存在（canBuy = tier < MAX_TIER，到 4 就买不动了）。
 * 使用者据此问出「0 到 5 档分别对应多少钱」，说明它确实在误导人。
 */
console.log('\n================ 仓位卡片 ================\n');
{
  const chains = [[], [[40, 0, 1]], [[40, 0, 1], [30, 1, 2]], [[40, 0, 1], [30, 1, 2], [20, 2, 3]],
    [[40, 0, 1], [35, 1, 2], [30, 2, 3], [25, 3, 4]]];
  const want = ['0%', '25%', '50%', '75%', '100%'];
  for (let t = 0; t <= 4; t++) {
    put({ tier: t, chain: chains[t], index: at(6000, 6000) });
    H.render();
    const txt = el('tierNum').textContent.trim();
    const dots = el('pips').innerHTML.match(/class="pip[^"]*"/g) || [];
    const lit = dots.filter((d) => d.includes(' on')).length;
    console.log(`  ${t} 档　卡片「${txt}」　圆点 ${dots.map((d) => (d.includes(' on') ? '●' : '○')).join('')}`);
    if (txt !== want[t]) bad(`第 ${t} 档卡片显示「${txt}」，应为「${want[t]}」`);
    if (dots.length !== 4) bad(`圆点画了 ${dots.length} 个，应为 4 个（空仓到满仓一共买 4 次）`);
    if (lit !== t) bad(`第 ${t} 档亮了 ${lit} 个点，应为 ${t} 个`);
    if (t === 4 && lit !== dots.length) bad('满仓时还有暗点 —— 会被读成「还能再买一次」');
    if (fractionsIn(txt).length) bad(`卡片又用回了分数：「${txt}」`);
  }

  // 交易记录那一列也要是百分比
  put({ tier: 3, chain: [[40, 0, 1], [30, 1, 2], [20, 2, 3]], index: at(6000, 6000) });
  H.render();
  const tbody = el('ledger').querySelector('tbody').innerHTML.replace(/<[^>]*>/g, ' ');
  console.log(`  交易记录仓位列：${(tbody.match(/\d+% → \d+%/g) || []).join('　') || '（空）'}`);
  const frL = fractionsIn(tbody);
  if (frL.length) bad(`交易记录里出现了分数「${frL.join('、')}」`);
  if (!/\d+% → \d+%/.test(tbody)) bad('交易记录的仓位列没有显示成百分比');
}

console.log(`${fails ? `✗ ${fails} 处有问题` : '✓ 时间线全部正确'}\n`);
process.exit(fails ? 1 : 0);
