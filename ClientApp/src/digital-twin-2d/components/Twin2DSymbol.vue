<template>
	<g class="twin2d-symbol" :class="stateClasses">
		<template v-if="item.symbolKey === 'conveyor-small' || item.symbolKey === 'conveyor-large'">
			<rect x="0" y="0" :width="item.width" :height="item.height" rx="10" :fill="fill" :stroke="stroke" stroke-width="3" />
			<line v-for="n in 7" :key="n" :x1="(item.width / 8) * n" y1="8" :x2="(item.width / 8) * n" :y2="item.height - 8" stroke="rgba(226,232,240,.38)" stroke-width="3" />
			<path class="flow-marker" :d="`M 14 ${item.height / 2} H ${item.width - 14}`" fill="none" stroke="#e0f2fe" stroke-width="4" stroke-dasharray="18 14" />
		</template>
		<template v-else-if="item.symbolKey === 'turntable'">
			<circle :cx="item.width/2" :cy="item.height/2" :r="Math.max(8, Math.min(item.width,item.height)/2-5)" :fill="fill" :stroke="stroke" stroke-width="4" />
			<path :d="`M ${item.width*.25} ${item.height*.5} H ${item.width*.75} M ${item.width*.62} ${item.height*.35} L ${item.width*.78} ${item.height*.5} L ${item.width*.62} ${item.height*.65}`" fill="none" stroke="#e0f2fe" stroke-width="5" />
		</template>
		<template v-else-if="item.symbolKey === 'robot'">
			<circle :cx="item.width*.5" :cy="item.height*.72" :r="Math.max(8,item.height*.18)" :fill="fill" :stroke="stroke" stroke-width="4" />
			<path :d="`M ${item.width*.5} ${item.height*.62} L ${item.width*.42} ${item.height*.38} L ${item.width*.62} ${item.height*.25} L ${item.width*.72} ${item.height*.42}`" fill="none" stroke="#e0f2fe" stroke-width="9" stroke-linecap="round" />
		</template>
		<template v-else-if="item.symbolKey === 'gantry'">
			<path :d="`M 12 ${item.height-12} V 18 H ${item.width-12} V ${item.height-12} M 12 45 H ${item.width-12}`" fill="none" :stroke="stroke" stroke-width="8" />
			<rect :x="item.width*.42" y="38" :width="item.width*.16" :height="Math.max(18,item.height*.45)" :fill="fill" rx="6" />
		</template>
		<template v-else-if="item.symbolKey === 'buffer'">
			<rect x="0" y="0" :width="item.width" :height="item.height" rx="8" :fill="fill" :stroke="stroke" stroke-width="3" />
			<line v-for="n in 4" :key="n" :x1="item.width/5*n" y1="8" :x2="item.width/5*n" :y2="item.height-8" stroke="#c7d2fe" stroke-width="2" />
			<text v-if="runtime.occupancy !== undefined" :x="item.width/2" :y="item.height/2+5" text-anchor="middle" class="capacity-text">{{ runtime.occupancy }}/{{ runtime.capacity ?? '?' }}</text>
		</template>
		<template v-else-if="item.symbolKey === 'pallet' || item.symbolKey === 'carton'">
			<rect x="0" y="0" :width="item.width" :height="item.height" :rx="item.symbolKey==='carton'?5:2" :fill="fill" :stroke="stroke" stroke-width="3" />
			<path v-if="item.symbolKey==='pallet'" :d="`M 8 ${item.height*.35} H ${item.width-8} M 8 ${item.height*.7} H ${item.width-8}`" stroke="#f8fafc" stroke-width="2" opacity=".55" />
			<path v-else :d="`M ${item.width*.5} 0 V ${item.height} M 0 ${item.height*.28} H ${item.width}`" stroke="#f8fafc" stroke-width="2" opacity=".45" />
		</template>
		<template v-else-if="item.symbolKey === 'agv'">
			<rect x="0" y="8" :width="item.width" :height="item.height-16" rx="22" :fill="fill" :stroke="stroke" stroke-width="4" />
			<circle :cx="item.width*.22" :cy="item.height-4" r="6" fill="#020617" /><circle :cx="item.width*.78" :cy="item.height-4" r="6" fill="#020617" />
			<path :d="`M ${item.width*.25} ${item.height*.5} H ${item.width*.72} M ${item.width*.62} ${item.height*.36} L ${item.width*.78} ${item.height*.5} L ${item.width*.62} ${item.height*.64}`" fill="none" stroke="#e0f2fe" stroke-width="4" />
		</template>
		<template v-else-if="item.symbolKey === 'label'">
			<rect x="0" y="0" :width="item.width" :height="item.height" rx="6" fill="rgba(15,23,42,.65)" :stroke="stroke" stroke-width="1.5" />
			<text x="10" :y="Math.max(20,item.height/2+5)" class="label-text">{{ item.name }}</text>
		</template>
		<template v-else-if="item.symbolKey === 'custom-svg' && customSvgBody">
			<svg x="0" y="0" :width="item.width" :height="item.height" viewBox="0 0 100 100" preserveAspectRatio="none"><g v-html="customSvgBody" /></svg>
		</template>
		<template v-else>
			<rect x="0" y="0" :width="item.width" :height="item.height" rx="12" :fill="fill" :stroke="stroke" stroke-width="3" />
			<circle :cx="item.width/2" :cy="item.height*.38" :r="Math.min(item.width,item.height)*.16" fill="none" stroke="#e0f2fe" stroke-width="4" />
		</template>
		<text v-if="item.symbolKey !== 'label'" :x="item.width/2" :y="item.height-10" text-anchor="middle" class="name-text">{{ item.name }}</text>
		<g v-if="runtime.fault || runtime.blocked || runtime.waiting || runtime.quality==='stale'" class="status-badge" :transform="`translate(${Math.max(2,item.width-70)} 4)`">
			<rect width="66" height="20" rx="8" :fill="badgeColor" />
			<text x="33" y="14" text-anchor="middle">{{ runtime.statusText }}</text>
		</g>
	</g>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Twin2DObjectView } from '../types';
