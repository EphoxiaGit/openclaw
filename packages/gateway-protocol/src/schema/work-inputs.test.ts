import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { WorkInputRequestSchema, WorkInputResponseSchema } from "./work-inputs.js";

describe("work input protocol", () => {
  it("accepts closed request kinds and rejects mixed or secret-bearing payloads", () => {
    const request = Compile(WorkInputRequestSchema);
    const base = {
      id: "request-1",
      revision: 1,
      status: "pending",
      sessionKey: "agent:main:main",
      createdAt: 1,
      updatedAt: 1,
      prompt: "Choose",
      creator: { type: "system", label: "TaskFlow" },
    };
    expect(
      request.Check({
        ...base,
        kind: "question",
        options: [{ id: "yes", label: "Yes" }],
        allowMultiple: false,
        allowFreeText: false,
      }),
    ).toBe(true);
    expect(
      request.Check({
        ...base,
        kind: "approval",
        decisions: ["approve", "reject"],
        options: [],
      }),
    ).toBe(false);

    const response = Compile(WorkInputResponseSchema);
    expect(
      response.Check({ secretRefs: [{ source: "env", provider: "default", id: "TOKEN" }] }),
    ).toBe(true);
    for (const forbidden of [
      { text: "" },
      { choiceIds: [] },
      { fileRefs: [] },
      { artifactRefs: [] },
      { secretRefs: [] },
      { value: "sentinel" },
      { secret: "sentinel" },
      { password: "sentinel" },
      { token: "sentinel" },
      { path: "/tmp/private" },
      { bytes: "c2VudGluZWw=" },
      { resumeToken: "sentinel" },
      { approvalId: "sentinel" },
      { fileRefs: [{ id: "/tmp/private" }] },
      { fileRefs: [{ id: "managed-1", content: "c2VudGluZWw=" }] },
      { fileRefs: [{ id: "managed-1", name: "browser-spoofed.txt" }] },
    ]) {
      expect(response.Check(forbidden)).toBe(false);
    }
  });
});
