#!/usr/bin/env node
// site-blueprint: URL -> Playwright crawl -> design system -> LLM -> SITE_CLONE_BLUEPRINT.md
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Нужен Node.js 20.12+ (сейчас ${process.versions.node}).`);
  process.exit(1);
}
const { main } = await import('../src/cli.mjs');
try {
  const code = await main(process.argv.slice(2));
  process.exit(code ?? 0);
} catch (e) {
  console.error('\n✖ ' + ((e && e.stack) || e));
  process.exit(1);
}
