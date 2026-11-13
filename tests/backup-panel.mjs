/**
 * 面板上的来源说明：中证停更、收盘取自雪球时要说清楚；中证恢复的那一轮说一句；平时一个字都不多。
 * 用法：npm run backup-panel（npm test 里也会跑）
 */
const { H, el, BASE } = await import('./harness.mjs');
let fails = 0;
const bad = (m) => { fails++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);
const show = (st) => { H.S = { ...H.S, state: st }; H.render(); return { sub: el('idxSub').textContent, note: el('dataNote').innerHTML }; };

console.log('\n【一】平时（中证正常）');
let v = show({ ...BASE, source: { index: 'csi', csiLast: BASE.asof } });
if (/雪球|备用源|中证已恢复/.test(v.sub + v.note)) bad(`平时不该提备用源：${v.sub}`);
else ok(`指数卡片：「${v.sub}」，数据说明里没有多余的话`);
v = show({ ...BASE, source: undefined });
if (/雪球/.test(v.sub + v.note)) bad('老版 state（没有 source 字段）不该提备用源');
else ok('老版 state 没有 source 字段也照常显示');

console.log('\n【二】中证停更、收盘取自雪球');
v = show({ ...BASE, source: { index: 'xueqiu', csiLast: '2026-11-11', filled: ['2026-11-12', '2026-11-13'], verifiedDays: 100, maxDiffPct: 0 } });
console.log(`  指数卡片：${v.sub}`);
console.log(`  数据说明：${v.note.split('<br>').find((s) => /停在/.test(s)).replace(/<[^>]+>/g, '')}`);
if (!/取自备用源雪球/.test(v.sub)) bad('指数卡片没说明来源');
if (!/中证官网的数据停在 11 月 11 日/.test(v.note) || !/11 月 12 日、11 月 13 日/.test(v.note) || !/核对了 100 天/.test(v.note) || !/自动换回/.test(v.note)) bad('数据说明缺了停在哪天 / 补了哪几天 / 核对结果 / 自动换回');
else ok('指数卡片和数据说明都写明了来源、停在哪天、补了哪几天、核对结果');

console.log('\n【三】中证恢复的那一轮');
v = show({ ...BASE, source: { index: 'csi', csiLast: '2026-11-16', recovered: ['2026-11-12', '2026-11-13'], recoveredMaxDiffPct: 0 } });
if (/雪球/.test(v.sub)) bad('恢复后指数卡片不该再说取自雪球');
else if (!/中证已恢复：11 月 12 日、11 月 13 日已换回正式数据/.test(v.note)) bad('恢复那一轮没说换回了哪几天');
else ok('恢复那一轮：指数卡片不再提雪球，数据说明写明换回了哪几天');

H.S = { ...H.S, state: BASE }; H.render();
console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 来源说明全部通过');
process.exit(fails ? 1 : 0);
