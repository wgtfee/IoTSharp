import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

export class RollerConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'roller-conveyor' as const;
	readonly generator = 'roller-conveyor-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const sizeClass = props.conveyorSizeClass === 'large' ? 'large' : 'small';
		const length = resolveNumber(props, 'length', sizeClass === 'large' ? 4 : 3, 0.2, 100);
		const width = resolveNumber(props, 'width', sizeClass === 'large' ? 2.4 : 1.6, 0.5, 8);
		const height = resolveNumber(props, 'height', sizeClass === 'large' ? 0.82 : 0.9, 0.2, 3);
		const rollerDiameter = resolveNumber(props, 'rollerDiameter', sizeClass === 'large' ? 0.18 : 0.14, 0.05, 0.6);
		const rollerPitch = resolveNumber(props, 'rollerPitch', sizeClass === 'large' ? 0.6 : 0.55, rollerDiameter * 1.1, 2);
		const root = new THREE.Group();
		root.name = definition.name;
		const geometry = createStraightRollerGeometry({
			length,
			width,
			height,
			rollerDiameter,
			rollerPitch,
			frameHeight: resolveNumber(props, 'frameHeight', 0.16, 0.08, 0.8),
			frameThickness: resolveNumber(props, 'frameThickness', 0.1, 0.04, 0.5),
			supportSpacing: resolveNumber(props, 'supportSpacing', 2, 0.8, 8),
			frameColor: sizeClass === 'large' ? 0x475569 : 0x334155,
			rollerColor: 0x94a3b8,
		});
		const driveMotor = geometry.getObjectByName('驱动电机');
		if (driveMotor) driveMotor.userData.twinEquipmentId = `${definition.objectId}:drive-motor`;
		// 图纸中的直角移载位只保留一张辊床，开放侧面接驳，避免相交的整段边梁穿透。
		if (props.openTransferSides === true) {
			for (const name of ['Frame_Left', 'Frame_Right', '驱动电机']) {
				const part = geometry.getObjectByName(name);
				if (part) part.visible = false;
			}
			root.userData.transferJunction = true;
			root.userData.disableAutoOutputStoppers = true;
		}
		root.add(geometry);
		const ports: TwinComponentPortDefinition[] = [
			{
				portId: 'input',
				name: '入口',
				type: 'material-input',
				localPosition: [-length / 2, height, 0],
				localDirection: [-1, 0, 0],
			},
			{
				portId: 'output',
				name: '出口',
				type: 'material-output',
				localPosition: [length / 2, height, 0],
				localDirection: [1, 0, 0],
			},
		];
		// Studio V2: the existing 108-pallet output port is occupied by
		// the original main route. Only this separate simulation branch port
		// can be used; true pallet identity transfer still requires occupancy.
		if (props.cacheBranchOutput === true) {
			ports.push({
				portId: 'cache-branch-output', name: '余丝分支出口（需要主回路授权）',
				type: 'material-output',
				localPosition: [length / 2, height, 0],
				localDirection: [1, 0, 0],
				metadata: { routeTap: true, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
					requiresMainLoopOccupancyGrant: true, simulationPreviewOnly: true },
			});
		}
		// Independent side-entry at the original BLUE main line's midspan,
		// not the already occupied input/output ends. The empty small pallet
		// may not enter the main 108-pallet loop without occupancy arbitration.
		if (props.cacheReturnEntry === true) {
			ports.push({
				portId: 'cache-return-entry', name: '红线折回蓝线的直角待接收入口',
				type: 'material-input',
				localPosition: [0, height, 0],
				localDirection: [-1, 0, 0],
				metadata: { routeTap: true, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
					requiresMainLoopOccupancyGrant: true, requiresSamePalletIdHandoff: true,
					simulationPreviewOnly: true },
			});
		}
		// Square 90-degree transfer in and out of a straight cross conveyor.
		// With yaw=-PI/2, both local +Z directions face world -X and oppose
		// the neighboring horizontal conveyor ports. No circular rail exists.
		if (props.squareRightAngleTransfer === true) {
			ports[0].localDirection = [0, 0, 1];
			ports[1].localDirection = [0, 0, 1];
			ports[0].name = '90度直角入口';
			ports[1].name = '90度直角出口';
			root.userData.squareRightAngleTransfer = true;
			root.userData.rounded = false;
		}
		// The existing full-width empty SMALL pallet route has two 90-degree
		// bends: right DOWN -> WEST across floor -> left DOWN. These are
		// two SQUARE guide beds inside the EXISTING horizontal conveyor;
		// never introduce a duplicated long return or a rounded U-turn.
		if (props.fullSpanTwoSquareElbows === true) {
			const markerMaterial = new THREE.MeshStandardMaterial({
				color: 0xeab308, metalness: 0.68, roughness: 0.35,
			});
			const surfaceY = height + 0.025;
			for (const side of ['Right', 'Left'] as const) {
				const elbow = new THREE.Group();
				elbow.name = `EmptyReturnSquareElbow-${side}`;
				elbow.position.set(side === 'Right' ? -length / 2 : length / 2, 0, 0);
				elbow.userData.squareCorner = true;
				elbow.userData.rounded = false;
				const horizontalRail = new THREE.Mesh(new THREE.BoxGeometry(width, 0.055, 0.09), markerMaterial);
				horizontalRail.position.set(0, surfaceY, -width * 0.38);
				horizontalRail.name = 'StraightWestGuide';
				elbow.add(horizontalRail);
				const verticalRail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, width), markerMaterial);
				verticalRail.position.set(side === 'Right' ? -width * 0.38 : width * 0.38, surfaceY, 0);
				verticalRail.name = side === 'Right' ? 'RightDownGuide' : 'LeftDownGuide';
				elbow.add(verticalRail);
				root.add(elbow);
			}
			// The horizontal span has yaw=PI; local +Z faces world -Z,
			// opposing the incoming RIGHT vertical-down output (+Z).
			ports.push({
				portId: 'square-right-input', name: '右端向下90度后转左',
				type: 'material-input',
				localPosition: [-length / 2, height, 0],
				localDirection: [0, 0, 1],
				metadata: { routeTap: true, physicalSquareCorner: true,
					transportUnitType: 'plastic-pallet', requiresOccupancyGrant: true },
			});
			root.userData.fullSpanTwoSquareElbows = true;
			root.userData.rounded = false;
		}
		// Optional side input, only when this real roller is configured as a physical merge.
