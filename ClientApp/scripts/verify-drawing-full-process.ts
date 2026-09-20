import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { defaultComponentRegistry, validateV7ComponentManifest, advanceComponentVisualRuntime } from '../src/digital-twin/components';
import { createPublishedRuntimeManifest } from '../src/digital-twin/routes/RouteAuthoringCompiler';
import { RouteSlotArrayRuntime } from '../src/digital-twin/runtime/RouteSlotArrayRuntime';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { ActuatorRuntime } from '../src/digital-twin/runtime/ActuatorRuntime';
import type { TwinV7SceneManifest } from '../src/digital-twin/contracts/v7-components';

const source = createDrawingPackagingProcessManifest();
const diagnostics = [...validateTwinSceneManifest(source), ...validateV7ComponentManifest(source)].filter(d => d.severity === 'error' && d.code !== 'twin.component.resource.required');
assert.deepEqual(diagnostics, [], '工艺场景清单校验不通过');
const { manifest } = createPublishedRuntimeManifest(source);
const speedOverride = process.env.DRAWING_PROCESS_SPEED ? Number(process.env.DRAWING_PROCESS_SPEED) : undefined;
assert(speedOverride === undefined || (Number.isFinite(speedOverride) && speedOverride > 0), '测试速度必须是有限正数');
if (speedOverride !== undefined) for (const route of manifest.routes) route.defaultSpeed = speedOverride;
const scene = new THREE.Scene(), roots = new Map<string, THREE.Group>();
const built: ReturnType<typeof defaultComponentRegistry.create>[] = [];
for (const object of (manifest as TwinV7SceneManifest).objects) {
	const c = object.component!;
	const result = defaultComponentRegistry.create({ ...c, objectId: object.objectId, name: object.name, resourceId: object.resourceId, transform: object.transform });
	scene.add(result.root); roots.set(object.objectId, result.root); built.push(result);
}
const errors: string[] = [];
const slots = new RouteSlotArrayRuntime(scene, manifest, m => errors.push(m), id => roots.get(id));
const actuators = new ActuatorRuntime(manifest, id => roots.get(id), m => errors.push(m));
assert.equal(manifest.behaviors?.length || 0, 0, '新产线不能依赖 V1 动作序列');
assert.equal(manifest.actionFlows?.length, 7, '全部七套工艺必须存在于动作图中');
const behavior = new SceneActionFlowRuntime(manifest, scene, id => roots.get(id), m => errors.push(m), (id, value, speedRatio) => {
	if (!actuators.apply({ actuatorId: id, value, speedRatio, source: 'behavior' })) return false;
	const state = actuators.getState(id)!;
	return typeof value === 'boolean' ? state.currentValue === value : Math.abs(Number(state.currentValue) - Number(state.targetValue)) <= 1e-4;
}, (routeId, ids, junctionId, edgeId) => slots.selectSimulationRoute(routeId, ids, junctionId, edgeId), id => actuators.holdActor(id));
const full = new Set<string>(), dispatched = new Set<string>();
const smallId = manifest.runtime.primarySmallPalletRouteId!;
const previous = new Map<string, THREE.Vector3>();
const woodPrevious = new Map<string, THREE.Vector3>(), clearedWood = new Set<string>();
const woodOrientations = new Map<string, THREE.Quaternion>();
const actuatorDefinitions = new Map((manifest.actuators || []).map(a => [a.actuatorId, a]));
const visitedEdges = new Set<string>();
const materialsPrevious = new Map<string, { position: THREE.Vector3; parent?: string; handoff: number; uuid: string }>();
const traceMaterialSteps = process.env.DRAWING_PROCESS_TRACE_MATERIAL_STEPS === '1';
const dt = .05, limit = Number(process.env.DRAWING_PROCESS_SECONDS || 4000), products = Number(process.env.DRAWING_PROCESS_PRODUCTS || 3);
let time = 0, minSpacing = Infinity, maxPalletStep = 0, maxHandoffStep = 0, maxMaterialStep = 0, minHeldSpacing = Infinity;
let pauseVerified = false;
function materialSnapshot() {
	const result: Array<{ id: string; position: number[] }> = [];
	scene.updateMatrixWorld(true);
	scene.traverse(node => { if (node.userData.materialEntity) result.push({ id: String(node.userData.twinEntityId), position: node.getWorldPosition(new THREE.Vector3()).toArray().map(v => Number(v.toFixed(6))) }); });
	return result.sort((a, b) => a.id.localeCompare(b.id));
}
const initialMaterials = materialSnapshot();
const initialPallets = slots.getSimulationSnapshot().map(p => ({ id: p.palletId, position: p.position }));
const stablePalletSnapshot = () => slots.getSimulationSnapshot().map(p => ({ ...p, position: p.position.map(v => Number(v.toFixed(9))) }));
function diagnostic() {
	return { time, errors, behavior: behavior.getSnapshot(), stations: [...roots].filter(([, r]) => r.userData.stationRequiredBatchSize).map(([id, r]) => ({ id, ...r.userData })), pallets: slots.getSimulationSnapshot() };
}
function runUntilDispatch(required: number) {
	for (let tick = 0; tick < limit / dt; tick++) {
		time = tick * dt;
		const beforeAxes = new Map(actuators.getSnapshot().map(a => [a.actuatorId, a]));
		actuators.tick(dt); slots.tick(dt); behavior.updateFixed(dt);
		for (const current of actuators.getSnapshot()) {
			const previous = beforeAxes.get(current.actuatorId)!, definition = actuatorDefinitions.get(current.actuatorId)!;
			if (definition.kind === 'gripper') continue;
			let delta = Math.abs(Number(current.currentValue) - Number(previous.currentValue));
			if (definition.kind === 'rotary-joint') { const period = definition.unit === 'degree' ? 360 : Math.PI * 2; delta = Math.abs(THREE.MathUtils.euclideanModulo(delta + period / 2, period) - period / 2); }
			const limit = Math.max(.001, Number(definition.speed || (definition.kind === 'rotary-joint' ? 1.8 : 1))) * (previous.speedRatio ?? 1) * dt;
			assert(delta <= limit + 1e-5, `${time}s ${current.actuatorId} 轴姿态跳变 ${delta} 超过单步上限 ${limit}`);
		}
		advanceComponentVisualRuntime(scene, dt, 1);
		scene.updateMatrixWorld(true);
		if (errors.length) throw new Error(errors[0]);
		if (!pauseVerified && behavior.getSnapshot().channels.some(channel => channel.attachedPayloadType)) {
			slots.setRunning(false); behavior.setRunning(false);
			const pausedMaterials = materialSnapshot(), pausedPallets = stablePalletSnapshot();
			const pausedAxes = actuators.getSnapshot();
			for (let wait = 0; wait < 100; wait++) { actuators.tick(dt, false); slots.tick(dt); behavior.updateFixed(dt); }
			assert.deepEqual(materialSnapshot(), pausedMaterials, '夹持中暂停不能让丝锭继续移动');
			assert.deepEqual(stablePalletSnapshot(), pausedPallets); assert.deepEqual(actuators.getSnapshot(), pausedAxes);
			pauseVerified = true; slots.setRunning(true); behavior.setRunning(true);
		}
		const pallets = slots.getSimulationSnapshot().filter(p => p.routeId === smallId);
		const framePallets = new Map(pallets.map(p => [p.palletId, p]));
		assert.equal(pallets.length, 50, '小托盘不可合并或丢失');
		for (const [i, pallet] of pallets.entries()) {
			if (pallet.currentEdgeId) visitedEdges.add(pallet.currentEdgeId);
			const position = new THREE.Vector3(...pallet.position), old = previous.get(pallet.palletId);
			if (old) { const step = old.distanceTo(position); maxPalletStep = Math.max(maxPalletStep, step); assert(step <= manifest.routes.find(r => r.routeId === smallId)!.defaultSpeed * dt + 1e-5, `${time}s ${pallet.palletId} 跳位置 ${step}`); }
			previous.set(pallet.palletId, position);
			for (const other of pallets.slice(i + 1)) {
				const distance = position.distanceTo(new THREE.Vector3(...other.position)); minSpacing = Math.min(minSpacing, distance);
				assert(distance >= 1.4999, `${time}s ${pallet.palletId}/${other.palletId} 重叠 ${distance}`);
			}
		}
		scene.traverse(node => {
			if (node.userData.twinEntityType === 'route-slot-pallet' && framePallets.get(String(node.userData.twinEntityId))?.currentEdgeId?.startsWith('drawing-edge-empty-')) {
				let materialCount = 0;
				node.traverse(item => { if (item.userData.materialEntity) materialCount++; });
				assert.equal(materialCount, 0, `${time}s 载料托盘不可误入空托回流`);
			}
			if (node.userData.behaviorPayloadCarrier && node.userData.payloadType === 'silk-cake') {
				const held: THREE.Vector3[] = [];
				node.traverse(item => { if (item.userData.materialEntity) held.push(item.getWorldPosition(new THREE.Vector3())); });
				for (let i = 0; i < held.length; i++) for (let j = i + 1; j < held.length; j++) {
					const distance = held[i].distanceTo(held[j]); minHeldSpacing = Math.min(minHeldSpacing, distance);
					assert(distance >= .9299, `${time}s ${node.name} 变距时丝锭相互穿透 ${distance}m`);
				}
			}
			if (node.userData.materialEntity) {
				const id = String(node.userData.twinEntityId), position = node.getWorldPosition(new THREE.Vector3()), old = materialsPrevious.get(id);
				if (old) {
					const step = old.position.distanceTo(position); maxMaterialStep = Math.max(maxMaterialStep, step);
					if (traceMaterialSteps && step > .5 && step >= maxMaterialStep) console.log(JSON.stringify({ materialStep: step, time, id, sameEntity: old.uuid === node.uuid, parent: node.parent?.name, parentChanged: old.parent !== node.parent?.uuid, previous: old.position.toArray(), position: position.toArray(), channels: behavior.getSnapshot().channels.map(c => ({ actor: c.actorObjectId, action: c.actionId, status: c.status })) }));
					if (old.parent !== node.parent?.uuid) {
						assert(Number(node.userData.materialHandoffSequence) > old.handoff, `${id} 出现未记录的物料转移`);
						const transferDistance = Number(node.userData.materialHandoffDistance);
						maxHandoffStep = Math.max(maxHandoffStep, transferDistance);
						assert(transferDistance < .04, `${time}s ${id} 取放瞬移 ${transferDistance}m`);
					}
				}
				materialsPrevious.set(id, { position, parent: node.parent?.uuid, handoff: Number(node.userData.materialHandoffSequence || 0), uuid: node.uuid });
			}
			if (node.userData.twinEntityType !== 'route-slot-pallet' || node.userData.transportUnitType !== 'wooden-pallet') return;
			const id = String(node.userData.twinEntityId);
			const oldOrientation = woodOrientations.get(id);
			if (oldOrientation) assert(oldOrientation.angleTo(node.quaternion) <= Math.PI / 2 * dt + 1e-5, `${time}s ${id} 木托转角瞬间旋转`);
			woodOrientations.set(id, node.quaternion.clone());
			const woodPosition = node.getWorldPosition(new THREE.Vector3()), oldWood = woodPrevious.get(id);
			if (node.userData.stackComplete && oldWood && oldWood.distanceTo(woodPosition) > 1e-6 && !clearedWood.has(id)) {
				assert(behavior.getSnapshot().interlocks.find(i => i.interlockId === 'drawing-gantry-retreated')?.satisfied, `${time}s ${id} 夹具未退回就开始出料`);
				assert(!behavior.getSnapshot().channels.find(c => c.actorObjectId === 'drawing-stacking-gantry')?.attachedPayloadType, '木托出料时夹具不可仍挂载物料');
				clearedWood.add(id);
			}
			woodPrevious.set(id, woodPosition);
			if (node.userData.stackComplete) {
				assert.equal(node.userData.stackedItemCount, 48); assert.equal(node.userData.stackedLayerMaterialCount, 8);
				const yarn: THREE.Object3D[] = [];
				node.traverse(item => { if (item.userData.materialEntity && item.userData.payloadType === 'silk-cake') yarn.push(item); });
				assert.equal(new Set(yarn.map(y => y.userData.twinEntityId)).size, 48);
				assert(yarn.every(y => y.userData.processHistory?.includes('inspected') && y.userData.processHistory.some((h: string) => h.startsWith('bagged-'))), '成品不可绕过外检或套袋');
				full.add(id);
			}
			if (node.userData.routeCompleted) { assert(full.has(id), '未完成木托不可离站'); assert(clearedWood.has(id), '木托未取得夹具安全放行'); dispatched.add(id); }
		});
		if (tick % 1200 === 0) console.log(JSON.stringify({ time, full: full.size, dispatched: dispatched.size, robot: roots.get('drawing-loading-robot')!.userData.completedBatchCount || 0, gantry: roots.get('drawing-stacking-gantry')!.userData.completedBatchCount || 0, channels: behavior.getSnapshot().channels.map(c => ({ ...c })) }));
		if (dispatched.size >= required) break;
	}
	assert(dispatched.size >= required, `整线未连续完成 ${required} 木托：实际 ${dispatched.size}`);
	assert([...visitedEdges].some(id => id.startsWith('drawing-edge-empty-')), '空托回流必须实际有托盘经过');
	assert(['drawing-bag-a', 'drawing-bag-b'].every(id => Number(roots.get(id)?.userData.completedBatchCount) > 0), '两台套袋机都必须实际完成加工');
}
try {
	slots.setRunning(true); behavior.setRunning(true);
	runUntilDispatch(products);
	const finishedWoodPallets = [...dispatched], simulationSeconds = time;
	const baggingCycles = Object.fromEntries(['drawing-bag-a', 'drawing-bag-b'].map(id => [id, roots.get(id)!.userData.completedBatchCount]));
	slots.setRunning(false); behavior.setRunning(false);
	slots.reset(); behavior.reset({ restoreMaterials: true }); actuators.reset();
	assert.deepEqual(materialSnapshot(), initialMaterials, '整线复位必须恢复原始源库存、ID 及位置');
	assert.deepEqual(slots.getSimulationSnapshot().map(p => ({ id: p.palletId, position: p.position })), initialPallets, '复位必须重建初始 50 空托盘');
	assert(behavior.getSnapshot().channels.every(c => c.cycleCount === 0 && c.completedActions === 0 && !c.attachedPayloadType));
	full.clear(); dispatched.clear(); previous.clear(); materialsPrevious.clear(); visitedEdges.clear(); woodPrevious.clear(); woodOrientations.clear(); clearedWood.clear();
	slots.setRunning(true); behavior.setRunning(true); runUntilDispatch(1);
	const actionFlows=behavior.getSnapshot().flows.map(f=>({id:f.flowId,state:f.state,cycles:f.cycles}));
	assert(actionFlows.every(f=>f.cycles>0), '七套动作图必须全部实际执行并完成批次');
	const report = { passed: true, generatedAt: new Date().toISOString(), kind: 'real-components-action-flow-v2-route-actuator-runtime', actionFlows, legacyBehaviors: manifest.behaviors?.length || 0, simulationSeconds, routeSpeedMetersPerSecond: manifest.routes[0].defaultSpeed, usesTemplateDefaultSpeed: speedOverride === undefined, smallPallets: 50, finishedWoodPallets, baggingCycles, emptyReturnVisited: true, loadedPalletsInEmptyReturn: 0, gantryClearanceBeforeWoodRelease: true, pauseWhileHolding: pauseVerified, resetInventoryAndPallets: true, finishedAfterReset: [...dispatched], resetRunSeconds: time, minSpacing, minHeldSpacing, maxPalletStep, maxHandoffStep, maxMaterialStep, databasePublication: 'requires-authenticated-ui-verification', realPlc: 'not-connected' };
	const output = speedOverride === undefined ? 'drawing-0911-process-verification.json' : 'drawing-0911-process-accelerated-verification.json';
	fs.writeFileSync(`public/digital-twin/templates/${output}`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	fs.writeFileSync('drawing-0911-process-diagnostic.json', JSON.stringify(diagnostic(), null, 2));
	throw error;
} finally { behavior.dispose(); actuators.dispose(); slots.dispose(); for (const result of built) result.dispose(); }
