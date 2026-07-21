<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { AvatarStage, type StageCapabilities } from "./runtime/AvatarStage";
import {
  DEFAULT_CAMERA_FRAMING,
  nextCameraFraming,
  nextGraphicsPreset,
  type CameraFraming,
  type GraphicsPreset,
} from "./runtime/presentation";

type StagePhase = "loading" | "ready" | "failed";

const host = ref<HTMLElement | null>(null);
const phase = ref<StagePhase>("loading");
const error = ref("");
const reducedMotion = ref(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const graphicsPreset = ref<GraphicsPreset>("quality");
const cameraFraming = ref<CameraFraming>(DEFAULT_CAMERA_FRAMING);
const capabilities = ref<StageCapabilities | null>(null);
const stage = shallowRef<AvatarStage | null>(null);

async function mountStage(): Promise<void> {
  phase.value = "loading";
  error.value = "";
  stage.value?.dispose();
  if (!host.value) return;
  try {
    const next = new AvatarStage(host.value, reducedMotion.value);
    stage.value = next;
    next.setGraphicsPreset(graphicsPreset.value);
    next.setCameraFraming(cameraFraming.value);
    capabilities.value = await next.load();
    phase.value = "ready";
  } catch (caught) {
    stage.value?.dispose();
    stage.value = null;
    phase.value = "failed";
    error.value = caught instanceof Error ? caught.message : "renderer_initialization_failed";
  }
}

function setReducedMotion(): void {
  reducedMotion.value = !reducedMotion.value;
  stage.value?.setReducedMotion(reducedMotion.value);
}

function setGraphicsPreset(): void {
  graphicsPreset.value = nextGraphicsPreset(graphicsPreset.value);
  stage.value?.setGraphicsPreset(graphicsPreset.value);
}

function setCameraFraming(): void {
  cameraFraming.value = nextCameraFraming(cameraFraming.value);
  stage.value?.setCameraFraming(cameraFraming.value);
}

onMounted(() => {
  void mountStage();
});
onBeforeUnmount(() => stage.value?.dispose());
</script>

<template>
  <main
    class="companion-stage"
    :data-phase="phase"
    :data-reduced-motion="reducedMotion"
    :data-graphics-preset="graphicsPreset"
  >
    <section class="stage-frame" aria-labelledby="stage-title">
      <header class="stage-header">
        <div>
          <p class="stage-eyebrow">AIRI-derived local renderer spike</p>
          <h1 id="stage-title">Companion Stage</h1>
        </div>
        <p class="stage-status" role="status" aria-live="polite">
          {{
            phase === "loading"
              ? "Loading private local model"
              : phase === "ready"
                ? "Local renderer ready"
                : "Renderer unavailable"
          }}
        </p>
      </header>

      <div class="avatar-aperture" data-testid="avatar-aperture">
        <div ref="host" class="avatar-canvas-host" />
        <div v-if="phase === 'loading'" class="stage-overlay" data-testid="stage-loading">
          <strong>Loading avatar…</strong
          ><span>The private local asset is served only by this loopback development process.</span>
        </div>
        <div
          v-else-if="phase === 'failed'"
          class="stage-overlay stage-error"
          data-testid="stage-error"
        >
          <strong>Avatar unavailable</strong><span>{{ error }}</span
          ><button type="button" @click="mountStage">Retry local load</button>
        </div>
      </div>

      <details class="stage-controls" aria-label="Renderer spike controls">
        <summary>Stage controls</summary>
        <div class="stage-controls-panel">
          <button type="button" :disabled="phase !== 'ready'" @click="stage?.triggerExpression()">
            Expression
          </button>
          <button
            type="button"
            :disabled="phase !== 'ready' || reducedMotion"
            @click="stage?.triggerGesture()"
          >
            Wave gesture
          </button>
          <button type="button" :disabled="phase !== 'ready'" @click="stage?.playTestTone()">
            Play test tone
          </button>
          <button type="button" :disabled="phase !== 'ready'" @click="stage?.stopAudio()">
            Stop audio
          </button>
          <button
            type="button"
            :disabled="phase !== 'ready'"
            :aria-pressed="graphicsPreset === 'quality'"
            @click="setGraphicsPreset"
          >
            Graphics: {{ graphicsPreset }}
          </button>
          <button
            type="button"
            :disabled="phase !== 'ready'"
            :aria-pressed="cameraFraming === 'portrait'"
            @click="setCameraFraming"
          >
            Frame: {{ cameraFraming === "portrait" ? "portrait" : "full figure" }}
          </button>
          <button type="button" :aria-pressed="reducedMotion" @click="setReducedMotion">
            Reduced motion: {{ reducedMotion ? "on" : "off" }}
          </button>
        </div>
      </details>
      <p v-if="capabilities" class="stage-capabilities">
        Calm local idle · {{ graphicsPreset }} · {{ cameraFraming }} · gaze
        {{ capabilities.lookAt ? "on" : "off" }} · blink {{ capabilities.blink ? "on" : "off" }} ·
        audio mouth {{ reducedMotion ? "paused" : "ready" }}
      </p>
    </section>
  </main>
</template>
