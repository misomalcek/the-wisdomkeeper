/**
 * Locomotion physics profiles, taken from the "Kinematic 3D Movement" blueprint (MovementMode.ts) and the
 * Technical Grounding Report §3.2–3.3. Units are metres and seconds.
 */
export enum TraversalMode {
  GROUND_WALK = 'GROUND_WALK',
  FREE_FLIGHT = 'FREE_FLIGHT',
  AQUATIC_LEVITATION = 'AQUATIC_LEVITATION',
}

export interface PhysicsProfile {
  maxSpeed: number;
  acceleration: number;
  dragDamping: number;
  gravityScale: number;
  slopeLimitAngleRad: number;
  resonanceCostPerSec: number;
  allowStepClimb: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;

export const PHYSICS_PROFILES: Record<TraversalMode, PhysicsProfile> = {
  [TraversalMode.GROUND_WALK]: {
    maxSpeed: 8.5, acceleration: 45, dragDamping: 10, gravityScale: 1, slopeLimitAngleRad: deg(45), resonanceCostPerSec: 0, allowStepClimb: true,
  },
  [TraversalMode.FREE_FLIGHT]: {
    maxSpeed: 22, acceleration: 35, dragDamping: 2.5, gravityScale: 0, slopeLimitAngleRad: Math.PI, resonanceCostPerSec: 5, allowStepClimb: false,
  },
  [TraversalMode.AQUATIC_LEVITATION]: {
    maxSpeed: 14, acceleration: 25, dragDamping: 4, gravityScale: 0.1, slopeLimitAngleRad: deg(20), resonanceCostPerSec: 1, allowStepClimb: false,
  },
};

/** Standard gravity: dynamic bodies (debris, pods) fall at 1 g. */
export const G = 9.81;
/**
 * The hero's own vertical integration is scaled up (2.6 g) for a responsive action-game jump arc; the blueprint's
 * 7.5 m/s take-off at 1 g floats for 1.5 s, which reads sluggish in combat. Apex height stays ~2.6 m.
 */
export const HERO_GRAVITY = G * 2.6;
export const JUMP_SPEED = 11.5;
/** Kinematic character controller settings (Grounding Report §3.2). */
export const KCC = {
  offset: 0.01,
  maxSlopeClimb: deg(45),
  minSlopeSlide: deg(30),
  autostepHeight: 0.5,
  autostepWidth: 0.2,
  autostepDynamic: false,
  snapToGround: 0.5,
  /** Hover height above a fluid / flow surface (blueprint: h > 1 m, target 1.2 m). */
  hoverHeight: 1.2,
  flightBoost: 1.8,
} as const;
