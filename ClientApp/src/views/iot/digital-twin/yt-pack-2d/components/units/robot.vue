<template>
  <g :transform="`translate(${config.x}, ${config.y})`" class="robot" @click="handleClick()">
    <circle :cx="0" :cy="0" :r="config.r" fill-opacity="0.3" fill="none" stroke="#666" stroke-width="3" stroke-dasharray="5,3"/>
    <circle :cx="0" :cy="0" :r="60" fill="#ccc" stroke="#666" stroke-width="5"/>

    <text :x="0" :y="60">{{ config.name }}</text>
  </g>
</template>

<script setup lang="ts">
import { inject } from 'vue';

defineOptions({ name: 'YtRobot' });

interface UnitInfo { name?: string; status?: string; }
const props = withDefaults(defineProps<{
  config: Record<string, any>;
  info?: UnitInfo;
}>(), {
  info: () => ({}),
});

const openDialog = inject<(data: UnitInfo) => void>('openRobotDialog', () => undefined);
const handleClick = () => openDialog({ name: props.info.name || props.config.name, status: props.info.status || '正常' });
</script>

<style scoped>
.robot {
  cursor: pointer;
}
.robot:hover circle {
  stroke: #2563eb;
  stroke-width: 3;
}

.nomal{
  fill: #1ecd9b;
}
.stop{
  fill: #f6bb3c;
}
.unnomal{
  fill: #e03326;
}
.default{
  fill: #ccc;
}

</style>
