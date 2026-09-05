import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import { PACKAGING_WOOD_PALLET_LENGTH, PACKAGING_WOOD_PALLET_WIDTH } from './PackagingLineDimensions';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

const addBox = (parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name;
	mesh.position.set(...position);
	parent.add(mesh);
	return mesh;
};

const addPortal = (root: THREE.Group, name: string, width: number, height: number, depth: number, material: THREE.Material) => {
	const halfDepth = depth / 2;
	addBox(root, `${name}-Post-L`, [0.18, height, 0.18], [0, height / 2, -halfDepth], material);
	addBox(root, `${name}-Post-R`, [0.18, height, 0.18], [0, height / 2, halfDepth], material);
	addBox(root, `${name}-Top`, [0.20, 0.20, depth + 0.18], [0, height, 0], material);
};

const finish = (root: THREE.Group, context: TwinComponentBuildContext, generator: string, componentType: string, properties: Record<string, unknown>, ports: TwinComponentPortDefinition[] = []) => {
	const { definition } = context;
	applyComponentIdentity(root, definition.objectId, componentType, definition.sectionId);
	root.userData.resourceKey = definition.resourceKey;
	root.userData.generator = generator;
	root.userData.generatorVersion = definition.generatorVersion;
	root.userData.properties = { ...properties };
	setTransform(root, definition.transform);
	return createComponentResult(root, ports);
};

export class SilkGantryComponent implements TwinComponentGenerator {
	readonly componentType = 'silk-gantry' as const;
	readonly generator = 'silk-gantry-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const props = context.definition.properties;
		const length = resolveNumber(props, 'length', 8.2, 4, 30);
		const width = resolveNumber(props, 'width', 27.0, 8, 36);
		const height = resolveNumber(props, 'height', 8.4, 3, 15);
		const railY = Math.max(1.0, height - 0.30);
		const root = new THREE.Group();
		root.name = context.definition.name;
		root.userData.sharedRailPairId = 'SilkGantry-Shared-Rail-Pair';
		root.userData.doubleRail = true;
		root.userData.doubleGripper = true;
		const tagActuator = (node: THREE.Object3D, actuator: Record<string, unknown>) => {
			node.userData.actuator = actuator;
			node.userData.actuatorId = actuator.actuatorId;
		};

		const frame = createMaterial(0x475569, { roughness: 0.58, metalness: 0.72 });
		const railMaterial = createMaterial(0xf97316, { emissive: 0x4a1f05, emissiveIntensity: 0.14, roughness: 0.38, metalness: 0.72 });
		const carriage = createMaterial(0x64748b, { roughness: 0.4, metalness: 0.66 });
		const tool = createMaterial(0x94a3b8, { roughness: 0.36, metalness: 0.82 });
		const cover = createMaterial(0xe2e8f0, { roughness: 0.82, metalness: 0.06 });
		const stackFootprintX = 4.2;
		const stackFootprintZ = 4.0;

		for (const x of [-length / 2, length / 2]) for (const z of [-width / 2, width / 2]) {
			const post = addBox(root, `Gantry-Support-Post-${x > 0 ? 'R' : 'L'}-${z > 0 ? 'F' : 'B'}`, [0.24, height, 0.24], [x, height / 2, z], frame);
			post.userData.gantrySupportPost = true;
		}
		for (const [index, x] of [-length / 2, length / 2].entries()) {
			const mainBeam = addBox(root, `SilkGantry-MainBeam-${index === 0 ? 'A' : 'B'}`, [0.30, 0.30, width], [x, height, 0], frame);
			mainBeam.userData.fixedMainBeam = true;
			mainBeam.userData.structuralRole = 'gantry-main-cross-beam';
		}
		// 两根深色 X 向长梁只是桁架主梁/轨道支撑梁，不是轨道。
		for (const [index, z] of [-(width / 2 - 0.38), width / 2 - 0.38].entries()) {
			const supportBeam = addBox(root, `SilkGantry-Rail-Support-MainBeam-${index === 0 ? 'A' : 'B'}`, [length, 0.24, 0.30], [0, railY, z], frame);
			supportBeam.userData.structuralRole = 'rail-support-main-beam';
			supportBeam.userData.isRail = false;
		}

		// 用户确认：真正轨道是 Z 轴方向的两根橙色长轨。
		const sharedRailX = Math.min(length * 0.22, Math.max(1.25, length / 2 - 1.1));
		const sharedRailXPositions = [-sharedRailX, sharedRailX];
		const sharedRailLength = Math.max(3.0, width - 0.60);
		for (const [index, x] of sharedRailXPositions.entries()) {
			const rail = addBox(root, `Gantry-Z-Travel-Rail-${index === 0 ? 'A' : 'B'}`, [0.18, 0.10, sharedRailLength], [x, railY + 0.17, 0], railMaterial);
			rail.userData.longitudinalRail = true;
			rail.userData.fixedSharedRail = true;
			rail.userData.sharedOrangeRail = true;
			rail.userData.visualRole = 'shared-orange-z-gantry-rail';
			rail.userData.travelAxis = 'z';
			rail.userData.sharedRailPairId = root.userData.sharedRailPairId;
		}

