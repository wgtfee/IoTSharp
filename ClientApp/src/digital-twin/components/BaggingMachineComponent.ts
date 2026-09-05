import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveBoolean, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

const addBox = (parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name; mesh.position.set(...position); parent.add(mesh); return mesh;
};
const addCylinder = (parent: THREE.Object3D, name: string, radius: number, length: number, position: [number, number, number], material: THREE.Material, axis: 'x'|'y'|'z'='y') => {
	const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 24), material);
	mesh.name = name; mesh.position.set(...position);
	if (axis === 'x') mesh.rotation.z = Math.PI / 2;
	if (axis === 'z') mesh.rotation.x = Math.PI / 2;
	parent.add(mesh); return mesh;
};

/** 化纤丝饼连续膜侧封包装机：连续膜供料 -> 导膜包覆 -> 纵向侧封 -> 切膜。 */
export class BaggingMachineComponent implements TwinComponentGenerator {
	readonly componentType = 'bagging-machine' as const;
	readonly generator = 'bagging-machine-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 5.2, 3.8, 12);
		const width = resolveNumber(props, 'width', 2.8, 2.1, 8);
		const machineHeight = resolveNumber(props, 'machineHeight', 3.2, 2.4, 8);
		const conveyorHeight = resolveNumber(props, 'conveyorHeight', 0.9, 0.2, 3);
		const conveyorWidth = resolveNumber(props, 'conveyorWidth', 1.6, 0.8, Math.max(0.9, width - 0.5));
		// 兼容旧草稿：旧 bagMouthWidth/Depth 在 V1 仍可作为连续膜包覆尺寸回退值。
		const legacyWidth = resolveNumber(props, 'bagMouthWidth', 1.5, 0.8, 3.0);
		const legacyDepth = resolveNumber(props, 'bagMouthDepth', 1.45, 0.8, 3.0);
		const filmWrapWidth = resolveNumber(props, 'filmWrapWidth', legacyWidth, 0.9, 2.8);
		const filmWrapDepth = resolveNumber(props, 'filmWrapDepth', legacyDepth, 0.9, 2.8);
		const filmRollDiameter = resolveNumber(props, 'filmRollDiameter', 0.55, 0.25, 1.2);
		const showBagFilm = resolveBoolean(props, 'showBagFilm', true);

		const root = new THREE.Group();
		root.name = definition.name;
		root.userData.processType = 'bagging';
		root.userData.baggingType = 'chemical-fiber-side-seal-film';
		root.userData.loadStationary = true;
		root.userData.filmFeed = 'continuous-roll';
		root.userData.sideSeal = true;
		root.userData.nextProcess = 'vacuum-film-tuck';
		root.userData.processSequence = ['positioning', 'film-feed', 'wrap', 'side-seal', 'cut', 'release'];

		const frame = createMaterial(0x475569, { roughness: 0.56, metalness: 0.72 });
		const moving = createMaterial(0x64748b, { roughness: 0.40, metalness: 0.72 });
		const accent = createMaterial(0x2563eb, { emissive: 0x0b1f4d, emissiveIntensity: 0.10, roughness: 0.42, metalness: 0.38 });
		const dark = createMaterial(0x111827, { roughness: 0.52, metalness: 0.42 });
		const filmMaterial = createMaterial(0xe0f2fe, { transparent: true, opacity: 0.24, roughness: 0.08, metalness: 0, side: THREE.DoubleSide });
		const filmRollMaterial = createMaterial(0xf1f5f9, { roughness: 0.32, metalness: 0.05 });
		const screenMaterial = createMaterial(0x0f172a, { emissive: 0x0ea5e9, emissiveIntensity: 0.22, roughness: 0.18, metalness: 0.12 });

		const conveyor = createStraightRollerGeometry({ length, width: conveyorWidth, height: conveyorHeight, rollerDiameter: 0.14, rollerPitch: 0.38, frameHeight: 0.16, frameThickness: 0.1, supportSpacing: 1.8, frameColor: 0x334155, rollerColor: 0x94a3b8 });
		conveyor.name = 'BaggingConveyor'; conveyor.userData.throughConveyor = true; conveyor.userData.smallPalletConveyor = true; root.add(conveyor);

