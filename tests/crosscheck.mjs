import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreHash, buildHash } from '../stamp.mjs';
import { dayLabel, posPct } from '../shared/strategy.js';
import { fileURLToPath } from 'node:url';

// 按脚本自身位置解析，保证从仓库根目录或 tests/ 目录跑都一样
const HERE = dirname(fileURLToPath(import.meta.url));
import { replay, ma, signal, nextTier, orderAmount, triggers, calcStep, calcCatchUp, missedEntries, validateState, nextMove, nextTradingDay, beijingDate, WEIGHTS, COMMISSION }
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
  console.log(`  ${ok ? 'OK ' : '!!!'} ${name}  可用${cash} 持有${hold} → ${posPct(r.tier)}→${posPct(r.to)} ${r.side} ${r.amount.toFixed(2)}  期望 ${exp.side} ${exp.amt.toFixed(2)}`);
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


console.log('\n=== 日期措辞 dayLabel（推送与面板共用同一句话）===');
{
  const cases = [
    ['2026-09-11', '2026-09-11', '9 月 11 日（今天，周五）', '当天'],
    ['2026-09-12', '2026-09-11', '9 月 12 日（明天，周六）', '第二天'],
    ['2026-09-10', '2026-09-11', '9 月 10 日（昨天，周四）', '前一天'],
    ['2026-09-14', '2026-09-11', '9 月 14 日（周一）', '周五出信号 → 下周一执行，不能叫「明日」'],
    ['2026-10-08', '2026-09-30', '10 月 8 日（周四）', '国庆前，差 8 天'],
    ['2027-01-04', '2026-12-31', '1 月 4 日（周一）', '跨年'],
    ['2026-03-01', '2026-02-28', '3 月 1 日（明天，周日）', '跨月仍算「明天」'],
    ['2026-01-01', '2025-12-31', '1 月 1 日（明天，周四）', '跨年仍算「明天」'],
  ];
  let bad = 0;
  for (const [d, today, want, why] of cases) {
    const got = dayLabel(d, today).label;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${today} 说 ${d} → ${got}　（${why}）`);
  }
  // 相对词只许在紧邻的那三天出现，其余一律只给日期＋星期
  let leak = 0;
  const base = '2026-06-15';
  for (let k = -400; k <= 400; k++) {
    const d = new Date(Date.parse(`${base}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
    const L = dayLabel(d, base);
    const hasRel = /今天|明天|昨天/.test(L.label);
    if (hasRel !== (Math.abs(k) <= 1)) leak++;
    if (L.diff !== k) leak++;
  }
  bad += leak;
  console.log(`  ${leak === 0 ? 'OK ' : '!!!'} 前后各 400 天遍历：相对词只出现在相差 1 天以内，diff 全部正确`);
  allOk = allOk && bad === 0;
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

  // Worker 的构建指纹：/health 返回它，用来从外面确认线上跑的是哪一版。
  // 没盖对章的话，查线上版本时会拿到一个对不上任何提交的值，比没有还误导人。
  const worker = readFileSync(join(HERE, '..', 'worker', 'src', 'index.js'), 'utf8');
  const wantB = buildHash(worker, core);
  const mB = worker.match(/const BUILD = '([^']*)';/);
  const gotB = mB && mB[1];
  const okB = gotB === wantB;
  allOk = allOk && okB;
  console.log(`  ${okB ? 'OK ' : '!!!'} worker 的 BUILD=${gotB}　实际哈希=${wantB}`);
  if (!okB) console.log('      → 改过 worker/src/index.js 但忘了跑 `npm run stamp`，/health 报出的版本会是错的');
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


