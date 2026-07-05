// Imperative render engine — Three.js objects live ONLY under
// apps/client/src/engine/ (lint-enforced: `no-restricted-imports`/boundaries
// forbid `three` anywhere else, and `ui/` must stay geometry-free).
//
// This is a Phase 0 placeholder: a neutral grid + hemisphere-light scene
// with orbit controls, wired for resize and disposal. Phase 1 replaces the
// placeholder contents with real scan/mesh rendering; the mount lifecycle
// here (construct on mount, dispose on unmount) is the pattern that stays.
//
// NO React imports here — this class is framework-agnostic and is mounted
// imperatively by ui/Viewport.tsx via useRef + useEffect.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Minimal "mesh visible in scene" wiring for Task 5 (client import flow) —
 * just enough for a manual import check to show something in the viewport.
 * Task 6 (the real viewer) owns proper materials/shading/LOD/selection;
 * `setRenderNodes` below intentionally does the simplest possible thing
 * (dispose everything, rebuild from scratch on every call) rather than
 * diffing — fine for Phase 1's few-mesh, infrequent-update case.
 */
export interface RenderNode {
  id: string;
  /** Float32, already re-centered at the case bbox centroid — see
   * engine/meshStore.ts's module doc. SceneManager never re-centers or
   * otherwise transforms these; it only renders them as given. */
  positions: Float32Array;
  indices: Uint32Array;
  visible: boolean;
  opacity: number;
}

const CAMERA_FOV_DEGREES = 50;
const CAMERA_NEAR_MM = 0.1;
const CAMERA_FAR_MM = 5000;
// Placeholder framing only — arbitrary mm-scale distance for a neutral grid,
// not tied to any real case geometry.
const CAMERA_START_POSITION_MM = [0, 120, 220] as const;
const GRID_SIZE_MM = 400;
const GRID_DIVISIONS = 40;

export class SceneManager {
  private readonly container: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly meshGroup: Group;
  private animationFrameId: number | null = null;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene = new Scene();
    this.scene.background = new Color(0x1a1a1a);

    this.camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR_MM, CAMERA_FAR_MM);
    this.camera.position.set(...CAMERA_START_POSITION_MM);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new HemisphereLight(0xffffff, 0x3a3a3a, 1.4));
    this.scene.add(new GridHelper(GRID_SIZE_MM, GRID_DIVISIONS, 0x666666, 0x333333));

    this.meshGroup = new Group();
    this.scene.add(this.meshGroup);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.handleResize();

    this.animate = this.animate.bind(this);
    this.animationFrameId = requestAnimationFrame(this.animate);
  }

  /**
   * Rebuilds the mesh group from `nodes` — called by ui/Viewport.tsx
   * whenever the case document (SceneNode list) or a mesh's render buffers
   * change. Disposes every previous geometry/material first (Three.js GPU
   * resources are not garbage-collected automatically).
   */
  setRenderNodes(nodes: readonly RenderNode[]): void {
    this.clearMeshGroup();
    for (const node of nodes) {
      if (!node.visible) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(node.positions, 3));
      geometry.setIndex(new BufferAttribute(node.indices, 1));
      geometry.computeVertexNormals();
      const material = new MeshStandardMaterial({
        color: 0xd8d0c0,
        transparent: node.opacity < 1,
        opacity: node.opacity,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.name = node.id;
      this.meshGroup.add(mesh);
    }
  }

  private clearMeshGroup(): void {
    for (const child of [...this.meshGroup.children]) {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((material) => material.dispose());
        } else {
          child.material.dispose();
        }
      }
      this.meshGroup.remove(child);
    }
  }

  private handleResize(): void {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate(): void {
    if (this.disposed) {
      return;
    }
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.clearMeshGroup();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
