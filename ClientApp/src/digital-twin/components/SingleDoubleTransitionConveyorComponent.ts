import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

type XZ = [number, number];

const addSegment = (
	root: THREE.Group,
	name: string,
	from: XZ,
	to: XZ,
	options: { width: number; height: number; rollerDiameter: number; rollerPitch: number },
) => {
	const dx = to[0] - from[0];
	const dz = to[1] - from[1];
	const length = Math.hypot(dx, dz);
	const segment = createStraightRollerGeometry({
		length,
		width: options.width,
		height: options.height,
		rollerDiameter: options.rollerDiameter,
		rollerPitch: options.rollerPitch,
		frameHeight: 0.16,
		frameThickness: 0.1,
		supportSpacing: Math.min(2, Math.max(0.8, length / 2)),
		frameColor: 0x334155,
		rollerColor: 0x94a3b8,
	});
	segment.name = name;
	segment.position.set((from[0] + to[0]) / 2, 0, (from[1] + to[1]) / 2);
	segment.rotation.y = -Math.atan2(dz, dx);
	root.add(segment);
	return segment;
};

const resolveSharedGeometry = (props: Record<string, unknown>) => {
	const laneWidth = resolveNumber(props, 'laneWidth', 1.6, 0.5, 4);
	const requestedLaneSpacing = resolveNumber(props, 'laneSpacing', 1.9, 0.6, 8);
	// 与双排小辊道保持同一约束：两排中心距不能导致实体相互穿透。
	const laneSpacing = Math.max(requestedLaneSpacing, laneWidth + 0.08);
	const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
	const transitionLength = resolveNumber(props, 'transitionLength', 2.8, 0.8, 12);
	const singleStubLength = resolveNumber(props, 'singleStubLength', 1.6, 0.5, 8);
	const doubleStubLength = resolveNumber(props, 'doubleStubLength', 1.4, 0.5, 8);
	const rollerDiameter = resolveNumber(props, 'rollerDiameter', 0.14, 0.05, 0.6);
	const rollerPitch = resolveNumber(props, 'rollerPitch', 0.45, rollerDiameter * 1.1, 2);
	const transitionAngle = Math.atan2(laneSpacing / 2, transitionLength);
	return { laneWidth, laneSpacing, height, transitionLength, singleStubLength, doubleStubLength, rollerDiameter, rollerPitch, transitionAngle };
};

export class SingleToDoubleConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'diverter-conveyor' as const;
	readonly generator = 'single-to-double-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const g = resolveSharedGeometry(props);
		const root = new THREE.Group();
		root.name = definition.name;

		const input: XZ = [-g.singleStubLength, 0];
		const junction: XZ = [0, 0];
		const branchA: XZ = [g.transitionLength, -g.laneSpacing / 2];
		const branchB: XZ = [g.transitionLength, g.laneSpacing / 2];
		const outputA: XZ = [g.transitionLength + g.doubleStubLength, -g.laneSpacing / 2];
		const outputB: XZ = [g.transitionLength + g.doubleStubLength, g.laneSpacing / 2];
		const geo = { width: g.laneWidth, height: g.height, rollerDiameter: g.rollerDiameter, rollerPitch: g.rollerPitch };

		addSegment(root, 'SingleToDouble-Input', input, junction, geo);
		addSegment(root, 'SingleToDouble-Branch-A', junction, branchA, geo);
		addSegment(root, 'SingleToDouble-Branch-B', junction, branchB, geo);
		addSegment(root, 'SingleToDouble-Output-A', branchA, outputA, geo);
		addSegment(root, 'SingleToDouble-Output-B', branchB, outputB, geo);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '单排入口', type: 'material-input', localPosition: [input[0], g.height, input[1]], localDirection: [-1, 0, 0] },
			{ portId: 'output-a', name: '双排 A 出口', type: 'material-output', localPosition: [outputA[0], g.height, outputA[1]], localDirection: [1, 0, 0], metadata: { laneId: 'A', laneSpacing: g.laneSpacing } },
			{ portId: 'output-b', name: '双排 B 出口', type: 'material-output', localPosition: [outputB[0], g.height, outputB[1]], localDirection: [1, 0, 0], metadata: { laneId: 'B', laneSpacing: g.laneSpacing } },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'single-to-double', name: '单排一分二内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input', name: '单排入口', localPosition: [input[0], g.height, input[1]], portId: 'input' },
				{ pointId: 'junction', name: '中心分流点', localPosition: [0, g.height, 0], kind: 'diverter' },
				{ pointId: 'branch-a', name: 'A 路过渡末端', localPosition: [branchA[0], g.height, branchA[1]] },
				{ pointId: 'branch-b', name: 'B 路过渡末端', localPosition: [branchB[0], g.height, branchB[1]] },
				{ pointId: 'output-a', name: '双排 A 出口', localPosition: [outputA[0], g.height, outputA[1]], portId: 'output-a' },
				{ pointId: 'output-b', name: '双排 B 出口', localPosition: [outputB[0], g.height, outputB[1]], portId: 'output-b' },
			],
			edges: [
				{ edgeId: 'input-to-junction', fromPointId: 'input', toPointId: 'junction', capacity: Number(props.capacity || 2) },
				{ edgeId: 'junction-to-a', fromPointId: 'junction', toPointId: 'branch-a', capacity: Number(props.capacity || 2) },
				{ edgeId: 'a-to-output', fromPointId: 'branch-a', toPointId: 'output-a', capacity: Number(props.capacity || 2) },
				{ edgeId: 'junction-to-b', fromPointId: 'junction', toPointId: 'branch-b', capacity: Number(props.capacity || 2) },
				{ edgeId: 'b-to-output', fromPointId: 'branch-b', toPointId: 'output-b', capacity: Number(props.capacity || 2) },
			],
		}];

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transitionType = 'single-to-double';
		root.userData.centeredTransition = true;
		root.userData.laneSpacing = g.laneSpacing;
		root.userData.transitionAngleDegrees = THREE.MathUtils.radToDeg(g.transitionAngle);
		root.userData.properties = { ...props, ...g, transitionAngleDegrees: THREE.MathUtils.radToDeg(g.transitionAngle), conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}

