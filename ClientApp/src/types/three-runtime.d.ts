// Three.js r165 does not publish TypeScript declarations in the package itself.
// Phase 0 keeps these modules isolated behind the digital-twin adapter. A matching
// @types/three package will replace this compatibility shim during dependency alignment.
declare module 'three';
declare module 'three/examples/jsm/controls/OrbitControls.js';
declare module 'three/examples/jsm/controls/TransformControls.js';
declare module 'three/examples/jsm/loaders/GLTFLoader.js';
