import { describe, expect, it } from "vitest";
import {
  CAMERA_FRAMING,
  DEFAULT_CAMERA_FRAMING,
  GRAPHICS_PROFILES,
  RELAXED_POSE_OFFSETS,
  ambientGestureAt,
  idleGazeAt,
  idleMotionAt,
  nextCameraFraming,
  nextGraphicsPreset,
  poseMagnitude,
} from "./presentation";

describe("Companion renderer presentation presets", () => {
  it("keeps the balanced preset within a lower rendering budget", () => {
    expect(GRAPHICS_PROFILES.balanced.pixelRatioCap).toBeLessThan(
      GRAPHICS_PROFILES.quality.pixelRatioCap,
    );
    expect(GRAPHICS_PROFILES.balanced.keyLightIntensity).toBeLessThan(
      GRAPHICS_PROFILES.quality.keyLightIntensity,
    );
    expect(GRAPHICS_PROFILES.balanced.shadows).toBe(false);
    expect(GRAPHICS_PROFILES.quality.shadows).toBe(true);
  });

  it("offers a reversible graphics toggle", () => {
    expect(nextGraphicsPreset("balanced")).toBe("quality");
    expect(nextGraphicsPreset("quality")).toBe("balanced");
  });

  it("defaults to a closer portrait while keeping full figure reversible", () => {
    expect(DEFAULT_CAMERA_FRAMING).toBe("portrait");
    expect(CAMERA_FRAMING.full.distanceMultiplier).toBeGreaterThan(
      CAMERA_FRAMING.portrait.distanceMultiplier,
    );
    expect(CAMERA_FRAMING.portrait.distanceMultiplier).toBe(0.6);
    expect(CAMERA_FRAMING.portrait.verticalOffset).toBe(0.22);
    expect(nextCameraFraming("full")).toBe("portrait");
    expect(nextCameraFraming("portrait")).toBe("full");
  });

  it("drops both upper arms near the sides with a subtle elbow bend", () => {
    expect(RELAXED_POSE_OFFSETS.leftUpperArm.z).toBeGreaterThanOrEqual(1.15);
    expect(RELAXED_POSE_OFFSETS.rightUpperArm.z).toBeLessThanOrEqual(-1.15);
    expect(poseMagnitude(RELAXED_POSE_OFFSETS.leftUpperArm)).toBeGreaterThan(1.15);
    expect(RELAXED_POSE_OFFSETS.leftLowerArm.x).toBeGreaterThan(0.2);
    expect(RELAXED_POSE_OFFSETS.rightLowerArm.x).toBeGreaterThan(0.2);
  });

  it("uses deterministic bounded idle eye motion", () => {
    expect(idleGazeAt(2_900)).toEqual(idleGazeAt(2_900));
    const gaze = idleGazeAt(3_100);
    expect(Math.abs(gaze.x)).toBeLessThanOrEqual(0.16);
    expect(Math.abs(gaze.y)).toBeLessThanOrEqual(0.07);
  });

  it("layers deterministic bounded body motion and brief ambient gestures", () => {
    expect(idleMotionAt(9_421)).toEqual(idleMotionAt(9_421));
    const idle = idleMotionAt(9_421);
    for (const value of [
      idle.breath,
      idle.weightShift,
      idle.torsoTwist,
      idle.torsoLean,
      idle.headNod,
      idle.headTurn,
    ]) {
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }

    expect(ambientGestureAt(1_000).active).toBe(false);
    expect(ambientGestureAt(11_500).active).toBe(false);
    const gesture = ambientGestureAt(10_100);
    expect(gesture.active).toBe(true);
    expect(Math.abs(gesture.upperArmX)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(gesture.upperArmZ)).toBeLessThanOrEqual(0.11);
    expect(Math.abs(gesture.lowerArmX)).toBeLessThanOrEqual(0.16);
    expect(Math.abs(gesture.lowerArmY)).toBeLessThanOrEqual(0.06);
  });
});
