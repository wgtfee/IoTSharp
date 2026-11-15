<template>
	<el-drawer :model-value="modelValue" title="机器人与桁架取放工艺" size="520px" @update:model-value="emit('update:modelValue', $event)" @closed="clearPreview">
		<div class="motion-card" v-if="draft">
			<p>选择来源、目标和工具，先检查取放位置，再生成空载试运行路径。</p>
			<el-form label-position="top">
				<el-form-item label="工艺名称"><el-input v-model="request.name" aria-label="工艺名称" /></el-form-item>
				<el-form-item label="取料来源"><el-select v-model="request.sourceSlotId" filterable aria-label="取料来源"><el-option v-for="slot in sourceSlots" :key="slot.slotId" :label="slot.name" :value="slot.slotId" /></el-select></el-form-item>
				<el-form-item label="放料目标 / 码垛托盘"><el-select v-model="request.targetSlotId" filterable aria-label="放料目标"><el-option v-for="slot in targetSlots" :key="slot.slotId" :label="slot.name" :value="slot.slotId" /></el-select></el-form-item>
				<el-form-item label="工具"><el-select v-model="request.toolFrameId" filterable aria-label="取放工具"><el-option v-for="tool in draft.toolFrames || []" :key="tool.toolFrameId" :label="`${draft.objects.find(o=>o.objectId===tool.objectId)?.name || '设备'} · ${tool.name}`" :value="tool.toolFrameId" /></el-select></el-form-item>
				<el-form-item label="试运行方式"><el-checkbox v-model="request.transferMaterials">包含实际仿真物料交接</el-checkbox></el-form-item>
				<el-form-item v-if="request.transferMaterials" label="本批物料数量"><el-input-number v-model="request.payloadCount" :min="1" :max="99" :step="1" :precision="0" aria-label="本批物料数量" /></el-form-item>
				<template v-if="selectedTarget?.stackPattern && request.transferMaterials">
					<el-form-item label="码垛范围"><el-checkbox v-model="fullPallet">按配方生成完整托盘工艺</el-checkbox></el-form-item>
					<template v-if="fullPallet">
						<p>当前配方 {{selectedTarget.stackPattern.rows}} × {{selectedTarget.stackPattern.columns}} × {{selectedTarget.stackPattern.layers}} 层；每批必须覆盖一整层。两个工具按同一动作图顺序运行。</p>
						<el-form-item label="隔板策略"><el-select :model-value="separatorMode" aria-label="隔板策略" @change="selectedTarget.stackPattern!.separatorMode=$event"><el-option label="不放隔板" value="none" /><el-option label="仅层间（8 层用 7 张）" value="between-layers" /><el-option label="每层含顶层（8 层用 8 张）" value="every-layer" /></el-select></el-form-item>
						<el-collapse><el-collapse-item title="从完整层边界恢复">
							<p>只在夹具已空、物料库存与层位已核对时使用。恢复不会新增或移动已放物料；运行开始时会再次检查实际库存。</p>
							<el-form-item label="已完成主物料层数"><el-input-number v-model="resume.completedLayers" :min="0" :max="selectedTarget.stackPattern.layers" :precision="0" aria-label="已完成主物料层数" /></el-form-item>
							<el-checkbox v-if="separatorMode!=='none'" v-model="resume.pendingSeparator" :disabled="resume.completedLayers < 1 || resume.completedLayers > separatorCount">最后一个已完成层还需补隔板</el-checkbox>
							<el-alert v-if="resumeError" :title="resumeError" type="warning" :closable="false" />
						</el-collapse-item></el-collapse>
						<template v-if="separatorMode !== 'none'">
							<p>隔板按配方计算层间高度；来源、目标和工具必须明确，工具须属于同一桁架。</p>
							<el-form-item label="隔板来源"><el-select v-model="separator.sourceSlotId" aria-label="隔板来源"><el-option v-for="slot in sourceSlots" :key="slot.slotId" :label="slot.name" :value="slot.slotId" /></el-select></el-form-item>
							<el-form-item label="隔板目标"><el-select v-model="separator.targetSlotId" aria-label="隔板目标"><el-option v-for="slot in separatorTargets" :key="slot.slotId" :label="slot.name" :value="slot.slotId" /></el-select></el-form-item>
							<el-form-item label="隔板工具"><el-select v-model="separator.toolFrameId" aria-label="隔板工具"><el-option v-for="tool in separatorTools" :key="tool.toolFrameId" :label="tool.name" :value="tool.toolFrameId" /></el-select></el-form-item>
							<el-form-item label="隔板厚度（米）"><el-input-number v-model="selectedTarget.stackPattern.separatorThickness" :min="0" :step="0.001" aria-label="隔板厚度" /></el-form-item>
							<el-form-item label="隔板相对主物料层的高度偏移（米）"><el-input-number v-model="selectedTarget.stackPattern.layerMaterialOffsetY" :min="0" :step="0.01" aria-label="隔板层偏移" /></el-form-item>
							<el-alert v-if="separatorError" :title="separatorError" type="warning" :closable="false" />
						</template>
					</template>
				</template>
			</el-form>
			<el-collapse>
				<el-collapse-item title="模板取放声明" name="templates">
					<p>维护模板时设置一次。位置相对槽位，单位为米；旋转为 XYZ 弧度。接近、退出距离必须显式填写。</p>
					<section v-for="slot in selectedSlots" :key="slot.slotId" class="motion-section">
						<strong>{{ slot.name }}</strong>
						<label>接触外法向</label><div class="motion-vector"><el-input-number v-for="axis in [0,1,2]" :key="axis" :model-value="slot.contactNormalLocal?.[axis]" :aria-label="`${slot.name} 法向 ${['X','Y','Z'][axis]}`" :step="1" controls-position="right" @change="setNormal(slot,axis,$event)" /></div>
						<article v-for="(target,index) in slot.toolTargets || []" :key="target.templateId" class="motion-section">
							<div class="motion-actions"><span>候选 {{ index+1 }} · {{ draft.toolFrames?.find(t=>t.toolFrameId===target.toolFrameId)?.name || '工具缺失' }}</span><el-button text type="danger" @click="slot.toolTargets!.splice(index,1)">移除候选</el-button></div>
							<label>TCP 局部位置</label><div class="motion-vector"><el-input-number v-for="axis in [0,1,2]" :key="axis" v-model="target.tcpOffset[axis]" :aria-label="`${slot.name} 候选 ${index+1} 位置 ${['X','Y','Z'][axis]}`" :step="0.01" controls-position="right" /></div>
							<label>TCP 局部旋转</label><div class="motion-vector"><el-input-number v-for="axis in [0,1,2]" :key="axis" v-model="target.tcpRotation[axis]" :aria-label="`${slot.name} 候选 ${index+1} 旋转 ${['X','Y','Z'][axis]}`" :step="0.1" controls-position="right" /></div>
							<div class="motion-pair"><label>接近距离（米）<el-input-number v-model="target.approachDistance" :min="0" :step="0.01" :aria-label="`${slot.name} 候选 ${index+1} 接近距离`" /></label><label>退出距离（米）<el-input-number v-model="target.retreatDistance" :min="0" :step="0.01" :aria-label="`${slot.name} 候选 ${index+1} 退出距离`" /></label></div>
						</article>
						<el-button :disabled="!toolForSlot(slot)" @click="addCandidate(slot)">为所选工具增加候选</el-button>
					</section>
					<el-alert v-if="declarationErrors.length" :title="declarationErrors.map(e=>e.message).join('；')" type="warning" :closable="false" />
					<el-button :disabled="!selectedSlots.length || declarationErrors.length>0" @click="saveDeclarations">保存模板声明</el-button>
				</el-collapse-item>
				<el-collapse-item title="轴运动约束" name="limits">
					<p>沿用每个执行轴的单位。分别填写每秒速度、每秒平方加速度、每秒立方加加速度。</p>
					<section v-for="axis in axes" :key="axis.actuatorId" class="motion-section">
						<strong>{{ axis.name }} · {{ axis.unit }}</strong>
						<div class="motion-vector"><label v-for="(label,key) in {velocity:'速度',acceleration:'加速度',jerk:'加加速度'}" :key="key">{{ label }}<el-input-number :model-value="request.axisLimits[axis.actuatorId]?.[key]" :min="0" :step="0.1" controls-position="right" :aria-label="`${axis.name} ${label}`" @change="setLimit(axis.actuatorId,key,$event)" /></label></div>
					</section>
				</el-collapse-item>
			</el-collapse>
			<div class="motion-actions"><el-button :loading="busy" @click="runPreview(false)">预览取放位置</el-button><el-button type="primary" :loading="busy" @click="runPreview(true)">{{ request.transferMaterials?'生成取放轨迹':'生成空载轨迹' }}</el-button></div>
			<el-button v-if="request.transferMaterials" :disabled="!canSaveBatchTask" @click="saveBatchTask">{{fullPallet?'保存整托码垛工艺':'保存为按批次规划工艺'}}</el-button>
			<small v-if="request.transferMaterials">适用于动态托盘和码垛：每批开始时绑定身份与层位，运动中保持本批目标。</small>
			<el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
			<el-alert v-if="notice" :title="notice" type="info" :closable="false" />
			<template v-if="preview">
				<el-alert :title="preview.checks.collision==='partial'?'直线轴刚性包围体初查未发现冲突；完整碰撞验证和物料交接仍未完成，仅限仿真。':'碰撞与物料交接尚未完整检查；此结果不能正式发布或控制现场设备。'" type="warning" :closable="false" show-icon />
				<div class="motion-actions"><el-tag>位置已计算</el-tag><el-tag :type="preview.trajectory?'success':'info'">{{ preview.trajectory?'机构与时间约束通过':'机构未检查' }}</el-tag></div>
				<el-alert v-if="preview.collisionReview" :title="preview.collisionReview.status==='clear-within-scope'?'适用运动段的连续包围体初查未发现冲突；完整碰撞验证仍未完成。':'当前模型或运动段不足以完成连续包围体初查。'" type="info" :closable="false" />
				<el-collapse v-if="preview.collisionReview"><el-collapse-item title="碰撞检查范围"><p v-for="item in preview.collisionReview.limitations" :key="item">{{item}}</p><p>检查对象对：{{preview.collisionReview.checkedPairs}}</p></el-collapse-item></el-collapse>
				<el-table :data="poseRows" size="small"><el-table-column prop="name" label="位置" width="115" /><el-table-column prop="position" label="世界坐标 X / Y / Z（米）" /></el-table>
				<p>蓝线仅表示取放位置之间的几何参考，不代表工具的实际执行曲线。</p>
				<p v-if="preview.trajectory">轨迹共 {{ preview.trajectory.points.length-1 }} 段，{{ preview.trajectory.points.at(-1)!.time.toFixed(2) }} 秒。</p>
				<el-collapse v-if="preview.rejections.length"><el-collapse-item :title="`候选拒绝记录（${preview.rejections.length}）`"><p v-for="(item,index) in preview.rejections" :key="index">{{ item.candidate }}：{{ item.reason }}</p></el-collapse-item></el-collapse>
				<el-button type="primary" :disabled="!preview.trajectory" @click="savePreview">{{preview.transfer?'保存为物料取放工艺':'保存为空载试运行工艺'}}</el-button>
				<small>保存后在动作流中启用。新工艺默认停用，可使用工作台撤销。</small>
			</template>
		</div>
	</el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import type { TwinMaterialSlotDefinition, TwinSceneManifest } from '../contracts';
