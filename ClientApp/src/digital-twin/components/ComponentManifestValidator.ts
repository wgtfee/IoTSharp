import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { defaultComponentRegistry } from './ComponentRegistry';
import { isComponentSceneObject, resolveComponentPorts } from './ComponentConnectionEngine';

export const validateV7ComponentManifest = (manifest: TwinSceneManifest): TwinValidationDiagnostic[] => {
	const diagnostics: TwinValidationDiagnostic[] = [];
	const objects = manifest.objects as TwinV7SceneObjectDefinition[];
	const objectIds = new Set(objects.map((item) => item.objectId));
	const portsByObject = new Map<string, Set<string>>();

	objects.forEach((object, index) => {
		if (object.kind !== 'component') return;
		const path = `objects[${index}].component`;
		if (!object.component) {
			diagnostics.push({ severity: 'error', code: 'twin.component.definition.required', message: 'Component 对象必须包含 component 定义。', path });
			return;
		}
		if (!object.component.resourceKey) diagnostics.push({ severity: 'error', code: 'twin.component.resource-key.required', message: '组件 resourceKey 不能为空。', path: `${path}.resourceKey` });
		if (!object.component.componentType || !defaultComponentRegistry.has(object.component.componentType)) diagnostics.push({ severity: 'error', code: 'twin.component.type.unsupported', message: `不支持的 componentType：${object.component.componentType || '(empty)'}`, path: `${path}.componentType` });
		if (!object.component.generator) diagnostics.push({ severity: 'error', code: 'twin.component.generator.required', message: '组件 generator 不能为空。', path: `${path}.generator` });
		if (!Number.isInteger(object.component.generatorVersion) || object.component.generatorVersion <= 0) diagnostics.push({ severity: 'error', code: 'twin.component.generator-version.invalid', message: 'generatorVersion 必须是正整数。', path: `${path}.generatorVersion` });
		if (!object.component.properties || typeof object.component.properties !== 'object' || Array.isArray(object.component.properties)) diagnostics.push({ severity: 'error', code: 'twin.component.properties.invalid', message: '组件 properties 必须是对象。', path: `${path}.properties` });
		try { portsByObject.set(object.objectId, new Set(resolveComponentPorts(object).map((port) => port.portId))); }
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
	}
	return diagnostics;
};
