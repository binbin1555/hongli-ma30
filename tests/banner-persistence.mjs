/**
 * 一条铁律：没点按钮，横幅就不许消失。
 *
 * 这份不挑场景，用真实行情连跑上百个交易日，中途一次都不点，
 * 每天收盘后刷新一次页面，核对「账上该有几笔没确认」和「屏幕上摆着几笔」
 * 是否始终相等 —— 少一笔就算违约，并指出是哪一天、哪一笔没了。
 *
 * 另外单独验几种「不是靠点击、而是靠出事」让横幅消失的路径。
 *
 * 用法：npm run persist
 */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

const { H, el, store, ROWS, CAL, CORE, banners } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, WEIGHTS, MA_LEN, posPct } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const PRINCIPAL = 1000000, ETF = 1.46;
const START = 60;                     // 从第 60 个交易日起跑，前面留足均线窗口
const DAYS = 160;                     // 跑多少个交易日
const LAUNCH = ROWS[START - 1].d;

function workerDay(idx, prev, ledger) {
  const closes = ROWS.slice(0, idx + 1).map((r) => r.c);
  const close = closes[closes.length - 1], ma30 = ma(closes, MA_LEN), today = ROWS[idx].d;
  let tier = prev.tier;
  if (prev.pending && prev.pending.signalDate < today) {
    const p = prev.pending;
    ledger.entries.push({ seq: ledger.entries.length + 1, date: today, signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL', tierFrom: p.tierFrom, tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo], price: close, etfPrice: ETF, late: false,
      recordedAt: `${today} 21:00:45` });
    tier = p.tierTo;
  }
  const want = nextTier(tier, signal(close, ma30));
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' } : null;
  const tg = triggers(close, ma30);
  return { pending, state: {
    schema: 1, launchDate: LAUNCH, asof: today, lastRun: `${today} 21:00:45`, tier, pending,
    index: { code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: 0, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
    bond: { code: '008204', close: ROWS[idx].b },
    etf: { code: '515180', close: ETF, asof: today, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${today} 21:00:45` },
  } };
}

let SERVE = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const rel = String(u).split('?')[0].replace(/^\.\//, '');
  if (SERVE && rel in SERVE) return { ok: true, json: async () => SERVE[rel] };
  return realFetch(u, o);
};
const refresh = async (d, t) => { goto(d, t); await H.load(); };

/** 屏幕上到底摆着几笔：单独成条的 + 汇总条里数的 */
function onScreen() {
  const bs = banners();
  const roll = bs.find((b) => /还有 \d+ 笔没确认/.test(b.text));
  const rolled = roll ? +roll.text.match(/还有 (\d+) 笔/)[1] : 0;
  return { single: bs.filter((b) => b !== roll), rolled, total: bs.filter((b) => b !== roll).length + rolled };
}

store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
const serveWith = (st) => { SERVE = {
  'data/state.json': st, 'data/ledger.json': JSON.parse(JSON.stringify(ledger)),
  'data/series.json': { rows: ROWS }, 'calendar/2026.json': { year: 2026, tradingDays: CAL },
  'calendar/2025.json': { year: 2025, tradingDays: CAL } }; };

/* ================= 一、连跑 160 个交易日，一次都不点 ================= */
console.log(`\n【一】从 ${ROWS[START].d} 起连跑 ${DAYS} 个交易日，全程一次都不点按钮`);
let prev = { tier: 0, pending: null };
let peak = 0, firstLoss = null, triggers_n = 0;
for (let k = 0; k < DAYS; k++) {
  const idx = START + k;
  if (!ROWS[idx]) break;
  const d = workerDay(idx, prev, ledger);
  prev = d.state;
  serveWith(d.state);
  await refresh(ROWS[idx].d, '21:30');

  // 该有几笔没确认：待办 + 账本里每一笔，去重按信号日
  const want = new Set(ledger.entries.map((e) => e.signalDate));
  if (d.state.pending) want.add(d.state.pending.signalDate);
  const got = onScreen();
  if (want.size > triggers_n) triggers_n = want.size;
  if (got.total !== want.size && !firstLoss) {
    firstLoss = { day: ROWS[idx].d, want: want.size, got: got.total,
      missing: [...want].filter((s) => !got.single.some((b) => b.sub.includes(s) || b.kick.includes(s))) };
  }
  if (got.total < peak) {
    if (!firstLoss) firstLoss = { day: ROWS[idx].d, want: want.size, got: got.total, missing: ['数量回退'] };
  }
  peak = Math.max(peak, got.total);
}
console.log(`  期间累计触发 ${triggers_n} 笔，账本记了 ${ledger.entries.length} 笔，最终屏幕上摆着 ${onScreen().total} 笔`);
if (firstLoss) {
  bad(`${firstLoss.day} 这天，该有 ${firstLoss.want} 笔没确认，屏幕上只剩 ${firstLoss.got} 笔`);
} else if (triggers_n === 0) {
  bad('这段行情一次都没触发，等于没验 —— 换个区间');
} else {
  ok(`${triggers_n} 笔全程一笔不少，没有任何一笔在没点击的情况下消失`);
}

/* ================= 二、跨度拉到极限：一年不打开，再打开 ================= */
console.log('\n【二】攒了一堆之后隔很久才打开，还在不在');
const lastDay = ROWS[Math.min(START + DAYS - 1, ROWS.length - 1)].d;
const farLater = ROWS[ROWS.length - 1].d;
await refresh(farLater, '10:00');
const far = onScreen();
console.log(`  最后一个交易日是 ${lastDay}，隔到 ${farLater} 才打开：屏幕上 ${far.total} 笔`);
if (far.total !== triggers_n) bad(`隔久了再打开变成 ${far.total} 笔，本该还是 ${triggers_n} 笔`);
else ok('时间跨度再大也不掉，它不看「过期与否」，只看你点没点');

/* ================= 三、攒太多时的汇总条，有没有把人吃掉 ================= */
console.log('\n【三】超过 5 笔时并成汇总条 —— 汇总条本身也得摆在明面上、可点');
const bs3 = banners();
const roll = bs3.find((b) => /还有 \d+ 笔没确认/.test(b.text));
console.log(`  单独成条 ${far.single.length} 笔，汇总条 ${far.rolled} 笔`);
if (far.total > 5) {
  if (!roll) bad(`超过 5 笔却没有汇总条，多出来的 ${far.total - far.single.length} 笔无处可寻`);
  else if (!roll.btn || !roll.btn.textContent) bad('汇总条没有按钮 —— 那些笔就永远确认不掉');
  else ok(`汇总条在，写着「${roll.text}」，按钮「${roll.btn.textContent}」`);
} else {
  console.log('  （这段行情没攒够 5 笔，汇总条没出场）');
}

/* ================= 四、不是靠点击，而是靠出事让它消失 ================= */
console.log('\n【四】渲染中途出错时，横幅会不会被整片抹掉');
{
  const before = onScreen().total;
  // 往账本里塞一笔坏记录：日期字段是坏的，看 dayLabel 会不会把整条渲染链带崩
  const dirty = JSON.parse(JSON.stringify(ledger));
  dirty.entries.push({ seq: 999, date: null, signalDate: null, side: 'BUY',
    tierFrom: 0, tierTo: 1, targetWeight: 0.25, price: 1, etfPrice: 1, late: false, recordedAt: null });
  SERVE['data/ledger.json'] = dirty;
  let threw = null;
  try { await refresh(farLater, '10:05'); } catch (e) { threw = e; }
  const after = onScreen().total;
  const notice = banners().find((b) => /读不出来|数据有问题/.test(`${b.text}${b.kick}`));
  console.log(`  塞进一笔坏记录后：渲染${threw ? '抛错 ' + threw.message.slice(0, 40) : '没抛错'}，屏幕上 ${after} 笔（之前 ${before} 笔）`);
  console.log(`  坏记录有没有被摆出来：${notice ? `有，写着「${notice.text}」` : '没有'}`);
  if (after < before) bad(`一笔坏数据让屏幕上少了 ${before - after} 笔 —— 没点按钮却消失了`);
  // 只是「没带走别人」还不够：坏掉的那一笔本身也不许被悄悄吞掉，
  // 否则它就是一笔你永远不知道存在过的操作。
  else if (!notice) bad('坏记录被无声吞掉了 —— 没有任何一条横幅提到它');
  else ok('坏数据没带走已有的横幅，它自己也被明着摆出来');
}

/* ================= 五、同一信号日出现两次，会不会一点收两条 ================= */
console.log('\n【五】账本里万一有两笔信号日相同的记录，点一条会不会连带收掉另一条');
{
  const dup = JSON.parse(JSON.stringify(ledger));
  if (dup.entries.length >= 1) {
    const e0 = dup.entries[dup.entries.length - 1];
    dup.entries.push({ ...e0, seq: e0.seq + 1, date: e0.date });   // 同一个 signalDate
    SERVE['data/ledger.json'] = dup;
    await refresh(farLater, '10:10');
    const b = onScreen();
    const sameSig = b.single.filter((x) => x.kick.includes(dayLabelMd(e0.date)));
    const warn = banners().find((x) => /账本里有重复记录/.test(x.text));
    console.log(`  信号日 ${e0.signalDate} 现在有 2 笔记录，屏幕上与之对应的操作条：${sameSig.length} 条`);
    console.log(`  重复警告条：${warn ? `在，写着「${warn.text}」` : '没有'}`);
    // 一天最多走一档，同一信号日出现两笔就是账本坏了。
    // 正确做法是合成一条 + 明着报警，而不是排两条共用一个确认标记 ——
    // 那样点一条会连带收掉另一条，在你眼里就是「没点的那条自己没了」。
    if (sameSig.length !== 1) bad(`同一信号日排了 ${sameSig.length} 条，它们共用一个确认标记，点一条会连带收掉别条`);
    else if (!warn) bad('重复记录被悄悄合并了，却没有任何提示 —— 等于把一笔吞掉');
    else {
      const n0 = onScreen().total;
      sameSig[0].btn.click();
      const n1 = onScreen().total;
      console.log(`  点掉那条操作后：${n0} → ${n1} 笔（警告条应当还在）`);
      if (n0 - n1 !== 1) bad(`点一条却少了 ${n0 - n1} 条`);
      else if (!banners().some((x) => /账本里有重复记录/.test(x.text))) bad('点完操作条，重复警告也跟着没了');
      else ok('合成一条 + 明着报警；点掉操作条只少一条，警告仍在');
    }
  }
}
function dayLabelMd(d) { return `${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日`; }

console.log(`\n${fails ? `✗ ${fails} 处不满足「不点就不消失」` : '✓ 没点按钮的横幅，在任何时间跨度下都不会自己消失'}\n`);
process.exitCode = fails ? 1 : 0;
