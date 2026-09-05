import * as THREE from 'three';
import type { TwinDataUpdate } from '/@/api/digital-twin';
import type { TwinObjectBindingDefinition, TwinSceneManifest } from '/@/digital-twin/contracts';

interface MaterialSnapshot {
	color?: number;
	emissive?: number;
	opacity: number;
	transparent: boolean;
}

/**
 * 运行态白名单绑定引擎。场景只能声明固定转换器，不能提交 JavaScript 表达式。
 */
export class BindingEngine {
	private bindings = new Map<string, TwinObjectBindingDefinition>();
	private readonly lastTimestamps = new Map<string, number>();
	private readonly materialSnapshots = new WeakMap<object, MaterialSnapshot>();
	private readonly animatedObjects = new Map<any, { axis: 'x' | 'y' | 'z'; speed: number }>();

	constructor(
		manifest: TwinSceneManifest,
		private readonly resolveObject: (objectId: string) => any,
		private readonly correctRouteProgress: (progress: number) => void,
		private readonly reportError?: (message: string) => void,
		private readonly applyRouteSignal?: (bindingId: string, value: unknown, stale: boolean) => void,
		private readonly applyRouteSlotArray?: (binding: TwinObjectBindingDefinition, value: unknown, stale: boolean) => void,
		private readonly applyRouteDistance?: (binding: TwinObjectBindingDefinition, object: any, distanceMeters: number) => void,
	) {
		this.setManifest(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		this.bindings = new Map((manifest.bindings ?? []).filter((binding) => binding.enabled !== false).map((binding) => [binding.bindingId, binding]));
		this.lastTimestamps.clear();
		this.animatedObjects.clear();
	}

	apply(updates: TwinDataUpdate[]) {
		for (const update of updates) {
			const binding = this.bindings.get(update.bindingKey);
			if (!binding) continue;
			const timestamp = Date.parse(update.sourceTimestamp || '') || 0;
			if (timestamp < (this.lastTimestamps.get(binding.bindingId) ?? 0)) continue;
			this.lastTimestamps.set(binding.bindingId, timestamp);
			try {
				this.applyBinding(binding, update);
			} catch (error) {
				this.reportError?.(`绑定 ${binding.bindingId} 应用失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	tick(deltaSeconds: number) {
		for (const [object, animation] of this.animatedObjects) object.rotation[animation.axis] += animation.speed * deltaSeconds;
	}

	dispose() {
		this.bindings.clear();
		this.lastTimestamps.clear();
		this.animatedObjects.clear();
	}

	private applyBinding(binding: TwinObjectBindingDefinition, update: TwinDataUpdate) {
		if (binding.transform.kind === 'routeSlotArray') {
			this.applyRouteSlotArray?.(binding, update.value, update.stale || update.quality === 'bad' || update.quality === 'missing');
			return;
		}
		if (binding.transform.kind === 'routeEvent') {
			this.applyRouteSignal?.(binding.bindingId, update.value, update.stale || update.quality === 'bad' || update.quality === 'missing');
			return;
		}
		const root = this.resolveObject(binding.objectId);
		if (!root) return;
		if (binding.transform.kind === 'routeDistance' || binding.target.kind === 'routeDistance') {
			if (update.stale || update.quality === 'bad' || update.quality === 'missing') {
				this.applyStaleStyle(root);
				return;
			}
			this.restoreMaterialStyle(root);
			this.applyRouteDistance?.(binding, root, Number(this.transform(binding, update.value)));
			return;
		}
		const target = this.resolveNode(root, binding.nodePath) ?? root;
		if (update.stale || update.quality === 'bad' || update.quality === 'missing') {
			this.applyStaleStyle(target);
			return;
		}
		this.restoreMaterialStyle(target);
		const transformed = this.transform(binding, update.value);
		switch (binding.target.kind) {
			case 'visible':
				target.visible = Boolean(transformed);
				break;
			case 'color':
			case 'emissive':
				this.applyMaterialColor(target, String(transformed), binding.target.kind);
				break;
			case 'opacity':
				this.applyOpacity(target, Number(transformed));
				break;
			case 'position':
			case 'rotation':
			case 'scale':
				this.applyVectorValue(target, binding.target.kind, binding.target.property, transformed);
				break;
			case 'animation': {
				const config = binding.transform as Record<string, unknown>;
				const axis = this.axisFromProperty(binding.target.property);
				const speedConfig = (Boolean(update.value) ? config.trueValue : config.falseValue) as { speed?: unknown } | undefined;
				const configuredSpeed = Number(speedConfig?.speed);
				const speed = Number.isFinite(configuredSpeed) ? configuredSpeed : Number(transformed) || 0;
				if (speed === 0) this.animatedObjects.delete(target);
				else this.animatedObjects.set(target, { axis, speed });
				break;
			}
			case 'routeProgress':
				this.correctRouteProgress(Number(transformed));
				break;
			case 'text':
			case 'number':
			case 'customProperty':
				target.userData[binding.target.property || binding.bindingId] = transformed;
				break;
		}
	}

	private transform(binding: TwinObjectBindingDefinition, value: unknown): unknown {
		const config = binding.transform as Record<string, any>;
		switch (binding.transform.kind) {
			case 'booleanVisibility':
				return Boolean(value);
			case 'booleanColor':
				return Boolean(value) ? config.trueColor || '#22c55e' : config.falseColor || '#ef4444';
			case 'rangeColor': {
				const number = Number(value);
				const stops = Array.isArray(config.stops) ? [...config.stops].sort((left, right) => Number(left.max) - Number(right.max)) : [];
				return stops.find((stop) => number <= Number(stop.max))?.color || config.defaultColor || '#38bdf8';
			}
			case 'numberScale':
			case 'numberRotation':
				return Math.min(Number(config.max ?? Number.POSITIVE_INFINITY), Math.max(Number(config.min ?? Number.NEGATIVE_INFINITY), Number(value) * Number(config.factor ?? 1)));
			case 'enumMap':
				return config.map?.[String(value)] ?? config.defaultValue ?? value;
			case 'formatText':
				return String(config.template || '{value}').replace('{value}', String(value ?? ''));
			case 'alarmSeverityStyle': {
				const severity = typeof value === 'object' && value ? String((value as Record<string, unknown>).severity ?? '') : String(value ?? '');
				return config.map?.[severity] ?? config.defaultColor ?? '#f59e0b';
			}
			case 'booleanAnimation':
				return Boolean(value) ? Number(config.trueValue?.speed ?? 1) : Number(config.falseValue?.speed ?? 0);
			case 'routeProgress':
			case 'routeDistance':
				return Number(value) * Number(config.factor ?? 1) + Number(config.offset ?? 0);
			default:
				return value;
		}
	}

	private resolveNode(root: any, path?: string) {
		if (!path) return root;
		const names = path.split('/').filter(Boolean);
		let current = root;
		if (names[0] === root.name) names.shift();
		for (const name of names) {
			const next = current.children?.find((child: any) => child.name === name);
			if (!next) return undefined;
			current = next;
		}
		return current;
	}

	private applyStaleStyle(target: any) {
		this.forEachMaterial(target, (material) => {
			this.captureMaterial(material);
			material.color?.set?.('#64748b');
			material.emissive?.set?.('#111827');
			material.opacity = Math.min(material.opacity ?? 1, 0.72);
			material.transparent = true;
			material.needsUpdate = true;
		});
	}

	private restoreMaterialStyle(target: any) {
		this.forEachMaterial(target, (material) => {
			const snapshot = this.materialSnapshots.get(material);
			if (!snapshot) return;
			if (snapshot.color !== undefined) material.color?.setHex?.(snapshot.color);
			if (snapshot.emissive !== undefined) material.emissive?.setHex?.(snapshot.emissive);
			material.opacity = snapshot.opacity;
			material.transparent = snapshot.transparent;
			material.needsUpdate = true;
		});
	}

	private applyMaterialColor(target: any, color: string, kind: 'color' | 'emissive') {
		this.forEachMaterial(target, (material) => {
			this.captureMaterial(material);
			material[kind]?.set?.(new THREE.Color(color));
			material.needsUpdate = true;
		});
	}

	private applyOpacity(target: any, value: number) {
		const opacity = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
		this.forEachMaterial(target, (material) => {
			this.captureMaterial(material);
			material.opacity = opacity;
			material.transparent = opacity < 1;
			material.needsUpdate = true;
		});
	}

	private applyVectorValue(target: any, kind: 'position' | 'rotation' | 'scale', property: string | undefined, value: unknown) {
		const vector = target[kind];
		const axis = this.axisFromProperty(property);
		if (Array.isArray(value) && value.length === 3) vector.set(Number(value[0]), Number(value[1]), Number(value[2]));
		else vector[axis] = Number(value) || 0;
	}

	private forEachMaterial(target: any, handler: (material: any) => void) {
		target.traverse?.((object: any) => {
			const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
			materials.forEach(handler);
		});
	}

	private captureMaterial(material: any) {
		if (this.materialSnapshots.has(material)) return;
		this.materialSnapshots.set(material, {
			color: material.color?.getHex?.(),
			emissive: material.emissive?.getHex?.(),
			opacity: material.opacity ?? 1,
			transparent: Boolean(material.transparent),
		});
	}

	private axisFromProperty(property?: string): 'x' | 'y' | 'z' {
		const axis = property?.split('.').pop()?.toLowerCase();
		return axis === 'x' || axis === 'z' ? axis : 'y';
	}
}
