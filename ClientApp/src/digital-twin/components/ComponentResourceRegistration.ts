import { builtInComponentTemplates } from './BuiltInComponentCatalog';

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
	defaultProperties: Record<string, unknown>;
	componentSchema: unknown;
}

/**
 * 可直接用于后端 ModelResource Seed / 新增 Component Resource API 的内置注册数据。
 * 这里不负责发 HTTP，避免前端在每次启动时重复向数据库插入资源。
 */
export const builtInComponentResourceRegistrations: TwinComponentResourceRegistrationPayload[] = builtInComponentTemplates.map((template) => ({
	resourceKey: template.resourceKey,
	name: template.name,
	resourceType: template.resourceType,
	componentType: template.componentType,
	generator: template.generator,
	generatorVersion: template.generatorVersion,
	category: template.category,
	tags: [...template.tags],
	capabilities: [...template.capabilities],
	defaultProperties: { ...template.defaultProperties },
	componentSchema: {
		properties: template.propertySchema.map((property) => ({ ...property })),
	},
}));

export const getBuiltInComponentRegistration = (resourceKey: string) =>
	builtInComponentResourceRegistrations.find((item) => item.resourceKey === resourceKey);
