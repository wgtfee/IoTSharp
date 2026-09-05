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
		const length = resolveNumber(props, 'length', sizeClass === 'large' ? 4 : 3, 0.5, 100);
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
		const transportUnitType = props.transportUnitType === 'carton' ? 'carton' : props.transportUnitType === 'wooden-pallet' ? 'wooden-pallet' : 'plastic-pallet';
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'main', name: '内置直线输送路线', conveyorSizeClass: sizeClass, transportUnitType,
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-length / 2, height, 0], kind: 'buffer', portId: 'input' },
				{ pointId: 'output', name: '出口', localPosition: [length / 2, height, 0], kind: 'buffer', portId: 'output' },
			],
			edges: [{ edgeId: 'through', fromPointId: 'input', toPointId: 'output', name: '辊道内部输送', capacity: Number(props.capacity || 4), speedLimit: Number(props.speedLimit || 1.2) }],
		}];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.properties = { ...props, length, width, height, rollerDiameter, rollerPitch };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
