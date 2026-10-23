/**
 * 闲钱分两处放（缓冲垫 + 交银稳利）：核心推算 cashPlan / cashPlanLines 的回归测试。
 *
 * 只验规则本身，不碰页面和推送（那两处另有 cashplan-panel / cashplan-push）。
 * 交易日、确认日、到账日一律在这里按交易日历**另算一遍**再去比对，
 * 不借用被测函数里的任何推算 —— 否则它算错了，测试会跟着一起错。
 *
 * 硬约束（每个场景都逐日检查）：
 *   缓冲垫、在途赎回款、交银稳利都不能是负数
 *   三者之和恒等于账本重放出来的现金，红利市值恒等于账本的
 *   赎回款在申请后第 2 个交易日到账（周末、长假顺延）
 *   赎回只动持有满 7 天的份额（按份额确认日算）
 *
 * 用法：npm run cashplan（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cashPlan, cashPlanLines, replay, ma, signal, nextTier, orderAmount, COMMISSION, dayLabel } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const yuan = (n) => Math.round(n).toLocaleString('en-US');

const CAL = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8')).tradingDays;

/* ---------------- 独立的日历推算（不用被测代码） ---------------- */
const tdAfter = (cal, d, n) => { const k = cal.findIndex((x) => x > d); return k < 0 || k + n - 1 >= cal.length ? null : cal[k + n - 1]; };
const natDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
/** 份额 s 日申购、r 日申请赎回：按两个确认日（各自的下一个交易日）算持有天数 */
const heldDays = (cal, s, r) => natDays(tdAfter(cal, s, 1), tdAfter(cal, r, 1));

/* ---------------- 造数据 ---------------- */
const P = 1_000_000;
const rowsOf = (from, to, price = () => 100, nav = () => 1) =>
  CAL.filter((d) => d >= from && d <= to).map((d, k) => ({ d, c: price(d, k), b: nav(d, k) }));
const led = (list) => list.map(([date, from, to], n) => ({
  seq: n + 1, date, signalDate: CAL[CAL.indexOf(date) - 1],
  side: to > from ? 'BUY' : 'SELL', tierFrom: from, tierTo: to, price: 100,
}));

/** 逐日硬约束；返回 cashPlan 结果 */
function checked(label, { rows, entries, start, launch = rows[0].d, cfg = {}, pending = null, cal = CAL, principal = P }) {
  const cp = cashPlan({ rows, entries, principal, launchDate: launch, tradingDays: cal, cfg: { startDate: start, ...cfg }, pending, trace: true });
  const rp = replay(rows, entries, principal, launch);
  let worst = 0, neg = null;
  cp.days.forEach((x, k) => {
    const h = rp.history[k];
    worst = Math.max(worst, Math.abs(x.cash - h.cash), Math.abs(x.V - h.V));
    if (!neg && (x.buf < -1e-6 || x.jiaoyin < -1e-6 || x.transit < -1e-6)) neg = x.d;
  });
  const fullCal = [...new Set([...rows.map((r) => r.d), ...cal])].sort();
  const badArrive = cp.events.filter((e) => e.kind === 'REDEEM' && e.arrive !== tdAfter(fullCal, e.d, 2));
  const young = cp.events.filter((e) => e.kind === 'REDEEM')
    .flatMap((e) => e.lots.filter((l) => !l.old && heldDays(fullCal, l.d, e.d) < 7).map((l) => `${e.d} 动了 ${l.d} 申购的份额`));
  if (worst > 1e-4) bad(`${label}：三类现金之和 / 红利市值偏离账本 ${worst.toExponential(2)} 元`);
  if (neg) bad(`${label}：${neg} 出现负数`);
  if (badArrive.length) bad(`${label}：到账日不对 ${badArrive.map((e) => `${e.d}→${e.arrive}`).join('、')}`);
  if (young.length) bad(`${label}：赎回了不满 7 天的份额 ${young.join('、')}`);
  if (worst <= 1e-4 && !neg && !badArrive.length && !young.length) ok(`${label}：逐日不为负、加总等于账本、到账日与 7 天规则都对`);
  return cp;
}
const ev = (cp, kind, d) => cp.events.filter((e) => e.kind === kind && (!d || e.d === d));
const dayOf = (cp, d) => cp.days.find((x) => x.d === d);

