/* 运动学使用右手系：XY 为水平面，Z 竖直向上；长度对外为 mm，角度为度。 */
export const GEOMETRY = Object.freeze({ mmPerUnit: 100, baseRadius: 8.5, platformRadius: 7.6,
  baseAnchorRadius: 7.229, platformAnchorRadius: 6.886, baseHeight: 0.8, homeHeight: 22.0,
  basePairHalfAngle: 7.95, platformPairHalfAngle: 8.35, platformOffset: 60,
  legMin: 1703.35, legMax: 2903.35, lensOffset: 0, focalLength: 21, lensRadius: 6.5, apertureArea: 1.327,
  target: Object.freeze([0, 0, 1.0]) });
export const PLATFORM_ANGLES = Object.freeze([51.65, 68.35, 171.65, 188.35, 291.65, 308.35]);
export const LEG_MAPPING = Object.freeze([5, 0, 1, 2, 3, 4]);
export const CHANNELS = Object.freeze([
  { key: 'x', name: 'X', unit: 'mm', max: 300 }, { key: 'y', name: 'Y', unit: 'mm', max: 300 },
  { key: 'z', name: 'Z 平台高', unit: 'mm', max: 500, origin: 2200 }, { key: 'roll', name: 'Roll', unit: '°', max: 15 },
  { key: 'pitch', name: 'Pitch', unit: '°', max: 15 }, { key: 'yaw', name: 'Yaw', unit: '°', max: 20 },
]);
export const ZERO_POSE = Object.freeze({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 });
const rad = Math.PI / 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
export function clampPose(pose) {
  return Object.fromEntries(CHANNELS.map(c => [c.key, clamp(Number(pose[c.key] ?? 0), -c.max, c.max)]));
}
const polar = (r, a, z) => [r * Math.cos(a * rad), r * Math.sin(a * rad), z];

/* 实机角度与连接映射：平台数组按底座缸号排序。 */
export const BASE_ANCHORS = Array.from({ length: 6 }, (_, i) =>
  polar(GEOMETRY.baseAnchorRadius, 120 * Math.floor(i / 2) + (i % 2 ? 7.95 : -7.95), GEOMETRY.baseHeight));
export const PLATFORM_ANCHORS = LEG_MAPPING.map(i => polar(GEOMETRY.platformAnchorRadius, PLATFORM_ANGLES[i], 0));

/* 理想几何焦点，与渲染共用；坐标单位为 100 mm。 */
export function opticalState(transform) {
  const r = transform.rotation, normal = [r[2], r[5], r[8]];
  const lens = transformPoint([0, 0, GEOMETRY.lensOffset], transform);
  const focus = lens.map((v, i) => v - GEOMETRY.focalLength * normal[i]);
  const errorMm = 100 * Math.hypot(...focus.map((v, i) => v - GEOMETRY.target[i]));
  return { normal, lens, focus, errorMm };
}

/* 显式展开 Rz(yaw)·Ry(pitch)·Rx(roll)，避免欧拉角顺序歧义。 */
export function poseTransform(pose = ZERO_POSE) {
  const cr = Math.cos(pose.roll * rad), sr = Math.sin(pose.roll * rad);
  const cp = Math.cos(pose.pitch * rad), sp = Math.sin(pose.pitch * rad);
  const cy = Math.cos(pose.yaw * rad), sy = Math.sin(pose.yaw * rad);
  return {
    rotation: [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
      sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr],
    translation: [pose.x / 100, pose.y / 100, GEOMETRY.homeHeight + pose.z / 100],
  };
}
export function transformPoint(point, transform) {
  const r = transform.rotation, t = transform.translation;
  return [0, 1, 2].map(i => t[i] + r[i * 3] * point[0] + r[i * 3 + 1] * point[1] + r[i * 3 + 2] * point[2]);
}
export function inverseKinematics(pose = ZERO_POSE) {
  const transform = poseTransform(pose);
  const upper = PLATFORM_ANCHORS.map(p => transformPoint(p, transform));
  const lengths = upper.map((q, i) => Math.hypot(...q.map((v, j) => v - BASE_ANCHORS[i][j])) * 100);
  return { ...transform, upper, lengths };
}

