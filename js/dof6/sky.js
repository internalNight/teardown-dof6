/* 太阳追踪模式的天空层：天球 / 太阳 / 当日轨迹 / 35° 限位锥 / 期望与实际法线 /
 * 镜面圆周到光斑的斜光束 / 实际光斑与偏移 / 平行入射光线。
 *
 * 坐标约定（与 brief §5 一致）：
 *   - 对外接口里的方向、目标、镜心、光斑都是运动学坐标（x=东、y=北、z=天顶）；
 *   - 渲染用 model.js 的 toScene 变换到场景坐标（Y 向上）：(x, y, z) -> (x, z, -y)；
 *   - 天空元素固定在世界坐标，不跟随相机。
 *
 * 性能约定：所有几何 / 材质在 buildSky() 内一次性创建；update() 只修改 position、
 * quaternion 与已有 BufferAttribute，不产生新的几何或材质。setDay() 也只改写预分配的
 * 顶点缓冲与 CSS2D 标签文本。
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { toScene } from './model.js';
import { GEOMETRY } from './kinematics.js';

/* 天球半径（场景单位，1 = 100 mm）。 */
export const R_SKY = 36;
export const SKY_COLORS = Object.freeze({
  cyan: 0x5fe3ff, amber: 0xffb05c, sun: 0xffe6b8, ray: 0xffd7a0, label: '#8fa3bd',
});

const DEG = Math.PI / 180;
const FOCAL = GEOMETRY.focalLength;            // 名义焦距 f = 21 单位
const MAX_PATH = 4096;                          // 当日轨迹预分配顶点数
const CONE_SEG = 72;                            // 限位锥圆周分段
const BEAM_SEG = 64;                            // 实时光束圆周分段
const MIRROR_RADIUS = 6.15;                     // 镜面圆周半径（与 model.js 光锥一致）
const RAY_COUNT = 6;                            // 平行入射光线数量

const ADD = THREE.AdditiveBlending;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Y_AXIS = V(0, 1, 0);
const Z_AXIS = V(0, 0, 1);

/* 运动学三元组 -> 场景向量（不分配新对象）。 */
function toSceneV(p, out) { return out.set(p[0], p[2], -p[1]); }
function isVec(p) { return Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite); }
function normalizeArray(p) { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; }
function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }
function clockText(minutes) {
  const m = Math.round(minutes);
  return pad2((((m % 1440) + 1440) % 1440) / 60) + ':' + pad2((((m % 60) + 60) % 60));
}
const radToDeg = r => r / DEG;

/* 标签全部内联样式，不依赖 css/dof6.css。 */
function makeLabel(text, { size = 10, color = SKY_COLORS.label, weight = 500, chip = false } = {}) {
  const el = document.createElement('div');
  el.textContent = text;
  const base = `font:${weight} ${size}px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;`
    + `color:${color};letter-spacing:.08em;white-space:nowrap;pointer-events:none;user-select:none;`
    + `text-shadow:0 0 6px rgba(2,6,12,.95);`;
  el.style.cssText = chip
    ? `${base}padding:2px 6px;border-left:1px solid ${color};background:rgba(6,12,20,.66);border-radius:2px;`
    : base;
  const object = new CSS2DObject(el);     // CSS2DObject 自带 position:absolute
  return { object, el, setText(value) { if (el.textContent !== value) el.textContent = value; } };
}

/* 面向相机的公告板：只改 quaternion，不新建对象。 */
function billboard(object) {
  object.onBeforeRender = (renderer, scene, camera) => { object.quaternion.copy(camera.quaternion); };
}

