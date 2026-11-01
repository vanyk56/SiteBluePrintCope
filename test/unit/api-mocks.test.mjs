// Unit tests: redaction (src/capture/redact.mjs), API sniffer (src/capture/network.mjs) and the generated mock layer
// of the Next.js project (src/output/api.mjs: mocks/registry.ts, lib/mock-api.ts findMock(), route.ts, rewrites).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { Redactor, SECRET_HEADERS } from '../../src/capture/redact.mjs';
import { ApiSniffer, graphqlInfo, isCacheBuster } from '../../src/capture/network.mjs';
import { apiProjectFiles, nextConfig, MOCK_LIB, MOCK_ROUTE, apiTable, loadApiMocks } from '../../src/output/api.mjs';

const ME = { id: 7, full_name: 'Иван Петров', email: 'Ivan.Petrov@nimbus.dev', phone: '+7 (999) 123-45-67', token: 'tok_live_9f8e7d6c5b4a3210', password: 'hunter2', token_count: 12, plan: 'pro', is_admin: false, address: 'ул. Ленина, 1', nested: { access_token: 'abc.def', items: [{ email: 'ivan.petrov@nimbus.dev', price: 1299 }] } };

test('Redactor.json: секреты, e-mail, телефоны, имена, адреса; счётчики и флаги не трогает', () => {
  const r = new Redactor();
  const out = r.json(ME);
  assert.equal(out.token, '[REDACTED]'); assert.equal(out.password, '[REDACTED]'); assert.equal(out.nested.access_token, '[REDACTED]');
  assert.equal(out.email, 'user1@example.com');
  assert.equal(out.nested.items[0].email, 'user1@example.com', 'тот же адрес → тот же фейк (связи в данных сохраняются)');
  assert.match(out.phone, /^\+1 555 010-01-00$/);
  assert.equal(out.full_name, 'User 1');
  assert.equal(out.address, '[REDACTED]');
  assert.equal(out.token_count, 12); assert.equal(out.plan, 'pro'); assert.equal(out.is_admin, false); assert.equal(out.nested.items[0].price, 1299); assert.equal(out.id, 7);
  assert.equal(ME.token, 'tok_live_9f8e7d6c5b4a3210', 'исходный объект не изменён');
  const rep = r.report();
  assert.equal(rep.enabled, true); assert.ok(rep.replaced >= 7); assert.ok(rep.kinds.secret >= 3 && rep.kinds.email >= 2);
});

test('Redactor.text: JWT, Bearer, ключи API, карты (Луна), телефоны — но не даты, цены и id', () => {
  const r = new Redactor();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const s = r.text(`auth ${jwt} | Authorization: Bearer abcdefghijklmnop123 | key sk_live_51Habcdefghijklmnop AKIAABCDEFGHIJKLMNOP | card 4111 1111 1111 1111 | not card 1234 5678 9012 3456 | call +7 (999) 123-45-67 | date 2024-01-15 | price 1 299 ₽ | order 89991234567 | mail ivan@mail.ru, demo@example.com`);
  assert.ok(!s.includes(jwt)); assert.match(s, /\[REDACTED_JWT\]/);
  assert.match(s, /Bearer \[REDACTED\]/);
  assert.ok(!/sk_live_51H|AKIAABCD/.test(s));
  assert.match(s, /\[REDACTED_CARD\]/); assert.match(s, /1234 5678 9012 3456/);
  assert.ok(!s.includes('123-45-67'));
  assert.match(s, /2024-01-15/); assert.match(s, /1 299/); assert.match(s, /89991234567/);
  assert.match(s, /user1@example\.com/); assert.match(s, /demo@example\.com/);
});

test('Redactor.url / headers / выключенный режим', () => {
  const r = new Redactor();
  const u = new URL(r.url('https://bob:pw@api.shop.example/v1/items?api_key=XYZ123&page=2&email=a.b%40mail.ru&q=sofa'));
  assert.equal(u.username, ''); assert.equal(u.password, '');
  assert.equal(u.searchParams.get('api_key'), '[REDACTED]'); assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('email'), 'user1@example.com'); assert.equal(u.searchParams.get('q'), 'sofa');
  const h = r.headers({ Authorization: 'Bearer x', Cookie: 'sid=1', 'X-CSRF-Token': 't', 'Content-Type': 'application/json', Accept: '*/*', 'X-Custom-Trace': 'abc' });
  assert.deepEqual(h, { 'content-type': 'application/json', accept: '*/*' });
  for (const k of ['authorization', 'cookie', 'set-cookie', 'x-api-key']) assert.ok(SECRET_HEADERS.test(k), k);
  const off = new Redactor({ enabled: false });
  assert.deepEqual(off.json(ME), ME); assert.equal(off.text('a@b.ru'), 'a@b.ru');
});

