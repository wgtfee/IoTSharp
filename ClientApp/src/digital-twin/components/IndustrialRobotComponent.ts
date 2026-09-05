import * as THREE from 'three';
import { applyComponentIdentity, createComponentResult, createMaterial, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator } from './types';

/**
 * 可整体选择、拖动和绑定的六轴工业机器人组件。
 * 支持普通搬运夹具、化纤丝锭 1×6 / 2×6 抓具；夹具始终挂在 J6 末端，不允许悬空飞行。
 */
export class IndustrialRobotComponent implements TwinComponentGenerator {
	readonly componentType = 'industrial-robot' as const;
	readonly generator = 'industrial-robot-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const pedestalRadius = resolveNumber(props, 'pedestalRadius', 0.72, 0.35, 1.5);
		const upperArmLength = resolveNumber(props, 'upperArmLength', 1.65, 0.7, 3.5);
		const forearmLength = resolveNumber(props, 'forearmLength', 1.45, 0.7, 3.5);
		const toolType = props.toolType === 'silk-grid-2x6' ? 'silk-grid-2x6' : props.toolType === 'silk-row-1x6' ? 'silk-row-1x6' : 'pallet-gripper';
		const gripperSpan = resolveNumber(props, 'gripperSpan', 6.2, 2.5, 9);
		const gripperRowSpacing = resolveNumber(props, 'gripperRowSpacing', 1.15, 0.5, 2.5);
		const axis1HomeYaw = resolveNumber(props, 'axis1HomeYaw', -0.45, -Math.PI, Math.PI);
		const axis2HomePitch = resolveNumber(props, 'axis2HomePitch', -0.48, -Math.PI, Math.PI);
		const axis3HomePitch = resolveNumber(props, 'axis3HomePitch', 1.20, -Math.PI, Math.PI);
		const root = new THREE.Group();
		root.name = definition.name;

		const bodyMaterial = createMaterial(0xf97316, { roughness: 0.42, metalness: 0.58 });
		const jointMaterial = createMaterial(0x1e293b, { roughness: 0.48, metalness: 0.72 });
		const toolMaterial = createMaterial(0x94a3b8, { roughness: 0.35, metalness: 0.78 });
		const cupMaterial = createMaterial(0x111827, { roughness: 0.7, metalness: 0.16 });

