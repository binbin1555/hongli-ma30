/**
 * 红利 MA30 停车策略 · Cloudflare Worker
 *
 * 由 cron-job.org 在每个交易日北京时间 21:00 触发一次：
 *   查交易日历 → 抓中证数据 → 10 项校验 → 算信号 → 提交 GitHub → 发 Bark 推送
 *
 * 设计原则：
 *   1. 任何一项校验不过，都要推一条带原因的告警，绝不静默失败。
 *   2. 仓库里不写任何金额。金额由本金（Worker 密钥 / 前端 localStorage）实时推导。
 *   3. 所有资金状态每次从账本重放得出，不存可变状态，杜绝写坏和漂移。
 */

import {
  ma, signal, nextTier, replay, plannedOrder, shares, triggers, auditLedger,
  WEIGHTS, MA_LEN, BUY_TH, SELL_TH,
} from '../../shared/strategy.js';

const CSI = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';
const SZSE = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';
const EM = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------- 基础工具

/** 北京时间的 YYYY-MM-DD */
function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function beijingStamp(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function shiftDays(ymd, n) {
  const t = Date.parse(ymd + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const compact = (s) => s.replace(/-/g, '');

async function retryFetch(url, opts = {}, tries = 4, label = '') {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      if (r.ok) return r;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error(`${label || url} 请求失败：${last}`);
}

// UTF-8 安全的 base64（Worker 里 btoa 不认多字节）
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------- GitHub

function gh(env) {
  const base = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hongli-ma30-worker',
  };

  // 分支名不写死：GH_BRANCH 没配就问 GitHub 要默认分支。
  // main 还是 master 各家仓库不一样，写死会在第一次运行时静默 404。
  let branchCache = env.GH_BRANCH || null;
  async function branchName() {
    if (branchCache) return branchCache;
    const r = await retryFetch(base, { headers }, 3, '仓库信息');
    branchCache = (await r.json()).default_branch;
    if (!branchCache) throw new Error('拿不到默认分支名');
    return branchCache;
  }

  return {
    branchName,
    async readJSON(path, fallback = null) {
      const branch = await branchName();
      const r = await fetch(`${base}/contents/${path}?ref=${branch}`, { headers });
      if (r.status === 404) return fallback;
      if (!r.ok) throw new Error(`读取 ${path} 失败：HTTP ${r.status}`);
      const j = await r.json();
      return JSON.parse(b64decode(j.content));
    },
    /** 一次提交写入多个文件，保证原子性 */
    async commit(files, message) {
      const branch = await branchName();
      const refRes = await retryFetch(`${base}/git/ref/heads/${branch}`, { headers }, 3, 'git ref');
      const baseSha = (await refRes.json()).object.sha;

      const cRes = await retryFetch(`${base}/git/commits/${baseSha}`, { headers }, 3, 'git commit');
      const baseTree = (await cRes.json()).tree.sha;

      const tree = [];
      for (const f of files) {
        const bRes = await retryFetch(`${base}/git/blobs`, {
          method: 'POST', headers,
          body: JSON.stringify({ content: b64encode(f.content), encoding: 'base64' }),
        }, 3, 'git blob');
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: (await bRes.json()).sha });
      }

      const tRes = await retryFetch(`${base}/git/trees`, {
        method: 'POST', headers, body: JSON.stringify({ base_tree: baseTree, tree }),
      }, 3, 'git tree');
      const treeSha = (await tRes.json()).sha;

      const nRes = await retryFetch(`${base}/git/commits`, {
        method: 'POST', headers,
        body: JSON.stringify({ message, tree: treeSha, parents: [baseSha] }),
      }, 3, 'git create commit');
      const newSha = (await nRes.json()).sha;

      await retryFetch(`${base}/git/refs/heads/${branch}`, {
        method: 'PATCH', headers, body: JSON.stringify({ sha: newSha, force: false }),
      }, 3, 'git update ref');

      return newSha;
    },
  };
}

