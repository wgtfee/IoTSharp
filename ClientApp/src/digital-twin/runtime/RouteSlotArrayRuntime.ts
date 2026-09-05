import * as THREE from 'three';
import type { TwinObjectBindingDefinition, TwinRouteDefinition, TwinSceneManifest, TwinTransportUnitType } from '/@/digital-twin/contracts';
import { parseRouteSlotArray, routeSlotProgress } from '/@/digital-twin/bindings/RouteSlotArray';
import { createComponentDefinitionFromTemplate, defaultComponentRegistry } from '/@/digital-twin/components';

interface RouteSlotEntity {
	key: string;
	bindingId: string;
	palletId: string;
	routeId: string;
	slotIndex: number;
	slotCount: number;
	currentProgress: number;
	targetProgress: number;
	transportUnitType: TwinTransportUnitType;
	resourceKey: string;
	root: THREE.Group;
}

interface RouteCurveInfo {
	route: TwinRouteDefinition;
	curve: THREE.Curve<THREE.Vector3>;
	loop: boolean;
}

/**
 * PLC/IoT 离散槽位数组运行时。
 * 例如 [12,23,0,0] 表示槽位 0/1 分别存在托盘 12/23，0 表示空位。
 * 数组索引只负责“位置事实”，不参与工艺推进和路径决策。
 */
export class RouteSlotArrayRuntime {
	private manifest: TwinSceneManifest;
	private readonly entities = new Map<string, RouteSlotEntity>();
	private readonly curves = new Map<string, RouteCurveInfo>();
	private readonly bindingRouteIds = new Map<string, string>();
	private readonly group = new THREE.Group();

