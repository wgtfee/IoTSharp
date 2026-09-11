import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReferencePackagingLineTwinSceneManifest } from '../src/digital-twin/presets/ReferencePackagingLineManifest';

const target = resolve('src/digital-twin/presets/reference-packaging-v19.scene.json');
const previous: any = JSON.parse(readFileSync(target, 'utf8'));
const generated: any = buildReferencePackagingLineTwinSceneManifest();
const previousObjects = new Map(previous.objects.map((item: any) => [item.objectId, item]));

generated.objects = generated.objects.map((item: any) => {
	const old: any = previousObjects.get(item.objectId);
	if (!old) return item;
	if (old.assetId) item.assetId = old.assetId;
	if (old.resourceId) item.resourceId = old.resourceId;
	if (item.component && old.component) {
		item.component.properties = {
			...(old.component.properties || {}),
			...(item.component.properties || {}),
		};
	}
	return item;
});

// 动作流程由专业编辑器维护；这里只刷新辊道组件、Port Connection 和自动 Route。
for (const key of ['resources', 'workPoints', 'materialSlots', 'toolFrames', 'actuators', 'poses', 'behaviors', 'interlocks']) {
	generated[key] = structuredClone(previous[key] || []);
}
// 严格发布不接受依赖运行时隐式上限的阻塞动作；参考场景统一采用有限安全超时。
for (const behavior of generated.behaviors || []) {
	for (const action of behavior.actions || []) {
		if (action.waitForInterlockId && !(Number(action.timeoutSeconds) > 0)) action.timeoutSeconds = 300;
	}
}
generated.sceneId = previous.sceneId;
generated.editorExtension = structuredClone(previous.editorExtension);
generated.runtime = {
	...(previous.runtime || {}),
	...generated.runtime,
	routePalletInitializers: structuredClone(previous.runtime?.routePalletInitializers || []),
};

writeFileSync(target, `${JSON.stringify(generated, null, '\t')}\n`, 'utf8');
console.log(`已更新 ${target}`);
console.log(`对象 ${generated.objects.length}，路线 ${generated.routes.length}，连接 ${generated.connections?.length || 0}，动作 ${generated.behaviors.length}`);
