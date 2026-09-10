import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 按脚本自身位置解析，保证从仓库根目录或 tests/ 目录跑都一样
const HERE = dirname(fileURLToPath(import.meta.url));
import { replay, ma, signal, nextTier, orderAmount, triggers, WEIGHTS }
  from '../shared/strategy.js';

const cases = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
let allOk = true;
console.log('=== JS 核心 vs Python 引擎 对账 ===');
for (const c of cases) {
  const r = replay(c.rows, c.entries, c.principal, c.launchDate);
  const diff = r.total - c.expect.final;
  const rel = Math.abs(diff) / c.expect.final;
  const ok = Math.abs(diff) < 0.01; // 1.5 万元级本金上允许 1 分钱的浮点误差
  allOk = allOk && ok;
  console.log(
    `${c.name}  JS=${r.total.toFixed(2)}  Python=${c.expect.final.toFixed(2)}  ` +
    `差=${diff.toFixed(6)}  相对误差=${rel.toExponential(2)}  ${ok ? 'OK' : '!!! 不一致'}`
  );
  const posJs = r.V / r.total;
  console.log(`    仓位 JS=${posJs.toFixed(6)}  Python=${c.expect.finalPos.toFixed(6)}  档位 JS=${r.tier}  笔数=${c.entries.length}`);
}

console.log('\n=== 信号函数单元测试 ===');
const t = [
  [96.9, 100, 'BUY',  '低于均线3%以上'],
  [97.0, 100, null,   '恰好等于 MA30×0.97 —— 不触发（严格小于）'],
  [97.1, 100, null,   '在区间内'],
  [102.0, 100, null,  '恰好等于 MA30×1.02 —— 不触发（严格大于）'],
  [102.1, 100, 'SELL','高于均线2%以上'],
];
for (const [c0, m0, want, why] of t) {
  const got = signal(c0, m0);
  console.log(`  收盘${c0} MA${m0} → ${String(got)}  期望 ${String(want)}  ${got === want ? 'OK' : '!!!'}  (${why})`);
  allOk = allOk && got === want;
}

console.log('\n=== 档位推进测试（一天最多动一档、封顶封底）===');
const tt = [[0,'SELL',0],[0,'BUY',1],[3,'BUY',4],[4,'BUY',4],[4,'SELL',3],[2,null,2]];
for (const [from, s, want] of tt) {
  const got = nextTier(from, s);
  console.log(`  档位${from} 信号${String(s)} → ${got} 期望${want} ${got===want?'OK':'!!!'}`);
  allOk = allOk && got === want;
}

console.log('\n=== 目标市值法下单金额（文档 3.5 公式）===');
const S = 1071188, V = 0, w = 0.25, c = 0.000045;
const o = orderAmount(S, V, w);
const manual = (w * S - V) / (1 + w * c);
console.log(`  S=${S} V=${V} w=${w} → ${o.side} ${o.amount.toFixed(4)}  手算 ${manual.toFixed(4)}  ${Math.abs(o.amount-manual)<1e-9?'OK':'!!!'}`);
const o2 = orderAmount(1000000, 500000, 0.25);
const m2 = (500000 - 0.25*1000000) / (1 - 0.25*c);
console.log(`  减仓 S=1000000 V=500000 w=0.25 → ${o2.side} ${o2.amount.toFixed(4)}  手算 ${m2.toFixed(4)}  ${Math.abs(o2.amount-m2)<1e-9?'OK':'!!!'}`);
const o3 = orderAmount(1000000, 300000, 0);
console.log(`  清仓 w=0 → ${o3.side} ${o3.amount}  期望 SELL 300000  ${o3.side==='SELL'&&o3.amount===300000?'OK':'!!!'}`);

console.log('\n=== MA30 边界 ===');
console.log('  只有29个数 →', ma(Array(29).fill(100)), '(期望 null)');
console.log('  30个数 →', ma(Array(30).fill(100)), '(期望 100)');
console.log('  含 NaN →', ma([...Array(29).fill(100), NaN]), '(期望 null)');

console.log('\n=== 今日真实状态复算 ===');
const trg = triggers(12387.45, 12087.24);
console.log(`  收盘/MA30=${trg.ratio.toFixed(4)}  买入线=${trg.buyAt.toFixed(2)}  还需跌=${trg.pctToBuy.toFixed(2)}%`);
console.log(`  与之前 Python 算的 1.0248 / 11724.62 / -5.35% 对比 ${Math.abs(trg.ratio-1.0248)<1e-4 && Math.abs(trg.buyAt-11724.62)<0.01 && Math.abs(trg.pctToBuy+5.35)<0.01 ? 'OK' : '!!!'}`);

console.log(`\n总判定：${allOk ? '全部通过 ✓' : '有不一致 ✗'}`);
process.exit(allOk ? 0 : 1);
