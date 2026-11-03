/**
 * 创业板50 超跌反弹那一路
 *
 * 一、规则核心（shared/rebound.js，纯函数）：线怎么算、按什么顺序检查、止盈阶段怎么盯 10 日线、
 *     实际成交怎么校正、到期日怎么推、推送文案说什么
 * 二、走 Worker 真正的定时入口 scheduled()（外部全换成内存假件，同 brake.mjs）：
 *     21:05 抓数 → 提交 → 推送 → 回填；22:35 兜底；14:45 盘中只在要动手时推；
 *     红利那边的文件一个都不碰
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rbReplay, rbStatus, rbNightPush, rbIntradayPush, rbTradingDaysAfter, rbConfigProblems, rbSeriesJSON,
  tickUp, tickDown, tickBelow, p34, rbDay, rbMd, RB_GROUP, RB_GROUP_ACT,
} from '../shared/rebound.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? `\n      ${detail}` : ''}`));

// 仓库里记的是真实成交，以后每买一笔、卖出都会往里记。场景都用一份固定的测试配置：
// 规则和仓库里一模一样，只是第 1 笔固定按 1.075 记 —— 不然每记一笔真实成交，测试就得跟着改一遍
const REAL = JSON.parse(readFileSync(join(ROOT, 'data', 'rebound.json'), 'utf8'));
const CFG = { ...JSON.parse(JSON.stringify(REAL)), fills: [{ k: 1, d: REAL.start, p: 1.075 }], exit: null };
const SER = JSON.parse(readFileSync(join(ROOT, 'data', 'rebound_series.json'), 'utf8'));
const CAL = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8')).tradingDays;
const START = CFG.start;
// 起始日之后的交易日：2026 年照日历，之后按估算（到期日落在 2027 年）
const AFTER = rbTradingDaysAfter(START, 130, CAL).days;
const BEFORE = SER.rows.filter((r) => r.d < START);
const day0 = { d: START, c: 1.072, h: 1.077, l: 1.063 };
/** 起始日之后按给定收盘价往下排；h / l 默认上下各 1%，可以单独给 */
const path = (closes) => [...BEFORE, day0, ...closes.map((x, i) => {
  const [c, h, l] = Array.isArray(x) ? x : [x, +(x * 1.01).toFixed(3), +(x * 0.99).toFixed(3)];
  return { d: AFTER[i], c, h, l };
})];
// 10 日线要用到前 9 天的收盘。先垫 9 天 1.000，后面几天的 10 日线就只由测试里给的数决定，
// 不随仓库里真实行情的那几天变
const W9 = Array(9).fill(1.0);
// 垫完之后一路涨到赚 15%（第 14 天 1.240）、再涨一天：下一天的卖出线是前 9 天平均 1.13889 低一格 = 1.138
const RISE = [...W9, 1.15, 1.18, 1.2, 1.22, 1.24, 1.26];
const cfgWith = (o) => ({ ...JSON.parse(JSON.stringify(CFG)), ...o });
const fractions = (t) => String(t).match(/\d+\s*\/\s*\d+/g) || [];
const amounts = (t) => String(t).match(/万|元|\d{1,3}(,\d{3})+/g) || [];
const md = (d) => rbMd(d, d);

/* ================================================================ 一、规则核心 */
console.log('\n【一】规则核心');

{
  console.log('\n● 仓库里记的真实成交');
  check(rbConfigProblems(REAL).length === 0, '仓库里的 data/rebound.json 合法', rbConfigProblems(REAL).join('；'));
  const rp = rbReplay(REAL, path([]));
  check(rp.ok && rp.P1 === 1.074742, `第 1 笔是同一笔委托的两笔成交（1.075、1.074）按份数加权：P1 = ${rp.ok && rp.P1}`);
  check(rp.ok && rp.addLines[0] === 0.945 && rp.addLines[1] === 0.816 && rp.arm === 1.236 && rp.floor === 1.096 && rp.sl === 0.806,
    `线跟着真实成本走：第 2 笔 ${rp.addLines && rp.addLines[0]}、第 3 笔 ${rp.addLines && rp.addLines[1]}、启动 ${rp.arm}、保底 ${rp.floor}、止损 ${rp.sl}`);
  check(p34(1.074742) === '1.0747' && p34(1.075) === '1.075' && p34(0.5 / (0.5 / 1.075)) === '1.075' && p34(NaN) === '–',
    '成本价：在格子上照样三位，不在格子上多给一位（浮点误差不算「不在格子上」）');
  const p = rbNightPush(rbStatus({ cfg: REAL, rows: path([]), tradingDays: CAL }), { today: START });
  check(p && p.body.includes('第 1 笔：11 月 3 日买入 @ 1.0747') && p.body.includes('成本 1.0747 ·')
    && p.body.includes('↓ ≤ 0.945：买第 2 笔') && p.body.includes('↑ ≥ 1.236：赚到 15%'),
  '推送里成本给到 1.0747，和线对得上：1.0747 × 0.88 → 0.945、× 1.15 → 1.236', p && p.body);
}

{
  console.log('\n● 配置和线');
  check(rbConfigProblems(CFG).length === 0, '测试配置合法', rbConfigProblems(CFG).join('；'));
  const rp = rbReplay(CFG, path([]));
  check(rp.ok && rp.P1 === 1.075, `P1 = 第 1 笔成交价 ${rp.P1}`);
  check(rp.addLines[0] === 0.946 && rp.addLines[1] === 0.817, `买入线 ${rp.addLines.join(' / ')}（P1 × 0.88 / × 0.76）`);
  check(rp.arm === 1.237 && rp.floor === 1.096 && rp.sl === 0.806,
    `止盈启动线 ${rp.arm}、保底线 ${rp.floor}、止损 ${rp.sl}（1.075 × 1.15 向上取 / × 1.02、× 0.75 向下取）`);
  check(rp.day === 0 && rp.inv === 0.5 && rp.armed === null && rp.next === null, '起始日是第 0 天，已投入专款的 50%，还没赚到过 15%');
  const pre = rbReplay(CFG, BEFORE);
  check(pre.ok && pre.s === -1 && pre.day === null, '行情还没到起始日：不报错，等当晚第一次更新');
  for (const [nm, c] of [
    ['没有第 1 笔', cfgWith({ fills: [] })],
    ['第 1 笔日期不是起始日', cfgWith({ fills: [{ k: 1, d: '2026-11-04', p: 1.075 }] })],
    ['比例合计超过 1', cfgWith({ weights: [0.5, 0.4, 0.25] })],
    ['买入线不是递减的', cfgWith({ ladder: [0.76, 0.88] })],
    ['同一笔记了两次', cfgWith({ fills: [{ k: 1, d: START, p: 1.075 }, { k: 2, d: AFTER[3], p: 0.94 }, { k: 2, d: AFTER[4], p: 0.93 }] })],
    ['止盈还是旧写法（一个数）', cfgWith({ tp: 1.2 })],
    ['均线天数不是整数', cfgWith({ tp: { arm: 1.15, ma: 10.5, floor: 1.02 } })],
    ['保底线高过启动线', cfgWith({ tp: { arm: 1.15, ma: 10, floor: 1.2 } })],
  ]) {
    const r = rbReplay(c, path([1.0]));
    check(!r.ok && r.problem, `配置坏了就停手：${nm} → ${r.problem}`);
  }
}