		const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(pedestalRadius, pedestalRadius * 1.12, 0.58, 28), jointMaterial);
		pedestal.name = 'Robot-Pedestal';
		pedestal.position.y = 0.29;
		root.add(pedestal);

		const axis1 = new THREE.Group();
		axis1.name = 'Robot-Axis-1';
		axis1.position.y = 0.58;
		axis1.rotation.y = axis1HomeYaw;
		axis1.userData.axis = 'y';
		const waist = new THREE.Mesh(new THREE.CylinderGeometry(pedestalRadius * 0.72, pedestalRadius * 0.82, 0.58, 24), bodyMaterial);
		waist.position.y = 0.29;
		axis1.add(waist);
		root.add(axis1);

		const axis2 = new THREE.Group();
		axis2.name = 'Robot-Axis-2';
		axis2.position.y = 0.56;
		axis2.rotation.z = axis2HomePitch;
		axis2.userData.axis = 'z';
		axis2.add(new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 16), jointMaterial));
		const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.48, upperArmLength, 0.48), bodyMaterial);
		upperArm.name = 'Robot-Upper-Arm';
		upperArm.position.y = upperArmLength / 2;
		axis2.add(upperArm);
		axis1.add(axis2);

		const axis3 = new THREE.Group();
		axis3.name = 'Robot-Axis-3';
		axis3.position.y = upperArmLength;
		axis3.rotation.z = axis3HomePitch;
		axis3.userData.axis = 'z';
		axis3.add(new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 16), jointMaterial));
		const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.40, forearmLength, 0.40), bodyMaterial);
		forearm.name = 'Robot-Forearm';
		forearm.position.y = forearmLength / 2;
		axis3.add(forearm);
		axis2.add(axis3);

		const axis4 = new THREE.Group();
		axis4.name = 'Robot-Axis-4';
		axis4.position.y = forearmLength;
		axis4.userData.axis = 'y';
		const wrist4 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.45, 18), jointMaterial);
		wrist4.name = 'Robot-Wrist-4';
		axis4.add(wrist4);
		axis3.add(axis4);

		const axis5 = new THREE.Group();
		axis5.name = 'Robot-Axis-5';
		axis5.position.y = 0.24;
		axis5.userData.axis = 'z';
		const wrist5 = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.30, 18), bodyMaterial);
		wrist5.rotation.x = Math.PI / 2;
		wrist5.name = 'Robot-Wrist-5';
		axis5.add(wrist5);
		axis4.add(axis5);

		const axis6 = new THREE.Group();
		axis6.name = 'Robot-Axis-6';
		axis6.position.y = 0.18;
		axis6.userData.axis = 'y';
		const wrist6 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 18), jointMaterial);
		wrist6.name = 'Robot-Wrist-6';
		axis6.add(wrist6);
		axis5.add(axis6);

		const tool = new THREE.Group();
		tool.name = 'Robot-Tool-Flange';
		tool.position.y = 0.18;
		tool.userData.axis = 'y';
		const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.22, 18), toolMaterial);
		flange.name = 'Robot-Tool-Flange-Mesh';
		tool.add(flange);
		axis6.add(tool);

		if (toolType === 'silk-row-1x6' || toolType === 'silk-grid-2x6') {
			const rowCount = toolType === 'silk-grid-2x6' ? 2 : 1;
			const headCount = rowCount * 6;
			const gripper = new THREE.Group();
			gripper.name = rowCount === 2 ? 'RobotGridGripper-2x6' : 'RobotRowGripper-1x6';
			gripper.userData.toolType = toolType;
			if (rowCount === 2) {
				// 正确吸附关系：夹具板面垂直 J6；吸盘轴与 J6 平行。
				// 六轴姿态只负责让 J6 正对丝车，12 个吸盘接触面即可与丝锭端面保持平行。
				const mount = new THREE.Group();
				mount.name = 'RobotGridGripper-FlangeMount';
				mount.position.y = 0.18;
				mount.userData.axis6LocalDirection = [0, 1, 0];
				mount.userData.gripperApproachLocalDirection = [0, 1, 0];
				mount.userData.mountAngleDegrees = 0;
				const axialBracket = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.34, 0.52), toolMaterial);
				axialBracket.name = 'RobotGridGripper-AxialBracket';
				axialBracket.position.y = 0.17;
				mount.add(axialBracket);
				gripper.position.set(0, 0.40, 0);
				gripper.userData.axis6AngleDegrees = 0;
				gripper.userData.gripDirection = 'local-positive-y-parallel-j6';
				gripper.userData.contactPlane = 'local-xz';
				mount.add(gripper);
				tool.add(mount);
			} else {
				gripper.position.y = 0.18;
				gripper.rotation.x = -Math.PI / 2;
				gripper.userData.gripDirection = 'local-negative-y-to-tool-positive-z';
				tool.add(gripper);
			}
			gripper.userData.gripperRows = rowCount;
			gripper.userData.gripperColumns = 6;
			gripper.userData.gripperHeadCount = headCount;
			if (rowCount === 2) gripper.userData.gripDirection = 'local-positive-y-parallel-j6';
			const pitch = gripperSpan / 6;
			for (let row = 0; row < rowCount; row += 1) {
				const rowZ = rowCount === 1 ? 0 : (row === 0 ? -gripperRowSpacing / 2 : gripperRowSpacing / 2);
				const rail = new THREE.Mesh(new THREE.BoxGeometry(gripperSpan, 0.18, 0.22), toolMaterial);
				rail.name = rowCount === 1 ? 'RobotRowGripperRail' : `RobotGridGripperRail-R${row + 1}`;
				rail.position.z = rowZ;
				gripper.add(rail);
				for (let column = 0; column < 6; column += 1) {
					const index = row * 6 + column + 1;
					const head = new THREE.Group();
					head.name = `RobotGripperHead-${index}`;
					head.position.set(-gripperSpan / 2 + pitch * (column + 0.5), rowCount === 2 ? 0.10 : -0.18, rowZ);
					head.userData.row = row + 1;
					head.userData.column = column + 1;
					const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.34, 16), jointMaterial);
					shaft.name = `RobotGripperShaft-${index}`;
					shaft.position.y = rowCount === 2 ? 0.17 : -0.13;
					head.add(shaft);
					const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.11, 0.10, 20), cupMaterial);
					cup.name = `RobotGripperCup-${index}`;
					cup.position.y = rowCount === 2 ? 0.39 : -0.34;
					cup.userData.contactNormalLocal = rowCount === 2 ? [0, 1, 0] : [0, -1, 0];
					head.add(cup);
					gripper.add(head);
				}
			}
			if (rowCount === 2) {
				for (const x of [-gripperSpan / 2 + 0.18, gripperSpan / 2 - 0.18, 0]) {
					const brace = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, gripperRowSpacing + 0.22), toolMaterial);
					brace.name = 'RobotGridGripper-CrossBrace';
					brace.position.x = x;
					gripper.add(brace);
				}
			}
		} else {
			const gripper = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 0.34), toolMaterial);
			gripper.name = 'Robot-Pallet-Gripper';
			gripper.position.y = 0.18;
			tool.add(gripper);
		}

		root.traverse((node: any) => {
			if (node.isMesh) {
				node.castShadow = true;
				node.receiveShadow = true;
			}
		});
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.generator = this.generator;
		root.userData.robotAxisCount = 6;
		root.userData.toolType = toolType;
		root.userData.gripperHeadCount = toolType === 'silk-grid-2x6' ? 12 : toolType === 'silk-row-1x6' ? 6 : 1;
		root.userData.properties = { ...props, pedestalRadius, upperArmLength, forearmLength, toolType, gripperSpan, gripperRowSpacing, axis1HomeYaw, axis2HomePitch, axis3HomePitch };
		setTransform(root, definition.transform);
		return createComponentResult(root, []);
	}
}
