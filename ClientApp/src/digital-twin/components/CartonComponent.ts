import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator } from './types';

const addBox = (parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name;
	mesh.position.set(...position);
	parent.add(mesh);
	return mesh;
};

/** 大/小辊道均可使用的独立纸箱运输单元；输送兼容性由 RouteEdge.transportUnitType 决定。 */
export class CartonComponent implements TwinComponentGenerator {
	readonly componentType = 'carton' as const;
	readonly generator = 'carton-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 1.20, 0.20, 6);
		const width = resolveNumber(props, 'width', 0.90, 0.20, 4);
		const height = resolveNumber(props, 'height', 0.80, 0.15, 4);
		const root = new THREE.Group();
		root.name = definition.name;

		const cardboard = createMaterial(0xa66a3f, { roughness: 0.92, metalness: 0.0 });
		const edge = createMaterial(0x7c4a24, { roughness: 0.95, metalness: 0.0 });
		const tape = createMaterial(0xd6b47b, { roughness: 0.78, metalness: 0.0 });
		const body = addBox(root, 'Carton-Body', [length, height, width], [0, height / 2, 0], cardboard);
		body.userData.cartonBody = true;

		const seamThickness = Math.max(0.012, Math.min(0.028, height * 0.035));
		addBox(root, 'Carton-Top-Seam-Tape', [length * 0.92, seamThickness, Math.min(0.10, width * 0.14)], [0, height + seamThickness / 2, 0], tape).userData.cartonTape = true;
		for (const x of [-length / 2, length / 2]) {
			addBox(root, 'Carton-Vertical-Edge-' + (x < 0 ? 'XN' : 'XP'), [0.018, height * 0.94, width * 0.96], [x + (x < 0 ? 0.010 : -0.010), height / 2, 0], edge).userData.cartonEdge = true;
		}
		for (const z of [-width / 2, width / 2]) {
			addBox(root, 'Carton-Side-Mark-' + (z < 0 ? 'ZN' : 'ZP'), [length * 0.34, height * 0.12, 0.012], [0, height * 0.55, z + (z < 0 ? -0.007 : 0.007)], edge).userData.handlingMark = true;
		}

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.resourceKey = definition.resourceKey;
		root.userData.generator = this.generator;
		root.userData.transportUnitType = 'carton';
		root.userData.routeManagedExternally = true;
		root.userData.properties = { ...props, length, width, height, routeManagedExternally: true };
		setTransform(root, definition.transform);
		return createComponentResult(root, []);
	}
}
