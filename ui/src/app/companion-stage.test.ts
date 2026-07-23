import { describe, expect, it } from "vitest";
import {
  COMPANION_AIRI_STAGE_URL,
  COMPANION_LOCAL_STAGE_SEARCH,
  COMPANION_LOCAL_STAGE_URL,
  isCompanionLocalStageEnabled,
  readCompanionEvent,
  readCompanionRendererIntent,
  readCompanionRendererSelection,
} from "./companion-stage.ts";

describe("local Companion stage route gate", () => {
  it("uses the fixed loopback renderer origin", () => {
    expect(COMPANION_LOCAL_STAGE_URL).toBe("http://127.0.0.1:5184/");
    expect(COMPANION_AIRI_STAGE_URL).toBe("http://127.0.0.1:5194/companion?openclaw=1");
    expect(COMPANION_LOCAL_STAGE_SEARCH).toBe("?companion-stage=local");
  });

  it("requires the explicit local-stage route value", () => {
    expect(isCompanionLocalStageEnabled("")).toBe(false);
    expect(isCompanionLocalStageEnabled("?companion-stage=local")).toBe(true);
    expect(isCompanionLocalStageEnabled("?companion-stage=remote")).toBe(false);
    expect(isCompanionLocalStageEnabled("?other=local")).toBe(false);
  });

  it("keeps the minimal renderer as rollback and accepts only closed AIRI presentation", () => {
    expect(readCompanionRendererSelection({})).toMatchObject({
      renderer: "minimal",
      url: COMPANION_LOCAL_STAGE_URL,
      presentation: { model: "native", camera: "native", animation: "idle" },
    });
    expect(
      readCompanionRendererSelection({
        gateway: {
          controlUi: {
            companionRenderer: "airi",
            companionPresentation: {
              model: "avatar-b",
              camera: "full",
              animation: "idle",
              provider: "must-not-cross",
            },
          },
        },
      }),
    ).toEqual({
      renderer: "airi",
      url: COMPANION_AIRI_STAGE_URL,
      origin: "http://127.0.0.1:5194",
      presentation: { model: "avatar-b", camera: "full", animation: "idle" },
    });
    expect(
      readCompanionRendererSelection({
        gateway: {
          controlUi: {
            companionRenderer: "https://example.com/renderer",
            companionPresentation: { model: "https://example.com/model.vrm" },
          },
        },
      }),
    ).toMatchObject({
      renderer: "minimal",
      url: COMPANION_LOCAL_STAGE_URL,
      presentation: { model: "native", camera: "native" },
    });
  });

  it("accepts only bounded renderer intents", () => {
    expect(readCompanionRendererIntent({ type: "open-main-chat", sequence: 1 })).toEqual({
      type: "open-main-chat",
      sequence: 1,
    });
    expect(readCompanionRendererIntent({ type: "cancel-response", sequence: 2 })).toEqual({
      type: "cancel-response",
      sequence: 2,
    });
    expect(
      readCompanionRendererIntent({ type: "send-message", text: "hello", sequence: 3 }),
    ).toBeNull();
  });

  it("accepts only closed semantic projections without private or extra fields", () => {
    const event = {
      type: "semantic-command",
      conversationId: "main-companion",
      sequence: 7,
      command: { type: "set", state: "activity.coding" },
    };
    expect(readCompanionEvent(event)).toEqual(event);
    expect(readCompanionEvent({ ...event, runId: "private" })).toBeNull();
    expect(
      readCompanionEvent({ ...event, command: { ...event.command, tool: "private" } }),
    ).toBeNull();
    expect(
      readCompanionEvent({ ...event, command: { type: "set", state: "raw.animation" } }),
    ).toBeNull();
  });
});
