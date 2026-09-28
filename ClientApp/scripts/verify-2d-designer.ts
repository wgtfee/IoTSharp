import { createDefaultTwinSceneManifest, createRouteEdge, createRoutePoint } from '../src/digital-twin/contracts';
import { reactive } from 'vue';
import { createTwin2DLibraryObject, twin2DBuiltInLibrary } from '../src/digital-twin-2d/library';
import { createDefaultTwin2DView, ensureTwin2DView, validateTwin2DView } from '../src/digital-twin-2d/types';
import { interpolateTwin2DRoute, resolveTwin2DRouteRuntimeStates, resolveTwin2DRuntimeStates } from '../src/digital-twin-2d/runtime';
import { duplicateTwin2DSelection, moveObjects, snapObjectsToAlignmentGuides } from '../src/digital-twin-2d/editor';
import { cloneTwin2DState } from '../src/digital-twin-2d/clone';
import { isSafeTwin2DSvg, sanitizeTwin2DSvg } from '../src/digital-twin-2d/svg';
import { mapModelResourceTo2DLibraryItem, saveTwin2DLibraryState } from '../src/digital-twin-2d/library-store';
import { mapTwin2DUpdates, resolveTwin2DRoutingContext, resolveTwin2DRouteSlotPallets } from '../src/digital-twin-2d/runtime';
import { resolve2DPorts, connectPorts2D, remove2DRoutePoint, remove2DRouteEdge } from '../src/digital-twin-2d/route';
import { BindingEngine } from '../src/digital-twin/bindings/BindingEngine';
import { telemetryBoolean } from '../src/digital-twin/bindings/BindingValueTransform';
import * as THREE from 'three';

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
saveTwin2DLibraryState(reactive({ favorites: [], recent: [], custom: [twin2DBuiltInLibrary[0]] }));
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
	const duplicated = duplicateTwin2DSelection(manifest, [reactiveConveyor]);
	assert(duplicated.views[0].businessObjectId !== conveyor.businessObjectId && duplicated.businessObjects.length === 1, '2D 复制必须生成独立业务对象');
	assert(JSON.stringify(duplicated.businessObjects[0].transform) === JSON.stringify(businessObject.transform), '2D 复制的像素偏移不能覆盖共享 3D 世界坐标');
	const states = resolveTwin2DRuntimeStates(view.objects, manifest, [{
		bindingId: 'database-row-guid', bindingKey: 'verify-running', value: true, quality: 'good', stale: false,
		sourceTimestamp: new Date().toISOString(), serverTimestamp: new Date().toISOString(),
	} as any]);
	assert(states[conveyor.id]?.running === true, 'Telemetry Running 未驱动 2D Runtime 状态');
	const staleStates = resolveTwin2DRuntimeStates(view.objects, manifest, [{
		bindingId: 'database-row-guid', bindingKey: 'verify-running', value: true, quality: 'good', stale: true,
	} as any]);
	assert(staleStates[conveyor.id]?.running === false && staleStates[conveyor.id]?.quality === 'stale', '过期 Telemetry 不应继续驱动运行动画');
}

const pointA = createRoutePoint([0,0,0],0), pointB = createRoutePoint([1,0,0],1), pointC = createRoutePoint([2,0,0],2);
pointA.pointId='a'; pointB.pointId='b'; pointC.pointId='c';
const edgeBC=createRouteEdge('b','c',1), edgeAB=createRouteEdge('a','b',0);
edgeBC.edgeId='bc'; edgeAB.edgeId='ab';
manifest.runtime.dataMode='simulation';
manifest.routes=[{routeId:'linear',routeKey:'linear',name:'线性路线',routeType:'material-flow',startPointId:'a',points:[pointA,pointB,pointC],edges:[edgeBC,edgeAB],decisionRules:[]} as any];
const mapped=interpolateTwin2DRoute(manifest,{a:{x:0,y:0},b:{x:100,y:0},c:{x:200,y:0}},.75,'linear');
assert(mapped?.x===150 && mapped.y===0,'2D 路线必须按图拓扑而非 edges 数组顺序插值');
manifest.runtime.dataMode='live';
edgeAB.occupancyBindingId='edge-occupancy';
const unavailable=resolveTwin2DRouteRuntimeStates(manifest,[]);
assert(unavailable.ab.stale && unavailable.ab.blocked,'实时路线缺少占用信号时应保持阻断状态');

