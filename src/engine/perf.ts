/**
 * Lightweight frame profiler (P1-H). Always records (a few ring-buffer writes per frame); the overlay only shows
 * with `?perf`. Numbers it reports:
 *  - frame: rAF interval in ms (what the player feels),
 *  - cpu: time spent inside our frame callback (simulation + render submission),
 *  - named sections (stream, …) so streaming hitches are visible on their own.
 */
const N = 600;

class Series {
  readonly buf = new Float32Array(N);
  n = 0;
  i = 0;
  push(v: number) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % N;
    if (this.n < N) this.n++;
  }
  stats() {
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
    const sum = a.reduce((s, v) => s + v, 0);
    return { n: a.length, avg: a.length ? sum / a.length : 0, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a.length ? a[a.length - 1] : 0 };
  }
  reset() {
    this.n = this.i = 0;
  }
}

export class Perf {
  readonly frame = new Series();
  readonly cpu = new Series();
  private sections = new Map<string, Series>();
  private open = new Map<string, number>();
  private acc = new Map<string, number>();
  private t0 = 0;
  private last = 0;
  /** Frames longer than 33 ms since the last reset. */
  long = 0;

  begin(now = performance.now()) {
    if (this.last) {
      const f = now - this.last;
      this.frame.push(f);
      if (f > 33.4) this.long++;
    }
    this.last = now;
    this.t0 = now;
    this.acc.clear();
  }
  end() {
    this.cpu.push(performance.now() - this.t0);
    for (const [k, s] of this.sections) s.push(this.acc.get(k) ?? 0);
  }
  /** Start a named section; nested calls of the same name are not supported. */
  start(name: string) {
    this.open.set(name, performance.now());
  }
  stop(name: string) {
    const t = this.open.get(name);
    if (t === undefined) return;
    this.acc.set(name, (this.acc.get(name) ?? 0) + performance.now() - t);
    if (!this.sections.has(name)) this.sections.set(name, new Series());
  }
  reset() {
    this.frame.reset();
    this.cpu.reset();
    for (const s of this.sections.values()) s.reset();
    this.long = 0;
  }
  report() {
    const r = (s: ReturnType<Series['stats']>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      frame: r(this.frame.stats()),
      cpu: r(this.cpu.stats()),
      long: this.long,
      sections: Object.fromEntries([...this.sections].map(([k, s]) => [k, r(s.stats())])),
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    };
  }
}

export const perf = new Perf();

/** `?perf` overlay: refreshed twice a second, plain text, no layout cost when hidden. */
export function mountPerfOverlay(extra: () => Record<string, unknown>) {
  if (typeof document === 'undefined' || !new URLSearchParams(location.search).has('perf')) return;
  const el = document.createElement('pre');
  el.id = 'perf-overlay';
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;padding:6px 8px;font:11px/1.35 monospace;color:#bff;background:rgba(0,10,14,.72);border:1px solid #2aa;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  setInterval(() => {
    const r = perf.report();
    const s = Object.entries(r.sections).map(([k, v]) => `${k} ${v.avg.toFixed(2)}/${v.max.toFixed(1)}`).join('  ');
    const x = Object.entries(extra()).map(([k, v]) => `${k} ${v}`).join('  ');
    el.textContent = `frame p50 ${r.frame.p50.toFixed(1)}  p95 ${r.frame.p95.toFixed(1)}  p99 ${r.frame.p99.toFixed(1)}  >33ms ${r.long}\ncpu avg ${r.cpu.avg.toFixed(2)}  p95 ${r.cpu.p95.toFixed(2)}  heap ${r.heapMB ?? '-'}MB\n${s}\n${x}`;
  }, 500);
}
