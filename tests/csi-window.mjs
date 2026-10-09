/**
 * 查询起点不是交易日时，中证这个接口会把起点之后第一条真实记录复制一份、贴上起点的日期返回。
 *
 * 2026-09-28 实测：往前 150 天正好是 05-01（劳动节）。中证返回了一行假的 05-01，
 * 收盘价 12363.89 —— 那是 05-06 的。原来的清洗规则「和前一行相同就删后面那行」
 * 删掉了真实的 05-06、留下了假的 05-01，第 3 项校验拒绝写入，整天没跑。
 *
 * 这里把中证当时的返回原样喂给真正的清洗函数和真正的校验函数，看结果对不对。
 * 用法：npm run csi-window
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const { fetchCSI, runChecks } = await import('../worker/src/index.js');
const CAL = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8')).tradingDays;
const calDays = new Set(CAL);
const calMonths = new Set(CAL.map((d) => d.slice(0, 7)));
const tradingCal = { covers: (d) => calMonths.has(d.slice(0, 7)), has: (d) => calDays.has(d) };

/** 假中证：返回我们给定的行 */
let payload = [];
globalThis.fetch = async () => new Response(JSON.stringify({ code: '200', data: payload }), { status: 200 });
const row = (d, c) => ({ tradeDate: d.replace(/-/g, ''), close: c, changePct: null });

// 2026-09-28 那天中证的原样返回（窗口起点 05-01）
const SEP28 = [row('2026-05-01', 12363.89), row('2026-05-06', 12363.89), row('2026-05-07', 12164.95), row('2026-05-08', 12123.91)];
// 起点是交易日时的正常返回
const NORMAL = [row('2026-04-29', 12364.05), row('2026-04-30', 12328.65), row('2026-05-06', 12363.89), row('2026-05-07', 12164.95)];

console.log('\n【一】复现 09-28：有官方日历时');
payload = SEP28;
let r = await fetchCSI('H00922', '2026-05-01', '2026-05-08', tradingCal);
console.log(`  清洗后：${r.rows.map((x) => `${x.d} ${x.c}`).join('　')}`);
console.log(`  剔除：非交易日 ${JSON.stringify(r.removed.offCalendar)}　误删风险的经验规则 ${JSON.stringify(r.removed.ghost)}`);
if (r.rows.some((x) => x.d === '2026-05-01')) bad('假的 05-01 还在');
else ok('贴错日期的 05-01 被剔除');
const d6 = r.rows.find((x) => x.d === '2026-05-06');
if (!d6) bad('真实的 05-06 被删掉了 —— 就是 09-28 那天的错');
else if (d6.c !== 12363.89) bad(`05-06 收盘价不对：${d6.c}`);
else ok('真实的 05-06 保留，收盘价 12363.89');

console.log('\n【二】清洗后的结果交给第 3、4 项校验 —— 09-28 那天就是在这里被拦下的');
const rows = r.rows.map((x) => ({ d: x.d, c: x.c, pct: x.pct }));
const checks = runChecks(rows, r.removed, '2026-05-08', null, 0, 0, CAL, []);
for (const id of [3, 4]) {
  const c = checks.find((x) => x.id === id);
  console.log(`  第 ${id} 项「${c.name}」：${c.ok ? '通过' : '没通过'} —— ${c.detail}`);
  if (!c.ok) bad(`第 ${id} 项校验仍然不过，那天照样会整轮停跑`);
}
if (checks.filter((x) => [3, 4].includes(x.id)).every((x) => x.ok)) ok('两项都通过，不会再因为这个停跑');

console.log('\n【三】没有日历覆盖时（比如跨年缺上一年日历），经验规则也要删对行');
payload = SEP28;
r = await fetchCSI('H00922', '2026-05-01', '2026-05-08', null);
console.log(`  清洗后：${r.rows.map((x) => `${x.d} ${x.c}`).join('　')}`);
if (r.rows.some((x) => x.d === '2026-05-01')) bad('没日历时，假的 05-01 留下来了');
else if (!r.rows.some((x) => x.d === '2026-05-06')) bad('没日历时，把真实的 05-06 删了 —— 方向还是反的');
else ok('删的是窗口起点那行假数据，真实的 05-06 保留');

console.log('\n【四】起点本来就是交易日：一行都不该动');
payload = NORMAL;
r = await fetchCSI('H00922', '2026-04-29', '2026-05-07', tradingCal);
const cut = Object.values(r.removed).reduce((a, b) => a + b.length, 0);
if (r.rows.length !== 4 || cut) bad(`正常数据被动了：剩 ${r.rows.length} 行，剔除 ${cut} 行`);
else ok('4 行原样保留，没有误删');

console.log('\n【五】假行不在起点、而在中间（收盘价也和邻居不同）—— 只有日历这一层拦得住');
// 上面几条里，假行恰好在起点，「起点规则」一层就够了，日历那层坏了也看不出来。
// 这一条专门验日历那层：起点规则管不到它，经验规则也管不到它（收盘价不重复）。
payload = [row('2026-04-29', 12364.05), row('2026-04-30', 12328.65), row('2026-05-04', 12340.00), row('2026-05-06', 12363.89)];
r = await fetchCSI('H00922', '2026-04-29', '2026-05-06', tradingCal);
console.log(`  清洗后：${r.rows.map((x) => x.d).join('　')}`);
if (r.rows.some((x) => x.d === '2026-05-04')) bad('05-04（劳动节假期）混在中间没被剔除 —— 第 3 项校验会拒绝写入');
else if (r.rows.length !== 3) bad(`应剩 3 行，实际 ${r.rows.length} 行`);
else ok('中间的休市日被日历剔除，其余 3 行原样保留');

console.log(`\n${fails ? `✗ ${fails} 处有问题` : '✓ 窗口起点落在休市日时，假行被剔除、真实数据保留、校验通过'}\n`);
process.exitCode = fails ? 1 : 0;
