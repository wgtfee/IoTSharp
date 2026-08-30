import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class BaggingMachineComponent implements TwinComponentGenerator {
	readonly componentType = 'bagging-machine' as const;
	readonly generator = 'bagging-machine-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 4, 2, 12);
		const width = resolveNumber(props, 'width', 3, 1.2, 8);
		const machineHeight = resolveNumber(props, 'machineHeight', 3.4, 1.5, 8);
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
		conveyor.name = 'BaggingConveyor';
		root.add(conveyor);
		const shellMaterial = createMaterial(0x7c3aed, { transparent: true, opacity: 0.2, roughness: 0.4, metalness: 0.34, side: THREE.DoubleSide });
		const shell = new THREE.Mesh(new THREE.BoxGeometry(length, machineHeight, width), shellMaterial);
		shell.name = 'BaggingShell';
		shell.position.y = machineHeight / 2;
		root.add(shell);
		const frameMaterial = createMaterial(0x5b21b6, { roughness: 0.48, metalness: 0.66 });
		for (const x of [-length / 2, length / 2]) {
			for (const z of [-width / 2, width / 2]) {
				const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, machineHeight, 0.1), frameMaterial);
				post.position.set(x, machineHeight / 2, z);
				root.add(post);
			}
		}
		const filmRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, width * 0.72, 20), createMaterial(0xc4b5fd, { roughness: 0.26, metalness: 0.15 }));
		filmRoll.name = 'FilmRoll';
		filmRoll.rotation.x = Math.PI / 2;
		filmRoll.position.set(-length * 0.22, machineHeight - 0.45, 0);
		root.add(filmRoll);
		const filmCurtain = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.72, machineHeight * 0.62), createMaterial(0xddd6fe, { transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0, side: THREE.DoubleSide }));
		filmCurtain.name = 'FilmCurtain';
		filmCurtain.position.set(0.15, conveyorHeight + machineHeight * 0.28, 0);
		filmCurtain.rotation.y = Math.PI / 2;
		root.add(filmCurtain);
		const label = createCanvasLabel('套袋机');
		label.position.set(0, machineHeight + 0.55, width / 2 + 0.02);
		root.add(label);
		const statusLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 10), createMaterial(0x22c55e, { emissive: 0x22c55e, emissiveIntensity: 0.62 }));
		statusLight.name = 'StatusLight';
		statusLight.position.set(length / 2 - 0.3, machineHeight + 0.18, width / 2 - 0.25);
		root.add(statusLight);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, conveyorHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, conveyorHeight, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.processType = 'bagging';
		root.userData.capabilities = ['material-flow', 'capacity', 'process-station', 'plc-binding'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