console.log('\n=== 补齐 calcCatchUp（漏做几天后一次性追上账本）===');
{
  const C3 = COMMISSION;
  const t = [
    [1000000,       0, 2, 'BUY',  (0.50*1000000-0)/(1+0.50*C3),        '空仓补到 2/5 档'],
    [1000000,       0, 4, 'BUY',  (1.00*1000000-0)/(1+1.00*C3),        '空仓补到满仓'],
    [      0, 1000000, 1, 'SELL', (1000000-0.25*1000000)/(1-0.25*C3),  '满仓补到 1/5 档'],
    [ 750000,  250000, 3, 'BUY',  (0.75*1000000-250000)/(1+0.75*C3),   '1档补到 3/5 档'],
  ];
  for (const [cash, hold, tgt, side, amt, name] of t) {
    const r = calcCatchUp(cash, hold, tgt);
    const ok = r.ok && r.side === side && Math.abs(r.amount - amt) < 0.01;
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}　→ ${r.side} ${r.amount.toFixed(2)}　期望 ${side} ${amt.toFixed(2)}`);
  }
  for (const [cash, hold, tgt, reason, name] of [
    [0, 0, 2, 'NO_INPUT', '两栏都空'],
    [1000000, 0, 5, 'BAD_TIER', '档位越界'],
    [1000000, 0, -1, 'BAD_TIER', '档位为负'],
  ]) {
    const r = calcCatchUp(cash, hold, tgt);
    const ok = !r.ok && r.reason === reason;
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name} → ${r.reason} 期望 ${reason}`);
  }

  console.log('\n  强不变量：成交后仓位必须精确落在目标档位上');
  let n = 0, bad = 0, worst = 0, eg = null;
  for (let total = 5000; total <= 3000000; total *= 4.3) {
    for (let i = 0; i <= 100; i++) {
      const hold = total * i / 100, cash = total - hold;
      for (let tgt = 0; tgt <= 4; tgt++) {
        const r = calcCatchUp(cash, hold, tgt);
        n++;
        if (!r.ok) continue;
        // 按目标市值法成交：买入付佣金，卖出扣佣金，总资产各减少 X*c
        let V = hold, S = total;
        if (r.side === 'BUY')  { V += r.amount; S -= r.amount * COMMISSION; }
        if (r.side === 'SELL') { V -= r.amount; S -= r.amount * COMMISSION; }
        const err = Math.abs(V / S - WEIGHTS[tgt]);
        if (err > worst) { worst = err; eg = { cash, hold, tgt, err }; }
        if (err > 1e-9) bad++;
      }
    }
  }
  allOk = allOk && bad === 0;
  console.log(`  ${bad === 0 ? 'OK ' : '!!!'} 穷举 ${n} 组，偏离目标仓位超过 1e-9 的有 ${bad} 组（最大偏差 ${worst.toExponential(2)}）`);
}


