/**
 * 中证停更时的备用源（雪球）：什么时候用、什么时候不用、中证恢复后怎么换回。
 *
 * 2026-11-12、13 两天中证官网的日终数据停在 11-11（所有指数都是），每日运行按设计拒绝写入，
 * 面板停在 11-11。这里用当时的真实数字把整条路走一遍：
 *   一、雪球的 K 线和 cookie 解析对不对
 *   二、三道关：对得上才用、新的才用、和价格指数合得上才用 —— 任何一关不过就整体不用
 *   三、补上的行带 s 标记；中证恢复后下一轮按日期换回，记下偏差
 *
 * 用法：npm run backup（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const { fetchXueqiu, xueqiuSession, backupIndexRows, mergeIndexRows } = await import('../worker/src/index.js');
const SERIES = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8'));
const CAL = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8')).tradingDays;
const calDays = new Set(CAL);
const calMonths = new Set(CAL.map((d) => d.slice(0, 7)));
const tradingCal = { covers: (d) => calMonths.has(d.slice(0, 7)), has: (d) => calDays.has(d) };

// 剧本：中证只到 11-11，今天是 11-13。下面两天的数是雪球当时给的真实值
const CSI_LAST = '2026-11-11', TODAY = '2026-11-13';
const NEW_TR = [['2026-11-12', 11975.113, -0.59], ['2026-11-13', 12015.7628, 0.34]];
const NEW_PX = [['2026-11-12', 5492.2728], ['2026-11-13', 5510.9164]];
const offRows = SERIES.rows.filter((r) => !r.s && r.d <= CSI_LAST);
if (offRows[offRows.length - 1].d !== CSI_LAST) { console.log(`✗ 仓库里的行情不到 ${CSI_LAST}，剧本对不上`); process.exit(1); }
const official = new Map(offRows.slice(-100).map((r) => [r.d, r.c]));
const trHist = offRows.slice(-150).map((r) => ({ d: r.d, c: r.c, pct: null }));
const pxHist = offRows.slice(-150).filter((r) => r.p != null).map((r) => ({ d: r.d, c: r.p }));
const trAll = trHist.concat(NEW_TR.map(([d, c, pct]) => ({ d, c, pct })));
const pxAll = pxHist.concat(NEW_PX.map(([d, c]) => ({ d, c })));
const fx = (tr = trAll, px = pxAll, session = async () => 'xq_a_token=abc') => ({ session, tr: async () => tr, price: async () => px });

console.log('\n【一】雪球的 cookie 和 K 线解析（假雪球）');
{
  const real = globalThis.fetch;
  let sentCookie = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://xueqiu.com/')) {
      const h = new Headers();
      h.append('set-cookie', 'xq_a_token=TOKEN123; path=/; expires=Wed, 13 Nov 2027 08:00:00 GMT; HttpOnly');
      h.append('set-cookie', 'u=661763; path=/; expires=Wed, 13 Nov 2027 08:00:00 GMT');
      return new Response('<html></html>', { status: 200, headers: h });
    }
    sentCookie = (opts.headers || {}).Cookie;
    // 北京 11-12 00:00 = UTC 11-11 16:00
    const ts = (d) => Date.parse(`${d}T00:00:00+08:00`);
    return new Response(JSON.stringify({ data: { column: ['timestamp', 'volume', 'open', 'high', 'low', 'close', 'chg', 'percent'],
      item: [[ts('2026-11-11'), 0, 1, 1, 1, 12046.6777, -9.2, -0.08], [ts('2026-11-12'), 0, 1, 1, 1, 11975.113, -71.6, -0.59], [ts('2026-11-13'), 0, 1, 1, 1, 12015.7628, 40.6, 0.34]] } }), { status: 200 });
  };
  try {
    const cookie = await xueqiuSession();
    if (!/xq_a_token=TOKEN123/.test(cookie) || !/u=661763/.test(cookie)) bad(`cookie 拼错了：${cookie}`);
    else ok(`拿到访问 cookie：${cookie}`);
    const rows = await fetchXueqiu('CSIH00922', 3, cookie);
    if (sentCookie !== cookie) bad('取 K 线时没带上 cookie');
    else ok('取 K 线时带上了 cookie');
    const want = '2026-11-11 12046.6777 -0.08｜2026-11-12 11975.113 -0.59｜2026-11-13 12015.7628 0.34';
    const got = rows.map((r) => `${r.d} ${r.c} ${r.pct}`).join('｜');
    if (got !== want) bad(`K 线解析不对：${got}`);
    else ok('时间戳按北京日期换算，收盘和涨跌幅都对');
  } catch (e) { bad(`解析出错：${e.message}`); }
  globalThis.fetch = async () => new Response('<html>blocked</html>', { status: 200 });
  try { await xueqiuSession(); bad('首页没给 cookie 时应该报错'); } catch (e) { ok(`首页没给 cookie 时报错：${e.message}`); }
  globalThis.fetch = real;
}

console.log('\n【二】三道关');
let r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx() });
if (!r.ok) bad(`真实剧本被拒了：${r.reason}`);
else {
  ok(`补上 ${r.rows.map((x) => `${x.d} ${x.c}`).join('、')}，核对 ${r.verified.days} 天、最大偏差 ${(r.verified.maxDiff * 100).toFixed(4)}%，`
    + `和价格指数比过 ${r.verified.priceChecked} 天`);
  if (r.rows.map((x) => x.d).join() !== '2026-11-12,2026-11-13') bad('只该补中证缺的 11-12、11-13');
  if (!r.rows.every((x) => x.src === 'xq')) bad('补上的行没带 src 标记');
  if (r.priceRows.length !== 2) bad(`价格指数也该补两天，实际 ${r.priceRows.length}`);
}

// 对不上：重叠的某一天差 0.05%
{
  const tr = trAll.map((x, k) => (k === trAll.length - 30 ? { ...x, c: x.c * 1.0005 } : x));
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(tr) });
  if (r.ok) bad('有一天差 0.05% 还被采用了');
  else ok(`有一天差 0.05%：不用 —— ${r.reason}`);
}
// 重叠太少
{
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(trAll.slice(-8)) });
  if (r.ok) bad('只重叠 6 天也被采用了');
  else ok(`重叠太少：不用 —— ${r.reason}`);
}
// 雪球也没有今天
{
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(trAll.slice(0, -1)) });
  if (r.ok) bad('雪球没有今天的数也被采用了');
  else ok(`雪球也没有今天：不用 —— ${r.reason}`);
}
// 和价格指数合不上：全收益跌、价格指数涨
{
  const tr = trAll.map((x) => (x.d === TODAY ? { ...x, c: 11900 } : x));
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(tr) });
  if (r.ok) bad('全收益和价格指数方向相反也被采用了');
  else ok(`全收益和价格指数合不上：不用 —— ${r.reason}`);
}
// 雪球访问失败
{
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(trAll, pxAll, async () => { throw new Error('HTTP 403'); }) });
  if (r.ok) bad('雪球访问失败时不该有结果');
  else ok(`雪球访问失败：不用 —— ${r.reason}`);
}
// 价格指数取不到：前两关过了就照用（第三关只能跳过），并且说出来
{
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: { ...fx(), price: async () => { throw new Error('timeout'); } } });
  if (!r.ok) bad(`价格指数取不到时不该整体放弃：${r.reason}`);
  else if (r.verified.priceChecked !== 0 || r.priceRows.length) bad('价格指数取不到时不该声称比过');
  else ok('价格指数取不到：照用全收益，核对记录里写明「和价格指数比过 0 天」');
}
// 日历里没有的日子（比如雪球混进周末）要剔掉
{
  const tr = trAll.concat([{ d: '2026-11-14', c: 12020, pct: 0.04 }]);
  r = await backupIndexRows({ official, today: TODAY, tradingCal, fetchers: fx(tr) });
  if (!r.ok || r.rows.some((x) => x.d === '2026-11-14')) bad('周六那行没被剔掉');
  else ok('混进来的周六（11-14）被交易日历剔掉');
}

console.log('\n【三】合并进 series：补上的行带标记，中证恢复后换回');
const empty = { bondByDate: new Map(), pxByDate: new Map(), yByDate: new Map() };
const base = SERIES.rows.filter((x) => x.d <= CSI_LAST);
const idxDay1 = offRows.slice(-140).map((x) => ({ d: x.d, c: x.c, pct: null }))
  .concat(NEW_TR.map(([d, c, pct]) => ({ d, c, pct, src: 'xq' })));
const m1 = mergeIndexRows(base, idxDay1, empty);
const t1 = m1.rows.slice(-3).map((x) => `${x.d} ${x.c}${x.s ? `[${x.s}]` : ''}`).join('　');
console.log(`  停更期间：${t1}`);
if (!m1.rows.find((x) => x.d === '2026-11-12' && x.s === 'xq' && x.c === 11975.11)) bad('11-12 应该带 xq 标记、收盘 11975.11');
else if (m1.rows.find((x) => x.d === CSI_LAST).s) bad('中证给的 11-11 不该带标记');
else if (m1.recovered.length) bad('停更期间不该有「换回」');
else ok('11-12、11-13 带 xq 标记，11-11 及以前没有');
const ma = m1.rows.find((x) => x.d === TODAY).m;
if (!(ma > 0)) bad('补上的那天没算出 MA30');
else ok(`补上的那天照常算出 MA30 ${ma}`);

// 中证恢复：下一轮给出 11-12、11-13 的正式数（假设和雪球一致到分）以及新的一天
const idxDay2 = offRows.slice(-140).map((x) => ({ d: x.d, c: x.c, pct: null }))
  .concat([{ d: '2026-11-12', c: 11975.11, pct: -0.59 }, { d: '2026-11-13', c: 12015.76, pct: 0.34 }, { d: '2026-11-16', c: 12030.5, pct: 0.12 }]);
const m2 = mergeIndexRows(m1.rows, idxDay2, empty);
const t2 = m2.rows.slice(-4).map((x) => `${x.d} ${x.c}${x.s ? `[${x.s}]` : ''}`).join('　');
console.log(`  中证恢复后：${t2}`);
if (m2.rows.some((x) => x.s)) bad('中证恢复后还残留着备用源标记');
else if (m2.recovered.map((x) => x.d).join() !== '2026-11-12,2026-11-13') bad(`换回的日子不对：${m2.recovered.map((x) => x.d)}`);
else ok(`11-12、11-13 换回正式数据，最大偏差 ${(Math.max(...m2.recovered.map((x) => x.diff)) * 100).toFixed(4)}%，标记全部消失`);

// 恢复时两边要是有出入，偏差要如实记下
const idxDay2b = idxDay2.map((x) => (x.d === '2026-11-12' ? { ...x, c: 11990 } : x));
const m3 = mergeIndexRows(m1.rows, idxDay2b, empty);
const w = m3.recovered.find((x) => x.d === '2026-11-12');
if (!w || !(w.diff > 0.001)) bad('正式数据和备用源有出入时没记下偏差');
else ok(`正式数据和备用源有出入时记下偏差：11-12 雪球 ${w.backup} / 中证 ${w.official}（${(w.diff * 100).toFixed(3)}%）`);

// 老行没变的部分一行不少、一个数不改
const before = new Map(base.map((x) => [x.d, JSON.stringify(x)]));
const changed = m1.rows.filter((x) => before.has(x.d) && x.d < offRows[offRows.length - 140].d && before.get(x.d) !== JSON.stringify(x));
if (changed.length) bad(`窗口以外的老行被改了：${changed.slice(0, 3).map((x) => x.d)}`);
else ok('窗口以外的老行原封不动');

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 备用源全部通过');
process.exit(fails ? 1 : 0);
