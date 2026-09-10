/**
 * 文案回归测试：把「下一次操作」卡片、触发横幅、Bark 推送的每一种状态都跑一遍，
 * 打印出真实生成的句子，并对「会被误解」的写法直接断言拦截。
 *
 * 这个文件跑的是 index.html 里的真代码 —— 把 <script type="module"> 整段抠出来，
 * 配一套极简 DOM 假件后 import 进来，再开一个后门读写模块内部的 S。
 * 不是复刻一份逻辑，所以以后改了渲染函数这里会跟着变，不会悄悄失效。
 *
 * 造场景时账本必须和档位对得上（tier 3 就得真有 0→1→2→3 三笔），
 * 否则重放出来的持仓和档位矛盾，测出来的方向也是假的。
 *
 * 用法：npm run wording（npm test 里也会跑）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const bad = (msg) => { fails++; console.log(`  ✗ ${msg}`); };

/* ---------------- 极简 DOM 假件 ---------------- */
class El {
  constructor(id = '') {
    this.id = id; this._t = ''; this._h = '';
    this.dataset = {}; this.style = {}; this.clientWidth = 880;
    this.classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
  }
  set textContent(v) { this._t = String(v); this._h = ''; }
  get textContent() { return this._h ? this._h.replace(/<br\s*\/?>/g, ' ⏎ ').replace(/<[^>]*>/g, '') : this._t; }
  set innerHTML(v) { this._h = String(v); this._t = ''; }
  get innerHTML() { return this._h; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  appendChild() {}
  insertAdjacentHTML() {}
  querySelectorAll() { return []; }
  addEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 880, height: 300 }; }
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
const store = new Map();

globalThis.document = {
  getElementById: el,
  querySelector: () => el('__q'),
  createElement: () => new El(),
  documentElement: { setAttribute() {}, removeAttribute() {} },
  body: new El('body'),
  addEventListener() {},
};
globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.fetch = async (u) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  try {
    const txt = readFileSync(join(ROOT, rel), 'utf8');
    return { ok: true, json: async () => JSON.parse(txt) };
  } catch { return { ok: false, json: async () => { throw new Error('404 ' + rel); } }; }
};

/* ---------------- 抠出页面模块并装上后门 ---------------- */
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('✗ index.html 里找不到 <script type="module">'); process.exit(1); }
const core = pathToFileURL(join(ROOT, 'shared', 'strategy.js')).href;
const src = m[1].replace('`./shared/strategy.js?v=', `\`${core}?v=`)
  + '\nglobalThis.__H = { get S() { return S; }, set S(v) { S = v; },'
  + ' renderInputDependent, execInfo, behindState, nextMove, LS };\n';
const tmp = join(tmpdir(), `hlma30-wording-${process.pid}.mjs`);
writeFileSync(tmp, src, 'utf8');
await import(pathToFileURL(tmp).href);
await new Promise((r) => setTimeout(r, 60));   // 等 load() 把真实数据读进来

const H = globalThis.__H;
if (!H || !H.S || !H.S.state) { console.log('✗ 页面模块没能加载出数据'); process.exit(1); }
const BASE = JSON.parse(JSON.stringify(H.S.state));
const CAL = H.S.cal;
const ROWS = H.S.series.rows;
const TODAY = (await import(core)).beijingDate();

/* 从日历里挑出能让执行日落在「今天之前 / 正是今天 / 今天之后」的信号日 */
const past = CAL.filter((d) => d < TODAY);
const SIG = {
  today: past[past.length - 1] ?? null,              // 上一个交易日出信号 → 今天执行
  future: CAL.filter((d) => d >= TODAY)[0] ?? null,  // 今天出信号 → 下一个交易日执行
  past: past[past.length - 4] ?? null,               // 几天前出信号 → 执行日已过
  unknown: '2099-01-02',                             // 超出日历 → 算不出执行日
};

/* ---------------- 造场景 ---------------- */
const LAUNCH = ROWS[ROWS.length - 60].d;
const D = (k) => ROWS[ROWS.length - k].d;   // 倒数第 k 个交易日

/** 按给定的档位路径造一份自洽账本：[[倒数第几天, from, to], ...] */
function ledgerFor(path) {
  return {
    schema: 1, launchDate: LAUNCH,
    entries: path.map(([k, from, to], n) => ({
      seq: n + 1, date: D(k), signalDate: D(k + 1),
      side: to > from ? 'BUY' : 'SELL', tierFrom: from, tierTo: to,
      targetWeight: [0, .25, .5, .75, 1][to],
      price: ROWS[ROWS.length - k].c, etfPrice: null, late: false, recordedAt: `${D(k)} 21:00:00`,
    })),
  };
}
const CHAIN = [[40, 0, 1], [30, 1, 2], [20, 2, 3]];   // 0→1→2→3