/* ================================================================ */
console.log('\n① 从空仓连续 4 天加仓（起用日 = 起算日）');
{
  const rows = rowsOf('2026-03-02', '2026-03-20');
  const E = led([['2026-03-10', 0, 1], ['2026-03-11', 1, 2], ['2026-03-12', 2, 3], ['2026-03-13', 3, 4]]);
  const cp = checked('连续加仓', { rows, entries: E, start: '2026-03-02' });
  const r0 = ev(cp, 'REDEEM', '2026-03-02')[0];
  if (r0 && near(r0.amount, 500000) && r0.arrive === tdAfter(CAL, '2026-03-02', 2)) ok(`起用当天赎回一半 ${yuan(r0.amount)} 元，${r0.arrive} 到账`);
  else bad(`起用当天应赎回 500,000 元：${JSON.stringify(r0)}`);
  // 目标市值法：买 X =（w×S − V）÷（1 + w×c），实付 X×(1+c)
  const need = orderAmount(P, 0, 0.25).amount * (1 + COMMISSION);
  const r10 = ev(cp, 'REDEEM', '2026-03-10')[0], r11 = ev(cp, 'REDEEM', '2026-03-11')[0];
  if (r10 && near(r10.amount, need, 1) && r10.arrive === tdAfter(CAL, '2026-03-10', 2)) ok(`3 月 10 日买入当天赎回 ${yuan(r10.amount)} 元（＝这笔买入实付），${r10.arrive} 到账`);
  else bad(`3 月 10 日应赎回约 ${yuan(need)} 元：${JSON.stringify(r10)}`);
  if (r11 && near(r11.amount, 500000 - (r10 ? r10.amount : 0), 1)) ok(`3 月 11 日把交银剩下的 ${yuan(r11.amount)} 元全部赎回，${r11.arrive} 到账`);
  else bad(`3 月 11 日应赎回交银剩下的全部：${JSON.stringify(r11)}`);
  for (const d of ['2026-03-12', '2026-03-13']) {
    if (ev(cp, 'REDEEM', d).length) bad(`${d} 交银已经赎空，不该再赎回`);
  }
  if (!cp.shorts.length) ok('4 笔买入都由缓冲垫按时付清，没有一笔没买够'); else bad(`出现没买够：${JSON.stringify(cp.shorts)}`);
  const last = dayOf(cp, '2026-03-13');
  if (last && last.jiaoyin < 1 && last.transit < 1 && last.buf < 200) ok(`满仓后交银 ${yuan(last.jiaoyin)}、在途 ${yuan(last.transit)}、缓冲垫只剩佣金零头 ${yuan(last.buf)} 元`);
  else bad(`满仓后现金应基本为 0：${JSON.stringify(last)}`);
}

console.log('\n② 连续 4 天减仓到空仓');
{
  const rows = rowsOf('2026-03-02', '2026-04-10');
  const E = led([['2026-03-10', 0, 1], ['2026-03-11', 1, 2], ['2026-03-12', 2, 3], ['2026-03-13', 3, 4],
    ['2026-03-23', 4, 3], ['2026-03-24', 3, 2], ['2026-03-25', 2, 1], ['2026-03-26', 1, 0]]);
  const cp = checked('连续减仓', { rows, entries: E, start: '2026-03-02' });
  const subs = ev(cp, 'SUBSCRIBE').map((e) => e.d);
  const want = [tdAfter(CAL, '2026-03-25', 1), tdAfter(CAL, '2026-03-26', 1)];
  if (JSON.stringify(subs) === JSON.stringify(want)) ok(`只在降到 25% 和 0% 之后的下一个交易日申购交银：${subs.join('、')}`);
  else bad(`申购日应为 ${want.join('、')}，实际 ${subs.join('、')}`);
  for (const e of ev(cp, 'SUBSCRIBE')) {
    if (near(e.amount, 250000, 300)) ok(`${e.d} 申购 ${yuan(e.amount)} 元（缓冲垫超出总资产 50% 的部分）`);
    else bad(`${e.d} 申购金额应约 250,000：${yuan(e.amount)}`);
  }
  const end = cp.days[cp.days.length - 1];
  if (near(end.buf, end.cash / 2, 50) && near(end.jiaoyin, end.cash / 2, 50)) ok(`空仓后缓冲垫 ${yuan(end.buf)} / 交银 ${yuan(end.jiaoyin)}，各一半`);
  else bad(`空仓后应各一半：${JSON.stringify(end)}`);
}

