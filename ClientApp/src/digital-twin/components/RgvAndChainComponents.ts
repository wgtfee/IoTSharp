import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

const resolveTransportUnitType = (value: unknown) => value === 'carton' ? 'carton' : value === 'wooden-pallet' ? 'wooden-pallet' : 'plastic-pallet';

export class ChainConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'chain-conveyor' as const;
	readonly generator = 'chain-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 4, 0.8, 60);
		const width = resolveNumber(props, 'width', 1.6, 0.6, 4);
		const height = resolveNumber(props, 'height', 0.9, 0.25, 2.5);
		const chainSpacing = resolveNumber(props, 'chainSpacing', Math.min(0.9, width * 0.55), 0.25, Math.max(0.3, width - 0.2));
		const transportUnitType = resolveTransportUnitType(props.transportUnitType);
		const root = new THREE.Group();
		root.name = definition.name;
		const frameMaterial = createMaterial(0x475569, { roughness: 0.55, metalness: 0.72 });
		const chainMaterial = createMaterial(0x1f2937, { roughness: 0.4, metalness: 0.86 });
		const sprocketMaterial = createMaterial(0x64748b, { roughness: 0.34, metalness: 0.9 });
		for (const z of [-width / 2, width / 2]) {
			const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.18, 0.12), frameMaterial);
			rail.position.set(0, height - 0.18, z * 0.92);
			root.add(rail);
		}
		for (const z of [-chainSpacing / 2, chainSpacing / 2]) {
			const chain = new THREE.Mesh(new THREE.BoxGeometry(length - 0.18, 0.08, 0.12), chainMaterial);
			chain.name = z < 0 ? 'Chain-Left' : 'Chain-Right';
			chain.position.set(0, height - 0.04, z);
			root.add(chain);
			for (const x of [-length / 2 + 0.14, length / 2 - 0.14]) {
				const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 18), sprocketMaterial);
				sprocket.name = `Chain-Sprocket-${x < 0 ? 'In' : 'Out'}-${z < 0 ? 'L' : 'R'}`;
				sprocket.position.set(x, height - 0.08, z);
				sprocket.rotation.x = Math.PI / 2;
				sprocket.userData.runtimeSpin = { axis: [0, 1, 0], speedDegPerSecond: 300 };
				root.add(sprocket);
			}
		}
		for (const x of [-length / 2 + 0.25, length / 2 - 0.25]) {
			for (const z of [-width / 2 + 0.14, width / 2 - 0.14]) {
				const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, Math.max(0.18, height - 0.18), 0.14), frameMaterial);
				leg.position.set(x, Math.max(0.18, height - 0.18) / 2, z);
				root.add(leg);
			}
		}
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, height, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, height, 0], localDirection: [1, 0, 0] },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'main', name: '链式输送路线', conveyorSizeClass: props.conveyorSizeClass === 'large' ? 'large' : 'small', transportUnitType,
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-length / 2, height, 0], kind: 'buffer', portId: 'input' },
				{ pointId: 'output', name: '出口', localPosition: [length / 2, height, 0], kind: 'buffer', portId: 'output' },
			],
			edges: [{ edgeId: 'through', fromPointId: 'input', toPointId: 'output', name: '链式输送', capacity: Number(props.capacity || 2), speedLimit: Number(props.speedLimit || 1) }],
		}];
		root.traverse((node: any) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.properties = { ...props, length, width, height, chainSpacing, transportUnitType };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}

