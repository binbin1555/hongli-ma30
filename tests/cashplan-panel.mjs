/**
 * 面板「闲钱放哪」卡片：跑的是 index.html 里的真代码（测试台见 harness.mjs）。
 *
 * 每个场景都核对：
 *   四项（红利 ETF / 缓冲垫 / 在途赎回款 / 交银稳利）显示出来的整数，加起来正好等于
 *   卡片里的合计，也正好等于上方「账户盈亏」里显示的总资产 —— 一元都不能差
 *   每一项和核心函数 cashPlan 的结果相差不超过 2 元（取整时尾差只补在最大那一项上）
 *   在途款写出到账日、不满 7 天的交银写出可免费赎回的日期
 *   接下来的资金操作、「下一次操作」卡片、横幅里的资金文字，和推送是同一句话
 *
 * 用法：npm run cashplan-panel（npm test 里也会跑）
 */
const _REAL_NOW = Date.now();
Date.now = () => {   // 钉在北京时间盘中 10:00，日期跟着今天走（与 wording.mjs 相同）
  const d = new Date(_REAL_NOW + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return Date.parse(d + 'T02:00:00Z');
};

const { H, el, store, ROWS, CAL, CORE, LAUNCH, D, put, at, pend, banners } = await import('./harness.mjs');
const { cashPlan, cashPlanLines, beijingDate } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const P = 1860000;
const TODAY = beijingDate();
const CFG = { schema: 1, startDate: LAUNCH, bufferRatio: 0.5, arriveDays: 2, minHoldDays: 7, driftPct: 0.01 };
const toNum = (s) => Number(String(s).replace(/[^\d]/g, ''));

/** 卡片上每一行：标签 → 显示的整数 + 小字 */
function cardRows() {
  const out = {};
  for (const m of el('cashRows').innerHTML.matchAll(/<div[^>]*><span>([^<]+)<\/span><b>([^<]*)(?:<small>([^<]*)<\/small>)?<\/b><\/div>/g)) {
    out[m[1]] = { n: /\d/.test(m[2]) ? toNum(m[2]) : null, raw: m[2], small: m[3] || '' };
  }
  return out;
}
/** 页面此刻会用的推算（和 cashNow() 同一组输入，另算一遍） */
function expectCP() {
  const st = H.S.state;
  return cashPlan({ rows: H.S.series.rows.filter((r) => r.d <= st.asof), entries: H.S.ledger.entries, principal: P,
    launchDate: st.launchDate, tradingDays: H.S.cal, cfg: H.S.cashcfg, pending: st.pending });
}

function scene(label, { tier = 0, chain = null, pending = null, cfg = CFG, principal = P, index = at(12000, 12100) }) {
  console.log(`\n● ${label}`);
  put({ tier, chain, pending, index });
  H.S = { ...H.S, cashcfg: cfg };
  if (principal) store.set('hlma30.principal', JSON.stringify(principal)); else store.delete('hlma30.principal');
  H.render();
  return { rows: cardRows(), cp: principal && cfg ? expectCP() : null };
}

function checkSums(label, rows, cp) {
  const parts = ['红利 ETF', '缓冲垫（当天可用）', '在途赎回款', '交银稳利'].map((k) => rows[k] && rows[k].n);
  const tot = rows['合计（＝上方总资产）'] && rows['合计（＝上方总资产）'].n;
  const top = toNum(el('pnlTot').textContent);
  if (parts.some((x) => x == null) || tot == null) return bad(`${label}：卡片缺行 ${JSON.stringify(rows)}`);
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum === tot && tot === top) ok(`四项 ${parts.map((x) => x.toLocaleString('en-US')).join(' + ')} = ${tot.toLocaleString('en-US')}，与上方总资产 ${top.toLocaleString('en-US')} 分毫不差`);
  else bad(`${label}：四项之和 ${sum}、卡片合计 ${tot}、上方总资产 ${top} 对不上`);
  const want = [cp.V, cp.buffer, cp.transit.reduce((a, t) => a + Math.round(t.amount), 0), cp.jiaoyin];
  const off = parts.map((x, k) => Math.abs(x - want[k]));
  if (Math.max(...off) <= 2) ok(`每一项与核心推算相差不超过 2 元（${off.map((x) => x.toFixed(1)).join(' / ')}）`);
  else bad(`${label}：与核心推算差太多 ${JSON.stringify({ shown: parts, want: want.map(Math.round) })}`);
}
function checkNext(label, cp) {
  const lines = cashPlanLines(cp, TODAY);
  const txt = el('cashNext').innerHTML;
  const miss = lines.filter((x) => !txt.includes(x));
  if (!miss.length) ok(lines.length ? `资金操作与推送同一套文字（${lines.length} 行）` : '没有资金操作时明说「没有要做的资金操作」');
  else bad(`${label}：卡片里缺了这几行 ${miss.join(' / ')}`);
  if (!lines.length && !/没有要做的资金操作/.test(txt)) bad(`${label}：没有操作时应明说`);
}

