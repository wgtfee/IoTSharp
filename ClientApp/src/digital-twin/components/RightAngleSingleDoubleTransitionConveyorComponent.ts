import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

type XZ = [number, number];

type SharedGeometry = {
	laneWidth: number;
	laneSpacing: number;
	height: number;
	inputStubLength: number;
	outputStubLength: number;
	rollerDiameter: number;
	rollerPitch: number;
};

const addSegment = (
	root: THREE.Group,
	name: string,
	from: XZ,
	to: XZ,
	options: SharedGeometry,
) => {
	const dx = to[0] - from[0];
	const dz = to[1] - from[1];
	const length = Math.hypot(dx, dz);
	const segment = createStraightRollerGeometry({
		length,
		width: options.laneWidth,
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

const resolveSharedGeometry = (props: Record<string, unknown>): SharedGeometry => {
	const laneWidth = resolveNumber(props, 'laneWidth', 1.6, 0.5, 4);
	const requestedLaneSpacing = resolveNumber(props, 'laneSpacing', 1.9, 0.6, 8);
	const laneSpacing = Math.max(requestedLaneSpacing, laneWidth + 0.08);
	const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
	const inputStubLength = resolveNumber(props, 'inputStubLength', 2.2, 0.6, 12);
	const outputStubLength = resolveNumber(props, 'outputStubLength', 2.6, 0.6, 12);
	const rollerDiameter = resolveNumber(props, 'rollerDiameter', 0.14, 0.05, 0.6);
	const rollerPitch = resolveNumber(props, 'rollerPitch', 0.45, rollerDiameter * 1.1, 2);
	return { laneWidth, laneSpacing, height, inputStubLength, outputStubLength, rollerDiameter, rollerPitch };
};

/**
 * 用户草图左侧：上方单排入口向下进入，在两处横向分支形成右侧两条平行出口。
 * 顶视图 local -Z 为上方，local +X 为右方。
 */
export class RightAngleSingleToDoubleConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'diverter-conveyor' as const;
	readonly generator = 'right-angle-single-to-double-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const g = resolveSharedGeometry(props);
		const root = new THREE.Group();
		root.name = definition.name;

		const laneA = -g.laneSpacing / 2;
		const laneB = g.laneSpacing / 2;
		const input: XZ = [0, laneA - g.inputStubLength];
		const junctionA: XZ = [0, laneA];
		const junctionB: XZ = [0, laneB];
		const outputA: XZ = [g.outputStubLength, laneA];
		const outputB: XZ = [g.outputStubLength, laneB];

		addSegment(root, 'RightAngleSplit-Trunk', input, junctionB, g);
		addSegment(root, 'RightAngleSplit-Output-A', junctionA, outputA, g);
		addSegment(root, 'RightAngleSplit-Output-B', junctionB, outputB, g);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '上方单排入口', type: 'material-input', localPosition: [input[0], g.height, input[1]], localDirection: [0, 0, -1] },
			{ portId: 'output-a', name: '右侧双排 A 出口', type: 'material-output', localPosition: [outputA[0], g.height, outputA[1]], localDirection: [1, 0, 0], metadata: { laneId: 'A', laneSpacing: g.laneSpacing } },
			{ portId: 'output-b', name: '右侧双排 B 出口', type: 'material-output', localPosition: [outputB[0], g.height, outputB[1]], localDirection: [1, 0, 0], metadata: { laneId: 'B', laneSpacing: g.laneSpacing } },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'right-angle-single-to-double',
			name: '直角一分二内置路线',
			conveyorSizeClass: 'small',
			transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input', name: '上方单排入口', localPosition: [input[0], g.height, input[1]], portId: 'input' },
				{ pointId: 'junction-a', name: '第一分流位', localPosition: [junctionA[0], g.height, junctionA[1]], kind: 'diverter' },
				{ pointId: 'junction-b', name: '第二转向位', localPosition: [junctionB[0], g.height, junctionB[1]], kind: 'buffer' },
				{ pointId: 'output-a', name: '右侧 A 出口', localPosition: [outputA[0], g.height, outputA[1]], portId: 'output-a' },
				{ pointId: 'output-b', name: '右侧 B 出口', localPosition: [outputB[0], g.height, outputB[1]], portId: 'output-b' },
			],
			edges: [
				{ edgeId: 'input-to-junction-a', fromPointId: 'input', toPointId: 'junction-a', capacity: Number(props.capacity || 2) },
				{ edgeId: 'junction-a-to-output-a', fromPointId: 'junction-a', toPointId: 'output-a', capacity: Number(props.capacity || 2) },
				{ edgeId: 'junction-a-to-junction-b', fromPointId: 'junction-a', toPointId: 'junction-b', capacity: Number(props.capacity || 2) },
				{ edgeId: 'junction-b-to-output-b', fromPointId: 'junction-b', toPointId: 'output-b', capacity: Number(props.capacity || 2) },
			],
		}];

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transitionType = 'right-angle-single-to-double';
		root.userData.laneSpacing = g.laneSpacing;
		root.userData.inputSide = 'top';
		root.userData.outputSide = 'right';
		root.userData.properties = { ...props, ...g, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}

