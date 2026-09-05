import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

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
		const withSilkCart = props.withSilkCart === true;
		const silkCartLoaded = props.silkCartLoaded !== false;
		const root = new THREE.Group();
		root.name = definition.name;
		const baseMaterial = createMaterial(0x1e293b, { roughness: 0.6, metalness: 0.74 });
		const accentMaterial = createMaterial(0xf59e0b, { roughness: 0.4, metalness: 0.68, emissive: 0x78350f, emissiveIntensity: 0.12 });
		const cartMaterial = createMaterial(0x475569, { roughness: 0.55, metalness: 0.68 });
		const wheelMaterial = createMaterial(0x111827, { roughness: 0.72, metalness: 0.3 });
		const silkMaterial = createMaterial(0xf8fafc, { roughness: 0.78, metalness: 0.0 });
		const silkEdgeMaterial = createMaterial(0xcbd5e1, { roughness: 0.68, metalness: 0.02 });

		const base = new THREE.Mesh(new THREE.CylinderGeometry(baseRadius, baseRadius * 1.04, 0.28, 40), baseMaterial);
		base.name = 'TurntableBase';
		base.position.y = 0.14;
		root.add(base);
		const rotatingDeck = new THREE.Group();
		rotatingDeck.name = 'RotatingDeck';
		rotatingDeck.userData.rotationAxis = 'y';
		rotatingDeck.userData.homeAngle = 0;
		rotatingDeck.userData.carriesSilkCart = withSilkCart;
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

		if (withSilkCart) {
			const cart = new THREE.Group();
			cart.name = 'SilkCart';
			cart.position.y = height + 0.10;
			cart.userData.twinEntityType = 'silk-cart';
			cart.userData.doubleSided = true;
			cart.userData.rows = 3;
			cart.userData.columnsPerSide = 6;
			cart.userData.loaded = silkCartLoaded;
			const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.24, 2.0), cartMaterial);
			chassis.name = 'SilkCart-Chassis';
			chassis.position.y = 0.18;
			cart.add(chassis);
			for (const x of [-3, 3]) {
				const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.7, 0.14), cartMaterial);
				post.name = x < 0 ? 'SilkCart-Post-L' : 'SilkCart-Post-R';
				post.position.set(x, 2.0, 0);
				cart.add(post);
			}
			for (let row = 0; row < 3; row += 1) {
				const y = 0.9 + row * 1.15;
				const beam = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.1, 0.1), cartMaterial);
				beam.name = `SilkCart-Beam-R${row + 1}`;
				beam.position.set(0, y, 0);
				cart.add(beam);
				for (const side of ['A', 'B'] as const) {
					const z = side === 'A' ? 0.78 : -0.78;
					for (let column = 0; column < 6; column += 1) {
						const x = -2.75 + column * 1.1;
						const spindle = new THREE.Group();
						spindle.name = `SilkCart-${side}-R${row + 1}-C${column + 1}`;
						spindle.position.set(x, y, z);
						spindle.rotation.y = side === 'A' ? 0 : Math.PI;
						const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.54, 12), cartMaterial);
						pin.name = `SilkCart-Pin-${side}-R${row + 1}-C${column + 1}`;
						pin.rotation.x = Math.PI / 2;
						pin.position.z = side === 'A' ? 0.22 : -0.22;
						spindle.add(pin);
						if (silkCartLoaded) {
							const cake = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.42, 28), silkMaterial);
							cake.name = `SilkCake-${side}-R${row + 1}-C${column + 1}`;
							cake.rotation.x = Math.PI / 2;
							cake.position.z = side === 'A' ? 0.48 : -0.48;
							spindle.add(cake);
							const edge = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.025, 8, 28), silkEdgeMaterial);
							edge.name = `SilkCake-Edge-${side}-R${row + 1}-C${column + 1}`;
							edge.position.z = side === 'A' ? 0.70 : -0.70;
							spindle.add(edge);
						}
						cart.add(spindle);
					}
				}
			}
			for (const x of [-2.7, 2.7]) for (const z of [-0.72, 0.72]) {
				const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 18), wheelMaterial);
				wheel.name = 'SilkCart-Wheel';
				wheel.rotation.z = Math.PI / 2;
				wheel.position.set(x, 0.08, z);
				cart.add(wheel);
			}
			rotatingDeck.add(cart);
		}

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
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'deck', name: '旋转台动态内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet', dynamic: true,
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-deckLength / 2, height, 0], portId: 'input' },
				{ pointId: 'center', name: '旋转中心', localPosition: [0, height, 0], kind: 'junction' },
				{ pointId: 'output', name: '出口', localPosition: [deckLength / 2, height, 0], portId: 'output' },
				{ pointId: 'side-a', name: '侧向A', localPosition: [0, height, -deckLength / 2], portId: 'side-a' },
				{ pointId: 'side-b', name: '侧向B', localPosition: [0, height, deckLength / 2], portId: 'side-b' },
			],
			edges: [
				{ edgeId: 'input-center', fromPointId: 'input', toPointId: 'center' },
				{ edgeId: 'center-output', fromPointId: 'center', toPointId: 'output' },
				{ edgeId: 'side-a-center', fromPointId: 'side-a', toPointId: 'center', bidirectional: true },
				{ edgeId: 'center-side-b', fromPointId: 'center', toPointId: 'side-b', bidirectional: true },
			],
		}];
		root.traverse((node: any) => {
			if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; }
		});
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.withSilkCart = withSilkCart;
		root.userData.silkCartLoaded = silkCartLoaded;
		root.userData.capabilities = ['material-flow', 'capacity', 'rotation', 'plc-binding'];
		root.userData.properties = { ...props, deckLength, width, height, baseRadius, withSilkCart, silkCartLoaded };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
