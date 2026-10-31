import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GEOMETRY, BASE_ANCHORS, PLATFORM_ANCHORS, inverseKinematics, opticalState, ZERO_POSE } from './kinematics.js';

/* 将运动学的 Z 向上坐标变换为场景 Y 向上；这是保手性的正交变换。 */
export const toScene = p => new THREE.Vector3(p[0], p[2], -p[1]);
export const MAT = {
  steel: new THREE.MeshPhysicalMaterial({ color: 0x202731, metalness: .86, roughness: .36, clearcoat: .3 }),
  black: new THREE.MeshStandardMaterial({ color: 0x111820, metalness: .65, roughness: .46 }),
  silver: new THREE.MeshPhysicalMaterial({ color: 0xb7c5d3, metalness: .96, roughness: .24, clearcoat: .5 }),
  chrome: new THREE.MeshPhysicalMaterial({ color: 0xe5edf4, metalness: 1, roughness: .12 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0b1018, roughness: .8 }),
  cyan: new THREE.MeshBasicMaterial({ color: 0x5fe3ff }),
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const yAxis = V(0, 1, 0);
const box = (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, .035);
function mesh(parent, geometry, material, position = V(0, 0, 0)) {
  const m = new THREE.Mesh(geometry, material); m.position.copy(position); parent.add(m); return m;
}
function beam(parent, a, b, radius = .16, material = MAT.steel) {
  const m = mesh(parent, new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12), material, a.clone().add(b).multiplyScalar(.5));
  m.quaternion.setFromUnitVectors(yAxis, b.clone().sub(a).normalize()); return m;
}
/* 万向铰只保留"座 + 球头"两级细节，避免满屏小零件。 */
function hinge() {
  const g = new THREE.Group();
  mesh(g, box(.95, .4, .85), MAT.black);
  mesh(g, new THREE.SphereGeometry(.22, 14, 10), MAT.chrome, V(0, .24, 0));
  g.scale.setScalar(1.6); return g;
}