console.log('\n③ 卖到空仓后不到 7 天又买入：不满 7 天的份额不能动');
{
  const rows = rowsOf('2026-03-02', '2026-04-24');
  const E = led([['2026-03-10', 0, 1], ['2026-03-11', 1, 2], ['2026-03-12', 2, 3], ['2026-03-13', 3, 4],
    ['2026-03-23', 4, 3], ['2026-03-24', 3, 2], ['2026-03-25', 2, 1], ['2026-03-26', 1, 0],
    ['2026-03-30', 0, 1]]);
  const cp = checked('7 天规则', { rows, entries: E, start: '2026-03-02' });
  const subs = ev(cp, 'SUBSCRIBE').map((e) => e.d);
  // 独立推算：第一批（subs[0] 申购）最早哪天可以免费赎回
  const firstFree = CAL.find((r) => r > '2026-03-30' && heldDays(CAL, subs[0], r) >= 7);
  const reds = ev(cp, 'REDEEM').filter((e) => e.d > '2026-03-26');
  if (reds.length && reds[0].d === firstFree && reds[0].lots.every((l) => l.d === subs[0])) {
    ok(`3 月 30 日买入时交银全是新份额，赎回推迟到 ${firstFree}（份额确认日起满 7 天），只动 ${subs[0]} 那批`);
  } else bad(`应在 ${firstFree} 才赎回 ${subs[0]} 那批：${JSON.stringify(reds)}`);
  if (!ev(cp, 'REDEEM', '2026-03-30').length) ok('3 月 30 日当天没有赎回（份额都不满 7 天）'); else bad('3 月 30 日不该赎回');
  if (!cp.shorts.length) ok('缓冲垫撑住了这笔买入，没有没买够'); else bad(`不该没买够：${JSON.stringify(cp.shorts)}`);

  // 3 月 27 日晚上（挂单：3 月 30 日买入）推送里该说什么
  const r27 = rows.filter((r) => r.d <= '2026-03-27');
  const cp27 = cashPlan({ rows: r27, entries: E.filter((e) => e.date <= '2026-03-27'), principal: P, launchDate: r27[0].d,
    tradingDays: CAL, cfg: { startDate: '2026-03-02' }, pending: { tierFrom: 0, tierTo: 1 } });
  const later = cp27.next.actions.find((a) => a.kind === 'REDEEM_LATER');
  const red = cp27.next.actions.find((a) => a.kind === 'REDEEM');
  if (!red && later && later.day === firstFree && near(later.amount, 250000, 300)) {
    ok(`挂单那晚：不赎回，另有约 ${yuan(later.amount)} 元 ${later.day} 起再赎回（与实际赎回日一致）`);
  } else bad(`挂单那晚应提示「不满 7 天、${firstFree} 起再赎回」：${JSON.stringify(cp27.next.actions)}`);
  const lines = cashPlanLines(cp27, '2026-03-27').join('\n');
  if (/持有不满 7 天/.test(lines) && !/这次不用赎回/.test(lines)) ok(`推送文案：${lines.replace(/\n/g, ' / ')}`);
  else bad(`文案不对：${lines}`);
}

console.log('\n③b 节前申购：持有天数按份额确认日算，不按申请日');
{
  // 找一个「下一个交易日隔了 4 天以上」的节前交易日：在这天申购，份额要等节后才确认
  const pre = CAL.find((d) => d >= '2026-04-20' && natDays(d, tdAfter(CAL, d, 1)) >= 4);
  const k = CAL.indexOf(pre);
  const sellDay = CAL[k - 1], buy1 = CAL[k + 1], buy2 = CAL[k + 2];
  const rows = rowsOf(CAL[k - 20], CAL[k + 25]);
  const E = led([[CAL[k - 10], 0, 1], [sellDay, 1, 0], [buy1, 0, 1], [buy2, 1, 2]]);
  const cp = checked('节前申购', { rows, entries: E, start: rows[0].d });
  const sub = ev(cp, 'SUBSCRIBE')[0];
  const free = CAL.find((r) => r > buy2 && heldDays(CAL, pre, r) >= 7);
  const byApply = CAL.find((r) => r > pre && natDays(pre, r) >= 7);
  const usesNew = ev(cp, 'REDEEM').filter((e) => e.lots.some((l) => l.d === pre));
  if (sub && sub.d === pre && usesNew.length && usesNew[0].d === free && free > byApply) {
    ok(`${pre} 节前申购的份额：按申请日算 ${byApply} 就满 7 天，按确认日算要到 ${free}，实际在 ${free} 才赎回`);
  } else bad(`节前申购的份额应在 ${free} 才赎回（按申请日会错算成 ${byApply}）：${JSON.stringify({ sub, usesNew })}`);
}

