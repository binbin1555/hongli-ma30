/**
 * 状态空间穷举：把界面的判断规则用同一批共享函数复算一遍，
 * 对每一种组合检查「不可能出现的情况」是否真的没出现。
 */
import {
  nextMove, calcStep, calcCatchUp, missedEntries, plannedOrder, orderAmount,
  shares, WEIGHTS, MAX_TIER, COMMISSION, signal, nextTier, ma, triggers,
} from '../shared/strategy.js';

let n = 0, bad = 0;
const fails = [];
const fail = (msg, ctx) => { bad++; if (fails.length < 8) fails.push(msg + '  ' + JSON.stringify(ctx)); };

const MA = 12000;
const priceCases = [0.94, 0.965, 0.97, 0.98, 1.0, 1.02, 1.021, 1.06].map((k) => +(MA * k).toFixed(2));

for (let tier = 0; tier <= MAX_TIER; tier++) {
  for (const close of priceCases) {
    const idx = { close, ma30: MA, buyTrigger: MA * 0.97, sellTrigger: MA * 1.02 };
    const pendings = [null];
    if (tier < MAX_TIER) pendings.push({ side: 'BUY', tierFrom: tier, tierTo: tier + 1, signalDate: '2026-09-10' });
    if (tier > 0) pendings.push({ side: 'SELL', tierFrom: tier, tierTo: tier - 1, signalDate: '2026-09-10' });

    for (const pending of pendings) {
      const mv = nextMove(idx, tier, pending);

      // —— 不变量 1：0 档不提卖出、满档不提买入
      if (tier === 0 && mv.kind === 'sell') fail('0档提示卖出', { tier, close });
      if (tier === MAX_TIER && mv.kind === 'buy') fail('满档提示买入', { tier, close });
      // —— 不变量 2：0–4 档永远有一个可执行方向
      if (mv.kind === 'none') fail('无任何方向', { tier, close, pending });
      // —— 不变量 3：距离不为负、不是 NaN
      if (mv.need !== undefined && !(mv.need >= 0)) fail('距离为负或NaN', { tier, close, need: mv.need });

      // 各种实盘填法
      const totals = [1000000, 37, 8_000_000];
      const holdRatios = [0, 0.1, 0.25, 0.375, 0.5, 0.62, 0.75, 0.9, 1];
      for (const total of totals) {
        for (const hr of holdRatios) {
          const hold = +(total * hr).toFixed(2), cash = +(total - hold).toFixed(2);
          n++;

          // 界面里计算器的目标：有挂单跟挂单，没挂单按方向走一档
          const wantBuy = pending ? pending.side === 'BUY' : mv.kind !== 'sell';
          const r = pending ? calcCatchUp(cash, hold, pending.tierTo) : calcStep(cash, hold, wantBuy);
          if (!r.ok) {
            if (!['NO_INPUT', 'FULL', 'EMPTY', 'BAD_TIER'].includes(r.reason))
              fail('未知失败原因', { reason: r.reason, cash, hold });
            continue;
          }
          // —— 不变量 4：金额必须有限、非负、不超过总资产
          if (!(r.amount >= 0 && isFinite(r.amount) && r.amount <= total + 1e-6))
            fail('金额越界或非数', { cash, hold, amount: r.amount });
          // —— 不变量 5：方向必须是 BUY/SELL/NONE 之一
          if (!['BUY', 'SELL', 'NONE'].includes(r.side)) fail('方向非法', { side: r.side });
          // —— 不变量 6：有挂单时，成交后仓位必须精确落在挂单目标上
          if (pending && r.side !== 'NONE') {
            let V = hold, S = total;
            if (r.side === 'BUY') { V += r.amount; S -= r.amount * COMMISSION; }
            else { V -= r.amount; S -= r.amount * COMMISSION; }
            if (Math.abs(V / S - WEIGHTS[pending.tierTo]) > 1e-9)
              fail('成交后未落在挂单目标仓位', { cash, hold, to: pending.tierTo, got: V / S });
          }
          // —— 不变量 7：股数非负、是100的整数倍
          const sh = shares(r.amount, 1.46);
          if (sh !== null && (sh < 0 || sh % 100 !== 0)) fail('股数非法', { sh, amount: r.amount });

          // —— 不变量 8：落后判定与补齐自洽
          const step = calcStep(cash, hold, true);
          if (step.tier !== undefined) {
            const target = pending ? pending.tierTo : tier;
            const behind = step.tier !== target;
            const cu = calcCatchUp(cash, hold, target);
            if (behind && cu.ok && cu.side !== 'NONE') {
              let V = hold, S = total;
              if (cu.side === 'BUY') { V += cu.amount; S -= cu.amount * COMMISSION; }
              else { V -= cu.amount; S -= cu.amount * COMMISSION; }
              if (Math.abs(V / S - WEIGHTS[target]) > 1e-9)
                fail('补齐后未落在目标仓位', { cash, hold, target, got: V / S });
            }
          }
        }
      }
    }
  }
}
console.log(`  穷举 ${n} 组（5 档位 × 8 价格位置 × 3 挂单形态 × 3 资产规模 × 9 持仓占比）`);
console.log(`  ${bad === 0 ? 'OK ' : '!!!'} 违反不变量：${bad} 组`);
for (const f of fails) console.log('      ' + f);
process.exit(bad === 0 ? 0 : 1);