export class DoubleToSingleConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'merger-conveyor' as const;
	readonly generator = 'double-to-single-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const g = resolveSharedGeometry(props);
		const root = new THREE.Group();
		root.name = definition.name;

		const inputA: XZ = [-(g.transitionLength + g.doubleStubLength), -g.laneSpacing / 2];
		const inputB: XZ = [-(g.transitionLength + g.doubleStubLength), g.laneSpacing / 2];
		const branchA: XZ = [-g.transitionLength, -g.laneSpacing / 2];
		const branchB: XZ = [-g.transitionLength, g.laneSpacing / 2];
		const merge: XZ = [0, 0];
		const output: XZ = [g.singleStubLength, 0];
		const geo = { width: g.laneWidth, height: g.height, rollerDiameter: g.rollerDiameter, rollerPitch: g.rollerPitch };

		addSegment(root, 'DoubleToSingle-Input-A', inputA, branchA, geo);
		addSegment(root, 'DoubleToSingle-Input-B', inputB, branchB, geo);
		addSegment(root, 'DoubleToSingle-Branch-A', branchA, merge, geo);
		addSegment(root, 'DoubleToSingle-Branch-B', branchB, merge, geo);
		addSegment(root, 'DoubleToSingle-Output', merge, output, geo);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input-a', name: '双排 A 入口', type: 'material-input', localPosition: [inputA[0], g.height, inputA[1]], localDirection: [-1, 0, 0], metadata: { laneId: 'A', laneSpacing: g.laneSpacing } },
			{ portId: 'input-b', name: '双排 B 入口', type: 'material-input', localPosition: [inputB[0], g.height, inputB[1]], localDirection: [-1, 0, 0], metadata: { laneId: 'B', laneSpacing: g.laneSpacing } },
			{ portId: 'output', name: '单排出口', type: 'material-output', localPosition: [output[0], g.height, output[1]], localDirection: [1, 0, 0] },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'double-to-single', name: '双排二合一内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input-a', name: '双排 A 入口', localPosition: [inputA[0], g.height, inputA[1]], portId: 'input-a' },
				{ pointId: 'input-b', name: '双排 B 入口', localPosition: [inputB[0], g.height, inputB[1]], portId: 'input-b' },
				{ pointId: 'branch-a', name: 'A 路汇流前端', localPosition: [branchA[0], g.height, branchA[1]] },
				{ pointId: 'branch-b', name: 'B 路汇流前端', localPosition: [branchB[0], g.height, branchB[1]] },
				{ pointId: 'merge', name: '中心汇流点', localPosition: [0, g.height, 0], kind: 'merger' },
				{ pointId: 'output', name: '单排出口', localPosition: [output[0], g.height, output[1]], portId: 'output' },
			],
			edges: [
				{ edgeId: 'a-input', fromPointId: 'input-a', toPointId: 'branch-a', capacity: Number(props.capacity || 2) },
				{ edgeId: 'a-to-merge', fromPointId: 'branch-a', toPointId: 'merge', capacity: Number(props.capacity || 2) },
				{ edgeId: 'b-input', fromPointId: 'input-b', toPointId: 'branch-b', capacity: Number(props.capacity || 2) },
				{ edgeId: 'b-to-merge', fromPointId: 'branch-b', toPointId: 'merge', capacity: Number(props.capacity || 2) },
				{ edgeId: 'merge-to-output', fromPointId: 'merge', toPointId: 'output', capacity: Number(props.capacity || 2) },
			],
		}];

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transitionType = 'double-to-single';
		root.userData.centeredTransition = true;
		root.userData.mergeAtCenter = true;
		root.userData.laneSpacing = g.laneSpacing;
		root.userData.transitionAngleDegrees = THREE.MathUtils.radToDeg(g.transitionAngle);
		root.userData.properties = { ...props, ...g, transitionAngleDegrees: THREE.MathUtils.radToDeg(g.transitionAngle), conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
