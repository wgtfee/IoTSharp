import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class DiverterConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'diverter-conveyor' as const;
	readonly generator = 'diverter-conveyor-v1';

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const width = resolveNumber(props, 'width', 1.6, 0.5, 6);
		const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
		const inputLength = resolveNumber(props, 'inputLength', 2.2, 0.8, 12);
		const outputLength = resolveNumber(props, 'outputLength', 2.5, 0.8, 12);
		const branchAngleDeg = resolveNumber(props, 'branchAngle', 35, 10, 80);
		const branchAngle = THREE.MathUtils.degToRad(branchAngleDeg);
		const rollerDiameter = resolveNumber(props, 'rollerDiameter', 0.14, 0.05, 0.6);
		const rollerPitch = resolveNumber(props, 'rollerPitch', 0.5, rollerDiameter * 1.1, 2);
		const root = new THREE.Group();
		root.name = definition.name;
		const buildSegment = (length: number) => createStraightRollerGeometry({
			length,
			width,
			height,
			rollerDiameter,
			rollerPitch,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: 2,
		});
		const input = buildSegment(inputLength);
		input.name = 'InputConveyor';
		input.position.x = -inputLength / 2;
		root.add(input);
		const straight = buildSegment(outputLength);
		straight.name = 'OutputStraight';
		straight.position.x = outputLength / 2;
		root.add(straight);
		const branch = buildSegment(outputLength);
		branch.name = 'OutputBranch';
		branch.rotation.y = -branchAngle;
		branch.position.set(Math.cos(branchAngle) * outputLength / 2, 0, Math.sin(branchAngle) * outputLength / 2);
		root.add(branch);
		const pivotMaterial = createMaterial(0xf59e0b, { roughness: 0.42, metalness: 0.72, emissive: 0x78350f, emissiveIntensity: 0.15 });
		const diverterArm = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.1, 0.12), pivotMaterial);
		diverterArm.name = 'DiverterArm';
		diverterArm.position.set(0.45, height + 0.13, 0);
		root.add(diverterArm);
		const branchEnd = new THREE.Vector3(Math.cos(branchAngle) * outputLength, height, Math.sin(branchAngle) * outputLength);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-inputLength, height, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output-a', name: '直行出口', type: 'material-output', localPosition: [outputLength, height, 0], localDirection: [1, 0, 0] },
			{ portId: 'output-b', name: '分流出口', type: 'material-output', localPosition: [branchEnd.x, height, branchEnd.z], localDirection: [Math.cos(branchAngle), 0, Math.sin(branchAngle)] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.junction = true;
		root.userData.properties = { ...props, width, height, inputLength, outputLength, branchAngle: branchAngleDeg };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
