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
		const laneAReverse = props.laneAReverse === true;
		const laneBReverse = props.laneBReverse === true;
		// Workbench 的 Manifest 由 Vue ref/reactive 持有，嵌套数组可能是 Proxy。
		// 浏览器 structuredClone(Proxy) 会直接抛 DataCloneError，因此组件边界必须先把
		// routeTaps 收敛成只包含 JSON primitive/普通数组的 DTO，再参与几何和 userData。
		const routeTaps = (Array.isArray(props.routeTaps) ? props.routeTaps as Array<Record<string, unknown>> : [])
			.map((tap) => ({
				tapId: String(tap?.tapId || ''),
				lane: String(tap?.lane || '').toUpperCase(),
				localX: Number(tap?.localX),
				terminal: tap?.terminal === true,
				side: tap?.side === 'negative' ? 'negative' : 'positive',
				localDirection: Array.isArray(tap?.localDirection) && tap.localDirection.length === 3
					? tap.localDirection.map((value) => Number(value)) as [number, number, number]
					: undefined,
			}));

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

		const ports: TwinComponentPortDefinition[] = [];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [];
		for (const lane of [
			{ id: 'A' as const, key: 'a', z: -laneSpacing / 2, reverse: laneAReverse },
			{ id: 'B' as const, key: 'b', z: laneSpacing / 2, reverse: laneBReverse },
		]) {
			const startX = lane.reverse ? length / 2 : -length / 2;
			const endX = lane.reverse ? -length / 2 : length / 2;
			const travelSign = lane.reverse ? -1 : 1;
			ports.push(
				{ portId: `${lane.key}-input`, name: `${lane.id}排入口`, type: 'material-input', localPosition: [startX, height, lane.z], localDirection: [-travelSign, 0, 0], metadata: { laneId: lane.id, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
				{ portId: `${lane.key}-output`, name: `${lane.id}排出口`, type: 'material-output', localPosition: [endX, height, lane.z], localDirection: [travelSign, 0, 0], metadata: { laneId: lane.id, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' } },
			);
			const taps = routeTaps
				.filter((tap) => String(tap.lane || '').toUpperCase() === lane.id && Number.isFinite(Number(tap.localX)))
				.map((tap) => ({
					tapId: String(tap.tapId || `tap-${lane.id.toLowerCase()}`),
					localX: THREE.MathUtils.clamp(Number(tap.localX), -length / 2, length / 2),
					terminal: tap.terminal === true,
					direction: Array.isArray(tap.localDirection) && tap.localDirection.length === 3
						? (tap.localDirection.map(Number) as [number, number, number])
						: [0, 0, tap.side === 'negative' ? -1 : 1] as [number, number, number],
				}))
				.sort((left, right) => travelSign * (left.localX - right.localX));
			const flowPoints: TwinComponentInternalFlowDefinition['points'] = [
				{ pointId: 'input', name: `${lane.id}排入口`, localPosition: [startX, height, lane.z], portId: `${lane.key}-input` },
			];
			let terminalSeen = false;
			for (const tap of taps) {
				if (terminalSeen) break;
				const portId = `${lane.key}-${tap.tapId}`;
				ports.push({
					portId,
					name: `${lane.id}排中间接驳 · ${tap.tapId}`,
					type: 'material-bidirectional',
					localPosition: [tap.localX, height, lane.z],
					localDirection: tap.direction,
					metadata: { laneId: lane.id, routeTap: true, terminal: tap.terminal, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' },
				});
				flowPoints.push({ pointId: `tap-${tap.tapId}`, name: `${lane.id}排中间接驳 · ${tap.tapId}`, localPosition: [tap.localX, height, lane.z], portId });
				terminalSeen = tap.terminal;
			}
			if (!terminalSeen) flowPoints.push({ pointId: 'output', name: `${lane.id}排出口`, localPosition: [endX, height, lane.z], portId: `${lane.key}-output` });
			internalFlows.push({
				flowId: `lane-${lane.key}`,
				name: `${lane.id}排内置路线`,
				conveyorSizeClass: 'small',
				transportUnitType: 'plastic-pallet',
				points: flowPoints,
				edges: flowPoints.slice(1).map((point, index) => ({
					edgeId: index === 0 && flowPoints.length === 2 ? 'through' : `segment-${index + 1}`,
					fromPointId: flowPoints[index].pointId,
					toPointId: point.pointId,
					capacity: capacityPerLane,
					speedLimit: Number(props.speedLimit || 1.2),
				})),
			});
		}

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
			laneAReverse,
			laneBReverse,
			routeTaps: routeTaps.map((tap) => ({
				...tap,
				localDirection: tap.localDirection ? [...tap.localDirection] : undefined,
			})),
			conveyorSizeClass: 'small',
			transportUnitType: 'plastic-pallet',
		};
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
