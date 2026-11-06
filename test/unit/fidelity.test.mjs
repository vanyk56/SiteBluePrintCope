// Visual-fidelity building blocks: grid templates, pseudo-element boxes, font stacks, tiny separators between
// sections, page wrappers and the metrics (aligned / strict similarity, layout IoU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTw, familyStack } from '../../src/analyze/tailwind.mjs';
import { detectSections } from '../../src/analyze/sections.mjs';
import { pageFile } from '../../src/output/project.mjs';
import { comparePng, layoutScore, loadLibs } from '../../src/verify/visual.mjs';

const tw = createTw({}, { vh: 900 });
const gridOf = (cols, gcv) => tw.groups({ t: 'div', r: [0, 0, 1320, 500], s: { display: 'grid', 'grid-template-columns': cols, ...(gcv ? { gcv } : {}) } }, {}, {}, null).gridCols;

test('grid-template-columns: авторский шаблон важнее пропорций, иначе minmax(0, Xfr) без роста по min-content', () => {
  assert.equal(gridOf('264px 832px 224px', '264px minmax(0,1fr) 224px'), 'grid-cols-[264px_minmax(0,1fr)_224px]');
  assert.equal(gridOf('264px 832px 224px'), 'grid-cols-[minmax(0,1.18fr)_minmax(0,3.71fr)_minmax(0,1fr)]');
  assert.equal(gridOf('1000px 300px'), 'grid-cols-[minmax(0,1fr)_300px]');
  assert.equal(gridOf('300px 300px 300px'), 'grid-cols-3', 'равные дорожки — обычный grid-cols-N');
  assert.equal(gridOf('300px 300px 300px', 'repeat(3,1fr)'), 'grid-cols-3', 'авторский шаблон не нужен, если N равных колонок точны');
  assert.equal(gridOf('300px 300px 300px', 'repeat(auto-fill,minmax(240px,1fr))'), 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]', 'auto-fill сохраняет адаптивность');
});

test('псевдоэлементы: размер/позиция/повтор фона, flex: none, вертикальные отступы, порядок', () => {
  const g = tw.groups({ t: 'li', r: [0, 0, 300, 26], s: { display: 'flex' }, pb: { content: '""', display: 'block', position: 'static', w: 20, h: 20, bg: '#22d3ee26', bgi: 'url(/svg/check.svg)', bgs: '12px', bgp: '50% 50%', bgr: 'no-repeat', margin: [3, 0, 0, 0], flex: [0, 0, 'auto'], order: -1, radius: 6 } }, {}, {}, null);
  for (const c of ['before:bg-[length:12px]', 'before:bg-center', 'before:bg-no-repeat', 'before:flex-none', 'before:mt-[3px]', 'before:-order-1', 'before:w-[20px]', 'before:rounded-[6px]']) assert.ok(g.before.split(' ').includes(c), `${c} в «${g.before}»`);
  const clear = tw.groups({ t: 'div', r: [0, 0, 300, 26], s: {}, pa: { content: '""', display: 'table', position: 'static', clear: 'both' } }, {}, {}, null);
  assert.ok(/after:clear-both/.test(clear.after) && /after:table/.test(clear.after), clear.after);
});

test('отступы и ширины: равные фиксированные поля ≠ mx-auto, авторские px ≠ w-full, модель границ таблиц, нативный progress', () => {
  const parent = { t: 'div', r: [0, 0, 400, 200], s: { padding: [0, 0, 0, 0] } };
  const hook = (extra = {}) => tw.groups({ t: 'div', r: [18, 0, 364, 78], s: { margin: [0, 18, 16, 18], ...extra } }, {}, {}, parent).m;
  assert.match(hook(), /\bmx-auto\b/, 'центрированный блок без проверки — как раньше');
  const fixed = hook({ mfix: 1 });
  assert.ok(!/mx-auto/.test(fixed) && /mx-\[18px\]|mr-\[18px\]/.test(fixed), fixed);
  const td = { t: 'td', r: [0, 0, 156, 46], s: { padding: [11, 18, 11, 18] } };
  const bar = (extra = {}) => tw.groups({ t: 'div', r: [18, 20, 120, 6], au: 'w', s: { w: 120, h: 6, ...extra } }, {}, {}, td).w;
  assert.equal(bar(), 'w-full', 'ширина совпала с контейнером — w-full');
  assert.equal(bar({ wpx: 1 }), 'w-30', 'авторские 120px действуют — остаются px');
  const tbl = (table) => tw.groups({ t: 'table', r: [0, 0, 600, 300], s: { display: 'table', table } }, {}, {}, null).table;
  assert.equal(tbl({ sep: 1 }), 'border-separate border-spacing-0');
  assert.equal(tbl({ sep: 1, sp: '2px 2px' }), 'border-separate border-spacing-[2px]');
  assert.equal(tbl({ sep: 1, sp: '4px 2px', fixed: 1 }), 'border-separate border-spacing-x-[4px] border-spacing-y-[2px] table-fixed');
  const ctl = (appearance) => tw.groups({ t: 'progress', r: [0, 0, 300, 8], s: { appearance } }, {}, {}, null).appearance;
  assert.equal(ctl('native'), '[border:revert]', 'нативный progress: рамка preflight отменяется');
  assert.equal(ctl('none'), 'appearance-none');
});

test('familyStack: вся цепочка запасных шрифтов + generic, кавычки только у имён с пробелами', () => {
  assert.equal(familyStack('"Lab Sans", Inter, system-ui, sans-serif'), "'Lab Sans',Inter,system-ui,sans-serif");
  assert.equal(familyStack('system-ui'), 'system-ui');
});

