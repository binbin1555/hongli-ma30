/**
 * 面板「闲钱放哪」卡片：跑的是 index.html 里的真代码（测试台见 harness.mjs）。
 *
 * 每个场景都核对：
 *   四格（红利 ETF / 缓冲垫现金 / 交银稳利 / 在途赎回款）显示的整数加起来，正好等于
 *   卡片合计、也正好等于「账户盈亏」里显示的总资产 —— 一元都不能差
 *   四格的占比加起来正好 100.0%，每一格和真实占比相差不超过 0.1 个百分点，彩条宽度与之一致
 *   每一格和核心函数 cashPlan 的结果相差不超过 2 元（取整时尾差只补在最大那一格上）
 *   在途款写出到账日、不满 7 天的交银写出可免费赎回的日期
 *   资金操作的文字、「下一次操作」卡片，和推送是同一句话；每一笔申赎另有一条蓝色横幅，金额一致
 * 另外把时钟拨到不同时刻，核对最上面那句「今天动不动资金」：
 *   操作日 15:00 前 → 要动资金；15:00 后 → 已截止并写出哪天补；前一晚 → 不用动、写出下一步；
 *   数据停更 → 数据没更新；没有操作 → 不用动
 *
 * 用法：npm run cashplan-panel（npm test 里也会跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---- 时钟：默认钉在北京时间今天 10:00，场景里可以拨到别的时刻 ---- */
const _REAL_NOW = Date.now();
const realToday = new Date(_REAL_NOW + 8 * 3600 * 1000).toISOString().slice(0, 10);
let FAKE = Date.parse(realToday + 'T02:00:00Z');
Date.now = () => FAKE;
const setNow = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); FAKE = Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3600000 + m * 60000; };

