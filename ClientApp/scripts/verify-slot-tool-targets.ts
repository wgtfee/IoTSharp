import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Matrix4 } from 'three';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { validateTwinSceneManifest, type TwinSceneManifest, type TwinSlotToolTargetDefinition } from '../src/digital-twin/contracts';
import { validateSlotToolTargets } from '../src/digital-twin/contracts/slot-tool-targets';
import { deriveSlotToolTarget, deriveSlotToolTargetCandidates, SlotTargetDerivationError, type SlotTargetContext } from '../src/digital-twin/motion/SlotToolTargetDeriver';
import cases from './fixtures/slot-tool-target-cases.json';

// 在实际生产模板上扩展声明；距离仅为本专项测试夹具，不是产品默认值。
const manifest = createDrawingPackagingProcessManifest();
const slot = manifest.materialSlots!.find(item => item.slotId === 'drawing-cart-left')!;
const frame = manifest.toolFrames!.find(item => item.objectId === 'drawing-loading-robot')!;
slot.contactNormalLocal = [0, 1, 0];
frame.approachDirectionLocal = [0, -1, 0];
frame.payloadTypes = ['silk-cake'];
const target: TwinSlotToolTargetDefinition = { contractVersion: 'slot-tool-target/1', templateId: 'top', toolFrameId: frame.toolFrameId, payloadType: 'silk-cake', tcpOffset: [0.2, 0, 0], tcpRotation: [0, 0, 0], approachDistance: 0.3, retreatDistance: 0.4 };
slot.toolTargets = [target];
assert.deepEqual(validateSlotToolTargets(manifest), []);
assert(!validateTwinSceneManifest(manifest).some(item => item.code.startsWith('twin.motion.target.')));
const restored = JSON.parse(JSON.stringify(manifest)) as TwinSceneManifest;
assert.deepEqual(restored.materialSlots!.find(item => item.slotId === slot.slotId)!.toolTargets, [target]);

for (const test of cases) {
	const changed = structuredClone(manifest);
	let parent: any = changed.materialSlots!.find(item => item.slotId === slot.slotId)!;
	for (const key of test.path.slice(0, -1)) parent = parent[key];
	parent[test.path[test.path.length - 1]] = structuredClone(test.value);
	assert(validateTwinSceneManifest(changed).some(item => item.code === `twin.motion.target.${test.code}`), test.name);
}
for (const invalid of [NaN, Infinity, -Infinity]) {
	const changed = structuredClone(manifest);
	changed.materialSlots!.find(item => item.slotId === slot.slotId)!.toolTargets![0].tcpOffset[0] = invalid;
	assert(validateSlotToolTargets(changed).some(item => item.code.endsWith('tcpOffset.invalid')));
}
const duplicate = structuredClone(manifest);
duplicate.materialSlots!.find(item => item.slotId === slot.slotId)!.toolTargets!.push(structuredClone(target));
assert(validateSlotToolTargets(duplicate).some(item => item.code.endsWith('id.invalid')));
const tooMany = structuredClone(manifest);
tooMany.materialSlots!.find(item => item.slotId === slot.slotId)!.toolTargets = Array.from({ length: 33 }, (_, i) => ({ ...target, templateId: String(i) }));
assert(validateSlotToolTargets(tooMany).some(item => item.code.endsWith('list.invalid')));

// 单独固定静态槽位，使用可手工算出的世界坐标进行独立断言。
delete slot.runtimeOwnerType;
delete slot.runtimeOwnerSelection;
slot.metadata = {};
slot.localPosition = [1, 0, 0];
slot.localRotation = [0, 0, Math.PI / 2];
const context: SlotTargetContext = { resolveAnchorWorld: () => new Matrix4().makeTranslation(10, 0, 0) };
const close = (actual: number[], expected: number[]) => assert(actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) < 1e-9), `${actual} != ${expected}`);
const before = JSON.stringify(manifest);
const result = deriveSlotToolTarget(manifest, slot.slotId, 'top', context);
close(result.contact, [11, 0.2, 0]);
close(result.approach, [10.7, 0.2, 0]);
close(result.retreat, [10.6, 0.2, 0]);
close(result.approachDirection, [1, 0, 0]);
assert.equal(result.status, 'geometry-only');
assert(Object.values(result.checks).every(value => value === 'unchecked'));
assert.equal(JSON.stringify(manifest), before);
assert.deepEqual(deriveSlotToolTarget(manifest, slot.slotId, 'top', context), result);

const rotated = deriveSlotToolTarget(manifest, slot.slotId, 'top', { resolveAnchorWorld: () => new Matrix4().makeRotationY(Math.PI / 2) });
close(rotated.contact, [0, 0.2, -1]);
close(rotated.approach, [0, 0.2, -0.7]);
assert.equal(rotated.candidateId, result.candidateId);
assert.notEqual(rotated.inputSignature, result.inputSignature);

