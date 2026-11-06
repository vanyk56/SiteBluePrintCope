/* Init script, runs in every frame BEFORE the page's own scripts:
 *   Playwright: context.addInitScript(installHooks)   ·   extension: MAIN-world content script at document_start.
 * Must stay self-contained (it is serialized with Function.prototype.toString). It only observes — nothing on the
 * page is blocked, spoofed or hidden; it gives the extractor/serializer access to things the DOM API does not expose:
 *   1. closed shadow roots      attachShadow({ mode: 'closed' }) → window.__sbShadowOf(host)
 *   2. WebGL canvases           getContext('webgl*') with preserveDrawingBuffer → canvas.toDataURL() is not blank
 *   3. fonts loaded from JS     new FontFace(family, url | ArrayBuffer) → window.__sbFontFaces()
 * CSS-in-JS (insertRule / adoptedStyleSheets) needs no hook: the serializer reads it from the CSSOM directly. */
export function installHooks() {
  const W = window;
  if (W.__sbHooks) return;
  const hide = (obj, key, value) => { try { Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: false }); } catch (e) {} };
  const closed = new WeakMap();
  const fonts = [];
  hide(W, '__sbHooks', { version: 1, since: Date.now() });

  // 1. closed shadow roots
  try {
    const proto = W.Element && W.Element.prototype;
    const orig = proto && proto.attachShadow;
    if (orig) {
      hide(proto, 'attachShadow', function attachShadow(init) {
        const root = orig.call(this, init);
        try { if (init && init.mode === 'closed') closed.set(this, root); } catch (e) {}
        return root;
      });
    }
  } catch (e) {}
  hide(W, '__sbShadowOf', (el) => (el && (el.shadowRoot || closed.get(el))) || null);

  // 2. keep the WebGL drawing buffer so snapshots of 3D canvases are not empty
  try {
    const cproto = W.HTMLCanvasElement && W.HTMLCanvasElement.prototype;
    const getContext = cproto && cproto.getContext;
    if (getContext) {
      hide(cproto, 'getContext', function (type, attrs) {
        if (/^(webgl2?|experimental-webgl)$/i.test(String(type))) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        return getContext.call(this, type, attrs);
      });
    }
  } catch (e) {}

  // 3. FontFace constructed from JS (not present in any stylesheet)
  try {
    const FF = W.FontFace;
    if (typeof FF === 'function') {
      const Wrapped = function FontFace(family, source, descriptors) {
        const face = new FF(family, source, descriptors);
        try {
          const rec = { family: String(family || '').replace(/["']/g, '').trim(), descriptors: {} };
          for (const k of ['weight', 'style', 'stretch', 'unicodeRange', 'display']) if (descriptors && descriptors[k]) rec.descriptors[k] = String(descriptors[k]);
          if (typeof source === 'string') rec.src = source.slice(0, 4000);
          else if (source && source.byteLength && source.byteLength < 4e6) {
            rec.bytes = source instanceof ArrayBuffer ? source.slice(0) : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
          }
          if (fonts.length < 60) fonts.push(rec);
        } catch (e) {}
        return face;
      };
      Wrapped.prototype = FF.prototype;
      try { Object.setPrototypeOf(Wrapped, FF); } catch (e) {}
      hide(W, 'FontFace', Wrapped);
    }
  } catch (e) {}
  const b64 = (buf) => {
    const u8 = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const mime = (buf) => {
    const h = new Uint8Array(buf.slice(0, 4)); const sig = String.fromCharCode(h[0], h[1], h[2], h[3]);
    return sig === 'wOF2' ? 'font/woff2' : sig === 'wOFF' ? 'font/woff' : sig === 'OTTO' ? 'font/otf' : 'font/ttf';
  };
  // [{ family, descriptors, src? (CSS src descriptor), data? (data: URL of the binary source) }]
  hide(W, '__sbFontFaces', () => fonts.map((f) => {
    const out = { family: f.family, descriptors: f.descriptors };
    if (f.src) out.src = f.src;
    if (f.bytes) { try { out.data = `data:${mime(f.bytes)};base64,${b64(f.bytes)}`; } catch (e) {} }
    return out;
  }).filter((f) => f.family && (f.src || f.data)));

  // 4. Web Animations API & scroll-reveal tracking (Element.prototype.animate + initial hidden states)
  const webAnims = [];
  const revealMap = new WeakMap();
  try {
    const proto = W.Element && W.Element.prototype;
    const origAnimate = proto && proto.animate;
    if (origAnimate) {
      hide(proto, 'animate', function animate(keyframes, options) {
        const anim = origAnimate.call(this, keyframes, options);
        try {
          if (webAnims.length < 120) {
            const dur = typeof options === 'number' ? options : (options && +options.duration) || 0;
            const delay = (options && +options.delay) || 0;
            const easing = (options && options.easing) || 'linear';
            const iterations = (options && options.iterations) || 1;
            webAnims.push({ target: this, keyframes, duration: dur, delay, easing: String(easing), iterations });
          }
        } catch (e) {}
        return anim;
      });
    }
  } catch (e) {}
  hide(W, '__sbWebAnims', () => webAnims);
  hide(W, '__sbRevealMap', revealMap);
}