// ---------------------------------------------------------------- 数据源

/** 深交所官方交易日历：返回 {'2026-09-10': 1, ...} */
async function fetchCalendarMonth(month) {
  const r = await retryFetch(`${SZSE}?month=${month}&random=0.${Date.now() % 99999}`, {
    headers: { Referer: 'https://www.szse.cn/' },
  }, 4, `深交所日历 ${month}`);
  const j = await r.json();
  const out = {};
  for (const x of j.data || []) out[x.jyrq] = x.jybz === '1' ? 1 : 0;
  return out;
}

/** 中证指数日线。返回升序 [{d,c,pct}]，已剔除周末 / 元旦 / 幽灵行 */
async function fetchCSI(code, startYmd, endYmd) {
  const r = await retryFetch(
    `${CSI}?indexCode=${code}&startDate=${compact(startYmd)}&endDate=${compact(endYmd)}`,
    { headers: { Referer: 'https://www.csindex.com.cn/', Accept: 'application/json' } },
    4, `中证 ${code}`
  );
  const j = await r.json();
  if (j.code !== '200') throw new Error(`中证 ${code} 返回异常 code=${j.code}`);

  const removed = { dup: [], weekend: [], newyear: [], ghost: [] };
  const seen = new Set();
  let rows = [];
  for (const x of j.data || []) {
    if (x.close == null) continue;
    const d = ymd(x.tradeDate);
    if (seen.has(d)) { removed.dup.push(d); continue; }
    seen.add(d);
    rows.push({ d, c: +x.close, pct: x.changePct == null ? null : +x.changePct });
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : 1));
  const rawCount = rows.length;

  // 坑 1：周末与 MMDD=0101 的幽灵行
  rows = rows.filter((r0) => {
    const wd = new Date(r0.d + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) { removed.weekend.push(r0.d); return false; }
    if (r0.d.slice(5) === '01-01') { removed.newyear.push(r0.d); return false; }
    return true;
  });
  // 坑 2：节假日补的幽灵行 —— 收盘价与前一日完全相同
  const clean = [];
  for (const r0 of rows) {
    if (clean.length && clean[clean.length - 1].c === r0.c) { removed.ghost.push(r0.d); continue; }
    clean.push(r0);
  }
  return { rows: clean, removed, rawCount };
}

/** 东方财富 ETF 日线，用于换算参考股数 */
async function fetchETF(code, startYmd, endYmd) {
  const url = `${EM}?secid=1.${code}&klt=101&fqt=1&beg=${compact(startYmd)}&end=${compact(endYmd)}`
    + `&fields1=f1,f2,f3&fields2=f51,f53`;
  const r = await retryFetch(url, {}, 3, `东方财富 ${code}`);
  const j = await r.json();
  const k = (j.data && j.data.klines) || [];
  return k.map((s) => {
    const [d, c] = s.split(',');
    return { d, c: +c };
  });
}

// ---------------------------------------------------------------- 校验

/**
 * 校验 3–9。fatal 为 true 的失败会阻止写入。
 * 校验 1（交易日历）和 2（数据到位）在主流程里单独处理。
 */