console.log('\n=== 校验体系 runChecks（含改造后的第 9 项）===');
{
  const { runChecks } = await import('../worker/src/index.js');
  const cal = ['2026-09-08', '2026-09-09', '2026-09-10'];
  const good = [
    { d: '2026-09-08', c: 12250.47, pct: 1.31 },
    { d: '2026-09-09', c: 12387.45, pct: 1.12 },
    { d: '2026-09-10', c: 12304.81, pct: -0.67 },
  ];
  const noRemoved = { dup: [], weekend: [], newyear: [], ghost: [] };
  const etfOk = { c: 1.46, d: '2026-09-10' };

  const run = (rows, tf, tt, entries, etf = etfOk) =>
    runChecks(rows, noRemoved, '2026-09-10', etf, tf, tt, cal, entries);

  // 全绿场景要够 30 个交易日，否则第 7 项本来就该失败
  const many = [], manyCal = [];
  for (let k = 0; k < 40; k++) {
    const day = new Date(Date.UTC(2026, 6, 1) + k * 86400000).toISOString().slice(0, 10);
    manyCal.push(day);
    many.push({ d: day, c: 12000 + k, pct: k === 0 ? null : +((( 12000 + k) / (11999 + k) - 1) * 100).toFixed(2) });
  }
  const last = manyCal[manyCal.length - 1];
  const green = runChecks(many, noRemoved, last, { c: 1.46, d: last }, 0, 0, manyCal, []);
  const ids = green.map((c) => c.id);
  const okCount = green.filter((c) => c.ok).length;
  let ok = ids.length === 9 && ids[0] === 1 && ids[1] === 2 && okCount === 9;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 全绿场景返回 ${ids.length} 项（id: ${ids.join(',')}），通过 ${okCount} 项`
    + (okCount === 9 ? '' : '　未过：' + green.filter((c) => !c.ok).map((c) => c.id + ':' + c.detail).join('；')));
  console.log(`       注：第 10 项账本自审在主流程里追加，最终是 10 项`);

  // 第 9 项现在能抓到 state 与账本脱节
  const drift = run(good, 0, 1, [{ date: '2026-09-09', tierFrom: 0, tierTo: 1, price: 1 }]);
  const c9 = drift.find((c) => c.id === 9);
  ok = !c9.ok && c9.detail.includes('脱节');
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} state 记 0 档但账本最后一笔是 1 档 → 第9项失败：${c9.detail.slice(0, 46)}`);

  const fine = run(good, 1, 2, [{ date: '2026-09-09', tierFrom: 0, tierTo: 1, price: 1 }]);
  ok = fine.find((c) => c.id === 9).ok;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} state 与账本吻合时第9项通过`);

  // 各项确实能抓到它声称拦的问题
  const cases = [
    [3, '塞进不在日历里的日期', [...good, { d: '2026-09-11', c: 12400, pct: 0.77 }]],
    [4, '残留幽灵行（连续两日同价）', [good[0], { d: '2026-09-09', c: 12250.47, pct: 0 }, good[2]]],
    [5, '涨跌幅与收盘价对不上', [good[0], { ...good[1], pct: 9.99 }, good[2]]],
    [6, '单日暴动超 ±11%', [good[0], { d: '2026-09-09', c: 20000, pct: 63.26 }, good[2]]],
  ];
  for (const [id, name, rows] of cases) {
    const r = runChecks(rows, noRemoved, '2026-09-10', etfOk, 0, 0, cal, []).find((c) => c.id === id);
    const caught = r && !r.ok;
    allOk = allOk && caught;
    console.log(`  ${caught ? 'OK ' : '!!!'} 第${id}项抓到「${name}」`);
  }
  // 第 7 项：不足 30 个交易日
  const short = runChecks(good, noRemoved, '2026-09-10', etfOk, 0, 0, cal, []).find((c) => c.id === 7);
  ok = !short.ok;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 第7项抓到「只有 3 个交易日，不足 30」`);
  // 第 8 项：ETF 日期与指数不一致
  const stale = runChecks(good, noRemoved, '2026-09-10', { c: 1.46, d: '2026-09-09' }, 0, 0, cal, []).find((c) => c.id === 8);
  ok = !stale.ok && stale.fatal === false;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 第8项抓到「ETF 报价是昨天的」且标记为非致命`);
}


console.log('\n=== 漏做识别 missedEntries ===');
{
  const es = [
    { date: '2026-09-08', tierFrom: 0, tierTo: 1, side: 'BUY' },
    { date: '2026-09-09', tierFrom: 1, tierTo: 2, side: 'BUY' },
    { date: '2026-09-10', tierFrom: 2, tierTo: 3, side: 'BUY' },
  ];
  const t = [
    [0, ['2026-09-08', '2026-09-09', '2026-09-10'], '一笔没做 → 三笔全欠'],
    [1, ['2026-09-09', '2026-09-10'], '做了第一笔 → 欠后两笔'],
    [2, ['2026-09-10'], '做了两笔 → 欠最后一笔'],
    [3, [], '全做完 → 不欠'],
  ];
  for (const [actual, want, name] of t) {
    const got = missedEntries(es, actual).map((e) => e.date);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}　实盘${actual}档 → [${got.join(', ')}]`);
  }
  // 有买有卖的往返路径
  const mix = [
    { date: '2026-06-01', tierFrom: 0, tierTo: 1, side: 'BUY' },
    { date: '2026-06-02', tierFrom: 1, tierTo: 2, side: 'BUY' },
    { date: '2026-07-01', tierFrom: 2, tierTo: 1, side: 'SELL' },
  ];
  let got = missedEntries(mix, 2).map((e) => e.date);
  let ok = JSON.stringify(got) === JSON.stringify(['2026-07-01']);
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 买买卖路径，实盘2档 → 只欠那笔卖出 [${got.join(', ')}]`);
  // 找不到对应起点时不瞎猜
  got = missedEntries(mix, 4);
  ok = got.length === 0;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 实盘档位在账本里找不到起点 → 返回空，不瞎猜`);
  ok = missedEntries([], 0).length === 0 && missedEntries(null, 0).length === 0;
  allOk = allOk && ok;
  console.log(`  ${ok ? 'OK ' : '!!!'} 空账本 / null 输入安全返回`);
}