/* ================================================================ */
{
  const { rows, cp } = scene('空仓、缓冲垫早已备好', { tier: 0, chain: [] });
  checkSums('空仓', rows, cp);
  const buf = rows['缓冲垫（当天可用）'].n, j = rows['交银稳利'].n;
  if (Math.abs(buf - j) <= 2) ok(`缓冲垫 ${buf.toLocaleString('en-US')} ≈ 交银 ${j.toLocaleString('en-US')}，各一半`); else bad(`空仓时应各一半：${buf} / ${j}`);
  checkNext('空仓', cp);
}
{
  const { rows, cp } = scene('持仓 75%（0→1→2→3）', { tier: 3 });
  checkSums('75%', rows, cp);
  if (rows['交银稳利'].n === 0 && rows['在途赎回款'].n === 0) ok('交银已全部赎回、没有在途 —— 剩下的现金全在缓冲垫'); else bad(`75% 时交银应为 0：${JSON.stringify(rows)}`);
  checkNext('75%', cp);
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
  const lines = cashPlanLines(cp, TODAY);
  const nextSub = el('nextSub').innerHTML;
  if (lines.length && nextSub.includes(`<b>资金：</b>${lines.join('；')}`)) ok(`「下一次操作」卡片：资金：${lines.join('；')}`);
  else bad(`「下一次操作」卡片里资金文字不对：${nextSub}`);
  const bn = banners().find((b) => !/你做了吗/.test(b.text));
  if (bn && bn.sub.includes(lines[0])) ok('挂单横幅里同样写着赎回安排'); else bad(`横幅里缺资金安排：${bn && bn.sub}`);
  checkNext('挂单', cp);
}
{
  const fut = { ...CFG, startDate: CAL.find((d) => d > TODAY) || '2099-01-02' };
  const { rows, cp } = scene(`起用日在将来（${fut.startDate}）`, { tier: 0, chain: [], cfg: fut });
  checkSums('未起用', rows, cp);
  if (rows['缓冲垫（当天可用）'].n === 0 && /还没起用/.test(rows['缓冲垫（当天可用）'].small)) ok('还没起用：缓冲垫 0，闲钱都在交银稳利');
  else bad(`未起用时缓冲垫应为 0：${JSON.stringify(rows)}`);
}
{
  scene('没设本金', { tier: 0, chain: [], principal: 0 });
  if (!el('cashCard').hidden && /设本金后显示/.test(el('cashRows').innerHTML)) ok('卡片显示「设本金后显示」，不编数字'); else bad(`没设本金时应提示：${el('cashRows').innerHTML}`);
}
{
  scene('没有 cashplan.json', { tier: 0, chain: [], cfg: null });
  if (el('cashCard').hidden) ok('卡片整张收起，页面其余部分照旧'); else bad('没有配置时卡片应收起');
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exitCode = fails ? 1 : 0;
