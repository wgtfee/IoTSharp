import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class ExternalInspectionComponent implements TwinComponentGenerator {
	readonly componentType = 'external-inspection' as const;
	readonly generator = 'external-inspection-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 4, 2, 12);
		const width = resolveNumber(props, 'width', 3, 1.2, 8);
		const machineHeight = resolveNumber(props, 'machineHeight', 3.2, 1.5, 8);
		const conveyorHeight = resolveNumber(props, 'conveyorHeight', 0.9, 0.2, 3);
		const conveyorWidth = resolveNumber(props, 'conveyorWidth', 1.6, 0.6, width - 0.2);
		const root = new THREE.Group();
		root.name = definition.name;
		const conveyor = createStraightRollerGeometry({
			length,
			width: conveyorWidth,
			height: conveyorHeight,
			rollerDiameter: 0.14,
			rollerPitch: 0.5,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: 2,
			frameColor: 0x334155,
			rollerColor: 0x94a3b8,
		});
		conveyor.name = 'InspectionConveyor';
		root.add(conveyor);
		const shellMaterial = createMaterial(0x0891b2, { transparent: true, opacity: 0.2, roughness: 0.42, metalness: 0.36, side: THREE.DoubleSide });
		const shell = new THREE.Mesh(new THREE.BoxGeometry(length, machineHeight, width), shellMaterial);
		shell.name = 'InspectionShell';
		shell.position.y = machineHeight / 2;
		root.add(shell);
		const frameMaterial = createMaterial(0x155e75, { roughness: 0.48, metalness: 0.66 });
		for (const x of [-length / 2, length / 2]) {
			for (const z of [-width / 2, width / 2]) {
				const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, machineHeight, 0.1), frameMaterial);
				post.position.set(x, machineHeight / 2, z);
				root.add(post);
			}
		}
		const label = createCanvasLabel('外检机');
		label.position.set(0, machineHeight + 0.55, width / 2 + 0.02);
		root.add(label);
		const statusMaterial = createMaterial(0x22c55e, { emissive: 0x22c55e, emissiveIntensity: 0.62, roughness: 0.3, metalness: 0.35 });
		const statusLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 10), statusMaterial);
		statusLight.name = 'StatusLight';
		statusLight.position.set(length / 2 - 0.3, machineHeight + 0.18, width / 2 - 0.25);
		root.add(statusLight);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, conveyorHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, conveyorHeight, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.processType = 'external-inspection';
		root.userData.capabilities = ['material-flow', 'capacity', 'process-station', 'plc-binding'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
