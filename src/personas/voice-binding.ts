import type { OpenClawConfig } from "../config/types.js";
import { resolveTtsPersonaBinding } from "../tts/tts.js";
import type { Persona } from "./types.js";

export type EffectivePersonaVoiceBinding =
  | { status: "unbound" }
  | ({ status: "missing" | "unavailable" | "ready" } & {
      ttsPersonaId: string;
      provider?: string;
      model?: string;
      voice?: string;
      providerBinding?: "applied" | "missing";
    });

export function resolvePersonaVoiceBinding(
  cfg: OpenClawConfig,
  persona: Pick<Persona, "primaryAgentId" | "ttsPersonaId">,
): EffectivePersonaVoiceBinding {
  if (!persona.ttsPersonaId) {
    return { status: "unbound" };
  }
  return resolveTtsPersonaBinding({
    cfg,
    personaId: persona.ttsPersonaId,
    agentId: persona.primaryAgentId,
  });
}

export function projectPersonaWithVoice<T extends Persona>(cfg: OpenClawConfig, persona: T) {
  const { ttsPersonaId: _ttsPersonaId, ...record } = persona;
  return { ...record, voiceBinding: resolvePersonaVoiceBinding(cfg, persona) };
}
