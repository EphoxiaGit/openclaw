export type GraphicsPreset = "balanced" | "quality";
export type CameraFraming = "full" | "portrait";

export const DEFAULT_CAMERA_FRAMING: CameraFraming = "portrait";

export type GraphicsProfile = Readonly<{
  pixelRatioCap: number;
  toneMappingExposure: number;
  keyLightIntensity: number;
  rimLightIntensity: number;
  shadows: boolean;
}>;

export const GRAPHICS_PROFILES: Readonly<Record<GraphicsPreset, GraphicsProfile>> = {
  balanced: {
    pixelRatioCap: 1.25,
    toneMappingExposure: 0.92,
    keyLightIntensity: 2.05,
    rimLightIntensity: 0.9,
    shadows: false,
  },
  quality: {
    pixelRatioCap: 2,
    toneMappingExposure: 1.02,
    keyLightIntensity: 2.3,
    rimLightIntensity: 1.15,
    shadows: true,
  },
};

export const CAMERA_FRAMING: Readonly<
  Record<
    CameraFraming,
    Readonly<{
      distanceMultiplier: number;
      verticalOffset: number;
    }>
  >
> = {
  full: { distanceMultiplier: 1.18, verticalOffset: 0.03 },
  portrait: { distanceMultiplier: 0.6, verticalOffset: 0.22 },
};

export type PoseBoneName =
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm";

export type PoseOffset = Readonly<{ x: number; y: number; z: number }>;

/**
 * A small rest-pose overlay for models shipped in a T-pose. Values are offsets
 * from the model's authored humanoid rest transforms, not a replacement rig.
 */
export const RELAXED_POSE_OFFSETS: Readonly<Record<PoseBoneName, PoseOffset>> = {
  leftShoulder: { x: 0.05, y: 0.02, z: 0.14 },
  rightShoulder: { x: 0.05, y: -0.02, z: -0.14 },
  leftUpperArm: { x: 0.08, y: 0.08, z: 1.22 },
  rightUpperArm: { x: 0.08, y: -0.08, z: -1.22 },
  leftLowerArm: { x: 0.24, y: 0.14, z: 0.12 },
  rightLowerArm: { x: 0.24, y: -0.14, z: -0.12 },
};

export type IdleBoneName = "spine" | "chest" | "upperChest" | "neck" | "head";

export const IDLE_BODY_OFFSETS: Readonly<Record<IdleBoneName, PoseOffset>> = {
  spine: { x: 0.014, y: 0.008, z: 0.01 },
  chest: { x: 0.022, y: 0.012, z: 0.016 },
  upperChest: { x: 0.016, y: 0.009, z: 0.012 },
  neck: { x: 0.01, y: 0.014, z: 0.008 },
  head: { x: 0.012, y: 0.018, z: 0.01 },
};

export function nextGraphicsPreset(current: GraphicsPreset): GraphicsPreset {
  return current === "balanced" ? "quality" : "balanced";
}

export function nextCameraFraming(current: CameraFraming): CameraFraming {
  return current === "full" ? "portrait" : "full";
}

export function poseMagnitude(offset: PoseOffset): number {
  return Math.hypot(offset.x, offset.y, offset.z);
}

export type AmbientGesture = Readonly<{
  active: boolean;
  upperArmX: number;
  upperArmZ: number;
  lowerArmX: number;
  lowerArmY: number;
}>;

export type IdleMotion = Readonly<{
  breath: number;
  weightShift: number;
  torsoTwist: number;
  torsoLean: number;
  headNod: number;
  headTurn: number;
  ambientGesture: AmbientGesture;
}>;

const IDLE_LIMITS = {
  breath: 1,
  weightShift: 1,
  torsoTwist: 1,
  torsoLean: 1,
  headNod: 1,
  headTurn: 1,
} as const;

function smoothPulse(value: number): number {
  const bounded = Math.min(1, Math.max(0, value));
  return Math.sin(bounded * Math.PI);
}

/**
 * A deterministic, bounded ambient gesture. It occupies only a short part of
 * each cycle so the avatar reads as settled rather than continuously animated.
 */
export function ambientGestureAt(now: number): AmbientGesture {
  const cycle = 13_600;
  const start = 0.64;
  const duration = 0.18;
  const phase = (((now % cycle) + cycle) % cycle) / cycle;
  if (phase < start || phase >= start + duration) {
    return { active: false, upperArmX: 0, upperArmZ: 0, lowerArmX: 0, lowerArmY: 0 };
  }
  const pulse = smoothPulse((phase - start) / duration);
  return {
    active: pulse > 0,
    upperArmX: pulse * 0.12,
    upperArmZ: pulse * -0.11,
    lowerArmX: pulse * 0.16,
    lowerArmY: Math.sin(pulse * Math.PI) * 0.06,
  };
}

/**
 * Layered idle phases are intentionally pure so motion remains reproducible in
 * tests and can be fully disabled without changing renderer lifecycle.
 */
export function idleMotionAt(now: number): IdleMotion {
  const safeNow = Number.isFinite(now) ? now : 0;
  return {
    breath: Math.sin(safeNow / 1_450) * IDLE_LIMITS.breath,
    weightShift: Math.sin(safeNow / 4_900 + 0.8) * IDLE_LIMITS.weightShift,
    torsoTwist: Math.sin(safeNow / 3_700) * IDLE_LIMITS.torsoTwist,
    torsoLean: Math.cos(safeNow / 4_300 + 0.45) * IDLE_LIMITS.torsoLean,
    headNod: Math.sin(safeNow / 2_650 + 0.3) * IDLE_LIMITS.headNod,
    headTurn: Math.cos(safeNow / 3_150 + 0.2) * IDLE_LIMITS.headTurn,
    ambientGesture: ambientGestureAt(safeNow),
  };
}

/** A deterministic, bounded gaze target used only after the pointer has rested. */
export function idleGazeAt(now: number): Readonly<{ x: number; y: number }> {
  const cycle = Math.floor(now / 2_700);
  const progress = (now % 2_700) / 2_700;
  const settle = Math.min(1, Math.min(progress / 0.22, (1 - progress) / 0.2));
  return {
    x: Math.sin(cycle * 2.17) * 0.16 * settle,
    y: Math.cos(cycle * 1.41) * 0.07 * settle,
  };
}
