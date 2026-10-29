/**
 * 面板上的闸门：跑的是 index.html 里的真代码（测试台见 harness.mjs）。
 *
 *   卡片的状态标签跟着闸门走：未上膛 / 已上膛 / 拦截中 / 数据异常
 *   新版 Worker 还没跑过（state 里没有 gate）时，页面按行情现算，和核心函数同一个数，并且注明是现算的
 *   拦下买入的那天：「下一次操作」说不用操作，横幅单独一条（紫色），点「知道了」永久收起、刷新也不回来
 *   gatelog 里更早拦下的那几笔，没点过的照样排着
 *   第 11 项检查在「设置与数据健康」里有名字
 *
 * 用法：npm run gate-panel（npm test 里也会跑）
 */
const _REAL_NOW = Date.now();
const realToday = new Date(_REAL_NOW + 8 * 3600 * 1000).toISOString().slice(0, 10);
Date.now = () => Date.parse(realToday + 'T02:00:00Z');   // 北京 10:00

const { H, el, store, CORE, put, at, SIG, banners, BASE, ROWS } = await import('./harness.mjs');
const { gateState, gateLine } = CORE;

let fails = 0;
const bad = (m) => { fails++; console.log(`    ✗ ${m}`); };
const ok = (m) => console.log(`    ✓ ${m}`);
const M = 6000;
const G = (close, { armed = true, below = true, dataOk = true, blocked = null } = {}) => ({
  asof: BASE.asof, close, active: true, dataOk, problem: dataOk ? null : '价格指数已连续 5 个交易日没取到',
  armed: dataOk && armed, memArmed: armed, below, blocking: dataOk && armed && below,
  ma250: below ? close * 1.02 : close * 0.98, dy: armed ? 0.031 : 0.039, y10: 0.034, spread: armed ? -0.003 : 0.005,
  pDate: BASE.asof, yDate: BASE.asof, staleP: 0, staleY: 0, blocked,
});
const GB = (close, signalDate = BASE.asof) => ({ signalDate, tierFrom: 0, tierTo: 1, close, ma250: close * 1.02, dy: 0.031, y10: 0.034, spread: -0.003 });
const gateBanners = () => banners().filter((b) => b.gate);
const clearAcks = () => { for (const k of [...store.keys()]) if (k.startsWith('hlma30.ack.')) store.delete(k); };

console.log('\n● 新版 Worker 还没跑过：页面按行情现算');
{
  put({ tier: 0, index: BASE.index, chain: [], gate: null });
  H.renderGate();
  const want = gateState(ROWS, BASE.asof);
  const line = el('gateLine').textContent;
  if (line === gateLine(want, realToday)) ok(`和核心函数同一句：${line}`); else bad(`现算的状态行不对：${line}`);
  if (/页面按行情现算/.test(el('gateNote').textContent)) ok('注明了是页面现算的'); else bad('没注明是现算的');
  if (el('gateGrid').innerHTML.split('class="ct"').length - 1 === 4) ok('四格：股息率 / 10 年国债 / 利差 / 年线'); else bad(`格子数不对：${el('gateGrid').innerHTML}`);
}

console.log('\n● 状态标签');
for (const [name, g, want] of [
  ['没上膛', G(M, { armed: false, below: false }), '未上膛'],
  ['上膛、收盘在年线上方', G(M, { below: false }), '已上膛'],
  ['上膛、收盘在年线下方', G(M), '拦截中'],
  ['数据异常', G(M, { dataOk: false }), '数据异常'],
]) {
  put({ tier: 0, index: at(M, M), chain: [], gate: g });
  H.renderGate();
  const chip = el('gateStat').textContent;
  if (chip === want) ok(`${name} → 「${chip}」`); else bad(`${name}：标签是「${chip}」，应为「${want}」`);
}