console.log('\n=== 有挂单时该用哪个目标（曾经用错，导致多买一整档）===');
{
  // 挂单目标 3/5 档（75%），实盘 30万现金 + 70万持仓（占 70%）
  const cash = 300000, hold = 700000, pendingTierTo = 3;
  const right = calcCatchUp(cash, hold, pendingTierTo);        // 调到挂单那一档
  const wrong = calcStep(cash, hold, true);                    // 从推断档位再走一档
  const okRight = right.ok && Math.abs(right.amount - (0.75 * 1000000 - 700000) / (1 + 0.75 * COMMISSION)) < 0.01;
  allOk = allOk && okRight;
  console.log(`  ${okRight ? 'OK ' : '!!!'} 正确做法 calcCatchUp(→${pendingTierTo}档) = ${Math.round(right.amount).toLocaleString()} 元`);
  console.log(`      对照 calcStep(走一档) = ${Math.round(wrong.amount).toLocaleString()} 元（推断你在 ${wrong.tier} 档，目标 ${wrong.to} 档）`);
  const differ = Math.abs(right.amount - wrong.amount) > 1000;
  allOk = allOk && differ;
  console.log(`  ${differ ? 'OK ' : '!!!'} 两者相差 ${Math.round(Math.abs(right.amount - wrong.amount)).toLocaleString()} 元 —— 有挂单时必须用前者`);

  // 成交后必须精确落在挂单目标仓位上
  let V = hold, S2 = cash + hold;
  if (right.side === 'BUY') { V += right.amount; S2 -= right.amount * COMMISSION; }
  else { V -= right.amount; S2 -= right.amount * COMMISSION; }
  const land = Math.abs(V / S2 - WEIGHTS[pendingTierTo]) < 1e-9;
  allOk = allOk && land;
  console.log(`  ${land ? 'OK ' : '!!!'} 成交后仓位 ${(V / S2 * 100).toFixed(4)}% ，挂单目标 ${WEIGHTS[pendingTierTo] * 100}%`);
}


console.log('\n=== 状态文件校验 validateState（防止损坏数据被硬画出来）===');
{
  const good = {
    tier: 2, asof: '2026-09-10', launchDate: '2026-09-01',
    index: { close: 12300, ma30: 12000, buyTrigger: 11640, sellTrigger: 12240 },
    pending: { side: 'SELL', tierFrom: 2, tierTo: 1, signalDate: '2026-09-10' },
  };
  // 断言「坏输入必须被拦下，且报出关键那条」，不锁死问题条数 —— 条数是实现细节
  const t = [
    [{ ...good, tier: 7 }, '档位 7', '档位越界 7'],
    [{ ...good, tier: 1.5 }, '档位 1.5', '档位是小数'],
    [{ ...good, tier: null }, '档位 null', '档位为 null'],
    [{ ...good, asof: '20260910' }, '数据日期', '日期格式不对'],
    [{ ...good, index: { ...good.index, ma30: 0 } }, 'index.ma30', 'MA30 为 0（会导致除零）'],
    [{ ...good, index: { ...good.index, buyTrigger: 99999 } }, '买入线不低于卖出线', '买入线高于卖出线'],
    [{ ...good, index: undefined }, '缺少 index', '缺少 index'],
    [{ ...good, pending: { ...good.pending, tierTo: 4 } }, '一次只能动一档', '挂单一次跨 2 档'],
    [{ ...good, pending: { ...good.pending, tierFrom: 0 } }, '对不上', '挂单起始档与当前档位对不上'],
    [null, '不是对象', 'state 为 null'],
    [{ ...good, launchDate: 'x' }, '起算日', '起算日格式不对'],
    [{ ...good, pending: { ...good.pending, signalDate: '' } }, 'signalDate', '挂单缺信号日'],
  ];
  for (const [st, key, name] of t) {
    const p = validateState(st);
    const ok = p.length > 0 && p.some((x) => x.includes(key));
    allOk = allOk && ok;
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}　→ ${p.length} 条：${p[0] || '（没报错，漏了）'}`);
  }
  // 完好状态不能误报
  const clean = validateState(good).length === 0 && validateState({ ...good, pending: null }).length === 0;
  allOk = allOk && clean;
  console.log(`  ${clean ? 'OK ' : '!!!'} 完好状态（含/不含挂单）均无误报`);
}

console.log(`\n总判定：${allOk ? '全部通过 ✓' : '有不一致 ✗'}`);
process.exit(allOk ? 0 : 1);
