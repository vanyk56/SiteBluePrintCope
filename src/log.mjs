const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = { dim: c(2), bold: c(1), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36) };
let verbose = false;
const t0 = Date.now();
const ts = () => color.dim(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`);
export const log = {
  setVerbose(v) { verbose = !!v; },
  step: (...a) => console.log(`\n${ts()} ${color.bold(color.magenta('▶ ' + a.join(' ')))}`),
  info: (...a) => console.log(`${ts()} ${color.cyan('•')}`, ...a),
  ok: (...a) => console.log(`${ts()} ${color.green('✓')}`, ...a),
  warn: (...a) => console.log(`${ts()} ${color.yellow('!')}`, ...a),
  error: (...a) => console.error(`${ts()} ${color.red('✗')}`, ...a),
  debug: (...a) => { if (verbose) console.log(`${ts()} ${color.dim('· ' + a.join(' '))}`); },
};
