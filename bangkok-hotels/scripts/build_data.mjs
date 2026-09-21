// Wraps JSON data files as plain scripts so the app never needs fetch()
// (works from file://, GitHub Pages and a strict CSP alike).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const hotels = read('data/hotels.json');
fs.writeFileSync(path.join(ROOT, 'data/hotels.js'), `// Generated from data/hotels.json by scripts/build_data.mjs — edit the JSON, then rerun.\nwindow.BKK_HOTELS = ${JSON.stringify(hotels)};\n`);
console.log(`hotels.js: ${hotels.hotels.length} hotels`);

let credits = { photos: {} };
try { credits = read('photos/credits.json'); } catch { /* no photos yet */ }
fs.writeFileSync(path.join(ROOT, 'data/photos.js'), `// Generated from photos/credits.json by scripts/build_data.mjs.\nwindow.BKK_PHOTOS = ${JSON.stringify(credits.photos || {})};\n`);
console.log(`photos.js: ${Object.keys(credits.photos || {}).length} photos`);
