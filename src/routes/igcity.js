// igCity — 실제 도시(서울 동네 등)의 지형을 "땅만 복셀화"해 월드 레벨로 올린다.
// OpenStreetMap(OSM, 무료) 건물 윤곽·높이·도로를 Overpass로 가져와 블록 그리드로 래스터화.
// 복셀로 뭉개는 건 지형 베이스뿐 — 그 위에 리얼 메시(GLB)를 얹는 전제. 캐릭터/에셋은 복셀 아님.
//   voxelizeCity(features, opts) 는 순수 함수(네트워크 0) → 오프라인 테스트 가능.
//   POST /voxelize : features 직접 받아 레벨 생성(오프라인/배치용).
//   POST /build    : place/bbox로 Overpass 호출 → voxelize → 레벨 생성(실행 환경의 인터넷 사용).
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';

const router = Router();
const MAX_VOX = 20000;     // 레벨당 복셀 상한(서버 저장 한도와 동일)
const BUILDING = 2;        // 건물 = 벽 블록(t=2)
const GROUND = 1;          // 지면(t=1)
const ROAD_C = 0x3a3f46;   // 도로 색
const GRASS_C = 0x3f7a4b;  // 공터/지면 색
const GOAL = 4;

// 점-다각형 포함 판정(ray casting). poly=[[x,z]...]
function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

// features: { bbox:{s,w,n,e}, buildings:[{geometry:[{lat,lon}...], height, levels}], roads:[{geometry:[...]}] }
// opts: { cell(미터/블록, 기본 4), name, maxSpan(한 변 최대 칸, 기본 200) }
// 반환: { voxels, spawn, geo, size:{gx,gz}, cell, count }
export function voxelizeCity(features, opts = {}) {
  const bb = features.bbox;
  if (!bb || ![bb.s, bb.w, bb.n, bb.e].every(Number.isFinite)) throw new Error('bbox 필요');
  let cell = Math.max(1, opts.cell || 4);
  const maxSpan = Math.max(20, opts.maxSpan || 200);
  const latMid = (bb.s + bb.n) / 2;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(latMid * Math.PI / 180);
  // 지도 좌표 → 미터(좌상단 기준) → 셀. x=동(경도+), z=남(위도-)
  const widthM = (bb.e - bb.w) * mPerLng, heightM = (bb.n - bb.s) * mPerLat;
  // 셀이 너무 많으면 cell 자동 확대(한 변 maxSpan 이내)
  cell = Math.max(cell, widthM / maxSpan, heightM / maxSpan);
  const gx = Math.max(1, Math.round(widthM / cell)), gz = Math.max(1, Math.round(heightM / cell));
  function toCell(lat, lon) { return [Math.round((lon - bb.w) * mPerLng / cell), Math.round((bb.n - lat) * mPerLat / cell)]; }

  const solid = {}; // "x,y,z" → 중복 방지
  const ground = {}; // "x,z" → 지면 vox 객체(도로 색 교체용)
  const vox = [];
  function put(x, y, z, t, c) { const k = x + ',' + y + ',' + z; if (solid[k]) return; solid[k] = 1; const o = { x, y, z, t }; if (c != null) o.c = c; vox.push(o); if (y === 0) ground[x + ',' + z] = o; return o; }

  // 1) 지면 한 겹
  for (let x = 0; x < gx; x++) for (let z = 0; z < gz; z++) put(x, 0, z, GROUND, GRASS_C);
  // 2) 도로: 지면 셀 색만 교체(선을 셀로 래스터화)
  (features.roads || []).forEach((r) => {
    const g = r.geometry || []; for (let i = 0; i + 1 < g.length; i++) {
      const a = toCell(g[i].lat, g[i].lon), b = toCell(g[i + 1].lat, g[i + 1].lon);
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) || 1;
      for (let s = 0; s <= steps; s++) { const x = Math.round(a[0] + (b[0] - a[0]) * s / steps), z = Math.round(a[1] + (b[1] - a[1]) * s / steps);
        const gc = ground[x + ',' + z]; if (gc) gc.c = ROAD_C; }
    }
  });
  // 3) 건물: 폴리곤 래스터화 + 높이만큼 쌓기
  (features.buildings || []).forEach((bd, bi) => {
    const g = bd.geometry || []; if (g.length < 3) return;
    const poly = g.map((p) => toCell(p.lat, p.lon));
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    poly.forEach((p) => { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < minz) minz = p[1]; if (p[1] > maxz) maxz = p[1]; });
    minx = Math.max(0, minx); maxx = Math.min(gx - 1, maxx); minz = Math.max(0, minz); maxz = Math.min(gz - 1, maxz);
    const hM = Number(bd.height) || (Number(bd.levels) || 2) * 3; // 미터
    const h = Math.max(1, Math.min(24, Math.round(hM / cell)));
    const shade = 0x8a93a0 + (bi % 5) * 0x060606; // 건물별 회색조 약간 변주
    for (let x = minx; x <= maxx; x++) for (let z = minz; z <= maxz; z++) {
      if (!inPoly(x + 0.5, z + 0.5, poly)) continue;
      for (let y = 1; y <= h; y++) put(x, y, z, BUILDING, shade);
      if (vox.length > MAX_VOX) return;
    }
  });

  // 4) 스폰(중앙 빈 지면 위) + 골(한 구석 랜드마크)
  const spawn = { x: Math.floor(gx / 2), y: 1, z: Math.floor(gz / 2) };
  // 골 블록 1개(검증 통과 + 탐험 목표). 비어있는 모서리에.
  put(gx - 1, 1, gz - 1, GOAL, null);

  // 상한 넘으면 잘라서 안전
  const voxels = vox.slice(0, MAX_VOX);
  return { voxels, spawn, geo: { lat: latMid, lng: (bb.w + bb.e) / 2, label: opts.name || '' }, size: { gx, gz }, cell, count: voxels.length };
}

