/**
 * 风格总开关（纯只读提醒模块，零依赖，与趋势系统 Python 版算法完全一致）
 *
 * 规则：沪深300 ETF (510300) / 红利 ETF (510880) 前复权收盘价之比 RS 的 120 日均线 ±1% 滞回带
 *   - 防守(红利MA30) -> 进攻(极简双升级)：RS > MA120 * 1.01
 *   - 进攻(极简双升级) -> 防守(红利MA30)：RS < MA120 * 0.99
 *   - 落在 [MA120*0.99, MA120*1.01] 缓冲区内：维持原状态不变
 *
 * 设计原则：只做宏观风格提醒，绝不修改或干扰红利 MA30 策略的任何仓位、信号、账本与风控数据。
 */

export const STYLE_MA_WINDOW = 120;
export const STYLE_HYST_BAND = 0.01;
export const STYLE_RULE_TEXT = '510300/510880 前复权 MA120 ±1% 滞回带';

const roundN = (x, n) => +Number(x).toFixed(n);

/**
 * 纯函数计算风格总开关状态。
 * @param {Array<{d:string, c:number}>} rows300 510300 前复权日收盘价列表
 * @param {Array<{d:string, c:number}>} rowsHl  510880 前复权日收盘价列表
 * @param {object|null} prevStatus 上一日持久化的 styleswitch.json（可选）
 */
export function evaluateStyleSwitch(rows300, rowsHl, prevStatus = null) {
  const map300 = new Map();
  for (const r of rows300 || []) {
    if (r && r.d && Number.isFinite(r.c) && r.c > 0) map300.set(r.d, +r.c);
  }
  const mapHl = new Map();
  for (const r of rowsHl || []) {
    if (r && r.d && Number.isFinite(r.c) && r.c > 0) mapHl.set(r.d, +r.c);
  }

  const commonDates = [];
  for (const d of map300.keys()) {
    if (mapHl.has(d)) commonDates.push(d);
  }
  commonDates.sort();

  if (commonDates.length < STYLE_MA_WINDOW) {
    return {
      ok: false,
      rule: STYLE_RULE_TEXT,
      error: `有效对齐交易日不足 ${STYLE_MA_WINDOW} 天（仅 ${commonDates.length} 天）`,
      barkLine: '',
      switchAlert: '',
    };
  }

  const rsList = commonDates.map((d) => map300.get(d) / mapHl.get(d));
  const n = commonDates.length;

  let sum = 0;
  for (let i = 0; i < STYLE_MA_WINDOW; i++) sum += rsList[i];
  let maVal = sum / STYLE_MA_WINDOW;
  let curMode = rsList[STYLE_MA_WINDOW - 1] > maVal ? 'trend' : 'hongli';
  let lastSwitchDate = null;
  let prevDayMode = curMode;

  for (let i = STYLE_MA_WINDOW - 1; i < n; i++) {
    if (i > STYLE_MA_WINDOW - 1) {
      sum += rsList[i] - rsList[i - STYLE_MA_WINDOW];
      maVal = sum / STYLE_MA_WINDOW;
    }
    const rsI = rsList[i];
    prevDayMode = curMode;
    if (curMode === 'hongli' && rsI > maVal * (1 + STYLE_HYST_BAND)) {
      curMode = 'trend';
      lastSwitchDate = commonDates[i];
    } else if (curMode === 'trend' && rsI < maVal * (1 - STYLE_HYST_BAND)) {
      curMode = 'hongli';
      lastSwitchDate = commonDates[i];
    }
  }

  const asOfDate = commonDates[n - 1];
  const rsNow = rsList[n - 1];
  const maNow = maVal;
  const upper = maNow * (1 + STYLE_HYST_BAND);
  const lower = maNow * (1 - STYLE_HYST_BAND);
  const devPct = (rsNow / maNow - 1) * 100;

  const prevModeSaved = prevStatus && (prevStatus.mode === 'trend' || prevStatus.mode === 'hongli')
    ? prevStatus.mode
    : null;
  const effPrevMode = prevModeSaved || prevDayMode;
  const switchedToday = curMode !== effPrevMode;
  if (switchedToday) {
    lastSwitchDate = asOfDate;
  } else if (!lastSwitchDate && prevStatus && prevStatus.lastSwitchDate) {
    lastSwitchDate = prevStatus.lastSwitchDate;
  }

  const isTrend = curMode === 'trend';
  const modeLabel = isTrend ? '进攻·趋势(极简双升级)' : '防守·红利MA30';
  const toSwitchPct = isTrend ? (lower / rsNow - 1) * 100 : (upper / rsNow - 1) * 100;
  const signPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const distText = isTrend
    ? `距切防守下轨(${lower.toFixed(4)})还差 ${signPct(toSwitchPct)}`
    : `距切进攻上轨(${upper.toFixed(4)})还差 ${signPct(toSwitchPct)}`;

  let switchAlert = '';
  let barkLine = '';
  if (switchedToday) {
    const fromLbl = effPrevMode === 'trend' ? '进攻·趋势' : '防守·红利MA30';
    const toLbl = isTrend ? '进攻·趋势' : '防守·红利MA30';
    switchAlert = `🔄 风格总开关今日触发切换：${fromLbl} → ${toLbl}（300/红利 ${rsNow.toFixed(4)}，偏离MA120 ${signPct(devPct)}，仅提醒）`;
    barkLine = switchAlert;
  } else {
    barkLine = `🧭 风格总开关：${modeLabel}（300/红利 ${rsNow.toFixed(4)}，偏离MA120 ${signPct(devPct)}，${distText}，仅提醒）`;
  }

  return {
    ok: true,
    rule: STYLE_RULE_TEXT,
    asOfDate,
    mode: curMode,
    modeLabel,
    switchedToday,
    prevMode: effPrevMode,
    lastSwitchDate,
    close300: roundN(map300.get(asOfDate), 4),
    closeHl: roundN(mapHl.get(asOfDate), 4),
    rs: roundN(rsNow, 4),
    ma120: roundN(maNow, 4),
    upperBand: roundN(upper, 4),
    lowerBand: roundN(lower, 4),
    deviationPct: roundN(devPct, 2),
    toSwitchPct: roundN(toSwitchPct, 2),
    distText,
    barkLine,
    switchAlert,
  };
}

/**
 * 格式化 Bark 推送附带提醒行（返回空串表示不附加，确保无数据时零干扰）。
 */
export function styleSwitchBarkLine(sw) {
  if (!sw || !sw.ok) return '';
  if (sw.switchedToday && sw.switchAlert) return `\n${sw.switchAlert}`;
  if (sw.barkLine) return `\n${sw.barkLine}`;
  return '';
}
