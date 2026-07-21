import { describe, expect, it } from "vitest";
import {
  COMPANION_LOCAL_STAGE_SEARCH,
  COMPANION_LOCAL_STAGE_URL,
  isCompanionLocalStageEnabled,
} from "./companion-stage.ts";

describe("local Companion stage route gate", () => {
  it("uses the fixed loopback renderer origin", () => {
    expect(COMPANION_LOCAL_STAGE_URL).toBe("http://127.0.0.1:5184/");
    expect(COMPANION_LOCAL_STAGE_SEARCH).toBe("?companion-stage=local");
  });

  it("requires the explicit local-stage route value", () => {
    expect(isCompanionLocalStageEnabled("")).toBe(false);
    expect(isCompanionLocalStageEnabled("?companion-stage=local")).toBe(true);
    expect(isCompanionLocalStageEnabled("?companion-stage=remote")).toBe(false);
    expect(isCompanionLocalStageEnabled("?other=local")).toBe(false);
  });
});
