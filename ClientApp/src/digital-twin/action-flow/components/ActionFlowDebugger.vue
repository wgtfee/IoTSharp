<template>
	<section class="af-debugger">
		<div class="af-debugger__controls">
			<el-radio-group :model-value="mode" size="small" @change="$emit('mode', $event as RuntimeMode)">
				<el-radio-button value="simulation">Simulation</el-radio-button>
				<el-radio-button value="live">Live</el-radio-button>
			</el-radio-group>
			<el-button size="small" type="success" @click="$emit('start')">{{ mode === 'live' ? '启动 Live Run' : '开始模拟' }}</el-button>
			<el-button size="small" :disabled="!snapshot" @click="$emit(snapshot?.state === 'Paused' ? 'resume' : 'pause')">{{ snapshot?.state === 'Paused' ? '继续' : '暂停' }}</el-button>
			<el-button v-if="mode === 'simulation'" size="small" @click="$emit('step')">单步</el-button>
			<el-button size="small" type="danger" plain :disabled="!snapshot" @click="$emit('stop')">{{ mode === 'live' ? '取消 Run' : '停止' }}</el-button>
			<el-select v-if="mode === 'simulation'" :model-value="snapshot?.speed || 1" size="small" style="width:90px" @change="$emit('speed', Number($event))"><el-option v-for="x in [.25,.5,1,2,5]" :key="x" :label="`${x}x`" :value="x" /></el-select>
			<el-tag size="small" :type="snapshot?.state === 'Faulted' ? 'danger' : snapshot?.state === 'Completed' ? 'success' : 'info'">{{ snapshot?.state || 'Created' }}</el-tag>
			<el-tag v-if="mode === 'live'" size="small" :type="connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : 'info'">{{ connectionState }}</el-tag>
			<span>Seq {{ snapshot?.sequence || 0 }}<template v-if="mode === 'simulation'"> · {{ (snapshot?.clockSeconds || 0).toFixed(1) }}s</template></span>
		</div>
		<div class="af-debugger__body">
			<div v-if="mode === 'simulation'"><strong>信号注入（Simulation）</strong><div class="af-debugger__signal"><el-input v-model="signalKey" size="small" placeholder="bindingId"/><el-input v-model="signalValue" size="small" placeholder="true / 1 / text"/><el-button size="small" @click="inject">注入</el-button></div></div>
			<div v-else><strong>Live 人工处置</strong><small>Live 信号由遥测/设备桥接进入，页面不直接写 PLC。</small><div v-if="manualSteps.length" class="af-debugger__action"><el-select v-model="manualStepId" size="small" placeholder="待人工确认步骤"><el-option v-for="item in manualSteps" :key="item.stepInstanceId" :label="item.label" :value="item.stepInstanceId" /></el-select><el-input v-model="manualReason" size="small" placeholder="确认原因（必填）"/><el-button size="small" type="primary" @click="confirmManual">确认</el-button></div><div v-if="failedSteps.length" class="af-debugger__action"><el-select v-model="retryStepId" size="small" placeholder="失败步骤"><el-option v-for="item in failedSteps" :key="item.stepInstanceId" :label="item.label" :value="item.stepInstanceId" /></el-select><el-input v-model="retryReason" size="small" placeholder="重试原因"/><el-button size="small" type="warning" @click="retryFailed">重试</el-button></div><small v-if="!manualSteps.length && !failedSteps.length">当前没有需要人工确认或重试的步骤。</small></div>
			<div><strong>资源锁</strong><small>{{ snapshot?.reservations.length || 0 }} 个</small><code v-for="r in snapshot?.reservations || []" :key="r.reservationId">{{ r.resourceType }}:{{ r.resourceId }}</code></div>
			<div><strong>物料归属</strong><small>{{ snapshot?.materials.length || 0 }} 个</small><code v-for="m in (snapshot?.materials || []).slice(0,5)" :key="m.materialInstanceId">{{ m.materialInstanceId }} → {{ m.ownerType }}:{{ m.ownerId }}</code></div>
			<div><strong>最近事件</strong><code v-for="e in (snapshot?.events || []).slice(-6).reverse()" :key="e.sequence">#{{ e.sequence }} {{ e.type }} {{ e.nodeId || '' }}</code></div>
		</div>
	</section>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { SimulationFlowRuntimeSnapshot } from '../runtime/SimulationFlowRuntime';
import type { LiveFlowRuntimeSnapshot } from '../runtime/LiveFlowRuntimeClient';

export type RuntimeMode = 'simulation' | 'live';
export interface RuntimeStepChoice { stepInstanceId: string; nodeId: string; label: string }

const props = withDefaults(defineProps<{ snapshot?: SimulationFlowRuntimeSnapshot | LiveFlowRuntimeSnapshot; mode?: RuntimeMode; connectionState?: string; manualSteps?: RuntimeStepChoice[]; failedSteps?: RuntimeStepChoice[] }>(), { mode: 'simulation', connectionState: 'disconnected', manualSteps: () => [], failedSteps: () => [] });
const emit = defineEmits<{ (e:'mode',v:RuntimeMode):void; (e:'start'):void; (e:'pause'):void; (e:'resume'):void; (e:'step'):void; (e:'stop'):void; (e:'speed',v:number):void; (e:'signal',key:string,value:unknown):void; (e:'manual-confirm',stepInstanceId:string,reason:string):void; (e:'retry',stepInstanceId:string,reason:string):void }>();
const signalKey = ref(''), signalValue = ref('true');
const manualStepId = ref(''), manualReason = ref('');
const retryStepId = ref(''), retryReason = ref('设计器人工重试');
watch(() => props.manualSteps, items => { if (!items.some(item => item.stepInstanceId === manualStepId.value)) manualStepId.value = items[0]?.stepInstanceId || ''; }, { immediate: true, deep: true });
watch(() => props.failedSteps, items => { if (!items.some(item => item.stepInstanceId === retryStepId.value)) retryStepId.value = items[0]?.stepInstanceId || ''; }, { immediate: true, deep: true });
const parse = (s:string) => { if (s === 'true') return true; if (s === 'false') return false; if (s !== '' && !Number.isNaN(Number(s))) return Number(s); try { return JSON.parse(s); } catch { return s; } };
const inject = () => { if (signalKey.value.trim()) emit('signal', signalKey.value.trim(), parse(signalValue.value)); };
const confirmManual = () => { if (manualStepId.value && manualReason.value.trim()) { emit('manual-confirm', manualStepId.value, manualReason.value.trim()); manualReason.value = ''; } };
const retryFailed = () => { if (retryStepId.value) emit('retry', retryStepId.value, retryReason.value.trim()); };
</script>
<style scoped>.af-debugger{border-top:1px solid var(--el-border-color);padding:8px 10px;background:var(--el-bg-color)}.af-debugger__controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px}.af-debugger__body{display:grid;grid-template-columns:1.3fr 1fr 1fr 1.3fr;gap:10px;margin-top:7px}.af-debugger__body>div{min-width:0;display:flex;flex-direction:column;gap:3px}.af-debugger__body strong{font-size:11px}.af-debugger__body small,.af-debugger__body code{font-size:10px;color:var(--el-text-color-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.af-debugger__signal,.af-debugger__action{display:grid;grid-template-columns:1fr 1fr auto;gap:4px}@media(max-width:1200px){.af-debugger__body{grid-template-columns:1fr 1fr}}</style>
