import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateStyleSwitch, styleSwitchBarkLine } from '../shared/styleswitch.js';
import { pushDaily } from '../worker/src/index.js';

// 1. 构造 150 天合成序列测试 ±1% 滞回带状态机
const makeSeries = (vals) => vals.map((v, i) => {
  const dt = new Date(Date.UTC(2026, 0, 1 + i));
  return { d: dt.toISOString().slice(0, 10), c: v };
});

// 前 125 天恒为 1.00，之后在 [0.995, 1.005] 缓冲区震荡（不应切换），最后突破 1.02（切进攻）再跌破 0.98（切防守）
const hl1 = makeSeries(Array(135).fill(1.0));
const c300 = Array(125).fill(1.0);
// 初始 RS=1.00 == MA120=1.00 -> hongli
c300.push(1.005, 1.008, 0.995); // 缓冲区内，仍应保持 hongli
const resBuf = evaluateStyleSwitch(makeSeries(c300), hl1.slice(0, c300.length));
assert.equal(resBuf.ok, true);
assert.equal(resBuf.mode, 'hongli', '缓冲区内应保持防守模式不切换');
assert.equal(resBuf.switchedToday, false);

// 突破上轨 +1% -> 切进攻
c300.push(1.025);
const resUp = evaluateStyleSwitch(makeSeries(c300), hl1.slice(0, c300.length), resBuf);
assert.equal(resUp.mode, 'trend', '突破 MA120+1% 应切至进攻模式');
assert.equal(resUp.switchedToday, true, '当日刚切换应标记 switchedToday=true');
assert.ok(resUp.switchAlert.includes('防守·红利MA30 → 进攻·趋势'), '切换文案应包含方向');

// 回到缓冲区 0.996 -> 维持进攻
c300.push(0.996);
const resHold = evaluateStyleSwitch(makeSeries(c300), hl1.slice(0, c300.length), resUp);
assert.equal(resHold.mode, 'trend', '回到缓冲区应维持进攻模式');
assert.equal(resHold.switchedToday, false);

// 跌破下轨 -1% -> 切回防守
c300.push(0.98);
const resDn = evaluateStyleSwitch(makeSeries(c300), hl1.slice(0, c300.length), resHold);
assert.equal(resDn.mode, 'hongli', '跌破 MA120-1% 应切回防守模式');
assert.equal(resDn.switchedToday, true);

// 2. 故障隔离：ok=false 或 null 时返回空字符串
assert.equal(styleSwitchBarkLine(null), '');
assert.equal(styleSwitchBarkLine({ ok: false, error: 'timeout' }), '');
assert.ok(styleSwitchBarkLine(resHold).includes('🧭 风格总开关'));

// 3. 测试 pushDaily 推送正文：带 styleSwitch 时附加提醒行，不带时零干扰
const captured = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  captured.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ code: 200, message: 'success' }) };
};

try {
  const baseArgs = {
    today: '2026-11-27',
    newState: {
      tier: 2,
      index: { close: 10000, ma30: 10050, changePct: 0.25, buyTrigger: 9748.5, sellTrigger: 10251, pctToBuy: -2.51, pctToSell: 2.51 },
      prevPush: { ok: true },
    },
    pending: null,
    execDay: '2026-11-30',
    executed: null,
    plan: null,
    etf: null,
    checks: [{ id: 'c1', name: '测试检查', ok: true }],
    late: false,
    cash: null,
  };
  const env = { BARK_KEY: 'test-dummy-key', SITE_URL: 'https://binbin1555.github.io/hongli-ma30/' };

  await pushDaily(env, { ...baseArgs, styleSwitch: null });
  await pushDaily(env, { ...baseArgs, styleSwitch: resHold });
  await pushDaily(env, {
    ...baseArgs,
    pending: { side: 'BUY', tierFrom: 2, tierTo: 3 },
    styleSwitch: resDn,
  });

  assert.equal(captured.length, 3);
  assert.ok(!captured[0].body.includes('风格总开关'), '不传 styleSwitch 时推送应零干扰');
  assert.ok(captured[1].body.includes('🧭 风格总开关：进攻·趋势'), '无操作分支应附带风格总开关提醒');
  assert.equal(captured[1].title, captured[0].title, '风格总开关不得篡改红利原推送标题');
  assert.ok(captured[2].body.includes('🔄 风格总开关今日触发切换'), '有挂单分支且刚切换时应附带切换提醒');
} finally {
  globalThis.fetch = origFetch;
}

// 4. 校验生成的 data/styleswitch.json 结构完整
const liveJson = JSON.parse(readFileSync(new URL('../data/styleswitch.json', import.meta.url), 'utf8'));
assert.equal(liveJson.ok, true);
assert.ok(['trend', 'hongli'].includes(liveJson.mode));
assert.ok(liveJson.barkLine.length > 10);

console.log('✓ styleswitch.mjs 全部单元测试通过（滞回带、故障隔离、Bark 双分支零干扰、实盘快照）');
