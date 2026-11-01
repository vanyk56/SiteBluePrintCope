// Minimal robots.txt parser (Allow/Disallow with * and $, longest match wins) + sitemap.xml reader.
const UA = 'site-blueprint';
// crawlers of AI companies: "Disallow: /" for them means the owner objects to AI use of the content
const AI_BOTS = ['gptbot', 'chatgpt-user', 'oai-searchbot', 'claudebot', 'claude-web', 'claude-user', 'claude-searchbot', 'anthropic-ai', 'google-extended', 'ccbot', 'perplexitybot', 'perplexity-user', 'bytespider', 'applebot-extended', 'meta-externalagent', 'facebookbot', 'cohere-ai', 'diffbot', 'amazonbot', 'youbot', 'deepseekbot', 'mistralai-user', 'ai2bot', 'omgili', 'timpibot', 'imagesiftbot'];

export function parseRobots(text) {
  const groups = []; let cur = null; const sitemaps = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim(); if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!cur || cur.rules.length || cur.delay !== undefined) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (k === 'allow' || k === 'disallow') { if (cur && v) cur.rules.push({ allow: k === 'allow', path: v, re: toRe(v) }); }
    else if (k === 'crawl-delay') { if (cur) cur.delay = parseFloat(v); }
    else if (k === 'sitemap') sitemaps.push(v);
  }
  const group = groups.find((g) => g.agents.some((a) => a.includes(UA))) || groups.find((g) => g.agents.includes('*'));
  const aiBlocked = [...new Set(groups.filter((g) => g.rules.some((r) => !r.allow && r.path === '/')).flatMap((g) => g.agents).filter((a) => AI_BOTS.some((b) => a.includes(b))))];
  const rules = group ? group.rules : [];
  return {
    rules: rules.length, sitemaps, aiBlocked, delay: group && Number.isFinite(group.delay) ? group.delay : undefined,
    allowed(url) {
      let p; try { const u = new URL(url); p = (u.pathname || '/') + u.search; } catch { return true; }
      let best = null;
      for (const r of rules) if (r.re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
      return !best || best.allow;
    },
  };
}
function toRe(pattern) {
  let s = pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (s.endsWith('$')) s = s.slice(0, -1) + '$'; else s += '';
  return new RegExp('^' + s);
}

export async function loadRobots(request, origin) {
  try {
    const r = await request.get(origin + '/robots.txt', { timeout: 15000, maxRedirects: 3 });
    if (!r.ok()) return { ...parseRobots(''), status: r.status() };
    const ct = r.headers()['content-type'] || '';
    const text = await r.text();
    if (/html/i.test(ct) && /<html/i.test(text)) return { ...parseRobots(''), status: 'html' };
    return { ...parseRobots(text), status: r.status() };
  } catch (e) { return { ...parseRobots(''), status: 'error' }; }
}

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
export async function sitemapUrls(request, candidates, limit = 200) {
  const out = []; const queue = [...new Set(candidates)]; let fetched = 0;
  while (queue.length && fetched < 6 && out.length < limit) {
    const u = queue.shift(); fetched++;
    if (/\.gz($|\?)/i.test(u)) continue;
    try {
      const r = await request.get(u, { timeout: 15000, maxRedirects: 3 });
      if (!r.ok()) continue;
      const text = await r.text();
      const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
      if (/<sitemapindex/i.test(text)) queue.push(...locs.slice(0, 5)); else out.push(...locs);
    } catch {}
  }
  return out.slice(0, limit);
}
