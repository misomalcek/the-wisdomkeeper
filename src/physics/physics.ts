import RAPIER from '@dimforge/rapier3d-compat';
import { G, KCC } from './profiles';

export { RAPIER };

let ready: Promise<void> | null = null;
/** Compile the Rapier WASM module once (it is inlined, so no extra request on GitHub Pages). */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

/** Collision layers: membership bits in the high half, filter bits in the low half. */
export const LAYER = {
  terrain: 1 << 0,
  static: 1 << 1,
  platform: 1 << 2,
  player: 1 << 3,
  debris: 1 << 4,
  pod: 1 << 5,
} as const;
const ALL = 0xffff;
export const groups = (member: number, filter = ALL) => ((member & 0xffff) << 16) | (filter & 0xffff);
/** Everything the hero can stand on or bump into. */
export const SOLID = LAYER.terrain | LAYER.static | LAYER.platform | LAYER.debris | LAYER.pod;
/** World geometry that should stop a ray (camera, tether, ground probe); excludes loose debris. */
export const WORLD = LAYER.terrain | LAYER.static | LAYER.platform;

export type HeightFn = (x: number, z: number) => number;

export const FIXED_DT = 1 / 60;
const CHUNK = 24;
const CHUNK_RES = 24;
const CHUNK_RINGS = 2;

export interface GroundHit {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  collider: RAPIER.Collider | null;
}

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  grounded: boolean;
  /** true when an upward move was cut short by a ceiling */
  ceiling: boolean;
  /** true when the horizontal move was mostly blocked */
  blocked: boolean;
}

/** Something that moves under Rapier and wants a callback after each fixed step (debris, platforms). */
export interface Stepper {
  /** Called before each fixed physics step. */
  pre?(dt: number, t: number): void;
  /** Called once per frame after stepping, with the interpolation factor. */
  sync?(alpha: number): void;
}

const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

