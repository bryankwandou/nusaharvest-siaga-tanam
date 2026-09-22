#!/usr/bin/env node
// Apply db/migrations/*.sql in lexical order, once each, inside a transaction per file.
// Usage: DATABASE_URL=postgres://... node db/migrate.mjs   (run from repo root; resolves pg from web/node_modules)
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'web', 'package.json'));
const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const client = new Client({
  connectionString: url,
  ssl: (process.env.DATABASE_SSL ?? 'false').toLowerCase() === 'true' ? { rejectUnauthorized: true } : undefined,
});
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  const done = new Map((await client.query('select name, sha256 from schema_migrations')).rows.map((r) => [r.name, r.sha256]));
  const dir = join(here, 'migrations');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    if (done.has(name)) {
      if (done.get(name) !== sha) console.warn(`warning: ${name} changed after it was applied; write a new migration instead`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name, sha256) values ($1, $2)', [name, sha]);
      await client.query('commit');
      console.log(`applied ${name}`);
    } catch (e) {
      await client.query('rollback');
      console.error(`failed ${name}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
