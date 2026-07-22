import { html, nothing } from "lit";
import type { WorkInputRequest, WorkInputResponse } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";

function csv(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requestKindLabel(request: WorkInputRequest): string {
  return request.kind === "question"
    ? t("chat.inputRequest.kind.question")
    : request.kind === "approval"
      ? t("chat.inputRequest.kind.approval")
      : request.kind === "add_information"
        ? t("chat.inputRequest.kind.information")
        : t("chat.inputRequest.kind.secretRef");
}

export function renderChatInputRequest(props: {
  request?: WorkInputRequest;
  busy: boolean;
  error?: string | null;
  onResolve: (response: WorkInputResponse) => void;
  onCancel: () => void;
}) {
  const request = props.request;
  if (!request || request.status !== "pending") {
    return nothing;
  }
  return html`<section
    class="chat-input-request"
    data-work-input-id=${request.id}
    aria-label=${t("chat.inputRequest.region")}
  >
    <div class="chat-input-request__header">
      <strong>${request.prompt}</strong>
      <span class="pill">${requestKindLabel(request)}</span>
    </div>
    ${request.description
      ? html`<div class="chat-input-request__description">${request.description}</div>`
      : nothing}
    <form
      class="chat-input-request__form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        let response: WorkInputResponse;
        if (request.kind === "question" || request.kind === "approval") {
          const choiceIds = data.getAll("choiceId").map(String);
          response = {
            ...(choiceIds.length ? { choiceIds } : {}),
            ...(request.kind === "question" && request.allowFreeText && data.get("text")
              ? { text: String(data.get("text")) }
              : {}),
          };
        } else if (request.kind === "add_information") {
          const fileRefs = csv(data.get("fileRefs"));
          const artifactRefs = csv(data.get("artifactRefs"));
          response = {
            ...(request.allowedFields.includes("text") && data.get("text")
              ? { text: String(data.get("text")) }
              : {}),
            ...(request.allowedFields.includes("fileRefs") && fileRefs.length
              ? { fileRefs: fileRefs.map((id) => ({ id })) }
              : {}),
            ...(request.allowedFields.includes("artifactRefs") && artifactRefs.length
              ? {
                  artifactRefs: artifactRefs.map((artifactId) => ({ artifactId })),
                }
              : {}),
          };
        } else {
          response = {
            secretRefs: [
              {
                source: String(data.get("source")) as "env" | "file" | "exec",
                provider: String(data.get("provider")),
                id: String(data.get("locator")),
              },
            ],
          };
        }
        props.onResolve(response);
      }}
    >
      ${request.kind === "question"
        ? html`<div class="chat-input-request__choices">
              ${request.options.map(
                (option) => html`<label class="chat-input-request__choice">
                  <input
                    name="choiceId"
                    value=${option.id}
                    type=${request.allowMultiple ? "checkbox" : "radio"}
                  />
                  <span>${option.label}</span>
                </label>`,
              )}
            </div>
            ${request.allowFreeText
              ? html`<label class="field">
                  <span>${t("chat.inputRequest.additionalInformation")}</span>
                  <textarea name="text" maxlength="8000"></textarea>
                </label>`
              : nothing}`
        : request.kind === "approval"
          ? html`<div class="chat-input-request__choices">
              ${request.decisions.map(
                (decision) => html`<label class="chat-input-request__choice">
                  <input required type="radio" name="choiceId" value=${decision} />
                  <span
                    >${decision === "approve"
                      ? t("chat.inputRequest.approveWork")
                      : t("chat.inputRequest.rejectWork")}</span
                  >
                </label>`,
              )}
            </div>`
          : request.kind === "add_information"
            ? html`${request.allowedFields.includes("text")
                ? html`<label class="field">
                    <span>${t("chat.inputRequest.information")}</span>
                    <textarea name="text" maxlength="8000"></textarea>
                  </label>`
                : nothing}
              ${request.allowedFields.includes("fileRefs")
                ? html`<label class="field">
                    <span>${t("chat.inputRequest.managedFileReferences")}</span>
                    <input name="fileRefs" aria-describedby="work-input-file-help" />
                    <small id="work-input-file-help" class="muted"
                      >${t("chat.inputRequest.managedFileHelp")}</small
                    >
                  </label>`
                : nothing}
              ${request.allowedFields.includes("artifactRefs")
                ? html`<label class="field">
                    <span>${t("chat.inputRequest.artifactReferences")}</span>
                    <input name="artifactRefs" aria-describedby="work-input-artifact-help" />
                    <small id="work-input-artifact-help" class="muted"
                      >${t("chat.inputRequest.artifactHelp")}</small
                    >
                  </label>`
                : nothing}`
            : html`<div class="chat-input-request__secret-grid">
                <label class="field">
                  <span>${t("chat.inputRequest.source")}</span>
                  <select name="source">
                    <option value="env">${t("chat.inputRequest.sourceEnvironment")}</option>
                    <option value="file">${t("chat.inputRequest.sourceFile")}</option>
                    <option value="exec">${t("chat.inputRequest.sourceExec")}</option>
                  </select>
                </label>
                <label class="field">
                  <span>${t("chat.inputRequest.providerAlias")}</span>
                  <input name="provider" required />
                </label>
                <label class="field">
                  <span>${t("chat.inputRequest.secretLocator")}</span>
                  <input name="locator" required />
                </label>
              </div>`}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      <div class="chat-input-request__actions">
        <button type="submit" class="btn btn--sm primary" ?disabled=${props.busy}>
          ${props.busy ? t("chat.inputRequest.submitting") : t("chat.inputRequest.submit")}
        </button>
        <button type="button" class="btn btn--sm" ?disabled=${props.busy} @click=${props.onCancel}>
          ${t("chat.inputRequest.cancelRequest")}
        </button>
      </div>
    </form>
  </section>`;
}
