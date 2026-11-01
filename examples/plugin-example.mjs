// Example plugin for site-blueprint (website-scraper-style "actions").
//   site-blueprint https://example.com --plugin ./examples/plugin-example.mjs
// or SB_PLUGINS=./examples/plugin-example.mjs. Every hook is optional; errors are logged and never stop the crawl.
// Hook list and payloads: src/core/hooks.mjs → HOOKS.
import path from 'node:path';

export default {
  name: 'example-plugin',
  hooks: {
    // stop the crawler from loading heavy third-party embeds (applies to the page and all its sub-requests)
    beforeRequest({ url, resourceType }) {
      if (resourceType === 'media' && /\.(mp4|webm)(\?|$)/i.test(url)) return { abort: true };
      return undefined; // continue as usual
    },
    // custom file names: (previous plugin's answer | null, { url, kind, category, ext, hint, base }) → name without extension
    generateFilename(prev, { category, base }) {
      if (category === 'images') return `img-${prev || base}`; // public/images/img-hero.jpg
      return prev; // null → keep the default clean name
    },
    onAssetError({ url, error }) {
      console.warn(`[example-plugin] asset failed: ${url} — ${error}`);
    },
    // add a banner comment to every generated TSX file
    beforeWrite(text, { file }) {
      if (file.endsWith('.tsx') && !text.startsWith("'use client'")) return `// cloned with permission of the site owner\n${text}`;
      return text;
    },
    afterFinish({ outDir, check }) {
      console.log(`[example-plugin] done → ${path.join(outDir, 'SITE_CLONE_BLUEPRINT.md')}${check ? ' · ' + check.summaryLine : ''}`);
    },
  },
};