// minimal extracted tree: body > [header, main > [A, hr, B], footer]
const box = (i, t, y, h, extra = {}) => ({ i, t, r: [0, y, 1440, h], k: [], ...extra });
function page() {
  const A = box(3, 'section', 60, 400, { k: [box(31, 'h2', 80, 40, { k: ['Первый'] })] });
  const hr = box(4, 'hr', 481, 1, { s: { margin: [20, 0, 20, 0], 'border-width': [1, 0, 0, 0] } });
  const spacer = box(7, 'div', 502, 0, {}); // zero-height, no margins/box -> dropped
  const B = box(5, 'section', 502, 400, { k: [box(51, 'h2', 520, 40, { k: ['Второй'] })] });
  const main = box(2, 'main', 60, 842, { k: [A, hr, spacer, B] });
  const root = box(0, 'body', 0, 1000, { k: [box(1, 'header', 0, 60, { k: ['Лого'] }), main, box(6, 'footer', 902, 98, { k: ['©'] })] });
  return { root, A, B, hr, main };
}

test('detectSections: мелкий <hr> между секциями раскрытой обёртки не теряется (info.inline + обёртка)', () => {
  const { root, A, B, hr, main } = page(); const info = {};
  const secs = detectSections(root, 900, info);
  assert.deepEqual(secs.map((s) => s.i), [1, 3, 5, 6], 'секции без мелких элементов');
  assert.equal(info.inline.length, 1);
  assert.equal(info.inline[0].node, hr);
  assert.equal(info.inline[0].before, 2, 'перед секцией B (индекс 2)');
  assert.deepEqual(info.inline[0].wrap, [main]);
  assert.deepEqual(info.wrapOf.get(A), [main]); assert.deepEqual(info.wrapOf.get(B), [main]);
});

test('pageFile: обёртки воссоздаются вокруг блоков, мелкие элементы стоят на своём месте', () => {
  const comp = (name) => ({ name, file: `components/sections/${name}.tsx` });
  const p = {
    raw: { meta: { title: 'Тест' } },
    blocks: [{ comp: comp('FirstSection'), section: { index: 1 }, wrap: [2] }, { comp: comp('SecondSection'), section: { index: 2 }, wrap: [2] }, { comp: comp('Outside'), section: { index: 3 }, wrap: [] }],
    wraps: new Map([[2, { tag: 'main', cls: 'max-w-[1170px] mx-auto px-[15px]' }]]),
    inlines: [{ at: 1, tag: 'hr', cls: 'my-5 border-0 border-t border-[#eee]', wrap: [2] }],
  };
  const code = pageFile({}, p);
  // <main> of the original becomes <div>: app/layout.tsx already renders <main>
  const order = ['<div className="max-w-[1170px] mx-auto px-[15px]">', '<FirstSection />', '<hr className="my-5 border-0 border-t border-[#eee]" />', '<SecondSection />', '</div>', '<Outside />'];
  let at = -1; for (const s of order) { const k = code.indexOf(s); assert.ok(k > at, `«${s}» на месте:\n${code}`); at = k; }
  assert.equal((code.match(/^import /gm) || []).length, 4, 'импорт Metadata + 3 компонента, у <hr> импорта нет');
});

const { PNG } = await loadLibs();
const noPng = !PNG && 'нет pngjs (npm install)';
function stripes(w, h, rows) { const p = new PNG({ width: w, height: h }); p.data.fill(255); for (const [y0, y1] of rows) for (let y = y0; y < y1; y++) for (let x = 10; x < w - 10; x++) p.data.set([30, 30, 30, 255], (y * w + x) * 4); return PNG.sync.write(p); }

test('comparePng: сдвиг на 20 px ниже вставки — «по секциям» почти 100 %, «строгое» честно ниже; маски не считаются', { skip: noPng }, async () => {
  const a = stripes(200, 400, [[20, 40], [120, 140], [220, 240], [320, 340]]);
  const b = stripes(200, 420, [[20, 40], [140, 160], [240, 260], [340, 360]]); // 20px inserted at y=100
  const r = await comparePng(a, b, { composite: false, bands: [{ name: 'top', y: 0, h: 100 }, { name: 'rest', y: 100, h: 300 }] });
  assert.equal(r.bands.find((x) => x.name === 'rest').similarity, 1, 'полоса ниже вставки совпадает после выравнивания');
  assert.ok(r.similarity > 0.94, 'aligned ' + r.similarity + ' (лишние 20 px клона честно штрафуются: 400/420)');
  assert.ok(r.strict < r.similarity - 0.05, `strict ${r.strict} < aligned ${r.similarity}`);
  assert.equal(r.bands.find((x) => x.name === 'rest').offset, 20);
  const c = stripes(200, 400, [[20, 40], [120, 140], [220, 240]]); // last stripe missing
  const unmasked = await comparePng(a, c, { composite: false });
  const masked = await comparePng(a, c, { composite: false, masks: [{ x: 0, y: 300, w: 200, h: 60 }] });
  assert.ok(masked.similarity > unmasked.similarity && masked.similarity > 0.999, `${masked.similarity} vs ${unmasked.similarity}`);
});

test('layoutScore: IoU текстовых блоков с учётом смещения полосы', () => {
  const orig = [{ text: 'Заголовок', r: [100, 100, 400, 40] }, { text: 'Кнопка', r: [100, 200, 120, 40] }];
  assert.equal(layoutScore(orig, orig).score, 1);
  const shifted = orig.map((o) => ({ ...o, r: [o.r[0], o.r[1] + 20, o.r[2], o.r[3]] }));
  assert.ok(layoutScore(orig, shifted).score < 0.6);
  assert.equal(layoutScore(orig, shifted, { offsetAt: () => 20 }).score, 1, 'смещение полосы компенсируется');
  const r = layoutScore(orig, [orig[0]]); assert.equal(r.matched, 1); assert.ok(r.score < 1);
});