		const frameHalfX = Math.min(length * 0.35, 1.85);
		const frameHalfZ = Math.max(conveyorWidth / 2 + 0.42, width / 2 - 0.22);
		for (const x of [-frameHalfX, frameHalfX]) for (const z of [-frameHalfZ, frameHalfZ]) {
			const post = addBox(root, 'Bagging-Frame-Post-' + (x < 0 ? 'IN' : 'OUT') + '-' + (z < 0 ? 'ZN' : 'ZP'), [0.14, machineHeight, 0.14], [x, machineHeight / 2, z], frame);
			post.userData.baggingSupportPost = true;
		}
		for (const z of [-frameHalfZ, frameHalfZ]) addBox(root, 'Bagging-Frame-Top-Longitudinal-' + (z < 0 ? 'ZN' : 'ZP'), [frameHalfX * 2 + 0.14, 0.18, 0.18], [0, machineHeight, z], frame);
		for (const x of [-frameHalfX, frameHalfX]) addBox(root, 'Bagging-Frame-Top-Cross-' + (x < 0 ? 'IN' : 'OUT'), [0.18, 0.18, frameHalfZ * 2 + 0.14], [x, machineHeight, 0], frame);

		const filmSupply = new THREE.Group(); filmSupply.name = 'Bagging-Film-Supply'; filmSupply.position.set(-frameHalfX + 0.35, 1.15, frameHalfZ + 0.34); filmSupply.userData.continuousFilmSupply = true;
		for (const [index, x] of [-0.34, 0.34].entries()) {
			const roll = addCylinder(filmSupply, 'Bagging-Film-Supply-Roll-' + (index + 1), filmRollDiameter / 2, Math.min(1.25, filmWrapWidth * 0.78), [x, 0, 0], filmRollMaterial, 'x');
			roll.userData.filmSupplyRoll = true; roll.userData.rotationAxis = 'x';
		}
		root.add(filmSupply);

		const feed = new THREE.Group(); feed.name = 'Bagging-Film-Feed-Assembly'; feed.position.set(-0.55, conveyorHeight + 1.05, frameHalfZ - 0.12); feed.userData.filmFeedAssembly = true;
		for (const [index, x] of [-0.18, 0.18].entries()) {
			const roller = addCylinder(feed, 'Bagging-Film-Guide-Roller-' + (index + 1), 0.075, Math.min(1.2, filmWrapWidth * 0.75), [x, 0, 0], moving, 'y');
			roller.userData.filmGuideRoller = true; roller.userData.rotationAxis = 'y';
		}
		root.add(feed);

		const wrap = new THREE.Group(); wrap.name = 'Bagging-Wrap-Guide'; wrap.position.set(0, conveyorHeight + 0.72, 0); wrap.userData.wrapGuide = true;
		const guideRadius = Math.max(filmWrapWidth, filmWrapDepth) * 0.55;
		const ring = new THREE.Mesh(new THREE.TorusGeometry(guideRadius, 0.055, 10, 40), accent); ring.name = 'Bagging-Wrap-Guide-Ring'; ring.rotation.x = Math.PI / 2; wrap.add(ring);
		root.add(wrap);

		if (showBagFilm) {
			const film = new THREE.Mesh(new THREE.CylinderGeometry(filmWrapWidth / 2, filmWrapWidth / 2, Math.max(0.85, filmWrapDepth), 32, 1, true), filmMaterial);
			film.name = 'Bagging-Film-Sleeve-Preview'; film.position.set(0, conveyorHeight + Math.max(0.85, filmWrapDepth) / 2, 0); film.userData.sideSealFilmPreview = true; root.add(film);
		}

		const seal = new THREE.Group(); seal.name = 'Bagging-Side-Seal-Unit'; seal.position.set(0.55, conveyorHeight + 0.88, filmWrapWidth / 2 + 0.18); seal.userData.sideSealUnit = true; seal.userData.sealDirection = 'longitudinal';
		for (const [index, z] of [-0.10, 0.10].entries()) {
			const jaw = addBox(seal, 'Bagging-Side-Seal-Jaw-' + (index + 1), [0.72, 0.11, 0.08], [0, 0, z], accent); jaw.userData.sideSealJaw = true;
		}
		root.add(seal);