{
  console.log('\n● 取整：显示出来的线就是触发的那一格');
  const avg = 0.75 / (0.5 / 1.075 + 0.25 / 0.944);
  const arm = tickUp(avg * 1.15), sl = tickDown(avg * 0.75);
  check(arm >= avg * 1.15 && arm - 0.001 < avg * 1.15, `启动线向上取：${(avg * 1.15).toFixed(5)} → ${arm}`);
  check(sl <= avg * 0.75 && sl + 0.001 > avg * 0.75, `止损线向下取：${(avg * 0.75).toFixed(5)} → ${sl}`);
  check(tickDown(1.075 * 0.88) === 0.946 && tickUp(1.29) === 1.29 && tickDown(0.946) === 0.946, '本来就在格子上的数不会被挪一格（浮点误差）');
  check(tickBelow(1.234) === 1.233 && tickBelow(1.2341) === 1.234 && tickBelow((1.26 * 9) / 9) === 1.259,
    '比均线低一格：均线正好在格子上就退一格，不在格子上就取它下面那一格');
  check(!rbReplay(CFG, path([1.236])).armed && rbReplay(CFG, path([1.237])).armed?.d === AFTER[0], '收盘 1.237 算赚到 15%，1.236 不算');
  const base = [1.0, 0.944];
  const hitSl = rbReplay(CFG, path([...base, sl])), missSl = rbReplay(CFG, path([...base, +(sl + 0.001).toFixed(3)]));
  check(hitSl.exit && hitSl.exit.why === 'sl' && !missSl.exit, `收盘正好 ${sl} 触发止损，高一格 ${(sl + 0.001).toFixed(3)} 不触发`);
  check(!rbReplay(CFG, path([0.947])).tranches[1].d && rbReplay(CFG, path([0.946])).tranches[1].d === AFTER[0], '收盘 0.946 买第 2 笔，0.947 不买');
}

{
  console.log('\n● 止盈：赚到 15% 之后改盯 10 日线');
  const a = rbReplay(CFG, path(RISE));
  check(a.armed && a.armed.d === AFTER[13] && a.armed.line === 1.237 && !a.exit, `第 14 天收盘 1.240 赚到 15%：先不卖（${a.armed && a.armed.d}）`);
  check(a.next && a.next.by === 'ma' && a.next.line === 1.138, `下一天的卖出线 = 前 9 天收盘平均 1.13889 低一格 = ${a.next && a.next.line}`);
  const brk = rbReplay(CFG, path([...RISE, 1.13]));
  check(brk.exit && brk.exit.why === 'ma' && brk.exit.line === 1.138 && brk.exit.d === AFTER[15], '收盘 1.130 ≤ 1.138：跌破 10 日线，全部卖出');
  const hold = rbReplay(CFG, path([...RISE, 1.139]));
  check(!hold.exit && hold.next, '收盘 1.139 还在线上：继续拿');

  // 「收盘 ≤ 卖出线」和「收盘 < 含当天的 10 日均线」必须同真同假，连均线正好等于收盘的那一格也不能差
  const flat = [...W9, 1.24, ...Array(9).fill(1.26)];
  const eq = rbReplay(CFG, path([...flat, 1.26])), one = rbReplay(CFG, path([...flat, 1.259]));
  check(!eq.exit && one.exit && one.exit.why === 'ma', '前 9 天都是 1.260：收盘 1.260 正好等于 10 日线，不算跌破；1.259 才算');

  const floor = rbReplay(CFG, path([...W9, 1.24, 1.09]));
  check(floor.exit && floor.exit.why === 'floor' && floor.exit.line === 1.096,
    `10 日线还低（1.026）、价格先跌回保底线：收盘 1.090 ≤ 1.096（成本 × 1.02）也全部卖出`);
  const keep = rbReplay(CFG, path([...W9, 1.24, 1.2]));
  check(keep.armed && !keep.exit && keep.next && keep.next.line === 1.096, '跌回启动线 1.237 下面但没破卖出线：还在止盈阶段，不会退回去重新等 15%');

  // 赚到 15% 的当天也要看 10 日线：前几天价格更高、中间加过仓把启动线拉低了，才会出现（极少见）
  const same = rbReplay(CFG, path([...Array(7).fill(1.236), 0.946, 1.184]));
  check(same.tranches[1].d === AFTER[7] && same.arm === 1.183 && same.armed && same.armed.d === AFTER[8]
    && same.exit && same.exit.d === AFTER[8] && same.exit.why === 'ma' && same.exit.line === 1.185,
  '加仓后启动线降到 1.183：当天收盘 1.184 赚到 15%、又低于 10 日线 1.185 → 当天就卖', JSON.stringify(same.exit));

  const up = Array.from({ length: 120 }, (_, i) => +(1.08 * 1.004 ** (i + 1)).toFixed(3));
  const exp = rbReplay(CFG, path(up));
  check(exp.armed && exp.exit && exp.exit.why === 'exp' && exp.exit.day === 120, '赚到 15% 之后一路涨、始终没跌破：第 120 个交易日照样到期卖出');

  // 随机走 60 条路，和最笨的算法逐日比：跌破 = 收盘 × 10 < 含当天的 10 个收盘之和（整数算，没有浮点误差）
  let seed = 7, mism = [];
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 60; k++) {
    let px = 1.08;
    const cl = [];
    for (let d = 0; d < 70; d++) { px = Math.max(1.0, px * (1 + (rnd() - 0.45) * 0.05)); cl.push(+px.toFixed(3)); }
    const rows = path(cl), s = BEFORE.length;
    const r = rbReplay(CFG, rows);
    let armI = null, want = null;
    for (let i = s + 1; i < rows.length && i - s <= 120; i++) {
      const c = Math.round(rows[i].c * 1000);
      if (armI == null && c >= 1237) armI = i;
      if (armI != null) {
        const sum = rows.slice(i - 9, i + 1).reduce((a, x) => a + Math.round(x.c * 1000), 0);
        if (c * 10 < sum || c <= 1096) { want = rows[i].d; break; }
      }
    }
    const got = r.exit && r.exit.why !== 'exp' ? r.exit.d : null;
    if (got !== want || (armI != null) !== !!r.armed) mism.push(`第 ${k} 条：规则 ${got} / 笨算法 ${want}`);
  }
  check(!mism.length, '随机 60 条路：哪天卖和「收盘跌破含当天的 10 日均线」逐日对得上', mism.slice(0, 3).join('；'));
}

