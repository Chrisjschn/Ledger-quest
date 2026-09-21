// Shared post-processing for the OSM base map: drop polygons too small to read.
export function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    a += x1 * kx * y2 * ky - x2 * kx * y1 * ky;
  }
  return Math.abs(a) / 2;
}
export function featureAreaM2(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return ringAreaM2(g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, p) => s + ringAreaM2(p[0]), 0);
  return 0;
}
export function pruneBasemap(bm, { minWater = 2500, minPark = 6000 } = {}) {
  const L = bm.layers;
  L.water.features = L.water.features.filter((f) => featureAreaM2(f) >= minWater);
  L.parks.features = L.parks.features.filter((f) => featureAreaM2(f) >= minPark);
  return bm;
}
