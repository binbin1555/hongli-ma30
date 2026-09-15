/**
 * 数据源体检：三个外部接口都还活着吗、返回的东西还是原来的形状吗。
 *
 * 存在的理由：2026-09-10 首次真实运行时，东财 K 线接口悄悄返回 HTTP 520，
 * 股数提示直接失效，而系统只在审计快照里留了一行日志。
 * 接口会变、会挂、会改字段，定期跑一次比出事后再查便宜得多。
 *
 *   npm run check:sources
 */
import { fetchETF } from '../worker/src/index.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
const ok = (name, detail) => console.log(`  OK  ${pad(name, 22)} ${detail}`);
const err = (name, detail) => { bad++; console.log(`  !!! ${pad(name, 22)} ${detail}`); };

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const ymd = (d) => d.replace(/-/g, '');
const back = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);

// 1) 中证指数
for (const code of ['H00922']) {
  try {
    const r = await fetch(`https://www.csindex.com.cn/csindex-home/perf/index-perf`
      + `?indexCode=${code}&startDate=${ymd(back(20))}&endDate=${ymd(today)}`,
      { headers: { 'User-Agent': UA, Referer: 'https://www.csindex.com.cn/' } });
    const j = await r.json();
    const rows = (j.data || []).filter((x) => x.close != null);
    if (j.code !== '200' || !rows.length) throw new Error(`code=${j.code} rows=${rows.length}`);
    const last = rows[rows.length - 1];
    if (last.close == null || last.changePct === undefined) throw new Error('缺少 close 或 changePct 字段');
    ok(`中证 ${code}`, `${rows.length} 行，最新 ${last.tradeDate} 收 ${last.close}`);
  } catch (e) { err(`中证 ${code}`, e.message); }
}

// 2) 深交所交易日历
try {
  const m = today.slice(0, 7);
  const r = await fetch(`https://www.szse.cn/api/report/exchange/onepersistenthour/monthList`
    + `?month=${m}&random=0.${Date.now() % 99999}`,
    { headers: { 'User-Agent': UA, Referer: 'https://www.szse.cn/' } });
  const j = await r.json();
  const d = j.data || [];
  if (!d.length || d[0].jyrq === undefined || d[0].jybz === undefined) throw new Error('字段结构变了');
  ok('深交所日历', `${m} 共 ${d.length} 天，其中交易日 ${d.filter((x) => x.jybz === '1').length} 天`);
} catch (e) { err('深交所日历', e.message); }

// 3) ETF 行情三源（走 Worker 里同一份实现）
try {
  const q = await fetchETF(process.env.ETF_CODE || '515180');
  if (q.failed) throw new Error('三源全挂：' + q.tried.join('、'));
  ok('ETF 行情', `收 ${q.c}　日期 ${q.d}　来源 ${q.source}`
    + (q.tried.length ? `（已降级，失败的：${q.tried.join('、')}）` : '（首选源正常）'));
  if (q.tried.length) err('ETF 首选源', '腾讯不可用，正靠备用源撑着，建议留意');
} catch (e) { err('ETF 行情', e.message); }

console.log(bad === 0 ? '\n  三个数据源全部正常 ✓' : `\n  有 ${bad} 项异常 ✗`);
process.exit(bad === 0 ? 0 : 1);
