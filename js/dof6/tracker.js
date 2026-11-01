/* 太阳追踪：太阳方向 → 六轴姿态（聚光点固定、镜面垂直太阳光、35° 倾角限位）+ 离轴光斑。
   只依赖 ./kinematics.js，不改运动学；pose 的 x/y/z 单位 mm（z 相对 homeHeight×100 的偏移），
   所有 [x,y,z] 三元组为场景单位（1 = 100 mm），长度/偏移对外 mm。 */
import { GEOMETRY, inverseKinematics, poseTransform, clamp } from './kinematics.js';
const rad = Math.PI / 180, deg = 180 / Math.PI;

/* 实机安全盒 A/B ±35°、C ±20°；行程与杆长范围取自运动学常量。 */
export const TRACK_LIMITS = Object.freeze({
  maxTiltDeg: 35, maxYawDeg: 20,          // 实机安全盒 A/B ±35°、C ±20°
  legMin: GEOMETRY.legMin, legMax: GEOMETRY.legMax,
  heightMin: 1700, heightMax: 2700,       // 平台中心高 mm
});

/* 归一化方向；零向量回退天顶，保证下游不出现 NaN。 */
function unit(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
}

/* 镜心：C = P_target + f·n（透镜中心与平台中心重合）。 */
function lensCenterOf(n) {
  return GEOMETRY.target.map((t, i) => t + GEOMETRY.focalLength * n[i]);
}

/* 由镜面法线反解姿态：最小旋转 Rz(0)·Ry(pitch)·Rx(roll)，把 +Z 转到 n。 */
function poseOfNormal(n) {
  const center = lensCenterOf(n);
  return {
    x: center[0] * GEOMETRY.mmPerUnit, y: center[1] * GEOMETRY.mmPerUnit,
    z: center[2] * GEOMETRY.mmPerUnit - GEOMETRY.homeHeight * GEOMETRY.mmPerUnit,
    roll: Math.asin(clamp(-n[1], -1, 1)) * deg,
    pitch: Math.atan2(n[0], n[2]) * deg,
    yaw: 0,
  };
}

/* 方向 → 方位角（自北顺时针，度，0..360）。 */
function azimuthOf(n) {
  return ((Math.atan2(n[0], n[1]) * deg) % 360 + 360) % 360;
}

/* 太阳方向 → 实际姿态（限位投影到 35° 锥面）、期望姿态、缸长与包络状态。 */
export function trackingSolution(direction, limits = TRACK_LIMITS) {
  const sun = unit(direction);
  const tiltDeg = Math.acos(clamp(sun[2], -1, 1)) * deg;             // θ = acos(n_z)
  const azimuthDeg = azimuthOf(sun);
  const maxTilt = limits.maxTiltDeg;
  const limited = tiltDeg > maxTilt + 1e-12;
  const epsilonDeg = limited ? tiltDeg - maxTilt : 0;
  let effectiveDirection;
  if (limited) {
    /* 保持水平方位角，把倾角夹到 35° 锥面：n_eff = [sin35·cosφ, sin35·sinφ, cos35]。 */
    const horizontal = Math.hypot(sun[0], sun[1]);
    const cosPhi = horizontal > 1e-12 ? sun[0] / horizontal : 1;
    const sinPhi = horizontal > 1e-12 ? sun[1] / horizontal : 0;
    effectiveDirection = [Math.sin(maxTilt * rad) * cosPhi, Math.sin(maxTilt * rad) * sinPhi, Math.cos(maxTilt * rad)];
  } else effectiveDirection = [...sun];
  const pose = poseOfNormal(effectiveDirection);
  const desiredPose = poseOfNormal(sun);
  const lensCenter = lensCenterOf(effectiveDirection);
  const desiredLensCenter = lensCenterOf(sun);
  const legLengths = inverseKinematics(pose).lengths;
  const min = Math.min(...legLengths), max = Math.max(...legLengths);
  const legRange = { min, max, ok: legLengths.every(v => v >= limits.legMin - 1e-9 && v <= limits.legMax + 1e-9) };
  const heightMm = lensCenter[2] * GEOMETRY.mmPerUnit;
  const inEnvelope = legRange.ok && heightMm >= limits.heightMin && heightMm <= limits.heightMax;
  return {
    tiltDeg, azimuthDeg, limited, epsilonDeg, effectiveDirection, pose, desiredPose,
    lensCenter, desiredLensCenter, legLengths, legRange, inEnvelope, target: [...GEOMETRY.target],
  };
}