		const buildTool = (role: 'silk' | 'separator', z: number) => {
			const group = new THREE.Group();
			group.name = role === 'silk' ? 'Gantry-Silk-Rail-Carriage' : 'Gantry-Separator-Rail-Carriage';
			group.position.set(0, railY + 0.30, z);
			group.userData.toolRole = role === 'silk' ? 'silk-cake' : 'separator-board';
			group.userData.sharedRailPairId = root.userData.sharedRailPairId;
			group.userData.servoAxisId = role === 'silk' ? 'Gantry-Silk-Z-Travel' : 'Gantry-Separator-Z-Travel';
			group.userData.travelAxis = 'z';
			group.userData.railMounted = true;
			tagActuator(group, {
				actuatorId: role === 'silk' ? 'gantry-yarn-z' : 'gantry-separator-z',
				name: role === 'silk' ? '丝锭夹具水平轴' : '隔板夹具水平轴',
				kind: 'linear-axis', motionAxis: 'z', unit: 'meter',
				minValue: -(width / 2 - 0.8), maxValue: width / 2 - 0.8, homeValue: z, speed: 3,
			});

			// 桥式小车沿 X 跨越两根 Z 向橙色轨道。
			const bridgeName = role === 'silk' ? 'Gantry-Silk-Bridge' : 'Gantry-Separator-Bridge';
			const bridge = addBox(group, bridgeName, [sharedRailX * 2 + 0.70, 0.28, 0.34], [0, 0, 0], tool);
			bridge.userData.bridgeAcrossSharedRails = true;
			bridge.userData.sharedRailPairId = root.userData.sharedRailPairId;

			for (const [index, x] of sharedRailXPositions.entries()) {
				const shoe = addBox(group, `${role === 'silk' ? 'Gantry-Silk' : 'Gantry-Separator'}-Rail-Shoe-${index + 1}`, [0.52, 0.26, 0.72], [x, 0.05, 0], tool);
				shoe.userData.sharedRailPairId = root.userData.sharedRailPairId;
				shoe.userData.railMounted = true;
				shoe.userData.mountedRailIndex = index;
				shoe.userData.travelAxis = 'z';
			}

			const trolley = new THREE.Group();
			trolley.name = role === 'silk' ? 'Gantry-Silk-Trolley' : 'Gantry-Separator-Trolley';
			trolley.userData.zOffset = z;
			addBox(trolley, `${trolley.name}-Body`, [0.78, 0.34, 0.72], [0, 0, 0], tool);
			// Gripper lift axis terminates at the gripper install plane.
			const gripperLevelOffset = role === 'silk' ? -0.55 : 0.55;
			const gripperY = -height * 0.36 + gripperLevelOffset;
			const guideBottomY = gripperY + 0.12;
			const guideLength = Math.max(0.5, Math.abs(guideBottomY));
			const guide = addBox(trolley, role === 'silk' ? 'Gantry-Z-Guide' : 'Gantry-Separator-Z-Guide', [0.30, guideLength, 0.30], [0, guideBottomY / 2, 0], frame);
			guide.userData.verticalGuide = true;
			guide.userData.lowerEndY = guideBottomY;
			const lift = new THREE.Group();
			lift.name = role === 'silk' ? 'Gantry-Z-Slide' : 'Gantry-Separator-Z-Slide';
			tagActuator(lift, {
				actuatorId: role === 'silk' ? 'gantry-yarn-y' : 'gantry-separator-y',
				name: role === 'silk' ? '丝锭夹具升降轴' : '隔板夹具升降轴',
				kind: 'linear-axis', motionAxis: 'y', unit: 'meter', minValue: -8, maxValue: 3, homeValue: 0, speed: 2.2,
			});
			const slideBottomY = gripperY + 0.10;
			const slideLength = Math.max(0.45, Math.abs(slideBottomY));
			const slideBar = addBox(lift, `${lift.name}-Bar`, [0.26, slideLength, 0.26], [0, slideBottomY / 2, 0], tool);
			slideBar.userData.lowerEndY = slideBottomY;
			slideBar.userData.baseLength = slideLength;
			const gripper = new THREE.Group();
			gripper.name = role === 'silk' ? 'GantryGripper-2x3' : 'Gantry-Separator-Gripper';
			gripper.position.y = gripperY;
			gripper.userData.heightOffset = gripperLevelOffset;
			gripper.userData.installPlaneY = gripperY;
			tagActuator(gripper, {
				actuatorId: role === 'silk' ? 'gantry-yarn-gripper' : 'gantry-separator-gripper',
				name: role === 'silk' ? '丝锭夹具' : '隔板真空夹具', kind: 'gripper', unit: 'boolean', homeValue: 0, speed: 1,
			});
			if (role === 'silk') {
				addBox(gripper, 'Gantry-Silk-Gripper-2x3', [stackFootprintX, 0.18, stackFootprintZ], [0, 0, 0], tool);
				for (let row = 0; row < 2; row += 1) for (let column = 0; column < 3; column += 1) {
					const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.30, 16), tool);
					head.name = `Silk-Grip-${row + 1}-${column + 1}`;
					head.position.set(-1.8 + column * 1.8, -0.20, -1.7 + row * 3.4);
					gripper.add(head);
				}
			} else {
				// 隔板夹具采用实体真空背板作为主承力结构，避免仅靠细框架悬空吸取。
				const backplate = addBox(gripper, 'Gantry-Separator-Gripper-Backplate', [stackFootprintX, 0.18, stackFootprintZ], [0, 0, 0], tool);
				backplate.userData.structuralRole = 'separator-gripper-solid-backplate';
				backplate.userData.solidLoadPlate = true;
				const centerMount = addBox(gripper, 'Gantry-Separator-Gripper-Center-Mount', [0.78, 0.30, 0.78], [0, 0.24, 0], frame);
				centerMount.userData.structuralRole = 'separator-gripper-center-mount';
				for (const [index, z] of [-1.55, 1.55].entries()) {
					const rib = addBox(gripper, `Gantry-Separator-Gripper-Reinforcement-${index + 1}`, [stackFootprintX - 0.20, 0.12, 0.16], [0, 0.15, z], frame);
					rib.userData.separatorGripperReinforcement = true;
				}
				for (const [index, x] of [-1.85, 1.85].entries()) {
					const sideRib = addBox(gripper, `Gantry-Separator-Gripper-Side-Rib-${index + 1}`, [0.16, 0.12, stackFootprintZ - 0.24], [x, 0.15, 0], frame);
					sideRib.userData.separatorGripperReinforcement = true;
				}
				let cupIndex = 0;
				for (const px of [-1.7, 0, 1.7]) for (const pz of [-1.45, 1.45]) {
					cupIndex += 1;
					const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.18, 16), frame);
					mount.name = `Gantry-Separator-Cup-Mount-${cupIndex}`;
					mount.position.set(px, -0.17, pz);
					mount.userData.vacuumCupMount = true;
					gripper.add(mount);
					const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 0.14, 16), tool);
					cup.name = `Gantry-Separator-Vacuum-Cup-${cupIndex}`;
					cup.position.set(px, -0.32, pz);
					cup.userData.vacuumCup = true;
					gripper.add(cup);
				}
			}
			lift.add(gripper);
			trolley.add(lift);
			group.add(trolley);
			root.add(group);
		};

		const toolZOffset = Math.min(1.8, width * 0.18);
		buildTool('silk', toolZOffset);
		buildTool('separator', -toolZOffset);

		// Two separator stock platforms sit under the shared Z rails. The first one is moved 2m further toward Z-.
		const stockX = 0;
		const stockDeckDepth = PACKAGING_WOOD_PALLET_WIDTH + 0.60;
		const stockDeckWidthX = Math.min(PACKAGING_WOOD_PALLET_LENGTH + 0.60, length - 0.8);
		const firstStockZ = -5.6;
		const stockSpacingZ = stockDeckDepth + 0.30;

		const buildSeparatorStockPlatform = (name: string, z: number, stockIndex: number, separatorCategory: 'A' | 'B') => {
			const stock = new THREE.Group();
			stock.name = name;
			stock.position.set(stockX, 0, z);
			stock.userData.underSharedRails = true;
			stock.userData.sharedRailPairId = root.userData.sharedRailPairId;
			stock.userData.stockIndex = stockIndex;
			stock.userData.stockRole = 'separator-board';
			stock.userData.separatorCategory = separatorCategory;
			addBox(stock, `Gantry-Separator-Stock-Deck-${stockIndex.toString().padStart(2, '0')}`, [stockDeckWidthX, 0.24, stockDeckDepth], [0, 0.62, 0], frame);

			// 每个暂存台只存放一类隔板：单个居中料堆，不再左右各放一类。
			const feeder = new THREE.Group();
			feeder.name = `SeparatorFeeder-${separatorCategory}`;
			feeder.position.set(0, 0, 0);
			feeder.userData.separatorFeeder = true;
			feeder.userData.separatorCategory = separatorCategory;
			addBox(feeder, `FeederBase-${separatorCategory}`, [PACKAGING_WOOD_PALLET_LENGTH + 0.20, 0.72, PACKAGING_WOOD_PALLET_WIDTH + 0.20], [0, 0.36, 0], frame);
			for (let i = 0; i < 5; i += 1) {
				const sheet = addBox(feeder, `SeparatorSheet-${separatorCategory}-${i + 1}`, [PACKAGING_WOOD_PALLET_LENGTH, 0.025, PACKAGING_WOOD_PALLET_WIDTH], [0, 1.10 + i * 0.04, 0], cover);
				sheet.userData.separatorCategory = separatorCategory;
			}
			stock.add(feeder);
			root.add(stock);
			return stock;
		};

		buildSeparatorStockPlatform('Gantry-Separator-Stock-Platform', firstStockZ, 1, 'A');
		buildSeparatorStockPlatform('Gantry-Separator-Stock-Platform-02', firstStockZ - stockSpacingZ, 2, 'B');
		root.userData.actuatorDefinitions = [];
		root.traverse((node) => {
			if (node.userData?.actuator) root.userData.actuatorDefinitions.push({ ...node.userData.actuator, nodePath: node.name });
		});
		return finish(root, context, this.generator, this.componentType, { ...props, length, width, height });
	}
}

