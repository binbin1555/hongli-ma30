import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreHash } from '../stamp.mjs';
import { fileURLToPath } from 'node:url';

// 按脚本自身位置解析，保证从仓库根目录或 tests/ 目录跑都一样
const HERE = dirname(fileURLToPath(import.meta.url));
import { replay, ma, signal, nextTier, orderAmount, triggers, calcStep, nextMove, nextTradingDay, beijingDate, WEIGHTS, COMMISSION }
  from '../shared/strategy.js';

const cases2 = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
let allOk = true;
console.log('=== JS 核心 vs Python 引擎 对账 ===');
for (const c of cases2) {
  const r = replay(c.rows, c.entries, c.principal, c.launchDate);
  const diff = r.total - c.expect.final;
  const rel = Math.abs(diff) / c.expect.final;
  const ok = Math.abs(diff) < 0.01; // 1.5 万元级本金上允许 1 分钱的浮点误差
  allOk = allOk && ok;
  console.log(
    `${c.name}  JS=${r.total.toFixed(2)}  Python=${c.expect.final.toFixed(2)}  ` +
    `差=${diff.toFixed(6)}  相对误差=${rel.toExponential(2)}  ${ok ? 'OK' : '!!! 不一致'}`
  );
  const posJs = r.V / r.total;
  console.log(`    仓位 JS=${posJs.toFixed(6)}  Python=${c.expect.finalPos.toFixed(6)}  档位 JS=${r.tier}  笔数=${c.entries.length}`);
}

console.log('\n=== 信号函数单元测试 ===');
const t = [
  [96.9, 100, 'BUY',  '低于均线3%以上'],
  [97.0, 100, null,   '恰好等于 MA30×0.97 —— 不触发（严格小于）'],
  [97.1, 100, null,   '在区间内'],
  [102.0, 100, null,  '恰好等于 MA30×1.02 —— 不触发（严格大于）'],
  [102.1, 100, 'SELL','高于均线2%以上'],
];
for (const [c0, m0, want, why] of t) {
  const got = signal(c0, m0);
  console.log(`  收盘${c0} MA${m0} → ${String(got)}  期望 ${String(want)}  ${got === want ? 'OK' : '!!!'}  (${why})`);
  allOk = allOk && got === want;
}

console.log('\n=== 档位推进测试（一天最多动一档、封顶封底）===');
const tt = [[0,'SELL',0],[0,'BUY',1],[3,'BUY',4],[4,'BUY',4],[4,'SELL',3],[2,null,2]];
for (const [from, s, want] of tt) {
  const got = nextTier(from, s);
  console.log(`  档位${from} 信号${String(s)} → ${got} 期望${want} ${got===want?'OK':'!!!'}`);
  allOk = allOk && got === want;
}

console.log('\n=== 目标市值法下单金额（文档 3.5 公式）===');
const S = 1071188, V = 0, w = 0.25, c = 0.000045;
const o = orderAmount(S, V, w);
const manual = (w * S - V) / (1 + w * c);
console.log(`  S=${S} V=${V} w=${w} → ${o.side} ${o.amount.toFixed(4)}  手算 ${manual.toFixed(4)}  ${Math.abs(o.amount-manual)<1e-9?'OK':'!!!'}`);
const o2 = orderAmount(1000000, 500000, 0.25);
const m2 = (500000 - 0.25*1000000) / (1 - 0.25*c);
console.log(`  减仓 S=1000000 V=500000 w=0.25 → ${o2.side} ${o2.amount.toFixed(4)}  手算 ${m2.toFixed(4)}  ${Math.abs(o2.amount-m2)<1e-9?'OK':'!!!'}`);
const o3 = orderAmount(1000000, 300000, 0);
console.log(`  清仓 w=0 → ${o3.side} ${o3.amount}  期望 SELL 300000  ${o3.side==='SELL'&&o3.amount===300000?'OK':'!!!'}`);

console.log('\n=== MA30 边界 ===');
console.log('  只有29个数 →', ma(Array(29).fill(100)), '(期望 null)');
console.log('  30个数 →', ma(Array(30).fill(100)), '(期望 100)');
console.log('  含 NaN →', ma([...Array(29).fill(100), NaN]), '(期望 null)');

console.log('\n=== 今日真实状态复算 ===');
const trg = triggers(12387.45, 12087.24);
console.log(`  收盘/MA30=${trg.ratio.toFixed(4)}  买入线=${trg.buyAt.toFixed(2)}  还需跌=${trg.pctToBuy.toFixed(2)}%`);
console.log(`  与之前 Python 算的 1.0248 / 11724.62 / -5.35% 对比 ${Math.abs(trg.ratio-1.0248)<1e-4 && Math.abs(trg.buyAt-11724.62)<0.01 && Math.abs(trg.pctToBuy+5.35)<0.01 ? 'OK' : '!!!'}`);


