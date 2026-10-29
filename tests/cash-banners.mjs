/**
 * 资金上的买卖也要横幅：赎回 / 申购交银稳利、缓冲垫不够时的补买。
 *
 * 和买卖红利的横幅同一条铁律 —— 不点就不消失：
 *   将要做的（明晚之后的那一笔）  → 「知道了」只收起当天，到了那天再出现
 *   就是今天、15:00 前            → 「已完成」才收起；不点就一直挂着
 *   就是今天、过了 15:00          → 说已截止、写出哪天补
 *   已经按规则当作做了的          → 追问「你做了吗？」，「我做了」才收起
 * 将要做的那条和事后追问的那条是同一笔，共用一个确认标记：点过「已完成」，晚上记完不会再问一遍。
 * 它们的确认标记和买卖红利的互不相干 —— 点一条不会连带收掉另一条。
 * 金额和核心函数 cashPlan 推算的一致，同一天先说买卖红利、再说申赎、最后说补买。
 *
 * 用法：npm run cash-banners（npm test 里也会跑）
 */

/* ---- 时钟：场景里拨到不同时刻 ---- */
let FAKE = Date.now();
Date.now = () => FAKE;
const setNow = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000; };

const { H, store, CAL, CORE, LAUNCH, D, put, at, pend, banners } = await import('./harness.mjs');
const { cashPlan, dayLabel } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const P = 1000000;
const CFG = { schema: 1, startDate: LAUNCH, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
const yuan = (n) => Math.round(n).toLocaleString('zh-CN');
const ackOf = (key) => { const v = store.get(`hlma30.ack.${key}`); return v == null ? null : JSON.parse(v); };
const clearAcks = () => { for (const k of [...store.keys()]) if (k.startsWith('hlma30.ack.') || k.startsWith('hlma30.notice.')) store.delete(k); };
const show = (bs) => bs.map((b) => `${b.cash ? '[蓝]' : b.catchup ? '[补]' : b.sell ? '[绿]' : '[红]'} ${b.kick}｜${b.text}｜[${b.btn.textContent}]`).join('\n        ');

/** 摆好数据、拨好时钟、画横幅；asof 可以往前拨（模拟「系统还没跑那天」） */
function scene(label, { tier = 0, chain = [], pending = null, cfg = CFG, asof = null, now, principal = P, keepAcks = true }) {
  console.log(`\n● ${label}`);
  setNow(...now);
  if (!keepAcks) clearAcks();
  put({ tier, chain, pending, index: at(12000, 12100) });
  if (asof) H.S.state.asof = asof;
  H.S = { ...H.S, cashcfg: cfg };
  if (principal) store.set('hlma30.principal', JSON.stringify(principal)); else store.delete('hlma30.principal');
  H.renderInputDependent();
  const st = H.S.state;
  const cp = principal && cfg ? cashPlan({ rows: H.S.series.rows.filter((r) => r.d <= st.asof), entries: H.S.ledger.entries, principal,
    launchDate: st.launchDate, tradingDays: H.S.cal, cfg, pending: st.pending, trace: true }) : null;
  const bs = banners();
  console.log(`        ${show(bs) || '（没有横幅）'}`);
  return { bs, cp };
}

const prev = D(2), last = D(1);              // 数据的倒数第二天、最后一天
const after = (d, n = 1) => CAL[CAL.indexOf(d) + n];
const L = (d, today) => dayLabel(d, today).label;

console.log('\n【一】一笔赎回的一生：前一晚预告 → 当天提醒 → 晚上记完不再问');
{
  const cfg = { ...CFG, startDate: last };   // last 那天起用：要先赎回一半交银，把缓冲垫备好
  let r = scene(`${prev} 21:30：明天（${last}）起用缓冲垫`, { cfg, asof: prev, now: [prev, '21:30'], keepAcks: false });
  const red = r.cp.next.actions.find((a) => a.kind === 'REDEEM');
  const b = r.bs.find((x) => x.cash);
  if (!red || red.day !== last) bad(`剧本没造出 ${last} 的赎回：${JSON.stringify(r.cp.next.actions)}`);
  else if (b && b.text === `赎回交银稳利约 ${yuan(red.amount)} 元` && b.kick.includes(L(last, prev)) && b.btn.textContent === '知道了') {
    ok(`蓝色横幅「${b.text}」，标着 ${L(last, prev)}15:00 前，按钮「知道了」`);
  } else bad(`前一晚应预告赎回：${show(r.bs)}`);
  if (b && /现在还做不了/.test(b.sub) && b.sub.includes(`到了 ${dayLabel(last, prev).md}`)) ok('说清现在还做不了、到那天会再出现'); else bad(`前一晚的说明不对：${b && b.sub}`);
  if (b) b.btn.click();
  const a1 = ackOf(`cash:REDEEM:${last}`);
  if (a1 === prev && !banners().some((x) => x.cash)) ok(`点「知道了」只收起 ${prev} 这一天（记的是日期，不是永久）`);
  else bad(`「知道了」应只收起当天：ack=${JSON.stringify(a1)}，横幅 ${show(banners())}`);

  r = scene(`${last} 10:00：就是今天，还没到 15:00`, { cfg, asof: prev, now: [last, '10:00'] });
  const b2 = r.bs.find((x) => x.cash);
  if (b2 && b2.btn.textContent === '已完成' && b2.text === `赎回交银稳利约 ${yuan(red.amount)} 元`) ok(`到了那天又出现了，按钮「已完成」`);
  else bad(`当天应再次出现、按钮「已完成」：${show(r.bs)}`);
  if (b2 && b2.sub.includes(`系统会在 ${dayLabel(last, last).md}当晚 21:00 按规则当作你已经赎回了`)) ok('写明当晚 21:00 不管做没做都照规则往下算'); else bad(`缺少「照规则往下算」的警告：${b2 && b2.sub}`);

  r = scene(`${last} 16:00：还没点，已过 15:00`, { cfg, asof: prev, now: [last, '16:00'] });
  const b3 = r.bs.find((x) => x.cash);
  const nx = after(last);
  if (b3 && b3.kick.includes('15:00 已过') && b3.sub.includes(`请在 ${L(nx, last)}15:00 前补上`) && b3.btn.textContent === '已完成') ok(`过了 15:00：说已截止，写出 ${L(nx, last)}15:00 前补上`);
  else bad(`过了 15:00 应说截止并写出补做日：${b3 && `${b3.kick}｜${b3.sub}`}`);

  r = scene(`${after(last, 2)} 10:00：数据停在 ${prev}，这笔过期了`, { cfg, asof: prev, now: [after(last, 2), '10:00'] });
  const b4 = r.bs.find((x) => x.cash);
  if (b4 && /已过期/.test(b4.kick) && b4.btn.textContent === '已完成') ok(`过期没点：横幅还在，标着「${b4.kick}」`); else bad(`过期的那笔不该消失：${show(r.bs)}`);

  r = scene(`${last} 10:00：点「已完成」`, { cfg, asof: prev, now: [last, '10:00'] });
  const bDone = r.bs.find((x) => x.cash);
  if (bDone) bDone.btn.click(); else bad('当天上午应有这条横幅可点');
  if (ackOf(`cash:REDEEM:${last}`) === true && !banners().some((x) => x.cash)) ok('「已完成」永久收起'); else bad(`「已完成」应永久收起：${JSON.stringify(ackOf(`cash:REDEEM:${last}`))}`);

  r = scene(`${last} 21:30：系统跑完，这笔已按规则记上`, { cfg, now: [last, '21:30'] });
  const evt = r.cp.events.find((e) => e.kind === 'REDEEM' && e.d === last);
  if (!evt) bad('剧本里当天应有赎回记录');
  else if (!r.bs.some((x) => x.cash)) ok(`当天点过「已完成」，晚上不再追问（同一笔共用确认标记 cash:REDEEM:${last}）`);
  else bad(`点过「已完成」还在追问：${show(r.bs)}`);

  clearAcks();
  r = scene(`${last} 21:30：要是白天没点`, { cfg, now: [last, '21:30'] });
  const b5 = r.bs.find((x) => x.cash);
  if (evt && b5 && b5.text === `赎回交银稳利约 ${yuan(evt.amount)} 元 你做了吗？` && b5.btn.textContent === '我做了' && /已按规则推算/.test(b5.kick)) {
    ok(`追问「${b5.text}」，按钮「我做了」，金额与当天推算一致`);
  } else bad(`没点的那笔晚上应追问：${show(r.bs)}`);
  if (b5 && b5.sub.includes(`请在 ${L(after(last), last)}15:00 前补上`)) ok(`没做的话写出 ${L(after(last), last)}15:00 前补上`); else bad(`追问里应写补做日：${b5 && b5.sub}`);
  r = scene(`${after(last)} 09:00：第二天早上，还没点`, { cfg, now: [after(last), '09:00'] });
  const b6 = r.bs.find((x) => x.cash);
  if (b6 && b6.sub.includes(`请在 ${L(after(last), after(last))}15:00 前补上`)) ok('第二天 15:00 前打开：补做日就是当天'); else bad(`第二天早上的补做日不对：${b6 && b6.sub}`);
  if (b6) b6.btn.click();
  if (ackOf(`cash:REDEEM:${last}`) === true && !banners().some((x) => x.cash)) ok('点「我做了」永久收起'); else bad('「我做了」应永久收起');
}

console.log('\n【二】卖出后申购交银：和卖出横幅各管各的');
{
  // 25% 仓位、挂着卖到空仓：卖出那天的下一个交易日要把多出来的钱申购交银
  const chain = [[40, 0, 1]];
  const r = scene(`${last} 21:30：挂单 ${after(last)} 卖出`, { tier: 1, chain, pending: pend(last, 1, 0), now: [last, '21:30'], keepAcks: false });
  const sub = r.cp.next.actions.find((a) => a.kind === 'SUBSCRIBE');
  const t = r.bs[0], c = r.bs.find((x) => x.cash);
  if (!sub) bad(`剧本没造出申购：${JSON.stringify(r.cp.next.actions)}`);
  else {
    if (t && !t.cash && t.sell && c && r.bs.indexOf(c) === 1) ok('卖出横幅排第一，紧跟着申购横幅'); else bad(`排序不对：${show(r.bs)}`);
    if (c && c.text === `申购交银稳利约 ${yuan(sub.amount)} 元` && c.kick.includes(L(sub.day, last)) && c.btn.textContent === '知道了') ok(`「${c.text}」标着 ${L(sub.day, last)}15:00 前`);
    else bad(`申购横幅不对：${c && `${c.kick}｜${c.text}`}`);
    if (t && t.sub.includes(`还要申购交银稳利约 ${yuan(sub.amount)} 元（${dayLabel(sub.day, last).md} 15:00 前）`)) ok('卖出横幅里点了一句「还要申购」'); else bad(`卖出横幅应点明申购：${t && t.sub}`);
  }
  if (t) t.btn.click();
  const left = banners();
  if (left.some((x) => x.cash) && !left.some((x) => !x.cash && !x.catchup && !/你做了吗/.test(x.text))) ok('收起卖出横幅，申购横幅还在');
  else bad(`点卖出横幅连带影响了申购横幅：${show(left)}`);
  const c2 = left.find((x) => x.cash);
  if (c2) c2.btn.click();
  if (ackOf(last) === last && sub && ackOf(`cash:SUBSCRIBE:${sub.day}`) === last) ok('两条各记各的确认标记');
  else bad(`确认标记串了：${JSON.stringify({ trade: ackOf(last), cash: sub && ackOf(`cash:SUBSCRIBE:${sub.day}`) })}`);
}

console.log('\n【三】攒了一堆没确认：买卖和申赎按日期混排，汇总条能一次清掉');
{
  const chain = [[40, 0, 1], [30, 1, 2], [3, 2, 1]];
  const r = scene(`${last} 21:30：起算以来的买卖和申赎都没点过`, { tier: 1, chain, now: [last, '21:30'], keepAcks: false });
  const cashEv = r.cp.events.filter((e) => e.kind === 'REDEEM' || e.kind === 'SUBSCRIBE');
  const total = cashEv.length + chain.length + r.cp.shorts.length;
  const roll = r.bs.find((x) => /还有 \d+ 笔没确认/.test(x.text));
  const shown = r.bs.filter((x) => x !== roll).length;
  if (total > 5 && shown === 5 && roll && roll.text === `还有 ${total - 5} 笔没确认`) ok(`共 ${total} 笔（买卖 ${chain.length}、申赎 ${cashEv.length}）：排 5 条 + 汇总「${roll.text}」`);
  else bad(`应排 5 条 + 汇总 ${total - 5} 笔：${show(r.bs)}`);
  // 最新的排最前：倒数第 2 天的申购（卖出后那天），然后是倒数第 3 天的卖出；最早那两笔赎回进了汇总。
  // 申购取最近的那笔：行情越攒越长，起算以来缓冲垫漂移也会冒出别的申购（10 月下旬就多了一笔 9 月 18 日的），
  // 取最早那笔就会拿错比较对象
  const subEv = cashEv.filter((e) => e.kind === 'SUBSCRIBE').pop();
  const b0 = r.bs[0], b1 = r.bs[1];
  if (subEv && b0.cash && b0.text.startsWith(`申购交银稳利约 ${yuan(subEv.amount)} 元`) && b0.kick.includes(dayLabel(subEv.d, last).label) && !b1.cash && b1.sell) {
    ok(`最新的在最前：${b0.text}，然后才是 ${D(3)} 那笔卖出`);
  } else bad(`排序不对：${show(r.bs)}`);
  if (roll && /赎回交银稳利/.test(roll.sub)) ok(`汇总条认得申赎：${roll.sub.split('。')[0]}`); else bad(`汇总条应列出申赎：${roll && roll.sub}`);
  if (roll) roll.btn.click();
  const after1 = banners();
  if (after1.length === 5 && !after1.some((x) => /还有 \d+ 笔没确认/.test(x.text))) ok('「这些我都做了」只清掉汇总里那几笔，排着的 5 条还在'); else bad(`汇总清完不对：${show(after1)}`);
  for (let k = 0; k < 10 && banners().length; k++) banners()[0].btn.click();
  const keys = [...store.keys()].filter((k) => k.startsWith('hlma30.ack.cash:'));
  if (!banners().length && keys.length === cashEv.length) ok(`逐条点完，一条不剩；申赎各留一个确认标记（${keys.length} 个）`); else bad(`没清干净：${show(banners())} / ${keys.length}`);
}

console.log('\n【四】缓冲垫不够、那笔没买够：补买横幅');
{
  const cfg = { ...CFG, startDate: last };   // 起用当天就买入：缓冲垫的钱还在路上
  const r = scene(`${last} 21:30：${last} 起用当天就买入了 25%`, { tier: 1, chain: [[1, 0, 1]], cfg, now: [last, '21:30'], keepAcks: false });
  const s = r.cp.shorts[0];
  const kinds = r.bs.map((x) => (x.catchup ? '补买' : x.cash ? '申赎' : '买卖'));
  const cb = r.bs.find((x) => x.catchup);
  if (!s) bad('剧本应造出「没买够」');
  else if (cb && cb.text === `补买红利 ETF 约 ${yuan(s.gap)} 元 你做了吗？` && cb.btn.textContent === '我做了' && cb.sub.includes(`${L(s.until, last)}赎回款到账后`)) {
    ok(`「${cb.text}」，写明 ${L(s.until, last)}赎回款到账后补`);
  } else bad(`补买横幅不对：${show(r.bs)}`);
  if (JSON.stringify(kinds) === JSON.stringify(['买卖', '申赎', '补买'])) ok('同一天：先买卖、再申赎、最后补买'); else bad(`同一天的顺序不对：${kinds.join(' → ')}`);
  if (cb) cb.btn.click();
  if (s && ackOf(`cash:CATCHUP:${s.date}`) === true && banners().length === 2) ok('点「我做了」只收起补买这一条'); else bad(`补买确认不对：${show(banners())}`);
}

console.log('\n【五】没设本金 / 没有 cashplan.json：不出资金横幅，买卖横幅照旧');
for (const [label, o] of [['没设本金', { principal: 0 }], ['没有配置', { cfg: null }]]) {
  const r = scene(label, { tier: 1, chain: [[1, 0, 1]], now: [last, '21:30'], keepAcks: false, ...o });
  if (!r.bs.some((x) => x.cash || x.catchup) && r.bs.length === 1) ok(`${label}：只有那笔买入的横幅`); else bad(`${label}：${show(r.bs)}`);
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exitCode = fails ? 1 : 0;
