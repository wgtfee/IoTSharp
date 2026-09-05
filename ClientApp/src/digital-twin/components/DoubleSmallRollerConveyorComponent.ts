import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

/**
 * 双排小辊道：两条完全独立、平行的小辊道共用一个工程组件根节点。
 * A/B 两排各自保留完整边梁、辊筒、支腿、驱动电机和独立物流端口。
 */
export class DoubleSmallRollerConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'double-small-roller-conveyor' as const;
	readonly generator = 'double-small-roller-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 8, 0.5, 100);
		const laneWidth = resolveNumber(props, 'laneWidth', 1.6, 0.5, 4);
		const requestedLaneSpacing = resolveNumber(props, 'laneSpacing', 1.9, 0.6, 8);
		// 中心距不能小于单排宽度，否则两条小辊道实体会相互穿透。
		const laneSpacing = Math.max(requestedLaneSpacing, laneWidth + 0.08);
		const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
		const rollerDiameter = resolveNumber(props, 'rollerDiameter', 0.14, 0.05, 0.6);
		const rollerPitch = resolveNumber(props, 'rollerPitch', 0.55, rollerDiameter * 1.1, 2);
		const frameHeight = resolveNumber(props, 'frameHeight', 0.16, 0.08, 0.8);
		const frameThickness = resolveNumber(props, 'frameThickness', 0.1, 0.04, 0.5);
		const supportSpacing = resolveNumber(props, 'supportSpacing', 2, 0.8, 8);
		const capacityPerLane = Math.max(1, Math.round(resolveNumber(props, 'capacityPerLane', 4, 1, 999)));

		const root = new THREE.Group();
		root.name = definition.name;
		root.userData.conveyorSizeClass = 'small';
		root.userData.transportUnitType = 'plastic-pallet';
		root.userData.laneCount = 2;
		root.userData.parallelLanes = true;
		root.userData.capacityPerLane = capacityPerLane;
		root.userData.totalCapacity = capacityPerLane * 2;

		for (const lane of [
			{ id: 'A', z: -laneSpacing / 2 },
			{ id: 'B', z: laneSpacing / 2 },
		] as const) {
			const laneRoot = new THREE.Group();
			laneRoot.name = `DoubleSmall-Lane-${lane.id}`;
			laneRoot.position.z = lane.z;
			laneRoot.userData.laneId = lane.id;
			laneRoot.userData.conveyorSizeClass = 'small';
			laneRoot.userData.transportUnitType = 'plastic-pallet';
			laneRoot.userData.capacity = capacityPerLane;
			const geometry = createStraightRollerGeometry({
				length,
				width: laneWidth,
				height,
				rollerDiameter,
				rollerPitch,
				frameHeight,
				frameThickness,
				supportSpacing,
				frameColor: 0x334155,
				rollerColor: 0x94a3b8,
			});
			geometry.name = `DoubleSmall-Lane-${lane.id}-Geometry`;
			geometry.userData.laneId = lane.id;
			const rollers = geometry.getObjectByName('Rollers');
			if (rollers) {
				rollers.name = `DoubleSmall-Lane-${lane.id}-Rollers`;
				rollers.userData.laneId = lane.id;
			}
			for (const railName of ['Frame_Left', 'Frame_Right']) {
				const rail = geometry.getObjectByName(railName);
				if (rail) {
					rail.name = `DoubleSmall-Lane-${lane.id}-${railName}`;
					rail.userData.laneId = lane.id;
				}
			}
			const supports = geometry.getObjectByName('Supports');
			if (supports) supports.name = `DoubleSmall-Lane-${lane.id}-Supports`;
			const driveMotor = geometry.getObjectByName('驱动电机');
			if (driveMotor) {
				driveMotor.name = `DoubleSmall-Lane-${lane.id}-DriveMotor`;
				driveMotor.userData.twinEquipmentId = `${definition.objectId}:lane-${lane.id.toLowerCase()}-drive-motor`;
				driveMotor.userData.laneId = lane.id;
			}
			laneRoot.add(geometry);
			root.add(laneRoot);
		}

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'a-input', name: 'A排入口', type: 'material-input', localPosition: [-length / 2, height, -laneSpacing / 2], localDirection: [-1, 0, 0], metadata: { laneId: 'A', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
			{ portId: 'a-output', name: 'A排出口', type: 'material-output', localPosition: [length / 2, height, -laneSpacing / 2], localDirection: [1, 0, 0], metadata: { laneId: 'A', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
			{ portId: 'b-input', name: 'B排入口', type: 'material-input', localPosition: [-length / 2, height, laneSpacing / 2], localDirection: [-1, 0, 0], metadata: { laneId: 'B', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
			{ portId: 'b-output', name: 'B排出口', type: 'material-output', localPosition: [length / 2, height, laneSpacing / 2], localDirection: [1, 0, 0], metadata: { laneId: 'B', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [
			{
				flowId: 'lane-a', name: 'A排内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
				points: [
					{ pointId: 'input', name: 'A排入口', localPosition: [-length / 2, height, -laneSpacing / 2], portId: 'a-input' },
					{ pointId: 'output', name: 'A排出口', localPosition: [length / 2, height, -laneSpacing / 2], portId: 'a-output' },
				],
				edges: [{ edgeId: 'through', fromPointId: 'input', toPointId: 'output', capacity: capacityPerLane, speedLimit: Number(props.speedLimit || 1.2) }],
			},
			{
				flowId: 'lane-b', name: 'B排内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
				points: [
					{ pointId: 'input', name: 'B排入口', localPosition: [-length / 2, height, laneSpacing / 2], portId: 'b-input' },
					{ pointId: 'output', name: 'B排出口', localPosition: [length / 2, height, laneSpacing / 2], portId: 'b-output' },
				],
				edges: [{ edgeId: 'through', fromPointId: 'input', toPointId: 'output', capacity: capacityPerLane, speedLimit: Number(props.speedLimit || 1.2) }],
			},
		];

		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.properties = {
			...props,
			length,
			laneWidth,
			laneSpacing,
			height,
			rollerDiameter,
			rollerPitch,
			frameHeight,
			frameThickness,
			supportSpacing,
			capacityPerLane,
			conveyorSizeClass: 'small',
			transportUnitType: 'plastic-pallet',
		};
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
