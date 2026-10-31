/**
 * 面板上的追高线：跑的是 index.html 里的真代码（测试台见 harness.mjs）。
 *
 *   卡片的状态标签跟着追高线走：未触发 / 拦截中 / 在线上方（还没到起用日）/ 算不出
 *   新版 Worker 还没跑过（state 里没有 chase）时，页面按行情现算，和核心函数同一个数，并且注明是现算的
 *   拦下买入的那天：「下一次操作」说不用操作，横幅单独一条（青色），点「知道了」永久收起、刷新也不回来
 *   chaselog 里更早拦下的那几笔，没点过的照样排着
 *   买入线本身还在追高线上方时，「下一次操作」提前说清楚跌到买入线也不一定会买
 *
 * 用法：npm run chase-panel（npm test 里也会跑）
 */
const _REAL_NOW = Date.now();
const realToday = new Date(_REAL_NOW + 8 * 3600 * 1000).toISOString().slice(0, 10);
Date.now = () => Date.parse(realToday + 'T02:00:00Z');   // 北京 10:00

const { H, el, store, CORE, put, at, SIG, banners, BASE, ROWS } = await import('./harness.mjs');
const { chaseState, chaseLine } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const M = 6000;
/** 追高线的几种状态：默认收盘比年线高 1%（线下方）；above 时高 5%；给了 line 就按它定年线 */
const C = (close, { above = false, ok: good = true, active = true, blocked = null, line = null } = {}) => {
  const ma250 = good ? (line ? line / 1.03 : close / (above ? 1.05 : 1.01)) : null;
  const ln = good ? ma250 * 1.03 : null;
  const up = good && close > ln;
  return {
    asof: BASE.asof, close, ma250, line: ln, dev: good ? close / ma250 - 1 : null,
    ok: good, problem: good ? null : '行情不足 250 个交易日，算不出年线',
    above: up, active, blocking: active && up, blocked,
  };
};
const CB = (close, signalDate = BASE.asof) => ({ signalDate, tierFrom: 0, tierTo: 1, close, ma250: close / 1.05, line: close / 1.05 * 1.03 });
const chaseBanners = () => banners().filter((b) => b.chase);
const clearAcks = () => { for (const k of [...store.keys()]) if (k.startsWith('hlma30.ack.')) store.delete(k); };

console.log('\n● 新版 Worker 还没跑过：页面按行情现算');
{
  put({ tier: 0, index: BASE.index, chain: [], chase: null });
  H.renderChase();
  const want = chaseState(ROWS, BASE.asof);
  const line = el('chaseLine').textContent;
  if (line === chaseLine(want, realToday)) ok(`和核心函数同一句：${line}`); else bad(`现算的状态行不对：${line}`);
  if (/页面按行情现算/.test(el('chaseNote').textContent)) ok('注明了是页面现算的'); else bad('没注明是现算的');
  if (el('chaseGrid').innerHTML.split('class="ct"').length - 1 === 3) ok('三格：收盘 / 年线 / 追高线'); else bad(`格子数不对：${el('chaseGrid').innerHTML}`);
}

console.log('\n● 状态标签');
for (const [name, c, want] of [
  ['收盘在追高线下方', C(M), '未触发'],
  ['收盘在追高线上方', C(M, { above: true }), '拦截中'],
  ['在线上方但还没到起用日', C(M, { above: true, active: false }), '在线上方'],
  ['算不出年线', C(M, { ok: false }), '算不出'],
]) {
  put({ tier: 0, index: at(M, M), chain: [], chase: c });
  H.renderChase();
  const chip = el('chaseStat').textContent;
  if (chip === want) ok(`${name} → 「${chip}」`); else bad(`${name}：标签是「${chip}」，应为「${want}」`);
}

