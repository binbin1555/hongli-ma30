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

/* ================================================================
 * 相对时间词的硬规矩
 *
 * 「明日」在周五是错的，「今天」在一张放了一夜的页面上是错的，
 * 「下一个交易日」不看日历根本不知道是哪天。所以定死一条规矩：
 *
 *   凡出现相对时间词的那一句，要么同句给出具体日期，
 *   要么明说「给不出具体日期」。
 *
 * 下面既扫渲染出来的真句子，也扫源码里的字符串字面量 ——
 * 前者管已经跑到的分支，后者管那些平时跑不到的告警。
 * ================================================================ */
const RELATIVE = /今天|今日|明天|明日|昨天|昨日|当晚|次日|下一?个交易日/g;
const HAS_DATE = /\d+\s*月\s*\d+\s*日|\d{4}-\d{2}-\d{2}/;
/** 括号里紧跟在日期后面的相对词是允许的：那是定位，不是信息 */
const stripParen = (t) => t.replace(/(\d+\s*月\s*\d+\s*日)（[^）]*）/g, '$1');

/** @returns 违规的句子；空数组表示全部合规 */
function relativeOffenders(text) {
  const out = [];
  for (const seg of stripParen(String(text)).split(/[。；\n]|⏎/)) {
    if (!seg.trim()) continue;
    RELATIVE.lastIndex = 0;
    const hit = seg.match(RELATIVE);
    if (!hit) continue;
    // 同句有日期，或同句明说「给不出具体日期」，都算合规
    if (HAS_DATE.test(seg) || seg.includes('具体日期')) continue;
    out.push(`${hit.join('/')} → 「${seg.trim()}」`);
  }
  return out;
}

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
  // 每一处相对时间词都必须挨着具体日期
  for (const o of relativeOffenders(all)) bad(`${name}：相对时间词旁边没有日期 —— ${o}`);
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
  const md = `${+exec.slice(5, 7)} 月 ${+exec.slice(8, 10)} 日`;
  // 规矩一：执行日的具体日期永远要出现在标题里，一个都不能少
  if (!w.short.includes(md)) bad(`${sig} → ${exec}：标题里没有具体日期（「${w.short}」）`);
  // 规矩二：相对词只许待在日期后面的括号里
  for (const o of relativeOffenders(`${w.short}。${w.long}`)) {
    bad(`${sig} → ${exec}：相对时间词旁边没有日期 —— ${o}`);
  }
  // 规矩三：只有执行日确实是第二天时，括注里才准出现「明天」
  const isTomorrow = exec === nextCalDay(sig);
  if (w.short.includes('明天') !== isTomorrow) {
    bad(`${sig} → ${exec}：「明天」这个括注用错了（「${w.short}」）`);
  }
}
const wNull = execWording(TODAY, null);
if (/明天|明日/.test(wNull.short)) bad('执行日算不出来时仍写了「明天」');
if (!wNull.short.includes('具体日期')) bad('执行日算不出来时没有明说「给不出具体日期」');
for (const o of relativeOffenders(`${wNull.short}。${wNull.long}`)) bad(`执行日取不到：${o}`);
console.log(`  执行日取不到 → 标题 …${wNull.short}\n    正文 ${wNull.long}`);

/* ---------------- 源码静态扫描 ---------------- */
/*
 * 上面那 15 个场景跑不到告警分支（交易日历取不到、数据未到、明年日历没发布……），
 * 而那些恰恰是最容易留下「今日」「明日」的地方 —— 平时不出现，出事那天才亮相，
 * 亮相时又正是你最需要看懂它的时候。所以直接扫源码里的字符串字面量。
 *
 * 判定放宽一点：只要那一行带了插值（说明日期是算出来的），或者明说
 * 「给不出具体日期」，就算合规；纯写死的相对词一律揪出来。
 */
console.log('\n================ 源码里的写死相对词 ================\n');
{
  const stripComment = (ln) => ln
    .replace(/^\s*(\/\/|\*|\/\*).*$/, '')          // 整行注释
    .replace(/(?<!:)\/\/.*$/, '');                  // 行尾注释（别误伤 https://）
  let scanned = 0;
  for (const f of ['worker/src/index.js', 'index.html']) {
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((raw, k) => {
      const ln = stripComment(raw);
      if (!ln.trim()) return;
      RELATIVE.lastIndex = 0;
      const hit = ln.match(RELATIVE);
      if (!hit) return;
      scanned++;
      const excused = ln.includes('${') || ln.includes('具体日期') || HAS_DATE.test(ln)
        || ln.includes('NO_EXEC_DATE') || ln.includes('RELATIVE');
      if (!excused) bad(`${f}:${k + 1} 写死了相对时间词「${hit.join('/')}」 —— ${ln.trim().slice(0, 72)}`);
    });
  }
  console.log(`  扫过 ${scanned} 行含相对时间词的代码（注释已排除）`);
}

console.log(`\n${fails ? `✗ ${fails} 处文案有问题` : '✓ 全部状态文案通过'}\n`);
process.exit(fails ? 1 : 0);