const { H, el, store, CAL, CORE, LAUNCH, D, put, at, pend, banners } = await import('./harness.mjs');
const { cashPlan, cashPlanLines, beijingDate, dayLabel } = CORE;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const P = 1000000;
const CFG = { schema: 1, startDate: LAUNCH, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
const toNum = (s) => Number(String(s).replace(/[^\d]/g, ''));
const NAME = { etf: '红利 ETF', buf: '缓冲垫', jy: '交银稳利', tr: '在途赎回款' };

/** 卡片上的四格：名字 → 显示的整数 / 占比 / 小字 */
function cardRows() {
  const out = {};
  const re = /<div class="ct" data-k="(\w+)"><span class="cl"><i [^>]*><\/i>[^<]*<\/span><b class="ca">([^<]*)<\/b><i class="cpct">([^<]*)<\/i>(?:<small>([^<]*)<\/small>)?<\/div>/g;
  for (const m of el('cashGrid').innerHTML.matchAll(re)) {
    out[NAME[m[1]]] = { n: toNum(m[2]), pct: Number(m[3].replace('%', '')), small: m[4] || '' };
  }
  const t = el('cashTot').innerHTML.match(/<b>([\d,]+)<\/b>/);
  out['合计'] = t ? { n: toNum(t[1]) } : null;
  return out;
}
/** 页面此刻会用的推算（和 cashNow() 同一组输入，另算一遍） */
function expectCP() {
  const st = H.S.state;
  return cashPlan({ rows: H.S.series.rows.filter((r) => r.d <= st.asof), entries: H.S.ledger.entries, principal: P,
    launchDate: st.launchDate, tradingDays: H.S.cal, cfg: H.S.cashcfg, pending: st.pending });
}
const head = () => ({ chip: el('cashStat').textContent, cls: el('cashCard').className, todo: el('cashTodo').textContent, sub: el('cashSub').innerHTML });

function scene(label, { tier = 0, chain = null, pending = null, cfg = CFG, principal = P, index = at(12000, 12100), now = [realToday, '10:00'] }) {
  console.log(`\n● ${label}`);
  setNow(...now);
  put({ tier, chain, pending, index });
  H.S = { ...H.S, cashcfg: cfg };
  if (principal) store.set('hlma30.principal', JSON.stringify(principal)); else store.delete('hlma30.principal');
  H.render();
  return { rows: cardRows(), cp: principal && cfg ? expectCP() : null };
}

function checkSums(label, rows, cp) {
  const keys = ['红利 ETF', '缓冲垫', '交银稳利', '在途赎回款'];
  const parts = keys.map((k) => rows[k] && rows[k].n);
  const tot = rows['合计'] && rows['合计'].n;
  const top = toNum(el('pnlTot').textContent);
  if (parts.some((x) => x == null || Number.isNaN(x)) || tot == null) return bad(`${label}：卡片缺格 ${JSON.stringify(rows)}`);
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum === tot && tot === top) ok(`四格 ${parts.map((x) => x.toLocaleString('en-US')).join(' + ')} = ${tot.toLocaleString('en-US')}，与「账户盈亏」总资产 ${top.toLocaleString('en-US')} 分毫不差`);
  else bad(`${label}：四格之和 ${sum}、卡片合计 ${tot}、上方总资产 ${top} 对不上`);
  const want = [cp.V, cp.buffer, cp.jiaoyin, cp.transit.reduce((a, t) => a + Math.round(t.amount), 0)];
  const off = parts.map((x, k) => Math.abs(x - want[k]));
  if (Math.max(...off) <= 2) ok(`每一格与核心推算相差不超过 2 元（${off.map((x) => x.toFixed(1)).join(' / ')}）`);
  else bad(`${label}：与核心推算差太多 ${JSON.stringify({ shown: parts, want: want.map(Math.round) })}`);
  // 占比
  const pcts = keys.map((k) => rows[k].pct);
  const psum = Math.round(pcts.reduce((a, b) => a + b, 0) * 10) / 10;
  const poff = pcts.map((p, k) => Math.abs(p - (parts[k] / tot) * 100));
  if (psum === 100 && Math.max(...poff) <= 0.1) ok(`占比 ${pcts.map((x) => `${x.toFixed(1)}%`).join(' + ')} = 100.0%，每格误差不超过 0.1 个百分点`);
  else bad(`${label}：占比 ${pcts.join(' / ')}（合计 ${psum}，最大误差 ${Math.max(...poff).toFixed(3)}）`);
  const widths = [...el('cashBar').innerHTML.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
  const nonzero = pcts.filter((x) => x > 0);
  if (JSON.stringify(widths) === JSON.stringify(nonzero)) ok('彩条每一段的宽度和占比一致'); else bad(`${label}：彩条宽度 ${widths} 与占比 ${nonzero} 不一致`);
}
/**
 * 推送里的每一行资金操作，卡片上都要有：要么原样出现在明细里，
 * 要么前半句已经是大字结论、明细里只留括号里的补充 —— 两处拼起来和推送一字不差。
 */
function checkLines(label, cp) {
  const lines = cashPlanLines(cp, beijingDate());
  const txt = el('cashSub').innerHTML, todo = el('cashTodo').textContent;
  const miss = lines.filter((x) => {
    if (txt.includes(x)) return false;
    const k = x.indexOf('元（');
    if (k < 0) return true;
    const lead = x.slice(0, k + 1), rest = x.slice(k + 2, -1);
    return !(todo.includes(lead) && txt.includes(rest) && !txt.includes(lead));
  });
  if (!miss.length) ok(lines.length ? `资金操作与推送同一套文字（${lines.length} 行，大字说过的半句不在明细里重复）` : '没有资金操作的文字要列');
  else bad(`${label}：卡片里缺了这几行 ${miss.join(' / ')}`);
}

/* ================================================================ */
console.log('\n【位置与折叠】');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const iNext = html.indexOf('<div id="nextCard">'), iCash = html.indexOf('id="cashCard"'), iPnl = html.indexOf('<p class="k">账户盈亏</p>');
  if (iNext > 0 && iNext < iCash && iCash < iPnl) ok('卡片排在「下一次操作」之后、「账户盈亏」之前'); else bad(`卡片位置不对：${iNext} / ${iCash} / ${iPnl}`);
  if (/<details class="how"><summary>这是怎么运作的<\/summary><div class="body note" id="cashNote">/.test(html)) ok('说明文字收在「这是怎么运作的」折叠块里，默认收起');
  else bad('说明文字应放进默认收起的折叠块');
}

