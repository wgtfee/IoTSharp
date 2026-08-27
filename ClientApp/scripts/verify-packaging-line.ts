import { createPackagingLineTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { resolveRoutePath } from '../src/digital-twin/routes/RouteEngine';
import { ProceduralPackagingLine } from '../src/digital-twin/runtime/ProceduralPackagingLine';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const manifest = createPackagingLineTwinSceneManifest();
const route = manifest.routes[0];
const errors = validateTwinSceneManifest(manifest).filter((item) => item.severity === 'error');
assert(errors.length === 0, `包装线 Manifest 校验失败：${errors.map((item) => item.message).join('；')}`);

const leftPath = resolveRoutePath(route, { payload: { sku: 'A' } });
const rightPath = resolveRoutePath(route, { payload: { sku: 'B' } });
assert(leftPath.edgeIds.includes('pack-edge-left-turn') && !leftPath.edgeIds.includes('pack-edge-right-turn'), 'SKU-A 没有进入左支线');
assert(rightPath.edgeIds.includes('pack-edge-right-turn') && !rightPath.edgeIds.includes('pack-edge-left-turn'), 'SKU-B 没有进入右支线');
assert(leftPath.closed && rightPath.closed, '包装线左右路线必须闭环');

const packagingLine = new ProceduralPackagingLine(route, 50);
const snapshot = packagingLine.getSnapshot();
assert(snapshot.palletCount === 50, `期望 50 个托盘，实际 ${snapshot.palletCount}`);
assert(snapshot.pathLengths.A > 80 && snapshot.pathLengths.B > 80, '包装线路径长度异常');
assert(packagingLine.group.getObjectByName('包装线桁架'), '桁架未生成');
assert(packagingLine.group.getObjectByName('包装机器人_1') && packagingLine.group.getObjectByName('包装机器人_2'), '两台机器人未生成');
assert(packagingLine.group.getObjectByName('左线旋转台') && packagingLine.group.getObjectByName('右线旋转台'), '两座旋转台未生成');

const pallets: any[] = [];
packagingLine.group.traverse((object: any) => {
	if (Number.isInteger(object.userData?.palletIndex)) pallets.push(object);
});
assert(pallets.length === 50, `场景树应包含 50 个独立托盘，实际 ${pallets.length}`);

const initialPosition = pallets[0].position.clone();
packagingLine.setRunning(true);
packagingLine.updateFixed(1);
assert(pallets[0].position.distanceTo(initialPosition) > 0.5, '运行后托盘没有移动');
const pausedPosition = pallets[0].position.clone();
packagingLine.setRunning(false);
packagingLine.updateFixed(1);
assert(pallets[0].position.distanceTo(pausedPosition) < 0.000001, '暂停后托盘仍在移动');
packagingLine.reset();
assert(pallets[0].position.distanceTo(initialPosition) < 0.000001, '复位后托盘没有回到初始位置');

console.log(JSON.stringify({
	manifest: manifest.name,
	objects: manifest.objects.length,
	edges: route.edges.length,
	pallets: snapshot.palletCount,
	leftPathMeters: Number(snapshot.pathLengths.A.toFixed(2)),
	rightPathMeters: Number(snapshot.pathLengths.B.toFixed(2)),
	status: 'PASS',
}, null, 2));
