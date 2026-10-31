import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildRig, DEFAULT_INFO, toScene } from './model.js';
import { CHANNELS, ZERO_POSE, GEOMETRY, clamp, clampPose, trajectoryPose, assertZeroLengths } from './kinematics.js';

/* 场景、拆解与运动共享一份状态，运动模式的基座铰点始终固定。 */
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const canvas = $('#stage'), app = $('#app');
const easeOut = t => 1 - (1 - t) ** 3;
assertZeroLengths();
const state = { mode: 'explode', explode: 0, target: 0, auto: false, direction: 1, hold: 0,
  pose: { ...ZERO_POSE }, playing: false, elapsed: 0, duration: 20, path: 'square' };

/* 基础环境与范本一致：物理金属、室内环境、三色布光及轻量泛光。 */
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); }
catch (error) { $('#boot').textContent = '浏览器未启用 WebGL，无法运行此页面'; throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, .5, 700);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = .055;
controls.enablePan = false; controls.minDistance = 26; controls.maxDistance = 320;
controls.minPolarAngle = .05; controls.maxPolarAngle = Math.PI - .05;
controls.autoRotateSpeed = .22;
const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, .04).texture; scene.environmentIntensity = .75;
room.dispose(); pmrem.dispose();
scene.add(new THREE.AmbientLight(0x8899bb, .8));
[[0xffffff, 2.4, [10, 19, 12]], [0x5fe3ff, 2, [-12, 8, -8]], [0xffb05c, 1.1, [11, 3, -4]], [0xcfe6ff, 1.2, [-3, 10, 16]]].forEach(([color, intensity, pos]) => {
  const light = new THREE.DirectionalLight(color, intensity); light.position.set(...pos.map(v => v * 1.9)); scene.add(light);
});
const glassRimLight=new THREE.DirectionalLight(0xBFE4FF,1.4);glassRimLight.position.set(14,26,-18);scene.add(glassRimLight);
const background = new THREE.Mesh(new THREE.SphereGeometry(340, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uBase: { value: new THREE.Color(0x05070d) }, uGlow: { value: new THREE.Color(0x0a1626) } },
  vertexShader: 'varying vec3 vDir; void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: 'uniform vec3 uBase; uniform vec3 uGlow; varying vec3 vDir; void main(){vec3 d=normalize(vDir);float g=pow(max(0.0,dot(d,normalize(vec3(-0.5,0.1,-1.0)))),2.0);gl_FragColor=vec4(mix(uBase,uGlow,g),1.0);}',
})); scene.add(background);
const dustPositions = [];
for (let i = 0; i < 380; i++) {
  const angle = i * 2.399963, radius = 62 + (i % 19) * 3;
  dustPositions.push(Math.cos(angle) * radius, (Math.sin(i * 3.71) * .5 + .5) * 65 - 18, Math.sin(angle) * radius);
}
const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(dustPositions, 3)), new THREE.PointsMaterial({ color: 0x8fa3bd, size: .045, transparent: true, opacity: .5, depthWrite: false })); scene.add(dust);
const rig = buildRig(); scene.add(rig.root);
const ring = new THREE.Mesh(new THREE.TorusGeometry(16, .014, 6, 160), new THREE.MeshBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: .16 }));
ring.rotation.x = Math.PI / 2; ring.position.y = -.67; scene.add(ring);
const grid = new THREE.GridHelper(48, 48, 0x254754, 0x142734); grid.position.y = -.7;
grid.material.transparent = true; grid.material.opacity = .23; scene.add(grid);
const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), .34, .5, .9)); composer.addPass(new OutputPass());
const labelRenderer = new CSS2DRenderer({ element: $('#label-layer') });

/* 标签与参数卡共享零件编号，射线拾取和标签按钮均可聚焦。 */
let selectedId = null, hoverId = null, lastInteract = performance.now(), userView = false;
rig.parts.filter(p => p.label).forEach(p => {
  const el = document.createElement('button'); el.type = 'button'; el.className = 'part-label';
  el.innerHTML = `<span class="dot"></span><span class="no">${p.no}</span><span>${p.name}</span>`;
  el.setAttribute('aria-label', `查看${p.name}参数`);
  el.addEventListener('click', () => selectPart(p.id));
  el.addEventListener('pointerenter', () => setHover(p.id)); el.addEventListener('pointerleave', () => setHover(null));
  const label = new CSS2DObject(el); label.position.copy(p.labelPos); p.obj.add(label); p.el = el; p.labelObj = label;
});

