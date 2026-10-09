import * as THREE from 'three';
import { RenderPipeline, WebGPURenderer, PMREMGenerator } from 'three/webgpu';
import { pass, mrt, output, normalView, uniform, vec4, mix, float, screenUV, smoothstep, length, vec2, renderOutput } from 'three/tsl';
import { bloomEmissive, fogDensity, type N } from './materials';
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

/**
 * WebGPU renderer (Three.js r186, TSL node materials) with an automatic WebGL2 backend where WebGPU is missing.
 * Post-processing runs as a node graph: scene pass with MRT normals → GTAO → bloom → FXAA → tone-mapped output.
 */
export class Gfx {
  readonly renderer: WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1400);
  readonly hemi = new THREE.HemisphereLight(0x88ccff, 0x112211, 0.9);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.2);
  readonly playerLight = new THREE.PointLight(0x5cffc1, 10, 16, 1.7);
  /** Bloom node: strength / radius / threshold uniforms are live. */
  bloom!: ReturnType<typeof bloom>;
  private pipeline!: RenderPipeline;
  private aoStrength = uniform(0.85);
  private vignette = uniform(0.35);
  private pixelRatio: number;
  private lowQualityTimer = 0;
  private frames = 0;
  private fpsAcc = 0;
  fps = 60;
  bloomEnabled = true;
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
    this.quality = (q.get('quality') as Quality) || (coarse ? 'low' : 'high');
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
    this.bloom = bloom(scenePass.getTextureNode('emissive'), 1.4, 0.5, 0.2);
    let out: N = this.bloomEnabled ? lit.add(this.bloom) : lit;
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
    const dir = this.sunDir;
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x + dir.x * 120, y + dir.y * 120, z + dir.z * 120);
    this.sun.target.updateMatrixWorld();
  }
  readonly sunDir = new THREE.Vector3(0.35, 0.8, 0.25).normalize();

  setWorldLook(p: { fog: number; fogDensity: number; hemiSky: number; hemiGround: number; sun: number; accent: number }) {
    const fog = new THREE.Color(p.fog);
    this.scene.background = fog;
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(fog);
      this.scene.fog.density = p.fogDensity;
    } else {
      this.scene.fog = new THREE.FogExp2(fog, p.fogDensity);
    }
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

  render() {
    this.pipeline.render();
  }
}