console.log('\n● 拦下买入的那天');
{
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], gate: G(M * 0.96, { blocked: GB(M * 0.96) }) });
  H.renderInputDependent();
  const line = el('nextLine').textContent;
  if (/的买入信号被闸门拦下，不用操作/.test(line)) ok(`「下一次操作」：${line}`); else bad(`「下一次操作」没说被拦下：${line}`);
  if (!/系统还没记下这笔操作/.test(el('nextSub').textContent)) ok('没有误报「系统还没记下这笔操作」'); else bad('把闸门拦下误说成了系统没跑完');
  const gb = gateBanners();
  if (gb.length === 1 && gb[0].text === '买入第 1 份被闸门拦下 不用操作' && gb[0].btn.textContent === '知道了') ok(`紫色横幅：${gb[0].kick}｜${gb[0].text}｜[${gb[0].btn.textContent}]`);
  else bad(`横幅不对：${JSON.stringify(gb.map((b) => [b.kick, b.text]))}`);
  gb[0] && gb[0].btn.click();
  if (store.get(`hlma30.ack.gate:${BASE.asof}`) === 'true' && !gateBanners().length) ok('点「知道了」永久收起（存 true，不是只收今天）');
  else bad(`确认标记：${store.get(`hlma30.ack.gate:${BASE.asof}`)}，横幅还剩 ${gateBanners().length} 条`);
  H.renderInputDependent();
  if (!gateBanners().length) ok('重画一遍也不回来'); else bad('重画后又冒出来了');
}

console.log('\n● gatelog 里更早拦下的几笔');
{
  clearAcks();
  const old = [GB(M * 0.95, SIG.past), GB(M * 0.97, BASE.asof)];
  put({ tier: 0, index: at(M, M), chain: [], gate: G(M, { armed: false, below: false }), gatelog: { entries: old } });
  H.renderInputDependent();
  const gb = gateBanners();
  if (gb.length === 2 && gb[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md) && gb[1].kick.includes(CORE.dayLabel(SIG.past, realToday).md)) ok('两笔都排着，新的在前');
  else bad(`应排两条：${JSON.stringify(gb.map((b) => b.kick))}`);
  gb[1] && gb[1].btn.click();
  const left = gateBanners();
  if (left.length === 1 && left[0].kick.includes(CORE.dayLabel(BASE.asof, realToday).md)) ok('点掉旧的那条，新的还在'); else bad(`点一条连带收掉了别的：${JSON.stringify(left.map((b) => b.kick))}`);
  // 当晚那笔还没进 gatelog（取文件失败）时，从 state 补上，不重复
  clearAcks();
  put({ tier: 0, index: at(M, M * 0.96), chain: [], gate: G(M * 0.96, { blocked: GB(M * 0.96) }), gatelog: { entries: [GB(M * 0.96)] } });
  H.renderInputDependent();
  if (gateBanners().length === 1) ok('gatelog 和 state 里是同一笔：只排一条'); else bad(`重复了：${gateBanners().length} 条`);
}

console.log('\n● 闸门已上膛、还没跌到买入线');
{
  put({ tier: 0, index: at(M, M), chain: [], gate: G(M, { below: false }) });
  H.renderInputDependent();
  if (/闸门已上膛：跌到 [\d,]+ 时，收盘若也在年线/.test(el('nextSub').textContent)) ok('「下一次操作」提前说了：跌到买入线也不一定会买'); else bad(`没提醒：${el('nextSub').textContent}`);
  put({ tier: 0, index: at(M, M), chain: [], gate: G(M, { armed: false, below: false }) });
  H.renderInputDependent();
  if (!/闸门/.test(el('nextSub').textContent)) ok('没上膛时不多嘴'); else bad(`没上膛也提闸门：${el('nextSub').textContent}`);
}

console.log('\n● 设置与数据健康');
{
  put({ tier: 0, index: at(M, M), chain: [] });
  H.render();
  if (/闸门要用的数据是新的/.test(el('checks').innerHTML)) ok('第 11 项检查有名字'); else bad('检查列表里没有第 11 项');
  if (/000922/.test(el('dataNote').innerHTML)) ok('数据来源里写了价格指数 000922 和国债收益率'); else bad('数据来源没写闸门的数据');
}

console.log(`\n${fails ? `✗ ${fails} 项不通过` : '✓ 面板闸门全部通过'}\n`);
process.exit(fails ? 1 : 0);
