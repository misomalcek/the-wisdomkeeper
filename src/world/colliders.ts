/** Static circle colliders (tree trunks, monoliths, pylons) in a uniform grid. */
interface Circle {
  x: number;
  z: number;
  r: number;
}

const CELL = 10;

export class Colliders {
  private cells = new Map<number, Circle[]>();
  count = 0;

  private key(cx: number, cz: number) {
    return (cx + 512) * 1024 + (cz + 512);
  }

  add(x: number, z: number, r: number) {
    const c = { x, z, r };
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL);
    const z1 = Math.floor((z + r) / CELL);
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const k = this.key(i, j);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
    }
    this.count++;
  }

  /** Pushes (pos) out of any overlapping collider; returns the corrected position. */
  resolve(pos: { x: number; z: number }, radius: number) {
    const cx = Math.floor(pos.x / CELL);
    const cz = Math.floor(pos.z / CELL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const c of list) {
          const dx = pos.x - c.x;
          const dz = pos.z - c.z;
          const min = c.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 < min * min) {
            const d = Math.sqrt(d2) || 0.0001;
            pos.x = c.x + (dx / d) * min;
            pos.z = c.z + (dz / d) * min;
          }
        }
      }
    }
    return pos;
  }
}
