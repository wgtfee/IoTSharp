import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class MergerConveyorComponent implements TwinComponentGenerator {
	readonly componentType = 'merger-conveyor' as const;
	readonly generator = 'merger-conveyor-v1';

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const width = resolveNumber(props, 'width', 1.6, 0.5, 6);
		const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
		const inputLength = resolveNumber(props, 'inputLength', 2.5, 0.8, 12);
		const outputLength = resolveNumber(props, 'outputLength', 2.2, 0.8, 12);
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
		const inputA = buildSegment(inputLength);
		inputA.name = 'InputStraight';
		inputA.position.x = -inputLength / 2;
		root.add(inputA);
		const inputB = buildSegment(inputLength);
		inputB.name = 'InputBranch';
		inputB.rotation.y = branchAngle;
		inputB.position.set(-Math.cos(branchAngle) * inputLength / 2, 0, Math.sin(branchAngle) * inputLength / 2);
		root.add(inputB);
		const output = buildSegment(outputLength);
		output.name = 'OutputConveyor';
		output.position.x = outputLength / 2;
		root.add(output);
		const inputBStart = new THREE.Vector3(-Math.cos(branchAngle) * inputLength, height, Math.sin(branchAngle) * inputLength);
		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input-a', name: '直行入口', type: 'material-input', localPosition: [-inputLength, height, 0], localDirection: [-1, 0, 0] },
			{ portId: 'input-b', name: '汇流入口', type: 'material-input', localPosition: [inputBStart.x, height, inputBStart.z], localDirection: [-Math.cos(branchAngle), 0, Math.sin(branchAngle)] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [outputLength, height, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.merger = true;
		root.userData.properties = { ...props, width, height, inputLength, outputLength, branchAngle: branchAngleDeg };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