/* 在 CSS2D 投影之后做屏幕排布；用完整标签边界避让 HUD，而非只判断锚点。 */
const labelPoint = new THREE.Vector3();
const hudElements = [...document.querySelectorAll('.hud-head,.hud-info,.pose-panel,.length-panel,.hud-bar,.scene-caption')];
const labelParts = rig.parts.filter(p => p.el);
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function layoutLabels() {
  const margin = 12, gap = 10, placed = [];
  const safe = hudElements.filter(el => el.getClientRects().length).map(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left - gap, right: r.right + gap, top: r.top - gap, bottom: r.bottom + gap };
  });
  // 主结构、上下铰链优先；空间不足时先收起电缸等低优先级标签。
  const priority = p => p.id === selectedId ? -2 : p.id === hoverId ? -1 : p.id.startsWith('cylinder') ? 20 : Number(p.no);
  const ordered = [...labelParts].sort((a, b) => priority(a) - priority(b));
  for (const p of ordered) {
    const el = p.el;
    const wanted = state.mode === 'explode' && state.explode > .07 || p.id === selectedId || p.id === hoverId;
    p.labelObj.getWorldPosition(labelPoint).project(camera);
    let result = null;
    if (wanted && el.style.display !== 'none' && labelPoint.z >= -1 && labelPoint.z <= 1) {
      const width = el.offsetWidth, height = el.offsetHeight;
      const anchorX = (labelPoint.x + 1) * innerWidth / 2, anchorY = (1 - labelPoint.y) * innerHeight / 2;
      const boxAt = (x, y) => ({ x, y, left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 });
      // 优先水平推向中心，仍有标签碰撞时，以 44px 为步长上下错开。
      for (let step = 0; step <= 8 && !result; step++) {
        const offsets = step ? [-step * 44, step * 44] : [0];
        for (const dy of offsets) {
          const y = anchorY + dy;
          if (y - height / 2 < margin || y + height / 2 > innerHeight - margin) continue;
          let x = clamp(anchorX, margin + width / 2, innerWidth - margin - width / 2);
          for (let pass = 0; pass < safe.length; pass++) {
            const hit = safe.find(r => intersects(boxAt(x, y), r));
            if (!hit) break;
            x = (hit.left + hit.right) / 2 < innerWidth / 2 ? hit.right + width / 2 : hit.left - width / 2;
          }
          const box = boxAt(x, y);
          if (box.left < margin || box.right > innerWidth - margin || safe.some(r => intersects(box, r))) continue;
          if (placed.some(r => Math.hypot(x - r.x, y - r.y) < 44 || intersects(box, {
            left: r.left - 8, right: r.right + 8, top: r.top - 8, bottom: r.bottom + 8,
          }))) continue;
          // 次要标签不跨越大半屏去寻找空位。
          if (p.id.startsWith('cylinder') && Math.hypot(x - anchorX, dy) > 180 && p.id !== selectedId && p.id !== hoverId) continue;
          result = box;
          el.style.translate = `${x - anchorX}px ${y - anchorY}px`;
          break;
        }
      }
    }
    el.classList.toggle('is-on', !!result);
    el.style.visibility = result ? 'visible' : 'hidden';
    el.tabIndex = result ? 0 : -1;
    if (result) placed.push(result);
  }
}
function showInfo(part) {
  const data = part || DEFAULT_INFO;
  $('#info-kicker').textContent = part ? `部件参数 / ${part.no}` : '整机概览';
  $('#info-title').textContent = part ? part.name : data.title;
  $('#info-desc').textContent = data.desc;
  $('#info-spec').replaceChildren(...data.spec.map(text => { const b = document.createElement('b'); b.textContent = text; return b; }));
  $('#info').classList.toggle('selected', !!part);
}
const tween = { active: false, time: 0, duration: 1, p0: new THREE.Vector3(), p1: new THREE.Vector3(), q0: new THREE.Vector3(), q1: new THREE.Vector3() };
function flyTo(position, target, duration = 1) {
  tween.p0.copy(camera.position); tween.p1.copy(position); tween.q0.copy(controls.target); tween.q1.copy(target);
  tween.time = 0; tween.duration = duration; tween.active = true;
}
function selectPart(id) {
  selectedId = id; const part = rig.parts.find(p => p.id === id);
  rig.parts.forEach(p => p.el?.classList.toggle('is-sel', p.id === id)); showInfo(part);
  if (part) {
    const box = new THREE.Box3().setFromObject(part.obj), target = box.getCenter(new THREE.Vector3());
    const radius = Math.max(2.2, box.getSize(new THREE.Vector3()).length() / 2);
    const distance = Math.max(14, radius * 3 / Math.min(1, camera.aspect));
    flyTo(target.clone().add(camera.position.clone().sub(controls.target).normalize().multiplyScalar(distance)), target);
    userView = true;
  } else { userView = false; fitView(true); }
  lastInteract = performance.now();
}
$('#info-close').addEventListener('click', () => selectPart(null));
function setHover(id) { hoverId = id; rig.parts.forEach(p => p.el?.classList.toggle('is-hover', p.id === id)); canvas.style.cursor = id ? 'pointer' : ''; }

