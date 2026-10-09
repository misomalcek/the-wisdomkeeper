import { Vector2 } from 'three';

/**
 * Keyboard + mouse (pointer lock) + touch, collapsed into one polling-friendly state.
 * Conventions: moveVector() returns x = strafe right (+), y = backward (+), like WASD.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseLeft = false;
  mouseRight = false;
  /** Accumulated relative mouse motion since the last consumeLook(). */
  private lookX = 0;
  private lookY = 0;
  /** Touch controls. */
  touchMove = new Vector2();
  touchAttack = false;
  touchAim = false;
  touchActive = false;
  lastDevice: 'mouse' | 'touch' = 'mouse';
  /** When false (tests, or pointer lock refused) mouse look is unavailable and arrows turn the camera. */
  lockWanted = true;
  private target?: HTMLElement;
  private onAnyKey?: () => void;
  private lockListeners: ((locked: boolean) => void)[] = [];

  attach(target: HTMLElement, onAnyKey?: () => void) {
    this.target = target;
    this.onAnyKey = onAnyKey;
    this.lockWanted = !new URLSearchParams(location.search).has('nolock');
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
      this.onAnyKey?.();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseLeft = this.mouseRight = false;
    });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.lastDevice = 'mouse';
      if (this.locked) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      }
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      this.lastDevice = 'mouse';
      if (e.button === 0) {
        this.mouseLeft = true;
        this.pressed.add('MouseLeft');
      }
      if (e.button === 2) {
        this.mouseRight = true;
        this.pressed.add('MouseRight');
      }
      this.onAnyKey?.();
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const l = this.locked;
      if (!l) this.mouseLeft = this.mouseRight = false;
      this.lockListeners.forEach((f) => f(l));
    });
    // A refused request (e.g. Esc is not a user gesture) just leaves the "click to capture" hint up.
    document.addEventListener('pointerlockerror', () => undefined);
  }

  get locked() {
    return !!this.target && document.pointerLockElement === this.target;
  }
  onLockChange(f: (locked: boolean) => void) {
    this.lockListeners.push(f);
  }
  requestLock() {
    if (!this.lockWanted || this.lastDevice === 'touch' || !this.target || this.locked) return;
    try {
      const r = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => undefined);
    } catch {
      /* unsupported: arrow keys still turn the camera */
    }
  }
  releaseLock() {
    if (this.locked) document.exitPointerLock();
  }

  consumeLook(out: Vector2) {
    out.set(this.lookX, this.lookY);
    this.lookX = this.lookY = 0;
    return out;
  }
  addLook(dx: number, dy: number) {
    this.lookX += dx;
    this.lookY += dy;
  }

  isDown(code: string) {
    return this.down.has(code);
  }
  wasPressed(code: string) {
    return this.pressed.has(code);
  }
  press(code: string) {
    this.pressed.add(code);
  }
  endFrame() {
    this.pressed.clear();
  }

  moveVector(out: Vector2): Vector2 {
    let x = 0;
    let y = 0;
    if (this.isDown('KeyA')) x -= 1;
    if (this.isDown('KeyD')) x += 1;
    if (this.isDown('KeyW')) y -= 1;
    if (this.isDown('KeyS')) y += 1;
    x += this.touchMove.x;
    y += this.touchMove.y;
    out.set(x, y);
    if (out.lengthSq() > 1) out.normalize();
    return out;
  }

  get attackHeld() {
    return this.mouseLeft || this.touchAttack || this.isDown('KeyJ');
  }
  get aimHeld() {
    return this.mouseRight || this.touchAim || this.isDown('KeyK');
  }
}
