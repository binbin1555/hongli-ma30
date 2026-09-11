/**
 * 红利 MA30 停车策略 —— 纯函数核心
 *
 * 这个文件被 Worker（生成推送）和网页（显示面板）同时引用。
 * 两边必须用同一份代码，否则推送里的金额和面板上的金额会对不上。
 *
 * 规则出处：《中证红利 MA30 停车策略 · 说明文档》第 3 节
 *   MA30   = 最近 30 个交易日 H00922 收盘价的算术平均（含当日）
 *   买入   收盘 < MA30 × 0.97  → 档位 +1
 *   卖出   收盘 > MA30 × 1.02  → 档位 -1
 *   档位   0 / 1 / 2 / 3 / 4  对应仓位 0 / 25% / 50% / 75% / 100%
 *   一天最多动一档
 *   T 日收盘出信号 → T+1 日收盘执行
 */

export const MA_LEN = 30;
export const BUY_TH = 0.97;
export const SELL_TH = 1.02;
export const COMMISSION = 0.000045; // 万分之 0.45 双边
export const WEIGHTS = [0, 0.25, 0.5, 0.75, 1.0];
export const MAX_TIER = 4;

/** 最近 MA_LEN 个收盘价的算术平均。不足则返回 null。 */
export function ma(closes, n = MA_LEN) {
  if (!Array.isArray(closes) || closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const v = closes[i];
    if (typeof v !== 'number' || !isFinite(v)) return null;
    s += v;
  }
  return s / n;
}

/** 当日收盘对 MA30 的信号。返回 'BUY' | 'SELL' | null */
export function signal(close, ma30) {
  if (!isFinite(close) || !isFinite(ma30) || ma30 <= 0) return null;
  if (close < ma30 * BUY_TH) return 'BUY';
  if (close > ma30 * SELL_TH) return 'SELL';
  return null;
}

/** 应用信号后的新档位（一天最多动一档，封顶封底） */
export function nextTier(tier, sig) {
  if (sig === 'BUY') return Math.min(tier + 1, MAX_TIER);
  if (sig === 'SELL') return Math.max(tier - 1, 0);
  return tier;
}

/**
 * 目标市值法下单金额（说明文档 3.5）
 *   买入 X = (w×S - V) / (1 + w×c)
 *   卖出 X = (V - w×S) / (1 - w×c)
 *   清仓（w=0）直接全部卖出
 * @returns {{side:'BUY'|'SELL'|'NONE', amount:number}}
 */
export function orderAmount(S, V, w, c = COMMISSION) {
  if (!isFinite(S) || !isFinite(V) || S <= 0) return { side: 'NONE', amount: 0 };
  if (w === 0) return V > 0 ? { side: 'SELL', amount: V } : { side: 'NONE', amount: 0 };
  const target = w * S;
  if (target > V) return { side: 'BUY', amount: (target - V) / (1 + w * c) };
  if (target < V) return { side: 'SELL', amount: (V - target) / (1 - w * c) };
  return { side: 'NONE', amount: 0 };
}

/**
 * 从不可更改的账本重放出当前资金状态。
 *
 * 之所以每次都从头重放而不是存一个"当前市值"，是因为重放是纯函数：
 * 只要账本和行情没变，结果永远一致，不存在状态漂移或写坏的可能。
 *
 * @param {Array<{d:string,c:number,b:number|null}>} rows  行情序列（升序，含指数收盘 c 和债券指数 b）
 * @param {Array<{date:string,price:number,tierTo:number}>} entries 账本条目（升序，date 为执行日）
 * @param {number} principal 本金
 * @param {string} launchDate 起算日 YYYY-MM-DD
 * @returns {{V:number,cash:number,total:number,tier:number,history:Array}}
 */
