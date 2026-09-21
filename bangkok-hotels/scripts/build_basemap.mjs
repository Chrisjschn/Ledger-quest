// Builds data/basemap.js — a compact vector base map of central Bangkok from
// OpenStreetMap (via the Overpass API). Runs on GitHub Actions where outbound
// network is unrestricted. Output is a plain script that sets window.BKK_BASEMAP
// so the app works from file://, GitHub Pages, and inside a locked-down CSP.
//
// Usage: node build_basemap.mjs            (writes ../data/basemap.js)
//        BBOX="W,S,E,N" node build_basemap.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import osmtogeojson from 'osmtogeojson';
import bboxClip from '@turf/bbox-clip';
import simplify from '@turf/simplify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_JS = path.join(ROOT, 'data', 'basemap.js');
const OUT_META = path.join(ROOT, 'data', 'basemap.meta.json');
const UA = 'BangkokHotelTracker/1.0 (+https://github.com/Chrisjschn/Ledger-quest; personal trip planner build script)';

// W, S, E, N — central Bangkok: Thonburi riverside → Ekkamai, Sathorn → Chatuchak
const BBOX = (process.env.BBOX || '100.455,13.665,100.645,13.825').split(',').map(Number);
const [W, S, E, N] = BBOX;
const MAX_BYTES = Number(process.env.MAX_BYTES || 1_700_000);

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const QUERY = `
[out:json][timeout:300][bbox:${S},${W},${N},${E}];
(
  way["waterway"~"^(river|canal)$"];
  way["natural"="water"];
  relation["natural"="water"];
  way["waterway"="riverbank"];
  relation["waterway"="riverbank"];
  way["leisure"~"^(park|garden|golf_course)$"];
  relation["leisure"~"^(park|garden|golf_course)$"];
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"];
  relation["route"~"^(light_rail|subway|monorail)$"];
  relation["route"="train"]["name"~"Airport Rail Link|Red Line",i];
  node["railway"="station"];
);
out geom;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass() {
  const fixture = process.env.OVERPASS_FIXTURE;
  if (fixture) return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  let lastErr;
  for (const url of MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Overpass: ${url} (attempt ${attempt})`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(QUERY),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const json = JSON.parse(text);
        if (!json.elements || json.elements.length < 100) throw new Error(`suspiciously small result (${json.elements?.length ?? 0} elements)`);
        console.log(`  ok: ${json.elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB`);
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`  failed: ${e.message}`);
        await sleep(8000 * attempt);
      }
    }
  }
  throw lastErr || new Error('Overpass failed');
}

const round = (n) => Math.round(n * 1e5) / 1e5;
function roundCoords(c) {
  if (typeof c[0] === 'number') return [round(c[0]), round(c[1])];
  return c.map(roundCoords);
}
function dedupe(c) {
  if (typeof c[0] === 'number') return c;
  if (typeof c[0][0] === 'number') {
    const out = [];
    for (const p of c) if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
    return out;
  }
  return c.map(dedupe);
}
function isEmpty(g) {
  if (!g) return true;
  const c = g.coordinates;
  if (g.type === 'LineString') return c.length < 2;
  if (g.type === 'MultiLineString') return !c.some((l) => l.length >= 2);
  if (g.type === 'Polygon') return !c.length || c[0].length < 4;
  if (g.type === 'MultiPolygon') return !c.some((p) => p.length && p[0].length >= 4);
  return false;
}
function clean(g) {
  if (!g) return null;
  if (g.type === 'MultiLineString') g.coordinates = g.coordinates.filter((l) => l.length >= 2);
  if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.filter((p) => p.length && p[0].length >= 4);
  if (g.type === 'Polygon' && (!g.coordinates.length || g.coordinates[0].length < 4)) return null;
  return isEmpty(g) ? null : g;
}

function prep(feature, tolerance) {
  let f = feature;
  try { f = bboxClip(f, BBOX); } catch { return null; }
  if (!f || isEmpty(f.geometry)) return null;
  if (tolerance > 0) {
    try { f = simplify(f, { tolerance, highQuality: false, mutate: true }); } catch { /* keep unsimplified */ }
  }
  f.geometry.coordinates = dedupe(roundCoords(f.geometry.coordinates));
  const g = clean(f.geometry);
  if (!g) return null;
  return { type: 'Feature', properties: {}, geometry: g };
}

const nameOf = (t) => t['name:en'] || t.name_en || t['int_name'] || t.name || undefined;
const ROAD_CLASS = { motorway: 'm', trunk: 't', primary: 'p', secondary: 's', tertiary: 'r' };

