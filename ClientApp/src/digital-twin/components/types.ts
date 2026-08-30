import * as THREE from 'three';

export type TwinComponentType =
	| 'roller-conveyor'
	| 'turn-conveyor-90'
	| 'diverter-conveyor'
	| 'merger-conveyor'
	| 'lift'
	| 'turntable'
	| 'external-inspection'
	| 'bagging-machine';

export type TwinComponentResourceType = 'procedural-component' | 'smart-model';
export type TwinComponentCapability =
	| 'material-flow'
	| 'capacity'
	| 'junction'
	| 'merger'
	| 'vertical-transfer'
	| 'rotation'
	| 'process-station'
	| 'plc-binding';

export type TwinComponentPortType = 'material-input' | 'material-output' | 'material-bidirectional';
export type TwinComponentPropertyEditor = 'number' | 'select' | 'boolean' | 'string';
export type TwinComponentPropertyCategory = 'geometry' | 'runtime' | 'connection' | 'process';
export type TwinBindingSlotDataType = 'bool' | 'int' | 'float' | 'string';
export type TwinBindingSlotDirection = 'input' | 'output';
export type TwinBindingSlotSemantic =
	| 'ready' | 'busy' | 'complete' | 'fault' | 'result'
	| 'route-code' | 'target-position' | 'actual-position' | 'in-position'
	| 'sensor' | 'command' | 'custom';

export interface TwinComponentTransform {
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

export interface TwinComponentDefinition {
	objectId: string;
	name: string;
	resourceKey: string;
	componentType: TwinComponentType;
	generator: string;
	generatorVersion: number;
	resourceId?: string;
	/** @deprecated 使用 generatorVersion；仅保留旧调用方编译兼容。 */
	resourceVersion?: number;
	properties: Record<string, unknown>;
	transform?: TwinComponentTransform;
	sectionId?: string;
	routeEdgeId?: string;
}

export interface TwinComponentPortDefinition {
	portId: string;
	name: string;
	type: TwinComponentPortType;
	localPosition: [number, number, number];
	localDirection: [number, number, number];
	metadata?: Record<string, unknown>;
}

export interface TwinResolvedComponentPort extends TwinComponentPortDefinition {
	worldPosition: THREE.Vector3;
	worldDirection: THREE.Vector3;
}

export interface TwinComponentPropertySchema {
	key: string;
	label: string;
	type: TwinComponentPropertyEditor;
	category: TwinComponentPropertyCategory;
	defaultValue: unknown;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: Array<{ label: string; value: unknown }>;
	description?: string;
}

export interface TwinComponentBindingSlot {
	slotId: string;
	name: string;
	description?: string;
	direction: TwinBindingSlotDirection;
	dataType: TwinBindingSlotDataType;
	required?: boolean;
	semantic: TwinBindingSlotSemantic;
}

export interface TwinComponentTemplate {
	resourceKey: string;
	name: string;
	resourceType: TwinComponentResourceType;
	componentType: TwinComponentType;
	generator: string;
	generatorVersion: number;
	category: 'conveyor' | 'transfer' | 'process';
	tags: string[];
	capabilities: TwinComponentCapability[];
	defaultProperties: Record<string, unknown>;
	propertySchema: TwinComponentPropertySchema[];
	bindingSlots?: TwinComponentBindingSlot[];
}

export interface TwinComponentBuildContext {
	definition: TwinComponentDefinition;
}

export interface TwinComponentBuildResult {
	root: THREE.Group;
	ports: TwinComponentPortDefinition[];
	bounds: THREE.Box3;
	dispose: () => void;
}

export interface TwinComponentGenerator {
	readonly componentType: TwinComponentType;
	readonly generator: string;
	readonly generatorVersion: number;
	create(context: TwinComponentBuildContext): TwinComponentBuildResult;
}

export const numberProperty = (
	key: string,
	label: string,
	defaultValue: number,
	category: TwinComponentPropertyCategory,
	options: Partial<TwinComponentPropertySchema> = {},
): TwinComponentPropertySchema => ({
	key,
	label,
	type: 'number',
	category,
	defaultValue,
	...options,
});

export const selectProperty = (
	key: string,
	label: string,
	defaultValue: unknown,
	category: TwinComponentPropertyCategory,
	options: Array<{ label: string; value: unknown }>,
): TwinComponentPropertySchema => ({
	key,
	label,
	type: 'select',
	category,
	defaultValue,
	options,
});

export const booleanProperty = (
	key: string,
	label: string,
	defaultValue: boolean,
	category: TwinComponentPropertyCategory,
): TwinComponentPropertySchema => ({
	key,
	label,
	type: 'boolean',
	category,
	defaultValue,
});
