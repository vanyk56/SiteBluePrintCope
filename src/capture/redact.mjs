// Redaction of secrets and personal data before anything captured from the network is written to disk.
// Mocks end up in a project that is shared with AI coders and pushed to git — tokens, cookies, e-mails and
// phone numbers must never travel with it. Default ON; --no-redact disables it (only for your own test data).

// header names that carry credentials — never stored at all
export const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token|x-goog-api-key|x-client-secret|x-session-id|x-request-signature)$/i;
// object keys / query parameters whose values are secrets
export const SECRET_KEY = /(^|[_\-.])(pass(word|wd)?|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|session(id)?|sessid|sid|cookie|jwt|bearer|signature|sig|hmac|otp|pin|cvv|cvc|csrf|xsrf|nonce|private[_-]?key|client[_-]?secret)$/i;
const SECRET_KEY_LOOSE = /(password|secret|token|apikey|api_key|private_key|client_secret|credit_?card|card_?number|cvv|iban|ssn|passport|snils|inn)/i;
// keys that hold personal data — values are replaced by stable fake ones
const EMAIL_KEY = /e-?mail/i;
const PHONE_KEY = /(phone|tel|mobile|msisdn|whatsapp)/i;
const NAME_KEY = /^(first_?name|last_?name|middle_?name|full_?name|surname|patronymic|given_?name|family_?name|customer_?name|user_?name|username|login|nickname)$/i;
const ADDR_KEY = /^(address|street|address_?line\d?|zip|postcode|postal_?code|ip|ip_?address|lat|lng|latitude|longitude|birth_?date|dob|birthday)$/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
const KEYLIKE_RE = /\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr]|AKIA|AIza)[A-Za-z0-9_-]{14,}\b/g;
const PHONE_RE = /(?<![\w.])\+?\d{1,3}[\s(.-]{0,2}\d{3}[\s).-]{0,2}\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\w.])/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits) {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = +digits[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
}

export class Redactor {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled; this.count = 0; this.kinds = {};
    this.emails = new Map(); this.phones = new Map(); this.names = new Map();
  }
  _hit(kind) { this.count++; this.kinds[kind] = (this.kinds[kind] || 0) + 1; }
  _fakeEmail(v) { if (!this.emails.has(v)) this.emails.set(v, `user${this.emails.size + 1}@example.com`); return this.emails.get(v); }
  _fakePhone(v) { if (!this.phones.has(v)) this.phones.set(v, `+1 555 010-${String(this.phones.size + 1).padStart(2, '0')}-00`); return this.phones.get(v); }
  _fakeName(v) { if (!this.names.has(v)) this.names.set(v, `User ${this.names.size + 1}`); return this.names.get(v); }
  // free text: tokens, e-mails, phones, card numbers
  text(s) {
    if (!this.enabled || typeof s !== 'string' || !s) return s;
    let out = s;
    out = out.replace(JWT_RE, () => { this._hit('jwt'); return '[REDACTED_JWT]'; });
    out = out.replace(BEARER_RE, (m, kind) => { this._hit('bearer'); return `${kind} [REDACTED]`; });
    out = out.replace(KEYLIKE_RE, () => { this._hit('api-key'); return '[REDACTED_KEY]'; });
    out = out.replace(EMAIL_RE, (m) => { if (/@example\.(com|org)$/i.test(m)) return m; this._hit('email'); return this._fakeEmail(m.toLowerCase()); });
    out = out.replace(CARD_RE, (m) => { const d = m.replace(/\D/g, ''); if (d.length < 13 || d.length > 19 || !luhn(d) || /^(\d)\1+$/.test(d)) return m; this._hit('card'); return '[REDACTED_CARD]'; });
    out = out.replace(PHONE_RE, (m) => { const d = m.replace(/\D/g, ''); if (d.length < 10 || d.length > 15 || !/[\s()+.-]/.test(m)) return m; this._hit('phone'); return this._fakePhone(d); });
    return out;
  }
  // value under a known key
  _byKey(key, v) {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'object') return undefined; // recurse into nested objects/arrays
    const secret = SECRET_KEY.test(key) || (typeof v === 'string' && SECRET_KEY_LOOSE.test(key) && !/^(true|false|\d{1,3})$/.test(v));
    if (secret) {
      if (typeof v === 'number' && !/(pin|cvv|cvc|otp)/i.test(key)) return v; // counters like token_count stay
      this._hit('secret'); return '[REDACTED]';
    }
    if (typeof v !== 'string') return v;
    if (EMAIL_KEY.test(key) && v.includes('@')) { this._hit('email'); return this._fakeEmail(v.toLowerCase()); }
    if (PHONE_KEY.test(key) && /\d{5,}|\d[\d\s()+.-]{8,}/.test(v)) { this._hit('phone'); return this._fakePhone(v.replace(/\D/g, '')); }
    if (NAME_KEY.test(key) && v.length > 1 && v.length < 80) { this._hit('name'); return this._fakeName(v); }
    if (ADDR_KEY.test(key) && v.length) { this._hit('address'); return '[REDACTED]'; }
    return undefined;
  }
  // deep copy of JSON with secrets/PII replaced
  json(value, depth = 0) {
    if (!this.enabled) return value;
    if (depth > 40) return value;
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((x) => this.json(x, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const r = this._byKey(k, v);
        out[k] = r !== undefined ? r : this.json(v, depth + 1);
      }
      return out;
    }
    return value;
  }
  // URL: secret query params → [REDACTED], PII in the rest of the URL is masked
  url(u) {
    if (!this.enabled) return u;
    try {
      const x = new URL(u);
      for (const [k, v] of [...x.searchParams]) {
        const r = this._byKey(k, v);
        if (r !== undefined && r !== v) x.searchParams.set(k, String(r));
        else { const t = this.text(v); if (t !== v) x.searchParams.set(k, t); }
      }
      if (x.username || x.password) { x.username = ''; x.password = ''; this._hit('credentials'); }
      return x.href;
    } catch { return this.text(u); }
  }
  // request headers: credential headers are dropped, the rest is kept only if harmless
  headers(h = {}) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (this.enabled && SECRET_HEADERS.test(k)) { this._hit('header'); continue; }
      if (/^(content-type|accept|x-requested-with|apollo-require-preflight|x-apollo-operation-name|graphql-operation)$/i.test(k)) out[k.toLowerCase()] = this.enabled ? this.text(String(v)) : v;
    }
    return out;
  }
  report() { return { enabled: this.enabled, replaced: this.count, kinds: { ...this.kinds } }; }
}
