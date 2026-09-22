// Fails when messages/en.json and messages/id.json do not have identical key sets,
// or when any value is empty. Run with `npm run i18n:check`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages');
const load = (l) => JSON.parse(readFileSync(join(root, `${l}.json`), 'utf8'));

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const en = flatten(load('en'));
const id = flatten(load('id'));
const problems = [];
for (const k of en.keys()) if (!id.has(k)) problems.push(`missing in id.json: ${k}`);
for (const k of id.keys()) if (!en.has(k)) problems.push(`missing in en.json: ${k}`);
for (const [name, map] of [['en', en], ['id', id]])
  for (const [k, v] of map) if (typeof v !== 'string' || v.trim() === '') problems.push(`empty or non-string in ${name}.json: ${k}`);

const banned = /\b(insurance|policy|policies|premium|claim|claims|asuransi|polis|premi|klaim)\b/i;
for (const [name, map] of [['en', en], ['id', id]])
  for (const [k, v] of map)
    if (typeof v === 'string' && banned.test(v)) problems.push(`banned word in ${name}.json: ${k}`);

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\ni18n check failed: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`i18n check passed: ${en.size} keys in both locales`);