function runChecks(rows, removed, today, etf, tierFrom, tierTo, calendar) {
  const checks = [];
  const add = (id, name, ok, detail, fatal = true) =>
    checks.push({ id, name, ok, detail, fatal });

  // 3 结构：日期严格递增、无重复、清洗后每一天都在官方交易日历里
  let structOk = true, structMsg = '';
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].d <= rows[i - 1].d) {
      structOk = false; structMsg = `日期未严格递增：${rows[i - 1].d} → ${rows[i].d}`; break;
    }
  }
  if (structOk && calendar && calendar.length) {
    const cal = new Set(calendar);
    const strays = rows.filter((r) => r.d >= calendar[0] && !cal.has(r.d)).map((r) => r.d);
    if (strays.length) {
      structOk = false;
      structMsg = `有 ${strays.length} 天不在官方交易日历里：${strays.slice(0, 3).join('、')}`;
    }
  }
  add(3, '结构：日期递增且都是官方交易日', structOk, structMsg || `${rows.length} 行，逐日核对交易所日历一致`);

  // 4 幽灵行：清洗掉了多少 + 清洗后确认已无残留
  let ghost = '';
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].c === rows[i - 1].c) { ghost = `清洗后仍有残留：${rows[i - 1].d} 与 ${rows[i].d} 同为 ${rows[i].c}`; break; }
  }
  const cut = removed
    ? removed.ghost.length + removed.weekend.length + removed.newyear.length + removed.dup.length
    : 0;
  const cutDetail = removed
    ? `剔除 ${cut} 行（幽灵 ${removed.ghost.length}／周末 ${removed.weekend.length}／元旦 ${removed.newyear.length}／重复 ${removed.dup.length}）`
    : '无清洗信息';
  add(4, '幽灵行已清除', !ghost, ghost || cutDetail);

  // 5 涨跌幅逐行对账
  let pctBad = '';
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pct == null) continue;
    const computed = (rows[i].c / rows[i - 1].c - 1) * 100;
    if (Math.abs(computed - rows[i].pct) > 0.02) {
      pctBad = `${rows[i].d} 接口报 ${rows[i].pct}%，自算 ${computed.toFixed(3)}%`; break;
    }
  }
  add(5, '涨跌幅与收盘价对账', !pctBad, pctBad || '逐行一致');

  // 6 异常波动
  let wild = '';
  for (let i = 1; i < rows.length; i++) {
    const ch = Math.abs(rows[i].c / rows[i - 1].c - 1);
    if (ch > 0.11) { wild = `${rows[i].d} 单日 ${(ch * 100).toFixed(2)}%`; break; }
  }
  add(6, '单日波动在 ±11% 内', !wild, wild || '通过');

  // 7 MA30 完整性
  const enough = rows.length >= MA_LEN;
  add(7, `MA30 有满 ${MA_LEN} 个交易日`, enough, `${rows.length} / ${MA_LEN}`);

  // 8 ETF 日期与指数日期一致（拦盘中实时条）—— 非致命，失败只是不给股数
  const etfOk = !!etf && etf.d === today;
  add(8, 'ETF 报价日期与指数一致', etfOk,
    etf ? `ETF ${etf.d} vs 指数 ${today}` : '未取到 ETF 报价', false);

  // 9 档位连续性
  const step = Math.abs(tierTo - tierFrom);
  const tierOk = step <= 1 && tierTo >= 0 && tierTo <= 4;
  add(9, '档位一天最多动一档', tierOk, `${tierFrom} → ${tierTo}`);

  return checks;
}

// ---------------------------------------------------------------- Bark