export class TopCoverGantryComponent implements TwinComponentGenerator {
	readonly componentType = 'top-cover-gantry' as const;
	readonly generator = 'top-cover-gantry-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const props = context.definition.properties;
		const length = resolveNumber(props, 'length', 7.05, 3, 20);
		const width = resolveNumber(props, 'width', 10.5, 5.7, 20);
		const height = resolveNumber(props, 'height', 6.0, 2.5, 12);
		const railY = Math.max(1.0, height - 0.30);
		const root = new THREE.Group();
		root.name = context.definition.name;
		root.userData.doubleRail = true;
		root.userData.sharedRailPairId = 'TopCover-Shared-Rail-Pair-01';
		root.userData.travelAxis = 'z';
		// 大辊道侧（Z+）保持原边界，新增跨度只向 Z- 延长，避免桁架/暂存台侵入大辊道。
		const zPositiveEnd = 2.85;
		const zNegativeEnd = zPositiveEnd - width;
		const zCenter = (zNegativeEnd + zPositiveEnd) / 2;
		root.userData.zPositiveFixedEnd = zPositiveEnd;
		root.userData.zNegativeExtendedEnd = zNegativeEnd;
		root.userData.zExtensionDirection = 'negative';

		const frame = createMaterial(0x475569, { roughness: 0.58, metalness: 0.72 });
		const railMaterial = createMaterial(0xf97316, { emissive: 0x4a1f05, emissiveIntensity: 0.14, roughness: 0.38, metalness: 0.72 });
		const carriage = createMaterial(0x64748b, { roughness: 0.40, metalness: 0.66 });
		const tool = createMaterial(0x94a3b8, { roughness: 0.36, metalness: 0.82 });
		const cover = createMaterial(0x9b6a3c, { roughness: 0.92, metalness: 0.0 });
		const coverSizeX = Math.min(PACKAGING_WOOD_PALLET_LENGTH, length - 1.0);
		const coverSizeZ = Math.min(PACKAGING_WOOD_PALLET_WIDTH, width - 1.0);

