import type { TwinComponentPropertySchema, TwinComponentType } from '../components/types';

export type ComponentStudioMode = 'design' | 'preview' | 'test';
export type StudioPrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'plane' | 'glb' | 'component';
export type StudioCollisionKind = 'box' | 'sphere' | 'cylinder';
export type StudioAnimationKind = 'rotate' | 'visibility' | 'color';
export type StudioAxis = 'x' | 'y' | 'z';
export type StudioVector3 = [number, number, number];

export interface StudioGeneratedNodeTransform {
	position: StudioVector3;
	rotation: StudioVector3;
	scale: StudioVector3;
}

/**
 * Non-destructive processing overrides for a generated V7 component.
 * These values belong to the Component Studio draft and never mutate the
 * built-in template or the ComponentRegistry generator implementation.
 */
export interface StudioStructuralOverrides {
	hiddenNodeKeys: string[];
	nodeTransforms: Record<string, StudioGeneratedNodeTransform>;
}

export interface StudioGeneratedNodeInfo {
	partId: string;
	nodeKey: string;
	name: string;
	type: 'Group' | 'Mesh' | 'InstancedMesh' | 'Instance' | 'Object3D';
	depth: number;
	hidden: boolean;
	canTransform: boolean;
	instanceIndex?: number;
	transform?: StudioGeneratedNodeTransform;
}

export interface StudioTransform {
	position: StudioVector3;
	rotation: StudioVector3;
	scale: StudioVector3;
}

export interface StudioGeometry {
	width: number;
	height: number;
	depth: number;
	radius: number;
	radiusTop: number;
	radiusBottom: number;
	segments: number;
}

export interface StudioMaterial {
	color: string;
	opacity: number;
	metalness: number;
	roughness: number;
}

export interface StudioPartDefinition {
	id: string;
	name: string;
	kind: StudioPrimitiveKind;
	transform: StudioTransform;
	geometry: StudioGeometry;
	material: StudioMaterial;
	source?: {
		fileName?: string;
		fileSize?: number;
		transient?: boolean;
		component?: {
			resourceKey: string;
			resourceId?: string;
			componentType: TwinComponentType;
			generator: string;
			generatorVersion: number;
			properties: Record<string, unknown>;
			propertySchema: TwinComponentPropertySchema[];
			structuralOverrides?: StudioStructuralOverrides;
		};
	};
}

export interface StudioPortDefinition {
	id: string;
	name: string;
	type: 'material-input' | 'material-output' | 'material-bidirectional' | 'control' | 'sensor' | 'mechanical';
	position: StudioVector3;
	direction: StudioVector3;
	color: string;
}

export interface StudioCollisionDefinition {
	id: string;
	name: string;
	kind: StudioCollisionKind;
	position: StudioVector3;
	size: StudioVector3;
	radius: number;
	height: number;
}

export interface StudioTelemetryCapability {
	id: string;
	name: string;
	key: string;
	target: 'run' | 'alarm' | 'visible' | 'speed' | 'color';
	description: string;
}

export interface StudioAnimationDefinition {
	id: string;
	name: string;
	targetPartId: string;
	kind: StudioAnimationKind;
	axis: StudioAxis;
	speed: number;
}

export interface ComponentStudioDefinition {
	schemaVersion: 'iotsharp-component-studio/v1';
	componentId: string;
	resourceKey: string;
	name: string;
	category: string;
	description: string;
	status: 'Draft' | 'Published';
	revision: number;
	publishedVersion: number;
	parts: StudioPartDefinition[];
	ports: StudioPortDefinition[];
	collisions: StudioCollisionDefinition[];
	telemetry: StudioTelemetryCapability[];
	animations: StudioAnimationDefinition[];
}

export interface ComponentStudioRuntimeState {
	run: boolean;
	alarm: boolean;
	visible: boolean;
	speedMultiplier: number;
}

export interface ComponentStudioHelperState {
	ports: boolean;
	collisions: boolean;
	origin: boolean;
	grid: boolean;
}