async function bark(env, { title, body, level = 'active', group = '红利MA30' }) {
  if (!env.BARK_KEY) return { skipped: '未配置 BARK_KEY' };
  const payload = {
    device_key: env.BARK_KEY,
    title, body, group, level,
    url: env.PAGES_URL || undefined,
    icon: env.BARK_ICON || undefined,
  };
  try {
    const r = await retryFetch('https://api.day.app/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    }, 3, 'Bark');
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

const money = (n) => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------- 主流程

async function runDaily(env, { force = false } = {}) {
  const today = beijingDate();
  const log = [];
  const G = gh(env);

  // ---- 校验 1：今天是不是交易日 ----
  const year = today.slice(0, 4);
  let cal = await G.readJSON(`calendar/${year}.json`);
  if (!cal || !cal.tradingDays.includes(today)) {
    // 日历里没有今天，可能是休市，也可能是日历没更新到
    const monthMap = await fetchCalendarMonth(today.slice(0, 7)).catch(() => null);
    if (!monthMap) {
      await bark(env, {
        title: '⚠️ 红利MA30 · 交易日历取不到',
        body: `${today} 无法确认是否交易日，本次未运行。请检查深交所接口。`,
        level: 'timeSensitive',
      });
      return { ok: false, today, reason: '交易日历不可用' };
    }
    if (monthMap[today] !== 1) {
      return { ok: true, today, skipped: '非交易日，静默' };
    }
    // 日历过期但交易所说今天开市 —— 顺手把日历补上
    cal = cal || { year: +year, tradingDays: [] };
    const merged = new Set(cal.tradingDays);
    for (const [d, v] of Object.entries(monthMap)) if (v === 1) merged.add(d);
    cal.tradingDays = [...merged].sort();
    cal.tradingDayCount = cal.tradingDays.length;
    cal.fetchedAt = new Date().toISOString();
    log.push('交易日历已就地补齐');
  }

  // ---- 幂等：同一天不重复跑 ----
  const state = await G.readJSON('data/state.json');
  if (!state) throw new Error('data/state.json 不存在，请先完成仓库初始化');
  if (state.asof === today && !force) {
    return { ok: true, today, skipped: '今日已运行过（加 &force=1 可强制重跑）' };
  }

  // ---- 抓数据 ----
  const from = shiftDays(today, -150);
  const [idxRes, bondRes] = await Promise.all([
    fetchCSI('H00922', from, today),
    fetchCSI('H11001', from, today).catch(() => ({ rows: [], removed: null })),
  ]);
  const idx = idxRes.rows;
  const removed = idxRes.removed;
  const bond = bondRes.rows;

  // ---- 校验 2：今天的数据到位了吗 ----
  const lastRow = idx[idx.length - 1];
  if (!lastRow || lastRow.d !== today) {
    await bark(env, {
      title: '⚠️ 红利MA30 · 今日数据未到',
      body: `交易日历显示 ${today} 开市，但中证接口最新数据只到 ${lastRow ? lastRow.d : '无'}。`
        + `本次未写入，请稍后手动重跑或检查数据源。`,
      level: 'timeSensitive',
    });
    return { ok: false, today, reason: `数据未到位，最新 ${lastRow ? lastRow.d : '无'}` };
  }

  // ---- ETF 报价 ----
  let etf = null;
  try {
    const k = await fetchETF(env.ETF_CODE || '515180', shiftDays(today, -20), today);
    // 只认与指数同一天的那根，挡掉盘中实时条
    etf = k.find((x) => x.d === today) || (k.length ? k[k.length - 1] : null);
  } catch (e) {
    log.push(`ETF 报价获取失败：${e.message}`);
  }

  // ---- 合并进 series ----
  const series = await G.readJSON('data/series.json');
  const bondByDate = new Map(bond.map((b) => [b.d, b.c]));
  const known = new Map(series.rows.map((r) => [r.d, r]));
  const closes = idx.map((r) => r.c);
  for (let i = 0; i < idx.length; i++) {
    const r = idx[i];
    const window = closes.slice(Math.max(0, i - MA_LEN + 1), i + 1);
    const m = window.length === MA_LEN ? window.reduce((a, b2) => a + b2, 0) / MA_LEN : null;
    const prev = known.get(r.d);
    known.set(r.d, {
      d: r.d,
      c: +r.c.toFixed(2),
      m: m != null ? +m.toFixed(2) : (prev ? prev.m : null),
      b: bondByDate.has(r.d) ? +bondByDate.get(r.d).toFixed(4) : (prev ? prev.b : null),
    });
  }
  const rows = [...known.values()].sort((a, b2) => (a.d < b2.d ? -1 : 1));
  series.rows = rows;
  series.updated = today;

  // ---- MA30 与信号 ----
  const upto = rows.filter((r) => r.d <= today).map((r) => r.c);
  const ma30 = ma(upto, MA_LEN);
  if (ma30 == null) throw new Error(`MA30 不可用：只有 ${upto.length} 个收盘价`);
  const close = lastRow.c;
  const trig = triggers(close, ma30);

  // ---- 执行昨日挂单（T+1 收盘成交） ----
  const ledger = await G.readJSON('data/ledger.json');
  let tier = state.tier;
  let executed = null;
  let late = false;
  if (state.pending && state.pending.signalDate < today) {
    const p = state.pending;
    const prevTradingDays = cal.tradingDays.filter((d) => d > p.signalDate && d <= today);
    late = prevTradingDays.length > 1;
    executed = {
      seq: (ledger.entries.length || 0) + 1,
      date: today,
      signalDate: p.signalDate,
      side: p.tierTo > p.tierFrom ? 'BUY' : 'SELL',
      tierFrom: p.tierFrom,
      tierTo: p.tierTo,
      targetWeight: WEIGHTS[p.tierTo],
      price: close,
      etfPrice: etf && etf.d === today ? etf.c : null,
      late,
      recordedAt: beijingStamp(),
    };
    ledger.entries.push(executed);
    tier = p.tierTo;
  }

  // ---- 今日信号 → 明日挂单 ----
  const sig = signal(close, ma30);
  const want = nextTier(tier, sig);
  const pending = want !== tier
    ? { signalDate: today, tierFrom: tier, tierTo: want, side: want > tier ? 'BUY' : 'SELL' }
    : null;

  // ---- 10 项校验 ----
  const checks = runChecks(idx, removed, today, etf, tier, want, cal.tradingDays);

  // 10 账本自审：每笔记录的日期都要落在行情序列里、档位要逐笔连得上。
  //    这一项防的是"算得出结果但结果是错的"——比直接报错危险得多。
  const audit = auditLedger(rows, ledger.entries, state.launchDate);
  checks.push({
    id: 10, name: '账本自审：日期与档位链完整', ok: audit.length === 0,
    detail: audit.length ? audit.slice(0, 3).map((a) => a.msg).join('；') : `${ledger.entries.length} 笔全部自洽`,
    fatal: true,
  });

  const fatal = checks.filter((c) => !c.ok && c.fatal);
  if (fatal.length) {
    await bark(env, {
      title: '⚠️ 红利MA30 · 数据校验未通过',
      body: `${today} 有 ${fatal.length} 项校验失败，本次未写入：\n`
        + fatal.map((c) => `· ${c.name}：${c.detail}`).join('\n'),
      level: 'timeSensitive',
    });
    return { ok: false, today, reason: '校验失败', checks };
  }

  // ---- 重放资金（本金只在 Worker 密钥里，不落仓库） ----
  const principal = Number(env.PRINCIPAL || 0);
  let plan = null;
  if (principal > 0 && pending) {
    const st = replay(rows.filter((r) => r.d <= today), ledger.entries, principal, state.launchDate);
    plan = plannedOrder(st.V, st.cash, pending.tierTo);
    plan.shares = etf && etf.d === today ? shares(plan.amount, etf.c) : null;
  }

  // ---- 组装新 state ----
  const newState = {
    ...state,
    asof: today,
    lastRun: beijingStamp(),
    tier,
    pending,
    index: {
      code: 'H00922', close: +close.toFixed(2), ma30: +ma30.toFixed(2),
      ratio: +trig.ratio.toFixed(4),
      changePct: lastRow.pct,
      buyTrigger: +trig.buyAt.toFixed(2), sellTrigger: +trig.sellAt.toFixed(2),
      pctToBuy: +trig.pctToBuy.toFixed(2), pctToSell: +trig.pctToSell.toFixed(2),
    },
    bond: { code: 'H11001', close: bondByDate.get(today) ?? state.bond?.close ?? null },
    etf: {
      code: env.ETF_CODE || '515180',
      close: etf ? etf.c : null,
      asof: etf ? etf.d : null,
      stale: !(etf && etf.d === today),
    },
    checks: {
      passed: checks.filter((c) => c.ok).length,
      total: checks.length,
      failed: checks.filter((c) => !c.ok).map((c) => ({ id: c.id, name: c.name, detail: c.detail })),
      ranAt: beijingStamp(),
    },
    lastExecuted: executed ? { date: executed.date, side: executed.side, tierTo: executed.tierTo } : state.lastExecuted || null,
  };

  // ---- 提交 ----
  const files = [
    { path: 'data/state.json', content: JSON.stringify(newState, null, 2) },
    { path: 'data/series.json', content: JSON.stringify(series) },
    { path: `calendar/${year}.json`, content: JSON.stringify(cal) },
    {
      path: `audit/${today}.json`,
      content: JSON.stringify({
        today, ranAt: beijingStamp(), checks,
        cleaning: { rawCount: idxRes.rawCount, removed },
        rawTail: idx.slice(-5), etf, ma30: +ma30.toFixed(4), signal: sig,
        tierBefore: state.tier, tierAfter: tier, pending, executed, log,
      }, null, 2),
    },
  ];
  if (executed) files.push({ path: 'data/ledger.json', content: JSON.stringify(ledger, null, 2) });

  const msg = executed
    ? `${today} 成交 ${executed.side === 'BUY' ? '买入' : '卖出'} 第 ${executed.tierTo} 档`
    : pending ? `${today} 出信号 ${pending.side === 'BUY' ? '买入' : '卖出'} → 明日执行`
      : `${today} 无操作`;
  const sha = await G.commit(files, `chore(daily): ${msg}`);

  // ---- 推送 ----
  await pushDaily(env, { today, newState, pending, executed, plan, etf, checks, late });

  // HTTP 返回里刻意不带任何金额：cron-job.org 之类的调用方会把响应体存在
  // 自己服务器上。金额只走 Bark 推送到本人手机，不经过第三方。
  return {
    ok: true, today, commit: sha.slice(0, 7), tier, pending, executed, checks,
    planned: plan ? { side: plan.side, targetWeight: plan.targetWeight, hasShares: plan.shares != null } : null,
  };
}

async function pushDaily(env, { today, newState, pending, executed, plan, etf, checks, late }) {
  const i = newState.index;
  const chg = i.changePct != null ? `${i.changePct > 0 ? '+' : ''}${i.changePct}%` : '';
  const warn = checks.some((c) => !c.ok) ? `\n⚠️ ${checks.filter((c) => !c.ok).map((c) => c.name).join('、')}` : '';
  const doneLine = executed
    ? `\n已记账：${executed.date} ${executed.side === 'BUY' ? '买入' : '卖出'}，档位 ${executed.tierFrom}→${executed.tierTo}${executed.late ? '（迟到执行）' : ''}`
    : '';

  if (pending) {
    // 方向以公式实际算出来的为准，不按档位方向假设
    const isBuy = (plan && plan.side !== 'NONE' ? plan.side : pending.side) === 'BUY';
    const amt = plan ? `${money(plan.amount)} 元` : `目标仓位 ${WEIGHTS[pending.tierTo] * 100}%`;
    const sh = plan && plan.shares ? `　约 ${money(plan.shares)} 股` : '';
    const px = etf ? `\n${newState.etf.code} 收盘 ${etf.c}${newState.etf.stale ? '（非当日价，股数仅供参考）' : ''}` : '';
    await bark(env, {
      title: `${isBuy ? '🔴 买入' : '🟢 卖出'}　明日收盘执行`,
      body: `${isBuy ? '买入' : '卖出'} ${amt}${sh}\n档位 ${pending.tierFrom}/5 → ${pending.tierTo}/5`
        + `\n指数 ${i.close}（${chg}）　MA30 ${i.ma30}${px}${doneLine}${warn}`,
      level: 'timeSensitive',
      group: '红利MA30·操作',
    });
  } else {
    const dist = newState.tier < 4
      ? `距买入还需跌 ${Math.abs(i.pctToBuy).toFixed(2)}%（${i.buyTrigger}）` : '已满仓';
    const dist2 = newState.tier > 0
      ? `　距卖出还需涨 ${i.pctToSell.toFixed(2)}%（${i.sellTrigger}）` : '';
    await bark(env, {
      title: `红利MA30 · 无操作　${newState.tier}/5 档`,
      body: `指数 ${i.close}（${chg}）　MA30 ${i.ma30}\n${dist}${dist2}${doneLine}${warn}`,
      level: 'passive',
    });
  }
  if (late) {
    await bark(env, {
      title: '⚠️ 红利MA30 · 挂单迟到执行',
      body: '上一次的挂单晚于 T+1 才成交，可能是某个交易日漏跑。请核对账本。',
      level: 'timeSensitive',
    });
  }
}

/** 每月刷新交易日历：把未来 4 个月的官方日历并进仓库 */
async function refreshCalendar(env) {
  const G = gh(env);
  const today = beijingDate();
  const months = [];
  for (let k = 0; k < 5; k++) {
    const d = new Date(Date.parse(today + 'T00:00:00Z'));
    d.setUTCMonth(d.getUTCMonth() + k);
    months.push(d.toISOString().slice(0, 7));
  }
  const byYear = new Map();
  const missing = [];
  for (const m of months) {
    const map = await fetchCalendarMonth(m).catch(() => null);
    if (!map || !Object.keys(map).length) { missing.push(m); continue; }
    const y = m.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, new Set());
    for (const [d, v] of Object.entries(map)) if (v === 1) byYear.get(y).add(d);
  }
  const files = [];
  for (const [y, set] of byYear) {
    const old = await G.readJSON(`calendar/${y}.json`, { year: +y, tradingDays: [] });
    for (const d of old.tradingDays) set.add(d);
    const days = [...set].sort();
    files.push({
      path: `calendar/${y}.json`,
      content: JSON.stringify({
        year: +y, source: 'szse.cn', fetchedAt: new Date().toISOString(),
        tradingDayCount: days.length, tradingDays: days,
      }),
    });
  }
  if (files.length) await G.commit(files, `chore(calendar): 刷新至 ${months[months.length - 1]}`);

  // 快到年底还拿不到明年日历，提醒一次
  const mm = +today.slice(5, 7);
  const nextYear = String(+today.slice(0, 4) + 1);
  if (mm >= 12 && !byYear.has(nextYear)) {
    await bark(env, {
      title: '📅 红利MA30 · 明年日历尚未发布',
      body: `${nextYear} 年交易日历在深交所还查不到。通常国务院公布节假日安排后才有，请留意。`,
      level: 'active',
    });
  }
  return { ok: true, years: [...byYear.keys()], missing };
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const token = url.searchParams.get('token');
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o, null, 2), {
        status: s,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });

    try {
      if (path === '/health') {
        const G = gh(env);
        const st = await G.readJSON('data/state.json');
        return json({
          ok: true, now: beijingStamp(), stateAsof: st && st.asof,
          tier: st && st.tier, pending: st && st.pending,
          checks: st && st.checks,
        });
      }
      if (path === '/run') {
        if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) return json({ ok: false, error: 'token 不正确' }, 401);
        return json(await runDaily(env, { force: url.searchParams.get('force') === '1' }));
      }
      if (path === '/calendar/refresh') {
        if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) return json({ ok: false, error: 'token 不正确' }, 401);
        return json(await refreshCalendar(env));
      }
      return json({ ok: false, error: '未知路径', paths: ['/run', '/calendar/refresh', '/health'] }, 404);
    } catch (e) {
      await bark(env, {
        title: '❌ 红利MA30 · 运行异常',
        body: `${beijingStamp()}\n${String(e && e.message || e)}`,
        level: 'timeSensitive',
      });
      return json({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '') }, 500);
    }
  },
};