		// 与丝锭桁架统一：四立柱 + 深色固定主梁，橙色只表示真正的 Z 向轨道。
		for (const x of [-length / 2, length / 2]) for (const z of [zNegativeEnd, zPositiveEnd]) {
			const post = addBox(root, `TopCover-Support-Post-${x > 0 ? 'R' : 'L'}-${z > 0 ? 'F' : 'B'}`, [0.24, height, 0.24], [x, height / 2, z], frame);
			post.userData.gantrySupportPost = true;
		}
		for (const [index, x] of [-length / 2, length / 2].entries()) {
			const mainBeam = addBox(root, `TopCover-Gantry-MainBeam-${index === 0 ? 'A' : 'B'}`, [0.30, 0.30, width], [x, height, zCenter], frame);
			mainBeam.userData.fixedMainBeam = true;
			mainBeam.userData.structuralRole = 'gantry-main-cross-beam';
		}
		for (const [index, z] of [zNegativeEnd + 0.30, zPositiveEnd - 0.30].entries()) {
			const supportBeam = addBox(root, `TopCover-Rail-Support-MainBeam-${index === 0 ? 'A' : 'B'}`, [length, 0.24, 0.30], [0, railY, z], frame);
			supportBeam.userData.structuralRole = 'rail-support-main-beam';
			supportBeam.userData.isRail = false;
		}

		// 真正的双轨与丝锭桁架一致：两根橙色轨道沿 Z 方向布置。
		const sharedRailX = Math.min(length * 0.27, Math.max(1.35, length / 2 - 1.0));
		const sharedRailXPositions = [-sharedRailX, sharedRailX];
		const sharedRailLength = Math.max(2.0, width - 0.60);
		for (const [index, x] of sharedRailXPositions.entries()) {
			const rail = addBox(root, index === 0 ? 'TopCover-Gantry-Rail-L' : 'TopCover-Gantry-Rail-R', [0.18, 0.10, sharedRailLength], [x, railY + 0.17, zCenter], railMaterial);
			rail.userData.longitudinalRail = true;
			rail.userData.fixedSharedRail = true;
			rail.userData.sharedOrangeRail = true;
			rail.userData.visualRole = 'shared-orange-z-gantry-rail';
			rail.userData.travelAxis = 'z';
			rail.userData.sharedRailPairId = root.userData.sharedRailPairId;
		}

		// 单套天盖桥式小车跨在同一对 Z 向橙色轨道上。
		const bridge = new THREE.Group();
		bridge.name = 'TopCover-Gantry-Bridge';
		bridge.position.set(0, railY + 0.30, zPositiveEnd - 1.30);
		bridge.userData.railCarriage = true;
		bridge.userData.railMounted = true;
		bridge.userData.travelAxis = 'z';
		bridge.userData.sharedRailPairId = root.userData.sharedRailPairId;
		bridge.userData.servoAxisId = 'TopCover-Gantry-Z-Travel';
		const bridgeBeam = addBox(bridge, 'TopCover-Gantry-Bridge-Beam', [sharedRailX * 2 + 0.70, 0.28, 0.34], [0, 0, 0], carriage);
		bridgeBeam.userData.bridgeAcrossSharedRails = true;
		for (const [index, x] of sharedRailXPositions.entries()) {
			const shoe = addBox(bridge, `TopCover-Gantry-Rail-Shoe-${index + 1}`, [0.52, 0.26, 0.72], [x, 0.05, 0], tool);
			shoe.userData.railMounted = true;
			shoe.userData.mountedRailIndex = index;
			shoe.userData.travelAxis = 'z';
			shoe.userData.sharedRailPairId = root.userData.sharedRailPairId;
		}