console.log('\n● 拦下买入的那天');
{
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], chase: C(M * 0.96, { above: true, blocked: CB(M * 0.96) }) });
  H.renderInputDependent();
  const line = el('nextLine').textContent;
  if (/的买入信号被追高线拦下，不用操作/.test(line)) ok(`「下一次操作」：${line}`); else bad(`「下一次操作」没说被拦下：${line}`);
  if (!/系统还没记下这笔操作/.test(el('nextSub').textContent)) ok('没有误报「系统还没记下这笔操作」'); else bad('把追高线拦下误说成了系统没跑完');
  const cb = chaseBanners();
  if (cb.length === 1 && cb[0].text === '买入第 1 份被追高线拦下 不用操作' && cb[0].btn.textContent === '知道了') ok(`青色横幅：${cb[0].kick}｜${cb[0].text}｜[${cb[0].btn.textContent}]`);
  else bad(`横幅不对：${JSON.stringify(cb.map((b) => [b.kick, b.text]))}`);
  if (!banners().some((b) => b.gate)) ok('不会顺带冒出闸门的横幅'); else bad('追高线拦下的却出了闸门横幅');
  cb[0] && cb[0].btn.click();
  if (store.get(`hlma30.ack.chase:${BASE.asof}`) === 'true' && !chaseBanners().length) ok('点「知道了」永久收起（存 true，不是只收今天）');
  else bad(`确认标记：${store.get(`hlma30.ack.chase:${BASE.asof}`)}，横幅还剩 ${chaseBanners().length} 条`);
  H.renderInputDependent();
  if (!chaseBanners().length) ok('重画一遍也不回来'); else bad('重画后又冒出来了');
}

console.log('\n● chaselog 里更早拦下的几笔');
{
  clearAcks();
  const old = [CB(M * 0.95, SIG.past), CB(M * 0.97, BASE.asof)];
  put({ tier: 0, index: at(M, M), chain: [], chase: C(M), chaselog: { entries: old } });
  H.renderInputDependent();
  const cb = chaseBanners();
  if (cb.length === 2 && cb[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md) && cb[1].kick.includes(CORE.dayLabel(SIG.past, realToday).md)) ok('两笔都排着，新的在前');
  else bad(`应排两条：${JSON.stringify(cb.map((b) => b.kick))}`);
  cb[1] && cb[1].btn.click();
  const left = chaseBanners();
  if (left.length === 1 && left[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md)) ok('点掉旧的那条，新的还在'); else bad(`点一条连带收掉了别的：${JSON.stringify(left.map((b) => b.kick))}`);
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], chase: C(M * 0.96, { above: true, blocked: CB(M * 0.96) }), chaselog: { entries: [CB(M * 0.96)] } });
  H.renderInputDependent();
  if (chaseBanners().length === 1) ok('chaselog 和 state 里是同一笔：只排一条'); else bad(`重复了：${chaseBanners().length} 条`);
}

console.log('\n● 买入线还在追高线上方');
{
  put({ tier: 0, index: at(M, M), chain: [], chase: C(M, { line: M * 0.9 }) });
  H.renderInputDependent();
  if (/追高线：买入线 [\d,]+ 还在追高线（[\d,]+，年线 × 1\.03）上方/.test(el('nextSub').textContent)) ok('「下一次操作」提前说了：跌到买入线也不一定会买'); else bad(`没提醒：${el('nextSub').textContent}`);
  put({ tier: 0, index: at(M, M), chain: [], chase: C(M, { line: M * 1.05 }) });
  H.renderInputDependent();
  if (!/追高线/.test(el('nextSub').textContent)) ok('买入线在追高线下方时不多嘴'); else bad(`不该提追高线：${el('nextSub').textContent}`);
}

console.log('\n● 数据说明');
{
  put({ tier: 0, index: at(M, M), chain: [] });
  H.render();
  if (/追高线只用 H00922/.test(el('dataNote').innerHTML)) ok('数据来源里写了追高线只用 H00922'); else bad('数据来源没提追高线');
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 面板追高线全部通过'}\n`);
process.exit(fails ? 1 : 0);