console.log('\n④ 起用当天就要买入：缓冲垫还没备好');
{
  const rows = rowsOf('2026-03-02', '2026-03-20');
  const E = led([['2026-03-10', 0, 1]]);
  const cp = checked('起用当天买入', { rows, entries: E, start: '2026-03-10' });
  const s = cp.shorts[0];
  const arr = tdAfter(CAL, '2026-03-10', 2);
  const need = orderAmount(P, 0, 0.25).amount * (1 + COMMISSION);
  if (s && s.date === '2026-03-10' && near(s.gap, need, 1) && s.until === arr) ok(`记下没买够：差 ${yuan(s.gap)} 元，要等 ${arr} 到账`);
  else bad(`应记下没买够：${JSON.stringify(cp.shorts)}`);
  const r = ev(cp, 'REDEEM', '2026-03-10')[0];
  // 缓冲垫目标按「当天早上、成交前」的总资产算（赎回申请就是那时候填的）
  if (r && near(r.amount, need + 0.5 * P, 1)) ok(`当天赎回 ${yuan(r.amount)} 元（这笔买入 + 缓冲垫目标）`);
  else bad(`当天应赎回约 ${yuan(need + 0.5 * P)}：${JSON.stringify(r)}`);
  // 前一晚的推送
  const r9 = rows.filter((x) => x.d <= '2026-03-09');
  const cp9 = cashPlan({ rows: r9, entries: [], principal: P, launchDate: r9[0].d, tradingDays: CAL,
    cfg: { startDate: '2026-03-10' }, pending: { tierFrom: 0, tierTo: 1 } });
  const lines = cashPlanLines(cp9, '2026-03-09').join('\n');
  const L = dayLabel(arr, '2026-03-09').label;
  if (cp9.next.short && lines.includes('⚠️ 缓冲垫只有约 0 元') && lines.includes(`要等 ${L}赎回款到账后再补买`)) ok(`推送明说差额和到账日：${lines.split('\n').pop()}`);
  else bad(`推送应提示缓冲垫不够：${lines}`);
}

console.log('\n⑤ 长假：到账日顺延（2026 年国庆）');
{
  const rows = rowsOf('2026-09-01', '2026-10-22');
  const cp = checked('国庆顺延', { rows, entries: [], start: '2026-09-30' });
  const r = ev(cp, 'REDEEM', '2026-09-30')[0];
  const want = tdAfter(CAL, '2026-09-30', 2);
  if (r && r.arrive === want && want > '2026-10-08') ok(`9 月 30 日申请，${want} 到账（不是 10 月 2 日）`);
  else bad(`国庆前申请应顺延到 ${want}：${JSON.stringify(r)}`);
}

console.log('\n⑥ 不该显示的时候不显示');
{
  const rows = rowsOf('2026-03-02', '2026-03-20');
  const base = { rows, entries: [], launchDate: rows[0].d, tradingDays: CAL };
  if (cashPlan({ ...base, principal: 0, cfg: { startDate: '2026-03-02' } }) === null) ok('没设本金 → 不推算'); else bad('没设本金应返回 null');
  if (cashPlan({ ...base, principal: P, cfg: null }) === null) ok('没有配置 → 不推算'); else bad('没有配置应返回 null');
  if (cashPlan({ ...base, principal: P, cfg: { startDate: '' } }) === null) ok('起用日为空 → 不推算'); else bad('起用日为空应返回 null');
  const fut = cashPlan({ ...base, principal: P, cfg: { startDate: '2026-06-01' } });
  const lines = cashPlanLines(fut, '2026-03-20');
  if (!fut.next.active && fut.buffer === 0 && near(fut.jiaoyin, P, 1) && /缓冲垫规则从 6 月 1 日/.test(lines.join(''))) ok(`起用日在将来：闲钱都算在交银稳利，文案「${lines[0]}」`);
  else bad(`起用日在将来时应全在交银：${JSON.stringify({ next: fut.next, buf: fut.buffer, j: fut.jiaoyin, lines })}`);
}