import type { Twin2DObjectRuntimeState } from '../runtime';
import { extractTwin2DSvgBody } from '../svg';

const props = defineProps<{ item: Twin2DObjectView; runtime?: Twin2DObjectRuntimeState }>();
const emptyRuntime: Twin2DObjectRuntimeState = { quality:'good', running:false, fault:false, visible:true, blocked:false, waiting:false, statusText:'UNBOUND', values:{} };
const runtime = computed(() => props.runtime || emptyRuntime);
const fill = computed(() => {
	if (runtime.value.fault) return '#7f1d1d';
	if (runtime.value.blocked) return '#9a3412';
	if (runtime.value.waiting) return '#0e7490';
	if (runtime.value.quality === 'stale') return '#4c1d95';
	if (runtime.value.running) return props.item.fill || '#166534';
	return props.item.fill || '#1e3a5f';
});
const stroke = computed(() => props.item.stroke || (runtime.value.fault ? '#f87171' : runtime.value.blocked ? '#fb923c' : runtime.value.running ? '#4ade80' : '#60a5fa'));
const badgeColor = computed(() => runtime.value.fault ? '#dc2626' : runtime.value.blocked ? '#ea580c' : runtime.value.waiting ? '#0891b2' : '#7c3aed');
const stateClasses = computed(() => ({ 'is-running': runtime.value.running, 'is-fault': runtime.value.fault, 'is-blocked': runtime.value.blocked, 'is-waiting': runtime.value.waiting, 'is-stale': runtime.value.quality === 'stale' }));
const customSvgBody = computed(() => props.item.customSvg ? extractTwin2DSvgBody(props.item.customSvg) : '');
</script>

<style scoped>
.twin2d-symbol{color:#e2e8f0}.name-text,.label-text{fill:#e2e8f0;font-size:13px;font-weight:600;pointer-events:none}.capacity-text{fill:#f8fafc;font-size:18px;font-weight:800}.status-badge text{fill:white;font-size:9px;font-weight:800}.is-running .flow-marker{animation:flow 1s linear infinite}.is-fault{animation:faultPulse .8s ease-in-out infinite alternate}.is-waiting{opacity:.88}.is-stale{opacity:.62}@keyframes flow{to{stroke-dashoffset:-32}}@keyframes faultPulse{to{opacity:.55}}
</style>