const update = (key: string, value: unknown, stale = false) => ({ bindingId: `row-${key}`, bindingKey: key, value, stale, quality: stale ? 'stale' : 'good', sourceTimestamp: new Date().toISOString() } as any);
assert(!telemetryBoolean('false') && !telemetryBoolean('0') && !telemetryBoolean('OFF') && telemetryBoolean('true'), 'PLC 布尔字符串转换不正确');
const bindingScene = createDefaultTwinSceneManifest();
const targetId = bindingScene.objects[0].objectId;
bindingScene.bindings = [
	{ bindingId:'run', objectId:targetId, source:{kind:'telemetry',key:'Running'}, target:{kind:'animation',property:'y'}, transform:{kind:'booleanAnimation',trueValue:{speed:2},falseValue:{speed:0}} },
	{ bindingId:'color', objectId:targetId, source:{kind:'telemetry',key:'State'}, target:{kind:'color'}, transform:{kind:'enumMap',map:{'2':'#00ff00'}} },
	{ bindingId:'text', objectId:targetId, source:{kind:'telemetry',key:'Count'}, target:{kind:'text',property:'label'}, transform:{kind:'formatText',template:'件数 {value}'} },
	{ bindingId:'visible', objectId:targetId, source:{kind:'telemetry',key:'Visible'}, target:{kind:'visible'}, transform:{kind:'booleanVisibility'} },
	{ bindingId:'progress', objectId:targetId, source:{kind:'telemetry',key:'Progress'}, target:{kind:'routeProgress',property:'routeProgress:linear'}, transform:{kind:'routeProgress',factor:0.01,offset:0.1} },
] as any;
const boundView = { ...conveyor, businessObjectId:targetId };
const signals = [update('run','false'), update('color',2), update('text',12), update('visible','false'), update('progress',50)];
const projected = resolveTwin2DRuntimeStates([boundView],bindingScene,signals)[boundView.id];
assert(!projected.running && !projected.visible && projected.color==='#00ff00' && projected.text==='件数 12', '2D 绑定必须使用声明的布尔、枚举和文本转换');
assert(Math.abs(projected.routeProgress!-.6)<1e-8 && projected.routeId==='linear', '2D 路线进度未应用比例和偏移');
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
let threeProgress=0;
const engine = new BindingEngine(bindingScene,()=>mesh,value=>{threeProgress=value;});
engine.apply(signals); engine.tick(1);
assert(!mesh.visible && mesh.rotation.y===0 && mesh.material.color.getHexString()==='00ff00' && mesh.userData.label===projected.text && threeProgress===projected.routeProgress, '共享转换器修改导致 3D 与 2D 结果不一致');
engine.apply([update('run','true')]); engine.tick(1);
assert(mesh.rotation.y===2,'3D booleanAnimation trueValue.speed 回归');
engine.apply([{...update('run',true),quality:'stale',stale:false}]); engine.tick(1);
assert(mesh.rotation.y===2 && engine.getSignalSnapshot().staleBindingIds.includes('run'),'3D 过期动画应停止，不能继续假装设备运行');
engine.apply([update('text',13)]);
assert(mesh.material.color.getHexString()==='00ff00','从过期状态恢复时应保留最近有效的业务颜色');
engine.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
const businessKeyWins=mapTwin2DUpdates([update('run',true),{...update('other',false),bindingId:'run'}]);
assert(businessKeyWins.get('run')?.value===true,'数据库行 ID 不可覆盖同名业务 bindingKey');

