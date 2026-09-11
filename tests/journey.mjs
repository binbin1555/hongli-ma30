/**
 * 全流程走查：T 日出信号 → T+1 日按时做 → T+2 日迟到补做。
 *
 * 这三条是日常最可能遇到的路径，所以不摆静态状态，而是**按 Worker 的真实
 * 状态机一天天推进**：执行昨日挂单 → 记账 → 算今日信号 → 生成新挂单，
 * 每一步产出的 state/ledger 和线上写进仓库的是同一个形状。
 *
 * 面板用真代码渲染。为了让「今天」跟着剧本走，整份脚本劫持了 Date.now ——
 * beijingDate(nowMs = Date.now()) 每次调用都会重新取，所以改一次时间，
 * 下一次 render 就活在那一天。
 *
 * 行情用真实历史：2026-05-28 是一次真的买入信号，T+1 是周五、T+2 是周一，
 * 顺带把「迟到 + 跨周末」一起验了。
 *
 * 用法：npm run journey（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ---- 必须在 import harness 之前劫持时间：harness 一加载就会跑 load() ---- */
const REAL_NOW = Date.now();
let FAKE = null;
Date.now = () => (FAKE === null ? REAL_NOW : FAKE);
/** 把「现在」设成北京时间的某天某时 */
const goto = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000;
};

const { H, el, store, ROOT, CORE, ROWS, CAL, fractionsIn, banners } = await import('./harness.mjs');
const { ma, signal, nextTier, triggers, WEIGHTS, MA_LEN, orderAmount, COMMISSION, posPct } = CORE;

let fails = 0;
const bad = (msg) => { fails++; console.log(`    ✗ ${msg}`); };

/*
 * 黑话清单：只有写这套系统的人才懂的词，一个都不许出现在页面上。
 * 半年后回来看的人也包括作者自己 —— 到时候「幽灵行」「档位链」
 * 一样得现想半天。
 *
 * 「挂单」尤其要紧：A 股里它特指去券商挂委托单，而这里指的是
 * 系统自己记下的一笔待办，照字面理解会跑去券商设条件单。
 */
const SLANG = {
  挂单: '在 A 股里特指去券商挂委托单，这里说的是系统记下的待办 —— 用「待执行的操作」',
  幽灵行: '自造词，没人懂 —— 说「重复抄来的假数据」',
  档位链: '自造词 —— 说「交易记录前后连得上」',
  自审: '自造词 —— 直说在查什么',
  对账: '会计术语，这里其实是「能不能对得上」',
  股票腿: '衍生品术语（leg）—— 说「买了红利的那部分」',
  理论口径: '「口径」是统计术语 —— 直说「理论值」',
  '结构：': '开发者写法，标题里不该有冒号分类',
};
function slangIn(text) {
  const hit = [];
  for (const [w, why] of Object.entries(SLANG)) if (String(text).includes(w)) hit.push(`${w}（${why}）`);
  return hit;
}
const ok = (label, v) => console.log(`    · ${label.padEnd(10, '　')} ${v}`);

/* ---------------- 剧本 ---------------- */
const SERIES = JSON.parse(readFileSync(join(ROOT, 'data', 'series.json'), 'utf8')).rows;
const T_DATE = '2026-05-28';
const iT = SERIES.findIndex((r) => r.d === T_DATE);
const [T, T1, T2] = [SERIES[iT].d, SERIES[iT + 1].d, SERIES[iT + 2].d];
const LAUNCH = SERIES[iT - 40].d;
const ETF_PX = 1.46;
const PRINCIPAL = 1000000;