{
  console.log('\n● 检查顺序');
  const a = rbReplay(CFG, path([1.06, 1.04, 1.0, 0.97, 0.944, 0.95]));
  const t2 = a.tranches[1];
  check(t2.d === AFTER[4] && t2.p === 0.944 && t2.model, `跌到 0.944 那天按收盘价记第 2 笔（${t2.d}）`);
  const avg2 = 0.75 / (0.5 / 1.075 + 0.25 / 0.944);
  check(Math.abs(a.avg - avg2) < 1e-12 && a.arm === tickUp(avg2 * 1.15) && a.sl === tickDown(avg2 * 0.75),
    `加仓后平均成本 ${a.avg.toFixed(4)}，止盈启动线 ${a.arm}、止损 ${a.sl}`);
  check(a.steps[4].sl === 0.806 && a.steps[5].sl === a.sl, '加仓那天的阶梯：当天之前用旧线，当天之后用新线');

  const gap = rbReplay(CFG, path([1.06, 0.81]));
  check(gap.tranches[1].d === AFTER[1] && gap.tranches[2].d === AFTER[1] && gap.inv === 1, '一天跳空穿过两条买入线（没到止损）：第 2、3 笔同一天买');

  const stopFirst = rbReplay(CFG, path([1.06, 0.80]));
  check(stopFirst.exit && stopFirst.exit.why === 'sl' && !stopFirst.tranches[1].d && !stopFirst.tranches[2].d,
    '同一天既到止损线又到买入线：按止损卖出，不再加仓');

  const after2 = rbReplay(CFG, path([1.0, 0.944, 0.9, 0.765]));
  check(after2.exit && after2.exit.why === 'sl' && !after2.tranches[2].d, `买了两笔后跌到 0.765：≤ 止损 ${after2.steps[2].sl} 也 ≤ 第 3 笔 0.817，按止损`);

  const run = rbReplay(CFG, path([...W9, 0.944, 1.1, 1.2, 1.24, 1.0, 1.3]));
  check(run.tranches[1].d === AFTER[9] && run.armed && run.armed.d === AFTER[11] && run.exit && run.exit.d === AFTER[13] && run.exit.why === 'ma'
    && run.exit.line === 1.053 && run.day === 14,
  '加仓后涨回 +15%（1.183）：进入止盈阶段；跌破 10 日线（1.053，比保底线 1.048 高，先碰到它）那天卖出，之后的行情不再看', JSON.stringify(run.exit));

  const flat = Array(120).fill(1.07);
  const exp = rbReplay(CFG, path(flat));
  check(exp.exit && exp.exit.why === 'exp' && exp.exit.day === 120 && exp.exit.d === path(flat)[BEFORE.length + 120].d, '第 120 个交易日：到期卖出');
  const expLow = rbReplay(CFG, path([...Array(119).fill(1.0), 0.93]));
  check(expLow.exit && expLow.exit.why === 'exp' && !expLow.tranches[1].d, '到期那天收盘到了买入线：只卖不买');
}

{
  console.log('\n● 实际成交校正');
  const late = cfgWith({ fills: [...CFG.fills, { k: 2, d: AFTER[5], p: 0.951 }] });
  const r = rbReplay(late, path([1.0, 0.97, 0.96, 0.95, 0.944, 0.955, 0.95]));
  const t = r.ok ? r.tranches[1] : {};
  check(t.d === AFTER[5] && t.p === 0.951 && !t.model && t.trig === AFTER[4], '收盘触发后晚一天才买到：按实际日期和价格算，触发日照样记着');
  check(r.ok && Math.abs(r.avg - 0.75 / (0.5 / 1.075 + 0.25 / 0.951)) < 1e-12, '平均成本按实际成交价重算');

  const intraday = cfgWith({ fills: [...CFG.fills, { k: 2, d: AFTER[1], p: 0.945 }] });
  const r2 = rbReplay(intraday, path([1.0, [0.95, 0.96, 0.94], 0.97]));
  check(r2.ok && r2.tranches[1].d === AFTER[1] && r2.tranches[1].p === 0.945, '按盘中价买了、收盘又回到线上方：记了实际成交就照实际算');

  const sold = cfgWith({ exit: { d: AFTER[3], p: 1.31 } });
  const r3 = rbReplay(sold, path([1.1, 1.29, 1.0, 1.31, 1.4]));
  check(r3.exit && !r3.exit.model && r3.exit.d === AFTER[3] && r3.exit.p === 1.31 && r3.exit.why === 'manual', '记了实际卖出：按实际那天结束（模型自己的卖点让位）');

  const weekend = cfgWith({ fills: [...CFG.fills, { k: 2, d: '2026-11-07', p: 0.94 }] });
  const r4 = rbReplay(weekend, path([1.0, 0.99, 0.98, 0.97, 0.96, 0.95]));
  check(!r4.ok && /不是行情里的交易日/.test(r4.problem), `实际成交日写成了周末：报错而不是悄悄忽略（${r4.problem}）`);
}