/* 根据可用的画幅区域构图：竖屏把模型放在顶部控制区与底部 HUD 之间。 */
const viewDirections = { hero: new THREE.Vector3(1, .64, 1.3), front: new THREE.Vector3(0, .24, 1), side: new THREE.Vector3(1, .24, 0), top: new THREE.Vector3(.02, 1, .04) };
let currentView = 'hero';
function viewportRegion() {
  const w = innerWidth, h = innerHeight, portrait = h > w;
  let top = portrait ? Math.min(h * .38, w <= 600 ? 520 : 630) : h < 650 ? 60 : 115;
  const bottom = portrait ? h - (state.mode === 'motion' ? 270 : 220) : h - (state.mode === 'motion' ? 210 : 165);
  if (portrait && state.mode === 'motion' && w > 600) top = Math.min(bottom - h * .27, Math.max(top, $('.pose-panel').getBoundingClientRect().bottom + 20));
  return { x: portrait ? w * .5 : w * .5 + 14, y: (top + bottom) / 2 - (portrait && state.mode !== 'motion' ? h * .055 : 0),
    width: portrait ? w - 55 : Math.max(w * .35, w - 595), height: Math.max(h * .27, bottom - top) };
}
function fitView(animate = false) {
  const region = viewportRegion(), e = easeOut(state.explode);
  const motion = state.mode === 'motion';
  const target = new THREE.Vector3(0, (motion ? 13.2 : 11.7) + e * 5.4, 0);
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const width = (currentView === 'top' ? 30 : motion ? 28 : 26) + 4 * e, height = currentView === 'top' ? 30 + 5 * e : (motion ? 27.5 : 23) + 11 * e;
  const portraitScale = camera.aspect < 1 ? (state.mode === 'motion' ? 1.08 : THREE.MathUtils.lerp(.88, .94, clamp(camera.aspect, 0, 1))) : 1;
  const distance = Math.max(width / (2 * tangent * camera.aspect * region.width / innerWidth), height / (2 * tangent * region.height / innerHeight)) * 1.0 * portraitScale;
  const position = target.clone().add(viewDirections[currentView].clone().normalize().multiplyScalar(distance));
  if (animate) flyTo(position, target); else { camera.position.copy(position); controls.target.copy(target); }
}
function setProjection() {
  const r = viewportRegion(); camera.aspect = innerWidth / innerHeight;
  camera.setViewOffset(innerWidth, innerHeight, innerWidth / 2 - r.x, innerHeight / 2 - r.y, innerWidth, innerHeight);
  camera.updateProjectionMatrix();
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  currentView = button.dataset.view; userView = true; selectedId = null; showInfo(null);
  rig.parts.forEach(p => p.el?.classList.remove('is-sel'));
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b === button));
  fitView(true); lastInteract = performance.now();
}));
controls.addEventListener('start', () => { tween.active = false; userView = true; lastInteract = performance.now(); });
controls.addEventListener('end', () => { lastInteract = performance.now(); });
canvas.addEventListener('wheel', () => { userView = true; }, { passive: true });

