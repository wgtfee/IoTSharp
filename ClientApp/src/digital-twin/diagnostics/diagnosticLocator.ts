import type { TwinSceneManifest } from '/@/digital-twin/contracts';

const indexedPath = (path: string, collection: string) => path.match(new RegExp(`${collection}\\[(\\d+)\\]`, 'i'));

/** 将前端/后端 Manifest 诊断路径解析回可定位的场景对象。 */
export const resolveTwinDiagnosticObjectId = (manifest: TwinSceneManifest, path?: string | null): string | undefined => {
	const value = String(path || '').trim();
	if (!value) return undefined;

	const objectIndexMatch = indexedPath(value, 'objects');
	if (objectIndexMatch) return manifest.objects[Number(objectIndexMatch[1])]?.objectId;

	const bindingIndexMatch = indexedPath(value, 'bindings');
	if (bindingIndexMatch) return manifest.bindings[Number(bindingIndexMatch[1])]?.objectId;

	const bindingKeyMatch = value.match(/(?:^|[.$])bindings[.:]([^.[\]]+)/i);
	if (bindingKeyMatch) {
		const binding = manifest.bindings.find((item) => item.bindingId === decodeURIComponent(bindingKeyMatch[1]));
		if (binding?.objectId) return binding.objectId;
	}

	return manifest.objects.find((item) => value.includes(item.objectId))?.objectId;
};
