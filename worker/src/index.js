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
  ma, signal, nextTier, replay, plannedOrder, shares, triggers, auditLedger, beijingDate, nextTradingDay, validateState,
  dayLabel, NO_EXEC_DATE, CLOSE_TIP, posPct,
  WEIGHTS, MA_LEN, BUY_TH, SELL_TH,
} from '../../shared/strategy.js';

// 线上跑的是哪一版代码。由 npm run stamp 按 worker/src/index.js + shared/strategy.js
// 的内容算出并写回这一行，/health 会把它原样返回。
// 有了它才能从外面确认「推上去的改动到底部署了没有」——
// 否则只能去翻 Cloudflare 的构建记录，而构建成功不等于你想要的那版真的在跑。
const BUILD = '22f0aec08f';

const CSI = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';
const SZSE = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';
const EM_RT = 'https://push2.eastmoney.com/api/qt/stock/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------- 基础工具

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

/**
 * ETF 最新收盘价，用于换算参考股数。
 *
 * 为什么要三个源：2026-09-10 首次真实运行时，东财 K 线接口返回 HTTP 520，
 * 股数提示直接失效。单一行情源不可靠，这里按顺序试，第一个成功的就用。
 * 三个源都给不出就返回 null —— 非致命，只是没有股数提示。
 *
 * 注意腾讯和新浪返回的是 GBK，中文会乱码，但分隔符和数字都是 ASCII，取值不受影响。
 */
const mktPrefix = (code) => (/^[56]/.test(code) ? 'sh' : 'sz');
const emPrefix = (code) => (/^[56]/.test(code) ? '1' : '0');

