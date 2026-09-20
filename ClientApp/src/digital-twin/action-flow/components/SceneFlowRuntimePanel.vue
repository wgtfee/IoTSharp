<template>
	<section class="scene-flow-runtime" aria-label="三维动作流运行状态">
		<div class="scene-flow-runtime__controls">
			<el-tag type="success">真实三维联动 · Simulation</el-tag>
			<el-button size="small" type="primary" @click="$emit('control', 'start')">按当前图重新运行</el-button>
			<el-button size="small" :disabled="!snapshot || ['Faulted','Completed','Created'].includes(snapshot.state)" @click="$emit('control', snapshot?.state === 'Paused' ? 'resume' : 'pause')">{{ snapshot?.state === 'Paused' ? '继续整线' : '暂停整线' }}</el-button>
			<el-button size="small" :disabled="!snapshot" @click="$emit('control', 'reset')">整线复位</el-button>
			<span role="status">{{ snapshot?.state || '尚未运行' }} · {{ (snapshot?.clockSeconds || 0).toFixed(1) }} s</span>
		</div>
		<p>画布高亮来自三维运行器。修改后请重新运行；保存草稿并发布后，场景中心才会使用新流程。此流程不会下发 PLC 命令。</p>
		<p v-if="snapshot?.fault" role="alert" class="scene-flow-runtime__fault">{{ snapshot.fault }}</p>
		<div v-if="snapshot" class="scene-flow-runtime__events"><span v-for="event in snapshot.events.slice(-4)" :key="event.sequence">#{{ event.sequence }} {{ event.type }} {{ event.nodeId }}</span></div>
	</section>
</template>
<script setup lang="ts">
import type { SimulationFlowRuntimeSnapshot } from '../runtime/SimulationFlowRuntime';
defineProps<{ snapshot?: SimulationFlowRuntimeSnapshot }>();
defineEmits<{ (event: 'control', command: 'start' | 'pause' | 'resume' | 'reset'): void }>();
</script>
<style scoped>
.scene-flow-runtime{border-top:1px solid var(--el-border-color);padding:10px;background:var(--el-bg-color)}
.scene-flow-runtime__controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.scene-flow-runtime p{font-size:12px;margin:8px 0 0;color:var(--el-text-color-secondary)}
.scene-flow-runtime .scene-flow-runtime__fault{color:var(--el-color-danger)}.scene-flow-runtime__events{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;margin-top:6px}
</style>
