/* site-blueprint API hook — MAIN world. Registered at document_start (reload / site crawl) or injected on demand.
 * Wraps fetch() and XMLHttpRequest to keep copies of textual responses (JSON, GraphQL, text) of THIS tab, so the
 * CLI can generate mock route handlers. It only observes: requests are not changed, delayed or blocked.
 * Credentials never leave the page: Authorization / Cookie / API-key headers are dropped right here, bodies are
 * redacted again by the extension and by the CLI. Hard caps: 400 responses, 2 MB each, 40 MB in total. */
(() => {
  'use strict';
  if (window.__sbApi) return;
  const MAX_ENTRIES = 400, MAX_BODY = 2e6, MAX_TOTAL = 40e6, MAX_REQ = 20000;
  const SECRET = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token|x-goog-api-key|x-client-secret)$/i;
  const TEXTUAL = /json|graphql|text\/plain|text\/csv|x-ndjson|xml/i;
  const STATIC = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|map)(\?|$)/i;
  const entries = []; let total = 0; let dropped = 0;
  const push = (e) => {
    if (entries.length >= MAX_ENTRIES || total + (e.body || '').length > MAX_TOTAL) { dropped++; return; }
    total += (e.body || '').length; entries.push(e);
  };
  const headersObj = (h) => {
    const out = {};
    try {
      if (!h) return out;
      const it = typeof h.forEach === 'function' && !Array.isArray(h) ? (f) => h.forEach((v, k) => f(k, v)) : (f) => (Array.isArray(h) ? h : Object.entries(h)).forEach(([k, v]) => f(k, v));
      it((k, v) => { if (!SECRET.test(String(k))) out[String(k).toLowerCase()] = String(v).slice(0, 500); });
    } catch (e) {}
    return out;
  };
  const absUrl = (u) => { try { return new URL(String(u), location.href).href; } catch (e) { return null; } };
  const reqBody = (b) => (typeof b === 'string' ? b.slice(0, MAX_REQ) : b instanceof URLSearchParams ? b.toString().slice(0, MAX_REQ) : null);

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function fetch(input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const req = typeof Request === 'function' && input instanceof Request ? input : null;
        const url = absUrl(req ? req.url : input && input.href ? input.href : input);
        const method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
        if (url && /^https?:/i.test(url) && !STATIC.test(url)) {
          const headers = headersObj((init && init.headers) || (req && req.headers));
          const body = reqBody(init && init.body);
          p.then((res) => {
            try {
              const ct = res.headers.get('content-type') || '';
              if (res.type === 'opaque' || !TEXTUAL.test(ct)) return;
              if (+res.headers.get('content-length') > MAX_BODY) return;
              res.clone().text().then((text) => {
                if (text.length <= MAX_BODY) push({ url, method, status: res.status, contentType: ct, requestHeaders: headers, requestBody: body, body: text, encoding: 'utf8', resourceType: 'fetch', ts: Date.now() });
              }, () => {});
            } catch (e) {}
          }, () => {});
        }
      } catch (e) {}
      return p;
    };
    try { Object.defineProperty(window, 'fetch', { value: wrapped, configurable: true, writable: true }); } catch (e) { window.fetch = wrapped; }
  }

  const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (X) {
    const open = X.open, send = X.send, setHeader = X.setRequestHeader;
    X.open = function (method, url) { try { this.__sbReq = { method: String(method || 'GET').toUpperCase(), url: absUrl(url), headers: {} }; } catch (e) {} return open.apply(this, arguments); };
    X.setRequestHeader = function (k, v) { try { if (this.__sbReq && !SECRET.test(String(k))) this.__sbReq.headers[String(k).toLowerCase()] = String(v).slice(0, 500); } catch (e) {} return setHeader.apply(this, arguments); };
    X.send = function (b) {
      try {
        const r = this.__sbReq;
        if (r && r.url && /^https?:/i.test(r.url) && !STATIC.test(r.url)) {
          r.body = reqBody(b);
          this.addEventListener('loadend', () => {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              if (!TEXTUAL.test(ct) || !this.status) return;
              let text = null;
              if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
              else if (this.responseType === 'json') text = JSON.stringify(this.response);
              if (text == null || text.length > MAX_BODY) return;
              push({ url: r.url, method: r.method, status: this.status, contentType: ct, requestHeaders: r.headers, requestBody: r.body, body: text, encoding: 'utf8', resourceType: 'xhr', ts: Date.now() });
            } catch (e) {}
          });
        }
      } catch (e) {}
      return send.apply(this, arguments);
    };
  }
  Object.defineProperty(window, '__sbApi', {
    value: Object.freeze({ drain() { const out = entries.splice(0); total = 0; return out; }, count() { return entries.length; }, dropped() { return dropped; }, since: Date.now() }),
    configurable: true, enumerable: false, writable: false,
  });
})();
