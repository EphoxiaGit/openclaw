import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("workspace config", () => {
  it("keeps the optional subtree absent by default", () => {
    expect(OpenClawSchema.parse({})).not.toHaveProperty("workspace");
  });

  it("round-trips the native live-work presentation settings", () => {
    const parsed = OpenClawSchema.parse({
      workspace: {
        liveWork: {
          visible: false,
          showContinueDraft: false,
        },
      },
    });

    expect(OpenClawSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown workspace and live-work keys", () => {
    expect(OpenClawSchema.safeParse({ workspace: { dock: true } }).success).toBe(false);
    expect(OpenClawSchema.safeParse({ workspace: { liveWork: { autoSend: true } } }).success).toBe(
      false,
    );
  });

  it("publishes searchable labels, help, and tags", () => {
    const hints = buildConfigSchema().uiHints;
    expect(hints.workspace?.label).toBe("Workspace");
    expect(hints["workspace.liveWork.visible"]?.help).toContain("project/context projection reads");
    expect(hints["workspace.liveWork.showContinueDraft"]?.tags).toContain("advanced");
  });
});
