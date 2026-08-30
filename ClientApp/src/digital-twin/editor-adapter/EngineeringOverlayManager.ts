import * as THREE from 'three';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { isComponentSceneObject, resolveComponentBodyBounds, resolveComponentPorts } from '/@/digital-twin/components';
import type { ThreeEditorRouteOverlay } from './ThreeEditorRouteOverlay';

export type EngineeringOverlayLayer = 'ports' | 'connections' | 'bounds' | 'routes';

const disposeObject = (object: THREE.Object3D) => object.traverse((child: any) => {
	child.geometry?.dispose?.();
	if (Array.isArray(child.material)) child.material.forEach((material: THREE.Material) => material.dispose());
	else child.material?.dispose?.();
});

/** 专业编辑的统一工程辅助图层；所有对象与 threejs-editor 共用同一 Scene 和工程坐标。 */
export class EngineeringOverlayManager {
	readonly root = new THREE.Group();
	private readonly groups = {
		ports: new THREE.Group(),
		connections: new THREE.Group(),
		bounds: new THREE.Group(),
	};
	private readonly visible: Record<Exclude<EngineeringOverlayLayer, 'routes'>, boolean> = { ports: false, connections: true, bounds: false };

	constructor(scene: THREE.Scene, private manifest: TwinSceneManifest, private readonly routeOverlay: ThreeEditorRouteOverlay) {
		this.root.name = 'IoTSharp Engineering Overlays';
		this.root.userData = { iotsharpTwinHelper: true, iotsharpEngineeringOverlay: true };
		this.groups.ports.name = 'Component Ports';
		this.groups.connections.name = 'Component Connections';
		this.groups.bounds.name = 'Component Body Bounds';
		this.root.add(this.groups.ports, this.groups.connections, this.groups.bounds);
		scene.add(this.root);
		this.rebuild(manifest);
	}

	rebuild(manifest = this.manifest) {
		this.manifest = manifest;
		for (const group of Object.values(this.groups)) {
			for (const child of [...group.children]) { group.remove(child); disposeObject(child); }
		}
		const portIndex = new Map<string, ReturnType<typeof resolveComponentPorts>[number]>();
		for (const object of manifest.objects as TwinV7SceneObjectDefinition[]) {
			if (!isComponentSceneObject(object)) continue;
			try {
				for (const port of resolveComponentPorts(object)) {
					portIndex.set(`${object.objectId}::${port.portId}`, port);
					const color = port.type === 'material-input' ? 0x38bdf8 : port.type === 'material-output' ? 0x22c55e : 0xf59e0b;
					const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
					marker.position.copy(port.worldPosition); marker.renderOrder = 1100;
					marker.userData = { iotsharpTwinHelper: true, componentObjectId: object.objectId, portId: port.portId };
					this.groups.ports.add(marker);
				}
				const body = resolveComponentBodyBounds(object);
				if (body) {
					const helper = new THREE.Box3Helper(body, 0xf59e0b);
					helper.userData = { iotsharpTwinHelper: true, componentObjectId: object.objectId };
					this.groups.bounds.add(helper);
				}
			} catch { /* 生成器诊断由属性面板与 Validator 展示。 */ }
		}
		for (const connection of manifest.connections || []) {
			const from = portIndex.get(`${connection.from.objectId}::${connection.from.portId}`);
			const to = portIndex.get(`${connection.to.objectId}::${connection.to.portId}`);
			if (!from || !to) continue;
			const line = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([from.worldPosition, to.worldPosition]),
				new THREE.LineBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.95 }),
			);
			line.renderOrder = 1050;
			line.userData = { iotsharpTwinHelper: true, connectionId: connection.connectionId };
			const marker = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }));
			marker.position.copy(from.worldPosition).lerp(to.worldPosition, 0.5);
			marker.rotation.x = Math.PI / 2;
			marker.renderOrder = 1051;
			marker.userData = { iotsharpTwinHelper: true, connectionId: connection.connectionId };
			this.groups.connections.add(line, marker);
		}
		for (const [layer, group] of Object.entries(this.groups)) group.visible = this.visible[layer as keyof typeof this.visible];
	}

	setVisible(layer: EngineeringOverlayLayer, visible: boolean) {
		if (layer === 'routes') { this.routeOverlay.setVisible(visible); return; }
		this.visible[layer] = visible;
		this.groups[layer].visible = visible;
	}

	dispose() {
		this.root.parent?.remove(this.root);
		disposeObject(this.root);
	}
}
