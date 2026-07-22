import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("workspace config", () => {
  it("keeps the optional subtree absent by default", () => {
    expect(OpenClawSchema.parse({})).not.toHaveProperty("workspace");
  });

  it("exposes true form defaults without materializing absent authored values", () => {
    const absent = OpenClawSchema.parse({ workspace: { liveWork: {} } });
    expect(absent.workspace?.liveWork).toEqual({});
    expect(
      OpenClawSchema.parse({
        workspace: { liveWork: { visible: false, showContinueDraft: false } },
      }),
    ).toMatchObject({
      workspace: { liveWork: { visible: false, showContinueDraft: false } },
    });

    const schema = buildConfigSchema().schema as {
      properties?: {
        workspace?: {
          properties?: {
            liveWork?: {
              properties?: Record<string, { default?: unknown }>;
            };
          };
        };
      };
    };
    const liveWorkProperties = schema.properties?.workspace?.properties?.liveWork?.properties;
    expect(liveWorkProperties?.visible?.default).toBe(true);
    expect(liveWorkProperties?.showContinueDraft?.default).toBe(true);
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

    expect(OpenClawSchema.parse(structuredClone(parsed))).toEqual(parsed);
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
