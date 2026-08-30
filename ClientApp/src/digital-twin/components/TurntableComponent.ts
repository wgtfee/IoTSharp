import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class TurntableComponent implements TwinComponentGenerator {
	readonly componentType = 'turntable' as const;
	readonly generator = 'turntable-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const deckLength = resolveNumber(props, 'deckLength', 2.4, 0.8, 8);
		const width = resolveNumber(props, 'width', 1.8, 0.6, 6);
		const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
		const baseRadius = resolveNumber(props, 'baseRadius', Math.max(deckLength, width) * 0.62, 0.6, 8);
		const root = new THREE.Group();
		root.name = definition.name;
		const baseMaterial = createMaterial(0x1e293b, { roughness: 0.6, metalness: 0.74 });
		const accentMaterial = createMaterial(0xf59e0b, { roughness: 0.4, metalness: 0.68, emissive: 0x78350f, emissiveIntensity: 0.12 });
		const base = new THREE.Mesh(new THREE.CylinderGeometry(baseRadius, baseRadius * 1.04, 0.28, 40), baseMaterial);
		base.name = 'TurntableBase';
		base.position.y = 0.14;
		root.add(base);
		const rotatingDeck = new THREE.Group();
		rotatingDeck.name = 'RotatingDeck';
		rotatingDeck.userData.rotationAxis = 'y';
		rotatingDeck.userData.homeAngle = 0;
		rotatingDeck.add(createStraightRollerGeometry({
			length: deckLength,
			width,
			height,
			rollerDiameter: 0.14,
			rollerPitch: 0.48,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: Math.max(1.2, deckLength),
			frameColor: 0x475569,
			rollerColor: 0x94a3b8,
		}));
		root.add(rotatingDeck);
		const ring = new THREE.Mesh(new THREE.TorusGeometry(baseRadius * 0.86, 0.045, 8, 48), accentMaterial);
		ring.rotation.x = Math.PI / 2;
		ring.position.y = 0.33;
		ring.name = 'RotationIndicator';
		root.add(ring);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-deckLength / 2, height, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [deckLength / 2, height, 0], localDirection: [1, 0, 0] },
			{ portId: 'side-a', name: '侧向A', type: 'material-bidirectional', localPosition: [0, height, -deckLength / 2], localDirection: [0, 0, -1] },
			{ portId: 'side-b', name: '侧向B', type: 'material-bidirectional', localPosition: [0, height, deckLength / 2], localDirection: [0, 0, 1] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.capabilities = ['material-flow', 'capacity', 'rotation', 'plc-binding'];
		root.userData.properties = { ...props, deckLength, width, height, baseRadius };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
