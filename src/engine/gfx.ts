import * as THREE from 'three';
import { RenderPipeline, WebGPURenderer, PMREMGenerator } from 'three/webgpu';
import { pass, mrt, output, normalView, uniform, vec3, vec4, mix, float, screenUV, smoothstep, length, vec2, renderOutput, dot, step, getViewPosition, exp, max, fog as tslFog } from 'three/tsl';
import { bloomEmissive, fbm2, fogBase, fogDensity, fogKeep, hash21, worldTime, type N } from './materials';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

const QUALITY: Record<Quality, { ratio: number; ao: boolean; shadows: boolean; shadowSize: number; aa: boolean }> = {
  low: { ratio: 0.75, ao: false, shadows: false, shadowSize: 1024, aa: false },
  medium: { ratio: 1, ao: false, shadows: true, shadowSize: 1024, aa: true },
  high: { ratio: 1.25, ao: true, shadows: true, shadowSize: 2048, aa: true },
  ultra: { ratio: 1.5, ao: true, shadows: true, shadowSize: 4096, aa: true },
};

export const QUALITIES = Object.keys(QUALITY) as Quality[];

/** Where the player's own quality choice is kept (the settings record; `game.ts` writes it). */
export const SETTINGS_KEY = 'wk.settings.v1';

/** The quality the player chose in the pause menu (or the desktop edition chose for this machine), if any. */
export function savedQuality(): Quality | null {
  try {
    const q = (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { quality?: string }).quality;
    return q && q in QUALITY ? (q as Quality) : null;
  } catch {
    return null;
  }
}

/**
 * WebGPU renderer (Three.js r186, TSL node materials) with an automatic WebGL2 backend where WebGPU is missing.
 * Post-processing runs as a node graph: scene pass with MRT normals → GTAO → bloom → FXAA → tone-mapped output.
 */
