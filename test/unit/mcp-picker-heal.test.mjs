// Unit tests for MCP server, Component Picker, Visual Auto-Heal, and Responsive Sibling Alignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, MCP_TOOLS } from '../../src/server/mcp.mjs';
import { styleToTailwind, renderStandaloneComponent, pickSiteComponent } from '../../src/analyze/picker.mjs';
import { findDegradedSections, fixVisualDriftDeterministic } from '../../src/verify/visual-heal.mjs';

test('MCP Server: initialize, ping, and tools/list follow JSON-RPC 2.0 spec', async () => {
  const initRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  });
  assert.equal(initRes.jsonrpc, '2.0');
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.serverInfo.name, 'site-blueprint');
  assert.ok(initRes.result.capabilities.tools);

  const listRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  assert.equal(listRes.id, 2);
  assert.equal(listRes.result.tools.length, MCP_TOOLS.length);
  const names = listRes.result.tools.map((t) => t.name);
  for (const expected of ['clone_site', 'extract_design_tokens', 'pick_component', 'heal_project', 'verify_clone']) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }

  const notifRes = await handleMcpRequest({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(notifRes, null, 'notifications return null');

  const promptsList = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'prompts/list',
  });
  assert.equal(promptsList.result.prompts[0].name, 'clone-website-1to1');

  const promptGet = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'prompts/get',
    params: { name: 'clone-website-1to1', arguments: { url: 'https://cursor.com' } },
  });
  assert.match(promptGet.result.messages[0].content.text, /https:\/\/cursor\.com/);

  const resList = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'resources/list',
  });
  assert.ok(Array.isArray(resList.result.resources));
});

test('Component Picker: styleToTailwind & renderStandaloneComponent generate valid React + Tailwind TSX', () => {
  const cls = styleToTailwind(
    {
      display: 'flex',
      'flex-direction': 'column',
      'justify-content': 'center',
      'align-items': 'center',
      gap: [16, 16],
      padding: [24, 32, 24, 32],
      'background-color': '#09090b',
      color: '#f4f4f5',
      radius: [12, 12, 12, 12],
    },
    'section'
  );
  assert.ok(cls.includes('flex'));
  assert.ok(cls.includes('flex-col'));
  assert.ok(cls.includes('justify-center'));
  assert.ok(cls.includes('items-center'));
  assert.ok(cls.includes('gap-4'));
  assert.ok(cls.includes('py-6 px-8'));
  assert.ok(cls.includes('rounded-xl'));

  const node = {
    t: 'section',
    s: { display: 'flex', 'flex-direction': 'column', gap: [16, 16], padding: [32, 32, 32, 32] },
    k: [
      { t: 'h2', s: { 'font-size': 36, 'font-weight': 700, color: '#ffffff' }, k: ['Pricing Plans'] },
      { t: 'a', href: '/signup', s: { padding: [8, 16, 8, 16], radius: [8, 8, 8, 8] }, k: ['Get Started'] },
    ],
  };
  const tsx = renderStandaloneComponent(node, { name: 'PricingCard' });
  assert.match(tsx, /export default function PricingCard\(\)/);
  assert.match(tsx, /Pricing Plans/);
  assert.match(tsx, /href="\/signup"/);
});

test('Component Picker: pickSiteComponent matches by type, name, heading, or index', () => {
  const site = {
    components: [
      { name: 'Header', type: 'header', heading: '', code: '<header />' },
      { name: 'HeroSection', type: 'hero', heading: 'Build software faster', code: '<section>Hero</section>' },
      { name: 'PricingSection', type: 'pricing', heading: 'Simple pricing', code: '<section>Pricing</section>' },
    ],
  };
  assert.equal(pickSiteComponent(site, 'pricing').name, 'PricingSection');
  assert.equal(pickSiteComponent(site, 'faster').name, 'HeroSection');
  assert.equal(pickSiteComponent(site, '1').name, 'HeroSection');
});

test('Visual Auto-Heal: findDegradedSections & fixVisualDriftDeterministic repair rigid widths and heights', () => {
  const site = {
    pages: [
      {
        slug: 'index',
        route: '/',
        blocks: [{ section: { index: 1 }, comp: { name: 'HeroSection', type: 'hero', file: 'components/sections/HeroSection.tsx' } }],
      },
    ],
    components: [{ name: 'HeroSection', type: 'hero', page: 'index', index: 1, file: 'components/sections/HeroSection.tsx' }],
  };
  const visualReport = {
    pages: [
      {
        slug: 'index',
        route: '/',
        view: 'desktop',
        bands: [
          { name: '1. header', similarity: 0.99, offset: 0, h: 80 },
          { name: '2. hero «Welcome»', similarity: 0.74, offset: 120, h: 600 },
        ],
      },
    ],
  };

  const degraded = findDegradedSections(visualReport, site, { minSimilarity: 0.85 });
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].comp.name, 'HeroSection');

  const sampleCode = `<section className="flex w-[1280px] h-[540px] bg-black"><div className="p-6">Content</div></section>`;
  const fixed = fixVisualDriftDeterministic(sampleCode, degraded[0].band);
  assert.equal(fixed.changed, true);
  assert.ok(fixed.code.includes('w-[1280px] max-w-full'), 'clamped rigid width with max-w-full');
  assert.ok(fixed.code.includes('min-h-[540px]'), 'converted rigid height to min-h on large offset drift');
});

test('Responsive Sibling Alignment: desktop & mobile siblings still merge into lg: classes when mobile-only node shifts _p', async () => {
  const { buildSite } = await import('../../src/analyze/site.mjs');
  const dTree = {
    i: 1, n: 1, t: 'body', r: [0, 0, 1440, 900], s: {},
    k: [
      {
        i: 2, n: 2, t: 'section', r: [0, 0, 1440, 500], s: { display: 'flex', padding: [64, 64, 64, 64] },
        k: [
          { i: 3, n: 3, t: 'h1', r: [64, 64, 800, 60], s: { 'font-size': 48, 'font-weight': 700 }, k: ['Responsive Headline'] },
        ],
      },
    ],
  };
  const mTree = {
    i: 1, n: 1, t: 'body', r: [0, 0, 390, 844], s: {},
    k: [
      {
        i: 2, n: 2, t: 'section', r: [0, 0, 390, 400], s: { display: 'flex', padding: [24, 16, 24, 16] },
        k: [
          { i: 10, n: 10, t: 'span', r: [16, 16, 100, 20], s: { 'font-size': 12 }, k: ['Mobile Badge'] },
          { i: 3, n: 11, t: 'h1', r: [16, 48, 350, 40], s: { 'font-size': 24, 'font-weight': 700 }, k: ['Responsive Headline'] },
        ],
      },
    ],
  };
  const site = buildSite({
    crawl: { origin: 'https://example.com', pages: [{ slug: 'index' }], assets: { saved: [] } },
    pages: [
      {
        slug: 'index',
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        raw: { url: 'https://example.com/', viewport: { w: 1440, h: 900 }, meta: { title: 'Test' }, tree: dTree, images: [], svgs: [], links: [], fontFaces: [], loadedFonts: [] },
        mobile: {
          raw: { url: 'https://example.com/', viewport: { w: 390, h: 844 }, meta: { title: 'Test' }, tree: mTree, images: [], svgs: [], links: [] },
        },
      },
    ],
    css: [],
  });
  const code = site.components[0].code;
  assert.match(code, /text-2xl.*lg:text-5xl/, 'h1 paired across mobile (24px -> text-2xl) and desktop (48px -> lg:text-5xl) despite shifted _p');
});