let rejectedGeometry = 0;
const rejects = (code: string, run: () => unknown) => { assert.throws(run, error => error instanceof SlotTargetDerivationError && error.code === code); rejectedGeometry++; };
rejects('anchor.missing', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', { resolveAnchorWorld: () => undefined }));
for (const matrix of [new Matrix4().makeScale(2, 1, 1), new Matrix4().makeScale(-1, 1, 1), new Matrix4().makeShear(0.1, 0, 0, 0, 0, 0)]) rejects('transform.unsupported', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', { resolveAnchorWorld: () => matrix }));
const broken = new Matrix4(); broken.elements[12] = NaN;
rejects('transform.unsupported', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', { resolveAnchorWorld: () => broken }));
frame.approachDirectionLocal = [0, 1, 0];
rejects('orientation.incompatible', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', context));
frame.approachDirectionLocal = [0, -1e200, 0];
slot.contactNormalLocal = [0, 1e-200, 0];
close(deriveSlotToolTarget(manifest, slot.slotId, 'top', context).contact, result.contact);
frame.approachDirectionLocal = [0, -1, 0]; slot.contactNormalLocal = [0, 1, 0];

slot.runtimeOwnerType = 'wooden-pallet'; slot.runtimeOwnerSelection = 'station-batch';
rejects('binding.required', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', context));
const bound: SlotTargetContext = { ...context, resolvedSlotFrame: { slotId: slot.slotId, ownerId: 'pallet-A', stateRevision: 'batch-1', worldMatrix: new Matrix4().makeTranslation(5, 2, 0) } };
const dynamic = deriveSlotToolTarget(manifest, slot.slotId, 'top', bound);
close(dynamic.contact, [5.2, 2, 0]); // 完整槽位快照不再次叠加模板的位置和旋转。
assert.equal(dynamic.ownerId, 'pallet-A');
bound.resolvedSlotFrame!.ownerId = 'pallet-B';
assert.notEqual(deriveSlotToolTarget(manifest, slot.slotId, 'top', bound).inputSignature, dynamic.inputSignature);
bound.resolvedSlotFrame!.stateRevision = '';
rejects('binding.required', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', bound));
bound.resolvedSlotFrame!.stateRevision = 'batch-2';
slot.runtimeOwnerSelection = 'nearest';
rejects('binding.required', () => deriveSlotToolTarget(manifest, slot.slotId, 'top', bound));
rejects('definition.missing', () => deriveSlotToolTarget(manifest, slot.slotId, 'missing', context));
rejects('slot.invalid', () => deriveSlotToolTarget(manifest, 'missing', 'top', context));

const legacy = createDrawingPackagingProcessManifest();
assert.deepEqual(validateSlotToolTargets(legacy), []);
// 模板输入顺序不决定结果；朝向不兼容的首个候选不能阻止后续几何候选。
delete slot.runtimeOwnerType; delete slot.runtimeOwnerSelection;
slot.toolTargets = [{ ...target, templateId: 'z-valid' }, { ...target, templateId: 'a-invalid', tcpRotation: [Math.PI, 0, 0] }, { ...target, templateId: 'b-valid' }];
const all = deriveSlotToolTargetCandidates(manifest, slot.slotId, frame.toolFrameId, context);
assert.deepEqual(all.candidates.map(item => item.templateId), ['b-valid', 'z-valid']);
assert.deepEqual(all.rejected.map(item => [item.templateId, item.code]), [['a-invalid', 'orientation.incompatible']]);
slot.toolTargets.reverse();
const reordered = deriveSlotToolTargetCandidates(manifest, slot.slotId, frame.toolFrameId, context);
assert.deepEqual(reordered.candidates.map(item => [item.templateId, item.contact]), all.candidates.map(item => [item.templateId, item.contact]));
assert.deepEqual(reordered.rejected, all.rejected);
slot.toolTargets = slot.toolTargets.filter(item => item.templateId === 'a-invalid');
assert.equal(deriveSlotToolTargetCandidates(manifest, slot.slotId, frame.toolFrameId, context).candidates.length, 0);
rejects('definition.missing', () => deriveSlotToolTargetCandidates(manifest, slot.slotId, 'unknown-tool', context));

// 桁架的物料夹具和隔板夹具共用派生约定；层位来自调用方快照，不在这里猜测库存或层高。
const gantryManifest = createDrawingPackagingProcessManifest();
let gantrySnapshots = 0;
for (const [targetSlotId, toolSuffix] of [['drawing-stack', 'gantry-yarn-tcp'], ['drawing-separator-target', 'gantry-separator-tcp']]) {
	const gantrySlot = gantryManifest.materialSlots!.find(item => item.slotId === targetSlotId)!;
	const gantryTool = gantryManifest.toolFrames!.find(item => item.toolFrameId === `drawing-stacking-gantry:${toolSuffix}`)!;
	assert(gantryTool.cartesianActuatorIds?.length, '必须使用实际桁架的工具声明');
	gantrySlot.contactNormalLocal = [0, 1, 0];
	gantryTool.approachDirectionLocal = [0, -1, 0];
	gantryTool.payloadTypes = [gantrySlot.payloadType!];
	gantrySlot.toolTargets = [{ ...target, toolFrameId: gantryTool.toolFrameId, payloadType: gantrySlot.payloadType!, tcpOffset: [0, 0.1, 0] }];
	for (const [layer, height] of [[0, 1], [1, 1.5]]) {
		const pose = deriveSlotToolTarget(gantryManifest, gantrySlot.slotId, target.templateId, {
			resolveAnchorWorld: () => { throw new Error('动态码垛禁止回退静态坐标'); },
			resolvedSlotFrame: { slotId: gantrySlot.slotId, ownerId: 'pallet-gantry', stateRevision: `layer-${layer}`, worldMatrix: new Matrix4().makeTranslation(2, height, 3) },
		});
		close(pose.contact, [2, height + 0.1, 3]);
		close(pose.approach, [2, height + 0.4, 3]);
		assert.equal(pose.toolFrameId, gantryTool.toolFrameId);
		assert.equal(pose.checks.kinematics, 'unchecked');
		gantrySnapshots++;
	}
}
console.log(JSON.stringify({ passed: true, sharedContractCases: cases.length, nonJsonNumberCases: 3, rejectedGeometry, gantrySnapshots, rotatedCoordinates: true, dynamicIdentity: true, stableCandidateEnumeration: true, perCandidateRejections: true, legacyDeclarations: true, browserTested: false, motionExecuted: false }));