/**
 * One Rapier world per region. Terrain is streamed as small heightfield chunks around the hero, static
 * props are fixed bodies, platforms are kinematic, debris is dynamic. Physics drives rendering, never the reverse.
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly heightAt: HeightFn;
  readonly char: Character;
  private chunks = new Map<number, RAPIER.Collider>();
  private steppers: Stepper[] = [];
  private acc = 0;
  time = 0;
  /** Interpolation factor between the last two fixed steps. */
  alpha = 0;
  private colliderTags = new Map<number, unknown>();

  constructor(heightAt: HeightFn, gravity = G) {
    this.heightAt = heightAt;
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    this.world.timestep = FIXED_DT;
    this.char = new Character(this);
  }

  // ---------------------------------------------------------------- terrain streaming

  private chunkKey(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096);
  }

  /** Make sure heightfield chunks exist around (x, z). Builds at most `budget` chunks per call. */
  streamTerrain(x: number, z: number, budget = 3) {
    const ci = Math.floor(x / CHUNK);
    const cj = Math.floor(z / CHUNK);
    let built = 0;
    for (let r = 0; r <= CHUNK_RINGS && built < budget; r++) {
      for (let i = ci - r; i <= ci + r && built < budget; i++) {
        for (let j = cj - r; j <= cj + r && built < budget; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          const k = this.chunkKey(i, j);
          if (this.chunks.has(k)) continue;
          this.chunks.set(k, this.buildChunk(i, j));
          built++;
        }
      }
    }
    // drop chunks well outside the ring (hysteresis of one chunk)
    for (const [k, c] of this.chunks) {
      const i = Math.floor(k / 8192) - 4096;
      const j = (k % 8192) - 4096;
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) > CHUNK_RINGS + 1) {
        this.world.removeCollider(c, false);
        this.chunks.delete(k);
      }
    }
  }

  /** Build every chunk around (x, z) at once (spawn, teleport). */
  primeTerrain(x: number, z: number) {
    this.streamTerrain(x, z, 999);
  }

  /** Build terrain around (x, z) and step once so the colliders are visible to queries immediately. */
  prime(x: number, z: number) {
    this.primeTerrain(x, z);
    this.world.step();
  }

  get terrainChunks() {
    return this.chunks.size;
  }

  private buildChunk(i: number, j: number) {
    const n = CHUNK_RES;
    const heights = new Float32Array((n + 1) * (n + 1));
    const x0 = i * CHUNK;
    const z0 = j * CHUNK;
    const step = CHUNK / n;
    // Rapier stores heights column-major: rows run along z, columns along x.
    for (let col = 0; col <= n; col++) {
      for (let row = 0; row <= n; row++) {
        heights[row + col * (n + 1)] = this.heightAt(x0 + col * step, z0 + row * step);
      }
    }
    const desc = RAPIER.ColliderDesc.heightfield(n, n, heights, { x: CHUNK, y: 1, z: CHUNK })
      .setTranslation(x0 + CHUNK / 2, 0, z0 + CHUNK / 2)
      .setFriction(0.9)
      .setCollisionGroups(groups(LAYER.terrain));
    return this.world.createCollider(desc);
  }

  // ---------------------------------------------------------------- bodies

  /** A fixed vertical cylinder from the ground up (tree trunks, monoliths, pylons). */
  addPillar(x: number, z: number, r: number, height = 9, y0?: number) {
    const base = y0 ?? this.heightAt(x, z) - 1;
    const desc = RAPIER.ColliderDesc.cylinder(height / 2, r)
      .setTranslation(x, base + height / 2, z)
      .setCollisionGroups(groups(LAYER.static));
    return this.world.createCollider(desc);
  }

  removeCollider(c: RAPIER.Collider) {
    this.colliderTags.delete(c.handle);
    this.world.removeCollider(c, false);
  }

  addFixed(desc: RAPIER.ColliderDesc, layer: number = LAYER.static, tag?: unknown) {
    const c = this.world.createCollider(desc.setCollisionGroups(groups(layer)));
    if (tag !== undefined) this.colliderTags.set(c.handle, tag);
    return c;
  }

  tag(c: RAPIER.Collider, value: unknown) {
    this.colliderTags.set(c.handle, value);
  }
  tagOf<T = unknown>(c: RAPIER.Collider | null | undefined): T | undefined {
    return c ? (this.colliderTags.get(c.handle) as T | undefined) : undefined;
  }
  untag(c: RAPIER.Collider) {
    this.colliderTags.delete(c.handle);
  }

  addStepper(s: Stepper) {
    this.steppers.push(s);
  }

  // ---------------------------------------------------------------- queries

  /** First solid surface straight below (x, y, z), or the analytic terrain if no collider is loaded there. */
  groundBelow(x: number, y: number, z: number, maxDist = 60, out?: GroundHit): GroundHit {
    const o = out ?? { y: 0, nx: 0, ny: 1, nz: 0, collider: null };
    _ray.origin = { x, y, z };
    _ray.dir = { x: 0, y: -1, z: 0 };
    const hit = this.world.castRayAndGetNormal(_ray, maxDist, true, undefined, groups(LAYER.player, WORLD), this.char.collider);
    const th = this.heightAt(x, z);
    if (hit && y - hit.timeOfImpact >= th - 0.05) {
      o.y = y - hit.timeOfImpact;
      o.nx = hit.normal.x;
      o.ny = hit.normal.y;
      o.nz = hit.normal.z;
      o.collider = hit.collider;
    } else {
      o.y = th;
      o.nx = 0;
      o.ny = 1;
      o.nz = 0;
      o.collider = null;
    }
    return o;
  }

  /** Distance along (dx,dy,dz) (unit) to the first world surface, or maxDist. */
  rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, mask: number = WORLD) {
    _ray.origin = { x: ox, y: oy, z: oz };
    _ray.dir = { x: dx, y: dy, z: dz };
    const hit = this.world.castRay(_ray, maxDist, true, undefined, groups(LAYER.player, mask), this.char.collider);
    return hit ? hit.timeOfImpact : maxDist;
  }

  /** Ray cast that also reports the collider (tether, aiming). */
  rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, mask: number = WORLD) {
    _ray.origin = { x: ox, y: oy, z: oz };
    _ray.dir = { x: dx, y: dy, z: dz };
    const hit = this.world.castRayAndGetNormal(_ray, maxDist, true, undefined, groups(LAYER.player, mask), this.char.collider);
    if (!hit) return null;
    return { t: hit.timeOfImpact, collider: hit.collider, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
  }

  // ---------------------------------------------------------------- stepping

  /** Advance the simulation by a frame's worth of time in fixed 60 Hz steps (max 4 per frame). */
  step(dt: number) {
    this.acc = Math.min(this.acc + dt, FIXED_DT * 4);
    let n = 0;
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this.time += FIXED_DT;
      for (const s of this.steppers) s.pre?.(FIXED_DT, this.time);
      this.world.step();
      n++;
    }
    this.alpha = this.acc / FIXED_DT;
    for (const s of this.steppers) s.sync?.(this.alpha);
    return n;
  }

  dispose() {
    this.char.dispose();
    this.world.free();
    this.chunks.clear();
    this.steppers = [];
    this.colliderTags.clear();
  }
}

