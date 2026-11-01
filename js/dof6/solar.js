/* 太阳位置解算（NOAA / SPA 简化式）：纯 ES 模块，无 three、无 DOM、无副作用，可在 node 直接 import。
   约定：角度对外为度；时间为「当地钟表分钟」（0 = 00:00，1440 = 次日 00:00）；
   运动学坐标 x = 东、y = 北、z = 天顶，direction 为指向太阳的单位向量。 */
const rad = Math.PI / 180, deg = 180 / Math.PI;
const sind = a => Math.sin(a * rad);
const cosd = a => Math.cos(a * rad);
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));

/* 默认场景：北京（116.4°E → UTC+8）、夏至当地 11:30。 */
export const SOLAR_DEFAULTS = Object.freeze({
  date: '2026-06-21', timeMinutes: 690, latitude: 39.9042, longitude: 116.4074,
});                                                     // timeMinutes = 11:30 当地时间

/* 经度 → 整数时区（15° 换 1 h），夹到 −12…14。 */
export function timezoneForLongitude(longitude) {
  return clampNum(Math.round((Number.isFinite(longitude) ? longitude : 0) / 15), -12, 14);
}

/* 当地钟表分钟 → 'HH:MM'（0..1440，四舍五入到分钟；1440 显示 '24:00'）。 */
export function formatClock(minutes) {
  const total = clampNum(Math.round(minutes), 0, 1440);
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* 'HH:MM' → 当地钟表分钟；格式非法返回 null。 */
export function parseClock(text) {
  if (typeof text !== 'string') return null;
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hh = Number(match[1]), mm = Number(match[2]);
  if (hh > 24 || mm > 59 || (hh === 24 && mm !== 0)) return null;
  return hh * 60 + mm;
}

/* 'YYYY-MM-DD' → 儒略日 0h UT（Gregorian）。日期非法直接抛 RangeError，避免静默算错。 */
function julianDay0(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!match) throw new RangeError(`日期必须是 YYYY-MM-DD：${date}`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`日期非法：${date}`);
  }
  const a = Math.floor((14 - month) / 12), y = year + 4800 - a, m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
    - Math.floor(y / 100) + Math.floor(y / 400) - 32045.5;
}

/* 太阳位置：日期/当地钟表时间/经纬度/时区 → 高度角、方位角、单位方向、赤纬、时角、均时差、真太阳时。 */
export function solarPosition(date, minutes, latitude, longitude, tzHours) {
  const lat = Number(latitude) || 0, lon = Number(longitude) || 0, tz = Number(tzHours) || 0;
  const clock = Number(minutes) || 0;
  /* UTC = 当地钟表时间 − tz·60；儒略日以当地日期 0h UT 为基准，直接叠加 UTC 分钟。 */
  const jd = julianDay0(date) + (clock - 60 * tz) / 1440;
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + T * (36000.76983 + T * 0.0003032);             // 几何平黄经
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);              // 平近点角
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);         // 轨道偏心率
  const C = sind(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + sind(2 * M) * (0.019993 - 0.000101 * T) + sind(3 * M) * 0.000289; // 中心差
  const lambda = L0 + C - 0.00569 - 0.00478 * sind(125.04 - 1934.136 * T); // 视黄经
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cosd(125.04 - 1934.136 * T);             // 视黄赤交角
  const declination = Math.asin(sind(eps) * sind(lambda)) * deg;        // 赤纬 δ
  const y = Math.tan((eps / 2) * rad) ** 2;
  /* 均时差（分钟）：方括号内为弧度，×4 得「分钟/度」再 ×(180/π) 换成分钟。 */
  const equationOfTime = 4 * deg * (y * sind(2 * L0) - 2 * e * sind(M)
    + 4 * e * y * sind(M) * cosd(2 * L0) - 0.5 * y * y * sind(4 * L0) - 1.25 * e * e * sind(2 * M));
  /* 时间偏移：经度时差 + 均时差；真太阳时 = 钟表时间 + 偏移。 */
  const offset = equationOfTime + 4 * lon - 60 * tz;
  const solarTime = clock + offset;
  const hourAngle = solarTime / 4 - 180;                                 // 时角 H，度
  const sinElev = sind(lat) * sind(declination) + cosd(lat) * cosd(declination) * cosd(hourAngle);
  const elevation = Math.asin(clampNum(sinElev, -1, 1)) * deg;
  let azimuth;
  if (Math.abs(cosd(elevation)) < 1e-9) azimuth = 0;                     // 天顶附近方位退化
  else {
    const cosAz = (sind(declination) - sind(lat) * sind(elevation)) / (cosd(lat) * cosd(elevation));
    azimuth = Math.acos(clampNum(cosAz, -1, 1)) * deg;
    if (hourAngle > 0) azimuth = 360 - azimuth;                          // 下午（H > 0）在西侧
  }
  const direction = [cosd(elevation) * sind(azimuth), cosd(elevation) * cosd(azimuth), sind(elevation)];
  return { elevation, azimuth, direction, declination, hourAngle, equationOfTime, solarTime };
}