import { validateSlotToolTargets } from '../contracts/slot-tool-targets';
import { motionDependencySnapshot } from './JointTrajectory';
import { applyPickPlacePreview, createBatchPickPlaceFlow, createStackingRecipeFlow, pickPlaceRequestErrors, previewPickPlace, type PickPlacePreview, type PickPlaceRequest } from './PickPlacePlanner';
import type { MotionSceneAccess } from './SceneSlotResolver';

const props = defineProps<{ modelValue: boolean; manifest: TwinSceneManifest; getScene: () => MotionSceneAccess | undefined }>();
const emit = defineEmits<{ (e:'update:modelValue', value:boolean):void; (e:'apply', manifest:TwinSceneManifest):void; (e:'preview', preview?:PickPlacePreview):void }>();
const clone = <T,>(value:T):T => JSON.parse(JSON.stringify(value));
const draft = ref<TwinSceneManifest>();
const request = ref<PickPlaceRequest>({ taskId:'', name:'取放工艺', sourceSlotId:'', targetSlotId:'', toolFrameId:'', axisLimits:{} });
const preview = shallowRef<PickPlacePreview>();
const fullPallet = ref(false);
const separator = ref({sourceSlotId:'',targetSlotId:'',toolFrameId:''});
const resume = ref({completedLayers:0,pendingSeparator:false});
const error = ref(''), notice = ref(''), busy = ref(false);
let baseline = '', generation = 0;
const clearPreview = () => { generation++; preview.value=undefined; emit('preview'); };
watch(()=>props.modelValue, open=>{ if(open){draft.value=clone(props.manifest);baseline=motionDependencySnapshot(props.manifest);request.value={taskId:crypto.randomUUID(),name:'取放工艺',sourceSlotId:'',targetSlotId:'',toolFrameId:'',axisLimits:{}};error.value='';notice.value='';} clearPreview(); },{immediate:true});
watch(()=>props.modelValue,open=>{if(open){fullPallet.value=false;separator.value={sourceSlotId:'',targetSlotId:'',toolFrameId:''};resume.value={completedLayers:0,pendingSeparator:false};}});
watch(()=>[draft.value,request.value,fullPallet.value,separator.value,resume.value],()=>{clearPreview();error.value='';notice.value='';},{deep:true});
watch(()=>motionDependencySnapshot(props.manifest),value=>{if(props.modelValue && value!==baseline){clearPreview();notice.value='场景已变化，请关闭后重新打开工艺卡。';}});
const sourceSlots = computed(()=>draft.value?.materialSlots?.filter(s=>s.role==='source')||[]);
const targetSlots = computed(()=>draft.value?.materialSlots?.filter(s=>['target','stack','buffer','fixture'].includes(s.role))||[]);
const selectedSlots = computed(()=>draft.value?.materialSlots?.filter(s=>[request.value.sourceSlotId,request.value.targetSlotId,...(fullPallet.value?[separator.value.sourceSlotId,separator.value.targetSlotId]:[])].includes(s.slotId))||[]);
const selectedTool = computed(()=>draft.value?.toolFrames?.find(t=>t.toolFrameId===request.value.toolFrameId));
const selectedTarget = computed(()=>draft.value?.materialSlots?.find(s=>s.slotId===request.value.targetSlotId));
const separatorMode = computed(()=>selectedTarget.value?.stackPattern?.separatorMode || (selectedTarget.value?.stackPattern?.layerMaterialRequired?'every-layer':'none'));
const separatorCount = computed(()=>{const layers=selectedTarget.value?.stackPattern?.layers||0;return separatorMode.value==='between-layers'?Math.max(0,layers-1):separatorMode.value==='every-layer'?layers:0;});
const resumeError = computed(()=>!fullPallet.value ? '' : resume.value.pendingSeparator && (resume.value.completedLayers<1 || resume.value.completedLayers>separatorCount.value)
	? '待补隔板必须对应一个已完成主物料层，且该层按当前配方需要隔板。'
	: resume.value.completedLayers === selectedTarget.value?.stackPattern?.layers && !resume.value.pendingSeparator
		? '配方已满层；请换托后创建新工艺。'
		: '');
