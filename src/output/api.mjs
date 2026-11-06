// Stage 3: generated mock API layer for the cloned Next.js 16 project (app/api/[...route]/route.ts,
// lib/mock-api.ts, mocks/registry.ts, mocks/data/*.json, next.config rewrites, and blueprint table).
import path from 'node:path';
import { readJSON, exists, truncate } from '../util.mjs';

export const MOCK_LIB = `export interface MockEntry {
  id: string;
  method: string;
  host?: string;
  path: string;
  query?: Record<string, string>;
  external?: boolean;
  operation?: string | null;
  status: number;
  contentType: string;
  kind: 'json' | 'html' | 'xml' | 'text';
  body?: unknown;
  text?: string;
}

export interface FindMockOptions {
  operation?: string | null;
  host?: string | null;
}

function normPath(p: string): string {
  const s = String(p || '/').replace(/\\/+/g, '/').replace(/\\/+$/, '');
  return s || '/';
}

export function findMock(
  mocks: MockEntry[],
  method: string,
  reqPath: string,
  searchParams?: URLSearchParams | Record<string, string> | null,
  opts: FindMockOptions = {}
): MockEntry | null {
  const m = String(method || 'GET').toUpperCase();
  const effectiveMethod = m === 'HEAD' ? 'GET' : m;
  const p = normPath(reqPath);
  const wantHost = opts.host ? String(opts.host).toLowerCase() : null;
  const wantOp = opts.operation ? String(opts.operation) : null;

  const params = new Map<string, string>();
  if (searchParams) {
    if (typeof (searchParams as URLSearchParams).entries === 'function') {
      for (const [k, v] of (searchParams as URLSearchParams).entries()) params.set(k, v);
    } else {
      for (const [k, v] of Object.entries(searchParams as Record<string, string>)) params.set(k, String(v));
    }
  }

  const candidates = mocks.filter((e) => {
    if (e.method.toUpperCase() !== effectiveMethod) return false;
    if (wantHost ? (!e.external || String(e.host || '').toLowerCase() !== wantHost) : !!e.external) return false;
    if (normPath(e.path) !== p) return false;
    if (e.operation || wantOp) return e.operation === wantOp;
    return true;
  });

  if (!candidates.length) return null;

  let best: MockEntry | null = null;
  let bestScore = -1;

  for (const c of candidates) {
    const q = c.query || {};
    const keys = Object.keys(q);
    if (keys.length === 0) {
      const score = params.size === 0 ? 100 : 1;
      if (score > bestScore) { bestScore = score; best = c; }
      continue;
    }
    const allMatch = keys.every((k) => params.get(k) === String(q[k]));
    if (allMatch) {
      const score = 10 + keys.length * 10 + (keys.length === params.size ? 50 : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }

  return best;
}

export function mockResponse(entry: MockEntry | null): Response {
  if (!entry) {
    return new Response(JSON.stringify({ error: 'Mock not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const headers: Record<string, string> = {
    'content-type': entry.contentType || (entry.kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'),
    'x-mock-id': entry.id,
  };
  const payload = entry.kind === 'json' ? JSON.stringify(entry.body ?? null) : String(entry.text ?? '');
  return new Response(payload, { status: entry.status || 200, headers });
}

export function mockUrl(url: string, siteOrigin?: string): string {
  const s = String(url || '');
  if (!/^https?:\\/\\//i.test(s)) return s;
  try {
    const u = new URL(s);
    if (siteOrigin && u.origin === new URL(siteOrigin).origin) return u.pathname + u.search;
    return \`/api/__mock/ext/\${u.host}\${u.pathname}\${u.search}\`;
  } catch {
    return s;
  }
}
`;

export const MOCK_ROUTE = `import { MOCKS } from '@/mocks/registry';
import { findMock, mockResponse } from '@/lib/mock-api';

type RouteContext = { params: Promise<{ route?: string[] }> };

async function extractOperation(req: Request, url: URL): Promise<string | null> {
  const qOp = url.searchParams.get('operationName');
  if (qOp) return qOp;
  if (req.method !== 'POST') return null;
  try {
    const body = await req.clone().json();
    const item = Array.isArray(body) ? body[0] : body;
    if (item && typeof item === 'object') {
      if (item.operationName) return String(item.operationName);
      if (typeof item.query === 'string') {
        const m = /(?:query|mutation|subscription)\\s+([A-Za-z_]\\w*)/.exec(item.query);
        if (m) return m[1];
      }
    }
  } catch {}
  return null;
}

async function handle(req: Request, context: RouteContext): Promise<Response> {
  const { route = [] } = await context.params;
  const url = new URL(req.url);
  let host: string | null = null;
  let reqPath = '/api/' + route.join('/');

  if (route[0] === '__mock') {
    if (route[1] === 'ext' && route.length >= 3) {
      host = route[2];
      reqPath = '/' + route.slice(3).join('/');
    } else {
      reqPath = '/' + route.slice(1).join('/');
    }
  }

  const operation = await extractOperation(req, url);
  const hit = findMock(MOCKS, req.method, reqPath, url.searchParams, { host, operation });
  return mockResponse(hit);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
`;