{
  const { rows, cp } = scene('空仓、缓冲垫早已备好（没有要做的事）', { tier: 0, chain: [] });
  checkSums('空仓', rows, cp);
  const buf = rows['缓冲垫'].n, j = rows['交银稳利'].n;
  if (Math.abs(buf - j) <= 2) ok(`缓冲垫 ${buf.toLocaleString('en-US')} ≈ 交银 ${j.toLocaleString('en-US')}，各一半`); else bad(`空仓时应各一半：${buf} / ${j}`);
  const h = head();
  if (h.chip.endsWith('不用动资金') && /\bok\b/.test(h.cls) && h.todo === '资金都在目标上，不用动') ok(`状态「${h.chip}」（绿色）：${h.todo}`);
  else bad(`没有资金操作时状态不对：${JSON.stringify(h)}`);
  checkLines('空仓', cp);
}
{
  const { rows, cp } = scene('持仓 75%（0→1→2→3）', { tier: 3 });
  checkSums('75%', rows, cp);
  if (rows['交银稳利'].n === 0 && rows['在途赎回款'].n === 0) ok('交银已全部赎回、没有在途 —— 剩下的现金全在缓冲垫'); else bad(`75% 时交银应为 0：${JSON.stringify(rows)}`);
}
{
  // 25% → 50% 这一笔会把交银剩下的钱赎回来，赎回款要隔两个交易日才到
  const chain = [[40, 0, 1], [1, 1, 2]];
  const { rows, cp } = scene(`${D(1)} 刚从 25% 加到 50%：赎回款还在路上`, { tier: 2, chain });
  checkSums('在途', rows, cp);
  const t = cp.transit[0];
  const tr = rows['在途赎回款'];
  if (t && tr.n > 0 && Math.abs(tr.n - t.amount) <= 1 && /\d+ 月 \d+ 日（[^）]*）到账/.test(tr.small)) ok(`在途 ${tr.n.toLocaleString('en-US')} 元，写明「${tr.small}」`);
  else bad(`在途款应写出到账日：${JSON.stringify(tr)} / ${JSON.stringify(cp.transit)}`);
  if (rows['交银稳利'].n === 0) ok('交银这一笔赎空了'); else bad(`交银应为 0：${rows['交银稳利'].n}`);
}
{
  const chain = [[40, 0, 1], [3, 1, 0]];
  const { rows, cp } = scene(`${D(3)} 卖到空仓：多出来的钱 ${D(2)} 申购，交银里有新份额`, { tier: 0, chain });
  checkSums('新份额', rows, cp);
  const j = rows['交银稳利'];
  if (cp.young.length && /其中 [\d,]+ 元持有不满 7 天，\d+ 月 \d+ 日（[^）]*）起可免费赎回/.test(j.small)) ok(`交银小字：「${j.small}」`);
  else bad(`应写出不满 7 天的份额和可赎回日期：${JSON.stringify(j)} / ${JSON.stringify(cp.young)}`);
}
{
  const sig = H.S.state.asof;
  const { cp } = scene('空仓时出了买入挂单', { tier: 0, chain: [], pending: pend(sig, 0, 1), index: at(12400, 11900) });
  const lines = cashPlanLines(cp, beijingDate());
  const nextSub = el('nextSub').innerHTML;
  if (lines.length && nextSub.includes(`<b>资金：</b>${lines.join('；')}`)) ok(`「下一次操作」卡片：资金：${lines.join('；')}`);
  else bad(`「下一次操作」卡片里资金文字不对：${nextSub}`);
  const bs = banners();
  const red = cp.next.actions.find((a) => a.kind === 'REDEEM');
  const amt = red && Math.round(red.amount).toLocaleString('zh-CN');
  const tb = bs[0], cb = bs.find((b) => b.cash);
  if (tb && !tb.cash && red && tb.sub.includes(`还要赎回交银稳利约 ${amt} 元`) && tb.sub.includes('蓝色横幅')) ok('挂单横幅点明还要赎回多少、另有蓝色横幅');
  else bad(`挂单横幅应点明赎回：${tb && tb.sub}`);
  if (cb && bs.indexOf(cb) === 1 && cb.text === `赎回交银稳利约 ${amt} 元` && cb.btn.textContent === '已完成') ok(`紧跟一条蓝色横幅「${cb.text}」，按钮「已完成」`);
  else bad(`应紧跟一条赎回横幅：${JSON.stringify(bs.map((b) => [b.cash, b.text, b.btn.textContent]))}`);
  checkLines('挂单', cp);
}