	constructor(
		private readonly scene: THREE.Scene,
		manifest: TwinSceneManifest,
		private readonly reportError?: (message: string) => void,
	) {
		this.manifest = structuredClone(manifest);
		this.group.name = 'IoTSharp Route Slot Array Runtime';
		this.group.userData.iotsharpTwinHelper = false;
		this.scene.add(this.group);
		this.setManifest(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		this.manifest = structuredClone(manifest);
		this.curves.clear();
		this.bindingRouteIds.clear();
		for (const route of this.manifest.routes || []) {
			const info = this.createCurve(route);
			if (info) this.curves.set(route.routeId, info);
		}
		const activeBindings = new Set<string>();
		const authoritativeRouteIds = new Set<string>();
		for (const binding of this.manifest.bindings || []) {
			if (binding.enabled === false || binding.transform.kind !== 'routeSlotArray') continue;
			const routeId = this.resolveRouteId(binding);
			if (!routeId) continue;
			activeBindings.add(binding.bindingId);
			this.bindingRouteIds.set(binding.bindingId, routeId);
			authoritativeRouteIds.add(routeId);
		}
		if (this.manifest.runtime.dataMode === 'simulation') {
			for (const initializer of this.manifest.runtime.routePalletInitializers || []) {
				if (authoritativeRouteIds.has(initializer.routeId)) continue;
				const route = this.manifest.routes.find((item) => item.routeId === initializer.routeId);
				if (!route || !this.curves.has(route.routeId)) continue;
				const bindingId = this.simulationBindingId(route.routeId);
				activeBindings.add(bindingId);
				this.bindingRouteIds.set(bindingId, route.routeId);
			}
		}
		for (const entity of [...this.entities.values()]) {
			if (!activeBindings.has(entity.bindingId)) this.removeEntity(entity.key);
		}
		if (this.manifest.runtime.dataMode === 'simulation') this.applySimulationDefaults(authoritativeRouteIds);
	}

	private applySimulationDefaults(authoritativeRouteIds: Set<string>) {
		for (const initializer of this.manifest.runtime.routePalletInitializers || []) {
			if (authoritativeRouteIds.has(initializer.routeId)) continue;
			const route = this.manifest.routes.find((item) => item.routeId === initializer.routeId);
			if (!route) continue;
			const capacity = Math.max(0, route.edges.filter((edge) => edge.enabled !== false).reduce((sum, edge) => sum + Math.max(0, Number(edge.capacity) || 0), 0));
			if (capacity <= 0) continue;
			const count = THREE.MathUtils.clamp(Math.floor(Number(initializer.simulationDefaultCount) || 0), 0, capacity);
			const emptyValue = initializer.emptyValue ?? 0;
			const slots: unknown[] = Array.from({ length: capacity }, () => emptyValue);
			for (let index = 0; index < count; index += 1) slots[index] = `SIM-${initializer.routeId}-${index + 1}`;
			const bindingId = this.simulationBindingId(initializer.routeId);
			const binding: TwinObjectBindingDefinition = {
				bindingId,
				objectId: `simulation:${initializer.routeId}`,
				source: { kind: 'telemetry', key: initializer.telemetryKey },
				target: { kind: 'customProperty', property: `routeSlots:${initializer.routeId}` },
				transform: { kind: 'routeSlotArray', routeId: initializer.routeId, emptyValue },
				staleAfterMs: 0,
			};
			this.apply(binding, slots, false);
		}
	}

	private simulationBindingId(routeId: string) {
		return `simulation-route-slots:${routeId}`;
	}

	apply(binding: TwinObjectBindingDefinition, value: unknown, stale: boolean) {
		const routeId = this.bindingRouteIds.get(binding.bindingId) || this.resolveRouteId(binding);
		if (!routeId) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 未配置目标路线`);
			return;
		}
		const curveInfo = this.curves.get(routeId);
		if (!curveInfo) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 引用的路线 ${routeId} 不存在或不可绘制`);
			return;
		}
		const existing = [...this.entities.values()].filter((item) => item.bindingId === binding.bindingId);
		if (stale) {
			for (const entity of existing) entity.root.visible = false;
			return;
		}
		const config = binding.transform as Record<string, unknown>;
		let rawArray: unknown = value;
		if (typeof rawArray === 'string') {
			try { rawArray = JSON.parse(rawArray); } catch {
				this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 收到的值不是合法 JSON 数组`);
				return;
			}
		}
		if (!Array.isArray(rawArray)) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 需要 JSON 数组，实际收到 ${typeof value}`);
			return;
		}
		const emptyValue = config.emptyValue ?? 0;
		const slots = parseRouteSlotArray(rawArray, emptyValue);
		const activeKeys = new Set<string>();
		const transportUnitType = this.resolveTransportUnitType(curveInfo.route);
		const resourceKey = this.resolveTransportUnitResourceKey(curveInfo.route, transportUnitType);
		for (const slot of slots) {
			const key = `${binding.bindingId}:${slot.palletId}`;
			activeKeys.add(key);
			const progress = routeSlotProgress(slot.slotIndex, slot.slotCount, curveInfo.loop);
			let entity = this.entities.get(key);
			if (entity && (entity.transportUnitType !== transportUnitType || entity.resourceKey !== resourceKey)) {
				this.removeEntity(key);
				entity = undefined;
			}
			if (!entity) {
				entity = {
					key,
					bindingId: binding.bindingId,
					palletId: slot.palletId,
					routeId,
					slotIndex: slot.slotIndex,
					slotCount: rawArray.length,
					currentProgress: progress,
					targetProgress: progress,
					transportUnitType,
					resourceKey,
					root: this.createTransportUnitMesh(binding.bindingId, slot.palletId, transportUnitType, resourceKey),
				};
				this.entities.set(key, entity);
				this.group.add(entity.root);
			} else {
				entity.routeId = routeId;
				entity.slotIndex = slot.slotIndex;
				entity.slotCount = rawArray.length;
				entity.targetProgress = progress;
				entity.root.visible = true;
			}
			entity.root.userData.slotIndex = slot.slotIndex;
			entity.root.userData.slotCount = rawArray.length;
			this.applyPose(entity, curveInfo, entity.currentProgress);
		}
		for (const entity of existing) {
			if (!activeKeys.has(entity.key)) this.removeEntity(entity.key);
		}
	}

	tick(deltaSeconds: number) {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		const blend = 1 - Math.exp(-Math.min(deltaSeconds, 0.25) * 10);
		for (const entity of this.entities.values()) {
			if (!entity.root.visible) continue;
			const curveInfo = this.curves.get(entity.routeId);
			if (!curveInfo) continue;
			let delta = entity.targetProgress - entity.currentProgress;
			if (curveInfo.loop) {
				if (delta > 0.5) delta -= 1;
				else if (delta < -0.5) delta += 1;
			}
			entity.currentProgress += delta * blend;
			if (curveInfo.loop) entity.currentProgress = ((entity.currentProgress % 1) + 1) % 1;
			else entity.currentProgress = THREE.MathUtils.clamp(entity.currentProgress, 0, 1);
			this.applyPose(entity, curveInfo, entity.currentProgress);
		}
	}

	getEntityDetail(entityType: string, entityId: string): Record<string, unknown> | undefined {
		if (entityType !== 'route-slot-pallet') return undefined;
		const entity = [...this.entities.values()].find((item) => item.palletId === entityId);
		return entity ? {
			palletId: entity.palletId,
			routeId: entity.routeId,
			slotIndex: entity.slotIndex,
			slotNumber: entity.slotIndex + 1,
			slotCount: entity.slotCount,
			progress: entity.targetProgress,
			bindingId: entity.bindingId,
			transportUnitType: entity.transportUnitType,
			resourceKey: entity.resourceKey,
		} : undefined;
	}

	dispose() {
		for (const key of [...this.entities.keys()]) this.removeEntity(key);
		this.scene.remove(this.group);
		this.curves.clear();
		this.bindingRouteIds.clear();
	}

	private resolveRouteId(binding: TwinObjectBindingDefinition) {
		const config = binding.transform as Record<string, unknown>;
		const configured = String(config.routeId || '').trim();
		if (configured) return configured;
		const target = String(binding.target.path || binding.target.property || '').trim();
		return target.startsWith('routeSlots:') ? target.slice('routeSlots:'.length) : '';
	}

	private createCurve(route: TwinRouteDefinition): RouteCurveInfo | undefined {
		const vectors = (route.points || []).map((point) => new THREE.Vector3(point.position[0], point.position[1], point.position[2]));
		if (vectors.length < 2) return undefined;
		const loop = route.loop === true;
		let curve: THREE.Curve<THREE.Vector3>;
		if (route.curveKind === 'line' || vectors.length === 2) {
			const path = new THREE.CurvePath<THREE.Vector3>();
			for (let index = 1; index < vectors.length; index += 1) path.add(new THREE.LineCurve3(vectors[index - 1], vectors[index]));
			if (loop && vectors.length > 2) path.add(new THREE.LineCurve3(vectors[vectors.length - 1], vectors[0]));
			curve = path;
		} else {
			curve = new THREE.CatmullRomCurve3(vectors, loop, 'centripetal', 0.5);
		}
		return { route, curve, loop };
	}

	private resolveTransportUnitType(route: TwinRouteDefinition): TwinTransportUnitType {
		const explicit = route.edges.find((edge) => edge.enabled !== false && edge.transportUnitType)?.transportUnitType;
		if (explicit) return explicit;
		return route.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'large')
			? 'wooden-pallet'
			: 'plastic-pallet';
	}

	private resolveTransportUnitResourceKey(route: TwinRouteDefinition, transportUnitType: TwinTransportUnitType) {
		const explicit = route.edges.find((edge) => edge.enabled !== false && edge.transportUnitResourceKey)?.transportUnitResourceKey;
		if (explicit) return explicit;
		if (transportUnitType === 'carton') return 'builtin-carton';
		if (transportUnitType === 'wooden-pallet') return 'builtin-wooden-pallet';
		return 'builtin-plastic-pallet';
	}

	private createTransportUnitMesh(bindingId: string, palletId: string, transportUnitType: TwinTransportUnitType, resourceKey: string) {
		const displayName = transportUnitType === 'carton'
			? `PLC 纸箱 ${palletId}`
			: transportUnitType === 'wooden-pallet'
				? `PLC 木托盘 ${palletId}`
				: `PLC 小托盘 ${palletId}`;
		const definition = createComponentDefinitionFromTemplate(resourceKey, {
			objectId: `route-slot:${bindingId}:${palletId}`,
			name: displayName,
		});
		const built = defaultComponentRegistry.create(definition);
		const root = built.root;
		root.name = displayName;
		// 这是运行时物流实体，不是 Manifest 中的场景对象；选择时必须以实体身份为准。
		delete root.userData.twinObjectId;
		root.userData.twinEntityType = 'route-slot-pallet';
		root.userData.twinEntityId = palletId;
		root.userData.bindingId = bindingId;
		root.userData.transportUnitType = transportUnitType;
		root.userData.runtimeTransportUnit = true;
		root.userData.componentResourceKey = resourceKey;

		const label = this.createLabelSprite(palletId);
		if (label) root.add(label);
		return root;
	}

	private createLabelSprite(text: string) {
		if (typeof document === 'undefined') return undefined;
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 80;
		const context = canvas.getContext('2d');
		if (!context) return undefined;
		context.fillStyle = 'rgba(7,17,31,0.88)';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.strokeStyle = '#fbbf24';
		context.lineWidth = 4;
		context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
		context.fillStyle = '#fef3c7';
		context.font = 'bold 38px sans-serif';
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(text, canvas.width / 2, canvas.height / 2);
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
		const sprite = new THREE.Sprite(material);
		sprite.name = `托盘编号 ${text}`;
		sprite.position.set(0, 0.8, 0);
		sprite.scale.set(1.5, 0.48, 1);
		sprite.userData.twinEntityType = 'route-slot-pallet';
		sprite.userData.twinEntityId = text;
		return sprite;
	}

	private applyPose(entity: RouteSlotEntity, curveInfo: RouteCurveInfo, progress: number) {
		const normalized = curveInfo.loop ? ((progress % 1) + 1) % 1 : THREE.MathUtils.clamp(progress, 0, 1);
		const position = curveInfo.curve.getPointAt(normalized);
		entity.root.position.copy(position);
		if (curveInfo.route.orientToPath !== false) {
			const tangent = curveInfo.curve.getTangentAt(normalized);
			if (tangent.lengthSq() > 0.000001) entity.root.lookAt(position.clone().add(tangent));
		}
	}

	private removeEntity(key: string) {
		const entity = this.entities.get(key);
		if (!entity) return;
		entity.root.parent?.remove(entity.root);
		entity.root.traverse((object: any) => {
			object.geometry?.dispose?.();
			const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
			for (const material of materials) {
				material.map?.dispose?.();
				material.dispose?.();
			}
		});
		this.entities.delete(key);
	}
}
