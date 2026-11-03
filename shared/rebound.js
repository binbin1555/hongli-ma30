/**
 * 创业板50 超跌反弹 · 规则核心（纯函数，不碰网络、不碰 DOM）
 *
 * Worker 的推送和 rebound.html 共用这一份 —— 两边必须说同一句话，各写各的迟早会分家。
 * 和 shared/strategy.js（红利那套）完全分开：这里出了错，波及不到红利的账本和推送。
 *
 * 规则（2026-11-03 起；标的 159682 创业板50ETF景顺；一律看 159682 的收盘价）：
 *   买  专款分三笔：50% / 25% / 25%
 *       第 1 笔 11 月 3 日开盘已买，成交价记作 P1
 *       第 2 笔 收盘 ≤ P1 × 0.88；第 3 笔 收盘 ≤ P1 × 0.76
 *   卖  下面任意一条先发生，全部卖出，交易结束（结束后不自动再来一轮）
 *       止盈 收盘 ≥ 平均成本 × 1.20；止损 收盘 ≤ 平均成本 × 0.75；到期 第 120 个交易日
 *   每个交易日按顺序检查：止损 → 止盈 → 第 2 笔 → 第 3 笔 → 到期；
 *   同一天既到止损线又到买入线，按止损执行，不再加仓；到期那天只卖不买。
 *
 * 仓库是公开的，这里不出现任何金额：仓位一律说「专款的百分之几」。
 * 金额只在 Worker 密钥 REBOUND_FUND 和手机浏览器的 localStorage 里，各自现算。
 */

export const RB_GROUP = '创业板50';
export const RB_GROUP_ACT = '创业板50·操作';
/** 盘中提醒的「快到线了」：离线不到 1% 就提醒收盘前再看一眼 */
export const RB_NEAR = 0.01;

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 2027 年的节假日安排还没公布（通常 11–12 月由国务院公布，深交所随后出日历）。
 * 在那之前，到期日按「周一到周五、去掉下面这些估计的休市日」来推，页面和推送都标「约」。
 * 2027 年日历进了仓库（每月 1 日自动刷新）之后，日历覆盖到的月份就完全照日历走，这张表不再起作用。
 *   元旦 1/1（周五）；春节 除夕 2/5（周五）到初七前后，按 2026 年的惯例休 6 个工作日；
 *   清明 4/5（周一）；劳动节 5/3–5/5
 */
export const RB_HOLIDAY_GUESS = new Set([
  '2027-01-01',
  '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
  '2027-04-05',
  '2027-05-03', '2027-05-04', '2027-05-05',
]);

// ---------------------------------------------------------------- 数字和日期

/**
 * 按 0.001 的最小价位取整。止盈线向上取，止损线和买入线向下取。
 * 收盘价本身都落在 0.001 的格子上，这样取整之后
 * 「收盘 ≥ 显示出来的止盈线」和「收盘 ≥ 成本 × 1.20」永远同真同假 ——
 * 不会出现页面写着 0.771、收盘正好 0.771 却不触发的事。
 */
export const tickUp = (x) => Math.ceil(x * 1000 - 1e-6) / 1000;
export const tickDown = (x) => Math.floor(x * 1000 + 1e-6) / 1000;