const idx = BASE.index;
// 让 close 落在买/卖线的某一侧
const at = (ma30, close) => ({
  ma30, close,
  buyTrigger: +(ma30 * 0.97).toFixed(2), sellTrigger: +(ma30 * 1.02).toFixed(2),
  pctToBuy: (ma30 * 0.97 - close) / close * 100,
  pctToSell: (ma30 * 1.02 - close) / close * 100,
  changePct: 0.31,
});
const pend = (sig, from, to) => ({ signalDate: sig, tierFrom: from, tierTo: to, side: to > from ? 'BUY' : 'SELL' });

/** tier / pending / index / ledger 一起换掉，保证账本和档位自洽 */
function put({ tier, pending = null, index, chain = null, calc = null }) {
  const led = ledgerFor(chain ?? CHAIN.slice(0, tier));
  const st = JSON.parse(JSON.stringify(BASE));
  st.launchDate = LAUNCH;
  st.tier = led.entries.length ? led.entries[led.entries.length - 1].tierTo : tier;
  st.pending = pending;
  st.index = { ...idx, ...index };
  H.S = { ...H.S, state: st, ledger: led };
  if (calc) store.set('hlma30.calc', JSON.stringify(calc)); else store.delete('hlma30.calc');
}

const M = 6000;
const SCEN = [
  ['空仓等待买入', { tier: 0, index: at(M, M) }],
  ['半仓等待（买卖都还远）', { tier: 2, index: at(M, M) }],
  ['满仓等待卖出', { tier: 4, index: at(M, M), chain: [[40, 0, 1], [35, 1, 2], [30, 2, 3], [25, 3, 4]] }],
  ['已跌破买入线但还没出挂单', { tier: 1, index: at(M, M * 0.96) }],
  ['已涨破卖出线但还没出挂单', { tier: 3, index: at(M, M * 1.03) }],
  ['挂单·执行日就是今天', { tier: 1, pending: pend(SIG.today, 1, 2), index: at(M, M * 0.96) }],
  ['挂单·执行日在将来', { tier: 1, pending: pend(SIG.future, 1, 2), index: at(M, M * 0.96) }],
  ['挂单·执行日已过', { tier: 1, pending: pend(SIG.past, 1, 2), index: at(M, M * 0.96) }],
  ['挂单·算不出执行日', { tier: 1, pending: pend(SIG.unknown, 1, 2), index: at(M, M * 0.96) }],
  ['挂单·卖出方向', { tier: 3, pending: pend(SIG.today, 3, 2), index: at(M, M * 1.03) }],
  ['挂单·清空到 0 档', { tier: 1, pending: pend(SIG.today, 1, 0), index: at(M, M * 1.03) }],
  ['落后账本·漏做两笔买入', { tier: 2, index: at(M, M), calc: { cash: 1000000, hold: 0 } }],
  ['落后账本·来回三笔只需补一次', {
    tier: 1, index: at(M, M), calc: { cash: 1000000, hold: 0 },
    chain: [[40, 0, 1], [30, 1, 2], [20, 2, 1]],
  }],
  ['实盘超前·账本里没有对应记录', { tier: 0, index: at(M, M), calc: { cash: 500000, hold: 500000 }, chain: [] }],
  ['挂单在身·实盘还落后', { tier: 2, pending: pend(SIG.today, 2, 3), index: at(M, M * 0.96), calc: { cash: 1000000, hold: 0 } }],
];