const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

export const createStudioPart = (kind: StudioPrimitiveKind, index = 0): StudioPartDefinition => {
	const isPlane = kind === 'plane';
	return {
		id: id('part'),
		name: kind === 'box' ? `立方体 ${index + 1}` : kind === 'cylinder' ? `圆柱体 ${index + 1}` : kind === 'sphere' ? `球体 ${index + 1}` : kind === 'plane' ? `平面 ${index + 1}` : kind === 'component' ? `V7 组件 ${index + 1}` : `GLB ${index + 1}`,
		kind,
		transform: { position: [0, isPlane ? 0.01 : 0.5, 0], rotation: isPlane ? [-90, 0, 0] : [0, 0, 0], scale: [1, 1, 1] },
		geometry: { width: 2, height: 1, depth: 1.2, radius: 0.5, radiusTop: 0.5, radiusBottom: 0.5, segments: 32 },
		material: { color: kind === 'cylinder' ? '#64748b' : kind === 'sphere' ? '#0ea5e9' : kind === 'plane' ? '#334155' : '#2563eb', opacity: 1, metalness: 0.18, roughness: 0.62 },
	};
};

export const createBlankComponentStudioDefinition = (): ComponentStudioDefinition => {
	const body = createStudioPart('box', 0);
	body.name = '主体';
	return {
		schemaVersion: 'iotsharp-component-studio/v1',
		componentId: id('component'),
		resourceKey: `custom-component-${Date.now()}`,
		name: '新建工业组件',
		category: 'custom',
		description: '在浏览器中由 IoTSharp Component Studio 创建的可复用组件。',
		status: 'Draft',
		revision: 0,
		publishedVersion: 0,
		parts: [body],
		ports: [
			{ id: id('port'), name: 'IN', type: 'material-input', position: [-1, 0.5, 0], direction: [-1, 0, 0], color: '#22c55e' },
			{ id: id('port'), name: 'OUT', type: 'material-output', position: [1, 0.5, 0], direction: [1, 0, 0], color: '#38bdf8' },
		],
		collisions: [{ id: id('collision'), name: '主体碰撞体', kind: 'box', position: [0, 0.5, 0], size: [2, 1, 1.2], radius: 0.5, height: 1 }],
		telemetry: [
			{ id: id('telemetry'), name: '运行状态', key: 'Run', target: 'run', description: '运行测试时驱动组件动画。' },
			{ id: id('telemetry'), name: '报警状态', key: 'Alarm', target: 'alarm', description: '报警时以红色高亮组件。' },
		],
		animations: [{ id: id('animation'), name: '主体旋转测试', targetPartId: body.id, kind: 'rotate', axis: 'y', speed: 30 }],
	};
};

export const cloneComponentStudioDefinition = (value: ComponentStudioDefinition): ComponentStudioDefinition => JSON.parse(JSON.stringify(value)) as ComponentStudioDefinition;

export const cloneStudioPartForPaste = (part: StudioPartDefinition, offset: StudioVector3 = [0.3, 0, 0.3]): StudioPartDefinition => {
	const clone = JSON.parse(JSON.stringify(part)) as StudioPartDefinition;
	clone.id = id('part');
	clone.name = /副本(?:\s+\d+)?$/.test(clone.name) ? clone.name : `${clone.name} 副本`;
	clone.transform.position = [
		Number((clone.transform.position[0] + offset[0]).toFixed(3)),
		Number((clone.transform.position[1] + offset[1]).toFixed(3)),
		Number((clone.transform.position[2] + offset[2]).toFixed(3)),
	];
	return clone;
};

export const cloneStudioPartsForPaste = (parts: StudioPartDefinition[], offset: StudioVector3 = [0.3, 0, 0.3]): StudioPartDefinition[] =>
	parts.map((part) => cloneStudioPartForPaste(part, offset));

export const createComponentStudioId = id;
