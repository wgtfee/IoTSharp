import { createDefaultTwinSceneManifest } from '../src/digital-twin/contracts';
import { reactive } from 'vue';
import { createTwin2DLibraryObject, twin2DBuiltInLibrary } from '../src/digital-twin-2d/library';
import { createDefaultTwin2DView, ensureTwin2DView, validateTwin2DView } from '../src/digital-twin-2d/types';
import { resolveTwin2DRuntimeStates } from '../src/digital-twin-2d/runtime';
import { moveObjects, snapObjectsToAlignmentGuides } from '../src/digital-twin-2d/editor';
import { cloneTwin2DState } from '../src/digital-twin-2d/clone';
import { isSafeTwin2DSvg, sanitizeTwin2DSvg } from '../src/digital-twin-2d/svg';
import { mapModelResourceTo2DLibraryItem } from '../src/digital-twin-2d/library-store';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

assert(twin2DBuiltInLibrary.length >= 10, '2D 内置模型库数量不足');
const databaseComponent = mapModelResourceTo2DLibraryItem({
	id: '22222222-2222-4222-8222-222222222222', resourceKey: 'component:test', name: '测试组件', runtimeFormat: 'procedural-component', originalFileName: '',
	modelMetadata: { resourceKey: 'component:test', resourceType: 'procedural-component', componentType: 'conveyor', generator: 'component-generator-v7', generatorVersion: 7, ports: [{ portId: 'input', type: 'material-input' }] },
} as any);
assert(databaseComponent?.generator === 'component-generator-v7' && databaseComponent.generatorVersion === 7, '数据库组件生成器快照未透传到 2D 模型库');
const manifest = createDefaultTwinSceneManifest();
manifest.routes = [];
const view = createDefaultTwin2DView();
const conveyor = createTwin2DLibraryObject(twin2DBuiltInLibrary[0], 100, 200, 1);
view.objects.push(conveyor);
assert(validateTwin2DView(view, manifest).every((item) => item.severity !== 'error'), '合法 2D View 不应产生 Error');
const reactiveConveyor = reactive(conveyor);
assert(cloneTwin2DState(reactiveConveyor).id === conveyor.id, 'Vue Proxy 场景对象无法创建安全快照');
const movedReactive = moveObjects([reactiveConveyor], 40, 20);
assert(movedReactive[0].x === 140 && movedReactive[0].y === 220, 'Vue Proxy 场景对象拖动坐标计算失败');
const stationary = createTwin2DLibraryObject(twin2DBuiltInLibrary[0], 400, 200, 2);
const nearAligned = { ...structuredClone(conveyor), x: 155 };
const alignment = snapObjectsToAlignmentGuides([nearAligned], [stationary], 6);
assert(alignment.objects[0].x === 160 && alignment.guides.vertical[0] === 400, '对象边缘对齐辅助线计算失败');
const invalidView = structuredClone(view);
invalidView.canvas.gridSize = 0;
assert(validateTwin2DView(invalidView, manifest).some((item) => item.code === 'twin2d.canvas.invalid'), '无效画布参数未被校验拦截');
const safeSvg = sanitizeTwin2DSvg('<svg onload="alert(1)"><script>alert(1)</script><image href="data:image/png;base64,AA"/><rect width="10" height="10"/></svg>');
assert(isSafeTwin2DSvg(safeSvg) && !/script|onload|data:/i.test(safeSvg), '自定义 SVG 安全清洗失败');

const businessObject = manifest.objects[0];
if (businessObject) {
	conveyor.businessObjectId = businessObject.objectId;
	manifest.bindings.push({
		bindingId: 'verify-running', objectId: businessObject.objectId,
		source: { kind: 'telemetry', deviceId: '11111111-1111-4111-8111-111111111111', key: 'Running' },
		target: { kind: 'animation' }, transform: { kind: 'booleanAnimation' }, staleAfterMs: 3000, enabled: true,
	});
	const states = resolveTwin2DRuntimeStates(view.objects, manifest, [{
		bindingId: 'verify-running', value: true, quality: 'good', stale: false,
		sourceTimestamp: new Date().toISOString(), serverTimestamp: new Date().toISOString(),
	}]);
	assert(states[conveyor.id]?.running === true, 'Telemetry Running 未驱动 2D Runtime 状态');
}

const cloned = structuredClone(manifest) as any;
cloned.view2d = view;
assert(ensureTwin2DView(cloned).objects.length === 1, 'view2d 保存/恢复失败');
console.log('IoTSharp 2D designer smoke PASS');
