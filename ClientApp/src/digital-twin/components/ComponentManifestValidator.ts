import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { defaultComponentRegistry } from './ComponentRegistry';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';
import { areComponentPortsCompatible, isComponentSceneObject, resolveComponentPorts, type TwinComponentPortRef } from './ComponentConnectionEngine';

const CONNECTION_DISTANCE_TOLERANCE = 0.08;
const CONNECTION_FACING_DOT = -Math.cos(15 * Math.PI / 180);

export const validateV7ComponentManifest = (manifest: TwinSceneManifest): TwinValidationDiagnostic[] => {
	const diagnostics: TwinValidationDiagnostic[] = [];
	const objects = manifest.objects as TwinV7SceneObjectDefinition[];
	const objectIds = new Set(objects.map((item) => item.objectId));
	const portsByObject = new Map<string, Set<string>>();
	const portRefsByObject = new Map<string, Map<string, TwinComponentPortRef>>();
	const sectionIds = new Set<string>();

	objects.forEach((object, index) => {
		if (object.kind !== 'component') return;
		const path = `objects[${index}].component`;
		if (!object.component) {
			diagnostics.push({ severity: 'error', code: 'twin.component.definition.required', message: 'Component 对象必须包含 component 定义。', path });
			return;
		}
		if (!object.component.resourceKey) diagnostics.push({ severity: 'error', code: 'twin.component.resource-key.required', message: '组件 resourceKey 不能为空。', path: `${path}.resourceKey` });
		if (!object.resourceId) diagnostics.push({ severity: 'error', code: 'twin.component.resource.required', message: '组件必须先注册到数据库模型资源库并绑定 resourceId。', path: `objects[${index}].resourceId` });
		if (!object.component.componentType || !defaultComponentRegistry.has(object.component.componentType)) diagnostics.push({ severity: 'error', code: 'twin.component.type.unsupported', message: `不支持的 componentType：${object.component.componentType || '(empty)'}`, path: `${path}.componentType` });
		if (!object.component.generator) diagnostics.push({ severity: 'error', code: 'twin.component.generator.required', message: '组件 generator 不能为空。', path: `${path}.generator` });
		if (!Number.isInteger(object.component.generatorVersion) || object.component.generatorVersion <= 0) diagnostics.push({ severity: 'error', code: 'twin.component.generator-version.invalid', message: 'generatorVersion 必须是正整数。', path: `${path}.generatorVersion` });
		if (!object.component.properties || typeof object.component.properties !== 'object' || Array.isArray(object.component.properties)) diagnostics.push({ severity: 'error', code: 'twin.component.properties.invalid', message: '组件 properties 必须是对象。', path: `${path}.properties` });
		const template = getBuiltInComponentTemplate(object.component.resourceKey);
		if (!template) diagnostics.push({ severity: 'error', code: 'twin.component.resource-key.unsupported', message: `未注册组件模板：${object.component.resourceKey}`, path: `${path}.resourceKey` });
		else {
			if (object.component.componentType !== template.componentType) diagnostics.push({ severity: 'error', code: 'twin.component.type.mismatch', message: `componentType 必须与资源模板 ${template.componentType} 一致。`, path: `${path}.componentType` });
			if (object.component.generator !== template.generator) diagnostics.push({ severity: 'error', code: 'twin.component.generator.mismatch', message: `generator 必须与资源模板 ${template.generator} 一致。`, path: `${path}.generator` });
			if (object.component.generatorVersion !== template.generatorVersion) diagnostics.push({ severity: 'error', code: 'twin.component.generator-version.mismatch', message: `generatorVersion 必须固定为资源版本 ${template.generatorVersion}。`, path: `${path}.generatorVersion` });
			for (const field of template.propertySchema) {
				const value = object.component.properties?.[field.key] ?? field.defaultValue;
				const fieldPath = `${path}.properties.${field.key}`;
				if (field.type === 'number') {
					const numeric = Number(value);
					if (!Number.isFinite(numeric)) diagnostics.push({ severity: 'error', code: 'twin.component.property.number', message: `${field.label}必须是有限数值。`, path: fieldPath });
					else if ((field.min !== undefined && numeric < field.min) || (field.max !== undefined && numeric > field.max)) diagnostics.push({ severity: 'error', code: 'twin.component.property.range', message: `${field.label}超出允许范围 ${field.min ?? '-∞'}～${field.max ?? '+∞'}。`, path: fieldPath });
				} else if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) diagnostics.push({ severity: 'error', code: 'twin.component.property.option', message: `${field.label}不是受支持的选项。`, path: fieldPath });
				else if (field.type === 'boolean' && typeof value !== 'boolean') diagnostics.push({ severity: 'error', code: 'twin.component.property.boolean', message: `${field.label}必须是布尔值。`, path: fieldPath });
			}
		}
		if (object.component.sectionId) {
			if (sectionIds.has(object.component.sectionId)) diagnostics.push({ severity: 'error', code: 'twin.component.section.duplicate', message: `Section ID ${object.component.sectionId} 不能重复。`, path: `${path}.sectionId` });
			sectionIds.add(object.component.sectionId);
		}
		if (object.transform.scale.some((value) => Math.abs(value - 1) > 0.000001)) diagnostics.push({ severity: 'error', code: 'twin.component.scale.locked', message: '参数化组件 Scale 必须保持 1,1,1；尺寸只能通过属性修改。', path: `objects[${index}].transform.scale` });
		try {
			const ports = resolveComponentPorts(object);
			portsByObject.set(object.objectId, new Set(ports.map((port) => port.portId)));
			portRefsByObject.set(object.objectId, new Map(ports.map((port) => [port.portId, port])));
		}
		catch (error) { diagnostics.push({ severity: 'error', code: 'twin.component.build.failed', message: error instanceof Error ? error.message : String(error), path }); }
	});

	const connectionIds = new Set<string>();
	const occupiedPorts = new Set<string>();
	for (const [index, connection] of (manifest.connections || []).entries()) {
		const path = `connections[${index}]`;
		if (!connection.connectionId || connectionIds.has(connection.connectionId)) diagnostics.push({ severity: 'error', code: 'twin.connection.id.invalid', message: 'connectionId 不能为空且必须唯一。', path: `${path}.connectionId` });
		connectionIds.add(connection.connectionId);
		if (connection.from.objectId === connection.to.objectId && connection.from.portId === connection.to.portId) diagnostics.push({ severity: 'error', code: 'twin.connection.self.invalid', message: '连接的起点和终点不能是同一个端口。', path });
		for (const [side, endpoint] of [['from', connection.from], ['to', connection.to]] as const) {
			if (!objectIds.has(endpoint.objectId)) diagnostics.push({ severity: 'error', code: 'twin.connection.object.missing', message: `连接引用了不存在的对象 ${endpoint.objectId}。`, path: `${path}.${side}.objectId` });
			const ports = portsByObject.get(endpoint.objectId);
			if (ports && !ports.has(endpoint.portId)) diagnostics.push({ severity: 'error', code: 'twin.connection.port.missing', message: `对象 ${endpoint.objectId} 不存在端口 ${endpoint.portId}。`, path: `${path}.${side}.portId` });
			const key = `${endpoint.objectId}::${endpoint.portId}`;
			if (occupiedPorts.has(key)) diagnostics.push({ severity: 'error', code: 'twin.connection.port.duplicate', message: `物理端口 ${endpoint.portId} 已经被其他 Connection 占用。`, path: `${path}.${side}` });
			occupiedPorts.add(key);
		}
		const from = portRefsByObject.get(connection.from.objectId)?.get(connection.from.portId);
		const to = portRefsByObject.get(connection.to.objectId)?.get(connection.to.portId);
		if (from && to) {
			if (!areComponentPortsCompatible(from, to)) diagnostics.push({ severity: 'error', code: 'twin.connection.compatibility.invalid', message: 'Connection 的端口方向或输送对象类型不兼容。', path });
			if (from.worldPosition.distanceTo(to.worldPosition) > CONNECTION_DISTANCE_TOLERANCE) diagnostics.push({ severity: 'error', code: 'twin.connection.position.detached', message: 'Connection 两端口已经分离，请重新吸附或断开连接。', path });
			if (from.worldDirection.dot(to.worldDirection) > CONNECTION_FACING_DOT) diagnostics.push({ severity: 'error', code: 'twin.connection.direction.invalid', message: 'Connection 两端口方向必须在 15°容差内相向。', path });
		}
	}
	return diagnostics;
};