{
  console.log('\n● 交易日和到期日');
  const n26 = CAL.filter((d) => d > START).length;
  const exp = rbTradingDaysAfter(START, CFG.maxDays, CAL);
  check(n26 === 42 && exp.estimated && exp.days.length === 120 && exp.days[41] === '2026-12-31', `2026 年还剩 ${n26} 个交易日照日历走，之后按工作日估`);
  check(exp.days[119] === '2027-04-30', `只有 2026 年日历时，到期日估为 ${exp.days[119]}`);
  check(!exp.days.includes('2027-01-01') && !exp.days.includes('2027-02-08') && !exp.days.includes('2027-04-05'), '估算时去掉元旦、春节、清明');
  // 2027 年日历公布后：照日历走，不再标「约」
  const cal27 = [];
  for (let t = Date.parse('2027-01-01T00:00:00Z'); t <= Date.parse('2027-06-30T00:00:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10), wd = new Date(t).getUTCDay();
    if (wd && wd !== 6 && !['2027-01-01', '2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-04-05'].includes(d)) cal27.push(d);
  }
  const exact = rbTradingDaysAfter(START, CFG.maxDays, [...CAL, ...cal27]);
  check(!exact.estimated && exact.days[119] === '2027-04-30', `日历齐了就照日历：${exact.days[119]}，不再标「约」`);
  const st = rbStatus({ cfg: CFG, rows: path([1.06]), tradingDays: CAL });
  check(st.expiry.left === 119 && st.nextDay.d === AFTER[1], `第 1 天：还剩 ${st.expiry.left} 个交易日，下一个交易日 ${st.nextDay.d}`);
  const fri = rbStatus({ cfg: CFG, rows: [...BEFORE, day0, { d: '2026-11-04', c: 1.06, h: 1.07, l: 1.05 }, { d: '2026-11-05', c: 1.05, h: 1.06, l: 1.04 }, { d: '2026-11-06', c: 1.04, h: 1.05, l: 1.03 }], tradingDays: CAL });
  check(fri.nextDay.d === '2026-11-09' && rbDay(fri.nextDay.d, '2026-11-06') === '11 月 9 日（周一）', '周五之后是下周一，不是「明天」');
}

{
  console.log('\n● 每晚的推送');
  const T0 = START;
  const s0 = rbStatus({ cfg: CFG, rows: path([]), tradingDays: CAL });
  const p0 = rbNightPush(s0, { today: T0 });
  check(p0 && /第 1 笔已买入/.test(p0.title) && p0.level === 'passive' && p0.group === RB_GROUP, `第 0 天：${p0 && p0.title}`);
  check(p0 && p0.body.includes('下一步：11 月 4 日（明天，周三）14:50 看一眼价格') && p0.body.includes('↓ ≤ 0.946：买第 2 笔（专款的 25%），还要跌 11.8%')
    && p0.body.includes('↑ ≥ 1.237：赚到 15%，不急着卖，改盯 10 日线，还要涨 15.4%') && p0.body.includes('都没到就不动'), '写清下一步：哪天 14:50、哪两条线、还差多少', p0 && p0.body);
  check(p0 && p0.body.includes('还剩 120 个交易日，约 2027 年 4 月 30 日（周五）到期'), '写清离到期还有多久（日历没发布前标「约」）');
  check(p0 && !p0.body.includes('止损'), '止损线在第 2 笔买入线下面：先不提，免得以为跌到 0.806 才有事');
  check(rbNightPush(rbStatus({ cfg: CFG, rows: BEFORE, tradingDays: CAL }), { today: T0 }) === null, '行情还没到起始日：不推');

  const sN = rbStatus({ cfg: CFG, rows: path([1.06]), tradingDays: CAL, since: T0 });
  const pN = rbNightPush(sN, { today: AFTER[0] });
  check(pN && /不用操作/.test(pN.title) && !/第 1 笔已买入/.test(pN.title) && pN.level === 'passive' && !pN.action, `平常的日子：${pN && pN.title}`);

  const sA = rbStatus({ cfg: CFG, rows: path([1.0, 0.97, 0.944]), tradingDays: CAL, since: AFTER[1] });
  const pA = rbNightPush(sA, { today: AFTER[2] });
  check(pA && pA.title === `🔔 创业板50 · ${md(AFTER[2])}收盘 0.944，到了第 2 笔买入线` && pA.level === 'timeSensitive' && pA.group === RB_GROUP_ACT,
    `收盘到了买入线：会响铃，单独分组 → ${pA && pA.title}`);
  check(pA && pA.body.includes('· 当天 14:50 已经买了：不用再动') && pA.body.includes(`· 还没买：${rbDay(AFTER[3], AFTER[2])} 14:50 补上，不论那时价格`),
    '「已经买了 / 还没买」两种情况都说清', pA && pA.body);
  check(pA && pA.body.includes(`止盈启动线 ${sA.rp.arm.toFixed(3)}、止损线 ${sA.rp.sl.toFixed(3)}`) && pA.body.includes('↓ ≤ 0.817：买第 3 笔'), '买入后的新线和下一道线都给出来');

  const sB = rbStatus({ cfg: CFG, rows: path([1.06, 0.81]), tradingDays: CAL, since: AFTER[0] });
  const pB = rbNightPush(sB, { today: AFTER[1] });
  check(pB && /到了第 2、3 笔买入线/.test(pB.title) && pB.body.includes('两笔一起买（专款的 50%）'), `跳空穿过两条线：${pB && pB.title}`);

  const sArm = rbStatus({ cfg: CFG, rows: path(RISE.slice(0, 14)), tradingDays: CAL, since: AFTER[12] });
  const pArm = rbNightPush(sArm, { today: AFTER[13] });
  check(pArm && pArm.title === `📈 创业板50 · ${md(AFTER[13])}收盘 1.240，赚到 15% → 改盯 10 日线` && pArm.level === 'active' && !pArm.action,
    `刚赚到 15%：响一声说清楚，但不是「要动手」→ ${pArm && pArm.title}`);
  check(pArm && pArm.body.includes('规则：收盘 ≥ 1.237（成本 1.075 × 1.15）之后不急着卖；此后收盘跌破 10 日线，或者回落到只赚 2%，就全部卖出')
    && pArm.body.includes(`↓ ≤ ${sArm.rp.next.line.toFixed(3)}：全部卖出（${sArm.rp.next.by === 'ma' ? '跌破 10 日线' : '回落到只赚 2%'}）`)
    && pArm.body.includes('没跌破就继续拿') && !pArm.body.includes('↑'), '写清规则换了什么、明天卖出线是多少；不再提启动线', pArm && pArm.body);

  const sHold = rbStatus({ cfg: CFG, rows: path(RISE), tradingDays: CAL, since: AFTER[13] });
  const pHold = rbNightPush(sHold, { today: AFTER[14] });
  check(pHold && /不用操作/.test(pHold.title) && pHold.body.includes('↓ ≤ 1.138：全部卖出（跌破 10 日线），还要跌 9.7%')
    && pHold.body.includes('没跌破就继续拿') && !pHold.body.includes('买第') && !pHold.body.includes('止损'), '止盈阶段的平常日子：只说卖出线一条', pHold && pHold.body);

  const sKeep = rbStatus({ cfg: CFG, rows: path([...W9, 1.24, 1.2]), tradingDays: CAL, since: AFTER[9] });
  const pKeep = rbNightPush(sKeep, { today: AFTER[10] });
  check(pKeep && pKeep.body.includes('↓ ≤ 1.096：全部卖出（回落到只赚 2%），还要跌 8.7%') && !pKeep.body.includes('1.237'),
    '跌回启动线下面：照样只盯卖出线（这天是保底线更高）', pKeep && pKeep.body);

  const above = [...W9, 1.10, ...Array(8).fill(1.30), 1.29];
  const sUp = rbStatus({ cfg: CFG, rows: path(above), tradingDays: CAL, since: AFTER[17] });
  const pUp = rbNightPush(sUp, { today: AFTER[18] });
  check(pUp && sUp.rp.next.line === 1.298 && pUp.body.includes('↓ ≤ 1.298：全部卖出（跌破 10 日线），这条线不低于现价：收盘涨不过它就卖'),
    '明天的卖出线比今天收盘还高：不说「还要跌」，说「收盘涨不过它就卖」', pUp && pUp.body);

  const sT = rbStatus({ cfg: CFG, rows: path([...RISE, 1.13]), tradingDays: CAL, since: AFTER[14] });
  const pT = rbNightPush(sT, { today: AFTER[15] });
  check(pT && pT.title === `🔔 创业板50 · ${md(AFTER[15])}收盘 1.130，跌破 10 日线 → 全部卖出` && pT.level === 'timeSensitive'
    && pT.body.includes(`规则：${md(AFTER[13])}起已赚到过 15%，收盘 ≤ 1.138（跌破 10 日线）`)
    && pT.body.includes('交易结束，不用再动') && pT.body.includes('交易结束后不自动再来一轮'), `跌破 10 日线：${pT && pT.title}`, pT && pT.body);
  const sF = rbStatus({ cfg: CFG, rows: path([...W9, 1.24, 1.09]), tradingDays: CAL, since: AFTER[9] });
  const pF0 = rbNightPush(sF, { today: AFTER[10] });
  check(pF0 && /回落到只赚 2% → 全部卖出/.test(pF0.title) && pF0.body.includes('收盘 ≤ 1.096（成本 1.075 × 1.02，只剩 2%）'), `回落到保底线：${pF0 && pF0.title}`);
  const sS = rbStatus({ cfg: CFG, rows: path([1.0, 0.8]), tradingDays: CAL, since: AFTER[0] });
  const pS = rbNightPush(sS, { today: AFTER[1] });
  check(pS && pS.title.startsWith('⛔') && /到了止损线/.test(pS.title) && pS.level === 'timeSensitive', `止损：${pS && pS.title}`);
  const sE = rbStatus({ cfg: CFG, rows: path(Array(120).fill(1.07)), tradingDays: CAL, since: AFTER[118] });
  const pE = rbNightPush(sE, { today: AFTER[119] });
  check(pE && pE.title.startsWith('⏰') && /到期了 → 全部卖出/.test(pE.title) && pE.body.includes('第 120 个交易日不论盈亏'), `到期：${pE && pE.title}`);
  const sE1 = rbStatus({ cfg: CFG, rows: path(Array(119).fill(1.07)), tradingDays: CAL, since: null });
  const pE1 = rbNightPush(sE1, { today: AFTER[118] });
  check(pE1 && pE1.title.startsWith('⏰') && /到期 → 14:50 全部卖出/.test(pE1.title) && pE1.level === 'timeSensitive' && pE1.body.includes('不论盈亏，14:50 全部卖出'),
    `到期前一晚提前说：${pE1 && pE1.title}`);
  const sD = rbStatus({ cfg: CFG, rows: path([...RISE, 1.13, 1.2]), tradingDays: CAL, since: AFTER[15] });
  check(sD.phase === 'done' && rbNightPush(sD, { today: AFTER[16] }) === null, '交易结束、那晚也推过了：之后不再推');

  const sMiss = rbStatus({ cfg: CFG, rows: path([1.0, 0.944, 0.95]), tradingDays: CAL, since: AFTER[0] });
  const pMiss = rbNightPush(sMiss, { today: AFTER[2] });
  check(pMiss && /到了第 2 笔买入线/.test(pMiss.title) && pMiss.title.includes(`${+AFTER[1].slice(8, 10)} 日收盘`), '前一晚的推送没送达：下一晚把那天的买入线补说（标出是哪天）', pMiss && pMiss.title);
  const sMissArm = rbStatus({ cfg: CFG, rows: path(RISE), tradingDays: CAL, since: AFTER[12] });
  const pMissArm = rbNightPush(sMissArm, { today: AFTER[14] });
  check(pMissArm && pMissArm.title.startsWith(`📈 创业板50 · ${md(AFTER[13])}收盘 1.240`), '赚到 15% 那晚没送达：下一晚照样说（标出是哪天）', pMissArm && pMissArm.title);

  const sTouch = rbStatus({ cfg: CFG, rows: path([[0.95, 0.97, 0.94]]), tradingDays: CAL, since: T0 });
  const pTouch = rbNightPush(sTouch, { today: AFTER[0] });
  check(pTouch && /盘中最低 0\.940 碰到过第 2 笔买入线 0\.946，收盘 0\.950 又回去了/.test(pTouch.body) && pTouch.level === 'active', '盘中碰线、收盘又回去了：提醒一句，按收盘价不算', pTouch && pTouch.body);
  const sTouchS = rbStatus({ cfg: CFG, rows: path([...RISE, [1.15, 1.17, 1.13]]), tradingDays: CAL, since: AFTER[14] });
  const pTouchS = rbNightPush(sTouchS, { today: AFTER[15] });
  check(pTouchS && /盘中最低 1\.130 碰到过卖出线 1\.138（跌破 10 日线），收盘 1\.150 又回去了/.test(pTouchS.body) && /若 14:50 已经卖了/.test(pTouchS.body),
    '止盈阶段盘中跌破过卖出线、收盘又站回去：提醒一句', pTouchS && pTouchS.body);

  const pF = rbNightPush(sA, { today: AFTER[2], fund: 400000 });
  check(pF && pF.body.includes('专款的 25%，约 10 万，按 0.944 约 105,900 份') && pF.body.includes('约 10 万，按 0.817 约 122,300 份'), '设了专款总额：说金额和份数（向下取整到 100 份）', pF && pF.body);
  check(pF && pF.title === pA.title, '金额只进正文，标题和没设时一字不差（标题会随推送结果记进公开仓库）');

  const all = [p0, pN, pA, pB, pArm, pHold, pKeep, pUp, pT, pF0, pS, pE, pE1, pMiss, pMissArm, pTouch, pTouchS].filter(Boolean);
  check(all.every((p) => !amounts(p.title).length), '所有标题都不带金额');
  check(all.every((p) => !amounts(p.body).length), '没设专款总额时，正文也不带金额');
  check(all.every((p) => !fractions(`${p.title}\n${p.body}`).length), '不出现「1/4」这类分数，比例一律说百分之几',
    all.map((p) => fractions(`${p.title}${p.body}`).join(',')).filter(Boolean).join(' | '));
  check(all.every((p) => !/止盈线|undefined|NaN|null/.test(`${p.title}${p.body}`)), '不再出现旧的「止盈线」，也没有漏出 undefined / NaN');

  const bad = rbNightPush(rbStatus({ cfg: cfgWith({ weights: [1, 1, 1] }), rows: path([1.0]), tradingDays: CAL }), { today: AFTER[0] });
  check(bad && /规则文件有问题/.test(bad.title) && bad.level === 'timeSensitive', '配置坏了：推一条告警，不给操作建议');
}

{
  console.log('\n● 14:45 盘中提醒');
  const st = rbStatus({ cfg: CFG, rows: path([1.06, 1.0]), tradingDays: CAL });
  const T = AFTER[2];
  check(rbIntradayPush(st, { c: 1.02, d: T }, { today: T }) === null, '离线还远：不推');
  const hit = rbIntradayPush(st, { c: 0.944, d: T }, { today: T });
  check(hit && /已到第 2 笔买入线/.test(hit.title) && hit.level === 'timeSensitive' && hit.body.includes('14:50 之后价格仍 ≤ 0.946，就买入'), `现价过了买入线：${hit && hit.title}`);
  const near = rbIntradayPush(st, { c: 0.952, d: T }, { today: T });
  check(near && /快到线了/.test(near.title) && near.level === 'active' && near.body.includes('第 2 笔买入线 0.946 只差 0.6%'), `离线不到 1%：${near && near.body.split('\n')[0]}`);
  check(rbIntradayPush(st, { c: 1.23, d: T }, { today: T }) === null && rbIntradayPush(st, { c: 1.3, d: T }, { today: T }) === null,
    '快到或者过了止盈启动线：不推（赚到 15% 当天不用动手）');
  const sl = rbIntradayPush(st, { c: 0.8, d: T }, { today: T });
  check(sl && sl.title.startsWith('⛔') && /已到止损线/.test(sl.title), '现价过了止损线：按止损说（检查顺序同收盘）');
  check(rbIntradayPush(st, { c: 0.944, d: AFTER[1] }, { today: T }) === null, '报价不是今天的：不推');

  const sh = rbStatus({ cfg: CFG, rows: path(RISE), tradingDays: CAL });
  const T2 = AFTER[15];
  const brk = rbIntradayPush(sh, { c: 1.13, d: T2 }, { today: T2 });
  check(brk && brk.title === '🔔 创业板50 · 现价 1.130，已跌破 10 日线' && brk.level === 'timeSensitive' && brk.body.includes('14:50 之后价格仍 ≤ 1.138，就全部卖出'),
    `止盈阶段、现价跌破 10 日线：${brk && brk.title}`);
  const nearS = rbIntradayPush(sh, { c: 1.145, d: T2 }, { today: T2 });
  check(nearS && /快到卖出线了/.test(nearS.title) && nearS.body.includes('离卖出线 1.138（跌破 10 日线）只差 0.6%') && !nearS.action, `离卖出线不到 1%：${nearS && nearS.body.split('\n')[0]}`);
  check(rbIntradayPush(sh, { c: 1.2, d: T2 }, { today: T2 }) === null, '止盈阶段、离卖出线还远：不推');

  const sSame = rbStatus({ cfg: CFG, rows: path([...Array(7).fill(1.236), 0.946]), tradingDays: CAL });
  const same = rbIntradayPush(sSame, { c: 1.184, d: AFTER[8] }, { today: AFTER[8] });
  check(same && /赚到了 15%，却在 10 日线下方/.test(same.title) && same.action && same.body.includes('1.183 到 1.185 之间'),
    '今天才第一次赚到 15%、却已经在 10 日线下方（极少见）：照样提醒当天卖', same && same.body);

  const st119 = rbStatus({ cfg: CFG, rows: path(Array(119).fill(1.07)), tradingDays: CAL });
  const due = rbIntradayPush(st119, { c: 1.07, d: AFTER[119] }, { today: AFTER[119] });
  check(due && due.title.endsWith('4 月 30 日到期 → 14:50 全部卖出') && due.body.startsWith('4 月 30 日（今天，周五）是第 120 个交易日') && due.level === 'timeSensitive',
    `到期当天 14:45 再提醒一次（日期写明）：${due && due.title}`);
  const done = rbStatus({ cfg: CFG, rows: path([...W9, 1.24, 1.09]), tradingDays: CAL });
  check(rbIntradayPush(done, { c: 1.1, d: AFTER[11] }, { today: AFTER[11] }) === null, '交易结束了：不推');
}

{
  console.log('\n● 行情文件的写法');
  const txt = rbSeriesJSON({ schema: 1, code: '159682', run: { asof: 'x' }, rows: [{ d: '2026-11-03', c: 1.072 }, { d: '2026-11-04', c: 1.06 }] });
  const back = JSON.parse(txt);
  check(back.rows.length === 2 && back.run.asof === 'x' && txt.split('\n').filter((l) => l.includes('"d":')).length === 2, '一行一根 K 线，读回来不走样');
}

/* ================================================================ 二、Worker 定时入口 */
console.log('\n【二】走 Worker 真正的定时入口');

const RealDate = Date;
let fakeNow = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
  static now() { return fakeNow ?? RealDate.now(); }
};
const at = (bj) => { fakeNow = RealDate.parse(bj.replace(' ', 'T') + 'Z') - 8 * 3600000; };