export class RgvComponent implements TwinComponentGenerator {
	readonly componentType = 'rgv' as const;
	readonly generator = 'rgv-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const stationCount = Number(props.stationCount) >= 2 ? 2 : 1;
		const trackLength = resolveNumber(props, 'trackLength', 9, 3, 40);
		const deckLength = resolveNumber(props, 'deckLength', 2.4, 1, 5);
		const deckWidth = resolveNumber(props, 'deckWidth', 1.6, 0.7, 3.5);
		const height = resolveNumber(props, 'height', 0.72, 0.25, 1.8);
		const stationGap = resolveNumber(props, 'stationGap', 0.35, 0.1, 1.5);
		const transportUnitType = resolveTransportUnitType(props.transportUnitType);
		const root = new THREE.Group();
		root.name = definition.name;
		const railMaterial = createMaterial(0x334155, { roughness: 0.45, metalness: 0.86 });
		const carriageMaterial = createMaterial(0xf59e0b, { roughness: 0.42, metalness: 0.58 });
		const deckMaterial = createMaterial(0x475569, { roughness: 0.48, metalness: 0.72 });
		const chainMaterial = createMaterial(0x111827, { roughness: 0.38, metalness: 0.9 });
		for (const z of [-0.48, 0.48]) {
			const rail = new THREE.Mesh(new THREE.BoxGeometry(trackLength, 0.12, 0.12), railMaterial);
			rail.position.set(0, 0.06, z);
			root.add(rail);
		}
		const carriage = new THREE.Group();
		carriage.name = 'RGV-Carriage';
		carriage.position.y = 0.18;
		carriage.userData.actuator = { actuatorId: 'rgv-x', name: 'RGV 行走轴', kind: 'linear-axis', motionAxis: 'x', unit: 'meter', minValue: -(trackLength - deckLength) / 2, maxValue: (trackLength - deckLength) / 2, homeValue: 0, speed: Number(props.travelSpeed || 2) };
		carriage.userData.actuatorId = 'rgv-x';
		root.add(carriage);
		const totalDeckSpan = stationCount * deckLength + (stationCount - 1) * stationGap;
		const ports: TwinComponentPortDefinition[] = [];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [];
		for (let station = 0; station < stationCount; station += 1) {
			const deckX = -totalDeckSpan / 2 + deckLength / 2 + station * (deckLength + stationGap);
			const deck = new THREE.Group();
			deck.name = `RGV-Station-${station + 1}`;
			deck.position.x = deckX;
			const platform = new THREE.Mesh(new THREE.BoxGeometry(deckLength, 0.18, deckWidth), deckMaterial);
			platform.position.y = height - 0.27;
			deck.add(platform);
			for (const x of [-deckLength * 0.28, deckLength * 0.28]) {
				const chain = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, deckWidth - 0.16), chainMaterial);
				chain.position.set(x, height - 0.14, 0);
				deck.add(chain);
			}
			carriage.add(deck);
			const prefix = stationCount === 1 ? 'station' : `station-${station + 1}`;
			ports.push(
				{ portId: `${prefix}-front`, name: `工位${station + 1} 前端`, type: 'material-bidirectional', localPosition: [deckX, height, -deckWidth / 2], localDirection: [0, 0, -1] },
				{ portId: `${prefix}-back`, name: `工位${station + 1} 后端`, type: 'material-bidirectional', localPosition: [deckX, height, deckWidth / 2], localDirection: [0, 0, 1] },
			);
			internalFlows.push({
				flowId: `station-${station + 1}`, name: `RGV 工位${station + 1}载台输送`, conveyorSizeClass: props.conveyorSizeClass === 'large' ? 'large' : 'small', transportUnitType,
				points: [
					{ pointId: 'front', name: '前端', localPosition: [deckX, height, -deckWidth / 2], kind: 'buffer', portId: `${prefix}-front` },
					{ pointId: 'back', name: '后端', localPosition: [deckX, height, deckWidth / 2], kind: 'buffer', portId: `${prefix}-back` },
				],
				edges: [{ edgeId: 'transfer', fromPointId: 'front', toPointId: 'back', name: '载台输送', bidirectional: true, capacity: 1, speedLimit: Number(props.transferSpeed || 0.8) }],
			});
		}
		root.traverse((node: any) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.actuatorDefinitions = [{ ...carriage.userData.actuator, nodePath: carriage.name }];
		root.userData.properties = { ...props, stationCount, trackLength, deckLength, deckWidth, height, stationGap, transportUnitType };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