function build(osm, { dropTertiary = false, tolScale = 1 } = {}) {
  const gj = osmtogeojson(osm, { flatProperties: true });
  const layers = { water: [], waterlines: [], parks: [], roads: [], rail: [], stations: [] };
  const seenStations = new Set();

  for (const feat of gj.features) {
    const t = feat.properties || {};
    const gt = feat.geometry?.type;
    const isPoly = gt === 'Polygon' || gt === 'MultiPolygon';
    const isLine = gt === 'LineString' || gt === 'MultiLineString';

    if (gt === 'Point' && t.railway === 'station') {
      const st = t.station || '';
      const net = t.network || t.operator || '';
      const isMetro = /subway|light_rail|monorail/.test(st) || /BTS|MRT|Airport Rail|ARL|SRT Red|Red Line/i.test(net) || /BTS|MRT/i.test(t.name || '');
      if (!isMetro) continue;
      const n = nameOf(t);
      if (!n) continue;
      const key = n + '|' + (t.ref || '');
      if (seenStations.has(key)) continue;
      seenStations.add(key);
      const [lng, lat] = feat.geometry.coordinates;
      if (lng < W || lng > E || lat < S || lat > N) continue;
      layers.stations.push({ type: 'Feature', properties: { n, net: net || undefined, ref: t.ref || undefined, st: st || undefined }, geometry: { type: 'Point', coordinates: [round(lng), round(lat)] } });
      continue;
    }

    if (isPoly && (t.natural === 'water' || t.waterway === 'riverbank' || t.water)) {
      const f = prep(feat, 0.00003 * tolScale);
      if (f) { f.properties = { n: nameOf(t) }; layers.water.push(f); }
      continue;
    }
    if (isLine && (t.waterway === 'river' || t.waterway === 'canal')) {
      if (t.waterway === 'canal' && !t.name && !t['name:en']) continue;
      const f = prep(feat, 0.00006 * tolScale);
      if (f) { f.properties = { k: t.waterway, n: nameOf(t) }; layers.waterlines.push(f); }
      continue;
    }
    if (isPoly && t.leisure) {
      const f = prep(feat, 0.00004 * tolScale);
      if (f) { f.properties = { k: t.leisure === 'golf_course' ? 'golf' : 'park', n: nameOf(t) }; layers.parks.push(f); }
      continue;
    }
    if (isLine && t.highway && ROAD_CLASS[t.highway]) {
      if (dropTertiary && t.highway === 'tertiary') continue;
      const tol = (t.highway === 'tertiary' ? 0.00008 : 0.00005) * tolScale;
      const f = prep(feat, tol);
      if (f) {
        const h = ROAD_CLASS[t.highway];
        const p = { h };
        if (h !== 'r') p.n = nameOf(t);
        f.properties = p;
        layers.roads.push(f);
      }
      continue;
    }
    if (isLine && t.route && /light_rail|subway|monorail|train/.test(t.route)) {
      const f = prep(feat, 0.00004 * tolScale);
      if (f) {
        f.properties = { r: t.route, n: nameOf(t), c: t.colour || undefined, ref: t.ref || undefined, net: t.network || undefined };
        layers.rail.push(f);
      }
      continue;
    }
  }

  // Merge the two directions of each rail route into one feature per name/colour.
  const railByKey = new Map();
  for (const f of layers.rail) {
    const key = (f.properties.n || f.properties.ref || '?') + '|' + (f.properties.c || '');
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (!railByKey.has(key)) railByKey.set(key, { type: 'Feature', properties: f.properties, geometry: { type: 'MultiLineString', coordinates: [] } });
    railByKey.get(key).geometry.coordinates.push(...lines);
  }
  layers.rail = [...railByKey.values()];

  const fc = (arr) => ({ type: 'FeatureCollection', features: arr });
  return {
    bbox: BBOX,
    generated: new Date().toISOString().slice(0, 10),
    attribution: 'Map data © OpenStreetMap contributors (ODbL)',
    layers: {
      water: fc(layers.water), waterlines: fc(layers.waterlines), parks: fc(layers.parks),
      roads: fc(layers.roads), rail: fc(layers.rail), stations: fc(layers.stations),
    },
  };
}

const osm = await fetchOverpass();
let out = build(osm);
let json = JSON.stringify(out);
if (json.length > MAX_BYTES) {
  console.log(`basemap ${json.length} bytes > ${MAX_BYTES}; dropping tertiary roads`);
  out = build(osm, { dropTertiary: true });
  json = JSON.stringify(out);
}
if (json.length > MAX_BYTES) {
  console.log(`basemap ${json.length} bytes > ${MAX_BYTES}; simplifying harder`);
  out = build(osm, { dropTertiary: true, tolScale: 2 });
  json = JSON.stringify(out);
}
fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
fs.writeFileSync(OUT_JS, `// Generated by scripts/build_basemap.mjs — do not edit by hand.\n// ${out.attribution}\nwindow.BKK_BASEMAP = ${json};\n`);
const counts = Object.fromEntries(Object.entries(out.layers).map(([k, v]) => [k, v.features.length]));
fs.writeFileSync(OUT_META, JSON.stringify({ generated: out.generated, bbox: BBOX, bytes: json.length, counts }, null, 2) + '\n');
console.log('wrote', OUT_JS, `${(json.length / 1e6).toFixed(2)} MB`, counts);