const branchScene=createDefaultTwinSceneManifest();
const a={...pointA,decisionMode:'plc' as const}, b={...pointB,decisionMode:'manual' as const}, c={...pointC,decisionMode:'manual' as const};
branchScene.bindings=[];
branchScene.routes=[{routeId:'branch',name:'分流',startPointId:'a',points:[a,b,c],edges:[{...edgeAB},{...edgeBC,edgeId:'ac',fromPointId:'a'}],decisionRules:[
	{ruleId:'b-rule',junctionPointId:'a',edgeId:'ab',source:'binding',bindingId:'route-choice',operator:'equals',matchValue:'B',enabled:true},
	{ruleId:'c-rule',junctionPointId:'a',edgeId:'ac',source:'binding',bindingId:'route-choice',operator:'equals',matchValue:'C',enabled:true},
]}] as any;
delete branchScene.routes[0].edges[0].occupancyBindingId;
const pointViews={a:{x:0,y:0},b:{x:100,y:0},c:{x:0,y:100}};
const branchSignals=[update('route-choice','C')];
const branchPosition=interpolateTwin2DRoute(branchScene,pointViews,1,'branch',resolveTwin2DRoutingContext(branchScene,branchSignals));
assert(branchPosition?.x===0 && branchPosition?.y===100,'2D 岔口必须依据 PLC 决策进入 C 路线');
assert(!interpolateTwin2DRoute(branchScene,pointViews,.5,'branch',resolveTwin2DRoutingContext(branchScene,[update('route-choice','C',true)])),'过期岔口信号不能回退到默认分支');
const slotBinding={bindingId:'slots',objectId:targetId,source:{kind:'telemetry',key:'托盘数组'},target:{kind:'customProperty',property:'routeSlots:linear'},transform:{kind:'routeSlotArray',routeId:'linear'},enabled:true} as any;
manifest.bindings=[slotBinding]; delete edgeAB.occupancyBindingId;
view.routePoints={a:{x:0,y:0},b:{x:100,y:0},c:{x:200,y:0}};
const pallets=resolveTwin2DRouteSlotPallets(manifest,view,[update('slots',[12,0,45])]);
assert(pallets.length===2 && pallets[0].x===0 && pallets[1].x===200 && pallets[1].palletId==='45','PLC 托盘数组槽位位置不正确');
assert(!resolveTwin2DRouteSlotPallets(manifest,view,[update('slots',[12,0,45],true)]).length,'过期 PLC 数组不可继续显示为当前托盘位置');
edgeAB.readyBindingId='ready';
const notReady=resolveTwin2DRouteRuntimeStates(manifest,[update('ready',false)],'live');
assert(notReady.ab.blocked && !notReady.ab.stale,'明确的未就绪状态应阻断但不应显示过期');
assert(resolveTwin2DRouteRuntimeStates(manifest,[],'live').ab.stale,'缺失就绪信号应显示过期阻断');

const rotated={...conveyor,rotation:90};
const ports=resolve2DPorts(manifest,rotated);
assert(ports.length>=2 && Math.abs(ports[0].x-(rotated.x+rotated.width/2))<1e-8,'对象旋转后端口未同步旋转');
let selfBlocked=false;
try {connectPorts2D(manifest,ports[1],ports[0]);} catch {selfBlocked=true;}
assert(selfBlocked,'不能将同一组件的端口连成自环');
const cleanRoute=structuredClone(branchScene.routes[0]);
cleanRoute.junctionDecisions={a:'ac'};
remove2DRouteEdge(cleanRoute,'ac');
assert(!cleanRoute.decisionRules?.some(rule=>rule.edgeId==='ac') && !cleanRoute.junctionDecisions.a,'删除连线未清理岔口引用');
remove2DRoutePoint(cleanRoute,view,'a');
assert(cleanRoute.startPointId==='b' && !cleanRoute.edges.length && !cleanRoute.decisionRules?.length && !view.routePoints.a,'删除起点未清理路线、规则及 2D 坐标');

const cloned = structuredClone(manifest) as any;
cloned.view2d = view;
assert(ensureTwin2DView(cloned).objects.length === 1, 'view2d 保存/恢复失败');
console.log('IoTSharp 2D designer smoke PASS');
