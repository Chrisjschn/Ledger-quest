// Produces dist/artifact.html: the same page as index.html, but as the body
// fragment the claude.ai artifact publisher expects (it supplies its own
// doctype/html/head/body skeleton). Everything else is shared verbatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .split('\n').filter((l) => !/<meta (charset|name="viewport")/.test(l)).join('\n');
const body = html.match(/<!-- app:start -->([\s\S]*?)<!-- app:end -->/)[1];
const scripts = html.match(/<!-- app:end -->([\s\S]*?)<\/body>/)[1];
const out = `${head.trim()}\n${body.trim()}\n${scripts.trim()}\n`;
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'artifact.html'), out);
console.log('wrote dist/artifact.html', out.length, 'bytes');