/* 六通道双向绑定，手动输入立即暂停轨迹；输入越界在本次事件内收敛到边界。 */
const inputs = new Map();
/* Z 通道对外显示绝对平台高度（1.7–2.7 m），内部仍存相对中位的偏移量。 */
const chLo = c => c.origin ? c.origin - c.max : -c.max;
const chHi = c => c.origin ? c.origin + c.max : c.max;
const toChannel = (c, poseValue) => c.origin ? poseValue + c.origin : poseValue;
const toPose = (c, channelValue) => c.origin ? channelValue - c.origin : channelValue;
CHANNELS.forEach(c => {
  const row = document.createElement('div'); row.className = 'channel';
  const lo = chLo(c), hi = chHi(c), start = toChannel(c, 0);
  row.innerHTML = `<div class="channel-head"><label for="pose-${c.key}">${c.name}<small>${c.unit}</small></label><input id="pose-${c.key}" type="number" min="${lo}" max="${hi}" step="0.1" value="${start}" aria-label="${c.name} 数值 ${c.unit}"></div><input id="range-${c.key}" type="range" min="${lo}" max="${hi}" step="0.1" value="${start}" aria-label="${c.name} 滑杆 ${c.unit}"><div class="channel-bounds"><span>${lo}</span><span>${hi}</span></div>`;
  $('#pose-controls').append(row);
  const number = row.querySelector('[type=number]'), range = row.querySelector('[type=range]'); inputs.set(c.key, { number, range });
  [number, range].forEach(input => input.addEventListener('input', () => {
    pausePath(); state.pose[c.key] = toPose(c, clamp(Number(input.value), chLo(c), chHi(c))); syncInputs(); updateTarget();
  }));
  number.addEventListener('change', syncInputs); number.addEventListener('blur', syncInputs);
});
function syncInputs() {
  CHANNELS.forEach(c => { const value = String(Number(toChannel(c, state.pose[c.key]).toFixed(1))); const pair = inputs.get(c.key); pair.number.value = value; pair.range.value = value; });
}
const lengthRows = Array.from({ length: 6 }, (_, i) => {
  const row = document.createElement('div'); row.className = 'length-row';
  row.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span><div class="length-track"><i></i></div><b>—</b>`; $('#lengths').append(row);
  return { row, value: row.querySelector('b'), bar: row.querySelector('i') };
});

/* 轨迹与目标球使用完全相同的采样函数；螺旋到终点后停止，避免回跳。 */
const pathGroup = new THREE.Group(); scene.add(pathGroup);
// 轨迹位于平台参考点平面，叠加绘制保证不会被上平台自身遮挡。
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: .7, depthTest: false, depthWrite: false })); pathLine.renderOrder = 50; pathGroup.add(pathLine);
const targetBall = new THREE.Mesh(new THREE.SphereGeometry(.115, 18, 12), new THREE.MeshStandardMaterial({ color: 0xffb05c, emissive: 0xffb05c, emissiveIntensity: 4, depthTest: false, depthWrite: false })); targetBall.renderOrder = 51; pathGroup.add(targetBall);
const targetRing = new THREE.Mesh(new THREE.TorusGeometry(.23, .018, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffb05c, depthTest: false, depthWrite: false })); targetRing.renderOrder = 52; targetRing.rotation.x = Math.PI / 2; targetBall.add(targetRing);
function pathPoint(p) { return toScene([p.x / 100, p.y / 100, GEOMETRY.homeHeight + p.z / 100]); }
function rebuildPath() {
  const points = Array.from({ length: 481 }, (_, i) => pathPoint(trajectoryPose(state.path, i / 480)));
  pathLine.geometry.dispose(); pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
  updateTarget();
}
function updateTarget() { targetBall.position.copy(pathPoint(state.pose)); }
function pausePath() { state.playing = false; $('#path-play').classList.remove('on'); $('#path-play').setAttribute('aria-pressed', 'false'); }
function playPath() {
  if (state.mode !== 'motion') setMode('motion');
  if (state.elapsed >= state.duration) state.elapsed = 0;
  state.playing = true; $('#path-play').classList.add('on'); $('#path-play').setAttribute('aria-pressed', 'true');
}
$('#path-play').addEventListener('click', playPath); $('#path-pause').addEventListener('click', pausePath);
$('#path-reset').addEventListener('click', () => { pausePath(); state.elapsed = 0; state.pose = { ...ZERO_POSE }; syncInputs(); updateTarget(); });
$('#trajectory').addEventListener('change', e => {
  pausePath(); state.path = e.target.value; state.elapsed = 0; state.pose = trajectoryPose(state.path, 0); syncInputs(); rebuildPath();
});

/* 模式切换先归零装配；运动时不保留任何拆解偏移。 */
function setAuto(on) {
  state.auto = on; state.direction = state.explode > .98 ? -1 : 1; state.hold = 0;
  $('#explode-auto').textContent = on ? 'Ⅱ 暂停拆解' : '▶ 自动拆解'; $('#explode-auto').setAttribute('aria-pressed', String(on));
}
function setMode(mode) {
  state.mode = mode; app.dataset.mode = mode; pausePath(); setAuto(false);
  state.explode = 0; state.target = 0;
  if (mode === 'explode') state.pose = { ...ZERO_POSE };
  document.querySelectorAll('.mode-switch button').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  pathGroup.visible = mode === 'motion'; selectedId = null; showInfo(null); rig.parts.forEach(p => p.el?.classList.remove('is-sel'));
  $('#scene-mode').textContent = mode === 'motion' ? '六轴运动' : '构件拆解';
  $('#progress').value = '0'; syncInputs(); setProjection(); userView = false; fitView(true);
}
document.querySelectorAll('.mode-switch button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#progress').addEventListener('input', e => { const value = Number(e.target.value) / 100; if (state.mode !== 'explode') setMode('explode'); state.target = value; setAuto(false); });
$('#explode-auto').addEventListener('click', () => { if (state.mode !== 'explode') setMode('explode'); setAuto(!state.auto); });

/* 拖拽和点击分开判断，按下/抬起使用当前指针重新拾取，避免悬停缓存失效。 */
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
let down = null;
function pick(event) {
  const r = canvas.getBoundingClientRect(); pointer.set((event.clientX - r.left) / r.width * 2 - 1, -(event.clientY - r.top) / r.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(rig.root, true).find(h => h.object.isMesh && h.object.userData.partId)?.object.userData.partId ?? null;
}
canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointermove', e => setHover(pick(e)));
canvas.addEventListener('pointerleave', () => setHover(null));
canvas.addEventListener('pointerup', e => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) selectPart(pick(e)); down = null; });
canvas.addEventListener('pointercancel', () => { down = null; });
window.addEventListener('keydown', e => {
  if (e.target.closest('input,select,button')) return;
  if (e.code === 'Space') { e.preventDefault(); if (state.mode === 'motion') state.playing ? pausePath() : playPath(); else setAuto(!state.auto); }
  if (e.key === 'Escape') selectPart(null);
  if (e.key.toLowerCase() === 'r') { userView = false; currentView = 'hero'; fitView(true); }
});
function resize() {
  renderer.setSize(innerWidth, innerHeight, false); composer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
  setProjection(); if (!userView) fitView();
}
window.addEventListener('resize', resize);

/* 拆解缓动与范本采用相同的三次缓出；运动学不叠加任何装饰性漂浮。 */
const clock = new THREE.Clock();
let previousFit = -1, hudAccumulator = 1;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), .05);
  if (state.mode === 'explode') {
    if (state.auto) {
      if (state.hold > 0) state.hold -= dt;
      else {
        state.target = clamp(state.target + state.direction * dt * .18, 0, 1);
        if (state.target === 1 || state.target === 0) { state.direction *= -1; state.hold = 1.8; }
      }
    }
    state.explode += (state.target - state.explode) * Math.min(1, dt * 5);
    if (Math.abs(state.explode - state.target) < .0003) state.explode = state.target;
  } else if (state.playing) {
    state.elapsed += dt;
    if (state.elapsed >= state.duration) {
      if (state.path === 'helix') { state.elapsed = state.duration; pausePath(); }
      else state.elapsed %= state.duration;
    }
    state.pose = clampPose(trajectoryPose(state.path, state.elapsed / state.duration)); syncInputs();
  }
  const ik = rig.update(state.pose, state.mode === 'explode' ? state.explode : 0); updateTarget();
  rig.parts.forEach(p => {
    if (!p.el) return;
    p.labelObj.position.copy(p.labelPos);
  });
  hudAccumulator += dt;
  if (hudAccumulator > .07) {
    hudAccumulator = 0;
    ik.lengths.forEach((length, i) => {
      const r=lengthRows[i], limit=length<GEOMETRY.legMin-1 || length>GEOMETRY.legMax+1, warn=length<GEOMETRY.legMin+200 || length>GEOMETRY.legMax-200;
      r.value.textContent = length.toFixed(1) + (limit ? ' 超限' : '');
      r.bar.style.width = `${clamp((length - GEOMETRY.legMin) / ((GEOMETRY.legMax - GEOMETRY.legMin) / 100), 0, 100)}%`;
      r.row.classList.toggle('limit',limit);r.row.classList.toggle('warn',!limit && warn);
    });
    const o=ik.optics, locked=o.errorMm<2;
    $('#focus-readout').classList.toggle('locked',locked);
    $('#focus-height').textContent=`z=${(o.lens[2]*100).toFixed(1)} → ${(o.focus[2]*100).toFixed(1)} mm`;
    $('#focus-error').textContent=`偏差 ${o.errorMm.toFixed(1)} mm`;
    $('#focus-status').textContent=locked ? '锁定' : '偏离';
    $('#length-note').textContent = state.mode === 'motion' ? '实时长度 · 下铰点固定' : state.explode > .01 ? '拆解示意 · 数据为装配零位长度' : '零位等长校验通过';
    const pct = Math.round(state.explode * 100); $('#progress').value = String(pct); $('#pct').textContent = `${pct}%`;
    $('#path-time').textContent = `${state.elapsed.toFixed(1).padStart(4, '0')} / 20.0 s`;
    $('#scene-status').textContent = state.mode === 'explode' ? pct ? `拆解 ${pct}%` : '装配状态' : state.playing ? '轨迹运行中' : '手动控制 / 已暂停';
  }
  if (!userView && Math.abs(state.explode - previousFit) > .012 && !tween.active) { previousFit = state.explode; fitView(true); }
  controls.autoRotate = state.mode === 'motion' && !userView && !tween.active && performance.now() - lastInteract > 4500;
  if (tween.active) {
    tween.time += dt / tween.duration; const k = easeOut(clamp(tween.time, 0, 1));
    camera.position.lerpVectors(tween.p0, tween.p1, k); controls.target.lerpVectors(tween.q0, tween.q1, k);
    if (tween.time >= 1) tween.active = false;
  }
  controls.update(dt); dust.rotation.y += dt * .002;
  if (params.get('nofx') === '1') renderer.render(scene, camera); else composer.render();
  labelRenderer.render(scene, camera); layoutLabels();
}

/* 演示参数仅用于可重复自检：默认拆解，?mode=motion&path=helix&play=1。 */
if (params.get('ui') === '0') document.body.classList.add('ui-hidden');
setMode(params.get('mode') === 'motion' ? 'motion' : 'explode');
if (state.mode === 'explode' && params.has('t')) state.explode = state.target = clamp(Number(params.get('t')), 0, 1);
if (['square', 'circle', 'eight', 'helix'].includes(params.get('path'))) { state.path = params.get('path'); $('#trajectory').value = state.path; }
if (viewDirections[params.get('view')]) { currentView = params.get('view'); userView = true; }
if (params.get('auto') === '1' && state.mode === 'explode') setAuto(true);
if (params.get('play') === '1' && state.mode === 'motion') playPath();
rebuildPath(); resize(); fitView(); tween.active = false; previousFit = state.explode;
/* 显式机位最后覆盖自动构图，确保录屏参数可重复。 */
const readVector = key => {
  const values = (params.get(key) || '').split(',').map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? new THREE.Vector3(...values) : null;
};
const manualCamera=readVector('cam'), manualLook=readVector('look');
if(manualCamera){camera.position.copy(manualCamera);if(manualLook)controls.target.copy(manualLook);userView=true;}
showInfo(null); tick(); setTimeout(() => $('#boot').classList.add('hide'), 260);
