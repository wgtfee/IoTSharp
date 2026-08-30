import { defaultComponentRegistry } from './ComponentRegistry';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';
import type { TwinComponentBuildResult, TwinComponentDefinition, TwinComponentTransform } from './types';

const identityTransform = (): TwinComponentTransform => ({
	position: [0, 0, 0],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
});

export const createComponentDefinitionFromTemplate = (
	resourceKey: string,
	options: {
		objectId: string;
		name?: string;
		properties?: Record<string, unknown>;
		transform?: TwinComponentTransform;
		sectionId?: string;
		routeEdgeId?: string;
		resourceVersion?: number;
	},
): TwinComponentDefinition => {
	const template = getBuiltInComponentTemplate(resourceKey);
	if (!template) throw new Error(`未找到内置数字孪生组件模板: ${resourceKey}`);
	return {
		objectId: options.objectId,
		name: options.name || template.name,
		resourceKey: template.resourceKey,
		componentType: template.componentType,
		generator: template.generator,
		generatorVersion: options.resourceVersion ?? template.generatorVersion,
		resourceId: template.resourceKey,
		resourceVersion: options.resourceVersion ?? template.generatorVersion,
		properties: {
			...template.defaultProperties,
			...(options.properties || {}),
		},
		transform: options.transform || identityTransform(),
		sectionId: options.sectionId,
		routeEdgeId: options.routeEdgeId,
	};
};

export const buildComponentFromTemplate = (
	resourceKey: string,
	options: Parameters<typeof createComponentDefinitionFromTemplate>[1],
): TwinComponentBuildResult => defaultComponentRegistry.create(
	createComponentDefinitionFromTemplate(resourceKey, options),
);