const recipeError = computed(()=>{
	if (!fullPallet.value || !selectedTarget.value?.stackPattern) return '';
	const p=selectedTarget.value.stackPattern;
	if (![p.rows,p.columns,p.layers].every(n=>Number.isInteger(n)&&n>0) || p.layers>64) return '码垛配方的行、列和层数必须为有效正整数，层数最多 64。';
	if (request.value.payloadCount!==p.rows*p.columns) return `本批数量必须等于整层格位数（${p.rows*p.columns}）。`;
	if (separatorMode.value!=='none' && (![p.separatorThickness,p.layerMaterialOffsetY].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))) return '隔板厚度和层间高度偏移必须填写为非负有限数值。';
	return '';
});
const separatorTargets = computed(()=>targetSlots.value.filter(s=>s.stackPatternSlotId===request.value.targetSlotId));
const separatorTools = computed(()=>draft.value?.toolFrames?.filter(t=>t.objectId===selectedTool.value?.objectId&&t.toolFrameId!==request.value.toolFrameId)||[]);
const separatorError = computed(()=>{
	if (!fullPallet.value || separatorMode.value==='none') return '';
	const source=draft.value?.materialSlots?.find(s=>s.slotId===separator.value.sourceSlotId), target=draft.value?.materialSlots?.find(s=>s.slotId===separator.value.targetSlotId), tool=draft.value?.toolFrames?.find(t=>t.toolFrameId===separator.value.toolFrameId);
	if (!source || source.role!=='source' || !target || target.stackPatternSlotId!==request.value.targetSlotId || !tool || tool.objectId!==selectedTool.value?.objectId || tool.toolFrameId===request.value.toolFrameId) return '请选择同一桁架上的隔板来源、对应层间目标和独立隔板工具。';
	return pickPlaceRequestErrors(draft.value!,{...request.value,...separator.value,payloadCount:1,name:`${request.value.name} · 隔板`}).join('；');
});
const mainRequestError = computed(()=>draft.value ? pickPlaceRequestErrors(draft.value,request.value).join('；') : '');
const declarationErrors = computed(()=>draft.value&&selectedSlots.value.length ? validateSlotToolTargets({...draft.value,materialSlots:selectedSlots.value}) : []);
const canSaveBatchTask = computed(()=>!mainRequestError.value && !resumeError.value && !recipeError.value && !separatorError.value && (!fullPallet.value || Boolean(selectedTarget.value?.stackPattern)));
const axes = computed(()=>{const tools=[selectedTool.value,...(fullPallet.value&&separatorMode.value!=='none'?[separatorTools.value.find(t=>t.toolFrameId===separator.value.toolFrameId)]:[])].filter(Boolean);return draft.value?.actuators?.filter(a=>['linear-axis','rotary-joint'].includes(a.kind)&&tools.some(tool=>a.objectId===tool!.objectId&&(!tool!.cartesianActuatorIds||tool!.cartesianActuatorIds.includes(a.actuatorId))))||[];});
const poseRows = computed(()=>preview.value ? [ ['预取',preview.value.pick.approach], ['取料接触',preview.value.pick.contact], ['取料退出',preview.value.pick.retreat], ['预放',preview.value.place.approach], ['放料接触',preview.value.place.contact], ['放料退出',preview.value.place.retreat] ].map(([name,position])=>({name,position:(position as number[]).map(v=>v.toFixed(4)).join(' / ')})) : []);
const setNormal = (slot:TwinMaterialSlotDefinition,axis:number,value:number|undefined) => { slot.contactNormalLocal ||= [0,0,0];slot.contactNormalLocal[axis]=value ?? NaN; };
const setLimit = (id:string,key:'velocity'|'acceleration'|'jerk',value:number|undefined) => { request.value.axisLimits[id] ||= {velocity:0,acceleration:0,jerk:0};request.value.axisLimits[id][key]=value ?? 0; };
const toolForSlot = (slot:TwinMaterialSlotDefinition) => fullPallet.value&&[separator.value.sourceSlotId,separator.value.targetSlotId].includes(slot.slotId)?draft.value?.toolFrames?.find(t=>t.toolFrameId===separator.value.toolFrameId):selectedTool.value;
const addCandidate = (slot:TwinMaterialSlotDefinition) => {const tool=toolForSlot(slot);if(!tool)return;slot.toolTargets ||= [];slot.toolTargets.push({contractVersion:'slot-tool-target/1',templateId:crypto.randomUUID(),toolFrameId:tool.toolFrameId,payloadType:slot.payloadType||'',tcpOffset:[0,0,0],tcpRotation:[0,0,0],approachDistance:0,retreatDistance:0}); };
const assertCurrent = () => {if(baseline!==motionDependencySnapshot(props.manifest))throw new Error('场景已变化，请关闭后重新打开工艺卡。');};
const saveDeclarations = () => {try{assertCurrent();const errors=validateSlotToolTargets(draft.value!);if(errors.length)throw new Error(errors.map(e=>e.message).join('；'));emit('apply',clone(draft.value!));baseline=motionDependencySnapshot(draft.value!);notice.value='模板声明已应用到草稿，可撤销；请保存场景以便重开。';}catch(e){error.value=e instanceof Error?e.message:String(e);}};
const runPreview = async (motion:boolean) => {
	clearPreview();const ticket=generation;error.value='';notice.value='';busy.value=true;
	try{await nextTick();assertCurrent();const scene=props.getScene();if(!scene)throw new Error('编辑器尚未加载，请等待模型完成。');const result=previewPickPlace(draft.value!,request.value,scene,motion);if(ticket!==generation||!props.modelValue)return;preview.value=result;emit('preview',result);}
	catch(e){if(ticket===generation)error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}
};
const savePreview = () => {try{assertCurrent();if(!preview.value)return;const result=applyPickPlacePreview(draft.value!,preview.value);emit('apply',result);emit('update:modelValue',false);}catch(e){error.value=e instanceof Error?e.message:String(e);}};
const saveBatchTask = () => {try{assertCurrent();if(!canSaveBatchTask.value)throw new Error([mainRequestError.value,recipeError.value,separatorError.value,resumeError.value].filter(Boolean).join('；'));const errors=validateSlotToolTargets(draft.value!);if(errors.length)throw new Error(errors.map(e=>e.message).join('；'));const board:PickPlaceRequest={...request.value,...separator.value,payloadCount:1,name:`${request.value.name} · 隔板`};emit('apply',fullPallet.value?createStackingRecipeFlow(draft.value!,request.value,separatorMode.value==='none'?undefined:board,resume.value):createBatchPickPlaceFlow(draft.value!,request.value));emit('update:modelValue',false);}catch(e){error.value=e instanceof Error?e.message:String(e);}};
</script>

<style scoped>
.motion-card{display:grid;gap:16px;color:var(--el-text-color-primary)}.motion-card p,.motion-card small{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.motion-card .el-select{width:100%}.motion-section{display:grid;gap:10px;margin:12px 0;padding:12px;border:1px solid var(--el-border-color);border-radius:6px}.motion-vector{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.motion-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.motion-vector .el-input-number,.motion-pair .el-input-number{width:100%}.motion-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}.motion-card :deep(.el-alert__title){white-space:pre-line}.motion-card :deep(.el-table){font-variant-numeric:tabular-nums}
</style>
