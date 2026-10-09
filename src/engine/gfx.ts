import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export class Gfx {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
  readonly composer: EffectComposer | null;
  readonly bloom: UnrealBloomPass;
  readonly hemi = new THREE.HemisphereLight(0x88ccff, 0x112211, 0.9);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.2);
  readonly playerLight = new THREE.PointLight(0x5cffc1, 10, 16, 1.7);
  private pixelRatio: number;
  private lowQualityTimer = 0;
  private frames = 0;
  private fpsAcc = 0;
  fps = 60;
  bloomEnabled = true;
  private adaptive = true;

  constructor(readonly container: HTMLElement) {
    const q = new URLSearchParams(location.search);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.pixelRatio = Number(q.get('scale')) || Math.min(window.devicePixelRatio || 1, 1.5);
    this.adaptive = !q.has('noadapt') && !q.has('scale');
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.id = 'game-canvas';

    this.scene.add(this.hemi, this.sun, this.sun.target, this.playerLight);
    this.sun.position.set(30, 60, 20);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.72);
    let composer: EffectComposer | null = null;
    try {
      // Half-float targets need a colour-buffer extension; some older mobile GPUs lack it.
      const ext = this.renderer.extensions;
      const hdr = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
      const target = new THREE.WebGLRenderTarget(1, 1, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4 });
      composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      composer.addPass(this.bloom);
      composer.addPass(new OutputPass());
    } catch (err) {
      console.warn('Post-processing unavailable, rendering directly', err);
      composer = null;
      this.bloom.enabled = false;
    }
    this.composer = composer;

    if (q.has('nobloom')) this.bloom.enabled = this.bloomEnabled = false;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setPixelRatio(this.pixelRatio);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Pixel scale used by point-size shaders. */
  get pointScale() {
    return (this.renderer.domElement.height * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** Self-tuning quality: drop pixel ratio, then bloom, if the frame rate stays low. */
  /** Seconds during which fps samples are ignored (shader compiles after a world swap). */
  grace = 5;

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
      } else if (this.pixelRatio > 0.8) {
        this.pixelRatio = 0.75;
        this.resize();
      } else if (this.bloomEnabled) {
        this.bloomEnabled = false;
        this.bloom.enabled = false;
      }
    }
  }

  setWorldLook(p: { fog: number; fogDensity: number; hemiSky: number; hemiGround: number; sun: number; accent: number }) {
    const fog = new THREE.Color(p.fog);
    this.scene.background = fog;
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(fog);
      this.scene.fog.density = p.fogDensity;
    } else {
      this.scene.fog = new THREE.FogExp2(fog, p.fogDensity);
    }
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.sun.color.set(p.sun);
    this.playerLight.color.set(p.accent);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