		const trolley = new THREE.Group();
		trolley.name = 'TopCover-Gantry-Trolley';
		addBox(trolley, 'TopCover-Gantry-Trolley-Body', [0.82, 0.34, 0.78], [0, 0, 0], tool);
		const gripperY = -height * 0.40;
		const guideBottomY = gripperY + 0.12;
		const guideLength = Math.max(0.5, Math.abs(guideBottomY));
		const guide = addBox(trolley, 'TopCover-Gantry-Z-Guide', [0.30, guideLength, 0.30], [0, guideBottomY / 2, 0], frame);
		guide.userData.verticalGuide = true;
		guide.userData.lowerEndY = guideBottomY;
		const slide = new THREE.Group();
		slide.name = 'TopCover-Gantry-Z-Slide';
		const slideBottomY = gripperY + 0.10;
		const slideLength = Math.max(0.45, Math.abs(slideBottomY));
		const slideBar = addBox(slide, 'TopCover-Gantry-Z-Slide-Bar', [0.26, slideLength, 0.26], [0, slideBottomY / 2, 0], tool);
		slideBar.userData.lowerEndY = slideBottomY;
		slideBar.userData.baseLength = slideLength;

		// 实体真空夹具：背板、加强筋、安装座和吸盘形成完整受力路径。
		const gripper = new THREE.Group();
		gripper.name = 'TopCover-Gantry-Gripper';
		gripper.position.y = gripperY;
		gripper.userData.installPlaneY = gripperY;
		const backplate = addBox(gripper, 'TopCover-Vacuum-Backplate', [coverSizeX, 0.18, coverSizeZ], [0, 0, 0], tool);
		backplate.userData.solidLoadPlate = true;
		backplate.userData.structuralRole = 'top-cover-gripper-solid-backplate';
		addBox(gripper, 'TopCover-Gripper-Center-Mount', [0.78, 0.30, 0.78], [0, 0.24, 0], frame);
		for (const z of [-coverSizeZ * 0.34, coverSizeZ * 0.34]) addBox(gripper, 'TopCover-Gripper-Reinforcement', [coverSizeX - 0.20, 0.12, 0.14], [0, 0.15, z], frame);
		let cupIndex = 0;
		for (const px of [-coverSizeX * 0.36, 0, coverSizeX * 0.36]) for (const pz of [-coverSizeZ * 0.31, coverSizeZ * 0.31]) {
			cupIndex += 1;
			const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.18, 16), frame);
			mount.name = `TopCover-Cup-Mount-${cupIndex}`;
			mount.position.set(px, -0.17, pz);
			mount.userData.vacuumCupMount = true;
			gripper.add(mount);
			const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 0.14, 16), tool);
			cup.name = `TopCover-Vacuum-Cup-${cupIndex}`;
			cup.position.set(px, -0.32, pz);
			cup.userData.vacuumCup = true;
			gripper.add(cup);
		}
		const ready = addBox(gripper, 'TopCover-Ready', [coverSizeX, 0.10, coverSizeZ], [0, -0.43, 0], cover);
		ready.userData.preloadedCover = true;
		slide.add(gripper);
		trolley.add(slide);
		bridge.add(trolley);
		root.add(bridge);

		// 天盖暂存台放在两根 Z 向轨道的下方，桥式小车可直接沿 Z 方向取盖。
		const table = new THREE.Group();
		table.name = 'TopCover-Stock-Table';
		const stockZ = zNegativeEnd + coverSizeZ / 2 + 0.55;
		table.position.set(0, 0, stockZ);
		table.userData.underSharedRails = true;
		table.userData.sharedRailPairId = root.userData.sharedRailPairId;
		table.userData.zNegativeStock = true;
		const stockDeckX = Math.min(coverSizeX + 0.50, length - 0.60);
		const stockDeckZ = Math.min(coverSizeZ + 0.30, width * 0.44);
		addBox(table, 'TopCover-Stock-Base', [stockDeckX, 0.68, stockDeckZ], [0, 0.34, 0], frame);
		for (let i = 0; i < 8; i += 1) addBox(table, `TopCover-Stock-${i + 1}`, [coverSizeX, 0.06, coverSizeZ], [0, 0.72 + i * 0.075, 0], cover);
		root.add(table);
		return finish(root, context, this.generator, this.componentType, { ...props, length, width, height });
	}
}

export class WrapperMachineComponent implements TwinComponentGenerator {
	readonly componentType = 'wrapper-machine' as const;
	readonly generator = 'wrapper-machine-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const props = context.definition.properties;
		const height = resolveNumber(props, 'height', 6.2, 3.8, 12);
		const legacyRingRadius = resolveNumber(props, 'ringRadius', 3.0, 1.8, 5.5);
		const armRadius = resolveNumber(props, 'armRadius', legacyRingRadius, 1.8, 5.5);
		const requestedWidth = resolveNumber(props, 'width', 6.8, 4.2, 12);
		const width = Math.max(requestedWidth, armRadius * 2 + 0.8);
		const root = new THREE.Group();
		root.name = context.definition.name;
		root.userData.processType = 'wrapping';
		root.userData.wrapperType = 'rotary-arm';
		root.userData.loadStationary = true;
		root.userData.rotationAxis = 'y';