test('cache busters и GraphQL', () => {
  assert.equal(isCacheBuster('_', '1730000000000'), true);
  assert.equal(isCacheBuster('t', '1730000000'), true);
  assert.equal(isCacheBuster('t', 'dark'), false);
  assert.equal(isCacheBuster('page', '2'), false);
  const g = graphqlInfo(new URL('https://x.example/graphql'), { query: 'query GetReviews($id: ID!) { reviews(id: $id) { id } }', variables: { id: 1 } });
  assert.deepEqual(g, { operationName: 'GetReviews', type: 'query', variables: { id: 1 } });
  assert.equal(graphqlInfo(new URL('https://x.example/graphql'), [{ operationName: 'A', query: 'query A{a}' }, { operationName: 'B', query: 'mutation B{b}' }]).operationName, 'A+B');
  assert.equal(graphqlInfo(new URL('https://x.example/graphql?operationName=Feed&extensions=%7B%22persistedQuery%22%3A%7B%22sha256Hash%22%3A%22abc%22%7D%7D'), undefined).operationName, 'Feed');
  assert.equal(graphqlInfo(new URL('https://x.example/graphql'), { extensions: { persistedQuery: { sha256Hash: '0123456789abcdef' } } }).operationName, 'persisted-0123456789');
  assert.equal(graphqlInfo(new URL('https://x.example/api'), { a: 1 }), null);
});

test('ApiSniffer: фильтр шума, дедупликация, GraphQL, редакция, лимиты, запись на диск', async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-api-'));
  const s = new ApiSniffer({ outDir, origin: 'https://www.shop.example', maxMocks: 7 });
  const rec = (o) => s.record({ method: 'GET', status: 200, contentType: 'application/json', resourceType: 'fetch', ...o });
  // noise / static / errors / trackers / redirects / non-fetch
  assert.equal(rec({ url: 'https://www.google-analytics.com/g/collect?v=2', body: '{}' }), null);
  assert.equal(rec({ url: 'https://shop.example/static/app.js', body: '{}' }), null);
  assert.equal(rec({ url: 'https://shop.example/cdn-cgi/challenge-platform/h/b', body: '{}' }), null);
  assert.equal(rec({ url: 'https://shop.example/api/x', status: 500, body: '{}' }), null);
  assert.equal(rec({ url: 'https://shop.example/api/x', status: 302, body: '' }), null);
  assert.equal(rec({ url: 'https://shop.example/api/x', resourceType: 'image', body: '{}' }), null);
  assert.equal(rec({ url: 'https://shop.example/api/x', method: 'OPTIONS', body: '' }), null);
  assert.equal(rec({ url: 'https://shop.example/page', contentType: 'text/x-component', body: '0:["$"]' }), null, 'RSC payload');
  assert.ok(s.skipped.trackers >= 1 && s.skipped.static >= 1 && s.skipped.noise >= 1 && s.skipped.errors >= 1);
  // JSON + cache buster dedup
  const a = rec({ url: 'https://shop.example/api/products?page=1&_=1730000000001', body: { items: [1, 2] }, page: 'shop' });
  const b = rec({ url: 'https://shop.example/api/products?page=1&_=1730000000999', body: { items: [1, 2] }, page: 'index' });
  assert.ok(a && a === b);
  assert.notEqual(rec({ url: 'https://shop.example/api/products?page=2', body: { items: [3] } }), a);
  // 401 is kept (the clone shows the logged-out state the user saw); body redacted, headers dropped
  const me = rec({ url: 'https://shop.example/api/me', status: 200, body: JSON.stringify(ME), requestHeaders: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', accept: 'application/json' } });
  // GraphQL POST: one mock per operation + variables
  const gq = (op, vars) => s.record({ url: 'https://shop.example/graphql', method: 'POST', contentType: 'application/json', requestBody: JSON.stringify({ operationName: op, query: `query ${op} { x }`, variables: vars }), body: { data: { op } } });
  const g1 = gq('GetReviews', { first: 3 }); const g2 = gq('GetReviews', { first: 10 }); const g3 = gq('GetReviews', { first: 3 });
  assert.match(g1, /^gql-get-reviews-[0-9a-f]{6}$/); assert.notEqual(g1, g2); assert.equal(g1, g3);
  // text/plain JSON and HTML fragments
  assert.ok(rec({ url: 'https://shop.example/ajax/count', contentType: 'text/plain', body: '{"n":5}' }));
  assert.ok(rec({ url: 'https://shop.example/fragments/cart', contentType: 'text/html', body: '<div class="cart">2 товара, a@b.ru</div>' }));
  // limit
  assert.equal(rec({ url: 'https://shop.example/api/one-more', body: {} }), null);
  assert.equal(s.skipped.limit, 1);
  const list = s.list();
  const ent = (id) => list.find((e) => e.id === id);
  assert.deepEqual(ent(a).query, { page: '1' }); assert.equal(ent(a).hits, 2); assert.deepEqual(ent(a).pages.sort(), ['index', 'shop']);
  const meE = ent(me);
  assert.equal(meE.body.email, 'user1@example.com'); assert.equal(meE.body.token, '[REDACTED]');
  assert.deepEqual(meE.request.headers, { accept: 'application/json' });
  assert.equal(ent(g1).graphql.operationName, 'GetReviews'); assert.equal(ent(g1).method, 'POST');
  const frag = list.find((e) => e.path === '/fragments/cart');
  assert.equal(frag.kind, 'html'); assert.match(frag.bodyText, /user\d@example\.com/);
  assert.equal(list.find((e) => e.path === '/ajax/count').kind, 'json');
  const summary = await s.write();
  assert.equal(summary.count, 7);
  assert.ok(summary.redaction.replaced > 0);
  const idx = JSON.parse(await fsp.readFile(path.join(outDir, 'data/api-mocks/index.json'), 'utf8'));
  assert.equal(idx.entries.length, 7);
  for (const e of idx.entries) assert.ok((await fsp.stat(path.join(outDir, e.file))).size > 0);
  const all = await fsp.readFile(path.join(outDir, 'data/api-mocks', me + '.json'), 'utf8');
  assert.ok(!all.includes('tok_live_9f8e7d6c5b4a3210') && !all.includes('nimbus.dev') && !all.includes('abcdefghijklmnopqrstuvwxyz'));
  const loaded = await loadApiMocks(outDir);
  assert.equal(loaded.entries.length, 7);
});

test('ApiSniffer: внешние API, sameSiteOnly, большие ответы', () => {
  const s = new ApiSniffer({ outDir: os.tmpdir(), origin: 'https://shop.example', sameSiteOnly: false });
  const id = s.record({ url: 'https://api.other.example/v1/items', body: { a: 1 }, contentType: 'application/json' });
  assert.equal(s.list().find((e) => e.id === id).external, true);
  assert.ok(s.record({ url: 'https://api.shop.example/v1/items', body: { a: 1 }, contentType: 'application/json' }), 'поддомен — свой');
  assert.equal(s.list().find((e) => e.host === 'api.shop.example').external, false);
  const only = new ApiSniffer({ outDir: os.tmpdir(), origin: 'https://shop.example', sameSiteOnly: true });
  assert.equal(only.record({ url: 'https://api.other.example/v1/items', body: { a: 1 }, contentType: 'application/json' }), null);
  assert.equal(only.record({ url: 'https://shop.example/api/huge', body: 'x'.repeat(2.2 * 1048576), contentType: 'text/plain' }), null);
  assert.equal(only.skipped.large, 1);
  const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, text: 'lorem ipsum '.repeat(12) })) };
  const bid = only.record({ url: 'https://shop.example/api/big', body: big, contentType: 'application/json' });
  const be = only.list().find((e) => e.id === bid);
  assert.equal(be.truncated, true); assert.equal(be.body.items.length, 60);
});

