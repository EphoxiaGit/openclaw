import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DisposeBag, normalizePointer } from "./lifecycle";
import {
  CAMERA_FRAMING,
  DEFAULT_CAMERA_FRAMING,
  GRAPHICS_PROFILES,
  IDLE_BODY_OFFSETS,
  RELAXED_POSE_OFFSETS,
  idleMotionAt,
  idleGazeAt,
  type AmbientGesture,
  type CameraFraming,
  type GraphicsPreset,
  type IdleBoneName,
  type PoseBoneName,
} from "./presentation";

const LOCAL_VRM_URL = "/__companion-local/vrm";
const BLINK_INTERVAL_MS = 4_200;
const BLINK_DURATION_MS = 180;
const TEST_TONE_DURATION_MS = 2_400;

type AudioGraph = {
  readonly context: AudioContext;
  readonly source: OscillatorNode;
  readonly gain: GainNode;
  readonly analyser: AnalyserNode;
  readonly data: Uint8Array<ArrayBuffer>;
};

type BoneSnapshot = {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Euler;
};

export type StageCapabilities = Readonly<{
  lookAt: boolean;
  blink: boolean;
  viseme: boolean;
  gesture: boolean;
}>;

export class AvatarStage {
  readonly #container: HTMLElement;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #clock = new THREE.Clock();
  readonly #gazeTarget = new THREE.Object3D();
  readonly #disposers = new DisposeBag();
  #vrm: VRM | null = null;
  #animationFrame: number | null = null;
  #loadRevision = 0;
  #disposed = false;
  #reducedMotion = false;
  #graphicsPreset: GraphicsPreset = "quality";
  #cameraFraming: CameraFraming = DEFAULT_CAMERA_FRAMING;
  #blinkStartedAt = performance.now() + BLINK_INTERVAL_MS;
  #lastPointerAt = performance.now();
  #gestureStartedAt: number | null = null;
  #audio: AudioGraph | null = null;
  #hip: THREE.Object3D | null = null;
  #rightUpperArm: THREE.Object3D | null = null;
  #rightLowerArm: THREE.Object3D | null = null;
  #ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> | null = null;
  #keyLight: THREE.DirectionalLight;
  #rimLight: THREE.DirectionalLight;
  readonly #poseBones = new Map<PoseBoneName, THREE.Object3D>();
  readonly #idleBones = new Map<IdleBoneName, THREE.Object3D>();
  #boneRest = new Map<THREE.Object3D, BoneSnapshot>();

  constructor(container: HTMLElement, reducedMotion: boolean) {
    this.#container = container;
    this.#reducedMotion = reducedMotion;
    this.#renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.#renderer.domElement.setAttribute("aria-label", "Private local VRM renderer");
    this.#container.replaceChildren(this.#renderer.domElement);

    this.#camera.position.set(0, 1.38, 3.1);
    this.#scene.add(this.#camera, this.#gazeTarget);
    this.#gazeTarget.position.set(0, 1.35, 0.4);
    this.#scene.add(new THREE.HemisphereLight(0xc5e9ff, 0x101e3b, 1.85));
    this.#keyLight = new THREE.DirectionalLight(0xb9ccff);
    this.#keyLight.position.set(2.4, 4, 3);
    this.#keyLight.castShadow = true;
    this.#keyLight.shadow.mapSize.set(1024, 1024);
    this.#keyLight.shadow.camera.near = 0.1;
    this.#keyLight.shadow.camera.far = 12;
    this.#scene.add(this.#keyLight);
    this.#rimLight = new THREE.DirectionalLight(0x78e6d0);
    this.#rimLight.position.set(-2, 1.5, -2);
    this.#scene.add(this.#rimLight);
    this.#applyGraphicsPreset();

    const resize = () => this.#resize();
    const pointer = (event: PointerEvent) => this.#trackPointer(event);
    const resizeObserver = new ResizeObserver(resize);
    window.addEventListener("resize", resize);
    this.#renderer.domElement.addEventListener("pointermove", pointer, { passive: true });
    resizeObserver.observe(this.#container);
    this.#disposers.add(() => window.removeEventListener("resize", resize));
    this.#disposers.add(() =>
      this.#renderer.domElement.removeEventListener("pointermove", pointer),
    );
    this.#disposers.add(() => resizeObserver.disconnect());
    this.#resize();
  }

  async load(): Promise<StageCapabilities> {
    this.#assertActive();
    const revision = ++this.#loadRevision;
    this.#disposeVrm();
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(LOCAL_VRM_URL);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error("vrm_missing_from_local_asset");
    }
    if (this.#disposed || revision !== this.#loadRevision) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error("stale_vrm_load");
    }