/* 带主元的消元，用于局部正解。正解存在多个装配分支，初值决定所收敛的分支。 */
function solveLinear(matrix, vector) {
  const a = matrix.map((r, i) => [...r, vector[i]]);
  for (let i = 0; i < 6; i++) {
    let pivot = i;
    for (let k = i + 1; k < 6; k++) if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k;
    if (Math.abs(a[pivot][i]) < 1e-12) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const d = a[i][i];
    for (let j = i; j <= 6; j++) a[i][j] /= d;
    for (let k = 0; k < 6; k++) {
      if (k === i) continue;
      const f = a[k][i];
      for (let j = i; j <= 6; j++) a[k][j] -= f * a[i][j];
    }
  }
  return a.map(r => r[6]);
}
export function forwardKinematics(lengths, initialPose = ZERO_POSE) {
  if (lengths.length !== 6 || lengths.some(v => !Number.isFinite(v) || v <= 0)) throw new RangeError('缸长必须是六个正数');
  let pose = { ...ZERO_POSE, ...initialPose }, iterations = 0;
  const residual = p => inverseKinematics(p).lengths.map((v, i) => lengths[i] - v);
  for (; iterations < 60; iterations++) {
    const error = residual(pose), norm = Math.hypot(...error);
    if (norm < 1e-6) break;
    const jacobian = Array.from({ length: 6 }, () => []);
    CHANNELS.forEach((c, j) => {
      const step = j < 3 ? 0.01 : 0.001;
      const a = inverseKinematics({ ...pose, [c.key]: pose[c.key] + step }).lengths;
      const b = inverseKinematics({ ...pose, [c.key]: pose[c.key] - step }).lengths;
      a.forEach((v, i) => { jacobian[i][j] = (v - b[i]) / (2 * step); });
    });
    const delta = solveLinear(jacobian, error);
    if (!delta) break;
    let accepted = false;
    for (let scale = 1; scale >= 1 / 128; scale /= 2) {
      const candidate = Object.fromEntries(CHANNELS.map((c, j) => [c.key, pose[c.key] + scale * delta[j]]));
      if (Math.hypot(...residual(candidate)) < norm) { pose = candidate; accepted = true; break; }
    }
    if (!accepted) break;
  }
  const errorMm = Math.max(...residual(pose).map(Math.abs));
  return { pose, iterations, errorMm, converged: errorMm < 0.01 };
}

/* 圆角方形以弧长匀速遍历，边界严格保持 ±250 mm。 */
function roundedSquare(phase) {
  const a = 250, r = 50, side = 2 * (a - r), arc = Math.PI * r / 2;
  let d = phase * 4 * (side + arc);
  const quadrant = Math.min(3, Math.floor(d / (side + arc)));
  d -= quadrant * (side + arc);
  let x, y;
  if (d < side) { x = -a + r + d; y = -a; }
  else { const angle = -Math.PI / 2 + (d - side) / r; x = a - r + r * Math.cos(angle); y = -a + r + r * Math.sin(angle); }
  for (let i = 0; i < quadrant; i++) [x, y] = [-y, x];
  return [x, y];
}
export function trajectoryPose(type, phase) {
  const u = clamp(phase, 0, 1), a = u * Math.PI * 2;
  if (type === 'square') { const [x, y] = roundedSquare(u === 1 ? 0 : u); return { ...ZERO_POSE, x, y }; }
  if (type === 'eight') return { x: 260 * Math.sin(a), y: 200 * Math.sin(2 * a), z: 40 * Math.sin(a), roll: 10 * Math.sin(a), pitch: 10 * Math.sin(2 * a), yaw: 12 * Math.sin(a) };
  if (type === 'helix') return { x: 220 * Math.cos(a * 2), y: 220 * Math.sin(a * 2), z: -300 + 600 * u, roll: 10 * Math.sin(a * 2), pitch: 10 * Math.cos(a * 2), yaw: 15 * Math.sin(a) };
  return { x: 250 * Math.cos(a), y: 250 * Math.sin(a), z: 15 * Math.sin(2 * a), roll: 10 * Math.sin(a), pitch: 10 * Math.cos(a), yaw: 10 * Math.sin(a) };
}
export function assertZeroLengths() {
  const { lengths } = inverseKinematics();
  const spread = Math.max(...lengths) - Math.min(...lengths);
  const expected = Math.hypot(2120, 100 * Math.sqrt(7.229 ** 2 + 6.886 ** 2 - 2 * 7.229 * 6.886 * Math.cos(43.7 * rad)));
  if (spread >= .01 || lengths.some(v => Math.abs(v - expected) >= .01 || v < GEOMETRY.legMin - .05 || v > GEOMETRY.legMax + .05)) throw new Error('零位几何自检失败');
  console.info(`零位等长自检通过：${lengths[0].toFixed(1)} mm（精确 ${lengths[0].toFixed(6)} mm）；最大差 ${spread.toFixed(8)} mm`);
  return { lengths, spread, expected };
}