// 리얼 모드: 건물 footprint를 미터 스케일 3D 메시(extrude)로, 지면은 평면 프롭으로.
// 복셀로 뭉개지 않는 저폴리 실제 도시. igPlay의 buildProps(verts/faces/pos/size)로 렌더·충돌.
// 반환: { voxels, props, spawn, geo, size, cell:1, count }
export function realCity(features, opts = {}) {
  const bb = features.bbox;
  if (!bb || ![bb.s, bb.w, bb.n, bb.e].every(Number.isFinite)) throw new Error('bbox 필요');
  const latMid = (bb.s + bb.n) / 2;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(latMid * Math.PI / 180);
  const widthM = Math.max(4, (bb.e - bb.w) * mPerLng), heightM = Math.max(4, (bb.n - bb.s) * mPerLat);
  const toM = (lat, lon) => [(lon - bb.w) * mPerLng, (bb.n - lat) * mPerLat]; // [x,z] 미터
  const maxBuildings = Math.max(10, opts.maxBuildings || 120);
  const props = [];

  // 지면: 얇은 큰 박스 프롭(플레이어가 그 위를 걷는다)
  function boxProp(cx, cy, cz, w, h, d, color) {
    const hw = w / 2, hd = d / 2;
    const verts = [[-hw, 0, -hd], [hw, 0, -hd], [hw, h, -hd], [-hw, h, -hd], [-hw, 0, hd], [hw, 0, hd], [hw, h, hd], [-hw, h, hd]];
    const quads = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    const faces = []; quads.forEach((q) => { faces.push(q[0], q[1], q[2], q[0], q[2], q[3]); });
    props.push({ verts, faces, pos: { x: cx, y: cy, z: cz }, scale: 1, color, size: { w, h, d }, collide: true });
  }
  boxProp(widthM / 2, 0, heightM / 2, widthM, 0.6, heightM, 0x37415a); // 지면

  // 건물: footprint extrude
  let built = 0;
  (features.buildings || []).forEach((bd, bi) => {
    if (built >= maxBuildings) return;
    const g = bd.geometry || []; if (g.length < 4) return;
    // 마지막 점이 첫 점과 같으면 제거(폐곡선)
    let pts = g.map((p) => toM(p.lat, p.lon));
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    const n = pts.length; if (n < 3) return;
    let cx = 0, cz = 0, minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    pts.forEach((p) => { cx += p[0]; cz += p[1]; if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < minz) minz = p[1]; if (p[1] > maxz) maxz = p[1]; });
    cx /= n; cz /= n;
    const hM = Math.max(3, Math.min(240, Number(bd.height) || (Number(bd.levels) || 3) * 3));
    const local = pts.map((p) => [p[0] - cx, p[1] - cz]); // 중심 기준 로컬
    const verts = [];
    for (let i = 0; i < n; i++) verts.push([local[i][0], 0, local[i][1]]);     // bottom 0..n-1
    for (let i = 0; i < n; i++) verts.push([local[i][0], hM, local[i][1]]);    // top n..2n-1
    const faces = [];
    for (let i = 1; i < n - 1; i++) { faces.push(0, i + 1, i); }               // bottom fan
    for (let i = 1; i < n - 1; i++) { faces.push(n, n + i, n + i + 1); }       // top fan
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push(i, j, n + j, i, n + j, n + i); } // sides
    // 도시다운 건물 색 팔레트(콘크리트/유리블루/벽돌/화이트/다크글래스) — 높이에 따라 고층은 유리톤
    const PAL = [0x6b7280, 0x8a93a0, 0x9aa7b4, 0x5f7f9a, 0x7d6a5b, 0xb7bcc4, 0x4a5a6e, 0xa98f74];
    const color = hM > 70 ? [0x3f5a7a, 0x4a6b8a, 0x5c6f8c][bi % 3] : PAL[bi % PAL.length];
    props.push({ verts, faces, pos: { x: cx, y: 0.3, z: cz }, scale: 1, color, size: { w: maxx - minx, h: hM, d: maxz - minz }, collide: true });
    built++;
  });

  // 검증·플레이용 최소 복셀: ground 더미 1 + goal 1 (지면은 메시라 안 보이는 구석에)
  const spawn = { x: Math.round(widthM / 2), y: 1, z: Math.round(heightM / 2) };
  const voxels = [{ x: 0, y: 0, z: 0, t: 1 }, { x: Math.round(widthM) - 2, y: 1, z: Math.round(heightM) - 2, t: 4 }];
  return { voxels, props, spawn, geo: { lat: latMid, lng: (bb.w + bb.e) / 2, label: opts.name || '' }, size: { w: Math.round(widthM), d: Math.round(heightM) }, cell: 1, count: voxels.length, buildings: built };
}

