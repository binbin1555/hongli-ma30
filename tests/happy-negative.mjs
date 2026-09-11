/**
 * 反向验证：一个从来不会失败的测试等于没测。
 *
 * 逐条把关键逻辑改坏，跑一遍 happy.mjs，确认它真的会红。
 * 改坏的是临时副本，跑完立刻还原。
 *
 * 「红」必须是断言报错，不能是代码崩了 —— 崩溃谁都能制造，
 * 那说明不了断言在盯着这件事。所以只认 happy.mjs 自己打出的 ✗。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = { page: join(ROOT, 'index.html'), core: join(ROOT, 'shared', 'strategy.js') };
const clean = { page: readFileSync(F.page, 'utf8'), core: readFileSync(F.core, 'utf8') };
const restore = () => { writeFileSync(F.page, clean.page, 'utf8'); writeFileSync(F.core, clean.core, 'utf8'); };
// 这个脚本会真的改写源码。万一中途被 Ctrl-C 或异常打断，
// 绝不能把改坏的版本留在硬盘上 —— 所以每条退路都挂上还原。
for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(ev, () => { restore(); if (ev !== 'exit') process.exit(1); });
}

const MUTANTS = [
  ['刷新不再清空计算器', 'page', "LS.set('calc', null);", '/* 改坏 */'],
  ['刷新后又替你预填', 'page',
    "$('etfLabel').textContent = st.etf?.code || 'ETF';\n  const man = LS.get('calc', null);",
    "$('etfLabel').textContent = st.etf?.code || 'ETF';\n  const man = LS.get('calc', null) || (M ? { cash: M.cash, hold: M.V } : null);"],
  ['按钮填的被当实盘证据', 'page', "m.from !== 'ledger' && isFinite(m.cash)", 'isFinite(m.cash)'],
  ['填账本的按钮藏起来', 'page', 'reset.hidden = !accountMoney();', 'reset.hidden = true;'],
  ['横幅记账后自行消失', 'page', ': last\n      ? { signalDate:', ': false\n      ? { signalDate:'],
  ['点完成不写进记忆', 'page', 'LS.set(ackKey, true)', 'LS.set(ackKey, false)'],
  ['买入金额漏算手续费', 'core', '(target - V) / (1 + w * c)', '(target - V)'],
  ['日期不写月日', 'core', '${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日', '某天'],
  ['仓位又变回分数', 'core', "`${Math.round(WEIGHTS[tier] * 100)}%`", '`${tier}/5 档`'],
];

let broken = 0;
console.log('\n把代码逐条改坏，看 happy.mjs 是否真的会报错\n');
for (const [name, file, from, to] of MUTANTS) {
  const src = clean[file];
  if (!src.includes(from)) { console.log(`  ⚠ ${name}：找不到要改的那段（${from}）—— 这条没测成`); broken++; restore(); continue; }
  restore();
  writeFileSync(F[file], src.split(from).join(to), 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [join(ROOT, 'tests', 'happy.mjs')], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }

  const hits = out.match(/✗ [^\n]*/g) || [];
  const crashed = /SyntaxError|ReferenceError|TypeError|Cannot read/.test(out);
  const caught = hits.length > 0 && !crashed;
  console.log(`  ${caught ? '✓' : '✗'} ${name.padEnd(11, '　')} ${
    caught ? `被抓到 —— ${hits[0].slice(2)}`
    : crashed ? '代码直接崩了，不算数：这个改法太粗暴，换一个'
    : '居然还是绿的 —— 这条断言是摆设'}`);
  if (!caught) broken++;
}
restore();

console.log(`\n${broken ? `✗ ${broken} 条没验成` : '✓ 每一条断言都真的会在代码坏掉时报错'}\n`);
process.exitCode = broken ? 1 : 0;