/** 复刻 runDaily 的状态推进：执行昨日挂单 → 记账 → 算今日信号 → 生成新挂单 */
function workerRun(dayIdx, prev, ledger, launchDate = LAUNCH) {
  const upto = SERIES.slice(0, dayIdx + 1);
  const closes = upto.map((r) => r.c);
  const close = closes[closes.length - 1];
  const ma30 = ma(closes, MA_LEN);
  const today = SERIES[dayIdx].d;
  const prevClose = closes[closes.length - 2];

  let tier = prev.tier;
  let executed = null;
  if (prev.pending && prev.pending.signalDate < today) {
    const p = prev.pending;
    executed = {
      seq: ledger.entries.length + 1, date: today, signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL', tierFrom: p.tierFrom, tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo], price: close, etfPrice: ETF_PX, late: false,
      recordedAt: `${today} 21:00:45`,
    };
    ledger.entries.push(executed);
    tier = p.tierTo;
  }
  const sig = signal(close, ma30);
  const want = nextTier(tier, sig);
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' }
    : null;
  const tg = triggers(close, ma30);
  const state = {
    schema: 1, launchDate, asof: today, lastRun: `${today} 21:00:45`, tier, pending,
    index: {
      code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: +((close / prevClose - 1) * 100).toFixed(2),
      buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2),
    },
    bond: { code: 'H11001', close: SERIES[dayIdx].b },
    etf: { code: '515180', close: ETF_PX, asof: today, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${today} 21:00:45` },
  };
  return { state, executed, pending, sig, close, ma30 };
}

/**
 * 页面的 onCalcInput 会先用 num() 清洗再存 localStorage —— 它只留数字和小数点，
 * 负号会被吃掉。测试必须走同一套清洗，否则断言拿原始值去算，
 * 会测出一个现实中不存在的"不一致"。
 */
const cleanCalc = (c) => {
  const f = (v) => Number(String(v).replace(/[^\d.]/g, '')) || 0;
  return { cash: f(c.cash), hold: f(c.hold) };
};

/** 把状态装进面板并渲染 */
function show(state, ledger, calc) {
  if (calc) {
    const cc = cleanCalc(calc);
    store.set('hlma30.calc', JSON.stringify(cc));
    el('inCash').value = String(cc.cash);
    el('inHold').value = String(cc.hold);
  } else {
    store.delete('hlma30.calc');
    el('inCash').value = '';
    el('inHold').value = '';
  }
  H.S = { ...H.S, state: JSON.parse(JSON.stringify(state)), ledger: JSON.parse(JSON.stringify(ledger)) };
  H.render();
}

/** 打印这一刻面板上的全部操作相关文字 */
function panel() {
  const bs = banners();
  const on = bs.length > 0;
  const out = {
    横幅: on ? bs.map((b) => `${b.kick}｜${b.text}`).join(' ∥ ') : null,
    // 最上面那条才是「眼下要做的那笔」。下面几条是早先记过账、等你回头确认的，
    // 它们的方向和日期本来就可能和挂单不同 —— 拿它们去比一致性是冤枉人。
    横幅首: on ? `${bs[0].kick}｜${bs[0].text}` : null,
    卡片: el('nextLine').textContent.trim(),
    卡片副: el('nextSub').textContent.trim(),
    仓位: el('tierNum').textContent.trim(),
    算主: el('oMain').textContent.trim(),
    算副: el('oSub').textContent.trim(),
    时点: el('timing').textContent.trim(),
    落差: el('mismatch').hidden === true ? null : el('mismatch').textContent.trim(),
  };
  for (const [k, v] of Object.entries(out)) if (v) console.log(`    ${k.padEnd(5, '　')} ${v}`);
  return out;
}

/** 目标市值法独立验算（不复用 calcCatchUp） */
function want(cash, hold, tier) {
  const S = cash + hold, V = hold, w = WEIGHTS[tier], c = COMMISSION;
  const t = w * S;
  if (Math.abs(t - V) < 0.005) return { side: 'NONE', amount: 0 };
  return t > V ? { side: 'BUY', amount: (t - V) / (1 + w * c) }
    : { side: 'SELL', amount: (V - t) / (1 - w * c) };
}
const shown = (s) => Number((s.match(/([\d,]+) 元/) || [])[1]?.replace(/,/g, ''));

/*
 * 多角度矩阵：把「面板此刻必须说什么」写成一个独立判据，
 * 然后拿真实历史里各种信号组合 × 各种用户行为去撞它。
 *
 * 判据完全不看被测代码怎么算的 —— 只从「账本档位 / 实盘档位 / 挂单 / 今天」
 * 这四个事实推导出应该显示什么，再去对照真实渲染出来的字。
 */
const CALJ = JSON.parse(readFileSync(join(ROOT, 'calendar', '2026.json'), 'utf8')).tradingDays;
const nearest = (cash, hold) => {
  const tot = cash + hold;
  if (!(tot > 0)) return null;
  const w = hold / tot;
  let t = 0, best = Infinity;
  WEIGHTS.forEach((x, k) => { const d = Math.abs(x - w); if (d < best) { best = d; t = k; } });
  return t;
};

/** 面板在这一刻必须满足的全部规则 */
function verify(tag, state, ledger, calc, todayStr) {
  const p = panel();
  const all = `${p.卡片}｜${p.卡片副}｜${p.算主}｜${p.算副}｜${p.时点}｜${p.横幅 || ''}｜${p.落差 || ''}`;
  const say = (m) => bad(`[${tag}] ${m}`);

  // ── 独立推导「真相」──
  const ledgerTier = state.tier;
  const pend = state.pending;
  const userTier = calc ? nearest(calc.cash, calc.hold) : ledgerTier;
  // 不算欠账的两种情形：实盘对上账本，或已经做到挂单的落点（提前做完）
  const onTarget = calc && (userTier === ledgerTier || (pend && userTier === pend.tierTo));
  const owed = calc && !onTarget ? ledgerTier - userTier : 0;
  const target = pend ? pend.tierTo : ledgerTier;
  const execDay = pend ? CALJ.filter((d) => d > pend.signalDate)[0] : null;

  // 1. 仓位卡片必须等于账本档位
  if (p.仓位 !== posPct(ledgerTier)) say(`仓位卡片「${p.仓位}」，账本是 ${posPct(ledgerTier)}`);

  // 2. 欠账提示当且仅当实盘档位 ≠ 账本档位
  const scolds = /你有 \d+ 笔操作还没做|你还欠着|实盘仓位和账本对不上|你填的实盘仓位和账本对不上|补齐到/.test(all);
  if (scolds !== (owed !== 0)) {
    say(owed === 0
      ? `实盘 ${posPct(userTier)} 已在应有位置（账本 ${posPct(ledgerTier)}${pend ? `，挂单去 ${posPct(pend.tierTo)}` : ''}），却提示欠账`
      : `实盘 ${posPct(userTier)} 与账本 ${posPct(ledgerTier)} 不符，却没提示`);
  }

  // 3. 落差框只允许在实盘≠账本时出现
  if (p.落差 && owed === 0) say(`实盘与账本一致，落差框仍出现：「${p.落差.slice(0, 36)}…」`);

  // 4. 有挂单且不欠账 → 卡片必须写出执行日期；执行日就是今天时必须说「今天」
  if (pend && owed === 0) {
    if (execDay) {
      const md = `${+execDay.slice(5, 7)} 月 ${+execDay.slice(8, 10)} 日`;
      if (!p.卡片.includes(md)) say(`挂单执行日是 ${execDay}，卡片没写出来：「${p.卡片}」`);
      const isToday = execDay === todayStr;
      if (p.卡片.includes('（今天') !== isToday) {
        say(`执行日 ${execDay}，今天 ${todayStr}，卡片${isToday ? '没说' : '却说'}「今天」：「${p.卡片}」`);
      }
      if (p.横幅首 && p.横幅首.includes('（今天') !== isToday) say(`横幅与卡片的「今天」不一致：「${p.横幅首}」`);
    }
    if (calc && userTier === pend.tierTo) {
      if (!/已经做到位/.test(p.时点)) say(`已提前做到位，时点行还在催「${p.时点.slice(0, 26)}…」`);
    } else if (!p.时点.includes('尾盘')) {
      say(`有挂单却没给尾盘提示：「${p.时点}」`);
    }
  }

  // 5. 无挂单且不欠账 → 回到预估态
  if (!pend && owed === 0 && calc) {
    if (!p.算主.includes('预估')) say(`没有挂单，计算器主行却没标「预估」：「${p.算主}」`);
    if (!/距离下一次|已跌破|已涨破|算不出/.test(p.卡片)) say(`没有挂单，卡片却不是等待态：「${p.卡片}」`);
  }

  // 6. 金额必须等于目标市值法独立算出的值。
  //    注意目标分三种：有待执行的操作 → 它的落点；欠账 → 补齐到同一处；
  //    两者都没有 → 计算器显示的是「下次触发时」的预估，目标是 nextMove 的落点。
  let amtTarget = target;
  if (!pend && owed === 0) {
    const mv2 = CORE.nextMove(state.index, ledgerTier, null);
    amtTarget = mv2 && mv2.tierTo != null ? mv2.tierTo : null;
  }
  if (calc && calc.cash + calc.hold > 0 && amtTarget != null) {
    const w = want(calc.cash, calc.hold, amtTarget);
    if (w.side !== 'NONE') {
      const g = shown(p.算主);
      if (!isFinite(g)) {
        if (!/已满仓|已空仓|先填/.test(p.算主)) say(`主行读不出金额：「${p.算主}」`);
      } else {
        if (Math.abs(g - w.amount) > 1) say(`金额 ${g}，公式算出 ${Math.round(w.amount)}（目标 ${posPct(amtTarget)}）`);
        const saysBuy = p.算主.includes('买入');
        if (saysBuy !== (w.side === 'BUY')) say(`方向：显示${saysBuy ? '买入' : '卖出'}，应为${w.side === 'BUY' ? '买入' : '卖出'}`);
      }
    }
  }

  // 6b. 卡片和横幅说的买卖方向，必须和它自己印出来的仓位箭头一致。
  //     「仓位 50% → 25%」配「买入第 1 份」是自相矛盾，读的人只会懵。
  if (pend && owed === 0) {
    const arrowBuy = pend.tierTo > pend.tierFrom;
    for (const [where, txt] of [['卡片', p.卡片], ['横幅', p.横幅首]]) {
      if (!txt) continue;
      if (/买入第/.test(txt) && !arrowBuy) say(`${where}说「买入」，但仓位是 ${posPct(pend.tierFrom)} → ${posPct(pend.tierTo)}：「${txt}」`);
      if (/卖出第/.test(txt) && arrowBuy) say(`${where}说「卖出」，但仓位是 ${posPct(pend.tierFrom)} → ${posPct(pend.tierTo)}：「${txt}」`);
    }
  }

  // 6c. 不许出现金额为 0 的操作指令 —— 「卖出第 1 份 0 元」是句没有意义的话
  if (/(买入|卖出)[^，。]*\s0 元/.test(p.算主)) say(`计算器给出 0 元的操作指令：「${p.算主}」`);

  // 6d. 已经做到挂单落点的人，绝不能被劝去反向操作
  if (pend && calc && userTier === pend.tierTo) {
    if (scolds) say(`已提前做到挂单落点 ${posPct(pend.tierTo)}，却被提示欠账/补齐：「${p.卡片}」`);
    if (p.落差) say(`已提前做到位，落差框却让人反向操作：「${p.落差.slice(0, 40)}…」`);
  }

  // 6e. 没有金额可算时，不许指着不存在的数字说「这就是本次要执行的金额」
  if (/先填可用资金|两栏加起来要大于 0/.test(p.算主 + p.算副)
      && /这就是本次要执行的金额/.test(p.时点)) {
    say(`计算器还没有数字（「${p.算主}」），时点行却说「这就是本次要执行的金额」`);
  }

  // 7. 封顶封底：满仓不提买入，空仓不提卖出
  if (ledgerTier >= 4 && !pend && /距离下一次买入/.test(p.卡片)) say('已满仓却提示还要买入');
  if (ledgerTier <= 0 && !pend && /距离下一次卖出/.test(p.卡片)) say('已空仓却提示还要卖出');

  // 7b. 这几个元素是用 textContent 写的，塞标签进去会把 <b> 原样印在页面上
  const tagChecks = [['计算器主行', el('oMain').textContent], ['仓位卡片', el('tierNum').textContent],
    ...banners().flatMap((b, k) => [[`第${k + 1}条横幅大字`, b.text], [`第${k + 1}条横幅顶行`, b.kick]])];
  for (const [nm, t] of tagChecks) {
    if (/<[a-zA-Z/]/.test(t)) say(`${nm}里漏出了 HTML 标签（该元素用 textContent 写）：「${t.slice(0, 48)}」`);
  }

  // 7c. 一手 100 股，金额和股数差得大时必须把实际花费括出来 ——
  //     小本金下「买入 250 元　约 100 股」实际只花 146 元，差 41%
  {
    const px0 = state.etf && state.etf.close;
    const mm = p.算主.match(/([\d,]+) 元　约 ([\d,]+) 股/);
    if (px0 && mm) {
      const amt = Number(mm[1].replace(/,/g, '')), shs = Number(mm[2].replace(/,/g, ''));
      const off = Math.abs(shs * px0 - amt) / amt;
      if (off > 0.02 && !/实际约/.test(p.算主)) {
        say(`金额 ${amt} 元与 ${shs} 股（实值 ${Math.round(shs * px0)} 元）差 ${(off * 100).toFixed(0)}%，却没括出实际花费：「${p.算主}」`);
      }
    }
  }

  // 7d. 算不出执行日时，句子不能断成「需在 执行日待定收盘前完成」
  if (/需在\s*执行日待定|执行日待定收盘前/.test(p.时点)) {
    say(`算不出执行日时句子断了：「${p.时点.slice(0, 40)}…」`);
  }

  // 8. 通用红线
  for (const h of slangIn(all)) say(`文案里出现黑话：${h}`);
  const fr = fractionsIn(all);
  if (fr.length) say(`出现分数「${fr.join('、')}」`);
  for (const m of all.matchAll(/还需[跌涨] (-?[\d.]+)%/g)) {
    if (Number(m[1]) < 0) say(`出现负百分比「${m[0]}」`);
  }
  for (const junk of ['undefined', 'NaN', 'null', 'Infinity']) {
    if (all.includes(junk)) say(`文案里漏出 ${junk}`);
  }
  return p;
}


/** 抓推送文案 */
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opt) => {
  if (String(u).includes('api.day.app')) {
    pushes.push(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ code: 200 }) };
  }
  return realFetch(u, opt);
};
const { pushDaily } = await import(`file://${join(ROOT, 'worker', 'src', 'index.js').replace(/\\/g, '/')}`);
const ENV = { BARK_KEY: 'x', ETF_CODE: '515180', PAGES_URL: 'https://example.invalid/' };
async function push(args) {
  pushes.length = 0;
  await pushDaily(ENV, args);
  for (const p of pushes) console.log(`    📱 ${p.title}\n       ${p.body.replace(/\n/g, '\n       ')}`);
  return pushes.slice();
}

store.set('hlma30.principal', String(PRINCIPAL));
const ledger = { schema: 1, launchDate: LAUNCH, entries: [] };
let st = { tier: 0, pending: null };

console.log(`\n剧本：本金 ${PRINCIPAL.toLocaleString('en-US')}　空仓起步　行情用真实历史`);
console.log(`  T = ${T}　T+1 = ${T1}　T+2 = ${T2}（T+1 是周五，T+2 是下周一）\n`);

/* ==================================================================== */
console.log('═════════════ T 日 ' + T + '：出信号 ═════════════\n');
const r0 = workerRun(iT, st, ledger);
st = r0.state;
console.log(`  21:00 Worker：收盘 ${r0.close.toFixed(2)}　MA30 ${r0.ma30.toFixed(2)}　买入线 ${st.index.buyTrigger}　信号 ${r0.sig}`);
console.log(`         挂单 ${r0.pending ? `${posPct(r0.pending.tierFrom)} → ${posPct(r0.pending.tierTo)}，执行日应为 ${T1}` : '无'}\n`);
if (!r0.pending) bad('T 日没生成挂单，剧本前提就不成立');

console.log('  ── 推送 ──');
await push({ today: T, newState: st, pending: r0.pending, execDay: T1, executed: null, plan: null, etf: st.etf, checks: [], late: false });

console.log('\n  ── 21:05 用户收到推送，点开面板（还没填过任何数字）──');
goto(T, '21:05');
show(st, ledger, null);
const pT = panel();
if (!pT.横幅) bad('T 日晚上没有触发横幅');
if (!pT.卡片.includes(`${+T1.slice(5, 7)} 月 ${+T1.slice(8, 10)} 日`)) bad(`T 日卡片没写出执行日 ${T1}：「${pT.卡片}」`);
if (/今天/.test(pT.卡片)) bad(`T 日卡片说「今天」，但执行日是 ${T1}：「${pT.卡片}」`);
if (pT.落差) bad(`T 日还没到执行日，落差框不该出现：「${pT.落差}」`);
if (/欠着|还没做/.test(pT.时点)) bad(`T 日被说成欠账：「${pT.时点}」`);

/* ==================================================================== */
console.log('\n\n═════════════ T+1 日 ' + T1 + '：按时操作 ═════════════\n');
console.log('  ── 10:00 盘中打开面板 ──');
goto(T1, '10:00');
show(st, ledger, null);
const p1 = panel();
if (!/今天/.test(p1.卡片)) bad(`T+1 当天卡片没说「今天」：「${p1.卡片}」`);
if (!p1.横幅.includes('今天')) bad(`T+1 横幅和卡片时点不一致：「${p1.横幅}」`);
if (p1.落差) bad(`T+1 当天做就是准时，落差框不该出现：「${p1.落差}」`);
if (/欠着|还没做/.test(p1.时点)) bad(`T+1 当天被说成欠账：「${p1.时点}」`);
if (!p1.时点.includes('尾盘')) bad('T+1 没给尾盘提示');

console.log('\n  ── 用户按面板填入真实持仓（还没买，全是现金）──');
const cash0 = PRINCIPAL;
show(st, ledger, { cash: cash0, hold: 0 });
const p1b = panel();
const w1 = want(cash0, 0, 1);
const got1 = shown(p1b.算主);
console.log(`\n    ✓ 独立验算：补到 ${posPct(1)} 应${w1.side === 'BUY' ? '买入' : '卖出'} ${Math.round(w1.amount).toLocaleString('en-US')} 元`);
if (Math.abs(got1 - w1.amount) > 1) bad(`计算器给 ${got1}，公式算出 ${Math.round(w1.amount)}`);
if (!p1b.算主.includes('买入')) bad(`方向不对：「${p1b.算主}」`);
if (p1b.算主.includes('预估')) bad('有挂单时不该标「预估」');
if (/欠着|补齐/.test(`${p1b.时点}${p1b.算主}`)) bad(`按时操作却提示欠账：「${p1b.时点}」`);

console.log('\n  ── 14:30 盘中提醒推送（跑真的 remind()）──');
goto(T1, '14:30');
{
  // remind() 会去 GitHub 读 calendar / state / series / ledger。
  // 把这些请求接到本地文件和当前剧本上，就能跑真代码而不是手写一段假的。
  const ghFiles = {
    [`calendar/${T1.slice(0, 4)}.json`]: { year: +T1.slice(0, 4), tradingDays: CAL },
    'data/state.json': st,
    'data/series.json': { rows: SERIES },
    'data/ledger.json': ledger,
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('api.day.app')) { pushes.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ code: 200 }) }; }
    if (url.startsWith('https://api.github.com/repos/')) {
      const m = url.match(/\/contents\/([^?]+)/);
      if (m) {
        const f = ghFiles[decodeURIComponent(m[1])];
        if (!f) return { status: 404, ok: false, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(f), 'utf8').toString('base64') }) };
      }
      return { ok: true, status: 200, json: async () => ({ default_branch: 'master' }) };   // 仓库信息
    }
    return prevFetch(u, o);
  };
  const { remind } = await import(pathToFileURL(join(ROOT, 'worker', 'src', 'index.js')).href);
  pushes.length = 0;
  const rr = await remind({ ...ENV, PRINCIPAL: String(PRINCIPAL), GH_OWNER: 'x', GH_REPO: 'y', GITHUB_TOKEN: 'z' });
  globalThis.fetch = prevFetch;
  if (!pushes.length) bad(`[14:30 提醒] 今天正是执行日，却没有推送（返回 ${JSON.stringify(rr)}）`);
  for (const pp of pushes) {
    console.log(`    📱 ${pp.title}`);
    console.log(`       ${pp.body.replace(/\n/g, '\n       ')}`);
    if (!pp.title.includes(`${+T1.slice(5, 7)} 月 ${+T1.slice(8, 10)} 日`)) bad(`[14:30 提醒] 标题里没有今天的日期：「${pp.title}」`);
    if (!pp.body.includes('尾盘')) bad('[14:30 提醒] 没给尾盘提示');
    if (/挂单/.test(`${pp.title}${pp.body}`)) bad('[14:30 提醒] 出现黑话「挂单」');
    for (const h of slangIn(`${pp.title}${pp.body}`)) bad(`[14:30 提醒] 黑话：${h}`);
  }
}

