/**
 * 一次性迁移：把 series.json 里闲钱基准那一列（b）从中证全债 H11001
 * 整列换成交银稳利中短债债券A（008204）的累计净值。
 *
 * 为什么必须整列重建：worker 每次只抓最近 150 天，直接换数据源的话，
 * 窗口内会变成基金净值（1.23 量级），窗口外仍是债指（267 量级）。
 * 两个量级混在同一列里，交界那一天会算出 −99.5% 的「收益」。
 *
 * 这个脚本只改 data/series.json 的 b 列，不碰 c（指数收盘）和 m（均线），
 * 也不碰账本。跑之前会先把原文件备份到 data/series.json.h11001.bak。
 *
 * 用法：node tools/migrate-cash-benchmark.mjs [基金代码]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = process.argv[2] || '008204';
const SERIES = join(ROOT, 'data', 'series.json');
const BAK = join(ROOT, 'data', 'series.json.h11001.bak');

const r = await fetch(`https://fund.eastmoney.com/pingzhongdata/${CODE}.js`, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://fund.eastmoney.com/',
  },
});
if (!r.ok) { console.log(`✗ 取净值失败：HTTP ${r.status}`); process.exit(1); }
const txt = await r.text();

const name = (txt.match(/fS_name\s*=\s*"([^"]*)"/) || [])[1] || CODE;
const m = txt.match(/Data_ACWorthTrend\s*=\s*(\[[\s\S]*?\]\s*\])\s*;/);
if (!m) { console.log('✗ 净值序列没解析出来，页面结构可能变了'); process.exit(1); }

// 时间戳是北京时间的零点。用 UTC 解会整体错一天 —— 实测踩过：
// 序列里会冒出周日，而真正的周五不见了。
const nav = new Map();
for (const x of JSON.parse(m[1])) {
  if (!Array.isArray(x) || x.length < 2 || !isFinite(x[1]) || x[1] <= 0) continue;
  nav.set(new Date(x[0] + 8 * 3600000).toISOString().slice(0, 10), +x[1]);
}
const days = [...nav.keys()].sort();
console.log(`基金：${name}（${CODE}）`);
console.log(`净值：${nav.size} 条，${days[0]} → ${days[days.length - 1]}\n`);

const series = JSON.parse(readFileSync(SERIES, 'utf8'));
const rows = series.rows;
if (!existsSync(BAK)) { writeFileSync(BAK, JSON.stringify(series), 'utf8'); console.log(`原文件已备份 → ${BAK}\n`); }

let hit = 0, carried = 0, missing = 0, last = null;
const firstNav = days[0];
for (const row of rows) {
  if (nav.has(row.d)) { row.b = +nav.get(row.d).toFixed(4); last = row.b; hit++; }
  else if (row.d < firstNav) { row.b = null; missing++; }      // 基金成立之前，没有就是没有
  else if (last != null) { row.b = last; carried++; }          // 当天没净值，沿用上一个已知值
  else { row.b = null; missing++; }
}
series.cashBenchmark = { code: CODE, name, kind: '累计净值' };
writeFileSync(SERIES, JSON.stringify(series), 'utf8');

console.log(`series 共 ${rows.length} 行：直接命中 ${hit}，沿用前值 ${carried}，留空 ${missing}`);
const withB = rows.filter((x) => x.b != null);
console.log(`b 列现在的范围：${withB[0].d} ${withB[0].b} → ${withB[withB.length - 1].d} ${withB[withB.length - 1].b}`);

// 量级自检：整列必须是同一个数量级，否则就是没换干净
const vals = withB.map((x) => x.b);
const lo = Math.min(...vals), hi = Math.max(...vals);
console.log(`最小 ${lo}　最大 ${hi}　比值 ${(hi / lo).toFixed(3)}`);
if (hi / lo > 3) {
  console.log('\n✗ 同一列里出现了差 3 倍以上的数值 —— 多半是两种基准混在一起了，请检查');
  process.exitCode = 1;
} else {
  console.log('\n✓ 整列量级一致，没有混入旧基准');
}
