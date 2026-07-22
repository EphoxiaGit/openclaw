import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WorkInputRequest } from "../../../api/types.ts";
import { renderChatInputRequest } from "./chat-input-request.ts";

const base = {
  id: "request-1",
  revision: 1,
  status: "pending" as const,
  sessionKey: "agent:main:main",
  createdAt: 1,
  updatedAt: 1,
  prompt: "Operator input needed",
  creator: { type: "system" as const, label: "TaskFlow" },
};

function renderRequest(request: WorkInputRequest, onResolve = vi.fn()) {
  const container = document.createElement("div");
  render(
    renderChatInputRequest({
      request,
      busy: false,
      onResolve,
      onCancel: vi.fn(),
    }),
    container,
  );
  return { container, onResolve };
}

describe("chat input request", () => {
  it("renders a semantic approval and submits only the selected decision", () => {
    const { container, onResolve } = renderRequest({
      ...base,
      kind: "approval",
      decisions: ["approve", "reject"],
    });
    const approve = container.querySelector<HTMLInputElement>('input[value="approve"]');
    expect(approve).not.toBeNull();
    if (!approve) {
      return;
    }
    approve.checked = true;
    container.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(onResolve).toHaveBeenCalledWith({ choiceIds: ["approve"] });
  });

  it("keeps managed references identifier-only and never renders a file or secret-value input", () => {
    const { container, onResolve } = renderRequest({
      ...base,
      kind: "add_information",
      allowedFields: ["fileRefs", "artifactRefs"],
    });
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    const fileRefs = container.querySelector<HTMLInputElement>('input[name="fileRefs"]');
    const artifactRefs = container.querySelector<HTMLInputElement>('input[name="artifactRefs"]');
    if (!fileRefs || !artifactRefs) {
      throw new Error("expected managed reference inputs");
    }
    fileRefs.value = "managed-a, managed-b";
    artifactRefs.value = "artifact-a";
    container.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(onResolve).toHaveBeenCalledWith({
      fileRefs: [{ id: "managed-a" }, { id: "managed-b" }],
      artifactRefs: [{ artifactId: "artifact-a" }],
    });
    expect(container.textContent).toContain("already managed by this OpenClaw session");
  });

  it("submits a SecretRef locator without a secret value field", () => {
    const { container, onResolve } = renderRequest({
      ...base,
      kind: "secret_ref",
    });
    const provider = container.querySelector<HTMLInputElement>('input[name="provider"]');
    const locator = container.querySelector<HTMLInputElement>('input[name="locator"]');
    if (!provider || !locator) {
      throw new Error("expected SecretRef locator fields");
    }
    provider.value = "default";
    locator.value = "ELEVENLABS_API_KEY";
    container.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(container.querySelector('input[name="value"]')).toBeNull();
    expect(onResolve).toHaveBeenCalledWith({
      secretRefs: [{ source: "env", provider: "default", id: "ELEVENLABS_API_KEY" }],
    });
  });
});