// Overpass로 bbox 내 건물/도로 가져오기(실행 환경의 인터넷 사용)
async function fetchOSM(bb) {
  const q = `[out:json][timeout:30];(way["building"](${bb.s},${bb.w},${bb.n},${bb.e});way["highway"](${bb.s},${bb.w},${bb.n},${bb.e}););out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: q });
  if (!res.ok) throw new Error('overpass_' + res.status);
  const data = await res.json();
  const buildings = [], roads = [];
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    if (el.tags && el.tags.building) buildings.push({ geometry: el.geometry, height: el.tags.height, levels: el.tags['building:levels'] });
    else if (el.tags && el.tags.highway) roads.push({ geometry: el.geometry });
  }
  return { bbox: bb, buildings, roads };
}

// 레벨 저장(igplay 'levels' 컬렉션에 직접 생성)
async function saveLevel(pid, uid, name, built, creatorName) {
  const id = randomId('lv_');
  const data = {
    title: String(name || '복셀 시티').slice(0, 80), creator: creatorName || '복셀 시티',
    genre: '어드벤처', difficulty: '보통', voxels: built.voxels, props: built.props || [], cover: null,
    spawn: built.spawn, desc: 'OSM 지형을 복셀화한 도시 월드입니다.', plays: 0, likes: 0, boostedUntil: 0,
    gateSymbol: null, gateMin: 0, geo: built.geo, source: 'igcity',
  };
  const rec = await getRepo().putRecord({ project_id: pid, collection: 'levels', doc_id: id, data, owner_id: uid });
  return { id: rec.doc_id, title: data.title, geo: data.geo, count: built.count, size: built.size, cell: built.cell };
}

// 오프라인/배치: features 직접 → 레벨
router.post('/voxelize', requireUser, async (req, res, next) => {
  try {
    const { features, name, cell, maxSpan, mode } = req.body || {};
    if (!features || !features.bbox) return res.status(400).json({ error: 'no_features', message: 'bbox 포함 features가 필요합니다.' });
    const built = mode === 'real' ? realCity(features, { name }) : voxelizeCity(features, { name, cell, maxSpan });
    const out = await saveLevel(req.project.id, req.user.uid, name, built, req.user.name);
    broadcast(req.project.id, 'igplay:levels', { type: 'level_new', id: out.id, title: out.title, ts: Date.now() });
    res.status(201).json({ level: out });
  } catch (e) { next(e); }
});
// 실시간: 장소/bbox → OSM → 복셀 레벨
router.post('/build', requireUser, async (req, res, next) => {
  try {
    const { bbox, name, cell, maxSpan, mode } = req.body || {};
    if (!bbox || !['s', 'w', 'n', 'e'].every((k) => Number.isFinite(+bbox[k]))) return res.status(400).json({ error: 'bad_bbox', message: 's,w,n,e 좌표가 필요합니다.' });
    const bb = { s: +bbox.s, w: +bbox.w, n: +bbox.n, e: +bbox.e };
    // 너무 넓은 영역 방지(약 1.2km 이하 권장)
    if ((bb.n - bb.s) > 0.02 || (bb.e - bb.w) > 0.02) return res.status(400).json({ error: 'too_wide', message: '영역이 너무 넓습니다. 더 좁혀 주세요(약 1km 이하).' });
    let features;
    try { features = await fetchOSM(bb); }
    catch (e) { return res.status(502).json({ error: 'osm_fail', message: 'OSM 데이터를 가져오지 못했습니다(인터넷/Overpass 상태 확인). ' + e.message }); }
    if (!features.buildings.length && !features.roads.length) return res.status(404).json({ error: 'empty_area', message: '이 영역에 건물·도로 데이터가 없습니다.' });
    const built = mode === 'real' ? realCity(features, { name }) : voxelizeCity(features, { name, cell, maxSpan });
    const out = await saveLevel(req.project.id, req.user.uid, name, built, req.user.name);
    broadcast(req.project.id, 'igplay:levels', { type: 'level_new', id: out.id, title: out.title, ts: Date.now() });
    res.status(201).json({ level: out, buildings: features.buildings.length, roads: features.roads.length });
  } catch (e) { next(e); }
});

export default router;