async function etfTencent(code) {
  const r = await fetch(`https://qt.gtimg.cn/q=${mktPrefix(code)}${code}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.text()).split('"')[1];
  if (!body) throw new Error('返回格式异常');
  const f = body.split('~');
  const c = Number(f[3]);
  const ts = String(f[30] || '');
  if (!(c > 0) || ts.length < 8) throw new Error('字段缺失');
  return { c, d: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` };
}
async function etfSina(code) {
  const r = await fetch(`https://hq.sinajs.cn/list=${mktPrefix(code)}${code}`,
    { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.text()).split('"')[1];
  if (!body) throw new Error('返回格式异常');
  const f = body.split(',');
  const c = Number(f[3]);
  const d = f[30];
  if (!(c > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new Error('字段缺失');
  return { c, d };
}
async function etfEastmoney(code) {
  const r = await fetch(`${EM_RT}?secid=${emPrefix(code)}.${code}&fields=f43,f59,f86`,
    { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const d0 = j && j.data;
  if (!d0 || !(d0.f43 > 0)) throw new Error('字段缺失');
  return {
    c: d0.f43 / Math.pow(10, d0.f59 ?? 2),
    d: new Date((d0.f86 + 8 * 3600) * 1000).toISOString().slice(0, 10),
  };
}
export async function fetchETF(code) {
  const sources = [['腾讯', etfTencent], ['新浪', etfSina], ['东财', etfEastmoney]];
  const tried = [];
  for (const [name, fn] of sources) {
    try {
      const q = await fn(code);
      return { ...q, source: name, tried };
    } catch (e) {
      tried.push(`${name}(${e.message})`);
    }
  }
  return { failed: true, tried };
}

// ---------------------------------------------------------------- 校验

/**
 * 校验 3–9。fatal 为 true 的失败会阻止写入。
 * 校验 1（交易日历）和 2（数据到位）在主流程里单独处理。
 */
export function runChecks(rows, removed, today, etf, tierFrom, tierTo, calendar, ledgerEntries) {
  const checks = [];
  const add = (id, name, ok, detail, fatal = true) =>
    checks.push({ id, name, ok, detail, fatal });

  // 1、2 在主流程里靠提前返回把关：走到这里就说明它们已经过了。
  // 之所以还要补记，是因为不记的话 state 里 total=8、页面却列 10 项，数字对不上。
  // 名字里不写「今天」：面板显示的是上一次运行的结果，隔夜再看「今天」就是假话。
  // 具体是哪一天由 detail 里的日期负责。
  add(1, '运行日在交易日历内', true, `${today} 在交易所日历里`);
  add(2, '中证运行日数据已到位', true, `最新数据日期 ${today}`);

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

  // 9 state 与账本一致：state.tier 必须等于账本最后一笔的目标档位。
  //   原先这里断言「一天最多动一档」，但那是 nextTier 的结构性质，穷举下永远成立 ——
  //   等于一条永远通过的假校验。改成校验持久化状态没有漂移，那才是真实风险
  //   （提交只写了一半、或有人手改了 state.json）。
  const lastEntry = ledgerEntries.length ? ledgerEntries[ledgerEntries.length - 1] : null;
  const expectTier = lastEntry ? lastEntry.tierTo : 0;
  const stateOk = tierFrom === expectTier && Math.abs(tierTo - tierFrom) <= 1 && tierTo >= 0 && tierTo <= 4;
  add(9, 'state 档位与账本一致', stateOk,
    stateOk ? `${tierFrom} → ${tierTo}，与账本最后一笔（${lastEntry ? lastEntry.date + ' → ' + lastEntry.tierTo + '档' : '无记录，应为 0 档'}）吻合`
      : `state 记为 ${tierFrom} 档，但账本最后一笔指向 ${expectTier} 档 —— 两者已脱节`);

  return checks;
}

// ---------------------------------------------------------------- Bark

/**
 * 最近一次推送的结果。推送是这套系统唯一的输出通道，
 * 它失败等于系统失效 —— 但失败时又没法用 Bark 告诉你，
 * 所以把结果记进 state.json，面板上能看见，HTTP 返回里也带上。
 */
let lastPush = null;

async function bark(env, { title, body, level = 'active', group = '红利MA30' }) {
  if (!env.BARK_KEY) {
    lastPush = { ok: false, at: beijingStamp(), reason: '未配置 BARK_KEY' };
    return lastPush;
  }
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
    const j = await r.json();
    // Bark 即使 HTTP 200 也可能在 body 里报错，两层都要看
    const ok = j && (j.code === 200 || j.code === undefined);
    lastPush = { ok, at: beijingStamp(), title, reason: ok ? null : JSON.stringify(j).slice(0, 200) };
    return lastPush;
  } catch (e) {
    lastPush = { ok: false, at: beijingStamp(), title, reason: String(e && e.message || e).slice(0, 200) };
    return lastPush;
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
  // 读到损坏的状态就停手：基于它算出来的信号和账本都会是错的
  const stBad = validateState(state);
  if (stBad.length) {
    await bark(env, {
      title: '⚠️ 红利MA30 · 状态文件异常',
      body: `${today} 读到的 state.json 不合法，本次未运行：\n` + stBad.slice(0, 4).join('\n'),
      level: 'timeSensitive',
    });
    return { ok: false, today, reason: 'state.json 不合法', problems: stBad };
  }
  if (state.asof === today && !force) {
    return { ok: true, today, skipped: `${today} 已运行过（加 &force=1 可强制重跑）` };
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
      title: `⚠️ 红利MA30 · ${dayLabel(today, today).md}数据未到`,
      body: `交易日历显示 ${today} 开市，但中证接口最新数据只到 ${lastRow ? lastRow.d : '无'}。`
        + `本次未写入。若此刻尚未到 17:00，属正常；若已过 18:00 仍如此，请检查数据源。`,
      level: 'timeSensitive',
    });
    // 带上时点：一眼能分清是「收盘前跑早了」还是「数据源真的坏了」
    const hh = +beijingStamp().slice(11, 13);
    const why = hh < 17 ? '当前还未到中证发布时间（一般 17:00–18:00），属正常' : '已过通常发布时间，请留意数据源';
    return { ok: false, today, now: beijingStamp(), latest: lastRow ? lastRow.d : null,
      reason: `数据未到位，最新 ${lastRow ? lastRow.d : '无'}`, hint: why };
  }

  // ---- ETF 报价 ----
  let etf = null;
  const etfRes = await fetchETF(env.ETF_CODE || '515180');
  if (etfRes.failed) {
    log.push(`ETF 报价三个源都取不到：${etfRes.tried.join('、')}`);
  } else {
    etf = etfRes;
    if (etfRes.tried.length) log.push(`ETF 报价降级到${etfRes.source}：${etfRes.tried.join('、')}`);
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

  // ---- 执行昨日挂单（T+1 收盘前成交） ----
  const ledger = await G.readJSON('data/ledger.json');
  let tier = state.tier;
  let executed = null;
  let late = false;
  if (state.pending && state.pending.signalDate < today) {
    const p = state.pending;
    // 信号日可能落在上一年（12 月出信号、1 月才执行），只查当年日历会漏算天数
    let calDays = cal.tradingDays;
    if (p.signalDate.slice(0, 4) !== year) {
      const prevCal = await G.readJSON(`calendar/${p.signalDate.slice(0, 4)}.json`);
      if (prevCal) calDays = prevCal.tradingDays.concat(calDays).sort();
    }
    const prevTradingDays = calDays.filter((d) => d > p.signalDate && d <= today);
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

  // 挂单到底哪天执行 —— 周五出的信号要到下周一，节前能差十天。
  // 推送里绝不能笼统写"明日"，那是会让人在休市日空等的错话。
  // 无挂单时也要算：那条推送要说清「哪一天不用操作」，而不是笼统的「明日」。
  let execDay = nextTradingDay(cal.tradingDays, today);
  if (!execDay) {   // 12 月底的信号会落到次年，当年日历里已经没有下一天了
    const nextCal = await G.readJSON(`calendar/${+year + 1}.json`);
    if (nextCal) execDay = nextTradingDay(nextCal.tradingDays, today);
  }

  // ---- 10 项校验 ----
  const checks = runChecks(idx, removed, today, etf, tier, want, cal.tradingDays, ledger.entries);

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
    push: null,   // 提交后由下面回填
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
    ? `${today} 成交 ${executed.side === 'BUY' ? '买入' : '卖出'} 至 ${posPct(executed.tierTo)}`
    : pending ? `${today} 出信号 ${pending.side === 'BUY' ? '买入' : '卖出'} → ${execDay || '下一交易日'} 执行`
      : `${today} 无操作`;
  const sha = await G.commit(files, `chore(daily): ${msg}`);

  // ---- 推送 ----
  await pushDaily(env, { today, newState, pending, execDay, executed, plan, etf, checks, late });

  // 推送结果补记一次：失败时面板上要看得见，否则你不会知道自己漏收了通知。
  // 这次补记失败也不影响主流程 —— 账本已经提交好了。
  if (lastPush && !lastPush.ok) {
    newState.push = lastPush;
    await G.commit(
      [{ path: 'data/state.json', content: JSON.stringify(newState, null, 2) }],
      `chore(daily): ${today} 推送失败，记录状态`
    ).catch(() => {});
  } else if (lastPush) {
    newState.push = { ok: true, at: lastPush.at };
    await G.commit(
      [{ path: 'data/state.json', content: JSON.stringify(newState, null, 2) }],
      `chore(daily): ${today} 推送已送达`
    ).catch(() => {});
  }

  // HTTP 返回里刻意不带任何金额：cron-job.org 之类的调用方会把响应体存在
  // 自己服务器上。金额只走 Bark 推送到本人手机，不经过第三方。
  return {
    ok: true, today, commit: sha.slice(0, 7), tier, pending, executed, checks,
    push: lastPush ? { ok: lastPush.ok, reason: lastPush.reason } : null,
    planned: plan ? { side: plan.side, targetWeight: plan.targetWeight, hasShares: plan.shares != null } : null,
  };
}

/**
 * 挂单执行日的措辞。**一律先说日期**，「明天」只作括注。
 *
 * 早先这里写死「明日收盘前执行」：周五出的信号执行日是下周一，
 * 长假前能差十天，2026 年 241 个信号日里有 50 个不是第二天。
 * 现在日期永远在，把括号删掉句子也依然正确。
 */
export function execWording(today, execDay) {
  if (!execDay) {
    return {
      short: `${NO_EXEC_DATE}收盘前执行`,
      long: '交易日历暂时取不到，给不出执行日期。请到面板核对后再下单。',
    };
  }
  const L = dayLabel(execDay, today);
  return {
    short: `${L.label}收盘前执行`,
    long: `执行日 ${execDay}（${L.wd}）收盘前完成`
      + (L.diff > 1 ? `　·　距出信号 ${L.diff} 天，中间的休市日不用操作` : ''),
  };
}

export async function pushDaily(env, { today, newState, pending, execDay, executed, plan, etf, checks, late }) {
  const i = newState.index;
  const chg = i.changePct != null ? `${i.changePct > 0 ? '+' : ''}${i.changePct}%` : '';
  const warn = checks.some((c) => !c.ok) ? `\n⚠️ ${checks.filter((c) => !c.ok).map((c) => c.name).join('、')}` : '';
  const doneLine = executed
    ? `\n已记账：${executed.date}（${dayLabel(executed.date, today).wd}）`
      + `${executed.side === 'BUY' ? '买入' : '卖出'}，仓位 ${posPct(executed.tierFrom)}→${posPct(executed.tierTo)}`
      + `${executed.late ? '（迟到执行）' : ''}`
    : '';

  if (pending) {
    // 方向以公式实际算出来的为准，不按档位方向假设
    const isBuy = (plan && plan.side !== 'NONE' ? plan.side : pending.side) === 'BUY';
    const share = isBuy ? pending.tierTo : pending.tierFrom;   // 买入第几份 / 卖出第几份
    // 金额是按本金重放出来的估算：实盘和理论账本一旦有偏差它就不准，
    // 所以只当量级参考放在副行，真正下单以面板计算器为准。
    const est = plan
      ? `\n估算约 ${money(plan.amount)} 元${plan.shares ? `（约 ${money(plan.shares)} 股）` : ''}，按本金推算，下单以面板为准`
      : '';
    const w = execWording(today, execDay);
    await bark(env, {
      title: `${isBuy ? '🔴 买入' : '🟢 卖出'}第 ${share} 份　${w.short}`,
      body: `仓位 ${posPct(pending.tierFrom)} → ${posPct(pending.tierTo)}${est}`
        + `\n${w.long}`
        + `\n${CLOSE_TIP}`
        + `\n指数 ${i.close}（${chg}）　MA30 ${i.ma30}${doneLine}${warn}`,
      level: 'timeSensitive',
      group: '红利MA30·操作',
    });
  } else {
    // 已经破线却没出挂单，只可能是满仓/空仓挡住了，这时要直说已经破线。
    //
    // 注意 pctToBuy 和 pctToSell 的符号约定是**相反**的（见 triggers）：
    //   pctToBuy  = (买入线 / 收盘 − 1)　→ 正数 = 收盘已在买入线之下
    //   pctToSell = (卖出线 / 收盘 − 1)　→ 正数 = 还需再涨这么多
    // 照着卖出侧的写法套到买入侧，判断就整个反过来 ——
    // 每天最常见的「无操作」推送会在没破线时说「已跌破买入线」。
    const dist = newState.tier >= 4
      ? '已满仓，不再加仓'
      : i.pctToBuy >= 0
        ? `已跌破买入线（${i.buyTrigger}）`
        : `距买入还需跌 ${Math.abs(i.pctToBuy).toFixed(2)}%（${i.buyTrigger}）`;
    const dist2 = newState.tier <= 0
      ? '　当前空仓，没有可卖的份额'
      : i.pctToSell <= 0
        ? `　已涨破卖出线（${i.sellTrigger}）`
        : `　距卖出还需涨 ${i.pctToSell.toFixed(2)}%（${i.sellTrigger}）`;
    // 刚成交过就不能叫「无操作」—— 那会让人以为白跑一趟。
    // 「无操作」说的是下一个交易日不用动，而那一天是哪天必须写出来：
    // 周五发出的「明日无需操作」，字面上指的是周六。
    const td = dayLabel(today, today);
    const nd = execDay ? dayLabel(execDay, today) : null;
    const title = executed
      ? `✅ ${td.md}已成交　仓位 ${posPct(newState.tier)}`
      : `红利MA30 · ${td.md}无操作　仓位 ${posPct(newState.tier)}`;
    const nextLine = nd
      ? `\n${nd.label}无需操作`
      : `\n${NO_EXEC_DATE}无需操作`;
    await bark(env, {
      title,
      body: `指数 ${i.close}（${chg}）　MA30 ${i.ma30}\n${dist}${dist2}${nextLine}${doneLine}${warn}`,
      level: 'passive',
    });
  }
  if (late && executed) {
    await bark(env, {
      title: '⚠️ 红利MA30 · 挂单迟到执行',
      body: `信号出在 ${executed.signalDate}，本该在它的下一个交易日收盘前成交，`
        + `实际拖到 ${executed.date}（${dayLabel(executed.date, today).wd}）才记上。`
        + '\n中间可能有交易日漏跑，请核对账本。',
      level: 'timeSensitive',
    });
  }
}

/**
 * T+1 盘中提醒（默认 14:30，收盘前半小时）。
 *
 * 只读不写：不碰账本、不改 state、不做任何校验写入。
 * 只有「今天正是某笔挂单的执行日」时才推送，其余情况一律静默，避免变成骚扰。
 */
async function remind(env) {
  const today = beijingDate();
  const G = gh(env);

  const cal = await G.readJSON(`calendar/${today.slice(0, 4)}.json`);
  if (!cal || !cal.tradingDays.includes(today)) {
    return { ok: true, today, skipped: '非交易日，静默' };
  }

  const state = await G.readJSON('data/state.json');
  if (!state || !state.pending) {
    return { ok: true, today, skipped: '没有待执行的挂单，静默' };
  }

  // 挂单该在哪天执行 —— 周五出的信号要到下周一，不能简单加一天
  let days = [...cal.tradingDays];
  const nextCal = await G.readJSON(`calendar/${+today.slice(0, 4) + 1}.json`);
  if (nextCal) days = days.concat(nextCal.tradingDays).sort();
  const execDay = nextTradingDay(days, state.pending.signalDate);
  if (execDay !== today) {
    return { ok: true, today, skipped: `执行日是 ${execDay}，不是 ${today}，静默` };
  }

  // 金额按本金和账本重放得出，和晚上那条推送同源
  const p = state.pending;
  let est = '';
  let side = p.side;
  const principal = Number(env.PRINCIPAL || 0);
  if (principal > 0) {
    const series = await G.readJSON('data/series.json');
    const ledger = await G.readJSON('data/ledger.json');
    const rows = series.rows.filter((r) => r.d <= state.asof);
    const st = replay(rows, ledger.entries, principal, state.launchDate);
    const o = plannedOrder(st.V, st.cash, p.tierTo);
    if (o.side !== 'NONE') {
      side = o.side;
      const sh = state.etf && state.etf.close ? shares(o.amount, state.etf.close) : null;
      est = `\n估算约 ${money(o.amount)} 元${sh ? `（约 ${money(sh)} 股）` : ''}，按本金推算，下单以面板为准`;
    }
  }
  const isBuy = side === 'BUY';
  const share = isBuy ? p.tierTo : p.tierFrom;
  const L = dayLabel(today, today);
  await bark(env, {
    title: `⏰ ${L.md}收盘前${isBuy ? '买入' : '卖出'}第 ${share} 份`,
    body: `仓位 ${posPct(p.tierFrom)} → ${posPct(p.tierTo)}${est}`
      + `\n信号出在 ${p.signalDate}，执行日就是 ${today}（${L.wd}）。`
      + `\n${CLOSE_TIP}`,
    level: 'timeSensitive',
    group: '红利MA30·操作',
  });
  return { ok: true, today, reminded: true, side, tierTo: p.tierTo };
}

/** 每月刷新交易日历：把未来 4 个月的官方日历并进仓库 */
async function refreshCalendar(env) {
  const G = gh(env);
  const today = beijingDate();
  // 用年月整数推算，不能用 Date.setUTCMonth：
  // 在 31 号调用时它会溢出到下下个月（1-31 加一个月得到 3-03），把二月整个跳过。
  const months = [];
  let curY = +today.slice(0, 4), curM = +today.slice(5, 7);
  for (let k = 0; k < 5; k++) {
    months.push(`${curY}-${String(curM).padStart(2, '0')}`);
    curM += 1;
    if (curM > 12) { curM = 1; curY += 1; }
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
      title: `📅 红利MA30 · ${nextYear} 年日历尚未发布`,
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
      // /health 不鉴权，所以它的异常不发 Bark ——
      // 否则任何知道地址的人都能靠反复请求把你的手机刷屏。
      if (path === '/health') {
        try {
          const G = gh(env);
          const st = await G.readJSON('data/state.json');
          return json({
            ok: true, build: BUILD, now: beijingStamp(), stateAsof: st && st.asof,
            tier: st && st.tier, pending: st && st.pending,
            checks: st && st.checks, push: st && st.push,
          });
        } catch (e) {
          return json({ ok: false, error: String(e && e.message || e) }, 503);
        }
      }
      if (path === '/run') {
        if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) return json({ ok: false, error: 'token 不正确' }, 401);
        return json(await runDaily(env, { force: url.searchParams.get('force') === '1' }));
      }
      if (path === '/remind') {
        if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) return json({ ok: false, error: 'token 不正确' }, 401);
        return json(await remind(env));
      }
      if (path === '/calendar/refresh') {
        if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) return json({ ok: false, error: 'token 不正确' }, 401);
        return json(await refreshCalendar(env));
      }
      return json({ ok: false, error: '未知路径', paths: ['/run', '/remind', '/calendar/refresh', '/health'] }, 404);
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
