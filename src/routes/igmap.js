// igMap — 월드(지도). 레벨·영상·라이브·상점 콘텐츠를 실제 위경도(geo)로 지도에 핀으로 모은다.
// 프론트는 무료 지도 타일(OpenStreetMap/OpenFreeMap)에 이 핀들을 올린다.
// geo가 있는 레코드만 반환(없으면 bbox 필터에 걸리지 않음). dot-path 필터(geo.lat/geo.lng) 사용.
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { optionalUser } from '../middleware/auth.js';

const router = Router();
const SRC = {
  level: { coll: 'levels', title: (d) => d.title, extra: (d) => ({ genre: d.genre, plays: d.plays | 0 }) },
  vod: { coll: 'vod', title: (d) => d.title, extra: (d) => ({ vkind: d.kind, views: d.views | 0 }) },
  live: { coll: 'live_sessions', title: (d) => d.title, extra: (d) => ({ status: d.status, watching: d.watching | 0 }), onlyLive: true },
  store: { coll: 'catalog', title: (d) => d.title, extra: (d) => ({ ckind: d.kind, price: d.price | 0, access: d.access }) },
};

// GET /pins?minLat&maxLat&minLng&maxLng&kinds=level,vod,live,store&limit=
router.get('/pins', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const minLat = +req.query.minLat, maxLat = +req.query.maxLat, minLng = +req.query.minLng, maxLng = +req.query.maxLng;
    const hasBbox = [minLat, maxLat, minLng, maxLng].every(Number.isFinite);
    const kinds = (req.query.kinds ? String(req.query.kinds).split(',') : Object.keys(SRC)).filter((k) => SRC[k]);
    const limit = Math.min(1000, parseInt(req.query.limit || '400', 10));
    const pins = [];
    for (const k of kinds) {
      const s = SRC[k];
      const filters = hasBbox ? [['geo.lat', 'gte', minLat], ['geo.lat', 'lte', maxLat], ['geo.lng', 'gte', minLng], ['geo.lng', 'lte', maxLng]] : [['geo.lat', 'gte', -90]];
      const rows = await repo.queryRecords(pid, s.coll, { limit: 500, filters, sort: 'created_at:desc' });
      for (const r of rows) {
        const d = r.data || {}; if (!d.geo || !Number.isFinite(+d.geo.lat)) continue;
        if (s.onlyLive && d.status === 'ended') continue;
        pins.push({ kind: k, id: r.doc_id, title: s.title(d) || '', lat: +d.geo.lat, lng: +d.geo.lng, label: d.geo.label || '', creator: d.creator || d.hostName || '', cover: d.cover || null, ...s.extra(d) });
      }
    }
    res.json({ pins: pins.slice(0, limit) });
  } catch (e) { next(e); }
});

export default router;
