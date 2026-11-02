/**
 * 面板上的暴跌刹车：跑的是 index.html 里的真代码（测试台见 harness.mjs）。
 *
 *   卡片的状态标签跟着刹车走：未触发 / 波动偏高 / 拦截中 / 条件已满足（还没到起用日）/ 算不出
 *   新版 Worker 还没跑过（state 里没有 brake）时，页面按行情现算，和核心函数同一个数，并且注明是现算的
 *   拦下买入的那天：「下一次操作」说不用操作，横幅单独一条（棕色），点「知道了」永久收起、刷新也不回来
 *   brakelog 里更早拦下的那几笔，没点过的照样排着
 *   波动率已经超过 40% 时，「下一次操作」提前说清楚跌到买入线也不一定会买
 *
 * 用法：npm run brake-panel（npm test 里也会跑）
 */
const _REAL_NOW = Date.now();
const realToday = new Date(_REAL_NOW + 8 * 3600 * 1000).toISOString().slice(0, 10);
Date.now = () => Date.parse(realToday + 'T02:00:00Z');   // 北京 10:00

const { H, el, store, CORE, put, at, SIG, banners, BASE, ROWS } = await import('./harness.mjs');
const { brakeState, brakeLine } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const M = 6000;
/** 刹车的几种状态：默认波动率 16%、收盘在年线下方 7%；hot 时波动率 52%；below=false 时收盘在年线上方 2% */
const B = (close, { hot = false, below = true, ok: good = true, active = true, blocked = null } = {}) => {
  const ma250 = good ? (below ? close * 1.08 : close / 1.02) : null;
  const vol = good ? (hot ? 0.52 : 0.16) : null;
  return {
    asof: BASE.asof, close, ma250, vol,
    ok: good, problem: good ? null : '行情不足 250 个交易日，算不出年线',
    below: good && below, hot: good && hot, active, blocking: good && active && hot && below, blocked,
  };
};
const BB = (close, signalDate = BASE.asof) => ({ signalDate, tierFrom: 0, tierTo: 1, close, ma250: close * 1.08, vol: 0.52 });
const brakeBanners = () => banners().filter((b) => b.brake);
const clearAcks = () => { for (const k of [...store.keys()]) if (k.startsWith('hlma30.ack.')) store.delete(k); };

console.log('\n● 新版 Worker 还没跑过：页面按行情现算');
{
  put({ tier: 0, index: BASE.index, chain: [], brake: null });
  H.renderBrake();
  const want = brakeState(ROWS, BASE.asof);
  const line = el('brakeLine').textContent;
  if (line === brakeLine(want, realToday)) ok(`和核心函数同一句：${line}`); else bad(`现算的状态行不对：${line}`);
  if (/页面按行情现算/.test(el('brakeNote').textContent)) ok('注明了是页面现算的'); else bad('没注明是现算的');
  if (el('brakeGrid').innerHTML.split('class="ct"').length - 1 === 3) ok('三格：波动率 / 年线 / 收盘'); else bad(`格子数不对：${el('brakeGrid').innerHTML}`);
}

console.log('\n● 状态标签');
for (const [name, b, want] of [
  ['波动率不到 40%', B(M), '未触发'],
  ['波动率超过 40% 但在年线上方', B(M, { hot: true, below: false }), '波动偏高'],
  ['波动率超过 40% 又在年线下方', B(M, { hot: true }), '拦截中'],
  ['条件满足但还没到起用日', B(M, { hot: true, active: false }), '条件已满足'],
  ['算不出年线', B(M, { ok: false }), '算不出'],
]) {
  put({ tier: 0, index: at(M, M), chain: [], brake: b });
  H.renderBrake();
  const chip = el('brakeStat').textContent;
  if (chip === want) ok(`${name} → 「${chip}」`); else bad(`${name}：标签是「${chip}」，应为「${want}」`);
}

