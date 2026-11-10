// Stage 3: writes the complete Next.js 16 + React 19 + Tailwind v4 starter project into `<outDir>/project/`.
import path from 'node:path';
import { writeText, ensureDir } from '../util.mjs';
import { buildGlobalsCss, bodyStyleOf } from './theme.mjs';
import { apiProjectFiles, nextConfig } from './api.mjs';
import { INTERACTIVE_FILES } from './interactive.mjs';
import { jsEsc } from '../analyze/skeleton.mjs';

export const PKG_VERSIONS = {
  next: '^16.0.0',
  react: '^19.0.0',
  'react-dom': '^19.0.0',
  tailwindcss: '^4.0.0',
  '@tailwindcss/postcss': '^4.0.0',
  typescript: '^5.7.0',
  '@types/node': '^22.0.0',
  '@types/react': '^19.0.0',
  '@types/react-dom': '^19.0.0',
};

export function iconsFile(site) {
  const icons = site.icons || [];
  if (!icons.length) {
    return `import type { SVGProps } from 'react';\n\nexport function PlaceholderIcon(props: SVGProps<SVGSVGElement>) {\n  return <svg viewBox="0 0 24 24" {...props} />;\n}\n`;
  }
  const lines = [`import type { SVGProps } from 'react';`, ''];
  for (const ic of icons) {
    const jsx = String(ic.jsx || '<svg viewBox="0 0 24 24" />').replace(/^<svg\b/, '<svg {...props}');
    lines.push(`export function ${ic.name}(props: SVGProps<SVGSVGElement>) {`);
    lines.push(`  return (`);
    lines.push(`    ${jsx}`);
    lines.push(`  );`);
    lines.push(`}`, '');
  }
  return lines.join('\n');
}