console.log('\n=== 计算器 calcStep：定点用例 ===');
const C2 = COMMISSION;
const fixed = [
  [1000000,       0, true,  {tier:0,to:1,side:'BUY', amt:(0.25*1000000-0)/(1+0.25*C2)}, '空仓买第1份'],
  [ 750000,  250000, true,  {tier:1,to:2,side:'BUY', amt:(0.50*1000000-250000)/(1+0.50*C2)}, '1档买第2份'],
  [ 500000,  500000, true,  {tier:2,to:3,side:'BUY', amt:(0.75*1000000-500000)/(1+0.75*C2)}, '2档买第3份'],
  [ 250000,  750000, true,  {tier:3,to:4,side:'BUY', amt:(1.00*1000000-750000)/(1+1.00*C2)}, '3档买第4份'],
  [ 750000,  250000, false, {tier:1,to:0,side:'SELL',amt:250000},                             '1档卖光'],
  [      0, 1000000, false, {tier:4,to:3,side:'SELL',amt:(1000000-0.75*1000000)/(1-0.75*C2)}, '满仓卖第4份'],
  [ 500000,  500000, false, {tier:2,to:1,side:'SELL',amt:(500000-0.25*1000000)/(1-0.25*C2)},  '2档卖第2份'],
];
for (const [cash, hold, buy, exp, name] of fixed) {
  const r = calcStep(cash, hold, buy);
  const ok = r.ok && r.tier === exp.tier && r.to === exp.to && r.side === exp.side
    && Math.abs(r.amount - exp.amt) < 0.01;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} ${name}  可用${cash} 持有${hold} → ${r.tier}/5→${r.to}/5 ${r.side} ${r.amount.toFixed(2)}  期望 ${exp.side} ${exp.amt.toFixed(2)}`);
}

console.log('\n=== 计算器：边界与非法输入 ===');
for (const [cash, hold, buy, reason, name] of [
  [0, 0, true, 'NO_INPUT', '两栏都空'],
  [-100, 100, true, 'NO_INPUT', '负数'],
  [0, 1000000, true, 'FULL', '满仓还想买'],
  [1000000, 0, false, 'EMPTY', '空仓还想卖'],
]) {
  const r = calcStep(cash, hold, buy);
  const ok = !r.ok && r.reason === reason;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} ${name} → ${r.reason} 期望 ${reason}`);
}

console.log('\n=== 计算器：不变量穷举（上次那个方向标反 bug 的守门人）===');
let nTot = 0, nBad = 0, badEg = null;
for (let total = 1000; total <= 5000000; total *= 3.7) {
  for (let i = 0; i <= 200; i++) {
    const hold = total * i / 200, cash = total - hold;
    for (const buy of [true, false]) {
      const r = calcStep(cash, hold, buy);
      nTot++;
      if (!r.ok) continue;
      const wrongSide = r.side !== (buy ? 'BUY' : 'SELL');
      const outOfRange = !(r.amount >= 0 && r.amount <= r.total + 1e-6);
      const tierBad = !(r.tier >= 0 && r.tier <= 4 && r.to >= 0 && r.to <= 4 && Math.abs(r.to - r.tier) === 1);
      if (wrongSide || outOfRange || tierBad) { nBad++; if (!badEg) badEg = { cash, hold, buy, r }; }
    }
  }
}
console.log(`  穷举 ${nTot} 组（总资产 1千~500万 × 持仓占比 0~100% × 买卖两向）`);
console.log(`  ${nBad === 0 ? 'OK ' : '!!!'} 方向错/金额越界/档位非法：${nBad} 组` + (badEg ? '  例:' + JSON.stringify(badEg) : ''));
allOk = allOk && nBad === 0;