console.log('\n● 拦下买入的那天');
{
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], brake: B(M * 0.96, { hot: true, blocked: BB(M * 0.96) }) });
  H.renderInputDependent();
  const line = el('nextLine').textContent;
  if (/的买入信号被暴跌刹车拦下，不用操作/.test(line)) ok(`「下一次操作」：${line}`); else bad(`「下一次操作」没说被拦下：${line}`);
  if (!/系统还没记下这笔操作/.test(el('nextSub').textContent)) ok('没有误报「系统还没记下这笔操作」'); else bad('把刹车拦下误说成了系统没跑完');
  const bb = brakeBanners();
  if (bb.length === 1 && bb[0].text === '买入第 1 份被暴跌刹车拦下 不用操作' && bb[0].btn.textContent === '知道了') ok(`棕色横幅：${bb[0].kick}｜${bb[0].text}｜[${bb[0].btn.textContent}]`);
  else bad(`横幅不对：${JSON.stringify(bb.map((b) => [b.kick, b.text]))}`);
  if (!banners().some((b) => b.gate || b.chase)) ok('不会顺带冒出闸门或追高线的横幅'); else bad('刹车拦下的却出了别的横幅');
  bb[0] && bb[0].btn.click();
  if (store.get(`hlma30.ack.brake:${BASE.asof}`) === 'true' && !brakeBanners().length) ok('点「知道了」永久收起（存 true，不是只收今天）');
  else bad(`确认标记：${store.get(`hlma30.ack.brake:${BASE.asof}`)}，横幅还剩 ${brakeBanners().length} 条`);
  H.renderInputDependent();
  if (!brakeBanners().length) ok('重画一遍也不回来'); else bad('重画后又冒出来了');
}

console.log('\n● brakelog 里更早拦下的几笔');
{
  clearAcks();
  const old = [BB(M * 0.95, SIG.past), BB(M * 0.97, BASE.asof)];
  put({ tier: 0, index: at(M, M), chain: [], brake: B(M), brakelog: { entries: old } });
  H.renderInputDependent();
  const bb = brakeBanners();
  if (bb.length === 2 && bb[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md) && bb[1].kick.includes(CORE.dayLabel(SIG.past, realToday).md)) ok('两笔都排着，新的在前');
  else bad(`应排两条：${JSON.stringify(bb.map((b) => b.kick))}`);
  bb[1] && bb[1].btn.click();
  const left = brakeBanners();
  if (left.length === 1 && left[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md)) ok('点掉旧的那条，新的还在'); else bad(`点一条连带收掉了别的：${JSON.stringify(left.map((b) => b.kick))}`);
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], brake: B(M * 0.96, { hot: true, blocked: BB(M * 0.96) }), brakelog: { entries: [BB(M * 0.96)] } });
  H.renderInputDependent();
  if (brakeBanners().length === 1) ok('brakelog 和 state 里是同一笔：只排一条'); else bad(`重复了：${brakeBanners().length} 条`);
}

console.log('\n● 波动率已经超过 40%');
{
  put({ tier: 0, index: at(M, M), chain: [], brake: B(M, { hot: true, below: false }) });
  H.renderInputDependent();
  if (/暴跌刹车：20 日波动率 52\.0% 已超过 40% —— 跌到买入线时收盘若在年线（[\d,]+）下方，这笔买入不会执行/.test(el('nextSub').textContent)) ok('「下一次操作」提前说了：跌到买入线也不一定会买');
  else bad(`没提醒：${el('nextSub').textContent}`);
  put({ tier: 0, index: at(M, M), chain: [], brake: B(M) });
  H.renderInputDependent();
  if (!/暴跌刹车/.test(el('nextSub').textContent)) ok('波动率不到 40% 时不多嘴'); else bad(`不该提刹车：${el('nextSub').textContent}`);
}

console.log('\n● 数据说明');
{
  put({ tier: 0, index: at(M, M), chain: [] });
  H.render();
  if (/暴跌刹车同样只用 H00922/.test(el('dataNote').innerHTML)) ok('数据来源里写了暴跌刹车只用 H00922'); else bad('数据来源没提暴跌刹车');
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 面板暴跌刹车全部通过'}\n`);
process.exit(fails ? 1 : 0);
