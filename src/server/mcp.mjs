// Model Context Protocol (MCP) stdio server for Cursor, Claude Code, Windsurf, and Claude Desktop.
// Exposes site-blueprint tools over JSON-RPC 2.0 (supports both newline-delimited JSON and Content-Length framing).
import path from 'node:path';
import fsp from 'node:fs/promises';
import { TOOL_DIR, DEFAULTS } from '../config.mjs';
import { exists, readJSON, normalizeUrl } from '../util.mjs';

const pkg = JSON.parse(await fsp.readFile(path.join(TOOL_DIR, 'package.json'), 'utf8'));

export const MCP_TOOLS = [
  {
    name: 'clone_site',
    description: 'Clone a live website URL into a standalone Next.js 16 + React 19 + Tailwind CSS v4 project with Mock API, design tokens, and SITE_CLONE_BLUEPRINT.md.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Website URL to clone (e.g. https://cursor.com)' },
        depth: { type: 'number', description: 'Link crawl depth (default: 1)', default: 1 },
        maxPages: { type: 'number', description: 'Maximum pages to crawl (default: 1)', default: 1 },
        outDir: { type: 'string', description: 'Output base directory (default: output)' },
        verify: { type: 'boolean', description: 'Run next build & visual verification (default: false for fast MCP calls)', default: false },
        llm: { type: 'boolean', description: 'Run LLM analysis (default: false)', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'extract_design_tokens',
    description: 'Extract design-system tokens (colors, fonts, shadows, radii, layout breakpoints, and sections) from a crawl directory or URL.',
    inputSchema: {
      type: 'object',
      properties: {
        fromDir: { type: 'string', description: 'Path to an existing site-blueprint output folder (containing data/crawl.json)' },
        url: { type: 'string', description: 'Live URL to crawl (1 page) if fromDir is not provided' },
      },
    },
  },
  {
    name: 'pick_component',
    description: 'Extract a standalone React + Tailwind CSS (.tsx) component from a crawl output directory by section type (hero, pricing, header, footer, features, faq), name, or index.',
    inputSchema: {
      type: 'object',
      properties: {
        fromDir: { type: 'string', description: 'Path to an existing site-blueprint output folder' },
        query: { type: 'string', description: 'Section type (e.g. "hero", "pricing"), component name, heading text, or index (0, 1, ...)' },
      },
      required: ['fromDir'],
    },
  },
  {
    name: 'heal_project',
    description: 'Run the self-healing Next.js build loop on a site-blueprint output directory to automatically fix build/JSX/CSS errors.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Path to the output directory or project/ directory' },
        iterations: { type: 'number', description: 'Max healing iterations (default: 3)', default: 3 },
      },
      required: ['dir'],
    },
  },
  {
    name: 'verify_clone',
    description: 'Compare a running Next.js clone against the original crawl screenshots using section-aligned pixelmatch and layout IoU.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Path to the site-blueprint output directory' },
        url: { type: 'string', description: 'URL of the running clone (default: http://localhost:3000)', default: 'http://localhost:3000' },
      },
      required: ['dir'],
    },
  },
];

