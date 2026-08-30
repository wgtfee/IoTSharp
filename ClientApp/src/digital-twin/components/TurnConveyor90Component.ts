import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

export class TurnConveyor90Component implements TwinComponentGenerator {
	readonly componentType = 'turn-conveyor-90' as const;
	readonly generator = 'turn-conveyor-90-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const radius = resolveNumber(props, 'radius', 2.2, 0.8, 12);
		const width = resolveNumber(props, 'width', 1.6, 0.5, 6);
		const height = resolveNumber(props, 'height', 0.9, 0.2, 3);
		const rollerDiameter = resolveNumber(props, 'rollerDiameter', 0.14, 0.05, 0.6);
		const rollerPitch = resolveNumber(props, 'rollerPitch', 0.45, rollerDiameter * 1.1, 2);
		const direction = props.turnDirection === 'right' ? -1 : 1;
		const root = new THREE.Group();
		root.name = definition.name;
		const frameMaterial = createMaterial(0x334155, { roughness: 0.62, metalness: 0.7 });
		const rollerMaterial = createMaterial(0x94a3b8, { roughness: 0.34, metalness: 0.86 });
		const railRadiusInner = Math.max(0.25, radius - width / 2);
		const railRadiusOuter = radius + width / 2;
		const start = direction > 0 ? -Math.PI / 2 : Math.PI / 2;
		const end = 0;
		const curveForRadius = (r: number) => new THREE.CatmullRomCurve3(
			Array.from({ length: 24 }, (_, index) => {
				const t = index / 23;
				const angle = start + (end - start) * t;
				return new THREE.Vector3(Math.cos(angle) * r, height - 0.08, Math.sin(angle) * r);
			}),
		);
		for (const r of [railRadiusInner, railRadiusOuter]) {
			const rail = new THREE.Mesh(new THREE.TubeGeometry(curveForRadius(r), 30, 0.06, 8, false), frameMaterial);
			rail.name = r === railRadiusInner ? 'Frame_Inner' : 'Frame_Outer';
			root.add(rail);
		}
		const arcLength = Math.PI * radius / 2;
		const rollerCount = Math.max(3, Math.floor(arcLength / rollerPitch) + 1);
		const rollerGeometry = new THREE.CylinderGeometry(rollerDiameter / 2, rollerDiameter / 2, Math.max(0.2, width - 0.14), 14);
		const rollers = new THREE.InstancedMesh(rollerGeometry, rollerMaterial, rollerCount);
		rollers.name = 'Rollers';
		const dummy = new THREE.Object3D();
		const yAxis = new THREE.Vector3(0, 1, 0);
		for (let index = 0; index < rollerCount; index += 1) {
			const t = rollerCount <= 1 ? 0 : index / (rollerCount - 1);
			const angle = start + (end - start) * t;
			const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).normalize();
			dummy.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
			dummy.quaternion.setFromUnitVectors(yAxis, radial);
			dummy.updateMatrix();
			rollers.setMatrixAt(index, dummy.matrix);
		}
		rollers.instanceMatrix.needsUpdate = true;
		root.add(rollers);
		const inputAngle = start;
		const outputAngle = end;
		const inputDirection: [number, number, number] = direction > 0 ? [-1, 0, 0] : [-1, 0, 0];
		const outputDirection: [number, number, number] = direction > 0 ? [0, 0, 1] : [0, 0, -1];
		const ports: TwinComponentPortDefinition[] = [
			{
				portId: 'input', name: '入口', type: 'material-input',
				localPosition: [Math.cos(inputAngle) * radius, height, Math.sin(inputAngle) * radius],
				localDirection: inputDirection,
			},
			{
				portId: 'output', name: '出口', type: 'material-output',
				localPosition: [Math.cos(outputAngle) * radius, height, Math.sin(outputAngle) * radius],
				localDirection: outputDirection,
			},
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.properties = { ...props, radius, width, height, rollerDiameter, rollerPitch, turnDirection: direction > 0 ? 'left' : 'right' };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
