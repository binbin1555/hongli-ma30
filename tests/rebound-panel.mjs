/**
 * 创业板50 那页（rebound.html）
 *
 * 和 harness.mjs 同一个办法：把页面里的 <script type="module"> 整段抠出来，配一套极简 DOM 假件跑真代码，
 * 再开个后门换数据、重画。查的是使用者真正看到的字：
 *   「下一步」卡和当晚的推送一字不差；梯子上每条线离现价多远；到期还剩几天；图里有哪几条线；
 *   金额只在本机填了专款总额之后才出现。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? `\n      ${detail}` : ''}`));

// 假时钟：默认就是真实时间；要测「数据落后」时拨到行情之后几天
const RealDate = Date;
let fakeNow = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
  static now() { return fakeNow ?? RealDate.now(); }
};
const at = (bj) => { fakeNow = RealDate.parse(bj.replace(' ', 'T') + 'Z') - 8 * 3600000; };

/* ---------------- 极简 DOM 假件 ---------------- */
class El {
  constructor(id = '') {
    this.id = id; this._t = ''; this._h = ''; this.value = ''; this.hidden = false;
    this.dataset = {}; this.style = {}; this.clientWidth = 540; this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  set textContent(v) { this._t = String(v); this._h = ''; }
  get textContent() { return this._h ? this._h.replace(/<br\s*\/?>/g, ' ⏎ ').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : this._t; }
  set innerHTML(v) { this._h = String(v); this._t = ''; }
  get innerHTML() { return this._h; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  addEventListener(type, fn) { (this._ls ||= {})[type] = [...(this._ls?.[type] || []), fn]; }
  click() { for (const f of (this._ls && this._ls.click) || []) f({}); }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 540, height: 300 }; }
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
const store = new Map();
globalThis.document = {
  getElementById: el,
  documentElement: { setAttribute() {}, removeAttribute() {} },
};
globalThis.window = { addEventListener() {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.fetch = async (u) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  try {
    const txt = readFileSync(join(ROOT, rel), 'utf8');
    return { ok: true, json: async () => JSON.parse(txt) };
  } catch { return { ok: false, json: async () => { throw new Error('404 ' + rel); } }; }
};

const html = readFileSync(join(ROOT, 'rebound.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('✗ rebound.html 里找不到 <script type="module">'); process.exit(1); }
const RB_URL = pathToFileURL(join(ROOT, 'shared', 'rebound.js')).href;
if (!m[1].includes('`./shared/rebound.js?v=')) { console.log('✗ rebound.html 不是按版本号加载 shared/rebound.js 的'); process.exit(1); }
const src = m[1].replace('`./shared/rebound.js?v=', `\`${RB_URL}?v=`)
  + '\nglobalThis.__RB = { get S() { return S; }, set S(v) { S = v; }, get ST() { return ST; }, render, LS,'
  + ' setRange(r) { range = r; } };\n';
const tmp = join(tmpdir(), `hlma30-rebound-${process.pid}.mjs`);
writeFileSync(tmp, src, 'utf8');
await import(pathToFileURL(tmp).href);
const H = globalThis.__RB;
if (!H || !H.S) { console.log('✗ 页面模块没能加载出数据'); process.exit(1); }
const RB = await import(RB_URL);

const T = (id) => el(id).textContent.replace(/\s+/g, ' ').trim();
const nextLines = () => (el('nextList').innerHTML.match(/<li[^>]*>[\s\S]*?<\/li>/g) || [])
  .map((li) => li.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim());
const visible = () => ['nextKick', 'nextHead', 'nextList', 'ladder', 'due', 'tranches', 'posKv', 'nextNote', 'warn'].map(T).join('\n');
const fractions = (t) => String(t).match(/\d+\s*\/\s*\d+/g) || [];
const amounts = (t) => String(t).match(/万|元|\d{1,3}(,\d{3})+/g) || [];

const BASE = JSON.parse(JSON.stringify(H.S));
const CAL = BASE.cal;
const START = BASE.cfg.start;
const AFTER = RB.rbTradingDaysAfter(START, 130, CAL).days;
const BEFORE = BASE.series.rows.filter((r) => r.d < START);
const day0 = { d: START, c: 1.072, h: 1.077, l: 1.063 };
const path = (closes) => [...BEFORE, day0, ...closes.map((c, i) => ({ d: AFTER[i], c, h: +(c * 1.01).toFixed(3), l: +(c * 0.99).toFixed(3) }))];
// 先垫 9 天 1.000，后面几天的 10 日线就只由这里给的数决定（同 tests/rebound.mjs）
const W9 = Array(9).fill(1.0);
const RISE = [...W9, 1.15, 1.18, 1.2, 1.22, 1.24, 1.26];            // 第 14 天赚到 15%，下一天卖出线 1.138
const DONE = [...W9, 0.944, 1.1, 1.2, 1.24, 1.0];                   // 第 10 天买第 2 笔、第 12 天赚到 15%、第 14 天跌破 10 日线卖出
function put(rows, { run = null, cfg = BASE.cfg, fund = 0 } = {}) {
  store.set('hlma30.rbFund', JSON.stringify(fund));
  H.S = { ...BASE, cfg, series: { ...BASE.series, rows, run } };
  H.render();
}

console.log('\n● 仓库里的真实数据（第 1 笔已买、当晚还没更新过）');
{
  H.render();
  const st = H.ST;
  check(st.ok, `rbStatus 正常：${st.ok ? st.phase : st.problem}`);
  if (st.phase === 'pre') {
    check(/第 1 笔已买入 @ 1\.075/.test(T('nextKick')) && /21:05 第一次更新/.test(T('nextHead')), `还没更新过：${T('nextKick')}｜${T('nextHead')}`);
  } else {
    check(T('nextHead').length > 0, `已经更新过：${T('nextHead')}`);
  }
  check(/止盈启动线.*1\.237/.test(T('ladder')) && /0\.946/.test(T('ladder')) && /0\.817/.test(T('ladder')), '梯子上有止盈启动线和两条买入线');
  check(/还剩 \d+ 个交易日/.test(T('due')), `到期：${T('due').slice(0, 60)}`);
  check(/<svg/.test(el('chart').innerHTML), '走势图画出来了');
}

console.log('\n● 平常的日子：大字是「下一步」，下面每一行和推送一样');
{
  const rows = path([1.06, 1.081, 1.05]);
  put(rows, { run: { asof: AFTER[2], ranAt: `${AFTER[2]} 21:05:12`, source: '腾讯', delivered: AFTER[2], push: { ok: true, at: `${AFTER[2]} 21:05:14` } } });
  const today = RB.rbBeijingDate();
  const st = RB.rbStatus({ cfg: BASE.cfg, rows, tradingDays: CAL, since: AFTER[1] });
  const p = RB.rbNightPush(st, { today });
  const lines = p.body.split('\n');
  const i = lines.findIndex((l) => l.startsWith('下一步：'));
  check(T('nextHead') === lines[i].slice(4), `大字：${T('nextHead')}`);
  const want = lines.filter((_, k) => k !== i).map((l) => (/^[↓↑]/.test(l) ? `${l[0]}${l.slice(1).trim()}` : l));
  const got = nextLines();
  check(JSON.stringify(got) === JSON.stringify(want), '下面每一行和推送一字不差', `页面：${got.join(' | ')}\n      推送：${want.join(' | ')}`);
  check(T('nextKick') === p.title.replace(/^创业板50 · /, ''), `小字是推送标题：${T('nextKick')}`);
  check(/第 2 笔买入线.*0\.946还要跌 9\.9%/.test(T('ladder')) && /止盈启动线.*1\.237还要涨 17\.8%/.test(T('ladder')), '梯子：收盘 1.050 时第 2 笔还要跌 9.9%，止盈启动线还要涨 17.8%', T('ladder'));
  check(/还剩 117 个交易日/.test(T('due')) && /约 2027 年 4 月 30 日（周五）到期/.test(T('due')), `到期：${T('due').slice(0, 50)}`);
  check(/推送 21:05 已送达/.test(T('foot')) && /行情来自腾讯/.test(T('foot')), `页脚：${T('foot')}`);
  check(!fractions(visible()).length, '整页不出现「1/4」这类分数', fractions(visible()).join(','));
  check(!amounts(visible()).length, '没填专款总额：整页不出现金额', amounts(visible()).join(','));
}

console.log('\n● 收盘到了第 2 笔买入线：卡片变成「要动手」，正文就是推送');
{
  const rows = path([1.0, 0.97, 0.944]);
  put(rows);
  const today = RB.rbBeijingDate();
  const st = RB.rbStatus({ cfg: BASE.cfg, rows, tradingDays: CAL, since: AFTER[1] });
  const p = RB.rbNightPush(st, { today });
  check(T('nextKick') === '要动手' && el('nextCard').className.includes('act'), `「要动手」：${el('nextCard').className}`);
  check(T('nextHead') === p.title.replace('创业板50 · ', ''), `标题：${T('nextHead')}`);
  check(nextLines().includes('· 当天 14:50 已经买了：不用再动') && nextLines().some((l) => /^· 还没买：.+ 14:50 补上，不论那时价格$/.test(l)), '「已经买了 / 还没买」两行都在');
  check(/第 2 笔已买/.test(T('ladder')) && /按收盘价记/.test(T('ladder')) && /加仓后已重算/.test(T('ladder')), '梯子上第 2 笔变成「已买」，平均成本注明已重算');
  check(/✓.+（按收盘价记）/.test(T('tranches')), `持仓表：${T('tranches').slice(0, 80)}`);
}

console.log('\n● 填了专款总额：金额和份数只在本机出现');
{
  put(path([1.06]), { fund: 400000 });
  check(/约 10 万（约 105,700 份）/.test(T('ladder')), `梯子：${T('ladder').match(/第 2 笔买入线[^0]*/)?.[0] || T('ladder').slice(0, 80)}`);
  check(/约 20 万/.test(T('posKv')), `持仓：${T('posKv')}`);
  check(/约 10 万/.test(T('nextList')), '「下一步」里也带上金额（和设了 REBOUND_FUND 的推送一样）');
  put(path([1.06]), { fund: 0 });
  check(!amounts(visible()).length, '清掉之后金额全部消失');
}

console.log('\n● 走势图');
{
  put(path([1.06, 1.0, 0.97]));
  H.setRange('round'); H.render();
  const svg = el('chart').innerHTML;
  check(/启动 1\.237/.test(svg) && /第2笔 0\.946/.test(svg) && /第3笔 0\.817/.test(svg) && /止损 0\.806/.test(svg) && /成本 1\.075/.test(svg), '「全程」：右边标着止盈启动线、两条买入线、止损、成本');
  check(!/class="ma10"/.test(svg), '还没赚到 15%：不画 10 日线');
  check(/到期 约4\/30/.test(svg), '「全程」：画出到期日（标「约」）');
  check((svg.match(/class="mb"/g) || []).length === 1, '买点：第 1 笔一个红三角');
  H.setRange('recent'); H.render();
  check(!/到期 约/.test(el('chart').innerHTML), '「近期」：离到期还远，不画到期线');
  put(path(RISE));
  const s1 = el('chart').innerHTML;
  check(/class="ma10"/.test(s1) && /卖出 1\.138/.test(s1) && !/启动 1\.237/.test(s1) && !/第2笔 0\.946/.test(s1) && !/止损 /.test(s1),
    '赚到 15% 之后：画 10 日线，右边只标卖出线和成本');
  put(path(DONE));
  check(H.ST.phase === 'done', `这条路走完是卖出：${H.ST.phase}`);
  const s2 = el('chart').innerHTML;
  check((s2.match(/class="mb"/g) || []).length === 2 && /class="ms"/.test(s2), '跌破 10 日线卖出之后：两个买点、一个卖点');
  check(!/第2笔 0\.946/.test(s2) && !/启动 /.test(s2) && !/卖出 1/.test(s2), '交易结束：右边不再标还没触发的线');
}

console.log('\n● 赚到 15% 之后：梯子只剩卖出线，下一步和推送一字不差');
{
  const rows = path(RISE);
  put(rows);
  const today = RB.rbBeijingDate();
  const st = RB.rbStatus({ cfg: BASE.cfg, rows, tradingDays: CAL, since: rows[rows.length - 2].d });
  const p = RB.rbNightPush(st, { today });
  const lines = p.body.split('\n');
  const i = lines.findIndex((l) => l.startsWith('下一步：'));
  const want = lines.filter((_, k) => k !== i).map((l) => (/^[↓↑]/.test(l) ? `${l[0]}${l.slice(1).trim()}` : l));
  check(JSON.stringify(nextLines()) === JSON.stringify(want), '「下一步」每一行和推送一字不差', `页面：${nextLines().join(' | ')}\n      推送：${want.join(' | ')}`);
  check(/卖出线.*跌破 10 日线.*1\.138还要跌 9\.7%/.test(T('ladder')) && !/买入线/.test(T('ladder')) && !/止损线/.test(T('ladder')) && !/止盈启动线/.test(T('ladder')),
    '梯子：卖出线 1.138 还要跌 9.7%；买入线、止损线、启动线都不再列', T('ladder'));
  check(/第 2 笔.*不再买（11 月 23 日已赚到过 15%）/.test(T('tranches')) && !/等收盘/.test(T('tranches')), '持仓表：没买的那两笔写「不再买」，不再挂着「等收盘 ≤ 0.946」', T('tranches'));
  put(path([...W9, 1.10, ...Array(8).fill(1.30), 1.29]));
  check(/卖出线.*1\.298涨不过它就卖/.test(T('ladder')), '卖出线比现价还高：梯子上说「涨不过它就卖」，不说「还要涨」', T('ladder'));
}

console.log('\n● 交易结束的第二天：说「交易已结束」，不再给下一步');
{
  put(path([...DONE, 1.05]));
  check(T('nextHead') === '交易已结束' && /全部卖出 @ 1\.000/.test(T('nextList')) && /交易结束后不自动再来一轮/.test(T('nextList'))
    && /跌破 10 日线/.test(T('nextKick')), `结束：${T('nextKick')}｜${T('nextHead')}｜${T('nextList')}`);
  check(/交易已结束/.test(T('ladder')) && /持有了 14 个交易日/.test(T('due')), `梯子和到期卡：${T('ladder')}｜${T('due')}`);
}

console.log('\n● 数据落后、推送没送达：页面顶上说清楚');
{
  const rows = path([1.06]);
  at(`${AFTER[3]} 10:00:00`);
  put(rows, { run: { asof: AFTER[0], ranAt: `${AFTER[0]} 21:05`, push: { ok: false, reason: '超时' } } });
  check(!el('warn').hidden && /数据还停在 11 月 4 日，之后的 2 个交易日/.test(T('warn')), `过了两个交易日还没更新：${T('warn').slice(0, 70)}`);
  check(/推送没有送达/.test(T('warn')), '推送没送达：提一句 22:35 会补发');
  at(`${AFTER[1]} 20:00:00`);
  put(rows, { run: { asof: AFTER[0], ranAt: `${AFTER[0]} 21:05`, push: { ok: true } } });
  check(el('warn').hidden, '当天 21:05 之前还没更新是正常的：不报落后');
  check(/11 月 5 日已经收盘，21:05 更新之后这里会换成下一步/.test(T('nextNote')), '下一步落在今天、可已经收盘：说明晚上会更新', T('nextNote'));
  fakeNow = null;
}

console.log('\n● 配置坏了：整页停止显示，不硬画');
{
  put(path([1.0]), { cfg: { ...BASE.cfg, weights: [1, 1, 1] } });
  check(/数据异常/.test(T('nextKick')) && /weights/.test(T('nextHead')) && el('ladder').innerHTML === '' && el('chart').innerHTML === '', `报错：${T('nextHead')}`);
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 创业板50 页面全部通过'}\n`);
process.exit(fails ? 1 : 0);
