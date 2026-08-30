import { builtInComponentTemplates } from './BuiltInComponentCatalog';
import { defaultComponentRegistry } from './ComponentRegistry';

export interface TwinComponentResourceRegistrationPayload {
	resourceKey: string;
	name: string;
	resourceType: 'procedural-component' | 'smart-model';
	componentType: string;
	generator: string;
	generatorVersion: number;
	category: string;
	tags: string[];
	capabilities: string[];
	bindingSlots: unknown[];
	defaultProperties: Record<string, unknown>;
	componentSchema: unknown;
	ports: Array<{
		portId: string;
		name: string;
		type: string;
		localPosition: [number, number, number];
		localDirection: [number, number, number];
	}>;
}

/**
 * 可直接用于后端 ModelResource Seed / 新增 Component Resource API 的内置注册数据。
 * 这里不负责发 HTTP，避免前端在每次启动时重复向数据库插入资源。
 */
export const builtInComponentResourceRegistrations: TwinComponentResourceRegistrationPayload[] = builtInComponentTemplates.map((template) => {
	const built = defaultComponentRegistry.create({
		objectId: `resource-preview-${template.resourceKey}`,
		name: template.name,
		resourceKey: template.resourceKey,
		componentType: template.componentType,
		generator: template.generator,
		generatorVersion: template.generatorVersion,
		resourceId: template.resourceKey,
		resourceVersion: template.generatorVersion,
		properties: { ...template.defaultProperties },
		transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
	});
	try {
		return {
			resourceKey: template.resourceKey,
			name: template.name,
			resourceType: template.resourceType,
			componentType: template.componentType,
			generator: template.generator,
			generatorVersion: template.generatorVersion,
			category: template.category,
			tags: [...template.tags],
			capabilities: [...template.capabilities],
			bindingSlots: structuredClone(template.bindingSlots || []),
			defaultProperties: { ...template.defaultProperties },
			componentSchema: {
				properties: template.propertySchema.map((property) => ({ ...property })),
			},
			ports: built.ports.map((port) => ({
				portId: port.portId,
				name: port.name,
				type: port.type,
				localPosition: [...port.localPosition] as [number, number, number],
				localDirection: [...port.localDirection] as [number, number, number],
			})),
		};
	} finally {
		built.dispose();
	}
});

export const getBuiltInComponentRegistration = (resourceKey: string) =>
	builtInComponentResourceRegistrations.find((item) => item.resourceKey === resourceKey);