		const cutter = new THREE.Group(); cutter.name = 'Bagging-Cut-Knife'; cutter.position.set(1.18, conveyorHeight + 0.95, filmWrapWidth / 2 + 0.16); cutter.userData.filmCutKnife = true; cutter.userData.travelAxis = 'z';
		addBox(cutter, 'Bagging-Cut-Knife-Blade', [0.58, 0.05, 0.05], [0, 0, 0], dark); root.add(cutter);

		const stopper = new THREE.Group(); stopper.name = 'Bagging-Positioning-Stopper'; stopper.position.set(0.72, conveyorHeight + 0.11, 0); stopper.userData.retractableStopper = true;
		addBox(stopper, 'Bagging-Stopper-Beam', [0.14, 0.26, conveyorWidth * 0.72], [0, 0, 0], accent); root.add(stopper);

		const centering = new THREE.Group(); centering.name = 'Bagging-Centering-Pusher'; centering.position.set(0, conveyorHeight + 0.34, 0); centering.userData.centeringPusher = true;
		for (const z of [-conveyorWidth / 2 - 0.13, conveyorWidth / 2 + 0.13]) {
			const pad = addBox(centering, 'Bagging-Centering-Pad-' + (z < 0 ? 'ZN' : 'ZP'), [0.52, 0.34, 0.10], [0, 0, z], moving); pad.userData.centeringPad = true;
		}
		root.add(centering);

		const cabinet = addBox(root, 'Bagging-Control-Cabinet', [0.74, 1.45, 0.46], [frameHalfX - 0.42, 0.725, frameHalfZ + 0.32], frame); cabinet.userData.controlCabinet = true;
		const hmi = new THREE.Group(); hmi.name = 'Bagging-HMI'; hmi.position.set(frameHalfX - 0.40, 1.62, frameHalfZ + 0.34); hmi.userData.operatorPanel = true;
		addBox(hmi, 'Bagging-HMI-Body', [0.46, 0.52, 0.18], [0, 0, 0], frame); addBox(hmi, 'Bagging-HMI-Screen', [0.34, 0.30, 0.025], [0, 0.02, -0.102], screenMaterial); root.add(hmi);
		const stackLight = new THREE.Group(); stackLight.name = 'Bagging-Stack-Light'; stackLight.position.set(frameHalfX - 0.18, machineHeight + 0.18, frameHalfZ); stackLight.userData.stackLight = true;
		addCylinder(stackLight, 'Bagging-Stack-Light-Pole', 0.025, 0.34, [0, -0.12, 0], frame, 'y');
		for (const [name, color, y] of [['Red',0xef4444,0.18],['Amber',0xf59e0b,0],['Green',0x22c55e,-0.18]] as const) addCylinder(stackLight, 'Bagging-Stack-Light-' + name, 0.075, 0.14, [0,y,0], createMaterial(color,{emissive:color,emissiveIntensity:name==='Green'?0.72:0.2,roughness:0.26,metalness:0.12}), 'y');
		root.add(stackLight);
		const label = createCanvasLabel('化纤侧封膜机'); label.position.set(0, machineHeight + 0.54, width / 2 + 0.02); root.add(label);

		const ports: TwinComponentPortDefinition[] = [
			{ portId:'input', name:'入口', type:'material-input', localPosition:[-length/2,conveyorHeight,0], localDirection:[-1,0,0] },
			{ portId:'output', name:'出口', type:'material-output', localPosition:[length/2,conveyorHeight,0], localDirection:[1,0,0] },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'bagging', name: '套袋机内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-length / 2, conveyorHeight, 0], portId: 'input' },
				{ pointId: 'process', name: '套袋工位', localPosition: [0, conveyorHeight, 0], kind: 'processStation', processType: 'bagging' },
				{ pointId: 'output', name: '出口', localPosition: [length / 2, conveyorHeight, 0], portId: 'output' },
			],
			edges: [
				{ edgeId: 'input-to-process', fromPointId: 'input', toPointId: 'process', capacity: 1 },
				{ edgeId: 'process-to-output', fromPointId: 'process', toPointId: 'output', capacity: 1 },
			],
		}];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.resourceKey = definition.resourceKey; root.userData.generator = this.generator; root.userData.generatorVersion = definition.generatorVersion;
		root.userData.capabilities = ['material-flow','capacity','process-station','plc-binding','continuous-film-feed','side-seal','film-cut'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth, filmWrapWidth, filmWrapDepth, filmRollDiameter, showBagFilm, transportUnitType: 'plastic-pallet' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
