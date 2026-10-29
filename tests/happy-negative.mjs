/**
 * 反向验证：一个从来不会失败的测试等于没测。
 *
 * 逐条把关键逻辑改坏，跑对应的那份测试，确认它真的会红。
 * 改坏的是临时副本，跑完立刻还原。
 *
 * 「红」必须是断言报错，不能是代码崩了 —— 崩溃谁都能制造，
 * 那说明不了断言在盯着这件事。所以只认测试自己打出的 ✗。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = { page: join(ROOT, 'index.html'), core: join(ROOT, 'shared', 'strategy.js'), worker: join(ROOT, 'worker', 'src', 'index.js') };
// 行尾一律拉平成 LF 再比对。Windows 上 git 每 checkout 一次就把工作区写成
// CRLF，而下面那些锚点里带着 \n —— 不拉平的话 git pull 之后整批锚点全部
// 失配，报「找不到要改的那段」，看着像测试自己坏了。
// 写回去也用 LF：git 提交时本来就按 LF 存，内容不受影响。
const flat = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const clean = { page: flat(F.page), core: flat(F.core), worker: flat(F.worker) };
const restore = () => { for (const k of Object.keys(F)) writeFileSync(F[k], clean[k], 'utf8'); };
// 这个脚本会真的改写源码。万一中途被 Ctrl-C 或异常打断，
// 绝不能把改坏的版本留在硬盘上 —— 所以每条退路都挂上还原。
for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(ev, () => { restore(); if (ev !== 'exit') process.exit(1); });
}

/** [名字, 改哪个文件, 原文, 改成, 跑哪份测试] */
const MUTANTS = [
  // —— 计算器 ——
  ['刷新不再清空计算器', 'page', "LS.set('calc', null);", '/* 改坏 */', 'happy'],
  ['刷新后又替你预填', 'page',
    "$('etfLabel').textContent = st.etf?.code || 'ETF';\n  const man = LS.get('calc', null);",
    "$('etfLabel').textContent = st.etf?.code || 'ETF';\n  const man = LS.get('calc', null) || (M ? { cash: M.cash, hold: M.V } : null);", 'happy'],
  ['按钮填的被当实盘证据', 'page', "m.from !== 'ledger' && isFinite(m.cash)", 'isFinite(m.cash)', 'happy'],
  ['填账本的按钮藏起来', 'page', 'reset.hidden = !accountMoney();', 'reset.hidden = true;', 'happy'],

  // —— 横幅 ——
  ['横幅记账后自行消失', 'page',
    'for (const e of [...entries].reverse()) {', 'for (const e of []) {', 'happy'],
  ['点完成不写进记忆', 'page',
    'LS.set(`ack.${item.signalDate}`, canDo ? true : bjToday());',
    'LS.set(`ack.${item.signalDate}`, false);', 'happy'],
  ['执行日没到就永久收起', 'page',
    'canDo ? true : bjToday()', 'true', 'banners'],
  ['待办谎称已经记好账', 'page',
    "body = `现在还做不了 —— 这笔要等到 <b>${bex.L.label}</b>收盘前。`",
    "body = `无论点不点，系统都已按规则把这笔操作写进不可更改的记录。`", 'banners'],
  ['又只剩最新那一条', 'page',
    'for (const it of todo.slice(0, MAX_BANNERS)) {',
    'for (const it of todo.slice(0, 1)) {', 'banners'],
  ['点一条把别条也收了', 'page',
    'LS.set(`ack.${item.signalDate}`, canDo ? true : bjToday());\n    renderInputDependent();',
    '(S.ledger.entries || []).forEach((e) => LS.set(`ack.${e.signalDate}`, true));\n    LS.set(`ack.${item.signalDate}`, canDo ? true : bjToday());\n    renderInputDependent();', 'banners'],

  // —— 「不点就不消失」这条铁律 ——
  ['建好之前先清空', 'page', 'box.replaceChildren(...built);', 'box.replaceChildren();', 'banner-persistence'],
  ['坏记录被无声吞掉', 'page',
    "catch (e) { pushNotice(built, '这笔读不出来', it.signalDate || it.day || it.date, e); }", 'catch (e) { /* 吞掉 */ }', 'banner-persistence'],
  ['重复信号日不合并', 'page',
    'if (seen.has(it.signalDate)) { dup.push(it.signalDate); continue; }',
    'if (seen.has(it.signalDate) && false) { dup.push(it.signalDate); continue; }', 'banner-persistence'],

  // —— 推送不许无声消失（09-18）——
  ['推送请求不设超时', 'worker', "}, 3, 'Bark', +env.BARK_TIMEOUT_MS || 8000);", "}, 3, 'Bark');", 'push-timeout'],
  ['超时信号没接上请求', 'worker', '...(ac ? { signal: ac.signal } : {}),', '', 'push-timeout'],

  // —— 补发：只在没送达时补、不和原推送撞车、要说明是补发 ——
  ['送达了还补发', 'worker', '  if (prev && prev.ok === true) return null;\n', '', 'push-resend'],
  ['刚跑完就急着补发', 'worker', "    if (!(mins >= 10)) return { ok: null, reason: '那一轮可能还在发推送，先不补发' };",
    "    if (false) return { ok: null, reason: '那一轮可能还在发推送，先不补发' };", 'push-resend'],
  ['补发不说明是补发', 'worker', "const resentLine = resent ? `\\n↻ 补发：${resent}` : '';", "const resentLine = '';", 'push-resend'],

  // —— 中证窗口起点落在休市日（09-28 整天停跑）——
  ['清洗不用官方日历', 'worker', '      if (tradingCal.covers(r0.d) && !tradingCal.has(r0.d)) {', '      if (false) {', 'csi-window'],
  ['起点假行删反方向', 'worker', 'if (rows.length >= 2 && rows[0].d === startYmd && rows[0].c === rows[1].c) {',
    'if (false) {', 'csi-window'],

  // —— 卡片与算法 ——
  ['买入金额漏算手续费', 'core', '(target - V) / (1 + w * c)', '(target - V)', 'happy'],
  ['日期不写月日', 'core', '${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日', '某天', 'happy'],
  ['仓位又变回分数', 'core', "`${Math.round(WEIGHTS[tier] * 100)}%`", '`${tier}/5 档`', 'happy'],
  ['长说明又摊回卡片上', 'page',
    '`<details class="how"><summary>这是怎么运作的</summary><div class="body">`', '`<span>`', 'happy'],

  // —— 闲钱分两处放（缓冲垫 + 交银稳利）——
  ['到账日少算一天', 'core', 'nth(d, LAG)', 'nth(d, LAG - 1)', 'cashplan'],
  ['赎回不看 7 天', 'core', 'if (r <= 1e-9 || !aged(l, d)) break;', 'if (r <= 1e-9) break;', 'cashplan'],
  ['持有天数按申请日算', 'core', 'return cs && cr ? nat(cs, cr) >= HOLD : nat(l.d, r) >= HOLD + 3;', 'return nat(l.d, r) >= HOLD;', 'cashplan'],
  ['缓冲垫比例写死四成', 'core', 'Math.max(0, Math.min(B * S, cash))', 'Math.max(0, Math.min(0.4 * S, cash))', 'cashplan'],
  ['在途款不计息', 'core', 'for (const l of lots) l.v *= g; for (const t of transit) t.v *= g;', 'for (const l of lots) l.v *= g;', 'cashplan'],
  ['卖出后不申购交银', 'core', 'if (buf - tgt(S2, cashOf()) > DRIFT * S2) {', 'if (false) {', 'cashplan'],
  ['买入日不提醒赎回', 'core', "if (deficit > ((o.side === 'BUY' || nextFirst || owe) ? 1e-9 * S : DRIFT * S)) {", 'if (false) {', 'cashplan-push'],
  ['平时偏离不补', 'core', 'if (deficit > (strict ? 1e-9 * S : DRIFT * S)) {\n        const left', 'if (deficit > (strict ? 1e-9 * S : DRIFT * S) && strict) {\n        const left', 'cashplan'],
  ['预告了却不兑现', 'core', "owe = owe ? left > 0.005 : (side === 'BUY' || first) && left > DRIFT * S;", 'owe = false;', 'cashplan'],
  ['零头也预告', 'core', 'if (rest > (owe ? 0.005 : DRIFT * S)) {', 'if (rest > 0.005) {', 'cashplan'],
  ['缓冲垫不够不报警', 'core', 'short = { day, have: bufE, need, gap: need - bufE, until };', 'short = null;', 'cashplan-push'],
  ['推送漏掉资金安排', 'worker', '        + cashBlock(cash, today)\n', '', 'cashplan-push'],
  ['盘中提醒漏掉资金', 'worker', '      + cashTxt,', "      + '',", 'cashplan-push'],
  ['金额漏进HTTP返回', 'worker', "cashPlan: cash ? (cash.error ? 'error' : 'ok') : 'off',", "cashPlan: cash ? (cash.error ? 'error' : cash) : 'off',", 'cashplan-push'],
  ['面板不补取整尾差', 'page', 'if (diff) { let k = 0;', 'if (false) { let k = 0;', 'cashplan-panel'],
  ['在途不写到账日', 'page', "`${money(t.r)} 元 ${t.arrive ? `${dl(t.arrive)}到账` : '到账日期交易日历暂时给不出'}`", "`${money(t.r)} 元`", 'cashplan-panel'],
  ['挂单卡片不带资金', 'page', "if (cashL.length) realLine += `<br><b>资金：</b>${cashL.join('；')}`;", '', 'cashplan-panel'],
  ['过了15点不说截止', 'page', "first.kind !== 'REDEEM_LATER' && bjHour() >= 15", 'false', 'cashplan-panel'],
  ['前一晚误报要动钱', 'page', '  if (first.day === today) {\n    return { cls: \'act\'', '  if (first.day >= today) {\n    return { cls: \'act\'', 'cashplan-panel'],
  // —— 资金上的买卖也要横幅（10-22）——
  ['资金横幅不排进来', 'page', 'const cash = cashItems();', 'const cash = [];', 'cash-banners'],
  ['申赎知道了永久收起', 'page', 'LS.set(`ack.${item.key}`, canDo ? true : bjToday());', 'LS.set(`ack.${item.key}`, true);', 'cash-banners'],
  ['预告和追问标记不同', 'page', 'key: `cash:${kind}:${a.day}`', 'key: `cash:${kind}:next:${a.day}`', 'cash-banners'],
  ['过了的申赎不追问', 'page', 'for (const e of cp.events || []) {', 'for (const e of []) {', 'cash-banners'],
  ['补买不出横幅', 'page', 'for (const x of cp.shorts || []) {', 'for (const x of []) {', 'cash-banners'],
  ['同一天顺序乱了', 'page', 'const rank = { trade: 0, cash: 1, catchup: 2, gate: 3 };', 'const rank = { trade: 2, cash: 1, catchup: 0, gate: 3 };', 'cash-banners'],
  ['申赎过15点不说截止', 'page', "} else if (item.day === today && bjHour() >= 15) {", '} else if (false) {', 'cash-banners'],
  ['补做日不认当天', 'page', '(S.cal || []).includes(today) && bjHour() < 15 && today > item.day ? today', 'false ? today', 'cash-banners'],
  ['汇总条漏收申赎', 'page', 'rest.forEach((r) => LS.set(`ack.${r.key || r.signalDate}`, true));', 'rest.forEach((r) => LS.set(`ack.${r.signalDate}`, true));', 'cash-banners'],
  ['买卖横幅不提申赎', 'page', "const acts = cp.next.actions.filter((a) => (a.kind === 'REDEEM' || a.kind === 'SUBSCRIBE') && a.day);", 'const acts = [];', 'cashplan-panel'],
  ['只申赎时静默推送', 'worker', "...(gBlocked || cashDue ? { level: 'timeSensitive', group: '红利MA30·操作' } : { level: 'passive' }),", "...(gBlocked ? { level: 'timeSensitive', group: '红利MA30·操作' } : { level: 'passive' }),", 'cashplan-push'],
  ['只申赎时不提醒', 'worker', '    if (!due.length) {\n      return { ok: true, today, skipped:', '    if (true) {\n      return { ok: true, today, skipped:', 'cashplan-push'],
  ['说明文字没有折叠', 'page', '<details class="how"><summary>这是怎么运作的</summary><div class="body note" id="cashNote">',
    '<div class="how"><p>这是怎么运作的</p><div class="body note" id="cashNote">', 'cashplan-panel'],

  // —— 闸门 ——
  ['回差没了', 'core', 'if (!memArmed && spread < GATE.armBelow) memArmed = true;\n      else if (memArmed && spread > GATE.disarmAbove) memArmed = false;',
    'memArmed = spread < 0;', 'gate'],
  ['国债缺多久都沿用', 'core', "    else if (staleY >= GATE.staleDays) problem = `10 年国债收益率已连续 ${staleY} 个交易日没取到`;\n", '', 'gate'],
  ['数据太旧照样拦', 'core', 'const armed = dataOk && memArmed;', 'const armed = memArmed;', 'gate'],
  ['卖出也被拦', 'core', "return sig === 'BUY' && tier < MAX_TIER && !!gate && gate.blocking === true;", 'return !!sig && !!gate && gate.blocking === true;', 'gate'],
  ['错配的价格指数照用', 'core', 'if (!(raw > -0.003 && raw < 0.03)) continue;', '/* 不查 */', 'gate'],
  ['年线上下判反', 'core', 'const below = ma250 != null && r.c < ma250;', 'const below = ma250 != null && r.c > ma250;', 'gate'],
  ['拦下了还出挂单', 'worker', 'if (blocked) want = tier;', '/* 不拦 */', 'gate'],
  ['拦截推送不响铃', 'worker', "...(gBlocked || cashDue ? { level: 'timeSensitive', group: '红利MA30·操作' } : { level: 'passive' }),",
    "...(cashDue ? { level: 'timeSensitive', group: '红利MA30·操作' } : { level: 'passive' }),", 'gate'],
  ['拦下了不记 gatelog', 'worker', 'if (blocked) {\n    const glog', 'if (false) {\n    const glog', 'gate'],
  ['取不到就拿空值盖掉', 'worker', 'y: yByDate.has(r.d) ? +yByDate.get(r.d).toFixed(4) : (prev && prev.y != null ? prev.y : null),',
    'y: yByDate.has(r.d) ? +yByDate.get(r.d).toFixed(4) : null,', 'gate'],
  ['闸门横幅只收今天', 'page', "'知道了', () => { LS.set(`ack.${item.key}`, true); renderInputDependent(); });",
    "'知道了', () => { LS.set(`ack.${item.key}`, bjToday()); renderInputDependent(); });", 'gate-panel'],
  ['拦下了却说系统没跑完', 'page', '} else if (gateBlockedNow()) {', '} else if (false) {', 'gate-panel'],
  ['横幅不看 gatelog', 'page', 'for (const b of (S.gatelog && S.gatelog.entries) || []) add(b);', '/* 不看 */', 'gate-panel'],
];

