// Cross-version unit-test runner: lists test/unit/*.test.mjs and runs them with `node --test <files>`
// (directory/glob arguments behave differently between Node 20, 22 and 24, explicit files work everywhere).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).filter((f) => !only.length || only.some((o) => f.includes(o))).sort().map((f) => path.join(dir, f));
// stripTypeScriptTypes (mock-api test) prints an ExperimentalWarning on Node 22/24 — noise in the report
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