export function replay(rows, entries, principal, launchDate) {
  const byDate = new Map();
  for (const e of entries || []) byDate.set(e.date, e);

  let start = rows.findIndex((r) => r.d >= launchDate);
  if (start < 0) start = rows.length - 1;

  let V = 0;
  let cash = principal;
  let tier = 0;
  const history = [];

  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (i > start) {
      const prev = rows[i - 1];
      if (prev.c > 0) V *= r.c / prev.c;
      if (prev.b && r.b && prev.b > 0) cash *= r.b / prev.b;
    }
    const e = byDate.get(r.d);
    if (e) {
      const S = V + cash;
      const w = WEIGHTS[e.tierTo];
      const o = orderAmount(S, V, w);
      if (o.side === 'BUY') {
        V += o.amount;
        cash -= o.amount * (1 + COMMISSION);
      } else if (o.side === 'SELL') {
        V -= o.amount;
        cash += o.amount * (1 - COMMISSION);
      }
      tier = e.tierTo;
    }
    history.push({ d: r.d, V, cash, total: V + cash, tier });
  }
  return { V, cash, total: V + cash, tier, history };
}

/**
 * 给定当前资金状态和待执行的目标档位，算出这一笔该买/卖多少钱。
 * 用于推送文案和面板的"下一次操作"。
 */
export function plannedOrder(V, cash, tierTo) {
  const S = V + cash;
  const o = orderAmount(S, V, WEIGHTS[tierTo]);
  return { ...o, targetWeight: WEIGHTS[tierTo], totalAssets: S };
}

/** 参考股数：按 ETF 价格换算并向下取整到 100 股。价格缺失则返回 null。 */
export function shares(amount, etfPrice) {
  if (!isFinite(amount) || !isFinite(etfPrice) || etfPrice <= 0) return null;
  return Math.floor(amount / etfPrice / 100) * 100;
}

/**
 * 校验 state.json 的形状。
 *
 * 存在的理由：损坏的状态会被界面「硬着头皮画出来」而不是报错。
 * 实测把 tier 改成 7 之后，档位显示 7、格子亮满 5 个、计算器却说已空仓，
 * 页面上还出现了 NaN —— 全程没有任何提示。
 * 宁可整页报错让人一眼看见，也不能显示一个看似正常的错数字。
 *
 * @returns {string[]} 问题列表，空数组表示通过
 */
export function validateState(st) {
  const bad = [];
  if (!st || typeof st !== 'object') return ['state.json 不是对象'];

  if (!Number.isInteger(st.tier) || st.tier < 0 || st.tier > MAX_TIER) {
    bad.push(`档位 ${JSON.stringify(st.tier)} 不是 0–${MAX_TIER} 的整数`);
  }
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!d.test(st.asof || '')) bad.push(`数据日期 ${JSON.stringify(st.asof)} 格式不对`);
  if (!d.test(st.launchDate || '')) bad.push(`起算日 ${JSON.stringify(st.launchDate)} 格式不对`);

  const i = st.index;
  if (!i || typeof i !== 'object') {
    bad.push('缺少 index 字段');
  } else {
    for (const k of ['close', 'ma30', 'buyTrigger', 'sellTrigger']) {
      if (!(Number(i[k]) > 0) || !isFinite(Number(i[k]))) bad.push(`index.${k} = ${JSON.stringify(i[k])} 不是正数`);
    }
    if (Number(i.buyTrigger) >= Number(i.sellTrigger)) bad.push('买入线不低于卖出线');
  }

  const p = st.pending;
  if (p != null) {
    if (typeof p !== 'object') bad.push('pending 不是对象');
    else {
      for (const k of ['tierFrom', 'tierTo']) {
        if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > MAX_TIER) bad.push(`pending.${k} = ${JSON.stringify(p[k])} 越界`);
      }
      if (Number.isInteger(p.tierFrom) && Number.isInteger(p.tierTo) && Math.abs(p.tierTo - p.tierFrom) !== 1) {
        bad.push(`挂单跨了 ${Math.abs(p.tierTo - p.tierFrom)} 档，一次只能动一档`);
      }
      if (!d.test(p.signalDate || '')) bad.push(`pending.signalDate ${JSON.stringify(p.signalDate)} 格式不对`);
      if (Number.isInteger(st.tier) && Number.isInteger(p.tierFrom) && p.tierFrom !== st.tier) {
        bad.push(`挂单起始档 ${p.tierFrom} 与当前档位 ${st.tier} 对不上`);
      }
    }
  }
  return bad;
}

