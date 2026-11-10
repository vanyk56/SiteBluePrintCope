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

// Output folders the MCP resources are listed from: ./output of the client's working directory, the tool's own
// output/ and every base folder a clone was written to during this session (clone_site with outDir).
const outputBases = new Set([path.resolve('output'), path.join(TOOL_DIR, 'output')]);
function rememberOutput(outDir) { if (outDir) outputBases.add(path.dirname(path.resolve(outDir))); }
async function listRuns() {
  const runs = new Map();
  for (const base of outputBases) {
    let dirs = [];
    try { dirs = await fsp.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) if (d.isDirectory() && !runs.has(d.name) && (await exists(path.join(base, d.name, 'data', 'crawl.json')))) runs.set(d.name, path.join(base, d.name));
  }
  return runs;
}

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
    const { lastRun } = await import('../cli.mjs');
    lastRun.outDir = null;
    const code = await main(cliArgs);
    const outDir = lastRun.outDir;
    const res = { ok: code === 0 && !!outDir, exitCode: code, url: start, outDir };
    if (outDir) {
      rememberOutput(outDir);
      const f = async (rel) => ((await exists(path.join(outDir, rel))) ? path.join(outDir, rel) : null);
      Object.assign(res, {
        blueprint: await f('SITE_CLONE_BLUEPRINT.md'), project: await f('project'), verificationReport: await f('VERIFICATION_REPORT.md'),
        designTokens: await f(path.join('data', 'design-tokens.json')), screenshots: await f('screenshots'),
        pages: lastRun.pages, components: lastRun.components, check: lastRun.check,
        next: 'Read the blueprint, then `cd project && npm install && npm run dev`. Use pick_component / extract_design_tokens with fromDir = outDir.',
      });
    }
    return res;
  }

  if (name === 'extract_design_tokens') {
    let outDir = args.fromDir ? path.resolve(String(args.fromDir)) : '';
    if (!outDir && args.url) {
      let url = String(args.url).trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const start = normalizeUrl(url);
      const host = new URL(start).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
      if (!start) throw new Error('Invalid URL: ' + url);
      outDir = path.resolve('output', `${host}-mcp-${Date.now()}`);
      const { crawl } = await import('../crawler.mjs');
      const { createHooks } = await import('../core/hooks.mjs');
      const opts = { ...DEFAULTS, depth: 1, maxPages: 1, mobile: false, verify: false, llm: false };
      const hooks = await createHooks(opts);
      await crawl(start, { ...opts, hooks }, outDir);
      rememberOutput(outDir);
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
    if (!comp) throw new Error(`No component matches "${args.query}". Available: ${site.components.map((c, i) => `${i}: ${c.name} [${c.type}]`).join(', ') || 'none'}`);
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
      const resources = [];
      for (const [run, dir] of await listRuns()) {
        for (const [file, description] of [['SITE_CLONE_BLUEPRINT.md', 'Full reverse-engineering blueprint'], ['VERIFICATION_REPORT.md', 'Build & visual regression report']]) {
          if (await exists(path.join(dir, file))) resources.push({ uri: `blueprint://${run}/${file}`, name: `${run} — ${file}`, mimeType: 'text/markdown', description: `${description} for ${run}` });
        }
      }
      return { jsonrpc: '2.0', id, result: { resources } };
    }
    if (method === 'resources/read') {
      const uri = String((params && params.uri) || '');
      const m = /^blueprint:\/\/([^/]+)\/(SITE_CLONE_BLUEPRINT\.md|VERIFICATION_REPORT\.md)$/.exec(uri);
      if (!m || m[1].includes('..')) throw new Error(`Invalid resource URI: ${uri}`);
      const dir = (await listRuns()).get(m[1]);
      if (!dir) throw new Error(`Unknown resource: ${uri}`);
      const text = await fsp.readFile(path.join(dir, m[2]), 'utf8');
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

export async function startMcpServer({ input = process.stdin, write = null } = {}) {
  // stdout carries JSON-RPC only: everything the pipeline prints goes to stderr
  const origWrite = write || process.stdout.write.bind(process.stdout);
  for (const k of ['log', 'info', 'debug', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

  let useContentLength = false;
  const send = (obj) => {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (useContentLength) origWrite(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    else origWrite(json + '\n');
  };
  // Requests are handled strictly one after another: the pipeline (browser, build, shared node_modules) is not
  // re-entrant, and two interleaved clone_site calls would mix up their results.
  let chain = Promise.resolve();
  const handle = (text) => {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const one = async (msg) => { try { return await handleMcpRequest(msg); } catch (e) { return msg && msg.id != null ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } } : null; } };
    chain = chain.then(async () => {
      if (Array.isArray(parsed)) { const out = (await Promise.all(parsed.map(one))).filter(Boolean); if (out.length) send(out); }
      else send(await one(parsed));
    });
  };

  let buf = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length > 0) {
      if (/^content-length:/i.test(buf.subarray(0, 15).toString('latin1'))) {
        useContentLength = true;
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('latin1'));
        const total = headerEnd + 4 + (m ? parseInt(m[1], 10) : 0);
        if (buf.length < total) break;
        const body = buf.subarray(headerEnd + 4, total).toString('utf8');
        buf = buf.subarray(total);
        if (body.trim()) handle(body);
      } else {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (line) handle(line);
      }
    }
  });
  // the client closed the pipe: finish what is running and exit (no orphaned server processes)
  return new Promise((resolve) => { input.on('end', () => chain.then(() => resolve(0))); });
}