/* 实际姿态 + 太阳方向 → 镜面法线 / 镜心 / 镜面-太阳夹角 / 光斑（薄透镜离轴近似）。 */
export function trackingOptics(pose, sunDirection) {
  const transform = poseTransform(pose);
  const r = transform.rotation, t = transform.translation;
  const normal = [r[2], r[5], r[8]];                                  // rotation 第 3 列 = 镜面法线
  const lensCenter = t.map((v, i) => v + normal[i] * GEOMETRY.lensOffset);
  const sun = unit(sunDirection);
  const sunAngleDeg = Math.acos(clamp(normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2], -1, 1)) * deg;
  /* 薄透镜离轴成像：焦点沿光轴后移 f/cos ε；cos ε 下限 0.35 防数值爆炸，光斑偏移用同一截断角保持一致。 */
  const cosEps = clamp(Math.cos(sunAngleDeg * rad), 0.35, 1);
  const spot = lensCenter.map((v, i) => v - (GEOMETRY.focalLength / cosEps) * sun[i]);
  const spotOffsetMm = GEOMETRY.focalLength * GEOMETRY.mmPerUnit * Math.tan(Math.acos(cosEps));
  return { normal, lensCenter, sunAngleDeg, spot, spotOffsetMm, target: [...GEOMETRY.target] };
}

/* 全包络自检：高度角 55°–90°（0.5°）× 方位角 0–360°（5°），断言缸长/倾角/平台高全部在机构范围内。 */
export function assertTrackerEnvelope(limits = TRACK_LIMITS) {
  let min = Infinity, max = -Infinity, samples = 0;
  const check = (condition, message) => { if (!condition) throw new Error(`太阳追踪包络自检失败：${message}`); };
  for (let el = 55; el <= 90 + 1e-9; el += 0.5) {
    for (let az = 0; az <= 360 + 1e-9; az += 5) {
      const direction = [Math.cos(el * rad) * Math.sin(az * rad), Math.cos(el * rad) * Math.cos(az * rad), Math.sin(el * rad)];
      const solution = trackingSolution(direction, limits);
      samples += 1;
      solution.legLengths.forEach((leg, i) => {
        check(leg >= limits.legMin && leg <= limits.legMax, `el=${el}° az=${az}° 第 ${i + 1} 缸 ${leg.toFixed(1)} mm 越界`);
        min = Math.min(min, leg); max = Math.max(max, leg);
      });
      check(Math.abs(solution.pose.roll) <= limits.maxTiltDeg + 1e-6, `el=${el}° az=${az}° roll=${solution.pose.roll.toFixed(3)}° 超限`);
      check(Math.abs(solution.pose.pitch) <= limits.maxTiltDeg + 1e-6, `el=${el}° az=${az}° pitch=${solution.pose.pitch.toFixed(3)}° 超限`);
      check(Math.abs(solution.pose.yaw) <= limits.maxYawDeg + 1e-6, `el=${el}° az=${az}° yaw=${solution.pose.yaw.toFixed(3)}° 超限`);
      const heightMm = solution.lensCenter[2] * GEOMETRY.mmPerUnit;
      check(heightMm >= limits.heightMin && heightMm <= limits.heightMax, `el=${el}° az=${az}° 平台高 ${heightMm.toFixed(1)} mm 越界`);
    }
  }
  console.info(`太阳追踪包络自检通过：六缸 ${min.toFixed(1)}–${max.toFixed(1)} mm（倾角限位 ${limits.maxTiltDeg}°）`);
  return { min, max, samples };
}