/**
 * 用户草图右侧：左侧两条平行入口向右进入，依次接入右侧公共竖向干线后向上输出。
 * 顶视图 local -Z 为上方，local +X 为右方。
 */
export class RightAngleDoubleToSingleConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'merger-conveyor' as const;
	readonly generator = 'right-angle-double-to-single-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const g = resolveSharedGeometry(props);
		const root = new THREE.Group();
		root.name = definition.name;

		const laneA = -g.laneSpacing / 2;
		const laneB = g.laneSpacing / 2;
		const inputA: XZ = [-g.inputStubLength, laneA];
		const inputB: XZ = [-g.inputStubLength, laneB];
		const merge: XZ = [0, laneA];
		const lowerTurn: XZ = [0, laneB];
		const output: XZ = [0, laneA - g.outputStubLength];

		addSegment(root, 'RightAngleMerge-Input-A', inputA, merge, g);
		addSegment(root, 'RightAngleMerge-Input-B', inputB, lowerTurn, g);
		addSegment(root, 'RightAngleMerge-Trunk', output, lowerTurn, g);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input-a', name: '左侧双排 A 入口', type: 'material-input', localPosition: [inputA[0], g.height, inputA[1]], localDirection: [-1, 0, 0], metadata: { laneId: 'A', laneSpacing: g.laneSpacing } },
			{ portId: 'input-b', name: '左侧双排 B 入口', type: 'material-input', localPosition: [inputB[0], g.height, inputB[1]], localDirection: [-1, 0, 0], metadata: { laneId: 'B', laneSpacing: g.laneSpacing } },
			{ portId: 'output', name: '上方单排出口', type: 'material-output', localPosition: [output[0], g.height, output[1]], localDirection: [0, 0, -1] },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'right-angle-double-to-single',
			name: '直角二合一内置路线',
			conveyorSizeClass: 'small',
			transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input-a', name: '左侧 A 入口', localPosition: [inputA[0], g.height, inputA[1]], portId: 'input-a' },
				{ pointId: 'input-b', name: '左侧 B 入口', localPosition: [inputB[0], g.height, inputB[1]], portId: 'input-b' },
				{ pointId: 'lower-turn', name: '下路转向位', localPosition: [lowerTurn[0], g.height, lowerTurn[1]], kind: 'buffer' },
				{ pointId: 'merge', name: '公共竖向干线汇流位', localPosition: [merge[0], g.height, merge[1]], kind: 'merger' },
				{ pointId: 'output', name: '上方单排出口', localPosition: [output[0], g.height, output[1]], portId: 'output' },
			],
			edges: [
				{ edgeId: 'input-a-to-merge', fromPointId: 'input-a', toPointId: 'merge', capacity: Number(props.capacity || 2) },
				{ edgeId: 'input-b-to-lower-turn', fromPointId: 'input-b', toPointId: 'lower-turn', capacity: Number(props.capacity || 2) },
				{ edgeId: 'lower-turn-to-merge', fromPointId: 'lower-turn', toPointId: 'merge', capacity: Number(props.capacity || 2) },
				{ edgeId: 'merge-to-output', fromPointId: 'merge', toPointId: 'output', capacity: Number(props.capacity || 2) },
			],
		}];

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.transitionType = 'right-angle-double-to-single';
		root.userData.laneSpacing = g.laneSpacing;
		root.userData.inputSide = 'left';
		root.userData.outputSide = 'top';
		root.userData.mergeOnSharedTrunk = true;
		root.userData.properties = { ...props, ...g, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
