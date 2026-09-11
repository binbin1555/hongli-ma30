/**
 * 面板测试台：把 index.html 里的 <script type="module"> 整段抠出来，
 * 配一套极简 DOM 假件后 import 进来，再开一个后门读写模块内部的 S。
 *
 * 跑的是真代码，不是复刻一份逻辑 —— 以后改了渲染函数，测试会跟着变，
 * 不会悄悄失效。wording.mjs 和 calculator.mjs 共用这一份。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 极简 DOM 假件 ---------------- */
class El {
  constructor(id = '') {
    this.id = id; this._t = ''; this._h = ''; this.value = '';
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
  // render() 里 renderLedger 要 $('ledger').querySelector('tbody')，
  // 给每个元素挂一个惰性子节点，让整条 render 链在假 DOM 里也能跑通
  querySelector(sel) { return (this._kids ||= {})[sel] ||= new El(sel); }
  addEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 880, height: 300 }; }
}
const els = new Map();
export const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
export const store = new Map();

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
export const CORE_URL = pathToFileURL(join(ROOT, 'shared', 'strategy.js')).href;
const src = m[1].replace('`./shared/strategy.js?v=', `\`${CORE_URL}?v=`)
  + '\nglobalThis.__H = { get S() { return S; }, set S(v) { S = v; },'
  + ' renderInputDependent, render, execInfo, behindState, nextMove, calc, LS };\n';
const tmp = join(tmpdir(), `hlma30-harness-${process.pid}.mjs`);
writeFileSync(tmp, src, 'utf8');
await import(pathToFileURL(tmp).href);
await new Promise((r) => setTimeout(r, 60));   // 等 load() 把真实数据读进来

export const H = globalThis.__H;
if (!H || !H.S || !H.S.state) { console.log('✗ 页面模块没能加载出数据'); process.exit(1); }

export const BASE = JSON.parse(JSON.stringify(H.S.state));
export const CAL = H.S.cal;
export const ROWS = H.S.series.rows;
export const CORE = await import(CORE_URL);
export const TODAY = CORE.beijingDate();

/* ---------------- 造场景 ---------------- */
export const LAUNCH = ROWS[ROWS.length - 60].d;
/** 倒数第 k 个交易日 */
export const D = (k) => ROWS[ROWS.length - k].d;

/** 按给定的档位路径造一份自洽账本：[[倒数第几天, from, to], ...] */
export function ledgerFor(path) {
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
export const CHAIN = [[40, 0, 1], [30, 1, 2], [20, 2, 3]];   // 0→1→2→3

/** 让 close 落在买/卖线的某一侧 */
export const at = (ma30, close) => ({
  ma30, close,
  buyTrigger: +(ma30 * 0.97).toFixed(2), sellTrigger: +(ma30 * 1.02).toFixed(2),
  pctToBuy: (ma30 * 0.97 - close) / close * 100,
  pctToSell: (ma30 * 1.02 - close) / close * 100,
  changePct: 0.31,
});
export const pend = (sig, from, to) => ({
  signalDate: sig, tierFrom: from, tierTo: to, side: to > from ? 'BUY' : 'SELL',
});

/**
 * tier / pending / index / ledger 一起换掉，保证账本和档位自洽。
 * calc 同时写进 localStorage 和两个输入框 —— 页面上这两处永远同步
 * （fillInputs 负责），测试里只写一处会测出假结果。
 */
export function put({ tier, pending = null, index, chain = null, calc = null, etf = undefined }) {
  const led = ledgerFor(chain ?? CHAIN.slice(0, tier));
  const st = JSON.parse(JSON.stringify(BASE));
  st.launchDate = LAUNCH;
  st.tier = led.entries.length ? led.entries[led.entries.length - 1].tierTo : tier;
  st.pending = pending;
  st.index = { ...BASE.index, ...index };
  if (etf !== undefined) st.etf = etf;
  H.S = { ...H.S, state: st, ledger: led };
  if (calc) {
    store.set('hlma30.calc', JSON.stringify(calc));
    el('inCash').value = String(calc.cash);
    el('inHold').value = String(calc.hold);
  } else {
    store.delete('hlma30.calc');
    el('inCash').value = '';
    el('inHold').value = '';
  }
}

/** 从日历里挑出让执行日落在「今天之前 / 正是今天 / 今天之后」的信号日 */
const pastDays = CAL.filter((d) => d < TODAY);
export const SIG = {
  today: pastDays[pastDays.length - 1] ?? null,      // 上一个交易日出信号 → 今天执行
  future: CAL.filter((d) => d >= TODAY)[0] ?? null,  // 今天出信号 → 下一个交易日执行
  past: pastDays[pastDays.length - 4] ?? null,       // 几天前出信号 → 执行日已过
  unknown: '2099-01-02',                             // 超出日历 → 算不出执行日
};