export function buildSky() {
  const group = new THREE.Group();
  group.name = 'sky';

  const C = SKY_COLORS;
  const _targetScene = V(), _sunScene = V(), _lensScene = V(), _desiredScene = V();
  const _normalScene = V(), _spotScene = V(), _u = V(), _v = V();
  const _tmpA = V(), _tmpB = V(), _dirScene = V();

  /* 加法混合的细线材质：暗场里只留一道发光边。 */
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, toneMapped: false, blending: ADD,
  });
  const basicMat = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, toneMapped: false, blending: ADD,
  });

  /* ---------------- 1. 天球：地平环 + 高度环 + 方位刻度 + 方位标签 ---------------- */
  const horizonPoints = [];
  for (let i = 0; i < 180; i++) {
    const a = i / 180 * Math.PI * 2;
    horizonPoints.push(V(Math.cos(a) * R_SKY, 0, Math.sin(a) * R_SKY));
  }
  group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(horizonPoints), lineMat(C.cyan, .22)));

  /* 30° / 60° 高度环，帮助读出太阳高度角。 */
  [30, 60].forEach(elevation => {
    const r = R_SKY * Math.cos(elevation * DEG), y = R_SKY * Math.sin(elevation * DEG), pts = [];
    for (let i = 0; i < 144; i++) {
      const a = i / 144 * Math.PI * 2;
      pts.push(V(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat(C.cyan, .09)));
  });

  /* 15° 一个方位刻度，正方向刻度加长（场景 -Z 为北）。 */
  const tickPositions = new Float32Array(24 * 6);
  for (let i = 0; i < 24; i++) {
    const az = i * 15, a = az * DEG, cardinal = az % 90 === 0;
    const inner = R_SKY - (cardinal ? 1.5 : .7), outer = R_SKY;
    // 运动学 (R sin az, R cos az, 0) -> 场景 (R sin az, 0, -R cos az)
    const sx = Math.sin(a), sz = -Math.cos(a);
    tickPositions.set([sx * inner, 0, sz * inner, sx * outer, 0, sz * outer], i * 6);
  }
  const ticks = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tickPositions, 3)),
    lineMat(C.cyan, .28),
  );
  group.add(ticks);

  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([text, az]) => {
    const label = makeLabel(text, { size: 11, color: '#c8e6f5', weight: 600 });
    const a = az * DEG;
    label.object.position.set(Math.sin(a) * R_SKY * .985, .9, -Math.cos(a) * R_SKY * .985);
    group.add(label.object);
  });

  /* ---------------- 2. 太阳：日面 + 加法辉光 + 细环；handle 为不可见拾取球 ---------------- */
  const sunGroup = new THREE.Group();
  sunGroup.name = 'sun';
  group.add(sunGroup);

  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(1.55, 56), new THREE.MeshBasicMaterial({
    color: C.sun, transparent: true, opacity: .96, depthWrite: false, toneMapped: false,
  }));
  billboard(sunDisc);
  sunGroup.add(sunDisc);

  const sunGlowMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: ADD, toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(0xffc98a) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying vec2 vUv; void main(){ float r = length(vUv * 2.0 - 1.0); float a = pow(max(0.0, 1.0 - r), 2.4) * 0.55; gl_FragColor = vec4(uColor, a); }',
  });
  const sunGlow = new THREE.Mesh(new THREE.CircleGeometry(4.6, 48), sunGlowMat);
  billboard(sunGlow);
  sunGroup.add(sunGlow);

  const sunRingMat = basicMat(C.sun, .35);
  const sunRing = new THREE.Mesh(new THREE.TorusGeometry(2.0, .012, 6, 64), sunRingMat);
  billboard(sunRing);
  sunGroup.add(sunRing);

  /* 半径 3 的拾取球：colorWrite:false 保证不可见，但不影响 raycaster。 */
  const handle = new THREE.Mesh(
    new THREE.SphereGeometry(3, 16, 12),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
  );
  handle.name = 'sun-handle';
  handle.userData.kind = 'sun';
  sunGroup.add(handle);

  /* ---------------- 3. 当日太阳轨迹：折线 + 整点刻度 + 时间标签 + 日出/日落标记 ---------------- */
  const pathGeo = new THREE.BufferGeometry();
  const pathPositions = new Float32Array(MAX_PATH * 3);
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3));
  pathGeo.setDrawRange(0, 0);
  const pathLine = new THREE.Line(pathGeo, lineMat(C.cyan, .48));
  pathLine.frustumCulled = false;
  group.add(pathLine);

  const tickMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(.18, 10, 8),
    basicMat(0x9fe8ff, .9),
    24,
  );
  tickMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tickMesh.frustumCulled = false;
  group.add(tickMesh);

  const hourLabels = Array.from({ length: 12 }, () => {
    const label = makeLabel('00:00', { size: 9, color: C.label });
    label.object.visible = false;
    group.add(label.object);
    return label;
  });

  const markerMat = basicMat(C.ray, .85);
  const riseMarker = new THREE.Mesh(new THREE.TorusGeometry(.5, .03, 6, 48), markerMat);
  const setMarker = new THREE.Mesh(new THREE.TorusGeometry(.5, .03, 6, 48), markerMat);
  billboard(riseMarker); billboard(setMarker);
  group.add(riseMarker, setMarker);
  const riseLabel = makeLabel('日出', { size: 9, color: C.label });
  const setLabel = makeLabel('日落', { size: 9, color: C.label });
  riseLabel.object.visible = setLabel.object.visible = false;
  group.add(riseLabel.object, setLabel.object);

  /* ---------------- 4. 限位锥：锥顶 target，半角 maxTiltDeg，母线长 f = 21 ---------------- */
  const limitGroup = new THREE.Group();
  limitGroup.name = 'limit-cone';
  group.add(limitGroup);

  const coneGeo = new THREE.BufferGeometry();
  const conePositions = new Float32Array((CONE_SEG + 1) * 3);
  coneGeo.setAttribute('position', new THREE.BufferAttribute(conePositions, 3));
  /* aFade：0 = 锥顶，1 = 边缘环；片元按此径向淡出，避免锥面变成实心色块。 */
  const coneFade = new Float32Array(CONE_SEG + 1);
  coneFade[0] = .06;
  coneFade.fill(1, 1);
  coneGeo.setAttribute('aFade', new THREE.BufferAttribute(coneFade, 1));
  const coneIndex = new Uint16Array(CONE_SEG * 3);
  for (let i = 0; i < CONE_SEG; i++) {
    coneIndex.set([0, 1 + i, 1 + (i + 1) % CONE_SEG], i * 3);
  }
  coneGeo.setIndex(new THREE.BufferAttribute(coneIndex, 1));
  const coneMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false, blending: ADD, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(C.cyan) }, uOpacity: { value: .012 } },
    vertexShader: 'attribute float aFade; varying float vFade; void main(){ vFade = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; varying float vFade; void main(){ gl_FragColor = vec4(uColor, uOpacity * (0.04 + 0.96 * pow(vFade, 1.6))); }',
  });
  const limitCone = new THREE.Mesh(coneGeo, coneMat);
  limitCone.frustumCulled = false;
  limitGroup.add(limitCone);

  /* 边缘环：单位半径 torus，按 21·sin(half) 等比缩放；正常态很淡，限位时变琥珀并加亮。 */
  const edgeRingMat = basicMat(C.cyan, .32);
  const edgeRing = new THREE.Mesh(new THREE.TorusGeometry(1, .0025, 6, 96), edgeRingMat);
  edgeRing.rotation.x = Math.PI / 2;
  edgeRing.frustumCulled = false;
  limitGroup.add(edgeRing);

  const generatrixGeo = new THREE.BufferGeometry();
  generatrixGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 2 * 3), 3));
  const generatrix = new THREE.LineSegments(generatrixGeo, lineMat(C.cyan, .14));
  generatrix.frustumCulled = false;
  limitGroup.add(generatrix);

  /* ---------------- 5. 期望 / 实际法线 ---------------- */
  const makeLineGeo = () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    geo.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(2), 1));
    return geo;
  };
  const desiredLineMat = new THREE.LineDashedMaterial({
    color: C.cyan, dashSize: .55, gapSize: .4, transparent: true, opacity: .8,
    depthWrite: false, toneMapped: false, blending: ADD,
  });
  const desiredLine = new THREE.Line(makeLineGeo(), desiredLineMat);
  desiredLine.frustumCulled = false;
  group.add(desiredLine);

  const actualLineMat = lineMat(0xcff6ff, .35);
  const actualLine = new THREE.Line(makeLineGeo(), actualLineMat);
  actualLine.frustumCulled = false;
  group.add(actualLine);

  const desiredCap = new THREE.Mesh(new THREE.TorusGeometry(.32, .028, 6, 40), basicMat(C.cyan, .85));
  const actualCap = new THREE.Mesh(new THREE.TorusGeometry(.22, .022, 6, 32), basicMat(0xcff6ff, .7));
  desiredCap.frustumCulled = actualCap.frustumCulled = false;
  group.add(desiredCap, actualCap);

  /* ---------------- 6. 实时光束：镜面平面圆周 -> 光斑的斜锥面 ---------------- */
  const beamGeo = new THREE.BufferGeometry();
  const beamPositions = new Float32Array((BEAM_SEG + 1) * 3);
  beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3));
  /* 边缘亮、光斑端淡，读起来像一束收束的光而不是实心锥。 */
  const beamFade = new Float32Array(BEAM_SEG + 1);
  beamFade.fill(1, 0, BEAM_SEG);
  beamFade[BEAM_SEG] = .08;
  beamGeo.setAttribute('aFade', new THREE.BufferAttribute(beamFade, 1));
  const beamIndex = new Uint16Array(BEAM_SEG * 3);
  for (let i = 0; i < BEAM_SEG; i++) {
    beamIndex.set([i, (i + 1) % BEAM_SEG, BEAM_SEG], i * 3);
  }
  beamGeo.setIndex(new THREE.BufferAttribute(beamIndex, 1));
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false, blending: ADD, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0x9fe8ff) }, uOpacity: { value: .04 } },
    vertexShader: 'attribute float aFade; varying float vFade; void main(){ vFade = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; varying float vFade; void main(){ gl_FragColor = vec4(uColor, uOpacity * (0.1 + 0.9 * vFade)); }',
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.frustumCulled = false;
  group.add(beam);

  const rimGeo = new THREE.BufferGeometry();
  const rimPositions = new Float32Array(BEAM_SEG * 3);
  rimGeo.setAttribute('position', new THREE.BufferAttribute(rimPositions, 3));
  const rimLine = new THREE.LineLoop(rimGeo, lineMat(0x9fe8ff, .38));
  rimLine.frustumCulled = false;
  group.add(rimLine);

  /* 预分配圆周顶点，避免 update 内分配。 */
  const rimVerts = Array.from({ length: BEAM_SEG }, () => V());

  /* ---------------- 7. 实际光斑：小球 + 公告板光晕 + 偏移虚线 + 数值标签 ---------------- */
  const spotMat = basicMat(0xddffff, 1);
  const spotSphere = new THREE.Mesh(new THREE.SphereGeometry(.1, 12, 8), spotMat);
  spotSphere.frustumCulled = false;
  group.add(spotSphere);

  const spotHaloMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: ADD, toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(C.cyan) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying vec2 vUv; void main(){ float r = length(vUv * 2.0 - 1.0); float a = pow(max(0.0, 1.0 - r), 3.0) * 0.8; gl_FragColor = vec4(uColor, a); }',
  });
  const spotHalo = new THREE.Mesh(new THREE.PlaneGeometry(.95, .95), spotHaloMat);
  billboard(spotHalo);
  spotHalo.frustumCulled = false;
  group.add(spotHalo);

  const offsetGeo = makeLineGeo();
  const offsetLine = new THREE.Line(offsetGeo, new THREE.LineDashedMaterial({
    color: C.amber, dashSize: .4, gapSize: .3, transparent: true, opacity: .75,
    depthWrite: false, toneMapped: false, blending: ADD,
  }));
  offsetLine.frustumCulled = false;
  offsetLine.visible = false;
  group.add(offsetLine);

  const offsetLabel = makeLabel('光斑 偏移 0 mm', { size: 10, color: '#ffc27a', chip: true });
  offsetLabel.object.visible = false;
  group.add(offsetLabel.object);

  /* ---------------- 8. 平行入射光线：6 条，方向 -direction，终点在镜面平面内 ---------------- */
  const rayGeo = new THREE.BufferGeometry();
  rayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAY_COUNT * 2 * 3), 3));
  const rayMesh = new THREE.LineSegments(rayGeo, lineMat(C.ray, .18));
  rayMesh.frustumCulled = false;
  group.add(rayMesh);

  /* ---------------- 工具函数 ---------------- */
  /* 以法线为轴取一组稳定的平面基向量。 */
  function planeBasis(normal, u, v) {
    const helper = Math.abs(normal.y) < .9 ? Y_AXIS : Z_AXIS;
    u.copy(helper).cross(normal).normalize();
    v.copy(normal).cross(u).normalize();
  }
  function setLine(line, a, b) {
    const positions = line.geometry.attributes.position;
    positions.setXYZ(0, a.x, a.y, a.z);
    positions.setXYZ(1, b.x, b.y, b.z);
    positions.needsUpdate = true;
  }
  /* 虚线长度可能随状态变化，直接改已有 lineDistance attribute，避免重建几何。 */
  function setDashed(line, a, b) {
    setLine(line, a, b);
    const distance = a.distanceTo(b);
    const lineDistance = line.geometry.attributes.lineDistance;
    lineDistance.setX(0, 0);
    lineDistance.setX(1, distance);
    lineDistance.needsUpdate = true;
  }

  /* 由太阳轨迹采样插值出指定钟表时刻的方向（运动学坐标）；越界返回 null。 */
  let pathSamples = [];
  function directionAt(minutes) {
    const n = pathSamples.length;
    if (!n) return null;
    if (minutes <= pathSamples[0].minutes || minutes >= pathSamples[n - 1].minutes) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pathSamples[mid].minutes <= minutes) lo = mid; else hi = mid;
    }
    const a = pathSamples[lo], b = pathSamples[hi], span = b.minutes - a.minutes;
    const t = span > 1e-6 ? (minutes - a.minutes) / span : 0;
    return normalizeArray([
      a.direction[0] + (b.direction[0] - a.direction[0]) * t,
      a.direction[1] + (b.direction[1] - a.direction[1]) * t,
      a.direction[2] + (b.direction[2] - a.direction[2]) * t,
    ]);
  }
  const elevationOfDirection = dir => radToDeg(Math.asin(Math.max(-1, Math.min(1, dir[2]))));
  /* 方向 -> 天球上的场景坐标；setDay 里用于摆放刻度/标签。 */
  const positionOf = (dir, out) => out.copy(toScene(dir)).multiplyScalar(R_SKY);
  /* 时间标签略微外推，避免与日面/轨迹圆点重叠。 */
  const positionOfLabel = (dir, out) => positionOf(dir, out).multiplyScalar((R_SKY + 2) / R_SKY);

  /* 限位锥几何只需在 maxTiltDeg 变化时重写已有 attribute。 */
  let coneAngle = 35;
  function writeLimitCone(halfAngleDeg) {
    coneAngle = halfAngleDeg;
    const half = Math.max(1, Math.min(89, halfAngleDeg)) * DEG;
    const radius = FOCAL * Math.sin(half), height = FOCAL * Math.cos(half);
    const positions = coneGeo.attributes.position;
    positions.setXYZ(0, 0, 0, 0);
    for (let i = 0; i < CONE_SEG; i++) {
      const a = i / CONE_SEG * Math.PI * 2;
      positions.setXYZ(1 + i, Math.cos(a) * radius, height, Math.sin(a) * radius);
    }
    positions.needsUpdate = true;
    coneGeo.computeBoundingSphere();
    edgeRing.position.y = height;
    edgeRing.scale.setScalar(radius);
    const generatrices = generatrixGeo.attributes.position;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      generatrices.setXYZ(i * 2, 0, 0, 0);
      generatrices.setXYZ(i * 2 + 1, Math.cos(a) * radius, height, Math.sin(a) * radius);
    }
    generatrices.needsUpdate = true;
    generatrixGeo.computeBoundingSphere();
  }
  writeLimitCone(35);

  /* ---------------- setDay：日期 / 地点变化时重建当日轨迹与时间刻度 ---------------- */
  function setDay(day = {}) {
    const path = Array.isArray(day && day.path) ? day.path : [];
    pathSamples = path
      .filter(p => p && isVec(p.direction) && Number.isFinite(p.minutes) && p.elevation >= -2)
      .map(p => ({ minutes: p.minutes, direction: normalizeArray(p.direction) }));
    if (!pathSamples.length && path.length) {
      // 防御：即使调用方漏传 elevation，也接受全部采样点。
      pathSamples = path.filter(p => p && isVec(p.direction) && Number.isFinite(p.minutes))
        .map(p => ({ minutes: p.minutes, direction: normalizeArray(p.direction) }));
    }
    pathSamples.sort((a, b) => a.minutes - b.minutes);

    /* 轨迹折线（超过预分配长度时等间隔抽稀）。 */
    const count = Math.min(pathSamples.length, MAX_PATH);
    const stride = pathSamples.length > MAX_PATH ? pathSamples.length / MAX_PATH : 1;
    for (let i = 0; i < count; i++) {
      const sample = pathSamples[Math.min(pathSamples.length - 1, Math.round(i * stride))];
      toScene(sample.direction).multiplyScalar(R_SKY).toArray(pathPositions, i * 3);
    }
    pathGeo.setDrawRange(0, count);
    pathGeo.attributes.position.needsUpdate = true;
    pathGeo.computeBoundingSphere();

    /* 整点刻度：24 个实例，无效时刻缩放为 0。 */
    const dummy = new THREE.Object3D();
    for (let hour = 0; hour < 24; hour++) {
      const dir = directionAt(hour * 60);
      const show = !!dir && elevationOfDirection(dir) > -1.5;
      dummy.position.set(0, 0, 0);
      dummy.scale.setScalar(show ? 1 : 0);
      if (show) positionOf(dir, dummy.position);
      dummy.updateMatrix();
      tickMesh.setMatrixAt(hour, dummy.matrix);
    }
    tickMesh.instanceMatrix.needsUpdate = true;
    tickMesh.computeBoundingSphere();

    /* 每 2 小时一个时间标签（重复 setDay 时全部重设，避免沿用旧位置）。 */
    let labelIndex = 0;
    for (let hour = 0; hour < 24 && labelIndex < hourLabels.length; hour += 2) {
      const dir = directionAt(hour * 60);
      const show = !!dir && elevationOfDirection(dir) > -1.5;
      const label = hourLabels[labelIndex++];
      label.object.visible = show;
      if (!show) continue;
      positionOfLabel(dir, label.object.position);
      label.setText(`${pad2(hour)}:00`);
    }
    for (let i = labelIndex; i < hourLabels.length; i++) hourLabels[i].object.visible = false;

    /* 日出 / 日落小圆环 + 文本。 */
    const showEvent = (marker, label, minutes, text) => {
      const dir = minutes == null ? null : directionAt(minutes);
      const show = !!dir;
      marker.visible = show;
      label.object.visible = show;
      if (!show) return;
      positionOf(dir, marker.position);
      marker.position.y += .15;
      positionOf(dir, label.object.position);
      label.object.position.y += 1.15;
      label.setText(`${text} ${clockText(minutes)}`);
    };
    showEvent(riseMarker, riseLabel, day.sunrise, '日出');
    showEvent(setMarker, setLabel, day.sunset, '日落');
  }

  /* ---------------- update：每帧只改位姿 / 颜色 / 已有顶点 ---------------- */
  function update(state = {}) {
    const s = state || {};
    const targetKin = isVec(s.target) ? s.target : GEOMETRY.target;
    const dirKin = isVec(s.direction) ? normalizeArray(s.direction) : [0, 0, 1];
    const visible = s.visible !== false;
    const limited = s.limited === true;
    const maxTiltDeg = Number.isFinite(s.maxTiltDeg) ? s.maxTiltDeg : 35;
    if (Math.abs(maxTiltDeg - coneAngle) > 1e-4) writeLimitCone(maxTiltDeg);

    toSceneV(targetKin, _targetScene);
    toSceneV(dirKin, _dirScene).normalize();          // 太阳方向（场景坐标，单位向量）
    _sunScene.copy(_dirScene).multiplyScalar(R_SKY);
    sunGroup.position.copy(_sunScene);
    sunGroup.visible = visible;
    const elevationDeg = Number.isFinite(s.elevation)
      ? s.elevation : radToDeg(Math.asin(Math.max(-1, Math.min(1, dirKin[2]))));
    // 日面亮度随高度角下降，贴地时收敛为一条亮线。
    sunDisc.material.opacity = .55 + .45 * Math.max(0, Math.min(1, elevationDeg / 12));

    /* 限位锥：顶点跟随 target，limited 时锥面与边缘环变琥珀。 */
    limitGroup.position.copy(_targetScene);
    const accent = limited ? C.amber : C.cyan;
    coneMat.uniforms.uColor.value.setHex(accent);
    edgeRingMat.color.setHex(accent);
    edgeRingMat.opacity = limited ? .85 : .32;

    /* 期望 / 实际法线。 */
    const normalScene = isVec(s.normal) ? toSceneV(normalizeArray(s.normal), _normalScene) : _normalScene.copy(_dirScene);
    if (isVec(s.lensCenter)) toSceneV(s.lensCenter, _lensScene);
    else _lensScene.copy(_targetScene).addScaledVector(normalScene, FOCAL);
    if (isVec(s.desiredLensCenter)) toSceneV(s.desiredLensCenter, _desiredScene);
    else _desiredScene.copy(_targetScene).addScaledVector(_dirScene, FOCAL);
    if (isVec(s.spot)) toSceneV(s.spot, _spotScene);
    else _spotScene.copy(_targetScene);

    desiredLineMat.color.setHex(limited ? C.amber : C.cyan);
    setDashed(desiredLine, _targetScene, _desiredScene);
    setLine(actualLine, _targetScene, _lensScene);
    desiredCap.position.copy(_desiredScene);
    desiredCap.quaternion.setFromUnitVectors(Z_AXIS, _tmpA.copy(_desiredScene).sub(_targetScene).normalize());
    actualCap.position.copy(_lensScene);
    actualCap.quaternion.setFromUnitVectors(Z_AXIS, _tmpA.copy(_lensScene).sub(_targetScene).normalize());

    /* 斜锥光束：镜面平面内的圆周 -> 光斑。圆周必须用镜面法线定平面，不能拿锥轴。 */
    planeBasis(normalScene, _u, _v);
    for (let i = 0; i < BEAM_SEG; i++) {
      const a = i / BEAM_SEG * Math.PI * 2;
      rimVerts[i].copy(_lensScene)
        .addScaledVector(_u, Math.cos(a) * MIRROR_RADIUS)
        .addScaledVector(_v, Math.sin(a) * MIRROR_RADIUS);
      rimVerts[i].toArray(rimPositions, i * 3);
      rimVerts[i].toArray(beamPositions, i * 3);
    }
    _spotScene.toArray(beamPositions, BEAM_SEG * 3);
    beamGeo.attributes.position.needsUpdate = true;
    rimGeo.attributes.position.needsUpdate = true;

    /* 实际光斑与偏移。 */
    const spotOffsetMm = Number.isFinite(s.spotOffsetMm) ? s.spotOffsetMm : 0;
    spotMat.color.setHex(limited ? C.amber : 0xddffff);
    spotHaloMat.uniforms.uColor.value.setHex(limited ? C.amber : C.cyan);
    spotSphere.position.copy(_spotScene);
    spotHalo.position.copy(_spotScene).addScaledVector(Y_AXIS, .03);

    const showOffset = spotOffsetMm > 5;
    offsetLine.visible = showOffset;
    offsetLabel.object.visible = showOffset;
    if (showOffset) {
      setDashed(offsetLine, _targetScene, _spotScene);
      offsetLabel.object.position.copy(_spotScene).addScaledVector(Y_AXIS, .75);
      offsetLabel.setText(`光斑 偏移 ${Math.round(spotOffsetMm)} mm`);
    }

    /* 平行入射光线：起点在上方（沿太阳方向 9 单位），终点落在镜面平面半径 5.6 内。 */
    rayMesh.visible = visible;
    if (visible) {
      const rayPositions = rayGeo.attributes.position;
      for (let i = 0; i < RAY_COUNT; i++) {
        const a = i / RAY_COUNT * Math.PI * 2;
        _tmpA.copy(_lensScene)
          .addScaledVector(_u, Math.cos(a) * 5.6)
          .addScaledVector(_v, Math.sin(a) * 5.6);
        _tmpB.copy(_tmpA).addScaledVector(_dirScene, 9);
        rayPositions.setXYZ(i * 2, _tmpB.x, _tmpB.y, _tmpB.z);
        rayPositions.setXYZ(i * 2 + 1, _tmpA.x, _tmpA.y, _tmpA.z);
      }
      rayPositions.needsUpdate = true;
    }
  }

  update();
  return { group, handle, setDay, update };
}