console.log('\n  ── 14:55 用户按计算器的数字下单成交 ──');
const buy1 = want(cash0, 0, 1).amount;
const realHold = Math.floor(buy1 / ETF_PX / 100) * 100 * ETF_PX;   // 100 股取整
const realCash = cash0 - realHold * (1 + COMMISSION);
console.log(`    成交 ${Math.round(realHold).toLocaleString('en-US')} 元（${Math.floor(buy1 / ETF_PX / 100) * 100} 股）`
  + `　余现金 ${Math.round(realCash).toLocaleString('en-US')}`);

console.log('\n  ── 21:00 Worker 记账 ──');
const r1 = workerRun(iT + 1, st, ledger);
st = r1.state;
console.log(`    账本 +1 笔：${r1.executed.date} ${r1.executed.side} ${posPct(r1.executed.tierFrom)}→${posPct(r1.executed.tierTo)}`
  + `　新仓位 ${posPct(st.tier)}　新挂单 ${r1.pending ? '有' : '无'}`);
if (!r1.executed) bad('T+1 晚上没有记账');
if (st.tier !== 1) bad(`T+1 记账后仓位应为 ${posPct(1)}，实际 ${posPct(st.tier)}`);
await push({ today: T1, newState: st, pending: r1.pending, execDay: T2, executed: r1.executed, plan: null, etf: st.etf, checks: [], late: false });

console.log('\n  ── 21:05 用户再打开面板，填入成交后的真实数字 ──');
goto(T1, '21:05');
show(st, ledger, { cash: Math.round(realCash), hold: Math.round(realHold) });
const p1c = panel();
// 记账之后横幅不再自动消失，而是改口追问「你做了吗」——
// 它撑到你亲口确认为止，这样忘了做也不会静悄悄过去
if (!p1c.横幅) bad('这笔已记账但还没确认，横幅该留下来追问一句');
if (p1c.横幅 && !/你做了吗/.test(p1c.横幅)) bad(`记账后横幅没改口追问：「${p1c.横幅}」`);
banners()[0].btn.click();     // 你点了「我做了」
H.render();
if (banners().length) bad('点过「我做了」，横幅仍不收起');
if (/欠着|还没做|对不上|补齐/.test(`${p1c.卡片}${p1c.时点}${p1c.算主}`)) {
  bad(`按时做完了却仍提示欠账：卡片「${p1c.卡片}」时点「${p1c.时点}」`);
}
if (p1c.仓位 !== posPct(1)) bad(`仓位卡片应显示 ${posPct(1)}，实际「${p1c.仓位}」`);
if (p1c.落差) bad(`实盘与账本一致，落差框不该出现：「${p1c.落差}」`);

/* ==================================================================== */
console.log('\n\n═════════════ T+2 日 ' + T2 + '：一切正常的一天 ═════════════\n');
console.log('  设定：T+1 那天已经按时买好了，实盘和账本对得上\n');
{
  const goodCalc = { cash: Math.round(realCash), hold: Math.round(realHold) };

  console.log('  ── 09:00 开盘前扫一眼 ──');
  goto(T2, '09:00');
  show(st, ledger, goodCalc);
  const a = verify('T+2 正常·开盘前', st, ledger, cleanCalc(goodCalc), T2);
  // 上一段已经点过「我做了」，所以这里不该再挂着
  if (a.横幅) bad(`[T+2 正常] 已经确认过的那笔，横幅不该再出现：「${a.横幅}」`);
  if (/欠着|还没做|补齐/.test(`${a.卡片}${a.时点}${a.算主}`)) bad(`[T+2 正常] 一切正常却提示欠账：「${a.卡片}」`);
  if (!/距离下一次/.test(a.卡片)) bad(`[T+2 正常] 该显示等待态，实际「${a.卡片}」`);
  if (!/预估/.test(a.算主)) bad(`[T+2 正常] 没有待执行的操作，计算器该标「预估」：「${a.算主}」`);
  if (!/不需要下单/.test(a.时点)) bad(`[T+2 正常] 没说清今天不用动：「${a.时点}」`);

  console.log('\n  ── 14:30 有没有骚扰推送 ──');
  {
    const ghFiles = {
      [`calendar/${T2.slice(0, 4)}.json`]: { year: +T2.slice(0, 4), tradingDays: CAL },
      'data/state.json': st, 'data/series.json': { rows: SERIES }, 'data/ledger.json': ledger,
    };
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('api.day.app')) { pushes.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ code: 200 }) }; }
      if (url.startsWith('https://api.github.com/repos/')) {
        const mm = url.match(/\/contents\/([^?]+)/);
        if (mm) {
          const f = ghFiles[decodeURIComponent(mm[1])];
          if (!f) return { status: 404, ok: false, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(f), 'utf8').toString('base64') }) };
        }
        return { ok: true, status: 200, json: async () => ({ default_branch: 'master' }) };
      }
      return prevFetch(u, o);
    };
    const { remind } = await import(pathToFileURL(join(ROOT, 'worker', 'src', 'index.js')).href);
    pushes.length = 0;
    const rr = await remind({ ...ENV, PRINCIPAL: String(PRINCIPAL), GH_OWNER: 'x', GH_REPO: 'y', GITHUB_TOKEN: 'z' });
    globalThis.fetch = prevFetch;
    console.log(`    ${pushes.length ? `📱 推了 ${pushes.length} 条` : '静默（' + (rr.skipped || '') + '）'}`);
    if (pushes.length) bad('[T+2 正常] 没有待执行的操作，14:30 却推了通知 —— 这是骚扰');
  }

  console.log('\n  ── 15:30 收盘后再看一眼 ──');
  goto(T2, '15:30');
  show(st, ledger, goodCalc);
  const b = verify('T+2 正常·收盘后', st, ledger, cleanCalc(goodCalc), T2);
  if (/收盘前.*必须|尾盘/.test(b.时点)) bad(`[T+2 正常] 今天本来就不用操作，却在催下单：「${b.时点}」`);

  console.log('\n  ── 21:00 Worker 跑完当天 ──');
  const rOK = workerRun(iT + 2, st, ledger, ledger.launchDate);
  console.log(`    仓位 ${posPct(rOK.state.tier)}　待执行 ${rOK.pending ? '有' : '无'}　账本 ${ledger.entries.length} 笔`);
  const T3ok = SERIES[iT + 3].d;
  await push({ today: T2, newState: rOK.state, pending: rOK.pending, execDay: T3ok,
    executed: rOK.executed, plan: null, etf: rOK.state.etf, checks: [], late: false });

  console.log('\n  ── 21:05 当晚最后看一眼 ──');
  goto(T2, '21:05');
  show(rOK.state, ledger, goodCalc);
  const c = verify('T+2 正常·当晚', rOK.state, ledger, cleanCalc(goodCalc), T2);
  if (/欠着|还没做|补齐/.test(`${c.卡片}${c.时点}${c.算主}`)) bad(`[T+2 正常] 当晚仍提示欠账：「${c.卡片}」`);
}

