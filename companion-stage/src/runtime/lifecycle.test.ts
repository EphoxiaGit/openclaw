import { describe, expect, it } from "vitest";
import { DisposeBag, normalizePointer } from "./lifecycle";

describe("Companion stage lifecycle primitives", () => {
  it("normalizes pointer movement against the mounted stage rather than the browser window", () => {
    expect(normalizePointer(150, 50, { left: 100, top: 0, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(normalizePointer(500, -500, { left: 100, top: 0, width: 100, height: 100 })).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("runs owned cleanup once and disposes resources in reverse order", () => {
    const events: string[] = [];
    const bag = new DisposeBag();
    bag.add(() => events.push("renderer"));
    bag.add(() => events.push("audio"));
    bag.dispose();
    bag.dispose();
    expect(events).toEqual(["audio", "renderer"]);
  });
});
