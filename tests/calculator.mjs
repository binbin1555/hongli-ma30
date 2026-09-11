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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { H, el, put, at, pend, D, CAL, TODAY, CORE, ROOT, fractionsIn } from './harness.mjs';

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
      bad(`金额不对：显示 ${shown}，按目标市值法补到 ${CORE.posPct(c.target)} 应为 ${Math.round(want.amount)}`);
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
      bad(`实盘和账本对得上（都在 ${CORE.posPct(behind.ledgerTier)}），不该判成欠账`);
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

/* ---------------- 这几条是读文案读出来的，不是算出来的 ---------------- */
console.log('\n================ 表述陷阱 ================\n');
{
  // 这一组要看账户卡片和时点行，本金必须设上，否则计算器走「先填可用资金」分支
  globalThis.localStorage.setItem('hlma30.principal', '1000000');
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  // 1. 文案让人「去看下方某板块」时，那个板块必须真的存在。
  //    曾经三处写「请看下方『系统自检』」，而页面上那一块叫「设置与数据健康」。
  const titles = new Set([...html.matchAll(/<p class="k"[^>]*>([^<]+)<\/p>/g)].map((m) => m[1].trim()));
  const refs = new Set([...html.matchAll(/[下上]方「([^」]+)」/g)].map((m) => m[1]));
  console.log(`  页面板块 ${titles.size} 个；文案引用 ${[...refs].join('、') || '（无）'}`);
  for (const r of refs) {
    if (!titles.has(r)) bad(`文案让人去看「${r}」，但页面上没有这个板块（现有：${[...titles].join('、')}）`);
  }

  // 2. 实盘档位和账本一致时，落差框必须收起来 —— 哪怕挂着单。
  //    挂单没到执行日就说「实盘落后账本」，每个正常触发日都会冤枉人一次。
  const sigFuture = CAL.filter((d) => d >= TODAY)[0];
  for (const [name, cfg] of [
    ['有挂单·实盘与账本一致', { tier: 1, chain: [[40, 0, 1]], pending: pend(sigFuture, 1, 2), index: at(6000, 5760) }],
    ['无挂单·实盘与账本一致', { tier: 1, chain: [[40, 0, 1]], index: at(6000, 6000) }],
  ]) {
    put({ ...cfg, etf: null });
    H.render();
    const box = el('mismatch');
    console.log(`  ${name}：落差框 ${box.hidden === true ? '已收起' : '显示中'}`);
    if (box.hidden !== true) bad(`${name}：实盘和账本本来就一致，落差框不该出现（${box.textContent.slice(0, 40)}…）`);
    if (/落后账本|超前账本/.test(box.hidden === true ? '' : box.textContent)) {
      bad(`${name}：说了「落后/超前账本」，但实盘和账本是一致的`);
    }
  }

  // 3. 执行日已过时不许打绿色对勾 —— 「✓ 本次要执行」和「已过期」是两个意思。
  const past = CAL.filter((d) => d < TODAY).slice(-4)[0];
  put({ tier: 1, chain: [[40, 0, 1]], pending: pend(past, 1, 2), index: at(6000, 5760), etf: null });
  H.render();
  const t = el('timing').textContent;
  console.log(`  执行日已过：${t.slice(0, 30)}…`);
  if (t.includes('✓')) bad(`执行日已过却打了绿色对勾：「${t.slice(0, 40)}…」`);

  // 3b. 清空输入框后，时点行必须跟着刷新 —— 不能把上一次的「你还欠着 N 笔」留在屏上
  put({ tier: 1, chain: [[40, 0, 1]], index: at(6000, 6000), calc: { cash: 300000, hold: 700000 }, etf: null });
  H.render();
  const before = el('timing').textContent;
  el('inCash').value = ''; el('inHold').value = '';
  globalThis.localStorage.setItem('hlma30.calc', JSON.stringify({ cash: 0, hold: 0 }));
  H.renderInputDependent();
  const after = el('timing').textContent;
  console.log(`  清空输入框：时点行 ${before === after ? '没变（陈旧）' : '已刷新'}`);
  if (/你还欠着|实盘仓位和账本对不上/.test(after)) {
    bad(`两个框都空了，时点行还在说「${after.slice(0, 24)}…」—— 此刻没有任何依据这么说`);
  }

  // 4. 指数与均线相等时不许写「高 0.00%」
  put({ tier: 1, chain: [[40, 0, 1]], index: at(6000, 6000), etf: null });
  H.render();
  const ma = el('maSub').textContent;
  console.log(`  指数=均线：${ma}`);
  if (/[高低] 0\.00%/.test(ma)) bad(`指数与均线相等，却写成「${ma}」`);

  // 5. 不满 90 天不许外推年化 —— 跑 2 天 +0.5% 会外推成「年化 +148%」
  const ann = el('pnlAnn').textContent;
  console.log(`  已运行 ${el('pnlDays').textContent}：年化显示「${ann}」`);
  const days = parseInt(el('pnlDays').textContent, 10);
  if (days < 90 && /%/.test(ann) && !ann.includes('后显示')) {
    bad(`只运行了 ${days} 天就外推年化「${ann}」，数字没有意义`);
  }
}

console.log(`${fails ? `✗ ${fails} 处有问题` : '✓ 时间线全部正确'}\n`);
process.exit(fails ? 1 : 0);