/* ==================================================================== */
console.log('\n\n═════════════ T+2 日 ' + T2 + '：迟到一天的情形 ═════════════\n');
console.log('  设定：T+1 那天忘了下单，账本已在 T+1 晚记了账，实盘仍是空仓\n');
console.log('  ── 10:00 打开面板，先不填数字 ──');
goto(T2, '10:00');
show(st, ledger, null);
const p2 = panel();
if (p2.落差) bad(`没填数字时系统无从判断，不该弹落差框：「${p2.落差}」`);
if (/欠着|还没做/.test(p2.时点)) bad(`没填数字就说欠账：「${p2.时点}」`);

console.log('\n  ── 填入真实持仓（还是空仓，因为昨天忘了做）──');
show(st, ledger, { cash: cash0, hold: 0 });
const p2b = panel();
const w2 = want(cash0, 0, 1);
const got2 = shown(p2b.算主);
console.log(`\n    ✓ 独立验算：补到 ${posPct(1)} 应买入 ${Math.round(w2.amount).toLocaleString('en-US')} 元`);
if (Math.abs(got2 - w2.amount) > 1) bad(`补做金额给 ${got2}，公式算出 ${Math.round(w2.amount)}`);
if (!/欠着|还没做/.test(`${p2b.卡片}${p2b.时点}`)) bad(`迟到了却没提示欠账：卡片「${p2b.卡片}」时点「${p2b.时点}」`);
if (!p2b.卡片.includes('1 笔')) bad(`应说欠 1 笔：「${p2b.卡片}」`);
if (!/补齐到/.test(p2b.算主)) bad(`计算器主行应提示补齐：「${p2b.算主}」`);

console.log('\n  ── 用户当天尾盘补做 ──');
console.log(`    成交 ${Math.round(realHold).toLocaleString('en-US')} 元`);
console.log('\n  ── 补做后立刻在计算器里更新数字 ──');
show(st, ledger, { cash: Math.round(realCash), hold: Math.round(realHold) });
const p2c = panel();
if (/欠着|还没做|对不上|补齐/.test(`${p2c.卡片}${p2c.时点}${p2c.算主}`)) {
  bad(`补做完了仍提示欠账：卡片「${p2c.卡片}」时点「${p2c.时点}」算主「${p2c.算主}」`);
}
if (p2c.落差) bad(`补做后实盘与账本一致，落差框不该出现：「${p2c.落差}」`);

console.log('\n  ── 21:00 Worker 跑 T+2 ──');
const r2 = workerRun(iT + 2, st, ledger);
console.log(`    仓位 ${posPct(r2.state.tier)}　新挂单 ${r2.pending ? '有' : '无'}　账本共 ${ledger.entries.length} 笔`);
const T3 = SERIES[iT + 3].d;
await push({ today: T2, newState: r2.state, pending: r2.pending, execDay: T3, executed: r2.executed, plan: null, etf: r2.state.etf, checks: [], late: false });

/* ==================================================================== */
/*
 * 「无操作」推送的距离文案 —— 每个交易日都会发一条，读得最多的就是它。
 *
 * pctToBuy 和 pctToSell 的符号约定是相反的（见 triggers）：
 *   pctToBuy  正数 = 收盘已在买入线之下
 *   pctToSell 正数 = 还需再涨这么多
 * 照着卖出侧的写法套到买入侧，判断会整个反过来 —— 曾经就这么错过一次，
 * 在没破线的日子里播报「已跌破买入线」。所以这里按收盘价扫一遍全区间。
 */
console.log('\n═════════════ 每日「无操作」推送的距离文案 ═════════════\n');
{
  const MA = 12000, BUY = MA * 0.97, SELL = MA * 1.02;
  const spots = [
    ['远低于买入线', BUY * 0.95, '已跌破'],
    ['刚好在买入线上', BUY, '已跌破'],
    ['略高于买入线', BUY * 1.001, '还需跌'],
    ['正好等于均线', MA, '还需跌'],
    ['略低于卖出线', SELL * 0.999, '还需跌'],
    ['刚好在卖出线上', SELL, '还需跌'],
    ['远高于卖出线', SELL * 1.05, '还需跌'],
  ];
  for (const [name, close, expectBuy] of spots) {
    const tg = triggers(close, MA);
    const stx = {
      tier: 2,
      index: {
        close: +close.toFixed(2), ma30: MA,
        buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
        pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2),
        changePct: 0,
      },
    };
    const got = await push({
      today: T2, newState: stx, pending: null, execDay: null,
      executed: null, plan: null, etf: null, checks: [], late: false,
    });
    const body = got[0].body;
    const line = body.split('\n').find((l) => /买入线|卖出线|还需/.test(l)) || '';
    console.log(`    收盘 ${Math.round(close).toString().padStart(6)}（买入线 ${Math.round(tg.buyAt)}　卖出线 ${Math.round(tg.sellAt)}）`);
    console.log(`      ${line.trim()}`);

    // 买入侧
    const reallyBelowBuy = close <= tg.buyAt + 1e-9;
    const saysBrokeBuy = line.includes('已跌破买入线');
    if (saysBrokeBuy !== reallyBelowBuy) {
      bad(`${name}：收盘 ${Math.round(close)} ${reallyBelowBuy ? '确实' : '并未'}跌破买入线 ${Math.round(tg.buyAt)}，`
        + `文案却说「${saysBrokeBuy ? '已跌破' : '还需跌'}」`);
    }
    // 卖出侧
    const reallyAboveSell = close >= tg.sellAt - 1e-9;
    const saysBrokeSell = line.includes('已涨破卖出线');
    if (saysBrokeSell !== reallyAboveSell) {
      bad(`${name}：收盘 ${Math.round(close)} ${reallyAboveSell ? '确实' : '并未'}涨破卖出线 ${Math.round(tg.sellAt)}，`
        + `文案却说「${saysBrokeSell ? '已涨破' : '还需涨'}」`);
    }
    // 报出来的百分比不许是负数
    for (const m of line.matchAll(/还需[跌涨] (-?[\d.]+)%/g)) {
      if (Number(m[1]) < 0) bad(`${name}：文案里出现负的百分比「${m[0]}」`);
    }
    if (expectBuy === '已跌破' && !saysBrokeBuy) bad(`${name}：预期「已跌破」，实际「${line.trim()}」`);
  }
}

/* ==================================================================== */
/** 跑一条剧本：从 tDate 起推进 n 天，在指定时刻按指定持仓查验 */
async function walk(name, tDate, startTier, startChain, visits) {
  console.log(`\n【${name}】`);
  const i0 = SERIES.findIndex((r) => r.d === tDate);
  const led = { schema: 1, launchDate: SERIES[i0 - 40].d, entries: [] };
  // 先把起始档位的账本铺好
  let prev = { tier: 0, pending: null };
  startChain.forEach(([k, from, to], n) => led.entries.push({
    seq: n + 1, date: SERIES[i0 - k].d, signalDate: SERIES[i0 - k - 1].d,
    side: to > from ? 'BUY' : 'SELL', tierFrom: from, tierTo: to,
    targetWeight: WEIGHTS[to], price: SERIES[i0 - k].c, etfPrice: ETF_PX, late: false,
    recordedAt: `${SERIES[i0 - k].d} 21:00:45`,
  }));
  prev.tier = startTier;

  const states = [];
  // 每条剧本有自己的起算日：用模块级那个常量会让重放跳过本剧本铺的账本，
  // 理论账户算成空仓，方向、金额全跟着错 —— 第一版就栽在这。
  for (let d = 0; d <= 3; d++) {
    const r = workerRun(i0 + d, prev, led, led.launchDate);
    prev = r.state;
    states.push({ ...r, ledger: JSON.parse(JSON.stringify(led)), day: SERIES[i0 + d].d });
  }

  // state.json 只在每天 21:00 更新：盘中打开面板，看到的还是**前一晚**那一版。
  // 让剧本只写「哪天几点」，状态由这条规则自动挑 —— 手写 states[k] 极易挑错，
  // 第一版就把 T+1 盘中配成了 T+1 晚上的状态，凭空多出一笔当天还没发生的记账。
  const pick = (day, at) => {
    const done = states.filter((s) => s.day < day || (s.day === day && at >= '21:00'));
    return done[done.length - 1];
  };
  for (const v of visits) {
    const at = v.at ?? '10:00';
    const snap = pick(v.day, at);
    if (!snap) { bad(`[${name} · ${v.label}] ${v.day} ${at} 之前没有任何一次运行`); continue; }
    goto(v.day, at);
    show(snap.state, snap.ledger, v.calc ?? null);
    const tag = `${name} · ${v.label}`;
    console.log(`  ── ${v.label}（${v.day} ${at}　面板数据截至 ${snap.state.asof}）`);
    const pp = verify(tag, snap.state, snap.ledger, v.calc ? cleanCalc(v.calc) : null, v.day);
    if (v.expect) v.expect(pp, (m) => bad(`[${tag}] ${m}`));
  }
  return states;
}

console.log('\n\n═════════════ 多角度矩阵 ═════════════');

const hold = (tot, t) => ({ cash: Math.round(tot * (1 - WEIGHTS[t])), hold: Math.round(tot * WEIGHTS[t]) });
const TOT = 1000000;

/* ② 连续三天买入：T+1 当天既要记账、又冒出新挂单 —— 最容易搞混的一天 */
await walk('连续买入信号', '2026-06-17', 1, [[40, 0, 1]], [
  { day: '2026-06-17', at: '21:05', label: 'T 日晚·收到推送', calc: hold(TOT, 1) },
  { day: '2026-06-18', at: '10:00', label: 'T+1 盘中·还没下单', calc: hold(TOT, 1) },
  { day: '2026-06-18', at: '21:05', label: 'T+1 晚·按时做完了', calc: hold(TOT, 2) },
  { day: '2026-06-22', at: '10:00', label: 'T+2 盘中·又一笔挂单在身', calc: hold(TOT, 2) },
  { day: '2026-06-22', at: '10:00', label: 'T+2 盘中·上一笔也没做', calc: hold(TOT, 1) },
]);

/* ③ 卖出方向 */
await walk('卖出信号', '2026-01-26', 3, [[40, 0, 1], [30, 1, 2], [20, 2, 3]], [
  { day: '2026-01-26', at: '21:05', label: 'T 日晚·收到推送', calc: hold(TOT, 3) },
  { day: '2026-01-27', at: '10:00', label: 'T+1 盘中·该卖了', calc: hold(TOT, 3) },
  { day: '2026-01-27', at: '21:05', label: 'T+1 晚·卖完了', calc: hold(TOT, 2) },
  { day: '2026-01-28', at: '10:00', label: 'T+2·忘了卖', calc: hold(TOT, 3) },
]);