		const frame = createMaterial(0x475569, { roughness: 0.58, metalness: 0.72 });
		const armMaterial = createMaterial(0xf97316, { emissive: 0x4a1f05, emissiveIntensity: 0.10, roughness: 0.38, metalness: 0.68 });
		const moving = createMaterial(0x64748b, { roughness: 0.40, metalness: 0.66 });
		const rollerMaterial = createMaterial(0x94a3b8, { roughness: 0.30, metalness: 0.86 });
		const filmMaterial = createMaterial(0xdbeafe, { transparent: true, opacity: 0.30, roughness: 0.16, metalness: 0.0, side: THREE.DoubleSide });
		const filmRollMaterial = createMaterial(0xe5e7eb, { roughness: 0.72, metalness: 0.02 });
		const hmiMaterial = createMaterial(0x0f172a, { roughness: 0.42, metalness: 0.50 });

		// 在线悬臂缠膜机采用四立柱刚架：大辊道沿 X 方向从中间通过，Z-/Z+ 两侧各两根立柱。
		const postZ = width / 2;
		const frameLengthX = Math.max(PACKAGING_WOOD_PALLET_LENGTH + 1.20, armRadius * 1.80);
		const postX = frameLengthX / 2;
		root.userData.fourPostFrame = true;
		root.userData.conveyorPassAxis = 'x';
		for (const x of [-postX, postX]) for (const z of [-postZ, postZ]) {
			const side = z < 0 ? 'L' : 'R';
			const end = x < 0 ? 'A' : 'B';
			const post = addBox(root, `Wrapper-Frame-Post-${side}-${end}`, [0.34, height, 0.34], [x, height / 2, z], frame);
			post.userData.fixedFrame = true;
			post.userData.wrapperSupportPost = true;
			post.userData.conveyorSide = z < 0 ? 'negative-z' : 'positive-z';
			post.userData.frameEnd = x < 0 ? 'negative-x' : 'positive-x';

			const foot = addBox(root, `Wrapper-Frame-Foot-${side}-${end}`, [0.92, 0.18, 0.92], [x, 0.09, z], frame);
			foot.userData.floorAnchor = true;
		}

		// 顶部四边刚架：两根 X 向纵梁 + 两根 Z 向横梁，中央再增加回转中心承力梁。
		for (const [index, z] of [-postZ, postZ].entries()) {
			const beam = addBox(root, `Wrapper-Frame-Top-Longitudinal-${index === 0 ? 'L' : 'R'}`, [frameLengthX + 0.34, 0.38, 0.42], [0, height, z], frame);
			beam.userData.fixedFrame = true;
			beam.userData.topFrameLongitudinal = true;
		}
		for (const [index, x] of [-postX, postX].entries()) {
			const beam = addBox(root, `Wrapper-Frame-Top-Cross-${index === 0 ? 'A' : 'B'}`, [0.42, 0.38, width + 0.34], [x, height, 0], frame);
			beam.userData.fixedFrame = true;
			beam.userData.topFrameCross = true;
		}
		const hubBridge = addBox(root, 'Wrapper-Frame-Hub-Bridge', [0.46, 0.42, width + 0.18], [0, height - 0.02, 0], frame);
		hubBridge.userData.fixedFrame = true;
		hubBridge.userData.hubSupportBeam = true;