export function layoutFile(site) {
  const top = (site.globals || []).filter((g) => g.position !== 'bottom');
  const bottom = (site.globals || []).filter((g) => g.position === 'bottom');
  const meta = (site.home && site.home.raw && site.home.raw.meta) || {};
  const lang = meta.lang || 'ru';
  const title = meta.title || (site.origin ? new URL(site.origin).hostname : 'Site Clone');
  const desc = meta.description || '';

  const imports = [`import type { Metadata } from 'next';`, `import './globals.css';`];
  for (const g of [...top, ...bottom]) {
    imports.push(`import { ${g.name} } from '@/components/layout/${g.name}';`);
  }
  if (site.cart) {
    imports.push(`import { CartProvider } from '@/components/interactive/Cart';`);
  }

  const metaLines = [
    `export const metadata: Metadata = {`,
    `  title: ${jsEsc(title)},`,
    ...(desc ? [`  description: ${jsEsc(desc)},`] : []),
    `};`,
  ];

  const mainOpen = site.layoutMain && site.layoutMain.cls ? `<main className="${site.layoutMain.cls}">` : null;
  let inner = [
    ...top.map((g) => `        <${g.name} />`),
    ...(mainOpen ? [`        ${mainOpen}`, `          {children}`, `        </main>`] : [`        {children}`]),
    ...bottom.map((g) => `        <${g.name} />`),
  ];

  const lwraps = site.layoutWrap || [];
  for (let i = lwraps.length - 1; i >= 0; i--) {
    const w = lwraps[i];
    const tag = w.tag === 'body' || w.tag === 'html' ? 'div' : (w.tag || 'div');
    inner = [
      `        <${tag}${w.cls ? ` className="${w.cls}"` : ''}>`,
      ...inner.map((l) => '  ' + l),
      `        </${tag}>`,
    ];
  }

  const bodyContent = site.cart
    ? [
        `        <CartProvider config={${JSON.stringify(site.cart)}}>`,
        ...inner.map((l) => '  ' + l),
        `        </CartProvider>`,
      ]
    : inner;

  return [
    ...imports,
    '',
    ...metaLines,
    '',
    `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
    `  return (`,
    `    <html lang=${jsEsc(lang)}>`,
    `      <body>`,
    ...bodyContent,
    `      </body>`,
    `    </html>`,
    `  );`,
    `}`,
    '',
  ].join('\n');
}

export function pageFile(site, p) {
  const blocks = p.blocks || [];
  const inlines = p.inlines || [];
  const wraps = p.wraps || new Map();
  const meta = (p.raw && p.raw.meta) || {};
  const imports = [];
  const seen = new Set();

  for (const b of blocks) {
    if (seen.has(b.comp.name)) continue;
    seen.add(b.comp.name);
    imports.push(`import { ${b.comp.name} } from '@/${b.comp.file.replace(/\.tsx$/, '')}';`);
  }

  const lines = [];
  if (p !== site.home && (meta.title || meta.description)) {
    lines.push(`import type { Metadata } from 'next';`);
  }
  lines.push(...imports);
  if (lines.length) lines.push('');

  if (p !== site.home && (meta.title || meta.description)) {
    lines.push(`export const metadata: Metadata = {`);
    if (meta.title) lines.push(`  title: ${jsEsc(meta.title)},`);
    if (meta.description) lines.push(`  description: ${jsEsc(meta.description)},`);
    lines.push(`};`, '');
  }

  const items = [];
  for (let i = 0; i <= blocks.length; i++) {
    for (const x of inlines) {
      if (x.at === i) {
        items.push({
          jsx: `<${x.tag}${x.cls ? ` className="${x.cls}"` : ''} />`,
          wrap: (x.wrap || []).filter((id) => wraps.get(id)),
        });
      }
    }
    if (i < blocks.length) {
      const b = blocks[i];
      items.push({
        jsx: `<${b.comp.name} />`,
        wrap: (b.wrap || []).filter((id) => wraps.get(id)),
      });
    }
  }

  const tagFor = (id) => {
    const w = wraps.get(id);
    if (!w) return 'div';
    return w.tag === 'main' || w.tag === 'body' || w.tag === 'html' ? 'div' : (w.tag || 'div');
  };

  lines.push(`export default function Page() {`);
  lines.push(`  return (`);
  // body of this page differs from the body the layout was generated for (other colour / font size / line height):
  // the difference goes onto the page wrapper, sections are relative to their own page's body
  let mainCls = '';
  try {
    const mine = bodyStyleOf(p), base = bodyStyleOf(site.home);
    if (p !== site.home && mine && base && site.tw && site.tw.inheritedGroups) mainCls = Object.values(site.tw.inheritedGroups(mine, base)).filter(Boolean).join(' ');
  } catch {}
  // <main> already lives in app/layout.tsx when the original wraps the page content itself (grid / flex shell):
  // the page blocks must stay its direct children — a nested <main> or <div> would become the only grid item
  // and collapse a "sidebar | article | toc" layout into one column. Fragment, or display:contents for classes.
  const inLayoutMain = !!(site.layoutMain && site.layoutMain.cls);
  const mainTag = inLayoutMain ? (mainCls ? 'div' : '') : 'main';
  if (inLayoutMain && mainCls) mainCls = 'contents ' + mainCls;
  lines.push(`    <${mainTag}${mainCls ? ` className="${mainCls}"` : ''}>`);

  const open = [];
  const pad = (depth) => '      ' + '  '.repeat(depth);

  for (const it of items) {
    let common = 0;
    while (common < open.length && common < it.wrap.length && open[common] === it.wrap[common]) {
      common++;
    }
    while (open.length > common) {
      const id = open.pop();
      lines.push(`${pad(open.length)}</${tagFor(id)}>`);
    }
    while (open.length < it.wrap.length) {
      const id = it.wrap[open.length];
      const w = wraps.get(id);
      const tag = tagFor(id);
      lines.push(`${pad(open.length)}<${tag}${w && w.cls ? ` className="${w.cls}"` : ''}>`);
      open.push(id);
    }
    lines.push(`${pad(open.length)}${it.jsx}`);
  }
  while (open.length > 0) {
    const id = open.pop();
    lines.push(`${pad(open.length)}</${tagFor(id)}>`);
  }

  lines.push(`    </${mainTag}>`);
  lines.push(`  );`);
  lines.push(`}`, '');

  return lines.join('\n');
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const POSTCSS_CONFIG = `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`;

export async function writeProject(site, outDir, { siteName = 'site-clone', hooks = null, api = null } = {}) {
  const root = path.join(outDir, 'project');
  await ensureDir(root);
  const files = [];

  const put = async (rel, content) => {
    const abs = path.join(root, rel);
    await ensureDir(path.dirname(abs));
    await writeText(abs, content);
    files.push(rel);
  };

  const pkgJson = {
    name: siteName,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
    },
    dependencies: {
      next: PKG_VERSIONS.next,
      react: PKG_VERSIONS.react,
      'react-dom': PKG_VERSIONS['react-dom'],
    },
    devDependencies: {
      tailwindcss: PKG_VERSIONS.tailwindcss,
      '@tailwindcss/postcss': PKG_VERSIONS['@tailwindcss/postcss'],
      typescript: PKG_VERSIONS.typescript,
      '@types/node': PKG_VERSIONS['@types/node'],
      '@types/react': PKG_VERSIONS['@types/react'],
      '@types/react-dom': PKG_VERSIONS['@types/react-dom'],
    },
  };

  const apiLayer = apiProjectFiles(api || site.api);

  await put('package.json', JSON.stringify(pkgJson, null, 2) + '\n');
  await put('tsconfig.json', TSCONFIG);
  await put('postcss.config.mjs', POSTCSS_CONFIG);
  await put('next.config.mjs', nextConfig({ rewrites: apiLayer.rewrites }));
  await put('app/globals.css', buildGlobalsCss(site));
  await put('app/layout.tsx', layoutFile(site));
  await put('components/icons.tsx', iconsFile(site));

  for (const [rel, code] of Object.entries(INTERACTIVE_FILES)) {
    await put(rel, code);
  }

  for (const c of site.components || []) {
    await put(c.file, c.code);
  }

  for (const p of site.pages || []) {
    await put(`${p.appDir}/page.tsx`, pageFile(site, p));
  }

  for (const [rel, content] of apiLayer.files.entries()) {
    await put(rel, content);
  }

  if (hooks && typeof hooks.emit === 'function') {
    await hooks.emit('afterProject', { root, files, site });
  }

  return {
    root,
    files,
    assets: (site.crawl && site.crawl.assets && site.crawl.assets.saved && site.crawl.assets.saved.length) || 0,
    mocks: apiLayer.count,
    rewrites: apiLayer.rewrites,
  };
}