/* ④ 连续卖出，一路卖到空仓 */
await walk('连续卖出至空仓', '2026-01-28', 2, [[40, 0, 1], [30, 1, 2]], [
  { day: '2026-01-28', at: '21:05', label: 'T 日晚', calc: hold(TOT, 2) },
  { day: '2026-01-29', at: '21:05', label: 'T+1 晚·卖掉一档', calc: hold(TOT, 1) },
  { day: '2026-01-30', at: '21:05', label: 'T+2 晚·再卖到空仓', calc: hold(TOT, 0) },
]);

/* ⑦ 跨五一长假：4-30 出信号，执行日 5-06，隔 6 个自然日 */
await walk('跨五一长假', '2026-04-30', 2, [[40, 0, 1], [30, 1, 2]], [
  { day: '2026-04-30', at: '21:05', label: 'T 日晚·节前最后一个交易日', calc: hold(TOT, 2) },
  { day: '2026-05-03', at: '11:00', label: '假期中间打开面板', calc: hold(TOT, 2) },
  { day: '2026-05-06', at: '10:00', label: '节后开市当天·就是执行日', calc: hold(TOT, 2) },
  { day: '2026-05-06', at: '21:05', label: '节后当晚·做完了', calc: hold(TOT, 1) },
]);

/* 用户行为变体：都发生在 ① 那条剧本上 */
await walk('用户行为变体', '2026-05-28', 0, [], [
  { day: '2026-05-28', at: '21:30', label: 'T 日晚就提前买了', calc: hold(TOT, 1) },
  { day: '2026-05-29', at: '10:00', label: 'T+1 盘中·只买了一半', calc: { cash: 875000, hold: 125000 } },
  { day: '2026-05-29', at: '21:05', label: 'T+1 晚·做了却忘了更新计算器', calc: hold(TOT, 0) },
  { day: '2026-06-01', at: '10:00', label: 'T+2·仍然没做', calc: hold(TOT, 0) },
  { day: '2026-06-02', at: '10:00', label: 'T+3·才想起来', calc: hold(TOT, 0) },
  { day: '2026-06-02', at: '15:30', label: 'T+3·补做完', calc: hold(TOT, 1) },
]);

/* ==================================================================== */
/*
 * 边缘但真实的状态：新用户还没设本金、ETF 报价取不到、封顶封底、
 * 系统漏跑一天、周末打开面板、系统彻底停跑、计算器乱填。
 * 这些都不是「假设」——前两条此刻线上就是。
 */
console.log('\n\n═════════════ 边缘状态 ═════════════');

/** 直接摆一个状态渲染，不走状态机 */
function raw(label, { tier, pending, chain = [], asof, day, at = '10:00', calc, etf = { code: '515180', close: ETF_PX, asof: null, stale: false }, principal = PRINCIPAL, ledgerExtra = [], checks }) {
  const i0 = SERIES.findIndex((r) => r.d === asof);
  const launch = SERIES[i0 - 40].d;
  const led = {
    schema: 1, launchDate: launch,
    entries: chain.map(([k, f, t], n) => ({
      seq: n + 1, date: SERIES[i0 - k].d, signalDate: SERIES[i0 - k - 1].d,
      side: t > f ? 'BUY' : 'SELL', tierFrom: f, tierTo: t, targetWeight: WEIGHTS[t],
      price: SERIES[i0 - k].c, etfPrice: ETF_PX, late: false, recordedAt: `${SERIES[i0 - k].d} 21:00:45`,
    })).concat(ledgerExtra),
  };
  const close = SERIES[i0].c;
  const ma30 = ma(SERIES.slice(0, i0 + 1).map((r) => r.c), MA_LEN);
  const tg = triggers(close, ma30);
  const state = {
    schema: 1, launchDate: launch, asof, lastRun: `${asof} 21:00:45`, tier, pending: pending ?? null,
    index: {
      code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: 0.2, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2),
    },
    bond: { code: 'H11001', close: SERIES[i0].b },
    etf: etf ? { ...etf, asof: etf.asof ?? asof } : null,
    checks: checks ?? { passed: 10, total: 10, failed: [], ranAt: `${asof} 21:00:45` },
  };
  store.set('hlma30.principal', String(principal));
  goto(day, at);
  show(state, led, calc ?? null);
  console.log(`\n  ── ${label}（今天 ${day} ${at}　数据截至 ${asof}）`);
  const pp = verify(label, state, led, calc ? cleanCalc(calc) : null, day);
  pp.胶囊 = el('healthPill').textContent.trim();
  pp.陈旧告警 = el('staleWarn').hidden === true ? null : el('staleWarn').textContent.trim();
  // 自检列表和脚注平时没人细读，恰恰最容易攒黑话
  const extra = [el('checks').textContent, el('dataNote').textContent,
    el('healthPill').textContent, el('staleWarn').textContent, el('pushWarn').textContent,
    el('ledgerWarn').textContent].join('｜');
  for (const h of slangIn(extra)) bad(`[${label}] 健康区出现黑话：${h}`);
  console.log(`    胶囊　　　 ${pp.胶囊}`);
  if (pp.陈旧告警) console.log(`    陈旧告警　 ${pp.陈旧告警}`);
  store.set('hlma30.principal', String(PRINCIPAL));
  return pp;
}

const A = '2026-05-28', A1 = '2026-05-29';
const pendBuy = { signalDate: A, tierFrom: 0, tierTo: 1, side: 'BUY' };

// ① 新用户第一天：还没设本金，却已经出了信号
raw('新用户·本金未设置 + 有挂单', { tier: 0, pending: pendBuy, asof: A, day: A1, principal: 0 });

// ② ETF 报价取不到（线上此刻就是这个状态）
raw('ETF 报价取不到', { tier: 0, pending: pendBuy, asof: A, day: A1, calc: hold(TOT, 0),
  etf: { code: '515180', close: null, asof: null, stale: true },
  checks: { passed: 9, total: 10, failed: [{ id: 8, name: 'ETF 报价日期与指数一致', detail: '未取到 ETF 报价' }], ranAt: `${A} 21:00:45` } });

// ③ 封顶：已满仓，指数继续跌
raw('已满仓·指数继续跌', { tier: 4, chain: [[40, 0, 1], [35, 1, 2], [30, 2, 3], [25, 3, 4]], asof: A, day: A1, calc: hold(TOT, 4) });

// ④ 封底：已空仓，指数继续涨
raw('已空仓·指数继续涨', { tier: 0, chain: [], asof: '2026-01-26', day: '2026-01-27', calc: hold(TOT, 0) });

// ⑤ 周末打开面板：数据停在周五，今天是周日
raw('周末打开面板', { tier: 1, chain: [[40, 0, 1]], asof: A1, day: '2026-05-31', at: '09:00', calc: hold(TOT, 1) });

// ⑥ 系统彻底停跑：数据停在两周前
{
  const r = raw('系统停跑两周', { tier: 1, chain: [[40, 0, 1]], asof: A, day: '2026-06-15', calc: hold(TOT, 1) });
  if (!r.陈旧告警) bad('[系统停跑两周] 数据停了 11 个交易日，却没有任何陈旧告警');
  if (/通过/.test(r.胶囊)) bad(`[系统停跑两周] 系统已经停跑，健康胶囊却还显示「${r.胶囊}」`);
  if (/稍等再刷新/.test(r.卡片副)) bad('[系统停跑两周] 停了两周还在说「稍等再刷新」');
}
// 正常当天不该误报陈旧
{
  const r = raw('数据正常（当天下午）', { tier: 1, chain: [[40, 0, 1]], asof: A1, day: A1, at: '14:00', calc: hold(TOT, 1) });
  if (r.陈旧告警) bad(`[数据正常] 当天下午却报了陈旧：「${r.陈旧告警.slice(0, 30)}…」`);
  if (!/通过/.test(r.胶囊)) bad(`[数据正常] 一切正常，胶囊却是「${r.胶囊}」`);
}