    this.#vrm = vrm;
    vrm.scene.rotation.y = Math.PI;
    vrm.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    this.#scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.#gazeTarget;
    this.#hip = vrm.humanoid?.getNormalizedBoneNode("hips") ?? null;
    this.#rightUpperArm = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm") ?? null;
    this.#rightLowerArm = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm") ?? null;
    for (const boneName of Object.keys(RELAXED_POSE_OFFSETS) as PoseBoneName[]) {
      const bone = vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
      if (bone) this.#poseBones.set(boneName, bone);
    }
    for (const boneName of Object.keys(IDLE_BODY_OFFSETS) as IdleBoneName[]) {
      const bone = vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
      if (bone) this.#idleBones.set(boneName, bone);
    }
    for (const bone of [
      this.#hip,
      this.#rightUpperArm,
      this.#rightLowerArm,
      ...this.#poseBones.values(),
      ...this.#idleBones.values(),
    ])
      this.#rememberBone(bone);
    this.#restoreBones();
    vrm.update(0);
    this.#frameCamera();
    this.#clock.start();
    this.#startLoop();
    return this.capabilities();
  }

  capabilities(): StageCapabilities {
    return {
      lookAt: Boolean(this.#vrm?.lookAt),
      blink: Boolean(this.#vrm?.expressionManager),
      viseme: Boolean(this.#vrm?.expressionManager),
      gesture: Boolean(this.#rightUpperArm && this.#rightLowerArm),
    };
  }

  setReducedMotion(value: boolean): void {
    this.#reducedMotion = value;
    if (value) {
      this.#gestureStartedAt = null;
      this.#restoreBones();
    }
  }

  graphicsPreset(): GraphicsPreset {
    return this.#graphicsPreset;
  }

  setGraphicsPreset(value: GraphicsPreset): void {
    this.#graphicsPreset = value;
    this.#applyGraphicsPreset();
    this.#resize();
  }

  cameraFraming(): CameraFraming {
    return this.#cameraFraming;
  }

  setCameraFraming(value: CameraFraming): void {
    this.#cameraFraming = value;
    this.#frameCamera();
  }

  triggerExpression(): void {
    this.#assertActive();
    this.#setExpression(["happy", "joy", "fun"], 0.85);
    window.setTimeout(() => this.#setExpression(["happy", "joy", "fun"], 0), 900);
  }

  triggerGesture(): void {
    this.#assertActive();
    if (this.#reducedMotion || !this.#rightUpperArm || !this.#rightLowerArm) return;
    this.#gestureStartedAt = performance.now();
  }

  async playTestTone(): Promise<void> {
    this.#assertActive();
    this.stopAudio();
    const context = new AudioContext();
    await context.resume();
    const source = context.createOscillator();
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      context.currentTime + TEST_TONE_DURATION_MS / 1000,
    );
    source.type = "sine";
    source.frequency.setValueAtTime(210, context.currentTime);
    source.connect(gain);
    gain.connect(context.destination);
    gain.connect(analyser);
    source.start();
    source.stop(context.currentTime + TEST_TONE_DURATION_MS / 1000 + 0.02);
    source.addEventListener("ended", () => this.stopAudio(), { once: true });
    this.#audio = { context, source, gain, analyser, data: new Uint8Array(analyser.fftSize) };
  }

  stopAudio(): void {
    const audio = this.#audio;
    this.#audio = null;
    this.#setExpression(["aa", "a"], 0);
    if (!audio) return;
    try {
      audio.source.stop();
    } catch {
      /* already stopped */
    }
    audio.source.disconnect();
    audio.gain.disconnect();
    audio.analyser.disconnect();
    void audio.context.close();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadRevision += 1;
    if (this.#animationFrame !== null) cancelAnimationFrame(this.#animationFrame);
    this.#animationFrame = null;
    this.stopAudio();
    this.#disposers.dispose();
    this.#disposeVrm();
    this.#renderer.renderLists.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    this.#renderer.domElement.remove();
  }

  #startLoop(): void {
    if (this.#animationFrame !== null) return;
    const frame = (now: number) => {
      if (this.#disposed) return;
      this.#animationFrame = requestAnimationFrame(frame);
      const delta = this.#clock.getDelta();
      this.#updateBlink(now);
      this.#updateIdleGaze(now);
      this.#applyRelaxedPose();
      this.#updateIdle(now);
      this.#updateGesture(now);
      this.#updateLipSync();
      this.#vrm?.update(delta);
      this.#renderer.render(this.#scene, this.#camera);
    };
    this.#animationFrame = requestAnimationFrame(frame);
  }

  #updateBlink(now: number): void {
    if (this.#reducedMotion || !this.#vrm?.expressionManager) return;
    const elapsed = now - this.#blinkStartedAt;
    if (elapsed > BLINK_DURATION_MS) {
      this.#setExpression(["blink", "blinkLeft", "blinkRight", "blink_l", "blink_r"], 0);
      this.#blinkStartedAt = now + BLINK_INTERVAL_MS;
      return;
    }
    if (elapsed >= 0) {
      const intensity = Math.sin((elapsed / BLINK_DURATION_MS) * Math.PI);
      this.#setExpression(["blink", "blinkLeft", "blinkRight", "blink_l", "blink_r"], intensity);
    }
  }

  #updateIdle(now: number): void {
    if (this.#reducedMotion) return;
    const motion = idleMotionAt(now);
    const hipRest = this.#hip ? this.#boneRest.get(this.#hip) : undefined;
    if (this.#hip && hipRest) {
      this.#hip.position.set(
        hipRest.position.x + motion.weightShift * 0.012,
        hipRest.position.y + motion.breath * 0.009,
        hipRest.position.z,
      );
      this.#hip.rotation.set(
        hipRest.rotation.x,
        hipRest.rotation.y + motion.weightShift * 0.018,
        hipRest.rotation.z + motion.weightShift * 0.012,
        hipRest.rotation.order,
      );
    }
    for (const [boneName, bone] of this.#idleBones) {
      const boneRest = this.#boneRest.get(bone);
      if (!boneRest) continue;
      const offset = IDLE_BODY_OFFSETS[boneName];
      const isHead = boneName === "head" || boneName === "neck";
      const nod = isHead ? motion.headNod * 0.026 : 0;
      const turn = isHead ? motion.headTurn * 0.036 : motion.torsoTwist * 0.024;
      bone.rotation.set(
        boneRest.rotation.x + motion.breath * offset.x + nod,
        boneRest.rotation.y + motion.torsoTwist * offset.y + turn,
        boneRest.rotation.z + motion.torsoLean * offset.z,
        boneRest.rotation.order,
      );
    }
    this.#updateAmbientGesture(motion.ambientGesture);
  }

  #updateAmbientGesture(gesture: AmbientGesture): void {
    if (!gesture.active || this.#gestureStartedAt || !this.#rightUpperArm || !this.#rightLowerArm)
      return;
    const upperRest = this.#relaxedRest(this.#rightUpperArm, "rightUpperArm");
    const lowerRest = this.#relaxedRest(this.#rightLowerArm, "rightLowerArm");
    if (!upperRest || !lowerRest) return;
    this.#rightUpperArm.rotation.set(
      upperRest.rotation.x + gesture.upperArmX,
      upperRest.rotation.y,
      upperRest.rotation.z + gesture.upperArmZ,
      upperRest.rotation.order,
    );
    this.#rightLowerArm.rotation.set(
      lowerRest.rotation.x + gesture.lowerArmX,
      lowerRest.rotation.y + gesture.lowerArmY,
      lowerRest.rotation.z,
      lowerRest.rotation.order,
    );
  }

  #updateGesture(now: number): void {
    if (!this.#gestureStartedAt || !this.#rightUpperArm || !this.#rightLowerArm) return;
    const elapsed = now - this.#gestureStartedAt;
    const progress = elapsed / 1_250;
    if (progress >= 1) {
      this.#gestureStartedAt = null;
      this.#restoreBones();
      return;
    }
    const upperRest = this.#relaxedRest(this.#rightUpperArm, "rightUpperArm");
    const lowerRest = this.#relaxedRest(this.#rightLowerArm, "rightLowerArm");
    if (!upperRest || !lowerRest) return;
    const lift = Math.sin(((Math.min(progress, 0.35) / 0.35) * Math.PI) / 2);
    const wave = Math.sin(progress * Math.PI * 6) * 0.3;
    this.#rightUpperArm.rotation.set(
      upperRest.rotation.x + lift * 0.75,
      upperRest.rotation.y,
      upperRest.rotation.z - lift * 0.5,
    );
    this.#rightLowerArm.rotation.set(
      lowerRest.rotation.x + lift * 0.55,
      lowerRest.rotation.y + wave,
      lowerRest.rotation.z,
    );
  }

  #updateLipSync(): void {
    const audio = this.#audio;
    if (!audio || this.#reducedMotion) return;
    audio.analyser.getByteTimeDomainData(audio.data);
    let energy = 0;
    for (const value of audio.data) {
      const normalized = (value - 128) / 128;
      energy += normalized * normalized;
    }
    const amplitude = Math.min(0.8, Math.sqrt(energy / audio.data.length) * 3.8);
    this.#setExpression(["aa", "a"], amplitude);
  }

  #trackPointer(event: PointerEvent): void {
    if (this.#reducedMotion || !this.#vrm?.lookAt) return;
    const pointer = normalizePointer(
      event.clientX,
      event.clientY,
      this.#renderer.domElement.getBoundingClientRect(),
    );
    this.#gazeTarget.position.set(pointer.x * 0.75, 1.35 + pointer.y * 0.45, 0.3);
    this.#lastPointerAt = performance.now();
  }

  #updateIdleGaze(now: number): void {
    if (this.#reducedMotion || !this.#vrm?.lookAt || now - this.#lastPointerAt < 1_800) return;
    const gaze = idleGazeAt(now);
    this.#gazeTarget.position.set(gaze.x, 1.35 + gaze.y, 0.3);
  }

  #setExpression(names: readonly string[], value: number): void {
    for (const name of names) this.#vrm?.expressionManager?.setValue(name, value);
  }

  #restoreBones(): void {
    for (const [bone, rest] of this.#boneRest) {
      bone.position.copy(rest.position);
      bone.rotation.copy(rest.rotation);
    }
    this.#applyRelaxedPose();
  }

  #applyRelaxedPose(): void {
    for (const [boneName, offset] of Object.entries(RELAXED_POSE_OFFSETS) as Array<
      [PoseBoneName, (typeof RELAXED_POSE_OFFSETS)[PoseBoneName]]
    >) {
      const bone = this.#poseBones.get(boneName);
      const rest = bone ? this.#boneRest.get(bone) : null;
      if (!bone || !rest) continue;
      bone.rotation.set(
        rest.rotation.x + offset.x,
        rest.rotation.y + offset.y,
        rest.rotation.z + offset.z,
        rest.rotation.order,
      );
    }
  }

  #rememberBone(bone: THREE.Object3D | null): void {
    if (bone && !this.#boneRest.has(bone)) {
      this.#boneRest.set(bone, {
        position: bone.position.clone(),
        rotation: bone.rotation.clone(),
      });
    }
  }

  #relaxedRest(bone: THREE.Object3D, boneName: PoseBoneName): BoneSnapshot | null {
    const rest = this.#boneRest.get(bone);
    if (!rest) return null;
    const offset = RELAXED_POSE_OFFSETS[boneName];
    return {
      position: rest.position,
      rotation: new THREE.Euler(
        rest.rotation.x + offset.x,
        rest.rotation.y + offset.y,
        rest.rotation.z + offset.z,
        rest.rotation.order,
      ),
    };
  }

  #applyGraphicsPreset(): void {
    const profile = GRAPHICS_PROFILES[this.#graphicsPreset];
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.pixelRatioCap));
    this.#renderer.toneMappingExposure = profile.toneMappingExposure;
    this.#renderer.shadowMap.enabled = profile.shadows;
    this.#keyLight.intensity = profile.keyLightIntensity;
    this.#keyLight.castShadow = profile.shadows;
    this.#rimLight.intensity = profile.rimLightIntensity;
    if (this.#ground) this.#ground.visible = profile.shadows;
  }

  #frameCamera(): void {
    const vrm = this.#vrm;
    if (!vrm) return;
    vrm.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const verticalFov = THREE.MathUtils.degToRad(this.#camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.#camera.aspect);
    const verticalDistance = size.y / (2 * Math.tan(verticalFov / 2));
    const horizontalDistance = Math.max(size.x, size.z) / (2 * Math.tan(horizontalFov / 2));
    const framing = CAMERA_FRAMING[this.#cameraFraming];
    const distance =
      Math.max(1.8, verticalDistance, horizontalDistance) * framing.distanceMultiplier;
    const focusY = center.y + size.y * framing.verticalOffset;
    this.#camera.position.set(center.x, focusY, center.z + distance);
    this.#camera.lookAt(center.x, focusY, center.z);
    this.#positionGround(bounds, size, center);
  }

  #positionGround(bounds: THREE.Box3, size: THREE.Vector3, center: THREE.Vector3): void {
    const footprint = Math.max(1.8, size.x, size.z) * 1.8;
    this.#disposeGround();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(footprint, footprint),
      new THREE.ShadowMaterial({ color: 0x081126, opacity: 0.22, transparent: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, bounds.min.y - 0.01, center.z);
    ground.receiveShadow = true;
    ground.visible = GRAPHICS_PROFILES[this.#graphicsPreset].shadows;
    this.#ground = ground;
    this.#scene.add(ground);
  }

  #resize(): void {
    const width = Math.max(1, this.#container.clientWidth);
    const height = Math.max(1, this.#container.clientHeight);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height, false);
    this.#frameCamera();
  }

  #disposeVrm(): void {
    this.#gestureStartedAt = null;
    this.#disposeGround();
    const vrm = this.#vrm;
    this.#vrm = null;
    this.#boneRest.clear();
    this.#poseBones.clear();
    this.#idleBones.clear();
    this.#hip = null;
    this.#rightUpperArm = null;
    this.#rightLowerArm = null;
    if (!vrm) return;
    this.#scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }

  #disposeGround(): void {
    const ground = this.#ground;
    this.#ground = null;
    if (!ground) return;
    this.#scene.remove(ground);
    ground.geometry.dispose();
    ground.material.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("stage_disposed");
  }
}