		// 顶部回转驱动：悬臂绕 Y 轴转动，末端竖直膜架围绕静止托盘公转。
		const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.42, 32), moving);
		hub.name = 'Wrapper-Rotary-Hub';
		hub.position.set(0, height - 0.31, 0);
		hub.userData.rotationAxis = 'y';
		root.add(hub);

		const rotaryArm = new THREE.Group();
		rotaryArm.name = 'Wrapper-Rotary-Arm';
		rotaryArm.position.set(0, height - 0.55, 0);
		rotaryArm.userData.rotationAxis = 'y';
		rotaryArm.userData.rotaryArm = true;
		rotaryArm.userData.rotationCenter = [0, height - 0.55, 0];
		const cantilever = addBox(rotaryArm, 'Wrapper-Cantilever-Beam', [armRadius, 0.28, 0.36], [armRadius / 2, 0, 0], armMaterial);
		cantilever.userData.cantileverArm = true;
		const counterWeight = addBox(rotaryArm, 'Wrapper-Arm-Counterweight', [0.85, 0.42, 0.52], [-0.48, 0, 0], moving);
		counterWeight.userData.counterweight = true;

		// 悬臂末端下挂的膜架立杆。它随悬臂绕货物旋转，膜车只沿 Y 轴上下运动。
		const filmMast = new THREE.Group();
		filmMast.name = 'Wrapper-Film-Mast';
		filmMast.position.set(armRadius, 0, 0);
		filmMast.userData.orbitsLoad = true;
		filmMast.userData.travelCarrierAxis = 'y';
		const mastLength = Math.max(2.8, height - 1.25);
		addBox(filmMast, 'Wrapper-Film-Mast-Rail', [0.28, mastLength, 0.30], [0, -mastLength / 2, 0], armMaterial);
		addBox(filmMast, 'Wrapper-Film-Mast-Brace', [0.72, 0.18, 0.36], [-0.20, -0.20, 0], frame);

		const carriage = new THREE.Group();
		carriage.name = 'Wrapper-Film-Carriage';
		carriage.position.set(0, -mastLength * 0.56, 0);
		carriage.userData.travelAxis = 'y';
		carriage.userData.minLocalY = -mastLength + 0.65;
		carriage.userData.maxLocalY = -0.55;
		carriage.userData.preStretch = true;
		addBox(carriage, 'Wrapper-Film-Carriage-Body', [0.62, 0.82, 0.78], [0, 0, 0], moving);

		const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.62, 24), filmRollMaterial);
		roll.name = 'Wrapper-Film-Roll';
		roll.position.set(0.18, 0, 0.29);
		roll.userData.filmRoll = true;
		carriage.add(roll);

		for (const [index, x] of [-0.13, 0.13].entries()) {
			const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.58, 18), rollerMaterial);
			roller.name = `Wrapper-PreStretch-Roller-${index + 1}`;
			roller.position.set(x - 0.20, 0, -0.22);
			roller.userData.preStretchRoller = true;
			carriage.add(roller);
		}
		const dancer = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.48, 16), rollerMaterial);
		dancer.name = 'Wrapper-Film-Tension-Dancer';
		dancer.position.set(-0.30, -0.05, -0.36);
		dancer.rotation.z = Math.PI / 10;
		carriage.add(dancer);

		const filmWeb = addBox(carriage, 'Wrapper-Film-Web', [0.018, 0.56, 0.62], [-0.38, 0, -0.06], filmMaterial);
		filmWeb.userData.stretchFilm = true;
		filmMast.add(carriage);
		rotaryArm.add(filmMast);
		root.add(rotaryArm);

		// 自动线常见的夹膜/断膜单元放在货物侧边，结束后夹持并切断薄膜。
		const cutClamp = new THREE.Group();
		cutClamp.name = 'Wrapper-Film-Cut-Clamp';
		cutClamp.position.set(0.78, 0.78, -(PACKAGING_WOOD_PALLET_WIDTH / 2 + 0.45));
		addBox(cutClamp, 'Wrapper-Film-Cut-Clamp-Base', [0.72, 0.22, 0.46], [0, 0, 0], frame);
		addBox(cutClamp, 'Wrapper-Film-Cut-Clamp-Jaw', [0.38, 0.34, 0.16], [0, 0.23, 0], moving);
		cutClamp.userData.autoCutClamp = true;
		root.add(cutClamp);

		const hmi = addBox(root, 'Wrapper-HMI-Box', [0.34, 0.62, 0.52], [postX, 1.55, postZ], hmiMaterial);
		hmi.userData.operatorPanel = true;

		return finish(root, context, this.generator, this.componentType, { ...props, height, width, armRadius });
	}
}

export class LabelingMachineComponent implements TwinComponentGenerator {
	readonly componentType = 'labeling-machine' as const;
	readonly generator = 'labeling-machine-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const props = context.definition.properties;
		const height = resolveNumber(props, 'height', 2.40, 1.40, 4.50);
		// 兼容旧组件草稿：原 headOffset 迁移为机身距输送线中心的侧向安装距离。
		const legacyHeadOffset = resolveNumber(props, 'headOffset', 1.85, 1.20, 3.50);
		const sideOffset = resolveNumber(props, 'sideOffset', legacyHeadOffset, 1.20, 3.50);
		const armReach = resolveNumber(props, 'armReach', 0.60, 0.35, 1.20);
		const root = new THREE.Group();
		root.name = context.definition.name;
		root.userData.processType = 'labeling';
		root.userData.labelerType = 'pallet-print-apply';
		root.userData.designReference = 'Domino-Mx350i-eP-inspired';
		root.userData.loadStationary = true;
		root.userData.maxProductDistanceMeters = armReach;
		root.userData.supportedLabelSides = ['front', 'side', 'rear'];
		root.userData.articulatedArmJoints = 3;

		const frame = createMaterial(0x475569, { roughness: 0.58, metalness: 0.70 });
		const bodyMaterial = createMaterial(0xe5e7eb, { roughness: 0.52, metalness: 0.32 });
		const dark = createMaterial(0x111827, { roughness: 0.40, metalness: 0.58 });
		const jointMaterial = createMaterial(0x64748b, { roughness: 0.35, metalness: 0.76 });
		const accent = createMaterial(0x2563eb, { emissive: 0x0b1f4d, emissiveIntensity: 0.10, roughness: 0.42, metalness: 0.38 });
		const labelMaterial = createMaterial(0xffffff, { roughness: 0.94, metalness: 0.0 });
		const screenMaterial = createMaterial(0x0f172a, { emissive: 0x1d4ed8, emissiveIntensity: 0.18, roughness: 0.18, metalness: 0.12 });

		// 可选落地支架：机身放在大辊道一侧，正面朝外，机械臂向托盘方向伸出。
		const stand = new THREE.Group();
		stand.name = 'Labeler-Floor-Stand';
		stand.position.set(0, 0, sideOffset);
		stand.userData.floorMounted = true;
		addBox(stand, 'Labeler-Stand-Base', [0.92, 0.16, 0.86], [0, 0.08, 0], frame);
		addBox(stand, 'Labeler-Stand-Column', [0.22, Math.max(0.70, height - 1.05), 0.22], [0, Math.max(0.70, height - 1.05) / 2 + 0.12, 0.10], frame);
		root.add(stand);