export async function loadApiMocks(outDir) {
  const idxFile = path.join(outDir, 'data', 'api-mocks', 'index.json');
  if (!(await exists(idxFile))) return { count: 0, entries: [], redaction: null };
  const idx = await readJSON(idxFile).catch(() => null);
  if (!idx || !Array.isArray(idx.entries)) return { count: 0, entries: [], redaction: null };
  const entries = [];
  for (const meta of idx.entries) {
    const f = path.join(outDir, meta.file || `data/api-mocks/${meta.id}.json`);
    const full = await readJSON(f).catch(() => null);
    if (full) entries.push(full);
  }
  return { ...idx, count: entries.length, entries };
}

const SAFE_PATH_RE = /^\/[A-Za-z0-9/_.-]+$/;

export function apiProjectFiles(api) {
  const entries = (api && api.entries) || [];
  const files = new Map();
  if (!entries.length) return { files, rewrites: [], count: 0 };

  const imports = [];
  const rows = [];
  const rewritePaths = new Set();

  entries.forEach((e, i) => {
    const varName = `m${i}`;
    const dataFile = `mocks/data/${e.id}.json`;
    const isJson = e.kind === 'json';
    const dataObj = isJson ? { body: e.body ?? null } : { text: String(e.bodyText ?? e.text ?? '') };
    files.set(dataFile, JSON.stringify(dataObj, null, 2) + '\n');
    imports.push(`import ${varName} from './data/${e.id}.json';`);

    const meta = {
      id: e.id,
      method: e.method || 'GET',
      ...(e.external && e.host ? { host: e.host, external: true } : {}),
      path: e.path || '/',
      ...(e.query && Object.keys(e.query).length ? { query: e.query } : {}),
      ...(e.graphql && e.graphql.operationName ? { operation: e.graphql.operationName } : e.operation ? { operation: e.operation } : {}),
      status: e.status || 200,
      contentType: e.contentType || (isJson ? 'application/json' : 'text/plain'),
      kind: e.kind || 'json',
    };
    const metaJson = JSON.stringify(meta).slice(1, -1);
    const prop = isJson ? 'body' : 'text';
    rows.push(`  { ${metaJson}, ${prop}: ${varName}.${prop} },`);

    if (!e.external && e.path && !e.path.startsWith('/api/') && e.path !== '/api' && SAFE_PATH_RE.test(e.path)) {
      rewritePaths.add(e.path);
    }
  });

  const registry = [
    "import type { MockEntry } from '@/lib/mock-api';",
    ...imports,
    '',
    'export const MOCKS: MockEntry[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');

  files.set('mocks/registry.ts', registry);
  files.set('lib/mock-api.ts', MOCK_LIB);
  files.set('app/api/[...route]/route.ts', MOCK_ROUTE);

  const rewrites = [...rewritePaths].sort().map((source) => ({
    source,
    destination: '/api/__mock' + source,
  }));

  return { files, rewrites, count: entries.length };
}

export function nextConfig({ rewrites = [] } = {}) {
  const lines = [
    '/** @type {import("next").NextConfig} */',
    'const nextConfig = {',
    '  images: { unoptimized: true },',
  ];
  if (rewrites && rewrites.length) {
    lines.push('  async rewrites() {', '    return [');
    for (const r of rewrites) {
      lines.push(`      { source: ${JSON.stringify(r.source)}, destination: ${JSON.stringify(r.destination)} },`);
    }
    lines.push('    ];', '  },');
  }
  lines.push('};', '', 'export default nextConfig;', '');
  return lines.join('\n');
}

export function apiTable(api) {
  const entries = (api && api.entries) || [];
  if (!entries.length) return [];
  const head = ['Метод', 'Путь / операция', 'Статус', 'Тип', 'Размер', 'Страницы', 'Файл мока'];
  const rows = entries.slice(0, 80).map((e) => {
    const op = (e.graphql && e.graphql.operationName) || e.operation;
    const q = e.query && Object.keys(e.query).length ? '?' + new URLSearchParams(e.query).toString() : '';
    const p = (e.external && e.host ? `${e.host}` : '') + (e.path || '/') + q + (op ? ` (${op})` : '');
    const sz = e.bytes ? `${e.bytes} B${e.truncated ? ' (усечено)' : ''}` : '—';
    const pgs = (e.pages || []).join(', ') || '—';
    return [
      `\`${e.method || 'GET'}\``,
      `\`${truncate(p, 80)}\``,
      String(e.status || 200),
      e.kind || 'json',
      sz,
      pgs,
      `\`mocks/data/${e.id}.json\``,
    ];
  });
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ];
}
