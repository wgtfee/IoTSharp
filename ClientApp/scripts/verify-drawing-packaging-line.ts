import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { createDrawingPackagingLineManifest } from '../src/digital-twin/presets/DrawingPackagingLineManifest';
import { validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { upsertGeneratedComponentRoutes, validateV7ComponentManifest } from '../src/digital-twin/components';
import { createPublishedRuntimeManifest, persistCompiledRouteGraph } from '../src/digital-twin/routes/RouteAuthoringCompiler';
import { validateRouteAuthoringManifest } from '../src/digital-twin/routes/RouteAuthoringValidator';
import { RouteSlotArrayRuntime } from '../src/digital-twin/runtime/RouteSlotArrayRuntime';

const source = createDrawingPackagingLineManifest();
// 离线测试不伪造数据库成功：只允许可导入模板缺少真实 resourceId，UI 发布必须另行验证实际注册结果。
const diagnostics = [...validateTwinSceneManifest(source), ...validateV7ComponentManifest(source), ...validateRouteAuthoringManifest(source)];
assert.deepEqual(diagnostics.filter(d => d.severity === 'error' && d.code !== 'twin.component.resource.required'), []);
assert.equal(diagnostics.filter(d => d.code === 'twin.component.resource.required').length, source.objects.length);
const before = JSON.stringify(source.routes);
for (let i = 0; i < 3; i++) upsertGeneratedComponentRoutes(source);
assert.equal(JSON.stringify(source.routes), before, '组件刷新不得复制或改写图纸手工路网');
assert.deepEqual(persistCompiledRouteGraph(source).diagnostics.filter(d => d.severity === 'error'), []);
const { manifest } = createPublishedRuntimeManifest(JSON.parse(JSON.stringify(source)));
assert.equal(manifest.routes.length, 2);
assert.equal(manifest.routes[0].edges.length, 54);
const errors: string[] = [];
const runtime = new RouteSlotArrayRuntime(new THREE.Scene(), manifest, message => errors.push(message));
const initial = runtime.getSimulationSnapshot();
assert.equal(initial.length, 50);
assert.equal(runtime.getDiagnostics().uniquePositions, 50);
const movement = new Map(initial.map(p => [p.palletId, 0]));
const coverage = new Set<string>();
const lastMove = new Map(initial.map(p => [p.palletId, 0]));
const points = new Map(manifest.routes[0].points.map(p => [p.pointId, new THREE.Vector3(...p.position)]));
const segments = manifest.routes[0].edges.map(e => new THREE.Line3(points.get(e.fromPointId)!, points.get(e.toPointId)!));
const temp = new THREE.Vector3(), candidate = new THREE.Vector3();
let minimumDistance = Infinity, maxStep = 0, previous = initial;
const seconds = Number(process.env.DRAWING_TEST_SECONDS || 1200);
const dt = 0.05;
function check(snapshot: typeof initial, time: number) {
	assert.equal(snapshot.length, 50, '托盘不能合并或丢失');
	for (let i = 0; i < snapshot.length; i++) {
		const p = snapshot[i]; candidate.set(...p.position);
		assert(p.position.every(Number.isFinite));
		const drift = Math.min(...segments.map(line => line.closestPointToPoint(candidate, true, temp).distanceTo(candidate)));
		assert(drift < 0.001, `${p.palletId} 离开辊道中心线 ${drift}m`);
		if (p.currentEdgeId) coverage.add(p.currentEdgeId);
		const step = candidate.distanceTo(new THREE.Vector3(...previous[i].position));
		maxStep = Math.max(maxStep, step);
		assert(step < 0.25, `${time}s ${p.palletId} 单帧跳变 ${step}m`);
		movement.set(p.palletId, movement.get(p.palletId)! + step);
		if (step > 0.0001) lastMove.set(p.palletId, time);
		for (let j = i + 1; j < snapshot.length; j++) {
			const q = snapshot[j].position;
			const distance = Math.hypot(p.position[0] - q[0], p.position[2] - q[2]);
			minimumDistance = Math.min(minimumDistance, distance);
			assert(distance >= 1.5 - 0.00001, `${time}s ${p.palletId}/${snapshot[j].palletId} 重叠: ${distance}m`);
		}
	}
	previous = snapshot;
}
check(initial, 0);
runtime.setRunning(true);
for (let tick = 1; tick <= seconds / dt; tick++) {
	runtime.tick(dt);
	check(runtime.getSimulationSnapshot(), tick * dt);
	if (tick % 2400 === 0) {
		console.log(JSON.stringify({ seconds: tick * dt, minDistance: minimumDistance, maxStep, coveredEdges: coverage.size,
			minTravel: Math.min(...movement.values()), longestIdle: Math.max(...[...lastMove.values()].map(t => tick * dt - t)) }));
		if (Math.max(...[...lastMove.values()].map(t => tick * dt - t)) > 100) {
			fs.writeFileSync('drawing-0911-traffic-diagnostic.json', JSON.stringify({
				zones: [...(runtime as any).junctionTraffic.entries()],
				entities: [...(runtime as any).entities.values()].map((e: any) => ({ id: e.key, idle: tick * dt - lastMove.get(e.palletId)!, position: e.root.position.toArray(), snapshot: e.simulationEngine.getSnapshot(), blocker: e.root.userData.collisionBlockerPalletId, candidate: e.root.userData.collisionCandidatePosition }))
			}, null, 2));
			throw new Error('存在超过 100 秒未动的托盘，已输出诊断，不能通过验收');
		}
	}
}
runtime.setRunning(false);
const paused = runtime.getSimulationSnapshot();
runtime.tick(1);
assert(runtime.getSimulationSnapshot().every((p, i) => new THREE.Vector3(...p.position).distanceTo(new THREE.Vector3(...paused[i].position)) < 1e-8), '暂停必须保持位置');
runtime.reset();
assert(runtime.getSimulationSnapshot().every((p, i) => new THREE.Vector3(...p.position).distanceTo(new THREE.Vector3(...initial[i].position)) < 1e-8), '重置必须恢复原始安全投放位置');
assert.deepEqual(errors, []);
const uncovered = manifest.routes[0].edges.filter(e => !coverage.has(e.edgeId)).map(e => e.edgeId);
const maxIdle = Math.max(...[...lastMove.values()].map(t => seconds - t));
assert.deepEqual(uncovered, [], '物理空跑必须覆盖全部小辊道支路');
assert(maxIdle < 120, `存在永久堵塞，最长不动 ${maxIdle}s`);
assert(Math.min(...movement.values()) > 250, '每个托盘都要完成实际持续输送');
const report = { passed: true, kind: 'real-route-runtime-without-webgl-or-database', seconds, fixedStep: dt, pallets: initial.length,
	minimumCenterDistance: minimumDistance, maximumFrameDisplacement: maxStep, coveredEdges: coverage.size,
	minimumTravelMeters: Math.min(...movement.values()), maximumIdleSeconds: maxIdle, pausePassed: true, resetPassed: true,
	databasePublication: 'requires-separate-authenticated-ui-verification', plcAndProcess: 'intentionally-deferred' };
fs.writeFileSync('public/digital-twin/templates/drawing-0911-physical-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
runtime.dispose();