let broken = 0;
console.log('\n把代码逐条改坏，看对应的测试是否真的会报错\n');
for (const [name, file, from, to, test] of MUTANTS) {
  const src = clean[file];
  if (!src.includes(from)) { console.log(`  ⚠ ${name.padEnd(11, '　')} 找不到要改的那段 —— 这条没测成`); broken++; restore(); continue; }
  restore();
  writeFileSync(F[file], src.split(from).join(to), 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [join(ROOT, 'tests', `${test}.mjs`)], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }

  const hits = out.match(/✗ [^\n]*/g) || [];
  const crashed = /SyntaxError|ReferenceError|TypeError|Cannot read/.test(out);
  const caught = hits.length > 0 && !crashed;
  console.log(`  ${caught ? '✓' : '✗'} ${name.padEnd(11, '　')} ${test.padEnd(10)} ${
    caught ? `被抓到 —— ${hits[0].slice(2).slice(0, 78)}`
    : crashed ? '代码直接崩了，不算数：这个改法太粗暴，换一个'
    : '居然还是绿的 —— 这条断言是摆设'}`);
  if (!caught) broken++;
}
restore();

console.log(`\n${broken ? `✗ ${broken} 条没验成` : '✓ 每一条断言都真的会在代码坏掉时报错'}\n`);
process.exitCode = broken ? 1 : 0;