console.log('\n=== 账本重放只依赖本金与账本（计算器填什么都不影响）===');
{
  const f = cases2[0];
  const a = replay(f.rows, f.entries, f.principal, f.launchDate).total;
  calcStep(999999, 888888, true);
  const b = replay(f.rows, f.entries, f.principal, f.launchDate).total;
  const ok = a === b && Math.abs(a - f.expect.final) < 0.01;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 调用计算器前后重放结果一致：${a.toFixed(2)} / ${b.toFixed(2)}`);
}


console.log('\n=== 下一次操作 nextMove：边界规则 ===');
{
  const mk = (close) => ({ close, ma30: 12000, buyTrigger: 12000 * 0.97, sellTrigger: 12000 * 1.02 });
  const t = [
    // 收盘,   档位, pending, 期望kind, 说明
    [12300, 0, null, 'buy',  '空仓+价高于卖出线：只能提示买入，不能提示卖出'],
    [11600, 4, null, 'sell', '满仓+价低于买入线：只能提示卖出，不能提示买入'],
    [12300, 4, null, 'sell', '满仓+价高于卖出线：卖出且已触发'],
    [11600, 0, null, 'buy',  '空仓+价低于买入线：买入且已触发'],
    [12100, 2, null, 'sell', '中间档+更接近卖出线'],
    [11700, 2, null, 'buy',  '中间档+更接近买入线'],
    [12300, 2, { side:'BUY', tierFrom:2, tierTo:3 }, 'pending', '已有挂单时一律显示挂单'],
  ];
  for (const [close, tier, pend, want, name] of t) {
    const r = nextMove(mk(close), tier, pend);
    const ok = r.kind === want;
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}  → ${r.kind}${r.need !== undefined ? ' need=' + r.need.toFixed(2) + '%' : ''}`);
  }

  console.log('\n  已触发（越过触发线）时 need 应为 0：');
  const a = nextMove(mk(11600), 0, null), b = nextMove(mk(12300), 4, null);
  const okZero = a.need === 0 && b.need === 0;
  allOk = allOk && okZero;
  console.log(`  ${okZero ? 'OK ' : '!!!'} 空仓已跌破买入线 need=${a.need}，满仓已涨破卖出线 need=${b.need}`);

  console.log('\n  不变量穷举：0档永不提卖出、4档永不提买入');
  let bad = 0, n = 0;
  for (let close = 9000; close <= 15000; close += 25) {
    for (let tier = 0; tier <= 4; tier++) {
      const r = nextMove(mk(close), tier, null);
      n++;
      if (tier === 0 && r.kind === 'sell') bad++;
      if (tier === 4 && r.kind === 'buy') bad++;
      if (r.kind === 'none') bad++;                       // 0–4 档永远该有一个方向
      if (r.need !== undefined && r.need < 0) bad++;      // 距离不能为负
    }
  }
  allOk = allOk && bad === 0;
  console.log(`  ${bad === 0 ? 'OK ' : '!!!'} 穷举 ${n} 组（收盘 9000~15000 × 5 个档位）违规 ${bad} 组`);
}


console.log('\n=== 执行日推算 nextTradingDay（用仓库里的真实 2026 日历）===');
{
  const cal = JSON.parse(readFileSync(join(HERE, '..', 'calendar', '2026.json'), 'utf8')).tradingDays;
  const t = [
    ['2026-09-10', '2026-09-11', '周四出信号 → 周五执行'],
    ['2026-09-11', '2026-09-14', '周五出信号 → 跳过周末，下周一执行'],
    ['2026-09-30', '2026-10-08', '国庆前最后一天出信号 → 跳过整个长假'],
    ['2026-02-13', '2026-02-24', '春节前出信号 → 跳过春节假期'],
    ['2026-12-31', null,         '年内最后一个交易日 → 需要次年日历'],
  ];
  for (const [sig, want, name] of t) {
    const got = nextTradingDay(cal, sig);
    const ok = got === want;
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}　${sig} → ${got}　期望 ${want}`);
  }
  // 不变量：结果必须严格晚于信号日，且本身是交易日
  const set = new Set(cal);
  let bad = 0;
  for (const d of cal) {
    const n = nextTradingDay(cal, d);
    if (n !== null && (!(n > d) || !set.has(n))) bad++;
  }
  allOk = allOk && bad === 0;
  console.log(`  ${bad === 0 ? 'OK ' : '!!!'} 遍历全年 ${cal.length} 个交易日，结果均晚于信号日且本身是交易日（违规 ${bad}）`);
}


console.log('\n=== 前端模块版本戳（防止浏览器缓存串版本）===');
{
  const core = readFileSync(join(HERE, '..', 'shared', 'strategy.js'), 'utf8');
  const want = coreHash(core);
  const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  const m = html.match(/const CORE_VERSION = '([^']*)';/);
  const got = m && m[1];
  const ok = got === want;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} index.html 的 CORE_VERSION=${got}　strategy.js 实际哈希=${want}`);
  if (!ok) console.log('      → 改过 shared/strategy.js 但忘了跑 `npm run stamp`，线上会因浏览器缓存旧模块而白屏');
}


console.log('\n=== 北京日期换算（曾经多叠了一次时区偏移）===');
{
  const t = [
    [Date.UTC(2026, 8, 10, 12, 42), '2026-09-10', 'UTC 12:42 → 北京 20:42 当天'],
    [Date.UTC(2026, 8, 10, 15, 59), '2026-09-10', 'UTC 15:59 → 北京 23:59 仍是当天'],
    [Date.UTC(2026, 8, 10, 16, 0),  '2026-09-11', 'UTC 16:00 → 北京次日 00:00'],
    [Date.UTC(2026, 8, 10, 23, 30), '2026-09-11', 'UTC 23:30 → 北京次日 07:30（旧实现会算错成前一天）'],
    [Date.UTC(2026, 11, 31, 16, 0), '2027-01-01', '跨年'],
  ];
  for (const [ms, want, name] of t) {
    const got = beijingDate(ms);
    const ok = got === want;
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}　→ ${got}　期望 ${want}`);
  }
  // 结果必须与本机时区无关
  const fixed = Date.UTC(2026, 8, 10, 12, 42);
  const ok = beijingDate(fixed) === '2026-09-10';
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 与运行环境时区无关（本机 offset=${new Date().getTimezoneOffset()} 分钟）`);
}

console.log(`\n总判定：${allOk ? '全部通过 ✓' : '有不一致 ✗'}`);
process.exit(allOk ? 0 : 1);