/**
 * The hero's kinematic character controller (infographic: "kinematic position-based rigid body with capsule
 * collider", "custom height & gravity controller", "move-and-slide & autostepping logic").
 * Rapier's controller does not simulate gravity, so the caller integrates vertical velocity and hands us a
 * per-frame translation; we return where the capsule may actually go.
 */
export class Character {
  readonly radius = 0.38;
  readonly halfHeight = 0.52;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  private phys: Physics;
  private snap = true;
  private out: MoveResult = { x: 0, y: 0, z: 0, grounded: false, ceiling: false, blocked: false };
  private groundCollider: RAPIER.Collider | null = null;

  constructor(phys: Physics) {
    this.phys = phys;
    const w = phys.world;
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius)
        .setTranslation(0, 50, 0)
        .setCollisionGroups(groups(LAYER.player, SOLID)),
    );
    const c = w.createCharacterController(KCC.offset);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setMaxSlopeClimbAngle(KCC.maxSlopeClimb);
    c.setMinSlopeSlideAngle(KCC.minSlopeSlide);
    // dynamic bodies are pushed, not stepped onto (Grounding Report §3.2)
    c.enableAutostep(KCC.autostepHeight, KCC.autostepWidth, KCC.autostepDynamic);
    c.enableSnapToGround(KCC.snapToGround);
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setCharacterMass(70);
    c.setNormalNudgeFactor(0.0001);
    this.controller = c;
  }

  /** Feet-to-centre offset of the capsule. */
  get centerOffset() {
    return this.halfHeight + this.radius;
  }

  /** Teleport the capsule (feet position). */
  place(x: number, y: number, z: number) {
    this.collider.setTranslation({ x, y: y + this.centerOffset, z });
  }

  setSnap(on: boolean) {
    if (on === this.snap) return;
    this.snap = on;
    if (on) this.controller.enableSnapToGround(KCC.snapToGround);
    else this.controller.disableSnapToGround();
  }

  /** The collider the hero last stood on (for riding platforms). */
  get ground() {
    return this.groundCollider;
  }

  /**
   * Move the capsule (feet at x,y,z) by (dx,dy,dz), sliding along walls and stepping up small ledges.
   */
  move(x: number, y: number, z: number, dx: number, dy: number, dz: number, dt: number): MoveResult {
    const c = this.controller;
    this.place(x, y, z);
    c.computeColliderMovement(this.collider, { x: dx, y: dy, z: dz }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(LAYER.player, SOLID));
    const m = c.computedMovement();
    const o = this.out;
    o.x = x + m.x;
    o.y = y + m.y;
    o.z = z + m.z;
    o.grounded = c.computedGrounded();
    o.ceiling = dy > 0.001 && m.y < dy * 0.5;
    const want = Math.hypot(dx, dz);
    o.blocked = want > 0.02 && Math.hypot(m.x, m.z) < want * 0.35;
    this.groundCollider = null;
    if (o.grounded) {
      for (let i = 0; i < c.numComputedCollisions(); i++) {
        const col = c.computedCollision(i);
        if (col && col.normal1.y > 0.5 && col.collider) {
          this.groundCollider = col.collider;
          break;
        }
      }
    }
    this.place(o.x, o.y, o.z);
    void dt;
    return o;
  }

  dispose() {
    this.phys.world.removeCharacterController(this.controller);
  }
}