/* ---------------- 跑 + 断言 ---------------- */
console.log('\n================ 「下一次操作」与触发横幅 ================\n');
store.set('hlma30.principal', '1000000');
for (const [name, over] of SCEN) {
  put(over);
  H.renderInputDependent();
  const line = el('nextLine').textContent.trim();
  const sub = el('nextSub').textContent.trim();
  const kick = el('bKick').textContent.trim();
  const btxt = el('bText').textContent.trim();
  const bsub = el('bSub').textContent.trim();
  const on = el('banner').classList.contains('on');
  const behind = H.behindState();

  console.log(`【${name}】`);
  console.log(`  卡片  ${line}`);
  console.log(`  副行  ${sub}`);
  if (on) { console.log(`  横幅  ${kick}`); console.log(`        ${btxt}`); console.log(`        ${bsub}`); }

  const all = `${line}｜${sub}｜${on ? kick + btxt + bsub : ''}`;
  if (!line) bad(`${name}：卡片主行是空的`);
  for (const junk of ['undefined', 'NaN', 'null', 'Infinity', '[object']) {
    if (all.includes(junk)) bad(`${name}：文案里漏出了 ${junk}`);
  }
  // 拼接必须通顺：旧写法会拼出「9 月 11 日 收盘（执行日已过）买入第 3 份」
  if (/收盘（执行日已过）/.test(all)) bad(`${name}：「执行日已过」插在句子中间，读不通`);
  // 卡片在讲挂单时，横幅不能对同一笔挂单说另一个时点。
  // （卡片在讲「补做」时两者本来就说的不是一件事，不比。）
  if (on && !behind) {
    if (line.startsWith('今天收盘前') !== kick.includes('今天收盘前')) {
      bad(`${name}：卡片「${line.slice(0, 10)}…」与横幅「${kick}」时点对不上`);
    }
    if (line.includes('买入') !== btxt.includes('买入')) {
      bad(`${name}：卡片说${line.includes('买入') ? '买入' : '卖出'}，横幅说${btxt.includes('买入') ? '买入' : '卖出'}`);
    }
  }
  // 说了「N 笔」就得真有 N 笔对得上的记录
  const nb = line.match(/你有 (\d+) 笔/);
  if (nb && (!behind || behind.missed.length !== +nb[1])) {
    bad(`${name}：说了 ${nb[1]} 笔，账本里能对上的却是 ${behind ? behind.missed.length : 0} 笔`);
  }
  // 没有漏做记录时不能凭空说「笔」
  if (behind && !behind.missed.length && /\d+ 笔操作还没做/.test(line)) {
    bad(`${name}：账本里没有漏做记录，却说了「N 笔操作还没做」`);
  }
  // 落后/超前的方向必须和实盘-账本的高低一致
  if (behind && /需一次性(买入|卖出)/.test(line)) {
    const saysBuy = /需一次性买入/.test(line);
    if (saysBuy !== (behind.gap > 0)) bad(`${name}：实盘${behind.gap > 0 ? '低于' : '高于'}账本，却让你${saysBuy ? '买入' : '卖出'}`);
    if (saysBuy !== sub.includes('低于')) bad(`${name}：主行说${saysBuy ? '买入' : '卖出'}，副行说${sub.includes('低于') ? '低于' : '高于'}账本`);
  }
  console.log('');
}

/* ---------------- 推送执行日措辞 ---------------- */
console.log('================ Bark 推送：执行日措辞 ================\n');
const { execWording } = await import(pathToFileURL(join(ROOT, 'worker', 'src', 'index.js')).href);
const nextCalDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const cases = [];
for (const sig of CAL) {
  const exec = CAL.filter((d) => d > sig)[0];
  if (exec) cases.push([sig, exec]);
}
const gap = cases.filter(([s, e]) => e !== nextCalDay(s));
console.log(`日历内 ${cases.length} 个信号日，其中 ${gap.length} 个的执行日不是第二天（周末与节假日）。`);
for (const [sig, exec] of [cases[0], gap[0], gap[gap.length - 1]].filter(Boolean)) {
  const w = execWording(sig, exec);
  console.log(`  信号 ${sig} → 执行 ${exec}\n    标题 …${w.short}\n    正文 ${w.long}`);
}
for (const [sig, exec] of cases) {
  const w = execWording(sig, exec);
  const isTomorrow = exec === nextCalDay(sig);
  if (w.short.includes('明日') !== isTomorrow) bad(`${sig} → ${exec}：「明日」用错了（标题「${w.short}」）`);
  if (!isTomorrow && !w.short.includes(`${+exec.slice(5, 7)} 月 ${+exec.slice(8, 10)} 日`)) {
    bad(`${sig} → ${exec}：不是第二天却没写出日期（标题「${w.short}」）`);
  }
}
const wNull = execWording(TODAY, null);
if (wNull.short.includes('明日')) bad('执行日算不出来时仍写了「明日」');
console.log(`  执行日取不到 → 标题 …${wNull.short}\n    正文 ${wNull.long}`);

console.log(`\n${fails ? `✗ ${fails} 处文案有问题` : '✓ 全部状态文案通过'}\n`);
process.exit(fails ? 1 : 0);