/* 当日事件：正午时刻/最大高度角/日出日落/昼长。地平线取太阳中心 −0.833°（含大气折射）。 */
export function daytime(date, latitude, longitude, tzHours) {
  const HORIZON = -0.833;
  const elevAt = m => solarPosition(date, m, latitude, longitude, tzHours).elevation;
  /* 1 min 粗扫取最高点，再在 ±1 min 内三分搜索，精度远优于 0.25 min。 */
  let best = 0, bestElev = -Infinity;
  for (let m = 0; m <= 1440; m += 1) {
    const el = elevAt(m);
    if (el > bestElev) { bestElev = el; best = m; }
  }
  let lo = Math.max(0, best - 1), hi = Math.min(1440, best + 1);
  for (let i = 0; i < 60; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (elevAt(a) < elevAt(b)) lo = a; else hi = b;
  }
  const solarNoon = (lo + hi) / 2;
  const maxElevation = elevAt(solarNoon);
  /* 5 min 粗扫找地平线过零点，再二分到 0.01 min；无解（极昼/极夜）返回 null。 */
  const crossings = [];
  const bisect = (a, b) => {
    let fa = elevAt(a) - HORIZON;
    for (let i = 0; i < 40; i++) {
      const mid = (a + b) / 2, fm = elevAt(mid) - HORIZON;
      if (fm === 0) return mid;
      if ((fa < 0) !== (fm < 0)) { b = mid; } else { a = mid; fa = fm; }
    }
    return (a + b) / 2;
  };
  for (let m = 0; m < 1440; m += 5) {
    const f0 = elevAt(m) - HORIZON, f1 = elevAt(m + 5) - HORIZON;
    if ((f0 < 0) !== (f1 < 0)) crossings.push(bisect(m, m + 5));
  }
  const sunrise = crossings.length ? crossings[0] : null;
  const sunset = crossings.length ? crossings[crossings.length - 1] : null;
  const dayLength = sunrise !== null && sunset !== null ? sunset - sunrise : 0;
  return { solarNoon, sunrise, sunset, maxElevation, dayLength };
}

/* 全天采样：含 0 与 1440 端点；每项 { minutes, elevation, azimuth, direction }。 */
export function sunPath(date, latitude, longitude, tzHours, stepMinutes = 10) {
  const step = Number(stepMinutes);
  if (!Number.isFinite(step) || step <= 0) throw new RangeError(`采样步长必须为正数：${stepMinutes}`);
  const samples = [];
  for (let m = 0; m < 1440; m += step) {
    const p = solarPosition(date, m, latitude, longitude, tzHours);
    samples.push({ minutes: m, elevation: p.elevation, azimuth: p.azimuth, direction: p.direction });
  }
  const end = solarPosition(date, 1440, latitude, longitude, tzHours);
  samples.push({ minutes: 1440, elevation: end.elevation, azimuth: end.azimuth, direction: end.direction });
  return samples;
}