/**
 * 北京日期 YYYY-MM-DD。
 *
 * 只需要在绝对时间上加 8 小时 —— Date.now() 已经是 UTC 纪元毫秒，
 * 再叠一次 getTimezoneOffset() 会多偏一个时区（在国内表现为
 * 每天 0:00–8:00 显示成前一天）。Worker 和网页共用这一份实现。
 */
export function beijingDate(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 交易日历里 afterDate 之后的第一个交易日。
 * 用来把「T 日出信号 → T+1 日执行」里的 T+1 算成具体日期：
 * 周五出的信号要到下周一才执行，节假日同理，不能简单地加一天。
 */
/**
 * 档位说成仓位百分比。
 *
 * 别写成「N/5 档」：一共只有 5 个档位（0–4），满仓是第 4 个，
 * 写成「4/5 档」会被读成「还差一档」，而那一档根本不存在
 * （canBuy = tier < MAX_TIER，到 4 就买不动了）。
 * 百分比没有分母，不会有这种歧义。
 *
 * 「档」这个字只保留给**步数**（「差 2 档」「补齐 2 档」），那本来就不会误读。
 */
export const posPct = (tier) => `${Math.round(WEIGHTS[tier] * 100)}%`;

export const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把一个日期说成不会被误解的话：**具体日期永远打头，相对说法只放进括号**。
 *
 * 为什么不许直接写相对词 ——
 *   「明日」  周五出的信号执行日是下周一，长假前差十天；
 *   「今天」  一张在手机上放了一夜的页面，它说的「今天」是昨天；
 *   「下一个交易日」  不看日历根本不知道是哪天。
 * 相对词只在括号里做定位，不承担信息量；把括号整个删掉，句子依然完全正确。
 *
 * @param {string} d      要说的日期，YYYY-MM-DD
 * @param {string} today  北京日期，YYYY-MM-DD
 * @returns {{md:string, wd:string, rel:string|null, diff:number, label:string}}
 *   md     '9 月 14 日'
 *   wd     '周一'
 *   rel    '今天' | '明天' | '昨天' | null —— 只在日历上紧邻时才给
 *   diff   相差几个自然日（负数表示已经过去）
 *   label  '9 月 14 日（周一）' / '9 月 11 日（今天，周五）'
 */
export function dayLabel(d, today) {
  const md = `${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日`;
  const wd = WEEKDAY_CN[new Date(`${d}T00:00:00Z`).getUTCDay()];
  const diff = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : null;
  return { md, wd, rel, diff, label: `${md}（${rel ? `${rel}，` : ''}${wd}）` };
}

/**
 * 执行时点的口径。
 *
 * 措辞一律用「收盘前」，不用「收盘」——
 * 「收盘执行」会被读成「收盘之后再执行」，而那是个做不到的动作；
 * 「收盘前」在时间上任何时候都对。
 *
 * 但「收盘前」单独看太松：字面上上午十点也算收盘前，
 * 而账本按当日收盘价记账（说明文档 3.4 与 7 节），买太早就和账本对不上。
 * 精度由这句 CLOSE_TIP 补齐 —— 两句必须一起出现。
 */
export const CLOSE_TIP = '请在尾盘（14:50 之后、收盘之前）下单 —— 账本按当日收盘价记账，买太早会和账本对不上';

/**
 * 算不出执行日时的统一说法。
 * 只写「下一个交易日」会被当成「明天」，所以必须把「给不出日期」这件事直说。
 */
export const NO_EXEC_DATE = '下一个交易日（交易日历暂时取不到，给不出具体日期）';

export function nextTradingDay(tradingDays, afterDate) {
  if (!Array.isArray(tradingDays)) return null;
  for (const d of tradingDays) if (d > afterDate) return d;
  return null;
}

/**
 * 下一次操作：距离触发还差多远，以及是哪个方向。
 *
 * 边界规则：
 *   已满仓（100%）不再提示买入，已空仓（0%）不再提示卖出；
 *   两个方向都可能时，取更接近触发线的那一个；
 *   价格已越过触发线但当天信号还没确认时，need 为 0，由界面显示「等收盘确认」。
 *
 * @param {{close:number,ma30:number,buyTrigger:number,sellTrigger:number}} idx
 * @param {number} tier 当前档位 0–4
 * @param {{side:string,tierFrom:number,tierTo:number}|null} pending 已触发待执行的挂单
 */
export function nextMove(idx, tier, pending) {
  if (pending) {
    return { kind: 'pending', side: pending.side, from: pending.tierFrom, to: pending.tierTo };
  }
  const canBuy = tier < MAX_TIER;
  const canSell = tier > 0;
  const opts = [];
  if (canBuy) {
    opts.push({ kind: 'buy', need: Math.max(0, (idx.close - idx.buyTrigger) / idx.close * 100),
      target: idx.buyTrigger, tierTo: tier + 1 });
  }
  if (canSell) {
    opts.push({ kind: 'sell', need: Math.max(0, (idx.sellTrigger - idx.close) / idx.close * 100),
      target: idx.sellTrigger, tierTo: tier - 1 });
  }
  if (!opts.length) return { kind: 'none' };
  opts.sort((a, b) => a.need - b.need);
  return opts[0];
}

/**
 * 计算器核心：给定「可用资金」和「已持有红利市值」，
 * 先按这两个数字反推现在处在第几档（取最接近的一档），再算朝指定方向走一档要动多少钱。
 *
 * 为什么按填入的数字反推、而不是用账本记录的档位：
 * 这样结果永远自洽 —— 不会出现"标着买入却算出要卖出"那种自相矛盾的输出。
 * 账本档位和这里不一致时，由调用方单独提示，不影响计算本身。
 *
 * @param {number} cash 可用资金（还没买 ETF 的钱）
 * @param {number} hold 已持有红利 ETF 的市值
 * @param {boolean} wantBuy true=算买入，false=算卖出
 */
export function calcStep(cash, hold, wantBuy) {
  const c = Number(cash) || 0;
  const h = Number(hold) || 0;
  const total = c + h;
  if (!(total > 0) || c < 0 || h < 0) return { ok: false, reason: 'NO_INPUT' };

  const weight = h / total;
  let tier = 0, best = Infinity;
  WEIGHTS.forEach((wt, k) => { const d = Math.abs(wt - weight); if (d < best) { best = d; tier = k; } });

  if (wantBuy && tier >= MAX_TIER) return { ok: false, reason: 'FULL', tier, weight, total };
  if (!wantBuy && tier <= 0) return { ok: false, reason: 'EMPTY', tier, weight, total };

  const to = wantBuy ? tier + 1 : tier - 1;
  const o = orderAmount(total, h, WEIGHTS[to]);
  return { ok: true, tier, to, weight, total, side: o.side, amount: o.amount, targetWeight: WEIGHTS[to] };
}

/**
 * 找出账本里已经记账、但你实盘还没做的那几笔。
 *
 * 做法：从最后一笔往回找，找到第一笔「起始档位 == 你实盘档位」的记录，
 * 它和它之后的全部记录，就是你欠着的操作。
 * 找不到对应起点时返回空数组 —— 宁可不说，也不瞎猜。
 *
 * @param {Array<{tierFrom:number,tierTo:number,date:string}>} entries 账本（升序）
 * @param {number} actualTier 按你填的实盘数字反推出的档位
 */
export function missedEntries(entries, actualTier) {
  const es = entries || [];
  if (!es.length) return [];
  if (es[es.length - 1].tierTo === actualTier) return [];   // 已经对上了
  for (let i = es.length - 1; i >= 0; i--) {
    if (es[i].tierFrom === actualTier) return es.slice(i);
  }
  return [];
}

/**
 * 补齐：从当前实盘位置一次性调到指定档位要动多少钱。
 *
 * 用在漏做的时候。calcStep 只算「走一档」，如果你连着几天没操作，
 * 账本已经往前走了两三档，走一档远远不够 —— 落后两档时它只给一半的量。
 *
 * @param {number} cash 可用资金
 * @param {number} hold 已持有红利市值
 * @param {number} targetTier 要补到的档位 0–4（一般就是账本记录的档位）
 */
export function calcCatchUp(cash, hold, targetTier) {
  const c = Number(cash) || 0;
  const h = Number(hold) || 0;
  const total = c + h;
  if (!(total > 0) || c < 0 || h < 0) return { ok: false, reason: 'NO_INPUT' };
  if (!(targetTier >= 0 && targetTier <= MAX_TIER)) return { ok: false, reason: 'BAD_TIER' };
  const o = orderAmount(total, h, WEIGHTS[targetTier]);
  return {
    ok: true, side: o.side, amount: o.amount, total,
    targetTier, targetWeight: WEIGHTS[targetTier], weight: h / total,
  };
}

/**
 * 账本自审：重放之前先确认账本本身是自洽的。
 *
 * 存在的理由：只要有一条记录的日期不在行情序列里（比如误写成休市日），
 * 重放会静默跳过它，后面每一笔的金额都会跟着错，而界面上看不出任何异常。
 * 这种"算得出结果但结果是错的"比直接报错危险得多。
 *
 * @returns {Array<{code:string,msg:string,entry:object|null}>} 空数组表示通过
 */
export function auditLedger(rows, entries, launchDate) {
  const problems = [];
  const dates = new Set(rows.map((r) => r.d));
  let prevDate = '';
  let expectTier = 0;

  (entries || []).forEach((e, k) => {
    if (!dates.has(e.date)) {
      problems.push({ code: 'DATE_NOT_IN_SERIES', entry: e,
        msg: `第 ${e.seq ?? k + 1} 笔的执行日 ${e.date} 不在行情序列里（可能是休市日或行情缺失），该笔及之后的金额都不可信` });
    }
    if (e.date < launchDate) {
      problems.push({ code: 'BEFORE_LAUNCH', entry: e, msg: `第 ${e.seq ?? k + 1} 笔的日期 ${e.date} 早于起算日 ${launchDate}` });
    }
    if (prevDate && e.date <= prevDate) {
      problems.push({ code: 'OUT_OF_ORDER', entry: e, msg: `第 ${e.seq ?? k + 1} 笔的日期 ${e.date} 未晚于上一笔 ${prevDate}` });
    }
    if (e.tierFrom !== undefined && e.tierFrom !== expectTier) {
      problems.push({ code: 'TIER_BREAK', entry: e,
        msg: `第 ${e.seq ?? k + 1} 笔起始档位是 ${e.tierFrom}，但按前序记录推算应为 ${expectTier}` });
    }
    if (Math.abs(e.tierTo - expectTier) > 1) {
      problems.push({ code: 'TIER_JUMP', entry: e, msg: `第 ${e.seq ?? k + 1} 笔一次跨了 ${Math.abs(e.tierTo - expectTier)} 档` });
    }
    if (e.tierTo < 0 || e.tierTo > MAX_TIER) {
      problems.push({ code: 'TIER_RANGE', entry: e, msg: `第 ${e.seq ?? k + 1} 笔的目标档位 ${e.tierTo} 超出 0–${MAX_TIER}` });
    }
    if (!(e.price > 0)) {
      problems.push({ code: 'BAD_PRICE', entry: e, msg: `第 ${e.seq ?? k + 1} 笔的成交价 ${e.price} 不合法` });
    }
    prevDate = e.date;
    expectTier = e.tierTo;
  });
  return problems;
}

/** 触发线与距离 */
export function triggers(close, ma30) {
  const buyAt = ma30 * BUY_TH;
  const sellAt = ma30 * SELL_TH;
  return {
    buyAt,
    sellAt,
    ratio: close / ma30,
    pctToBuy: (buyAt / close - 1) * 100,   // 负数 = 还需下跌
    pctToSell: (sellAt / close - 1) * 100, // 正数 = 还需上涨
  };
}