console.log('\n【今天动不动资金：把时钟拨到不同时刻】');
{
  // 起用日定在数据日之后的第一个交易日：那天要先赎回一半交银稳利，把缓冲垫备好
  const asof = H.S.state.asof;
  const day = CAL.find((d) => d > asof);
  const cfg = { ...CFG, startDate: day };
  const lab = (d, today) => dayLabel(d, today).label;

  let r = scene(`${day} 10:00（操作日、还没到 15:00）`, { tier: 0, chain: [], cfg, now: [day, '10:00'] });
  let h = head();
  const red = r.cp.next.actions.find((a) => a.kind === 'REDEEM');
  if (h.chip === `${dayLabel(day, day).md}要动资金` && /\bact\b/.test(h.cls) && h.todo.startsWith(`${lab(day, day)}15:00 前赎回交银稳利约`)
      && red && h.todo.includes(Math.round(red.amount).toLocaleString('en-US'))) ok(`状态「${h.chip}」（红色）：${h.todo}`);
  else bad(`操作日上午应显示「要动资金」：${JSON.stringify(h)}`);
  checkSums('操作日', r.rows, r.cp);
  checkLines('操作日', r.cp);

  r = scene(`${day} 16:00（操作日、已过 15:00）`, { tier: 0, chain: [], cfg, now: [day, '16:00'] });
  h = head();
  const nd = CAL.find((d) => d > day);
  if (h.chip === '已过 15:00' && /\bwarn\b/.test(h.cls) && /已经截止/.test(h.todo) && h.sub.includes(`${lab(nd, day)}15:00 前补上`)) ok(`状态「${h.chip}」：${h.todo}；${h.sub.replace(/<[^>]+>/g, '').split('。')[0]}`);
  else bad(`过了 15:00 应提示截止并写出补做日：${JSON.stringify(h)}`);

  r = scene(`${asof} 21:30（前一晚，系统刚跑完）`, { tier: 0, chain: [], cfg, now: [asof, '21:30'] });
  h = head();
  if (h.chip === `${dayLabel(asof, asof).md}不用动资金` && h.todo.startsWith(`下一步：${lab(day, asof)}15:00 前赎回交银稳利约`)) ok(`状态「${h.chip}」：${h.todo}`);
  else bad(`前一晚应显示「不用动」并写出下一步：${JSON.stringify(h)}`);

  const later = CAL[CAL.indexOf(day) + 3];
  r = scene(`${later} 10:00（数据停在 ${asof}，好几个交易日没更新）`, { tier: 0, chain: [], cfg, now: [later, '10:00'] });
  h = head();
  if (h.chip === '数据没更新' && /\bwarn\b/.test(h.cls) && h.todo.startsWith('本该在 ')) ok(`状态「${h.chip}」：${h.todo}`);
  else bad(`数据停更时应明说：${JSON.stringify(h)}`);
}
{
  const fut = { ...CFG, startDate: CAL.find((d) => d > realToday) || '2099-01-02' };
  const { rows, cp } = scene(`起用日在将来（${fut.startDate}）`, { tier: 0, chain: [], cfg: fut });
  checkSums('未起用', rows, cp);
  const h = head();
  if (rows['缓冲垫'].n === 0 && /还没起用/.test(rows['缓冲垫'].small) && h.chip === '还没起用') ok(`状态「${h.chip}」：${h.todo}；缓冲垫 0，闲钱都在交银稳利`);
  else bad(`未起用时不对：${JSON.stringify({ rows, h })}`);
}
{
  scene('没设本金', { tier: 0, chain: [], principal: 0 });
  const h = head();
  if (!el('cashCard').hidden && h.todo === '设本金后显示' && el('cashGrid').innerHTML === '') ok(`状态「${h.chip}」：不编数字`); else bad(`没设本金时应提示：${JSON.stringify(h)}`);
}
{
  scene('没有 cashplan.json', { tier: 0, chain: [], cfg: null });
  if (el('cashCard').hidden) ok('卡片整张收起，页面其余部分照旧'); else bad('没有配置时卡片应收起');
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exitCode = fails ? 1 : 0;