// ⑦ 挂单迟到执行：系统漏跑，T 的挂单拖到 T+2 才记
{
  const i0 = SERIES.findIndex((r) => r.d === '2026-06-01');
  raw('挂单迟到执行（系统漏跑一天）', {
    tier: 1, chain: [], asof: '2026-06-01', day: '2026-06-02', calc: hold(TOT, 1),
    ledgerExtra: [{
      seq: 1, date: '2026-06-01', signalDate: '2026-05-28', side: 'BUY',
      tierFrom: 0, tierTo: 1, targetWeight: WEIGHTS[1], price: SERIES[i0].c,
      etfPrice: ETF_PX, late: true, recordedAt: '2026-06-01 21:00:45',
    }],
  });
  const tb = el('ledger').querySelector('tbody').innerHTML.replace(/<[^>]*>/g, ' ');
  console.log(`    交易记录：${tb.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  if (!/迟到/.test(tb)) {
    bad('[挂单迟到执行] 账本里 late=true，交易记录却完全看不出这笔是迟到成交的');
  }
}

// ⑧ 计算器乱填
console.log('\n  ── 计算器异常输入');
for (const [label, c] of [
  ['只填可用资金', { cash: 1000000, hold: 0 }],
  ['只填已持有', { cash: 0, hold: 1000000 }],
  ['两栏都是 0', { cash: 0, hold: 0 }],
  ['负数', { cash: -5000, hold: 100000 }],
  ['极小本金（1 万）', { cash: 10000, hold: 0 }],
  ['正好卡在四舍五入边界 12.5%', { cash: 875000, hold: 125000 }],
  ['正好卡在四舍五入边界 37.5%', { cash: 625000, hold: 375000 }],
]) {
  raw(`乱填·${label}`, { tier: 0, pending: pendBuy, asof: A, day: A1, calc: c });
}

/* ==================================================================== */
/*
 * 出错时才会出现的文案 —— 平时看不到，出事那天却是唯一的指引。
 * 顺带把每一句都拿去过一遍「黑话」筛子。
 */
console.log('\n\n═════════════ 出错时的文案 ═════════════');

const health = () => ({
  胶囊: el('healthPill').textContent.trim(),
  自检: el('checks').textContent.replace(/\s+/g, ' ').trim(),
  推送告警: el('pushWarn').hidden === true ? null : el('pushWarn').textContent.trim(),
  陈旧告警: el('staleWarn').hidden === true ? null : el('staleWarn').textContent.trim(),
  账本告警: el('ledgerWarn').style.display === 'none' ? null : el('ledgerWarn').textContent.trim(),
  脚注: el('dataNote').textContent.replace(/\s+/g, ' ').trim(),
});

function showHealth(label, over) {
  raw(label, { tier: 1, chain: [[40, 0, 1]], asof: A1, day: A1, at: '22:00', calc: hold(TOT, 1), ...over });
  const h = health();
  for (const [k, v] of Object.entries(h)) if (v) console.log(`    ${k.padEnd(5, '　')} ${v}`);
  return h;
}

// ① 还没跑过第一次
showHealth('首次运行之前', { checks: {} });

// ② 推送失败
{
  const i0 = SERIES.findIndex((r) => r.d === A1);
  const st0 = { passed: 10, total: 10, failed: [], ranAt: `${A1} 21:00:45` };
  raw('推送失败', { tier: 1, chain: [[40, 0, 1]], asof: A1, day: A1, at: '22:00', calc: hold(TOT, 1), checks: st0 });
  // push 字段要手工塞进去再渲染一次
  H.S = { ...H.S, state: { ...H.S.state, push: { ok: false, at: `${A1} 21:00:47`, reason: 'Bark 返回 400：device_key 无效' } } };
  H.render();
  const h = health();
  for (const [k, v] of Object.entries(h)) if (v) console.log(`    ${k.padEnd(5, '　')} ${v}`);
  if (!h.推送告警) bad('[推送失败] 推送发不出去，面板上却没有任何提示');
}

// ③ 多项校验未过 —— 把每条的名字和说明都亮出来
showHealth('多项校验未过', {
  checks: {
    passed: 6, total: 10, ranAt: `${A1} 21:00:45`,
    failed: [
      { id: 4, name: '幽灵行已清除', detail: '2026-05-20 与前一日收盘价完全相同' },
      { id: 5, name: '涨跌幅与收盘价对账', detail: '2026-05-21 涨跌幅对不上，差 0.42%' },
      { id: 8, name: 'ETF 报价日期与指数一致', detail: '未取到 ETF 报价' },
      { id: 10, name: '账本自审：日期与档位链完整', detail: '第 2 笔的起始档位与第 1 笔的落点对不上' },
    ],
  },
});

// ④ 账本自审异常
{
  raw('账本自身有异常', {
    tier: 2, chain: [], asof: A1, day: A1, at: '22:00', calc: hold(TOT, 2),
    ledgerExtra: [
      { seq: 1, date: '2026-05-20', signalDate: '2026-05-19', side: 'BUY', tierFrom: 0, tierTo: 1, targetWeight: WEIGHTS[1], price: 11800, etfPrice: ETF_PX, late: false, recordedAt: '' },
      { seq: 2, date: '2026-05-21', signalDate: '2026-05-20', side: 'BUY', tierFrom: 3, tierTo: 4, targetWeight: WEIGHTS[4], price: 11810, etfPrice: ETF_PX, late: false, recordedAt: '' },
    ],
  });
  const h = health();
  if (h.账本告警) console.log(`    账本告警　 ${h.账本告警}`);
  else bad('[账本自身有异常] 账本档位链断了，却没有任何告警');
}

// ⑤ 状态文件损坏时，整页会被这些话取代
console.log('\n  ── 状态文件损坏时列出的问题');
{
  const base = JSON.parse(JSON.stringify(H.S.state));
  const cases = [
    ['档位越界', { ...base, tier: 7 }],
    ['档位不是整数', { ...base, tier: 1.5 }],
    ['日期格式不对', { ...base, asof: '2026/05/29' }],
    ['买入线高于卖出线', { ...base, index: { ...base.index, buyTrigger: 99999 } }],
    ['挂单跨了两档', { ...base, pending: { signalDate: A, tierFrom: 0, tierTo: 3, side: 'BUY' } }],
  ];
  for (const [nm, st] of cases) {
    const probs = CORE.validateState(st);
    console.log(`    ${nm.padEnd(9, '　')} ${probs.join('；') || '（没查出问题）'}`);
    if (!probs.length) bad(`[状态损坏·${nm}] 明显不合法却没被 validateState 拦下`);
  }
}

/* ==================================================================== */
/*
 * 交互序列：前面查的都是「某一刻显示什么」，这里查的是
 * 「点了、改了、隔了一天之后，显示还对不对」——
 * 状态残留和跨日行为只有连着走才看得出来。
 */
console.log('\n\n═════════════ 交互序列 ═════════════');

const bannerOn = () => banners().length > 0;

/* ① 「已完成」按钮的跨日行为 */
console.log('\n【点「已完成」之后】');
{
  // 确认标记存在 localStorage 里会跨用例残留 —— 上一段点过的「我做了」
  // 会让这一段以为横幅本来就该收起。每段开头清一次。
  for (const k of [...store.keys()]) if (k.startsWith('hlma30.ack.')) store.delete(k);
  const i0 = SERIES.findIndex((r) => r.d === A);
  const led0 = { schema: 1, launchDate: SERIES[i0 - 40].d, entries: [] };
  const mk = (asof, pending, tier) => {
    const cl = SERIES[SERIES.findIndex((r) => r.d === asof)].c;
    const m3 = ma(SERIES.slice(0, SERIES.findIndex((r) => r.d === asof) + 1).map((r) => r.c), MA_LEN);
    const tg = triggers(cl, m3);
    return {
      schema: 1, launchDate: led0.launchDate, asof, lastRun: `${asof} 21:00:45`, tier, pending,
      index: { code: 'H00922', close: +cl.toFixed(2), ma30: +m3.toFixed(2), ratio: +tg.ratio.toFixed(4),
        changePct: 0.1, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
        pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
      bond: { code: 'H11001', close: 267 },
      etf: { code: '515180', close: ETF_PX, asof, stale: false },
      checks: { passed: 10, total: 10, failed: [], ranAt: `${asof} 21:00:45` },
    };
  };
  const pA = { signalDate: A, tierFrom: 0, tierTo: 1, side: 'BUY' };

  goto(A, '21:05'); show(mk(A, pA, 0), led0, null);
  console.log(`  T 日晚打开　　　　　　横幅 ${bannerOn() ? '显示' : '收起'}`);
  if (!bannerOn()) bad('[已完成] T 日晚横幅没显示');

  banners()[0].btn.onclick();
  console.log(`  点「已完成」　　　　　横幅 ${bannerOn() ? '显示' : '收起'}`);
  if (bannerOn()) bad('[已完成] 点了按钮横幅还在');

  goto(A, '21:10'); show(mk(A, pA, 0), led0, null);
  console.log(`  同一天刷新页面　　　　横幅 ${bannerOn() ? '显示' : '收起'}`);
  if (bannerOn()) bad('[已完成] 同一天刷新后横幅又冒出来了');

  goto(A1, '10:00'); show(mk(A, pA, 0), led0, null);
  console.log(`  T+1 执行日当天打开　　横幅 ${bannerOn() ? '显示' : '收起'}　卡片「${el('nextLine').textContent.trim()}」`);
  if (!/今天/.test(el('nextLine').textContent)) {
    bad('[已完成] 横幅已收起，顶部卡片必须还在提醒今天要做 —— 否则点过按钮就彻底没提示了');
  }

  // T+1 晚执行 + 又出新信号 → 新的信号日，横幅必须重新出现
  const led1 = { ...led0, entries: [{ seq: 1, date: A1, signalDate: A, side: 'BUY', tierFrom: 0, tierTo: 1,
    targetWeight: WEIGHTS[1], price: SERIES[i0 + 1].c, etfPrice: ETF_PX, late: false, recordedAt: `${A1} 21:00:45` }] };
  const pB = { signalDate: A1, tierFrom: 1, tierTo: 2, side: 'BUY' };
  goto(A1, '21:05'); show(mk(A1, pB, 1), led1, null);
  console.log(`  T+1 晚又出新信号　　　横幅 ${bannerOn() ? '显示' : '收起'}`);
  if (!bannerOn()) bad('[已完成] 换了新信号，横幅必须重新出现 —— 否则这笔永远没人提醒');
}

/* ② 同一天不同时刻打开，时点提示是否始终成立 */
console.log('\n【同一天从早到晚】');
{
  const i0 = SERIES.findIndex((r) => r.d === A);
  const led = { schema: 1, launchDate: SERIES[i0 - 40].d, entries: [] };
  const pA = { signalDate: A, tierFrom: 0, tierTo: 1, side: 'BUY' };
  const st1 = { schema: 1, launchDate: led.launchDate, asof: A, lastRun: `${A} 21:00:45`, tier: 0, pending: pA,
    index: { code: 'H00922', close: 11646.8, ma30: 12017.48, ratio: 0.9691, changePct: -0.17,
      buyTrigger: 11656.95, sellTrigger: 12257.83, pctToBuy: 0.09, pctToSell: 5.25 },
    bond: { code: 'H11001', close: 267 }, etf: { code: '515180', close: ETF_PX, asof: A, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${A} 21:00:45` } };
  for (const at of ['09:00', '11:30', '14:45', '15:30', '20:00']) {
    goto(A1, at); show(st1, led, hold(TOT, 0));
    const line = el('nextLine').textContent.trim();
    const t = el('timing').textContent.trim();
    console.log(`  ${A1} ${at}　${line}`);
    if (!/今天/.test(line)) bad(`[同一天] ${at} 打开，执行日就是今天却没说「今天」：「${line}」`);
    if (!t.includes('尾盘')) bad(`[同一天] ${at} 没给尾盘提示`);
  }
}