export async function handleMcpToolCall(name, args = {}) {
  if (name === 'clone_site') {
    let url = String(args.url || '').trim();
    if (!url) throw new Error('url is required');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const start = normalizeUrl(url);
    if (!start) throw new Error('Invalid URL: ' + url);
    const { main } = await import('../cli.mjs');
    const cliArgs = [
      start,
      '--depth', String(args.depth ?? 1),
      '--max-pages', String(args.maxPages ?? 1),
      '--no-zip',
    ];
    if (args.outDir) cliArgs.push('--out', String(args.outDir));
    if (!args.verify) cliArgs.push('--no-verify');
    if (!args.llm) cliArgs.push('--no-llm');
    const code = await main(cliArgs);
    return { ok: code === 0, exitCode: code, url: start };
  }

  if (name === 'extract_design_tokens') {
    let outDir = args.fromDir ? path.resolve(String(args.fromDir)) : '';
    if (!outDir && args.url) {
      let url = String(args.url).trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const start = normalizeUrl(url);
      const host = new URL(start).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
      outDir = path.resolve('output', `${host}-mcp-${Date.now()}`);
      const { crawl } = await import('../crawler.mjs');
      const { createHooks } = await import('../core/hooks.mjs');
      const opts = { ...DEFAULTS, depth: 1, maxPages: 1, mobile: false, verify: false, llm: false };
      const hooks = await createHooks(opts);
      await crawl(start, { ...opts, hooks }, outDir);
    }
    if (!outDir || !(await exists(path.join(outDir, 'data', 'crawl.json')))) {
      throw new Error('Provide a valid fromDir containing data/crawl.json or a live url');
    }
    const { loadCrawl, buildSite } = await import('../analyze/site.mjs');
    const site = buildSite(await loadCrawl(outDir), DEFAULTS);
    return {
      origin: site.origin,
      outDir,
      breakpoint: site.bp,
      colors: site.tokens.colors,
      roles: site.tokens.roles,
      fonts: site.tokens.fonts,
      radii: site.tokens.radii,
      shadows: site.tokens.shadows,
      components: site.components.map((c) => ({ name: c.name, type: c.type, file: c.file, heading: c.heading || null })),
    };
  }

  if (name === 'pick_component') {
    const outDir = path.resolve(String(args.fromDir || ''));
    if (!(await exists(path.join(outDir, 'data', 'crawl.json')))) {
      throw new Error(`No data/crawl.json found in ${outDir}`);
    }
    const { loadCrawl, buildSite } = await import('../analyze/site.mjs');
    const { pickSiteComponent } = await import('../analyze/picker.mjs');
    const site = buildSite(await loadCrawl(outDir), DEFAULTS);
    const comp = pickSiteComponent(site, args.query || '');
    if (!comp) throw new Error('No matching component found');
    return {
      name: comp.name,
      type: comp.type,
      file: comp.file,
      heading: comp.heading || null,
      availableComponents: site.components.map((c, i) => ({ index: i, name: c.name, type: c.type, heading: c.heading || null })),
      code: comp.code,
    };
  }

  if (name === 'heal_project') {
    const rawDir = path.resolve(String(args.dir || '.'));
    const projectRoot = (await exists(path.join(rawDir, 'project', 'package.json'))) ? path.join(rawDir, 'project') : rawDir;
    const outDir = path.basename(projectRoot) === 'project' ? path.dirname(projectRoot) : rawDir;
    const { ensureDeps, healProject } = await import('../verify/build.mjs');
    const deps = await ensureDeps(projectRoot, { mode: 'shared', outDir });
    if (!deps.ok) return { ok: false, reason: deps.reason };
    const build = await healProject(projectRoot, { iterations: args.iterations ?? 3, outDir });
    return { ok: build.ok, iterations: build.iterations, history: build.history };
  }

  if (name === 'verify_clone') {
    const outDir = path.resolve(String(args.dir || '.'));
    const { verify } = await import('../verify/index.mjs');
    const code = await verify(outDir, { ...DEFAULTS, url: args.url || 'http://localhost:3000' });
    const reportPath = path.join(outDir, 'verify', 'report.json');
    const report = (await exists(reportPath)) ? await readJSON(reportPath) : null;
    return { ok: code === 0, exitCode: code, report };
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

export async function handleMcpRequest(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) return null;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'site-blueprint', version: pkg.version },
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }
    if (method === 'resources/list') {
      const outBase = path.join(TOOL_DIR, 'output');
      const resources = [];
      try {
        const dirs = await fsp.readdir(outBase, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const bp = path.join(outBase, d.name, 'SITE_CLONE_BLUEPRINT.md');
          if (await exists(bp)) {
            resources.push({
              uri: `blueprint://${d.name}/SITE_CLONE_BLUEPRINT.md`,
              name: `${d.name} — SITE_CLONE_BLUEPRINT.md`,
              mimeType: 'text/markdown',
              description: `Full reverse-engineering blueprint for ${d.name}`,
            });
          }
          const vr = path.join(outBase, d.name, 'VERIFICATION_REPORT.md');
          if (await exists(vr)) {
            resources.push({
              uri: `blueprint://${d.name}/VERIFICATION_REPORT.md`,
              name: `${d.name} — VERIFICATION_REPORT.md`,
              mimeType: 'text/markdown',
              description: `Build & visual regression report for ${d.name}`,
            });
          }
        }
      } catch {}
      return { jsonrpc: '2.0', id, result: { resources } };
    }
    if (method === 'resources/read') {
      const uri = String((params && params.uri) || '');
      const m = /^blueprint:\/\/([^/]+)\/(SITE_CLONE_BLUEPRINT\.md|VERIFICATION_REPORT\.md)$/.exec(uri);
      if (!m || m[1].includes('..')) throw new Error(`Invalid resource URI: ${uri}`);
      const file = path.join(TOOL_DIR, 'output', m[1], m[2]);
      const text = await fsp.readFile(file, 'utf8');
      return {
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
      };
    }
    if (method === 'prompts/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          prompts: [
            {
              name: 'clone-website-1to1',
              description: 'Master prompt for cloning a website 1:1 into Next.js 16 + React 19 + Tailwind CSS v4 using site-blueprint.',
              arguments: [{ name: 'url', description: 'Target website URL', required: true }],
            },
          ],
        },
      };
    }
    if (method === 'prompts/get') {
      const url = (params && params.arguments && params.arguments.url) || 'https://example.com';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: `1:1 Next.js clone workflow for ${url}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Используй MCP-инструмент clone_site для ${url}, затем прочитай SITE_CLONE_BLUEPRINT.md и VERIFICATION_REPORT.md, доведи все секции в project/ до 99%+ визуального сходства и проверь через verify_clone.`,
              },
            },
          ],
        },
      };
    }
    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const res = await handleMcpToolCall(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res, null, 2) }],
          },
        };
      } catch (toolErr) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: String((toolErr && toolErr.message) || toolErr) }],
          },
        };
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: String((err && err.message) || err) },
    };
  }
}

export async function startMcpServer() {
  // Redirect console.log to stderr so stdout remains pure JSON-RPC
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a) => process.stderr.write(a.join(' ') + '\n');

  let useContentLength = false;
  const send = (obj) => {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (useContentLength) {
      origWrite(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      origWrite(json + '\n');
    }
  };

  let buf = Buffer.alloc(0);
  process.stdin.on('data', async (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length > 0) {
      const str = buf.toString('utf8');
      if (str.startsWith('Content-Length:')) {
        useContentLength = true;
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buf.subarray(0, headerEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        const len = m ? parseInt(m[1], 10) : 0;
        const total = headerEnd + 4 + len;
        if (buf.length < total) break;
        const body = buf.subarray(headerEnd + 4, total).toString('utf8');
        buf = buf.subarray(total);
        try {
          const parsed = JSON.parse(body);
          const resp = await handleMcpRequest(parsed);
          if (resp) send(resp);
        } catch {}
      } else {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const resp = await handleMcpRequest(parsed);
          if (resp) send(resp);
        } catch {}
      }
    }
  });

  return new Promise(() => {});
}