const BR = 'master';
let files, blobs, trees, commits, head, log, barks, kl, quote, barkFail, sources;
function resetRepo(init) {
  files = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  blobs = new Map(); trees = new Map(); commits = new Map([['c0', { tree: 't0' }]]); head = 'c0'; log = [];
  trees.set('t0', { entries: [] });
  barks = []; barkFail = false; sources = { tx: true, em: true, sina: true };
}
let n = 0;
const sha = (p) => `${p}${++n}`;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const ymd8 = (d) => d.replace(/-/g, '');

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const m = opts.method || 'GET';
  if (url.startsWith('https://api.day.app/')) {
    barks.push(JSON.parse(opts.body));
    return barkFail ? json({ code: 400, message: 'device not found' }) : json({ code: 200 });
  }
  if (url.startsWith('https://web.ifzq.gtimg.cn/')) {
    if (!sources.tx) return new Response('', { status: 500 });
    return json({ code: 0, data: { sz159682: { day: kl.map((r) => [r.d, String(r.c), String(r.c), String(r.h), String(r.l), '1000']) } } });
  }
  if (url.startsWith('https://push2his.eastmoney.com/')) {
    if (!sources.em) return new Response('', { status: 500 });
    return json({ data: { klines: kl.map((r) => `${r.d},${r.c},${r.c},${r.h},${r.l}`) } });
  }
  if (url.startsWith('https://quotes.sina.cn/')) {
    if (!sources.sina) return new Response('', { status: 500 });
    return json(kl.map((r) => ({ day: r.d, open: String(r.c), high: String(r.h), low: String(r.l), close: String(r.c), volume: '1' })));
  }
  if (url.startsWith('https://qt.gtimg.cn/')) {
    if (!quote) return new Response('', { status: 500 });
    const f = Array(40).fill('0'); f[3] = String(quote.c); f[30] = `${ymd8(quote.d)}144500`;
    return new Response(`v_sz159682="${f.join('~')}";`, { status: 200 });
  }
  if (url.startsWith('https://hq.sinajs.cn/') || url.startsWith('https://push2.eastmoney.com/')) return new Response('', { status: 500 });
  if (url.startsWith('https://www.szse.cn/')) {
    const month = new URL(url).searchParams.get('month');
    const data = [];
    for (let t = RealDate.parse(`${month}-01T00:00:00Z`); new RealDate(t).toISOString().slice(0, 7) === month; t += 86400000) {
      const d = new RealDate(t).toISOString().slice(0, 10);
      data.push({ jyrq: d, jybz: CAL.includes(d) ? '1' : '0' });
    }
    return json({ data });
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
const ENV = { RUN_TOKEN: 'T', GITHUB_TOKEN: 'x', GH_OWNER: 'o', GH_REPO: 'r', GH_BRANCH: BR, BARK_KEY: 'k', BARK_TIMEOUT_MS: '200',
  PAGES_URL: 'https://binbin1555.github.io/hongli-ma30/' };
const CRON = { intraday: '45 6 * * *', night: '5 13 * * *', backup: '35 14 * * *' };
const fire = async (slot, env = ENV) => {
  const jobs = [];
  await worker.scheduled({ cron: CRON[slot], scheduledTime: RealDate.now() }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
};
const repoJSON = (p) => (files.has(p) ? JSON.parse(files.get(p)) : null);
const DIV = { 'data/state.json': '{"asof":"x"}', 'data/ledger.json': '{"entries":[]}', 'data/series.json': '{"rows":[]}' };
function seed({ rows = SER.rows, run = null, cfg = CFG } = {}) {
  resetRepo({
    ...DIV,
    'data/rebound.json': cfg,
    'data/rebound_series.json': rbSeriesJSON({ ...SER, rows, run }),
    'calendar/2026.json': JSON.stringify({ year: 2026, tradingDays: CAL }),
  });
}
const show = (b) => (b ? `${b.title}｜${String(b.body).replace(/\n/g, '⏎')}` : '（没有推送）');
const untouched = () => Object.entries(DIV).every(([k, v]) => files.get(k) === v);
/** 已经跑到 i 天（AFTER 的下标）的那份行情和回填过的运行记录 */
const ranTo = (closes, i) => {
  const rows = path(closes.slice(0, i + 1));
  return { rows, run: { asof: AFTER[i], ranAt: `${AFTER[i]} 21:05:01`, since: i ? AFTER[i - 1] : START, delivered: AFTER[i], push: { ok: true } } };
};

{
  console.log('\n● 11 月 3 日 21:05：第一次更新');
  seed(); kl = [...SER.rows.slice(-59), day0]; quote = null;
  at(`${START} 21:05:02`);
  await fire('night');
  const ser = repoJSON('data/rebound_series.json'), b = barks[0];
  check(barks.length === 1 && b && /第 1 笔已买入/.test(b.title), `推了一条：${show(b)}`);
  check(b && b.url === `https://binbin1555.github.io/hongli-ma30/rebound.html?d=${START}` && b.group === RB_GROUP, `点开跳反弹页（${b && b.url}）`);
  check(ser?.rows?.at(-1)?.d === START && ser.rows.at(-1).c === 1.072 && ser.rows.length === SER.rows.length + 1, '行情并进了今天这根');
  check(ser?.run?.asof === START && ser.run.push?.ok && ser.run.delivered === START && ser.run.source === '腾讯', '推送结果回填：已送达');
  check(log.length === 2 && log.every((x) => x.startsWith('chore(rebound): ')) && /收盘 1\.072/.test(log[0]) && /推送已送达/.test(log[1]), `两次提交：${log.join(' | ')}`);
  check(untouched(), '红利的 state / ledger / series 一个字节都没动');

  console.log('\n● 同一晚 22:35 兜底：都好就什么也不做');
  const nLog = log.length;
  barks = []; at(`${START} 22:35:01`);
  await fire('backup');
  check(barks.length === 0 && log.length === nLog, '没推送、没提交');
}

{
  console.log('\n● 推送没送达：22:35 照原样补发');
  seed(); kl = [...SER.rows.slice(-59), day0];
  barkFail = true; at(`${START} 21:05:02`);
  await fire('night');
  const first = barks[0];
  const s1 = repoJSON('data/rebound_series.json');
  check(s1?.run?.push?.ok === false && s1.run.delivered === null, '没送达也记下来（delivered 不前进）');
  barkFail = false; barks = []; at(`${START} 22:35:01`);
  await fire('backup');
  const again = barks[0];
  check(again && first && again.title === first.title && again.body.startsWith(first.body) && /↻ 补发：21:05 那轮的推送没有送达/.test(again.body), `补发一字不差，末尾注明：${again && again.body.split('\n').at(-1)}`);
  const s2 = repoJSON('data/rebound_series.json');
  check(s2?.run?.push?.ok && s2.run.push.resent && s2.run.delivered === START, '补发成功后回填');
}

{
  console.log('\n● 腾讯挂了：换东财；三个都没有今天：先说一声，22:35 再试');
  seed(); kl = [...SER.rows.slice(-59), day0];
  sources.tx = false; at(`${START} 21:05:02`);
  await fire('night');
  check(repoJSON('data/rebound_series.json')?.run?.source === '东财', '降级到东财');
  seed(); kl = SER.rows.slice(-60); quote = null;
  at(`${START} 21:05:02`);
  await fire('night');
  check(barks.length === 1 && /收盘价还没取到/.test(barks[0].title) && /22:35 会再试一次/.test(barks[0].body) && log.length === 0, `只推一句、不写入：${show(barks[0])}`);
  barks = []; at(`${START} 22:35:01`);
  await fire('backup');
  check(barks.length === 1 && /收盘价取不到/.test(barks[0].title) && /下一个交易日晚上会把 11 月 3 日的数据一起补上/.test(barks[0].body), '兜底那次也没有：说明下一个交易日补上');
  barks = []; quote = { c: 1.072, d: START }; at(`${START} 22:36:01`);
  await fire('backup');
  const s = repoJSON('data/rebound_series.json');
  check(s?.run?.source === '腾讯实时报价' && s.rows.at(-1).c === 1.072 && barks.length === 1, 'K 线都没有、实时报价有：用实时报价兜底');
}

{
  console.log('\n● 收盘到了第 2 笔买入线');
  const rows = path([1.0, 0.97, 0.96]);
  const today = AFTER[3];
  seed({ rows, run: { asof: AFTER[2], ranAt: `${AFTER[2]} 21:05:01`, since: AFTER[1], delivered: AFTER[2], push: { ok: true } } });
  kl = [...rows.slice(-59), { d: today, c: 0.944, h: 0.97, l: 0.94 }];
  at(`${today} 21:05:02`);
  await fire('night', { ...ENV, REBOUND_FUND: '400000' });
  const b = barks[0];
  check(b && /到了第 2 笔买入线/.test(b.title) && b.level === 'timeSensitive' && b.group === RB_GROUP_ACT, `响铃推送：${b && b.title}`);
  check(b && b.body.includes('约 10 万'), '设了 REBOUND_FUND：正文里有金额');
  check(/到了买入线/.test(log[0] || ''), `提交说明：${log[0]}`);
  const txt = files.get('data/rebound_series.json');
  check(!amounts(txt).length, '仓库里的行情文件（含推送结果）不带金额', amounts(txt).join(','));
}

{
  console.log('\n● 赚到 15%、之后跌破 10 日线');
  const CL = [...RISE, 1.13];
  let r = ranTo(CL, 12);
  seed(r); kl = [...r.rows.slice(-59), { d: AFTER[13], c: 1.24, h: 1.25, l: 1.22 }];
  at(`${AFTER[13]} 21:05:02`);
  await fire('night');
  check(barks.length === 1 && barks[0].title.startsWith('📈') && /改盯 10 日线/.test(barks[0].title) && /赚到 15%，改盯 10 日线/.test(log[0] || ''),
    `赚到 15% 那晚：推一条、提交说明写清 → ${log[0]}`);
  r = ranTo(CL, 14);
  seed(r); kl = [...r.rows.slice(-59), { d: AFTER[15], c: 1.13, h: 1.16, l: 1.12 }];
  at(`${AFTER[15]} 21:05:02`);
  await fire('night');
  check(barks.length === 1 && /跌破 10 日线 → 全部卖出/.test(barks[0].title) && barks[0].group === RB_GROUP_ACT && /跌破 10 日线，全部卖出/.test(log[0] || ''),
    `跌破那晚：响铃推送、提交说明写清 → ${log[0]}`);
}

{
  console.log('\n● 脏数据：不写入，推告警');
  seed(); kl = [...SER.rows.slice(-59), { d: START, c: 1.5, h: 1.5, l: 1.4 }];
  at(`${START} 21:05:02`);
  await fire('night');
  check(barks.length === 1 && /行情数据没通过检查/.test(barks[0].title) && log.length === 0, `单日涨跌超过 ±21%：${show(barks[0])}`);
}

{
  console.log('\n● 非交易日、交易早已结束：静默');
  seed(); kl = [...SER.rows.slice(-59), day0];
  at('2026-11-07 21:05:02');
  await fire('night');
  check(barks.length === 0 && log.length === 0, '周六：不推不写');
  const r = ranTo([...W9, 1.24, 1.09], 10);
  seed(r);
  kl = [...r.rows.slice(-59), { d: AFTER[11], c: 1.05, h: 1.06, l: 1.04 }];
  at(`${AFTER[11]} 21:05:02`);
  await fire('night');
  check(barks.length === 0 && log.length === 0, '卖出那晚的推送已送达：之后不抓、不写、不推');
}

{
  console.log('\n● 14:45 盘中');
  const rows = path([1.06, 1.0]);
  const today = AFTER[2];
  seed({ rows, run: { asof: AFTER[1], ranAt: `${AFTER[1]} 21:05`, delivered: AFTER[1], push: { ok: true } } });
  at(`${today} 14:45:03`);
  quote = { c: 1.02, d: today }; await fire('intraday');
  check(barks.length === 0, '离线还远：不推');
  quote = { c: 0.944, d: today }; await fire('intraday');
  check(barks.length === 1 && /已到第 2 笔买入线/.test(barks[0].title) && barks[0].url.endsWith(`rebound.html?d=${today}`), `到线：${barks[0] && barks[0].title}`);
  check(log.length === 0, '盘中那次只读不写');
  const r = ranTo(RISE, 14);
  barks = []; seed(r); at(`${AFTER[15]} 14:45:03`); quote = { c: 1.13, d: AFTER[15] };
  await fire('intraday');
  check(barks.length === 1 && /已跌破 10 日线/.test(barks[0].title), `止盈阶段跌破 10 日线：${barks[0] && barks[0].title}`);
  barks = []; seed(); at(`${START} 14:45:03`); quote = { c: 0.9, d: START };
  await fire('intraday');
  check(barks.length === 0, '起始日当天不看（第 1 笔是那天开盘买的）');
}

{
  console.log('\n● 手动入口 /rebound');
  seed(); kl = [...SER.rows.slice(-59), day0];
  at(`${START} 21:30:00`);
  const r401 = await worker.fetch(new Request('https://w/rebound'), ENV, { waitUntil() {} });
  check(r401.status === 401, '不带口令：401');
  const r = await worker.fetch(new Request('https://w/rebound?token=T'), ENV, { waitUntil() {} });
  const res = JSON.parse(await r.text());
  check(res.ok && res.push && res.push.ok && !/body|万/.test(JSON.stringify(res)), `带口令：跑一遍收盘后那次（返回里不带正文和金额）：${JSON.stringify(res).slice(0, 120)}`);
  barks = []; await fire('night');
  check(barks.length === 0, '之后 21:05 的定时看到今天已跑过：不重复推');
  const unknown = []; await worker.scheduled({ cron: '0 0 * * *' }, ENV, { waitUntil: (p) => unknown.push(p) });
  check(unknown.length === 0, '不认识的定时：什么都不做');
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 创业板50 超跌反弹全部通过'}\n`);
process.exit(fails ? 1 : 0);
