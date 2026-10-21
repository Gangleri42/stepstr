// The GLB parser of every viewer: three.js's, with meshoptimizer's decoder for models published compressed
// (pipeline/compress.ts). The decoder comes from its own entry, so the encoder and the simplifier stay out of the page;
// the napplet build cuts its worker code (pipeline/meshopt-no-workers.ts).
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const gltfLoader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
