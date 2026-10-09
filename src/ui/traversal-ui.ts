const $ = (id: string) => document.getElementById(id) as HTMLElement;

export type TravMode = 'walk' | 'levitate' | 'tether' | 'flight';
const ORDER: TravMode[] = ['walk', 'levitate', 'tether', 'flight'];

/**
 * Traversal HUD: the radial mode wheel from the mockups (hold X), the Mycelial Fiber gauge,
 * the current-mode chip and the on-screen tether target marker.
 */
export class TraversalUI {
  isOpen = false;
  private sel: TravMode | null = null;
  private ax = 0;
  private ay = 0;
  private wheel = $('mode-wheel');
  private sectors = Array.from(document.querySelectorAll<HTMLElement>('#mode-wheel .sector'));
  private chip = $('mode-chip');
  private chipName = $('mode-name');
  private mark = $('tether-mark');
  private fiberFill = $('fiber-fill');
  private fiberText = $('fiber-text');
  private tetherAb = $('ab-tether');
  private last = '';

  open(current: TravMode) {
    this.isOpen = true;
    this.ax = this.ay = 0;
    this.sel = current;
    this.wheel.classList.remove('hidden');
    this.paint();
  }

  /** Close the wheel and return the chosen mode (null if nothing was picked). */
  close(): TravMode | null {
    this.isOpen = false;
    this.wheel.classList.add('hidden');
    return this.sel;
  }

  /** Accumulate pointer / stick motion; the sector under the accumulated direction is selected. */
  steer(dx: number, dy: number) {
    this.ax = this.ax * 0.9 + dx;
    this.ay = this.ay * 0.9 + dy;
    if (Math.hypot(this.ax, this.ay) < 8) return;
    // 0 = up (walk), 90 = right (levitate), 180 = down (tether), 270 = left (flight)
    const a = (Math.atan2(this.ax, -this.ay) * 180) / Math.PI;
    const idx = Math.round((((a % 360) + 360) % 360) / 90) % 4;
    if (this.sel !== ORDER[idx]) {
      this.sel = ORDER[idx];
      this.paint();
    }
  }

  setAvailable(avail: Record<TravMode, boolean>) {
    for (const s of this.sectors) s.classList.toggle('off', !avail[s.dataset.mode as TravMode]);
  }

  private paint() {
    for (const s of this.sectors) s.classList.toggle('sel', s.dataset.mode === this.sel);
  }

  /** Next mode for a quick tap (touch MODE button / tapping X). */
  static cycle(m: TravMode): TravMode {
    return m === 'walk' ? 'levitate' : m === 'levitate' ? 'flight' : 'walk';
  }

  hud(s: { fiber: number; maxFiber: number; mode: string; modeClass: string; tetherCd: number; tetherReady: boolean; mark: { x: number; y: number; label: string } | null }) {
    const key = `${Math.round(s.fiber)}|${s.mode}|${s.tetherCd.toFixed(2)}|${s.tetherReady}`;
    if (key !== this.last) {
      this.last = key;
      this.fiberFill.style.transform = `scaleX(${Math.max(0, Math.min(1, s.fiber / s.maxFiber))})`;
      this.fiberText.textContent = `${Math.round(s.fiber)}`;
      this.chipName.textContent = s.mode;
      this.chip.className = s.modeClass;
      this.tetherAb.style.setProperty('--p', String(s.tetherCd));
      this.tetherAb.classList.toggle('ready', s.tetherReady && s.tetherCd <= 0);
      this.tetherAb.classList.toggle('low', !s.tetherReady);
    }
    if (s.mark) {
      this.mark.classList.remove('hidden');
      this.mark.style.left = `${s.mark.x}px`;
      this.mark.style.top = `${s.mark.y}px`;
      const span = this.mark.querySelector('span')!;
      if (span.textContent !== s.mark.label) span.textContent = s.mark.label;
    } else this.mark.classList.add('hidden');
  }
}