function sampleApi() {
  const s = new ApiSniffer({ outDir: os.tmpdir(), origin: 'https://shop.example' });
  s.record({ url: 'https://shop.example/api/products?page=1', contentType: 'application/json', body: { page: 1 }, page: 'shop' });
  s.record({ url: 'https://shop.example/api/products?page=2', contentType: 'application/json', body: { page: 2 }, page: 'shop' });
  s.record({ url: 'https://shop.example/api/products', contentType: 'application/json', body: { page: 'all' } });
  s.record({ url: 'https://shop.example/graphql', method: 'POST', contentType: 'application/json', requestBody: '{"operationName":"GetReviews","query":"query GetReviews{r}"}', body: { data: { reviews: [] } } });
  s.record({ url: 'https://shop.example/wp-json/wp/v2/posts', contentType: 'application/json', body: [{ id: 1 }] });
  s.record({ url: 'https://shop.example/fragments/cart', contentType: 'text/html', body: '<b>2</b>' });
  s.record({ url: 'https://api.other.example/v1/rates', contentType: 'application/json', body: { usd: 1 } });
  return { entries: s.list() };
}

test('apiProjectFiles: моки, registry, catch-all route и rewrites', async () => {
  const api = sampleApi();
  const { files, rewrites, count } = apiProjectFiles(api);
  assert.equal(count, 7);
  for (const k of ['mocks/registry.ts', 'lib/mock-api.ts', 'app/api/[...route]/route.ts']) assert.ok(files.has(k), k);
  assert.equal([...files.keys()].filter((k) => k.startsWith('mocks/data/')).length, 7);
  const reg = files.get('mocks/registry.ts');
  assert.equal((reg.match(/^import m\d+ from '\.\/data\//gm) || []).length, 7);
  assert.match(reg, /"operation":"GetReviews"/);
  assert.match(files.get('app/api/[...route]/route.ts'), /params: Promise</, 'Next 16: params — Promise');
  assert.equal(files.get('lib/mock-api.ts'), MOCK_LIB);
  const cart = [...files.entries()].find(([k, v]) => k.startsWith('mocks/data/') && v.includes('<b>2</b>'));
  assert.deepEqual(JSON.parse(cart[1]), { text: '<b>2</b>' });
  assert.deepEqual(rewrites.map((r) => r.source).sort(), ['/fragments/cart', '/graphql', '/wp-json/wp/v2/posts']);
  assert.ok(rewrites.every((r) => r.destination === '/api/__mock' + r.source));
  assert.equal(apiProjectFiles({ entries: [] }).count, 0);
  assert.equal(apiProjectFiles({ entries: [{ ...api.entries[0], path: '/a:b(.*)' }] }).rewrites.length, 0, 'опасные шаблоны путей не попадают в rewrites');
  const table = apiTable(api);
  assert.equal(table.length, 9); assert.match(table[0], /Метод/);
  // next.config is valid ESM with working rewrites()
  const cfg = nextConfig({ rewrites });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(cfg).toString('base64'));
  assert.equal(mod.default.images.unoptimized, true);
  assert.deepEqual(await mod.default.rewrites(), rewrites);
  assert.equal((await import('data:text/javascript;base64,' + Buffer.from(nextConfig()).toString('base64'))).default.rewrites, undefined);
  assert.match(MOCK_ROUTE, /export const POST = handle/);
});

const strip = nodeModule.stripTypeScriptTypes;
test('lib/mock-api.ts: findMock / mockResponse / mockUrl (TypeScript → JS через node:module)', { skip: typeof strip !== 'function' && 'нужен Node 22.13+ (stripTypeScriptTypes)' }, async () => {
  const js = strip(MOCK_LIB, { mode: 'strip' });
  const { findMock, mockResponse, mockUrl } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const { files } = apiProjectFiles(sampleApi());
  // registry rows → objects (the same data the generated registry.ts imports)
  const rows = [...files.get('mocks/registry.ts').matchAll(/^ {2}\{ (.+), (?:body|text): m(\d+)\.(body|text) \},$/gm)];
  const bodies = [...files.entries()].filter(([k]) => k.startsWith('mocks/data/')).map(([, v]) => JSON.parse(v));
  const MOCKS = rows.map((m) => ({ ...JSON.parse('{' + m[1] + '}'), [m[3]]: bodies[+m[2]][m[3]] }));
  assert.equal(MOCKS.length, 7);
  const q = (s) => new URLSearchParams(s);
  const hit = (...a) => { const e = findMock(MOCKS, ...a); return e && (e.body ?? e.text); };
  assert.deepEqual(hit('GET', '/api/products', q('page=2')), { page: 2 });
  assert.deepEqual(hit('GET', '/api/products', q('page=1')), { page: 1 });
  assert.deepEqual(hit('GET', '/api/products/', q('')), { page: 'all' }, 'хвостовой слэш, без параметров → общий мок');
  assert.deepEqual(hit('GET', '/api/products', q('page=99')), { page: 'all' });
  assert.deepEqual(hit('HEAD', '/api/products', q('page=2')), { page: 2 });
  assert.equal(hit('DELETE', '/api/products', q('')), null);
  assert.deepEqual(hit('POST', '/graphql', q(''), { operation: 'GetReviews' }), { data: { reviews: [] } });
  assert.equal(hit('POST', '/graphql', q(''), { operation: 'DeleteAll' }), null, 'чужая операция GraphQL не подменяется');
  assert.equal(hit('GET', '/v1/rates', q('')), null, 'внешний API только через /api/__mock/ext/<host>');
  assert.deepEqual(hit('GET', '/v1/rates', q(''), { host: 'api.other.example' }), { usd: 1 });
  assert.equal(hit('GET', '/fragments/cart', q('')), '<b>2</b>');
  const res = mockResponse(findMock(MOCKS, 'GET', '/api/products', q('page=2')));
  assert.equal(res.status, 200); assert.match(res.headers.get('x-mock-id'), /^get-api-products-/); assert.deepEqual(await res.json(), { page: 2 });
  assert.equal(await mockResponse(findMock(MOCKS, 'GET', '/fragments/cart', q(''))).text(), '<b>2</b>');
  assert.equal(mockUrl('https://api.other.example/v1/rates?x=1'), '/api/__mock/ext/api.other.example/v1/rates?x=1');
  assert.equal(mockUrl('/api/products?page=1'), '/api/products?page=1');
});
