<template>
  <g :transform="`translate(${config.x}, ${config.y})`" class="turnplate" @click="handleClick()">
    <rect :x="-30" :y="-config.r+5" :height="2*config.r-10" :width="60" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
    <circle :cx="0" :cy="0" :r="config.r" fill="none" fill-opacity="0.3" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>

    <text :x="0" :y="60">{{ config.name }}</text>
  </g>
</template>

<script setup lang="ts">
import { inject } from 'vue';

defineOptions({ name: 'YtTurnplate' });

interface UnitInfo { name?: string; status?: string; }
const props = withDefaults(defineProps<{
  config: Record<string, any>;
  info?: UnitInfo;
}>(), {
  info: () => ({}),
});

const openDialog = inject<(data: UnitInfo) => void>('openTurnplateDialog', () => undefined);
const handleClick = () => openDialog({ name: props.info.name || props.config.name, status: props.info.status || '正常' });
</script>

<style scoped>
.turnplate {
  cursor: pointer;
}
.turnplate:hover circle {
  stroke: #2563eb;
  stroke-width: 3;
}
.turnplate:hover rect {
  stroke: #2563eb;
  stroke-width: 3;
}

</style>
