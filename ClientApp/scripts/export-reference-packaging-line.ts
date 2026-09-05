import { builtInComponentResourceRegistrations } from '../src/digital-twin/components/ComponentResourceRegistration';
import { createReferencePackagingLineTwinSceneManifest } from '../src/digital-twin/presets/ReferencePackagingLineManifest';

// 供本地部署/验收脚本使用：只输出 JSON，不直接访问数据库或保存凭据。
const manifest = createReferencePackagingLineTwinSceneManifest();
const requiredKeys = new Set((manifest.objects || [])
	.filter((item) => item.kind === 'component' && Boolean(item.component?.resourceKey))
	.map((item) => item.component!.resourceKey));
for (const route of manifest.routes || []) {
	for (const routeEdge of route.edges || []) {
		if (routeEdge.transportUnitResourceKey) requiredKeys.add(routeEdge.transportUnitResourceKey);
	}
}
const registrations = builtInComponentResourceRegistrations
	.filter((registration) => requiredKeys.has(registration.resourceKey));

console.log(JSON.stringify({
	manifest,
	registrations,
}));
