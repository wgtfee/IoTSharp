import { createSilkCakeLineTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { SilkCakeLineRuntime } from '../src/digital-twin/runtime/SilkCakeLineRuntime';
import { TwinMaterialFlowRuntime } from '../src/digital-twin/runtime/TwinMaterialFlowRuntime';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const manifest = createSilkCakeLineTwinSceneManifest();
const route = manifest.routes[0];
const errors = validateTwinSceneManifest(manifest).filter((item) => item.severity === 'error');
assert(errors.length === 0, `丝饼产线 Manifest 校验失败：${errors.map((item) => item.message).join('；')}`);

const options = {
	...manifest.runtime.silkLineSimulation!,
	silkCakesPerCart: 2,
	cartChangeDelaySeconds: 0.2,
	robotCycleSeconds: 0.35,
	gantryCycleSeconds: 0.45,
	palletReleaseIntervalSeconds: 0.08,
	stackRows: 1,
	stackColumns: 2,
	stackLayers: 1,
};
const flow = new TwinMaterialFlowRuntime(route);
const runtime = new SilkCakeLineRuntime(route, flow, options);

let visualPallets = 0;
runtime.group.traverse((object: any) => {
	if (object.userData?.twinEntityType === 'plastic-pallet') visualPallets += 1;
	assert(!/包装箱|木托盘|wood pallet|carton/i.test(object.name || ''), `发现旧包装物料：${object.name}`);
});
assert(visualPallets === 50, `场景应包含 50 个绿色塑料托盘，实际 ${visualPallets}`);
assert(runtime.group.getObjectByName('丝车'), '丝车未生成');
assert(runtime.group.getObjectByName('旋转台与丝车供料区'), '旋转台未生成');
assert(runtime.group.getObjectByName('上料机器人'), '上料机器人未生成');
assert(runtime.group.getObjectByName('桁架码垛机构'), '桁架未生成');
assert(runtime.group.getObjectByName('Stack-A'), '码垛区未生成');

runtime.setSpeed(8);
runtime.setRunning(true);
for (let tick = 0; tick < 30 * 60; tick += 1) runtime.updateFixed(1 / 30);
const snapshot = runtime.getSnapshot();

assert(snapshot.palletFlow.pallets.length === 50, '业务 Runtime 的塑料托盘总数不是 50');
assert(snapshot.palletFlow.onlineCount > 0 && snapshot.palletFlow.sourceQueue.length < 50, 'SourceQueue 没有向在线 Section 放行托盘');
assert(snapshot.robot.completedCount >= 3, `机器人任务完成数不足：${snapshot.robot.completedCount}`);
assert(snapshot.gantry.completedCount === 2, `桁架应在两次码垛后被 Stack Full 阻塞，实际 ${snapshot.gantry.completedCount}`);
assert(snapshot.stack.state === 'full' && snapshot.stack.occupied === 2, '码垛区满位状态不正确');
assert(snapshot.stations.find((station) => station.type === 'gantry-stacking')?.waitingReason === 'STACK_FULL', '桁架工位没有报告 STACK_FULL');
assert(snapshot.palletFlow.waitingCount > 0, 'Stack Full 后没有形成托盘等待/上游阻塞');
assert(snapshot.cart && snapshot.cart.cartId !== 'SilkCart-001', '空丝车没有按模拟延时自动更换');
assert(snapshot.stack.silkCakeIds.every((cakeId) => runtime.materials.getCake(cakeId)?.state === 'stacked'), '码垛丝饼生命周期未进入 stacked');
assert(snapshot.palletFlow.pallets.filter((pallet) => pallet.cycleCount > 0).every((pallet) => !pallet.silkCakeId || pallet.state !== 'empty-return'), '空托盘回流状态与丝饼载荷冲突');
for (const section of snapshot.sections) assert(section.occupancy + section.reserved <= section.capacity, `${section.sectionId} 超出容量：${section.occupancy}+${section.reserved}>${section.capacity}`);

const beforePause = snapshot.palletFlow.pallets.find((pallet) => pallet.currentSectionId && pallet.sectionProgress < 0.99);
runtime.setRunning(false);
for (let tick = 0; tick < 30; tick += 1) runtime.updateFixed(1 / 30);
if (beforePause) {
	const afterPause = runtime.pallets.getPallet(beforePause.palletId)!;
	assert(Math.abs(afterPause.sectionProgress - beforePause.sectionProgress) < 0.000001, '暂停后托盘仍在移动');
}

// 独立验收空托盘闭环：小车队全部上线后，完成码垛的空托盘必须优先回到上料段并再次装料。
const cycleOptions = { ...options, palletCount: 8, silkCakesPerCart: 4, stackRows: 4, stackColumns: 4, stackLayers: 3 };
const cycleFlow = new TwinMaterialFlowRuntime(route);
const cycleRuntime = new SilkCakeLineRuntime(route, cycleFlow, cycleOptions);
cycleRuntime.setSpeed(12);
cycleRuntime.setRunning(true);
for (let tick = 0; tick < 45 * 60; tick += 1) cycleRuntime.updateFixed(1 / 30);
const cycleSnapshot = cycleRuntime.getSnapshot();
assert(cycleSnapshot.palletFlow.sourceQueue.length === 0, '小车队场景的 SourceQueue 未清空');
assert(cycleSnapshot.palletFlow.pallets.some((pallet) => pallet.cycleCount > 0), '空塑料托盘没有回到上料段形成下一循环');
assert(cycleSnapshot.robot.completedCount > cycleOptions.palletCount, '机器人没有对回流托盘执行再次上料');
assert(cycleSnapshot.gantry.completedCount > cycleOptions.palletCount, '桁架没有持续完成多轮码垛');

console.log(JSON.stringify({
	manifest: manifest.name,
	pallets: snapshot.palletFlow.pallets.length,
	online: snapshot.palletFlow.onlineCount,
	sourceQueue: snapshot.palletFlow.sourceQueue.length,
	robotCompleted: snapshot.robot.completedCount,
	gantryCompleted: snapshot.gantry.completedCount,
	stack: `${snapshot.stack.occupied}/${snapshot.stack.capacity} ${snapshot.stack.state}`,
	waitingPallets: snapshot.palletFlow.waitingCount,
	activeCart: snapshot.cart?.cartId,
	closedLoopRobotTasks: cycleSnapshot.robot.completedCount,
	closedLoopGantryTasks: cycleSnapshot.gantry.completedCount,
	maxPalletCycles: Math.max(...cycleSnapshot.palletFlow.pallets.map((pallet) => pallet.cycleCount)),
	status: 'PASS',
}, null, 2));