/* 模型工厂按独立零件分组，主程序只调用 update，不操纵网格细节。 */
export function buildRig() {
  const root = new THREE.Group(), parts = [];
  function add(id, name, obj, spec, desc, labelPos, parent = root, label = true) {
    parent.add(obj);
    obj.traverse(o => { if (o.isMesh) o.userData.partId = id; });
    const part = { id, name, obj, spec, desc, labelPos, label, no: String(parts.length + 1).padStart(2, '0') };
    parts.push(part); return part;
  }
  const orange = new THREE.MeshStandardMaterial({ color: 0xE0602C, roughness: .85 });
  const frameSteel = new THREE.MeshPhysicalMaterial({ color: 0x252C34, metalness: .45, roughness: .55, clearcoat: .08 });
  const base = new THREE.Group(), weights = new THREE.Group();
  /* 底座六边形管框做成整体环形截面（斜接角），避免六段梁在角点互相穿插。 */
  const BASE_R = 8.75, FRAME_W = .6, FRAME_H = .45;
  const hexPoints = (r, reverse) => Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 3 * (reverse ? 5 - k : k);
    return V(r * Math.cos(a), r * Math.sin(a), 0);
  });
  const frameShape = new THREE.Shape(hexPoints(BASE_R, false));
  frameShape.holes.push(new THREE.Path(hexPoints(BASE_R - FRAME_W, true)));
  const frameMesh = mesh(base, new THREE.ExtrudeGeometry(frameShape, { depth: FRAME_H, bevelEnabled: true, bevelThickness: .05, bevelSize: .05, bevelSegments: 2 }), frameSteel, V(0, .15, 0));
  frameMesh.rotation.x = -Math.PI / 2;
  BASE_ANCHORS.forEach(p => {
    const a = toScene(p), dir = a.clone().setY(0).normalize(), yaw = -Math.atan2(a.z, a.x);
    // 地脚垫板：压在管框下、落地，避免环框悬空。
    const pad = mesh(base, box(1.5, .22, 1.25), MAT.black, dir.clone().multiplyScalar(BASE_R - .1).setY(.11));
    pad.rotation.y = yaw;
    // 铰点悬臂托板：从管框内壁伸到铰点圆，与环框焊接。
    const arm = mesh(base, box(1.45, .26, 1.0), frameSteel, dir.clone().multiplyScalar(7.5).setY(.78));
    arm.rotation.y = yaw;
    // 三角加强筋：托板两侧的焊接筋板。
    [-1, 1].forEach(side => {
      const gus = mesh(base, box(1.1, .5, .1), frameSteel, dir.clone().multiplyScalar(7.5).add(V(-dir.z * side * .42, .52, dir.x * side * .42)));
      gus.rotation.y = yaw;
    });
    // 配重：移到环框外侧落地，互不重叠也不穿框。
    const weight = mesh(weights, new RoundedBoxGeometry(2.6, 1.5, 1.9, 2, .14), orange, dir.clone().multiplyScalar(10.0).setY(.75));
    weight.rotation.y = yaw;
  });
  // 控制柜移到环框外的地面上，加底座托板。
  mesh(base, box(4.4, .18, 1.8), MAT.black, V(0, .09, 10.9));
  mesh(base, box(4.2, 1.9, 1.6), MAT.black, V(0, 1.05, 10.9));
  add('base', '基座底板', base, ['外径约 1700 mm / 厚 40 mm','铰点 R = 722.9 mm','铰点高 80 mm'], '低矮中空底板固定六个铰点，并为地面料床保留视线。', V(-7,.4,3));
  add('weights','配重块',weights,['6 × 300 × 200 × 150 mm','橙色地脚配重'],'六处地脚配重稳定聚光装置的支承边界。', V(8,1,1));

  const lower = new THREE.Group(), upper = new THREE.Group();
  const lowerHinges = BASE_ANCHORS.map(() => { const h=hinge(); lower.add(h); return h; });
  const upperHinges = BASE_ANCHORS.map(() => { const h=hinge(); upper.add(h); return h; });
  add('lower','下铰链',lower,['6 组万向耳座','R = 722.9 mm'], '固定铰链将缸力传递至基座。',toScene(BASE_ANCHORS[4]));
  add('upper','上铰链',upper,['6 组万向耳座','R = 688.6 mm','连接映射 [5,0,1,2,3,4]'], '随动铰链允许六缸协同调节透镜姿态。',V(0,0,0));

  /* 上平台就是"黑色圆环框"：圆环直接承托透镜，二者共面。 */
  const platform = new THREE.Group();
  const ringMat=new THREE.MeshPhysicalMaterial({color:0x0E1319,metalness:.55,roughness:.42,clearcoat:.3});
  const RING_OUT=7.45, RING_IN=6.5, RING_T=.5;
  const ringShape=new THREE.Shape();ringShape.absarc(0,0,RING_OUT,0,Math.PI*2,false);
  const ringHole=new THREE.Path();ringHole.absarc(0,0,RING_IN,0,Math.PI*2,true);ringShape.holes.push(ringHole);
  const ringMesh=mesh(platform,new THREE.ExtrudeGeometry(ringShape,{depth:RING_T,bevelEnabled:false,curveSegments:96}),ringMat,V(0,0,0));
  ringMesh.rotation.x=-Math.PI/2;
  const innerSeat=mesh(platform,new THREE.TorusGeometry(RING_IN+.03,.05,8,128),MAT.silver,V(0,RING_T*.55,0));innerSeat.rotation.x=Math.PI/2;
  PLATFORM_ANCHORS.forEach(q=>{
    const a=toScene(q), yaw=-Math.atan2(a.z,a.x);
    const br=mesh(platform,box(1.1,.55,1.0),MAT.steel,a.clone().setY(-.28));br.rotation.y=yaw;
  });
  add('platform','上平台（圆环框）',platform,['黑色圆环框 Ø1490 / 内孔 Ø1300','框厚 50 mm · 展示位中心高 2200 mm','透镜与环共面'], '六缸直接驱动黑色圆环框；菲涅尔透镜嵌在环内，与环共面，随平台同步调姿。',V(6,RING_T,-1));

  const lens=new THREE.Group();
  const glass=new THREE.MeshPhysicalMaterial({color:0x8FB8CC,transparent:true,opacity:.13,roughness:.08,metalness:0,clearcoat:1,ior:1.45,toneMapped:true,side:THREE.DoubleSide,depthWrite:false});
  mesh(lens,new THREE.CylinderGeometry(6.48,6.48,.25,96),glass,V(0,.3,0));
  const groove=new THREE.LineBasicMaterial({color:0xDCEFFF,transparent:true,opacity:.30,toneMapped:false,depthWrite:false});
  for(let i=0;i<36;i++){
    const r=Math.sqrt(1.2**2+(6.42**2-1.2**2)*i/35);
    const pts=Array.from({length:193},(_,j)=>V(r*Math.cos(j*Math.PI/96),.44,r*Math.sin(j*Math.PI/96)));
    lens.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),groove));
  }
  const alignment=mesh(lens,new THREE.TorusGeometry(.15,.012,6,32),new THREE.MeshBasicMaterial({color:0x5fe3ff,transparent:true,opacity:.5,toneMapped:false}),V(0,.46,0));alignment.rotation.x=Math.PI/2;
  add('lens','菲涅尔透镜',lens,['PMMA Ø1300 × 25 mm','名义焦距 2100 mm','采光面积 1.327 m² / 36 圈刻环'], '菲涅尔环带把沿法线入射的平行光汇聚到下方焦点；透镜嵌在上平台圆环框内，与环共面。',V(5,.9,0),platform);

  const bed=new THREE.Group();
  const bedSteel=new THREE.MeshStandardMaterial({color:0x3A4048,metalness:.7,roughness:.45});
  const powder=new THREE.MeshStandardMaterial({color:0x9AA3AD,roughness:1,metalness:0});
  mesh(bed,new THREE.CylinderGeometry(1.6,1.6,1.0,48),bedSteel,V(0,.5,0));
  mesh(bed,new THREE.CylinderGeometry(1.55,1.55,.1,48),powder,V(0,.95,0));
  mesh(bed,new THREE.CylinderGeometry(1.8,1.8,.12,48),bedSteel,V(0,.06,0));
  const lip=mesh(bed,new THREE.TorusGeometry(1.6,.05,8,64),MAT.silver,V(0,1.0,0));lip.rotation.x=Math.PI/2;
  const targetMat=new THREE.MeshBasicMaterial({color:0x5fe3ff,transparent:true,opacity:.8,toneMapped:false});
  const mark=mesh(bed,new THREE.TorusGeometry(.3,.02,6,40),targetMat,V(0,1.02,0));mark.rotation.x=Math.PI/2;
  beam(bed,V(-.4,1.02,0),V(.4,1.02,0),.015,targetMat);beam(bed,V(0,1.02,-.4),V(0,1.02,.4),.015,targetMat);
  add('bed','加热料床',bed,['料床 Ø320 × 100 mm','TC-1C 粉层厚 5 mm','目标 (0,0,100) mm'], '固定料床承接聚光热量，准星标示焦点目标。',V(1.5,1.6,0));

  /* 光路：锥面半径收在环孔内侧，起点落在透镜面，避免与圆环框/镜面穿插。 */
  const coneMode=new URLSearchParams(location.search).get('cone');
  const cone=new THREE.Mesh(new THREE.CylinderGeometry(6.15,0,21,72,1,true),new THREE.MeshBasicMaterial({
    color:0x9FE8FF,transparent:true,opacity:coneMode==='full'?.18:.07,
    depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,toneMapped:false
  }));cone.renderOrder=3;root.add(cone);
  // Low radiance in linear space keeps the .07 additive surface a hint of light after OutputPass.
  cone.material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','outgoingLight *= 0.12;\n#include <opaque_fragment>');};
  const rayMaterial=new THREE.LineBasicMaterial({color:0xFFD7A0,transparent:true,opacity:.2,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false});
  const RAY_COUNT=6;
  const rays=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(RAY_COUNT*6),3)),rayMaterial);
  rays.renderOrder=4;root.add(rays);
  const focus=new THREE.Group();root.add(focus);
  const spotMat=new THREE.MeshBasicMaterial({color:0xddffff,toneMapped:false});
  mesh(focus,new THREE.SphereGeometry(.045,12,8),spotMat);
  const haloMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,
    uniforms:{color:{value:new THREE.Color(0x5fe3ff)}},
    vertexShader:'varying vec2 p;void main(){p=uv*2.-1.;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'uniform vec3 color;varying vec2 p;void main(){float a=pow(max(0.,1.-length(p)),3.);gl_FragColor=vec4(color,a*.75);}'
  });
  const halo=mesh(focus,new THREE.PlaneGeometry(.62,.62),haloMat);halo.rotation.x=-Math.PI/2;
  const coneEnabled=new URLSearchParams(location.search).get('cone')!=='0';

  /* 电动缸：外筒 + 两道端环 + 活塞杆 + 杆端球头，不再堆叠装饰环/线缆。 */
  const cylinders = BASE_ANCHORS.map((_, i) => {
    const g = new THREE.Group(), body = new THREE.Group(), piston = new THREE.Group();
    g.add(body, piston);
    const outerLength = 15.5;
    mesh(body, new THREE.CylinderGeometry(.525, .525, outerLength, 32), MAT.silver, V(0, .35 + outerLength / 2, 0));
    [.35, 15.85].forEach(y => mesh(body, new THREE.CylinderGeometry(.56, .56, .19, 24), MAT.rubber, V(0, y, 0)));
    const rod = mesh(piston, new THREE.CylinderGeometry(.31, .31, 1, 24), MAT.chrome);
    const end = mesh(piston, new THREE.SphereGeometry(.24, 16, 10), MAT.chrome);
    const part = add(`cylinder-${i}`, `电动缸 ${i + 1}`, g, ['外筒 Ø105 × 1550 mm', '内杆 Ø62 mm', '杆长 1703–2903 mm / 行程 1200 mm'], '银色外筒长度固定，内杆随上下铰点距离伸缩。拆解时外筒与内杆沿各自缸轴反向拉开。', V(i === 0 ? -.9 : .9, 2.3, .2), root, i < 2);
    return { g, body, piston, rod, end, part };
  });
  const neutral = inverseKinematics(ZERO_POSE);
  const conversion = new THREE.Matrix4().makeRotationX(-Math.PI / 2), conversionInverse = conversion.clone().invert();
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const guides = [], guidePoint = new THREE.Vector3();
  const guideGroup = new THREE.Group(); guideGroup.name = 'explode-guides'; root.add(guideGroup);
  const guideMaterial = new THREE.LineDashedMaterial({
    color: 0x5fe3ff, transparent: true, opacity: 0, depthWrite: false, dashSize: .16, gapSize: .12,
  });
  function addGuide(obj, anchor = V(0, 0, 0)) {
    const assembly = root.worldToLocal(obj.localToWorld(anchor.clone()));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([assembly, assembly]), guideMaterial);
    line.visible = false; line.userData.guideFor = obj.uuid; guideGroup.add(line);
    guides.push({ obj, anchor, assembly, line });
  }

  function update(pose = ZERO_POSE, explode = 0) {
    const ik = inverseKinematics(pose);
    const e = 1 - Math.pow(1 - explode, 3);
    base.position.y = weights.position.y = -2.5 * e;
    lower.position.y = -2.5 * e; upper.position.y = 5.2 * e;
    matrix.set(...ik.rotation.slice(0, 3), 0, ...ik.rotation.slice(3, 6), 0, ...ik.rotation.slice(6, 9), 0, 0, 0, 0, 1);
    matrix.premultiply(conversion).multiply(conversionInverse); rotation.setFromRotationMatrix(matrix);
    platform.position.copy(toScene(ik.translation)).add(V(0, 5.2 * e, 0)); platform.quaternion.copy(rotation);
    lens.position.y = 3.6 * e;
    cylinders.forEach((c, i) => {
      const b = toScene(BASE_ANCHORS[i]), q = toScene(ik.upper[i]);
      const vector = q.clone().sub(b), length = ik.lengths[i] / 100;
      c.g.position.copy(b);
      c.g.quaternion.setFromUnitVectors(yAxis, vector.normalize());
      // 组的局部 Y 就是缸轴；上下两段只沿该轴反向拉开，不叠加径向漂移。
      c.body.position.y = -1.0 * e; c.piston.position.y = 2.8 * e;
      c.part.labelPos.y = 8.0 - e;
      const rodStart = 15.6, rodEnd = length - .25;
      c.rod.position.y = (rodStart + rodEnd) / 2; c.rod.scale.y = rodEnd - rodStart;
      c.end.position.y = length - .45;
      lowerHinges[i].position.copy(b).add(V(0, -.06, 0));
      lowerHinges[i].rotation.y = Math.atan2(q.x - b.x, q.z - b.z);
      // 上铰链挂在圆环框下方，环上表面保持干净。
      upperHinges[i].position.copy(q).add(V(0, -.5, 0).applyQuaternion(rotation));
      upperHinges[i].quaternion.copy(rotation).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI));
    });
    const upperPart = parts.find(p => p.id === 'upper');
    upperPart.labelPos.copy(toScene(ik.upper[1])).add(V(.5, 0, .6));
    const optics=opticalState(ik), c=toScene(optics.lens), f=toScene(optics.focus);
    cone.position.copy(c).add(f).multiplyScalar(.5);
    cone.quaternion.setFromUnitVectors(yAxis,c.clone().sub(f).normalize());
    cone.visible=coneEnabled && explode<.0001;
    rays.visible=cone.visible;
    const rayPositions=rays.geometry.attributes.position;
    for(let i=0;i<RAY_COUNT;i++){
      const a=i*Math.PI*2/RAY_COUNT, rimPoint=V(6.1*Math.cos(a),0,6.1*Math.sin(a)).applyQuaternion(rotation).add(c);
      rayPositions.setXYZ(i*2,rimPoint.x,rimPoint.y,rimPoint.z);rayPositions.setXYZ(i*2+1,f.x,f.y,f.z);
    }
    rayPositions.needsUpdate=true;rays.geometry.computeBoundingSphere();
    focus.position.copy(f);focus.visible=explode<.0001;
    const locked=optics.errorMm<2;
    spotMat.color.setHex(locked?0xddffff:0xffb05c);haloMat.uniforms.color.value.setHex(locked?0x5fe3ff:0xffb05c);
    guideMaterial.opacity = .22 * e;
    guideGroup.visible = explode > .0001;
    if (guideGroup.visible) {
      root.updateMatrixWorld(true);
      guides.forEach(({ obj, anchor, assembly, line }) => {
        root.worldToLocal(guidePoint.copy(anchor).applyMatrix4(obj.matrixWorld));
        line.visible = guidePoint.distanceToSquared(assembly) > .000001;
        const positions = line.geometry.attributes.position;
        positions.setXYZ(0, assembly.x, assembly.y, assembly.z);
        positions.setXYZ(1, guidePoint.x, guidePoint.y, guidePoint.z);
        positions.needsUpdate = true;
        line.computeLineDistances(); line.geometry.computeBoundingSphere();
      });
    }
    return { ...ik, optics };
  }
  update();
  root.updateMatrixWorld(true);
  addGuide(base); addGuide(weights);
  cylinders.forEach(c=>{addGuide(c.body,V(0,5,0));addGuide(c.piston,V(0,15,0));});
  lowerHinges.forEach(h => addGuide(h, V(0, .25, 0)));
  upperHinges.forEach(h => addGuide(h, V(0, .25, 0)));
  addGuide(platform, V(0, .25, 0)); addGuide(lens, V(0, .3, 0));
  return { root, parts, update, cylinders, platform, neutral };
}

export const DEFAULT_INFO = { title: '六轴调姿 · 太阳聚光', desc: '六轴调节透镜姿态，光锥汇聚至地面料床。自由运动时实时显示焦点偏差。', spec: ['Ø1300 mm PMMA', '焦距 2100 mm', 'TC-1C 模拟月壤'] };