export const p3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '–');
/** 带符号的百分比，负号用 −，和红利面板一致 */
export const pc1 = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%` : '–');
const abs1 = (x) => `${Math.abs(x * 100).toFixed(1)}%`;
const share = (w) => `${Math.round(w * 100)}%`;

/** 金额：上万说「8 万」，不到一万说「2,350 元」。只在知道专款总额时才用得上 */
export function rbMoney(yuan) {
  const a = Math.abs(yuan), sign = yuan < 0 ? '−' : '';
  if (a >= 10000) return `${sign}${Math.round(a / 1000) / 10} 万`;
  return `${sign}${Math.round(a).toLocaleString('en-US')} 元`;
}
/** 买得起的份数：向下取整到 100 份（一手） */
export const rbShares = (yuan, price) => Math.floor(yuan / price / 100 + 1e-9) * 100;

export function rbBeijingDate(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function rbBeijingHM(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** '11 月 4 日'；不是今年的就带上年份：'2027 年 4 月 30 日' */
export function rbMd(d, today) {
  const md = `${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日`;
  return today && d.slice(0, 4) !== today.slice(0, 4) ? `${d.slice(0, 4)} 年 ${md}` : md;
}
export const rbWd = (d) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
/** '11 月 4 日（明天，周三）'。和红利那边同一个写法：日期永远在，「明天」只作括注 */
export function rbDay(d, today) {
  const diff = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : null;
  return `${rbMd(d, today)}（${rel ? `${rel}，` : ''}${rbWd(d)}）`;
}

/**
 * after 之后的 n 个交易日（升序）。
 * 交易日历覆盖到的月份照日历走；没覆盖到的月份按「周一到周五、去掉估计的休市日」来估，
 * 并标明 estimated —— 到期日落在 2027 年，而 2027 年的日历现在还没有。
 * 「覆盖」按月判断，和红利那边清洗数据的口径一样：某个月一个交易日都没有，就当那个月没取到。
 */
export function rbTradingDaysAfter(after, n, tradingDays = []) {
  const set = new Set(tradingDays);
  const months = new Set([...set].map((d) => d.slice(0, 7)));
  const days = [];
  let estimated = false;
  let t = Date.parse(`${after}T00:00:00Z`);
  for (let guard = 0; days.length < n && guard < n * 3 + 40; guard++) {
    t += 86400000;
    const d = new Date(t).toISOString().slice(0, 10);
    if (months.has(d.slice(0, 7))) {
      if (set.has(d)) days.push(d);
    } else {
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6 && !RB_HOLIDAY_GUESS.has(d)) { days.push(d); estimated = true; }
    }
  }
  return { days, estimated };
}

/**
 * data/rebound_series.json 的写法：一行一根 K 线。
 * 整个文件挤成一行的话，每晚那次提交在 GitHub 上只能看到「整行变了」，看不出改了哪天。
 */
export function rbSeriesJSON(series) {
  const { rows = [], ...rest } = series;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  return `${head},\n  "rows": [\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`;
}

// ---------------------------------------------------------------- 配置

/** data/rebound.json 的问题清单（空数组 = 没问题）。配置坏了就停手：宁可不推，也不推错 */
export function rbConfigProblems(cfg) {
  if (!cfg || typeof cfg !== 'object') return ['data/rebound.json 读不出来'];
  const out = [];
  const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!/^\d{6}$/.test(String(cfg.code || ''))) out.push('code 应是 6 位基金代码');
  if (!isDate(cfg.start)) out.push('start 应是日期（YYYY-MM-DD）');
  const W = cfg.weights;
  if (!Array.isArray(W) || W.length !== 3 || W.some((w) => !(w > 0)) || W.reduce((a, b) => a + b, 0) > 1 + 1e-9) {
    out.push('weights 应是三个正数，合计不超过 1');
  }
  const L = cfg.ladder;
  if (!Array.isArray(L) || L.length !== 2 || !(L[0] < 1 && L[1] > 0 && L[1] < L[0])) out.push('ladder 应是两个递减的、介于 0 和 1 之间的数');
  if (!(cfg.tp > 1)) out.push('tp 应大于 1');
  if (!(cfg.sl > 0 && cfg.sl < 1)) out.push('sl 应介于 0 和 1 之间');
  if (!(Number.isInteger(cfg.maxDays) && cfg.maxDays > 0)) out.push('maxDays 应是正整数');
  if (!Array.isArray(cfg.fills)) out.push('fills 应是数组');
  else {
    const f1 = cfg.fills.find((f) => f && f.k === 1);
    if (!f1 || f1.d !== cfg.start || !(f1.p > 0)) out.push('fills 里要有第 1 笔（k 为 1），日期等于 start，价格大于 0');
    const seen = new Set();
    for (const f of cfg.fills) {
      if (!f || ![1, 2, 3].includes(f.k)) { out.push(`fills 里有一笔的 k 不是 1、2、3：${JSON.stringify(f)}`); continue; }
      if (seen.has(f.k)) out.push(`第 ${f.k} 笔记了两次`);
      seen.add(f.k);
      if (!isDate(f.d) || (isDate(cfg.start) && f.d < cfg.start)) out.push(`第 ${f.k} 笔的日期不对：${f.d}`);
      if (!(f.p > 0)) out.push(`第 ${f.k} 笔的价格不对：${f.p}`);
    }
  }
  if (cfg.exit != null) {
    const e = cfg.exit;
    if (!e || !isDate(e.d) || !(e.p > 0) || (isDate(cfg.start) && e.d <= cfg.start)) out.push('exit 应是 {d, p}，日期在起始日之后、价格大于 0');
  }
  return out;
}

// ---------------------------------------------------------------- 重放

/**
 * 按规则把行情从起始日逐日走一遍，得出每一笔、每一天的线和结局。
 *
 * 不存可变状态：每次都从 data/rebound.json（规则 + 实际成交）和行情重放 ——
 * 和红利那边的账本同一个思路，哪天写坏了也不会一路错下去。
 *
 * 模型按「当天 14:50 照规则做了、成交价约等于收盘价」来记（回测也是这个口径）。
 * fills / exit 里记了实际成交的，以实际为准：那一笔按实际的日期和价格算，
 * 不再按收盘价自动记 —— 晚一天才买到、或者按盘中价买了但收盘又回到了线上方，都靠它校正。
 *
 * rows 是升序的 [{d, c, h?, l?}]，想看哪天就先截到哪天。
 */
export function rbReplay(cfg, rows) {
  const problems = rbConfigProblems(cfg);
  if (problems.length) return { ok: false, problem: problems[0], problems };
  const W = cfg.weights;
  const f1 = cfg.fills.find((f) => f.k === 1);
  const P1 = f1.p;
  const addLines = cfg.ladder.map((x) => tickDown(P1 * x));
  const actual = new Map(cfg.fills.filter((f) => f.k > 1).map((f) => [f.k, f]));
  const tranches = W.map((w, i) => ({ k: i + 1, w, d: null, p: null, model: false, trig: null }));
  Object.assign(tranches[0], { d: f1.d, p: P1, trig: f1.d });
  // 平均成本 = 投入 ÷ 份数。投入按专款的比例记（0.5、0.25……），份数 = 比例 ÷ 成交价
  let inv = W[0], units = W[0] / P1;
  const lines = () => { const avg = inv / units; return { avg, tp: tickUp(avg * cfg.tp), sl: tickDown(avg * cfg.sl) }; };
  const events = [{ d: f1.d, day: 0, kind: 'buy', k: 1, p: P1, model: false }];

  const s = rows.findIndex((r) => r.d >= cfg.start);
  if (s < 0) {
    // 行情还没到起始日（比如开盘买完、当晚 21:05 还没跑）
    return { ok: true, P1, addLines, tranches, events, exit: null, s: -1, steps: [], day: null, last: null, prev: rows[rows.length - 1] || null, inv, ...lines() };
  }
  if (rows[s].d !== cfg.start) return { ok: false, problem: `行情里没有起始日 ${cfg.start}`, problems: [`行情里没有起始日 ${cfg.start}`] };

  const steps = [{ d: rows[s].d, day: 0, ...lines() }];
  let exit = null;
  for (let i = s + 1; i < rows.length; i++) {
    const r = rows[i], day = i - s, L = lines();
    if (cfg.exit) {
      if (cfg.exit.d === r.d) exit = { d: r.d, day, p: cfg.exit.p, why: cfg.exit.why || 'manual', model: false };
    } else if (r.c <= L.sl) exit = { d: r.d, day, p: r.c, why: 'sl', model: true, line: L.sl };
    else if (r.c >= L.tp) exit = { d: r.d, day, p: r.c, why: 'tp', model: true, line: L.tp };
    if (!exit) {
      for (const t of tranches.slice(1)) {
        if (t.d) continue;
        const line = addLines[t.k - 2];
        if (!t.trig && r.c <= line) t.trig = r.d;
        const a = actual.get(t.k);
        // 到期那天只卖不买：买进来当天收盘就得全卖，白交两次手续费
        if (a ? a.d === r.d : day < cfg.maxDays && r.c <= line) {
          Object.assign(t, { d: r.d, p: a ? a.p : r.c, model: !a });
          inv += t.w; units += t.w / t.p;
          events.push({ d: r.d, day, kind: 'buy', k: t.k, p: t.p, model: t.model, line });
        }
      }
      if (!cfg.exit && day >= cfg.maxDays) exit = { d: r.d, day, p: r.c, why: 'exp', model: true };
    }
    steps.push({ d: r.d, day, ...lines() });
    if (exit) break;
  }
  const lastIdx = exit ? s + exit.day : rows.length - 1;
  const lastD = rows[lastIdx].d;
  // 记了实际成交、日期也已经在行情范围里，却一直没对上任何一天 —— 多半是日期写错了（比如写成了周末）
  for (const a of actual.values()) {
    if (!tranches[a.k - 1].d && a.d <= lastD) {
      const m = `第 ${a.k} 笔的实际成交日 ${a.d} 不是行情里的交易日`;
      return { ok: false, problem: m, problems: [m] };
    }
  }
  if (cfg.exit && !exit && cfg.exit.d <= lastD) {
    const m = `实际卖出日 ${cfg.exit.d} 不是行情里的交易日`;
    return { ok: false, problem: m, problems: [m] };
  }
  return {
    ok: true, P1, addLines, tranches, events, exit, s, steps,
    day: lastIdx - s, last: rows[lastIdx], prev: rows[lastIdx - 1] || null, inv, ...lines(),
  };
}

/**
 * 现在处在哪一步、下一步盯哪几条线。推送和页面都只读它的结果。
 *   cfg          data/rebound.json
 *   rows         行情（升序）
 *   tradingDays  仓库里已有的交易日历（可以不全，没覆盖到的月份会估算并标「约」）
 *   since        上一次送达的推送说到了哪天的收盘：比它新的买卖才算「新出的事」。
 *                某晚推送没送达，下一晚会把那天的事一起补说，而不是就此漏掉
 */
export function rbStatus({ cfg, rows, tradingDays = [], since = null }) {
  const rp = rbReplay(cfg, rows);
  if (!rp.ok) return { ok: false, problem: rp.problem, problems: rp.problems };
  const phase = rp.s < 0 ? 'pre' : rp.exit ? 'done' : 'open';
  const last = rp.last;
  const c = last ? last.c : rp.P1;
  const chg = last && rp.prev ? last.c / rp.prev.c - 1 : null;
  const exp = rbTradingDaysAfter(cfg.start, cfg.maxDays, tradingDays);
  const day = rp.day ?? 0;
  const expiry = { d: exp.days[cfg.maxDays - 1] || null, estimated: exp.estimated, left: cfg.maxDays - day };
  const nx = rbTradingDaysAfter(last ? last.d : cfg.start, 1, tradingDays);
  const nextDay = { d: nx.days[0] || null, estimated: nx.estimated };

  const nextAdd = rp.tranches.find((t) => !t.d) || null;
  const watch = [];
  if (phase !== 'done') {
    if (nextAdd) watch.push({ kind: 'add', k: nextAdd.k, w: nextAdd.w, line: rp.addLines[nextAdd.k - 2] });
    watch.push({ kind: 'tp', line: rp.tp });
    watch.push({ kind: 'sl', line: rp.sl, behind: !!nextAdd && rp.sl < rp.addLines[nextAdd.k - 2] });
    for (const x of watch) x.dist = x.line / c - 1;
  }

  const fresh = rp.events.filter((e) => since == null || e.d > since);
  const exitFresh = rp.exit && (since == null || rp.exit.d > since) ? rp.exit : null;

  // 盘中碰过线、收盘又回去了：按收盘价不算触发，可你 14:50 也许已经照盘中价做了。
  // 拿当天开盘前生效的那组线比（当天有买卖的话，买卖之后的线已经变了）
  const touches = [];
  if (phase === 'open' && last && day > 0 && last.h > 0 && last.l > 0) {
    const L = rp.steps[rp.steps.length - 2];
    const doneToday = new Set(rp.events.filter((e) => e.d === last.d).map((e) => e.k));
    for (const t of rp.tranches.slice(1)) {
      const line = rp.addLines[t.k - 2];
      if (!t.d && !doneToday.has(t.k) && last.l <= line && last.c > line) touches.push({ kind: 'add', k: t.k, line, ext: last.l });
    }
    if (last.h >= L.tp && last.c < L.tp) touches.push({ kind: 'tp', line: L.tp, ext: last.h });
    if (last.l <= L.sl && last.c > L.sl) touches.push({ kind: 'sl', line: L.sl, ext: last.l });
  }

  const px = rp.exit ? rp.exit.p : c;
  const pnl = px / rp.avg - 1;
  return {
    ok: true, phase, cfg, rp, last, c, chg, day, expiry, nextDay, nextAdd, watch, fresh, exitFresh, touches,
    pnl, inv: rp.inv, fundPnl: rp.inv * pnl, tradingDays,
  };
}

// ---------------------------------------------------------------- 文案

const WHY = { tp: '止盈', sl: '止损', exp: '到期', manual: '实际卖出' };

/** 买第 k 笔要花多少。知道专款总额才说金额和份数，否则只说比例 */
function sizeText(w, price, fund) {
  if (!(fund > 0)) return `专款的 ${share(w)}`;
  const amt = fund * w;
  return `专款的 ${share(w)}，约 ${rbMoney(amt)}，按 ${p3(price)} 约 ${rbShares(amt, price).toLocaleString('en-US')} 份`;
}

/**
 * 接下来盯的几条线，一行一条，按「先碰到哪条」排：下方先说买入线，止损线在它下面就不提
 * （跌下去先碰到的是买入线，买完止损线还会重算）。
 */
export function rbWatchLines(st, { fund = 0 } = {}) {
  const out = [];
  for (const x of st.watch) {
    if (x.kind === 'add') out.push(`↓ ≤ ${p3(x.line)}：买第 ${x.k} 笔（${sizeText(x.w, x.line, fund)}），还要跌 ${abs1(x.dist)}`);
    if (x.kind === 'tp') out.push(`↑ ≥ ${p3(x.line)}：全部卖出（止盈），还要涨 ${abs1(x.dist)}`);
    if (x.kind === 'sl' && !x.behind) out.push(`↓ ≤ ${p3(x.line)}：全部卖出（止损），还要跌 ${abs1(x.dist)}`);
  }
  return out;
}

/** '还剩 119 个交易日，约 2027 年 4 月 30 日（周五）到期' */
export function rbExpiryText(st, today) {
  const e = st.expiry;
  if (!e.d) return `还剩 ${e.left} 个交易日到期`;
  return `还剩 ${e.left} 个交易日，${e.estimated ? '约 ' : ''}${rbMd(e.d, today)}（${rbWd(e.d)}）到期`;
}

/** '成本 1.075 · 持仓 −0.7% · 已投入专款的 50%'；知道专款总额时带上金额 */
export function rbHoldLine(st, { fund = 0 } = {}) {
  const base = `成本 ${p3(st.rp.avg)} · 持仓 ${pc1(st.pnl)}`;
  if (!(fund > 0)) return `${base} · 已投入专款的 ${share(st.inv)}`;
  return `${base}（约 ${rbMoney(fund * st.inv * st.pnl)}）· 已投入约 ${rbMoney(fund * st.inv)}`;
}

/** 盘中碰线的提醒，一条一行 */
function touchLines(st) {
  return st.touches.map((t) => {
    const what = t.kind === 'add' ? `第 ${t.k} 笔买入线 ${p3(t.line)}` : t.kind === 'tp' ? `止盈线 ${p3(t.line)}` : `止损线 ${p3(t.line)}`;
    const hl = t.kind === 'tp' ? '最高' : '最低';
    const did = t.kind === 'add' ? '买了' : '卖了';
    return `⚠️ 盘中${hl} ${p3(t.ext)} 碰到过${what}，收盘 ${p3(st.c)} 又回去了，按收盘价不算。`
      + `若 14:50 已经${did}，请更新成交记录（见页面）`;
  });
}

/** 「已经做了 / 还没做」两行：规则是 14:50 照价格操作，而这条推送 21:05 才到 */
function didOrNot(st, today, verb) {
  const nd = st.nextDay.d;
  const when = nd ? `${rbDay(nd, today)} 14:50` : '下一个交易日 14:50';
  return [`· 当天 14:50 已经${verb}了：${verb === '卖' ? '交易结束，' : ''}不用再动`, `· 还没${verb}：${when} 补上，不论那时价格`];
}

/**
 * 每晚 21:05 那条推送。返回 null 表示今晚不推（还没开始，或者交易早就结束了）。
 * 先后顺序：刚卖出 > 刚买入 > 明天到期 > 平常。
 */
export function rbNightPush(st, { today, fund = 0, resent = null } = {}) {
  if (!st.ok) {
    return {
      title: '⚠️ 创业板50 · 规则文件有问题',
      body: `${st.problem}\n今晚没有给出操作建议。请检查 data/rebound.json，改好后下一轮会自动恢复。`,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  if (st.phase === 'pre') return null;
  if (st.phase === 'done' && !st.exitFresh) return null;
  const tail = resent ? `\n↻ 补发：${resent}` : '';
  const head = `${rbMd(st.last.d, today)}收盘 ${p3(st.last.c)}${st.chg != null ? `（${pc1(st.chg)}）` : ''}`;

  if (st.exitFresh) {
    const x = st.exitFresh;
    // 卖出那天不会再买，所以最后一组线就是当天生效的那组
    const L = st.rp.steps[st.rp.steps.length - 1];
    const rule = x.why === 'tp' ? `收盘 ≥ ${p3(L.tp)}（成本 ${p3(L.avg)} × ${st.cfg.tp.toFixed(2)}）`
      : x.why === 'sl' ? `收盘 ≤ ${p3(L.sl)}（成本 ${p3(L.avg)} × ${st.cfg.sl.toFixed(2)}）`
        : x.why === 'exp' ? `第 ${st.cfg.maxDays} 个交易日不论盈亏` : '按记下的实际卖出';
    const icon = x.why === 'sl' ? '⛔' : x.why === 'exp' ? '⏰' : '🔔';
    const lines = x.model
      ? [`规则：${rule} → 全部卖出，交易结束`, ...didOrNot(st, today, '卖')]
      : [`已记下实际卖出：${rbMd(x.d, today)} @ ${p3(x.p)}`];
    return {
      title: `${icon} 创业板50 · ${rbMd(x.d, today)}收盘 ${p3(st.last.c)}，${x.why === 'exp' ? '到期了' : `到了${WHY[x.why]}线`} → 全部卖出`,
      body: [...lines, `按${x.model ? '收盘' : '成交价'}算：持仓 ${pc1(st.pnl)}，专款整体 ${pc1(st.fundPnl)}`
        + (fund > 0 ? `（约 ${rbMoney(fund * st.fundPnl)}）` : ''), '交易结束后不自动再来一轮'].join('\n') + tail,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }

  const buys = st.fresh.filter((e) => e.kind === 'buy' && e.k > 1);
  const expiryLine = `⏳ ${rbExpiryText(st, today)}`;
  if (buys.length) {
    const model = buys.filter((b) => b.model);
    const ks = buys.map((b) => b.k);
    const w = buys.reduce((a, b) => a + st.rp.tranches[b.k - 1].w, 0);
    const lines = [];
    if (model.length) {
      const rule = model.map((b) => `收盘 ≤ ${p3(b.line)} 买第 ${b.k} 笔`).join('、');
      lines.push(`规则：${rule}${model.length > 1 ? ' → 两笔一起买' : ''}（${sizeText(w, st.last.c, fund)}）`, ...didOrNot(st, today, '买'));
      lines.push(`买入后（按收盘价估）成本约 ${p3(st.rp.avg)} → 止盈线 ${p3(st.rp.tp)}、止损线 ${p3(st.rp.sl)}`);
    } else {
      lines.push(`已记下实际成交：${buys.map((b) => `第 ${b.k} 笔 ${rbMd(b.d, today)} @ ${p3(b.p)}`).join('、')}`);
      lines.push(`成本 ${p3(st.rp.avg)} → 止盈线 ${p3(st.rp.tp)}、止损线 ${p3(st.rp.sl)}`);
    }
    lines.push('接下来：', ...rbWatchLines(st, { fund }), expiryLine);
    return {
      title: `🔔 创业板50 · ${rbMd(buys[buys.length - 1].d, today)}收盘 ${p3(st.last.c)}，`
        + (model.length ? `到了第 ${ks.join('、')} 笔买入线` : `第 ${ks.join('、')} 笔已记账`),
      body: lines.join('\n') + tail,
      level: model.length ? 'timeSensitive' : 'active', group: model.length ? RB_GROUP_ACT : RB_GROUP, action: model.length > 0,
    };
  }

  const nd = st.nextDay.d;
  const ndText = nd ? rbDay(nd, today) : '下一个交易日';
  const touch = touchLines(st);
  if (st.expiry.left === 1) {
    return {
      title: `⏰ 创业板50 · ${nd ? rbMd(nd, today) : '下一个交易日'}到期 → 14:50 全部卖出`,
      body: [`${ndText}是第 ${st.cfg.maxDays} 个交易日：不论盈亏，14:50 全部卖出，交易结束`,
        `${head}${head.endsWith('）') ? '' : ' '}· ${rbHoldLine(st, { fund })}`, ...touch].join('\n') + tail,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  const first = st.fresh.some((e) => e.k === 1);
  return {
    // 括号后面直接接「·」，别再空一格：「（−1.6%） · 」在手机上看着像断了
    title: `创业板50 · ${head}${head.endsWith('）') ? '' : ' '}· ${first ? '第 1 笔已买入' : '不用操作'}`,
    body: [
      ...(first ? [`第 1 笔：${rbMd(st.cfg.start, today)}买入 @ ${p3(st.rp.P1)}（专款的 ${share(st.cfg.weights[0])}）`] : []),
      `下一步：${ndText}14:50 看一眼价格`,
      ...rbWatchLines(st, { fund }),
      '都没到就不动',
      expiryLine,
      rbHoldLine(st, { fund }),
      ...touch,
    ].join('\n') + tail,
    level: touch.length ? 'active' : 'passive', group: RB_GROUP, action: false,
  };
}

/**
 * 14:45 盘中提醒。只在真要动手的时候响：现价已经过线、离线不到 1%、或者今天就是到期日。
 * 其余日子一律返回 null，不推 —— 天天响的提醒，响到第三天就没人看了。
 *   quote  { c, d }：实时价，d 必须是今天
 */
export function rbIntradayPush(st, quote, { today, fund = 0 } = {}) {
  if (!st.ok || st.phase !== 'open' || !st.last || !quote || quote.d !== today || !(quote.c > 0)) return null;
  // 今天是第几个交易日：行情只到上一个交易日，往后数到今天
  const ahead = rbTradingDaysAfter(st.last.d, 10, st.tradingDays).days.indexOf(today);
  if (ahead < 0) return null;
  const day = st.day + ahead + 1;
  const c = quote.c;
  const pos = c / st.rp.avg - 1;
  const now = `现价 ${p3(c)}（持仓 ${pc1(pos)}）`;
  if (day >= st.cfg.maxDays) {
    return {
      title: `⏰ 创业板50 · ${rbMd(today, today)}到期 → 14:50 全部卖出`,
      body: `${rbDay(today, today)}是第 ${st.cfg.maxDays} 个交易日：不论盈亏，14:50 全部卖出，交易结束\n${now}`,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  const { sl, tp } = st.rp;
  if (c <= sl) {
    return {
      title: `⛔ 创业板50 · 现价 ${p3(c)}，已到止损线 ${p3(sl)}`,
      body: `规则：收盘 ≤ ${p3(sl)} → 全部卖出，交易结束\n14:50 之后价格仍 ≤ ${p3(sl)}，就全部卖出\n${now}`,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  if (c >= tp) {
    return {
      title: `🔔 创业板50 · 现价 ${p3(c)}，已到止盈线 ${p3(tp)}`,
      body: `规则：收盘 ≥ ${p3(tp)} → 全部卖出，交易结束\n14:50 之后价格仍 ≥ ${p3(tp)}，就全部卖出\n${now}`,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  const open = st.rp.tranches.filter((t) => !t.d);
  const hit = open.filter((t) => c <= st.rp.addLines[t.k - 2]);
  if (hit.length) {
    const w = hit.reduce((a, t) => a + t.w, 0);
    const line = st.rp.addLines[hit[hit.length - 1].k - 2];
    return {
      title: `🔔 创业板50 · 现价 ${p3(c)}，已到第 ${hit.map((t) => t.k).join('、')} 笔买入线`,
      body: `规则：收盘 ≤ ${hit.map((t) => p3(st.rp.addLines[t.k - 2])).join(' / ')} → 买第 ${hit.map((t) => t.k).join('、')} 笔（${sizeText(w, c, fund)}）`
        + `\n14:50 之后价格仍 ≤ ${p3(line)}，就买入\n${now}`,
      level: 'timeSensitive', group: RB_GROUP_ACT, action: true,
    };
  }
  // 「只差多少」一律是从现价再走多远才到线，和推送、页面上「还要跌 / 还要涨」同一个口径
  const near = [];
  const gap = (line) => Math.abs(line / c - 1);
  for (const t of open) { const line = st.rp.addLines[t.k - 2]; if (gap(line) <= RB_NEAR) near.push(`第 ${t.k} 笔买入线 ${p3(line)} 只差 ${abs1(gap(line))}`); }
  if (gap(tp) <= RB_NEAR) near.push(`止盈线 ${p3(tp)} 只差 ${abs1(gap(tp))}`);
  if (gap(sl) <= RB_NEAR) near.push(`止损线 ${p3(sl)} 只差 ${abs1(gap(sl))}`);
  if (!near.length) return null;
  return {
    title: `创业板50 · 现价 ${p3(c)}，快到线了`,
    body: `离${near.join('；离')}\n收盘前再看一眼：真到了线就照规则做，没到就不动\n${now}`,
    level: 'active', group: RB_GROUP, action: false,
  };
}
