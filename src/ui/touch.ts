import type { Input } from '../engine/input';

/** Virtual stick + look pad + buttons. Writes straight into Input. */
export function setupTouch(input: Input, onFirstTouch: () => void) {
  const touched = () => {
    input.lastDevice = 'touch';
    input.touchActive = true;
    onFirstTouch();
  };

  // movement stick
  {
    const el = document.getElementById('stick-l')!;
    const knob = el.querySelector('i') as HTMLElement;
    let pid = -1;
    const upd = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      knob.style.transform = `translate(${dx * 36}px, ${dy * 36}px)`;
      input.touchMove.set(dx, dy);
    };
    el.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      el.setPointerCapture(pid);
      touched();
      upd(e);
    });
    el.addEventListener('pointermove', (e) => e.pointerId === pid && upd(e));
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      knob.style.transform = '';
      input.touchMove.set(0, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // camera look: drag anywhere on the right side
  {
    const pad = document.getElementById('look-pad')!;
    let pid = -1;
    let lx = 0;
    let ly = 0;
    pad.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      pad.setPointerCapture(pid);
      lx = e.clientX;
      ly = e.clientY;
      touched();
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      input.addLook((e.clientX - lx) * 1.5, (e.clientY - ly) * 1.5);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === pid) pid = -1;
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  const tap = (id: string, code: string) =>
    document.getElementById(id)!.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      touched();
      input.press(code);
    });
  tap('t-jump', 'Space');
  tap('t-dash', 'ShiftLeft');
  tap('t-q', 'KeyQ');
  tap('t-f', 'KeyF');
  tap('t-r', 'KeyR');
  tap('t-use', 'KeyE');
  tap('t-fly', 'KeyV');
  tap('t-inv', 'Tab');
  tap('t-pause', 'Escape');

  const hold = (id: string, set: (v: boolean) => void, edge?: string) => {
    const el = document.getElementById(id)!;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      touched();
      set(true);
      if (edge) input.press(edge);
    });
    const up = () => set(false);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  hold('t-atk', (v) => (input.touchAttack = v), 'MouseLeft');
  hold('t-aim', (v) => (input.touchAim = v));
}