		// Mx350i-eP 风格打印机本体：紧凑热转印/热敏打印模块，包含标签卷和操作面板。
		const printer = new THREE.Group();
		printer.name = 'Labeler-Printer-Module';
		printer.position.set(0, height - 0.55, sideOffset + 0.02);
		printer.userData.printTechnology = 'thermal-transfer-direct-thermal';
		printer.userData.printResolutionDpi = 300;
		printer.userData.printWidthMm = 162;
		addBox(printer, 'Labeler-Printer-Body', [0.74, 0.68, 0.62], [0, 0, 0], bodyMaterial);
		addBox(printer, 'Labeler-Printer-Front-Panel', [0.60, 0.48, 0.06], [0, 0.02, 0.34], dark);
		addBox(printer, 'Labeler-HMI-Screen', [0.34, 0.20, 0.025], [0.12, 0.08, 0.385], screenMaterial);
		const supplyRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.10, 28), labelMaterial);
		supplyRoll.name = 'Labeler-Label-Supply-Roll';
		supplyRoll.rotation.z = Math.PI / 2;
		supplyRoll.position.set(-0.23, -0.10, 0.39);
		supplyRoll.userData.labelSupplyRoll = true;
		printer.add(supplyRoll);
		const takeupRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.10, 24), dark);
		takeupRoll.name = 'Labeler-Liner-Takeup-Roll';
		takeupRoll.rotation.z = Math.PI / 2;
		takeupRoll.position.set(-0.23, 0.18, 0.39);
		printer.add(takeupRoll);
		root.add(printer);

		// 三关节电动贴标臂：三个独立转动关节形成连续受力链，末端带 Tamp 贴标板。
		const armBase = new THREE.Group();
		armBase.name = 'Labeler-Arm-Joint-1';
		armBase.position.set(0, height - 0.46, sideOffset - 0.34);
		armBase.userData.electricJoint = true;
		armBase.userData.jointIndex = 1;
		armBase.userData.collisionDetection = true;
		armBase.userData.rotationAxis = 'y';
		const joint1 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.24, 24), jointMaterial);
		joint1.name = 'Labeler-Arm-Joint-1-Hub';
		joint1.position.y = 0;
		armBase.add(joint1);

		const link1Length = armReach * 0.38;
		const link1 = addBox(armBase, 'Labeler-Arm-Link-1', [0.18, 0.18, link1Length], [0, 0, -link1Length / 2], accent);
		link1.userData.articulatedArmLink = true;

		const joint2 = new THREE.Group();
		joint2.name = 'Labeler-Arm-Joint-2';
		joint2.position.set(0, 0, -link1Length);
		joint2.userData.electricJoint = true;
		joint2.userData.jointIndex = 2;
		joint2.userData.collisionDetection = true;
		joint2.userData.rotationAxis = 'y';
		const joint2Hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 24), jointMaterial);
		joint2Hub.name = 'Labeler-Arm-Joint-2-Hub';
		joint2.add(joint2Hub);
		const link2Length = armReach * 0.37;
		const link2 = addBox(joint2, 'Labeler-Arm-Link-2', [0.16, 0.16, link2Length], [0, 0, -link2Length / 2], accent);
		link2.userData.articulatedArmLink = true;
		armBase.add(joint2);

		const joint3 = new THREE.Group();
		joint3.name = 'Labeler-Arm-Joint-3';
		joint3.position.set(0, 0, -link2Length);
		joint3.userData.electricJoint = true;
		joint3.userData.jointIndex = 3;
		joint3.userData.collisionDetection = true;
		joint3.userData.rotationAxis = 'y';
		const joint3Hub = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.20, 24), jointMaterial);
		joint3Hub.name = 'Labeler-Arm-Joint-3-Hub';
		joint3.add(joint3Hub);
		const wristLength = armReach * 0.25;
		addBox(joint3, 'Labeler-Arm-Wrist-Link', [0.14, 0.14, wristLength], [0, 0, -wristLength / 2], accent);
		joint2.add(joint3);

		const pad = new THREE.Group();
		pad.name = 'Labeler-Tamp-Pad';
		pad.position.set(0, 0, -wristLength);
		pad.userData.applyMethod = 'electric-tamp';
		pad.userData.labelSides = ['front', 'side', 'rear'];
		pad.userData.maxApplyPatterns = 8;
		addBox(pad, 'Labeler-Tamp-Pad-Body', [0.52, 0.42, 0.08], [0, 0, 0], dark);
		const label = addBox(pad, 'Labeler-Ready-Label', [0.38, 0.28, 0.012], [0, 0, -0.048], labelMaterial);
		label.userData.readyLabel = true;
		const camera = addBox(pad, 'Labeler-Code-Verification-Camera', [0.10, 0.08, 0.06], [0.18, 0.15, -0.075], dark);
		camera.userData.codeVerification = '1d-2d';
		pad.userData.integratedCamera = true;
		joint3.add(pad);
		root.add(armBase);

		// 明确保留贴标中心与输送线的关系，后续运行时可直接驱动三个关节去侧面/前后面贴标。
		root.userData.labelCenterHeight = height - 0.46;
		root.userData.sideOffset = sideOffset;
		return finish(root, context, this.generator, this.componentType, { ...props, height, sideOffset, armReach });
	}
}