export class Gfx {
  readonly renderer: WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.15, 6000);
  readonly hemi = new THREE.HemisphereLight(0x88ccff, 0x112211, 0.9);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.2);
  readonly playerLight = new THREE.PointLight(0x5cffc1, 10, 16, 1.7);
  /** Bloom node: strength / radius / threshold uniforms are live. */
  bloom!: ReturnType<typeof bloom>;
  private pipeline!: RenderPipeline;
  private aoStrength = uniform(0.85);
  private vignette = uniform(0.35);
  /** Light shafts: the sun's screen position, its visibility (0 behind the camera) and colour. */
  private sunUV = uniform(new THREE.Vector2(0.5, -0.2));
  private sunVis = uniform(0);
  readonly shaftColor = uniform(new THREE.Color(0.55, 0.85, 1.0));
  readonly shaftStrength = uniform(0.22);
  /** Grade: global saturation, highlight desaturation (neon cores burn toward white) and shadow tint. */
  readonly saturation = uniform(0.95);
  /** Ground mist: drifting low fog pooled in the hollows (world height base, density, colour). */
  readonly mistBase = uniform(0);
  private readonly fogColor = uniform(new THREE.Color());
  readonly mistStrength = uniform(0.32);
  readonly mistColor = uniform(new THREE.Color(0.18, 0.42, 0.48));
  private projInv = uniform(new THREE.Matrix4());
  private camWorld = uniform(new THREE.Matrix4());
  readonly shadowTint = uniform(new THREE.Color(0.002, 0.006, 0.009));
  /** Contrast around mid-grey (linear 0.18): >1 deepens shadows and lifts highlights. */
  readonly contrast = uniform(1.15);
  private pixelRatio: number;
  private lowQualityTimer = 0;
  private frames = 0;
  private fpsAcc = 0;
  fps = 60;
  bloomEnabled = true;
  /** Screen-space light shafts (high quality and up; `?noshafts` disables). */
  shafts = !new URLSearchParams(location.search).has('noshafts');
  private adaptive = true;
  quality: Quality;
  readonly backend: 'webgpu' | 'webgl2';
  private pmrem: PMREMGenerator;
  private envRT: THREE.RenderTarget | null = null;

  /** Use `Gfx.create` — the renderer has to finish its async init before the first frame. */
  private constructor(readonly container: HTMLElement, forceWebGL: boolean) {
    const q = new URLSearchParams(location.search);
    this.renderer = new WebGPURenderer({ antialias: false, powerPreference: 'high-performance', forceWebGL });
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.quality = (q.get('quality') as Quality) || savedQuality() || (coarse ? 'low' : 'high');
    if (!QUALITY[this.quality]) this.quality = 'high';
    this.pixelRatio = Number(q.get('scale')) || Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].ratio);
    this.adaptive = !q.has('noadapt') && !q.has('scale');
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = QUALITY[this.quality].shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.id = 'game-canvas';
    this.backend = 'webgl2';
    this.pmrem = new PMREMGenerator(this.renderer);

    this.scene.add(this.hemi, this.sun, this.sun.target, this.playerLight);
    this.sun.position.set(30, 60, 20);
    this.configureShadows();
    if (q.has('nobloom')) this.bloomEnabled = false;
    window.addEventListener('resize', () => this.resize());
  }

  static async create(container: HTMLElement): Promise<Gfx> {
    const q = new URLSearchParams(location.search);
    const g = new Gfx(container, q.has('webgl'));
    await g.renderer.init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isGPU = !!(g.renderer.backend as any).isWebGPUBackend;
    (g as { backend: 'webgpu' | 'webgl2' }).backend = isGPU ? 'webgpu' : 'webgl2';
    g.buildPipeline();
    g.resize();
    return g;
  }

  private configureShadows() {
    const s = this.sun.shadow;
    const Q = QUALITY[this.quality];
    this.sun.castShadow = Q.shadows;
    s.mapSize.set(Q.shadowSize, Q.shadowSize);
    const cam = s.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -55;
    cam.right = cam.top = 55;
    cam.near = 1;
    cam.far = 260;
    s.bias = -0.0006;
    s.normalBias = 0.04;
    s.radius = 3;
  }

  /**
   * Scene pass writing colour, emissive light (and view normals for GTAO) → ambient occlusion → selective
   * bloom of the emissive target (blueprint: strength 1.4, radius 0.5, threshold 0.2) → FXAA → vignette.
   */
  private buildPipeline() {
    const Q = QUALITY[this.quality];
    const pipeline = new RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    scenePass.setMRT(Q.ao ? mrt({ output, emissive: bloomEmissive, normal: normalView }) : mrt({ output, emissive: bloomEmissive }));
    const color = scenePass.getTextureNode('output');
    let lit: N = color;
    if (Q.ao) {
      const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), this.camera);
      aoPass.resolutionScale = 0.5;
      const occl = aoPass.getTextureNode().sample(screenUV).r;
      lit = vec4(color.rgb.mul(mix(float(1), occl, this.aoStrength)), color.a);
    }
    {
      // ground mist from the depth buffer: reconstruct each pixel's world position; fog thickens with
      // distance and pools below a few metres above the ground, drifting with low-frequency noise
      const depth = scenePass.getTextureNode('depth');
      const d: N = depth.sample(screenUV).r;
      const vp: N = getViewPosition(screenUV, d, this.projInv);
      const wp: N = this.camWorld.mul(vec4(vp, 1)).xyz;
      const dist: N = vp.length();
      const drift: N = fbm2(wp.xz.mul(0.035).add(vec2(worldTime.mul(0.02), worldTime.mul(-0.013))));
      const height: N = exp(max(wp.y.sub(this.mistBase), 0).mul(-0.45));
      const along: N = float(1).sub(exp(dist.mul(-0.012)));
      const far: N = float(1).sub(smoothstep(220, 1400, dist).mul(0.65)); // the far land keeps its silhouettes
      const mist: N = along.mul(height).mul(far).mul(drift.mul(0.9).add(0.35)).mul(this.mistStrength).mul(step(d, 0.99999)).min(0.85);
      lit = vec4(mix(lit.rgb, this.mistColor, mist), lit.a);
    }
    if (Q.ao && this.shafts) {
      // crepuscular light shafts: march from each pixel toward the sun, gathering open sky (depth at the far
      // plane) through gaps in the canopy, with exponential decay — volumetric light through the fog
      const depth = scenePass.getTextureNode('depth');
      const N_RAY = 16;
      const step0: N = this.sunUV.sub(screenUV).mul(0.85 / N_RAY);
      let shafts: N = float(0);
      let w = 1;
      // per-pixel jitter of the march start hides the banding of so few taps
      const jit: N = hash21(screenUV.mul(1731.0));
      for (let i = 1; i <= N_RAY; i++) {
        shafts = shafts.add(step(0.99999, depth.sample(screenUV.add(step0.mul(jit.add(i)))).r).mul(w));
        w *= 0.88;
      }
      shafts = shafts.mul((1 - 0.88) / (1 - Math.pow(0.88, N_RAY)));
      const ray: N = shafts.mul(this.shaftStrength).mul(this.sunVis);
      lit = vec4(lit.rgb.add(this.shaftColor.mul(ray)), lit.a);
    }
    this.bloom = bloom(scenePass.getTextureNode('emissive'), 1.4, 0.5, 0.2);
    let out: N = this.bloomEnabled ? lit.add(this.bloom) : lit;
    // grade in linear light: neon highlights desaturate toward white, a global saturation trim, cool shadows
    {
      const c: N = out.rgb;
      const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      const hi = smoothstep(1.0, 5.0, lum);
      const g1 = mix(vec3(lum), c, float(1).sub(hi.mul(0.5)).mul(this.saturation));
      const g15 = g1.div(0.18).max(vec3(0)).pow(vec3(this.contrast)).mul(0.18);
      const g2 = g15.add(this.shadowTint.mul(float(1).sub(smoothstep(0.0, 0.2, lum))));
      out = vec4(g2, 1);
    }
    // tone map + sRGB inside the graph so FXAA works on display values
    out = renderOutput(out);
    if (Q.aa) out = fxaa(out);
    // soft optical vignette
    const d = length(screenUV.sub(vec2(0.5)));
    out = vec4(out.rgb.mul(float(1).sub(smoothstep(0.45, 0.95, d).mul(this.vignette))), 1);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = out;
    this.pipeline = pipeline;
  }

  setBloom(on: boolean) {
    if (on === this.bloomEnabled) return;
    this.bloomEnabled = on;
    this.buildPipeline();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Pixel scale used by world-sized sprites (half the drawing-buffer height over tan(fov/2)). */
  get pointScale() {
    return (this.renderer.domElement.height * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** Seconds during which fps samples are ignored (shader compiles after a world swap). */
  grace = 5;

  /** Self-tuning quality: drop pixel ratio, then AO/bloom, if the frame rate stays low. */
  adapt(dt: number) {
    if (this.grace > 0) {
      this.grace -= dt;
      this.frames = 0;
      this.fpsAcc = 0;
      return;
    }
    this.frames++;
    this.fpsAcc += dt;
    if (this.fpsAcc < 1) return;
    this.fps = this.frames / this.fpsAcc;
    this.frames = 0;
    this.fpsAcc = 0;
    if (!this.adaptive) return;
    if (this.fps < 28) this.lowQualityTimer++;
    else this.lowQualityTimer = Math.max(0, this.lowQualityTimer - 1);
    if (this.lowQualityTimer >= 3) {
      this.lowQualityTimer = 0;
      if (this.pixelRatio > 1) {
        this.pixelRatio = 1;
        this.resize();
      } else if (this.quality === 'ultra' || this.quality === 'high') {
        this.setQuality('medium');
      } else if (this.pixelRatio > 0.8) {
        this.pixelRatio = 0.75;
        this.resize();
      } else if (this.quality === 'medium') {
        this.setQuality('low');
      } else if (this.bloomEnabled) {
        this.setBloom(false);
      }
    }
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.renderer.shadowMap.enabled = QUALITY[q].shadows;
    this.configureShadows();
    this.buildPipeline();
  }

  /** Keep the sun's shadow frustum centred on the hero. */
  followShadow(x: number, y: number, z: number) {
    // the mist pools a little below the hero; ease it so jumps and flight don't pump the fog
    this.mistBase.value += (y - 1.2 - this.mistBase.value) * 0.02;
    fogBase.value = this.mistBase.value;
    const dir = this.sunDir;
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x + dir.x * 120, y + dir.y * 120, z + dir.z * 120);
    this.sun.target.updateMatrixWorld();
  }
  readonly sunDir = new THREE.Vector3(0.35, 0.8, 0.25).normalize();

  setWorldLook(p: { fog: number; fogDensity: number; hemiSky: number; hemiGround: number; sun: number; accent: number }) {
    const fog = new THREE.Color(p.fog);
    // mist takes the region's fog hue, lifted, so it reads as lit vapour rather than a grey wash
    this.mistColor.value.copy(fog).lerp(new THREE.Color(p.accent), 0.12).multiplyScalar(1.6);
    this.scene.background = fog;
    // height fog (materials.fogKeep) instead of FogExp2: hazy valleys, readable ridgelines on the horizon
    this.fogColor.value.copy(fog);
    this.scene.fog = null;
    this.scene.fogNode ??= tslFog(this.fogColor, float(1).sub(fogKeep));
    fogDensity.value = p.fogDensity;
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.sun.color.set(p.sun);
    this.playerLight.color.set(p.accent);
  }

  /** Image-based lighting: prefilter a small scene (normally the region's sky) into the environment map. */
  setEnvironment(envScene: THREE.Scene, intensity = 0.6) {
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = intensity;
  }

  private _sp = new THREE.Vector3();
  private _fw = new THREE.Vector3();
  render() {
    // project the sun for the light shafts; fade them out as it leaves the view
    const cam = this.camera;
    this._sp.copy(cam.position).addScaledVector(this.sunDir, 1000).project(cam);
    this.sunUV.value.set(this._sp.x * 0.5 + 0.5, 0.5 - this._sp.y * 0.5);
    cam.getWorldDirection(this._fw);
    this.sunVis.value = THREE.MathUtils.smoothstep(this._fw.dot(this.sunDir), -0.1, 0.45);
    this.projInv.value.copy(cam.projectionMatrixInverse);
    this.camWorld.value.copy(cam.matrixWorld);
    this.pipeline.render();
  }
}
