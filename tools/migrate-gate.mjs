/**
 * 给 data/series.json 补上闸门要用的两列（一次性）：
 *   p  中证红利价格指数 000922 收盘（和全收益 H00922 的差就是分红，用来推算股息率）
 *   y  10 年期国债到期收益率（%）
 *
 * 之后 Worker 每天会把当天的 p、y 一起写进来（150 天窗口重抓，缺的会自愈），
 * 这个脚本只负责把历史补齐 —— 股息率要整整一年的分红，年线要 250 个交易日。
 *
 *   node tools/migrate-gate.mjs          只看，不写
 *   node tools/migrate-gate.mjs --write  写回 data/series.json
 *
 * 只填行情里已有的日期，不增删任何一行；已有的 c / m / b 一个字不动。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateState, gateLine } from '../shared/strategy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const path = join(ROOT, 'data', 'series.json');
const series = JSON.parse(readFileSync(path, 'utf8'));
const rows = series.rows;
const first = rows[0].d, last = rows[rows.length - 1].d;
const compact = (s) => s.replace(/-/g, '');

// 1. 价格指数：中证官网，和 Worker 抓 H00922 是同一个接口（一次拿全，别连着刷 —— 会被它的防火墙拦）
const r1 = await fetch(`https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000922&startDate=${compact(first)}&endDate=${compact(last)}`,
  { headers: { 'User-Agent': UA, Referer: 'https://www.csindex.com.cn/', Accept: 'application/json' } });
const j1 = await r1.json();
if (j1.code !== '200') throw new Error(`中证 000922 返回 code=${j1.code}`);
const pBy = new Map();
for (const x of j1.data || []) if (x.close != null) pBy.set(`${x.tradeDate.slice(0, 4)}-${x.tradeDate.slice(4, 6)}-${x.tradeDate.slice(6)}`, +x.close);

// 2. 10 年国债收益率：东方财富数据中心（中债口径），按日期倒序分页，翻到覆盖起点为止
const yBy = new Map();
for (let page = 1; page <= 20; page++) {
  const u = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD'
    + `&columns=SOLAR_DATE,EMM00166466&sortColumns=SOLAR_DATE&sortTypes=-1&pageNumber=${page}&pageSize=500&source=WEB&client=WEB`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
  const j = await r.json();
  const data = (j && j.result && j.result.data) || [];
  for (const x of data) {
    const d = String(x.SOLAR_DATE || '').slice(0, 10), y = Number(x.EMM00166466);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(y) && y > 0 && y < 20) yBy.set(d, y);
  }
  if (!data.length || data[data.length - 1].SOLAR_DATE.slice(0, 10) < first) break;
}

// 3. 填进已有的行
let np = 0, ny = 0, changedP = 0, changedY = 0;
for (const r of rows) {
  if (pBy.has(r.d)) { const v = +pBy.get(r.d).toFixed(2); if (r.p !== undefined && r.p !== v) changedP++; r.p = v; np++; } else if (r.p === undefined) r.p = null;
  if (yBy.has(r.d)) { const v = +yBy.get(r.d).toFixed(4); if (r.y !== undefined && r.y !== v) changedY++; r.y = v; ny++; } else if (r.y === undefined) r.y = null;
}
const missP = rows.filter((r) => r.p == null).map((r) => r.d), missY = rows.filter((r) => r.y == null).map((r) => r.d);
console.log(`行情 ${rows.length} 行（${first} → ${last}）`);
console.log(`价格指数：填上 ${np} 行，缺 ${missP.length} 行${missP.length ? `（${missP.slice(0, 5).join('、')}…）` : ''}${changedP ? `，和原有值不同 ${changedP} 行` : ''}`);
console.log(`国债收益率：填上 ${ny} 行，缺 ${missY.length} 行${missY.length ? `（${missY.slice(0, 5).join('、')}…）` : ''}${changedY ? `，和原有值不同 ${changedY} 行` : ''}`);

// 4. 全收益和价格指数要对得上：除息日以外，两边的涨跌几乎相同
let worst = 0, worstD = '';
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (!(a.p > 0 && b.p > 0)) continue;
  const raw = (b.c / a.c) / (b.p / a.p) - 1;
  if (raw < worst) { worst = raw; worstD = b.d; }
}
console.log(`全收益 ÷ 价格的单日最小比值 ${(worst * 100).toFixed(3)}%（${worstD || '—'}；明显为负说明两边日期错配）`);

const g = gateState(rows);
console.log(`\n${last}：${gateLine(g, last)}`);
console.log(`  股息率 ${(g.dy * 100).toFixed(2)}%　国债 ${(g.y10 * 100).toFixed(2)}%（${g.yDate}）　利差 ${(g.spread * 100).toFixed(2)}%　年线 ${g.ma250.toFixed(2)}`);

if (WRITE) {
  // 和 Worker 写回时同一个格式（不缩进），免得这一次提交把整个文件的每一行都标成改动
  writeFileSync(path, JSON.stringify(series));
  console.log('\n已写回 data/series.json');
} else {
  console.log('\n只看了一遍，没有写。确认无误后加 --write');
}