const sideMergeX = props.sideMergeInlet === true ? -length / 2 + 0.25 : undefined;
if (sideMergeX !== undefined) {
    ports.push({
        portId: 'side-input', name: '侧向汇流入口', type: 'material-bidirectional',
        localPosition: [sideMergeX, height, 0], localDirection: [0, 0, -1],
        metadata: { routeTap: true, conveyorSizeClass: sizeClass, transportUnitType: 'plastic-pallet' },
    });
    root.userData.sideMergeInlet = true;
}
const transportUnitType = props.transportUnitType === 'carton' ? 'carton' : props.transportUnitType === 'wooden-pallet' ? 'wooden-pallet' : 'plastic-pallet';
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'main', name: '内置直线输送路线', conveyorSizeClass: sizeClass, transportUnitType,
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-length / 2, height, 0], kind: 'buffer', portId: 'input' },
				{ pointId: 'output', name: '出口', localPosition: [length / 2, height, 0], kind: 'buffer', portId: 'output' },
                ...(sideMergeX === undefined ? [] : [{ pointId: 'side-input', name: '侧向汇流入口', localPosition: [sideMergeX, height, 0] as [number, number, number], kind: 'merger' as const, portId: 'side-input' }]),
			],
			edges: [
                { edgeId: 'through', fromPointId: 'input', toPointId: 'output', name: '辊道内部输送', capacity: Number(props.capacity || 4), speedLimit: Number(props.speedLimit || 1.2) },
                ...(sideMergeX === undefined ? [] : [{ edgeId: 'side-merge-through', fromPointId: 'side-input', toPointId: 'output', name: '侧向汇流接入', capacity: Number(props.capacity || 4), speedLimit: Number(props.speedLimit || 1.2) }]),
            ],
		}];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.properties = { ...props, length, width, height, rollerDiameter, rollerPitch };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