console.log('\n⑦ 偏离超过总资产 1% 才调（25% 仓位时红利大跌 / 小跌）');
for (const [drop, expect] of [[0.10, true], [0.03, false]]) {
  const rows = rowsOf('2026-03-02', '2026-04-10', (d) => (d >= '2026-03-20' ? 100 * (1 - drop) : 100));
  const E = led([['2026-03-10', 0, 1]]);
  const cp = checked(`跌 ${drop * 100}%`, { rows, entries: E, start: '2026-03-02' });
  const subs = ev(cp, 'SUBSCRIBE');
  if (expect ? subs.length === 1 && subs[0].d === tdAfter(CAL, '2026-03-20', 1) : subs.length === 0) {
    ok(expect ? `红利跌 10%：缓冲垫超出目标 ${yuan(subs[0].amount)} 元，${subs[0].d} 申购交银` : '红利跌 3%：偏离不到 1%，不折腾');
  } else bad(`跌 ${drop * 100}% 时申购记录不对：${JSON.stringify(subs)}`);
}

console.log('\n⑧ 真实行情长跑（data/series.json，按 MA30 规则自动生成账本）');
{
  const series = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
  const rows = series.rows;
  const launch = rows[40].d, entries = [];
  let tier = 0, pend = null;
  for (let i = 40; i < rows.length; i++) {
    if (pend) { entries.push({ seq: entries.length + 1, date: rows[i].d, signalDate: pend.s, side: pend.t > tier ? 'BUY' : 'SELL', tierFrom: tier, tierTo: pend.t, price: rows[i].c }); tier = pend.t; pend = null; }
    const w = nextTier(tier, signal(rows[i].c, ma(rows.slice(0, i + 1).map((r) => r.c))));
    if (w !== tier) pend = { s: rows[i].d, t: w };
  }
  for (const start of [launch, '2025-06-03', '2026-10-23']) {
    const cp = checked(`${launch} 起算、${start} 起用，${entries.length} 笔交易`, { rows, entries, start, launch, principal: 1_860_000 });
    if (start === launch) {
      if (!cp.shorts.length) ok('三年里没有一笔没买够'); else bad(`出现没买够：${JSON.stringify(cp.shorts)}`);
      const calm = cp.events.filter((e) => !entries.some((x) => x.date === e.d) && !entries.some((x) => tdAfter(rows.map((r) => r.d), x.date, 1) === e.d));
      console.log(`      （非买卖日、也不是卖出次日的申赎提醒：${calm.length} 次，约每年 ${(calm.length / 3).toFixed(1)} 次）`);
    }
  }
}

console.log('\n⑨ 文案：日期打头、金额取整、不出现没有日期的相对时间');
{
  const rows = rowsOf('2026-03-02', '2026-03-13');
  const E = led([['2026-03-10', 0, 1]]);
  const cp = cashPlan({ rows, entries: E, principal: P, launchDate: rows[0].d, tradingDays: CAL, cfg: { startDate: '2026-03-02' }, pending: { tierFrom: 1, tierTo: 2 } });
  const lines = cashPlanLines(cp, '2026-03-13');
  const txt = lines.join('\n');
  const L = dayLabel(cp.next.day, '2026-03-13').label;
  if (lines[0].startsWith(`${L}15:00 前赎回交银稳利约 `) && /只赎持有满 7 天的份额，预计 \d+ 月 \d+ 日（[^）]+）到账/.test(lines[0])) ok(`赎回句：${lines[0]}`);
  else bad(`赎回句格式不对：${lines[0]}`);
  if (/\d+\.\d/.test(txt)) bad(`金额没取整：${txt}`); else ok('金额全部取整到元');
  const stray = txt.split('\n').filter((s) => /今天|明天|次日|下一?个交易日/.test(s.replace(/(\d+\s*月\s*\d+\s*日)（[^）]*）/g, '$1')) && !/\d+\s*月\s*\d+\s*日|给不出/.test(s));
  if (stray.length) bad(`相对时间词没带日期：${stray.join(' / ')}`); else ok('相对时间词都只出现在日期后的括号里');
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exitCode = fails ? 1 : 0;
