/**
 * Local-only Companion renderer contract.
 *
 * The source is intentionally fixed: the Control UI never accepts a renderer
 * URL from route state, storage, the Gateway, or a model. This is not an
 * authorization boundary; it is a removable development-only presentation
 * mount with no bridge or message channel.
 */
export const COMPANION_LOCAL_STAGE_URL = "http://127.0.0.1:5184/";
export const COMPANION_LOCAL_STAGE_SEARCH = "?companion-stage=local";

export function isCompanionLocalStageEnabled(search: string): boolean {
  return new URLSearchParams(search).get("companion-stage") === "local";
}
