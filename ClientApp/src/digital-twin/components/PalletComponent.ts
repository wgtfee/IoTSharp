import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator } from './types';

export class PalletComponent implements TwinComponentGenerator {
	readonly componentType = 'pallet' as const;
	readonly generator = 'pallet-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const palletType = props.palletType === 'wooden-pallet' ? 'wooden-pallet' : 'plastic-pallet';
		const length = resolveNumber(props, 'length', 1.2, 0.4, 4);
		const width = resolveNumber(props, 'width', 1.0, 0.4, 4);
		const height = resolveNumber(props, 'height', 0.16, 0.06, 0.8);
		const deckThickness = Math.max(0.035, height * 0.34);
		const runnerHeight = Math.max(0.03, height - deckThickness);
		const root = new THREE.Group();
		root.name = definition.name;

		const mainColor = palletType === 'wooden-pallet' ? 0xb7793f : 0x2563eb;
		const accentColor = palletType === 'wooden-pallet' ? 0x7c4a24 : 0x1e40af;
		const deckMaterial = createMaterial(mainColor, { roughness: palletType === 'wooden-pallet' ? 0.82 : 0.55, metalness: 0.04 });
		const runnerMaterial = createMaterial(accentColor, { roughness: palletType === 'wooden-pallet' ? 0.86 : 0.62, metalness: 0.03 });

		const slatCount = palletType === 'wooden-pallet' ? 7 : 5;
		const slatWidth = Math.min(width / slatCount * 0.72, 0.18);
		for (let index = 0; index < slatCount; index += 1) {
			const t = slatCount <= 1 ? 0.5 : index / (slatCount - 1);
			const slat = new THREE.Mesh(new THREE.BoxGeometry(length, deckThickness, slatWidth), deckMaterial);
			slat.name = `Deck_${index + 1}`;
			slat.position.set(0, runnerHeight + deckThickness / 2, -width / 2 + slatWidth / 2 + t * Math.max(0, width - slatWidth));
			root.add(slat);
		}

		const runnerWidth = Math.max(0.09, Math.min(0.16, width * 0.12));
		for (const [index, z] of [-width * 0.34, 0, width * 0.34].entries()) {
			const runner = new THREE.Mesh(new THREE.BoxGeometry(length * 0.92, runnerHeight, runnerWidth), runnerMaterial);
			runner.name = `Runner_${index + 1}`;
			runner.position.set(0, runnerHeight / 2, z);
			root.add(runner);
		}

		if (palletType === 'plastic-pallet') {
			for (const x of [-length * 0.3, 0, length * 0.3]) {
				const brace = new THREE.Mesh(new THREE.BoxGeometry(runnerWidth, deckThickness * 0.72, width * 0.82), runnerMaterial);
				brace.name = 'PlasticBrace';
				brace.position.set(x, runnerHeight + deckThickness * 0.36, 0);
				root.add(brace);
			}
		}

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transportUnitType = palletType;
		root.userData.properties = { ...props, palletType, length, width, height, routeManagedExternally: true };
		setTransform(root, definition.transform);
		return createComponentResult(root, []);
	}
}

/** 环形包装线专用绿色小托盘。物流类型仍为 plastic-pallet，但与蓝色塑料母托盘使用独立资源。 */
export class SmallPalletComponent implements TwinComponentGenerator {
	readonly componentType = 'pallet' as const;
	readonly generator = 'small-pallet-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const diameter = resolveNumber(props, 'diameter', 1.48, 0.8, 2.4);
		const baseHeight = resolveNumber(props, 'baseHeight', 0.12, 0.06, 0.3);
		const columnHeight = resolveNumber(props, 'columnHeight', 0.92, 0.3, 1.5);
		const columnDiameter = resolveNumber(props, 'columnDiameter', 0.48, 0.18, 0.8);
		const radius = diameter / 2;
		const root = new THREE.Group();
		root.name = definition.name;

		const green = createMaterial(0x087f5b, { roughness: 0.55, metalness: 0.08 });
		const darkGreen = createMaterial(0x065f46, { roughness: 0.62, metalness: 0.08 });
		const base = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.95, radius, baseHeight, 32), green);
		base.name = 'SmallPallet-Base';
		base.position.y = baseHeight / 2;
		root.add(base);

		const ringY = baseHeight + 0.015;
		for (const [name, ringRadius] of [['SmallPallet-InnerRing', radius * 0.58], ['SmallPallet-OuterRing', radius * 0.84]] as const) {
			const ring = new THREE.Mesh(new THREE.TorusGeometry(ringRadius, Math.max(0.035, diameter * 0.037), 10, 32), darkGreen);
			ring.name = name;
			ring.rotation.x = Math.PI / 2;
			ring.position.y = ringY;
			root.add(ring);
		}
		for (let index = 0; index < 12; index += 1) {
			const holder = new THREE.Group();
			holder.name = `SmallPallet-Rib-${index + 1}`;
			holder.rotation.y = index * Math.PI / 6;
			const rib = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.76, Math.max(0.035, baseHeight * 0.42), Math.max(0.045, diameter * 0.037)), darkGreen);
			rib.position.set(radius * 0.40, ringY + 0.01, 0);
			holder.add(rib);
			root.add(holder);
		}

		const column = new THREE.Mesh(new THREE.CylinderGeometry(columnDiameter * 0.48, columnDiameter * 0.52, columnHeight, 28), green);
		column.name = 'SmallPallet-CenterColumn';
		column.position.y = baseHeight + columnHeight / 2;
		root.add(column);
		const core = new THREE.Mesh(new THREE.CylinderGeometry(columnDiameter * 0.29, columnDiameter * 0.29, columnHeight * 0.5, 24), darkGreen);
		core.name = 'SmallPallet-Core';
		core.position.y = baseHeight + columnHeight * 0.75;
		root.add(core);

		const cakeAnchor = new THREE.Group();
		cakeAnchor.name = 'SilkCakeAnchor';
		cakeAnchor.position.y = baseHeight + 0.21;
		root.add(cakeAnchor);

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transportUnitType = 'plastic-pallet';
		root.userData.transportUnitVariant = 'small-pallet';
		root.userData.resourceKey = definition.resourceKey;
		root.userData.properties = { ...props, diameter, baseHeight, columnHeight, columnDiameter, routeManagedExternally: true };
		setTransform(root, definition.transform);
		return createComponentResult(root, []);
	}
}
