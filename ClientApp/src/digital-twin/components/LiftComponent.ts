import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class LiftComponent implements TwinComponentGenerator {
	readonly componentType = 'lift' as const;
	readonly generator = 'lift-v1';

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const platformLength = resolveNumber(props, 'platformLength', 2.2, 0.8, 8);
		const width = resolveNumber(props, 'width', 1.8, 0.6, 6);
		const baseHeight = resolveNumber(props, 'baseHeight', 0.9, 0.2, 3);
		const liftHeight = resolveNumber(props, 'liftHeight', 4, 0.5, 30);
		const columnSize = resolveNumber(props, 'columnSize', 0.18, 0.08, 0.8);
		const root = new THREE.Group();
		root.name = definition.name;
		const frameMaterial = createMaterial(0x334155, { roughness: 0.56, metalness: 0.7 });
		const accentMaterial = createMaterial(0x0ea5e9, { roughness: 0.34, metalness: 0.62, emissive: 0x082f49, emissiveIntensity: 0.22 });
		for (const x of [-platformLength / 2, platformLength / 2]) {
			for (const z of [-width / 2, width / 2]) {
				const column = new THREE.Mesh(new THREE.BoxGeometry(columnSize, liftHeight + baseHeight + 0.5, columnSize), frameMaterial);
				column.position.set(x, (liftHeight + baseHeight) / 2, z);
				column.name = 'LiftColumn';
				root.add(column);
			}
		}
		const topFrame = new THREE.Mesh(new THREE.BoxGeometry(platformLength + 0.35, 0.18, width + 0.35), frameMaterial);
		topFrame.position.y = baseHeight + liftHeight + 0.2;
		topFrame.name = 'TopFrame';
		root.add(topFrame);
		const platform = new THREE.Group();
		platform.name = 'LiftPlatform';
		platform.position.y = 0;
		platform.userData.liftTravel = liftHeight;
		platform.add(createStraightRollerGeometry({
			length: platformLength,
			width,
			height: baseHeight,
			rollerDiameter: 0.14,
			rollerPitch: 0.48,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: 2,
			frameColor: 0x475569,
			rollerColor: 0x94a3b8,
		}));
		root.add(platform);
		const statusLight = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), accentMaterial);
		statusLight.name = 'StatusLight';
		statusLight.position.set(platformLength / 2 + 0.25, baseHeight + liftHeight + 0.35, width / 2 + 0.1);
		root.add(statusLight);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input-lower', name: '下层入口', type: 'material-input', localPosition: [-platformLength / 2, baseHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output-lower', name: '下层出口', type: 'material-output', localPosition: [platformLength / 2, baseHeight, 0], localDirection: [1, 0, 0] },
			{ portId: 'input-upper', name: '上层入口', type: 'material-input', localPosition: [-platformLength / 2, baseHeight + liftHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output-upper', name: '上层出口', type: 'material-output', localPosition: [platformLength / 2, baseHeight + liftHeight, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.capabilities = ['material-flow', 'capacity', 'vertical-transfer', 'plc-binding'];
		root.userData.properties = { ...props, platformLength, width, baseHeight, liftHeight };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