/* ③ 买完立刻反向：T 买入信号，T+1 又出卖出信号 */
console.log('\n【买完第二天就要卖】');
{
  const i0 = SERIES.findIndex((r) => r.d === A);
  const led = { schema: 1, launchDate: SERIES[i0 - 40].d,
    entries: [{ seq: 1, date: A1, signalDate: A, side: 'BUY', tierFrom: 0, tierTo: 1,
      targetWeight: WEIGHTS[1], price: SERIES[i0 + 1].c, etfPrice: ETF_PX, late: false, recordedAt: `${A1} 21:00:45` }] };
  const st2 = { schema: 1, launchDate: led.launchDate, asof: A1, lastRun: `${A1} 21:00:45`, tier: 1,
    pending: { signalDate: A1, tierFrom: 1, tierTo: 0, side: 'SELL' },
    index: { code: 'H00922', close: 12400, ma30: 12100, ratio: 1.0248, changePct: 5.1,
      buyTrigger: 11737, sellTrigger: 12342, pctToBuy: -5.35, pctToSell: -0.47 },
    bond: { code: 'H11001', close: 267 }, etf: { code: '515180', close: ETF_PX, asof: A1, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${A1} 21:00:45` } };
  goto(A1, '21:05'); show(st2, led, hold(TOT, 1));
  const pp = verify('买完第二天就要卖', st2, led, cleanCalc(hold(TOT, 1)), A1);
  console.log(`    交易记录　 ${el('ledger').querySelector('tbody').textContent.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
}

/* ④ 小额：算出来不够一手 */
console.log('\n【本金太小，不够一手】');
{
  const i0 = SERIES.findIndex((r) => r.d === A);
  const led = { schema: 1, launchDate: SERIES[i0 - 40].d, entries: [] };
  const st3 = { schema: 1, launchDate: led.launchDate, asof: A, lastRun: `${A} 21:00:45`, tier: 0,
    pending: { signalDate: A, tierFrom: 0, tierTo: 1, side: 'BUY' },
    index: { code: 'H00922', close: 11646.8, ma30: 12017.48, ratio: 0.9691, changePct: -0.17,
      buyTrigger: 11656.95, sellTrigger: 12257.83, pctToBuy: 0.09, pctToSell: 5.25 },
    bond: { code: 'H11001', close: 267 }, etf: { code: '515180', close: ETF_PX, asof: A, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${A} 21:00:45` } };
  for (const [lab, c] of [['总共 500 元', { cash: 500, hold: 0 }], ['总共 600 元', { cash: 600, hold: 0 }]]) {
    goto(A1, '10:00'); show(st3, led, c);
    const m = el('oMain').textContent.trim();
    console.log(`  ${lab}　→　${m}`);
    if (/约 0 股/.test(m)) bad(`[小额] 算出 0 股还照样显示：「${m}」—— 该直说这点钱买不了一手`);
    if (/<[a-zA-Z/]/.test(m)) bad(`[小额] 计算器主行漏出 HTML 标签（该元素用 textContent 写）：「${m}」`);
    if (!/不足一手/.test(m) && /125 元/.test(m)) bad(`[小额] 125 元买不了一手，却没提示：「${m}」`);
  }
}

/* ==================================================================== */
/*
 * 还没碰过的三块：亏钱时的盈亏卡片、金额量级、跨年。
 * 「红涨绿跌」是最早就提的要求，但前面每一轮都跑在赚钱的场景上。
 */
console.log('\n\n═════════════ 盈亏卡片 · 金额量级 · 跨年 ═════════════');

/* ① 亏损状态：找一段真跌过的行情，满仓扛下来 */
console.log('\n【亏钱的时候】');
{
  // 在真实行情里找「满仓期间跌得最多」的一段
  let best = null;
  for (let i = MA_LEN + 5; i < SERIES.length - 5; i++) {
    for (const span of [20, 40, 60]) {
      const j = i + span;
      if (j >= SERIES.length) continue;
      const dd = SERIES[j].c / SERIES[i].c - 1;
      if (!best || dd < best.dd) best = { i, j, dd, from: SERIES[i].d, to: SERIES[j].d };
    }
  }
  console.log(`  取真实行情最惨的一段：${best.from} → ${best.to}　指数 ${(best.dd * 100).toFixed(2)}%`);

  const led = {
    schema: 1, launchDate: SERIES[best.i].d,
    entries: [{ seq: 1, date: SERIES[best.i].d, signalDate: SERIES[best.i - 1].d, side: 'BUY',
      tierFrom: 0, tierTo: 4, targetWeight: 1, price: SERIES[best.i].c, etfPrice: ETF_PX,
      late: false, recordedAt: `${SERIES[best.i].d} 21:00:45` }],
  };
  const cl = SERIES[best.j].c;
  const m4 = ma(SERIES.slice(0, best.j + 1).map((r) => r.c), MA_LEN);
  const tg = triggers(cl, m4);
  const stL = {
    schema: 1, launchDate: led.launchDate, asof: SERIES[best.j].d, lastRun: `${SERIES[best.j].d} 21:00:45`,
    tier: 4, pending: null,
    index: { code: 'H00922', close: +cl.toFixed(2), ma30: +m4.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: -1.2, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
    bond: { code: 'H11001', close: SERIES[best.j].b },
    etf: { code: '515180', close: ETF_PX, asof: SERIES[best.j].d, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${SERIES[best.j].d} 21:00:45` },
  };
  store.set('hlma30.principal', String(PRINCIPAL));
  goto(SERIES[best.j].d, '21:05');
  show(stL, led, null);
  const pnl = {
    盈亏: el('pnl').textContent.trim(), 盈亏色: el('pnl').style.color,
    累计: el('pnlCum').textContent.trim(), 累计色: el('pnlCum').style.color,
    年化: el('pnlAnn').textContent.trim(), 总资产: el('pnlTot').textContent.trim(),
    已运行: el('pnlDays').textContent.trim(),
  };
  for (const [k, v] of Object.entries(pnl)) console.log(`    ${k.padEnd(4, '　')} ${v}`);

  // A 股约定：红涨绿跌。亏钱必须是绿色（--dn），不能是红色
  const neg = pnl.盈亏.startsWith('−') || pnl.盈亏.startsWith('-');
  if (!neg) bad(`[亏钱] 这段行情指数跌了 ${(best.dd * 100).toFixed(1)}%、满仓扛着，盈亏却是「${pnl.盈亏}」`);
  if (neg && pnl.盈亏色 !== 'var(--dn)') bad(`[亏钱] 亏损应显示绿色（--dn），实际「${pnl.盈亏色}」`);
  if (neg && pnl.累计色 !== 'var(--dn)') bad(`[亏钱] 累计亏损应显示绿色，实际「${pnl.累计色}」`);
  if (/NaN|undefined/.test(Object.values(pnl).join(''))) bad('[亏钱] 盈亏卡片里出现 NaN/undefined');
  if (!/^−|^-/.test(pnl.累计)) bad(`[亏钱] 累计收益应带负号，实际「${pnl.累计}」`);
}

/* ② 金额量级：一亿和一千块，格式都得读得出来 */
console.log('\n【金额量级】');
{
  const i0 = SERIES.findIndex((r) => r.d === A);
  for (const [lab, P] of [['本金 1 亿', 100000000], ['本金 1000 元', 1000], ['本金 1234.56 元', 1234.56]]) {
    const r = raw(`量级·${lab}`, { tier: 0, pending: { signalDate: A, tierFrom: 0, tierTo: 1, side: 'BUY' },
      asof: A, day: A1, principal: P, calc: { cash: P, hold: 0 } });
    console.log(`    盈亏卡片总资产 ${el('pnlTot').textContent.trim()}`);
    const all = `${r.算主}｜${r.算副}｜${el('pnlTot').textContent}`;
    if (/NaN|undefined|Infinity|e\+/.test(all)) bad(`[${lab}] 金额格式坏了：「${all.slice(0, 70)}」`);
    // 千分位必须是三位一组
    for (const m of all.matchAll(/(\d{1,3}(?:,\d{3})+)/g)) {
      if (!/^\d{1,3}(,\d{3})+$/.test(m[1])) bad(`[${lab}] 千分位不对：「${m[1]}」`);
    }
  }
}

/* ③ 跨年：12 月出信号，执行日落在次年 */
console.log('\n【跨年】');
{
  const dec = SERIES.filter((r) => r.d >= '2026-12-20');
  if (!dec.length) {
    console.log('    行情数据没到 12 月下旬，改用手工状态验措辞');
    const stY = {
      schema: 1, launchDate: '2026-11-02', asof: '2026-12-31', lastRun: '2026-12-31 21:00:45',
      tier: 0, pending: { signalDate: '2026-12-31', tierFrom: 0, tierTo: 1, side: 'BUY' },
      index: { code: 'H00922', close: 11600, ma30: 12000, ratio: 0.9667, changePct: -0.5,
        buyTrigger: 11640, sellTrigger: 12240, pctToBuy: 0.34, pctToSell: 5.52 },
      bond: { code: 'H11001', close: 270 },
      etf: { code: '515180', close: ETF_PX, asof: '2026-12-31', stale: false },
      checks: { passed: 10, total: 10, failed: [], ranAt: '2026-12-31 21:00:45' },
    };
    const ledY = { schema: 1, launchDate: '2026-11-02', entries: [] };
    for (const [lab, d, at] of [['除夕夜打开', '2026-12-31', '21:05'], ['元旦假期打开', '2027-01-02', '11:00']]) {
      goto(d, at);
      show(stY, ledY, hold(TOT, 0));
      console.log(`  ── ${lab}（${d} ${at}）`);
      console.log(`    卡片　 ${el('nextLine').textContent.trim()}`);
      console.log(`    时点　 ${el('timing').textContent.trim().slice(0, 78)}`);
      const line = el('nextLine').textContent;
      // 2027 年日历还没进仓库时，必须老实说算不出来，不能瞎编一个日期
      if (/1 月 1 日|1 月 2 日|1 月 3 日/.test(line)) {
        bad(`[跨年·${lab}] 元旦假期不是交易日，却把执行日说成了「${line}」`);
      }
      if (!/执行日待定|1 月 4 日|1 月 5 日/.test(line)) {
        bad(`[跨年·${lab}] 既没给出合法执行日，也没说「执行日待定」：「${line}」`);
      }
      const tm = el('timing').textContent;
      if (/需在\s*执行日待定|执行日待定收盘前/.test(tm)) {
        bad(`[跨年·${lab}] 算不出执行日时句子断了：「${tm.slice(0, 44)}…」`);
      }
      if (!/交易日历还没进系统|定不下来/.test(tm)) {
        bad(`[跨年·${lab}] 没说清为什么定不下执行日：「${tm.slice(0, 44)}…」`);
      }
    }
  }
}

/* ==================================================================== */
console.log('\n\n═════════════ 推送里的检查告警 · 图表 ═════════════');

/* ① 检查名是肯定句，列出来时必须说清是「没通过」 */
console.log('\n【检查没通过时的推送】');
{
  const idx0 = { close: 11646.8, ma30: 12017.48, changePct: -0.17,
    buyTrigger: 11656.95, sellTrigger: 12257.83, pctToBuy: 0.09, pctToSell: 5.25 };
  const got = await push({
    today: A1, newState: { tier: 2, index: idx0 }, pending: null, execDay: '2026-06-01',
    executed: null, plan: null, etf: { close: ETF_PX },
    checks: [{ ok: true, name: '这一天确实是交易日' },
      { ok: false, name: 'ETF 报价和指数是同一天的' },
      { ok: false, name: '没有混进重复抄来的假数据' }],
    late: false,
  });
  const body = got[0].body;
  if (!/没通过/.test(body)) {
    bad('[检查告警] 检查名是肯定句，光列名字会被读成「这些是事实」—— 必须写明「没通过」');
  }
  if (!/2 项/.test(body)) bad('[检查告警] 没说清有几项没通过');
}

/* ② 图表：各时间范围与边界都不该崩、不该漏 NaN */
console.log('\n【图表】');
{
  const i0 = ROWS.length - 1;
  H.S = { ...H.S,
    ledger: { schema: 1, launchDate: ROWS[i0 - 60].d, entries: [
      { seq: 1, date: ROWS[i0 - 40].d, side: 'BUY', tierFrom: 0, tierTo: 1, targetWeight: 0.25, price: ROWS[i0 - 40].c },
      { seq: 2, date: ROWS[i0 - 20].d, side: 'SELL', tierFrom: 1, tierTo: 0, targetWeight: 0, price: ROWS[i0 - 20].c }] },
    state: { ...H.S.state, launchDate: ROWS[i0 - 60].d, tier: 0 } };
  const marks = [];
  for (const [nm, from] of [['近一月', i0 - 20], ['近三月', i0 - 62], ['近半年', i0 - 125],
    ['近一年', i0 - 242], ['近两年', Math.max(0, i0 - 485)], ['近三年', 0],
    ['只剩 2 天', i0 - 1], ['只剩 1 天', i0], ['越界', i0 + 50]]) {
    try {
      H.drawChart(Math.max(0, from));
      const g = el('chart').innerHTML;
      if (/NaN|undefined|Infinity/.test(g)) bad(`[图表] ${nm} 画出了 NaN/undefined`);
      if (nm === '近一年') marks.push(...(g.match(/>[BS]</g) || []));
      console.log(`  ${nm.padEnd(9, '　')} ${g ? `${g.length} 字符` : '空（数据不足，正常）'}`);
    } catch (e) {
      bad(`[图表] ${nm} 抛错：${e.message}`);
    }
  }
  console.log(`  近一年里的买卖标记：${marks.join(' ') || '（无）'}`);
  if (marks.length !== 2) bad(`[图表] 账本里 2 笔成交，图上却有 ${marks.length} 个标记`);
}

/* ==================================================================== */
/*
 * 本金输入 —— 它是所有金额的根。
 * 原先直接丢给 num()（只留数字和小数点），于是「abc」「１００万」被静默
 * 清空，「1e6」变 16 元、「50万」变 50 元 —— 后一种最坏，清空还看得出来，
 * 16 元看不出来，而账户盈亏和交易记录的每个数都是从本金推出来的。
 */
console.log('\n\n═════════════ 本金输入 ═════════════\n');
{
  const PV = () => el('pView').textContent.trim();
  const HINT = () => el('pHint').textContent.trim();
  const setP = (v) => {
    store.set('hlma30.principal', '1000000');
    store.set('hlma30.calc', JSON.stringify({ cash: 750000, hold: 250000 }));
    H.render();
    el('pBtn').click();          // 进入编辑态
    el('inP').value = v;
    el('pBtn').click();          // 点完成
    return { 本金: PV(), 提示: HINT(), 计算器: `${el('inCash').value} / ${el('inHold').value}`,
      仍在编辑: el('inP').hidden !== true };
  };

  const cases = [
    ['1000000', true, '正常'],
    ['1,000,000', true, '带千分位'],
    ['1234.56', true, '带小数'],
    ['abc', false, '纯字母'],
    ['1.2.3', false, '两个小数点'],
    ['1e6', false, '科学计数法 —— 原先会变成 16 元'],
    ['50万', false, '带「万」—— 原先会变成 50 元'],
    ['１００万', false, '全角 —— 手机输入法很容易打出'],
    ['1000000 元', false, '带单位'],
    ['-5000', false, '负数'],
  ];
  for (const [v, shouldSave, why] of cases) {
    const r = setP(v);
    const saved = !r.仍在编辑;
    console.log(`  输入 ${JSON.stringify(v).padEnd(13)} → ${saved ? `保存为 ${r.本金}` : '拒绝保存，停在编辑态'}　（${why}）`);
    if (saved !== shouldSave) {
      bad(`[本金] 输入「${v}」${shouldSave ? '应该保存却被拒' : '不该保存却存进去了：' + r.本金}`);
    }
    if (!saved && !/看不出是多少钱|不是一个有效金额/.test(r.提示)) {
      bad(`[本金] 拒绝了「${v}」却没说清为什么：「${r.提示}」`);
    }
    if (!saved) console.log(`      提示：${r.提示}`);
  }

  // 清空 = 主动清除，允许，但要说明
  {
    const r = setP('');
    console.log(`  输入 ${JSON.stringify('').padEnd(13)} → ${r.本金}　提示：${r.提示}`);
    if (r.本金 !== '未设置') bad(`[本金] 清空后应显示「未设置」，实际「${r.本金}」`);
    if (!/清除/.test(r.提示)) bad('[本金] 清空本金没有任何说明');
  }

  // 小得离谱要提醒，但不拦
  {
    const r = setP('500');
    console.log(`  输入 ${JSON.stringify('500').padEnd(13)} → ${r.本金}　提示：${r.提示}`);
    if (!/确认没少写几位/.test(r.提示)) bad('[本金] 本金只有 500 元却没提醒是不是少写了几位');
  }

  // 点开又原样点「完成」，不该把计算器里填的数字清掉
  {
    store.set('hlma30.principal', '1000000');
    store.set('hlma30.calc', JSON.stringify({ cash: 750000, hold: 250000 }));
    H.render();
    el('pBtn').click();
    el('pBtn').click();          // 一个字没改
    const kept = store.get('hlma30.calc');
    console.log(`  点开→原样完成　→ 计算器数字 ${kept ? '保留' : '被清空'}`);
    if (!kept) bad('[本金] 点开本金又原样点「完成」，把计算器里填的实盘数字清掉了');
  }
}

/* ==================================================================== */
/*
 * 在券商 App 里做了，但没回前端页面更新数字 —— 最常见的用法之一。
 * 系统只能看那两个输入框，所以分不清「真没做」和「做了没更新」。
 * 分不清就不能断言，只能把两种可能都摆出来。
 */
console.log('\n\n═════════════ 在券商做了、没回页面更新 ═════════════');
{
  const led2 = { schema: 1, launchDate: SERIES[iT - 40].d, entries: [{
    seq: 1, date: T1, signalDate: T, side: 'BUY', tierFrom: 0, tierTo: 1,
    targetWeight: WEIGHTS[1], price: SERIES[iT + 1].c, etfPrice: ETF_PX, late: false,
    recordedAt: `${T1} 21:00:45` }] };
  const i1 = SERIES.findIndex((r) => r.d === T1);
  const cl = SERIES[i1].c, m30 = ma(SERIES.slice(0, i1 + 1).map((r) => r.c), MA_LEN);
  const tg = triggers(cl, m30);
  const st2 = {
    schema: 1, launchDate: led2.launchDate, asof: T1, lastRun: `${T1} 21:00:45`, tier: 1, pending: null,
    index: { code: 'H00922', close: +cl.toFixed(2), ma30: +m30.toFixed(2), ratio: +tg.ratio.toFixed(4),
      changePct: 1.29, buyTrigger: +tg.buyAt.toFixed(2), sellTrigger: +tg.sellAt.toFixed(2),
      pctToBuy: +tg.pctToBuy.toFixed(2), pctToSell: +tg.pctToSell.toFixed(2) },
    bond: { code: 'H11001', close: SERIES[i1].b },
    etf: { code: '515180', close: ETF_PX, asof: T1, stale: false },
    checks: { passed: 10, total: 10, failed: [], ranAt: `${T1} 21:00:45` } };

  const peek = (label, calc) => {
    store.set('hlma30.principal', String(PRINCIPAL));
    if (calc) {
      store.set('hlma30.calc', JSON.stringify(calc));
      el('inCash').value = String(calc.cash); el('inHold').value = String(calc.hold);
    } else { store.delete('hlma30.calc'); el('inCash').value = ''; el('inHold').value = ''; }
    H.S = { ...H.S, state: JSON.parse(JSON.stringify(st2)), ledger: JSON.parse(JSON.stringify(led2)) };
    goto(T2, '10:00');
    H.render();
    const line = el('nextLine').textContent.trim();
    const sub = el('nextSub').textContent.trim();
    const tm = el('timing').textContent.trim();
    console.log(`\n  ── ${label}`);
    console.log(`     卡片 ${line}`);
    return { line, sub, tm };
  };

  // A. 从没填过 → 输入框跟着账本走，一切正常
  {
    const r = peek('从来没在计算器里填过数字', null);
    if (/还没做|对不上|差 \d+ 档|补齐/.test(r.line)) {
      bad(`[没更新] 从没填过数字时系统无从判断，不该提示欠账：「${r.line}」`);
    }
  }

  // B. 填过、数字停在买之前 → 不能断言「你还没做」
  {
    // 最常见的那条路径：**当天上午**填好数字、照着买、当晚 21:00 记账。
    // 填写时刻和记账日期同一天，只比日期分不出先后。
    const r = peek('T+1 上午填过、照着买了、没回来更新', { cash: PRINCIPAL, hold: 0, at: `${T1} 10:00` });
    console.log(`     提示 ${r.sub.split(' ⏎ ').find((x) => /注意/.test(x)) || '（没有过时提醒）'}`);
    if (/你有 \d+ 笔操作还没做/.test(r.line)) {
      bad(`[没更新] 填完之后账本又动过，系统分不清真没做还是没更新，不该断言「还没做」：「${r.line}」`);
    }
    if (!/若确实没做/.test(r.line)) bad(`[没更新] 主行没给「可能已经做了」留余地：「${r.line}」`);
    if (!/那之后账本又记了/.test(r.sub)) bad('[没更新] 副行没说清数字是哪天填的、之后账本动过几笔');
    if (!/改成现在的真实持仓|改一下下面两栏/.test(`${r.sub}${r.tm}`)) {
      bad('[没更新] 没告诉他「已经做过的话改一下数字就行」');
    }
  }

  // C. 数字已更新 → 恢复正常
  {
    const buy = orderAmount(PRINCIPAL, 0, WEIGHTS[1]).amount;
    const h = Math.floor(buy / ETF_PX / 100) * 100 * ETF_PX;
    const r = peek('已经回来更新了数字', { cash: Math.round(PRINCIPAL - h * (1 + COMMISSION)), hold: Math.round(h), at: T1 });
    if (/还没做|差 \d+ 档|补齐/.test(r.line)) bad(`[没更新] 数字更新后仍提示欠账：「${r.line}」`);
  }
}

console.log(`\n${fails ? `✗ 全流程有 ${fails} 处问题` : '✓ T / T+1 / T+2 三条路径全程畅通，无错报'}\n`);
process.exitCode = fails ? 1 : 0;
