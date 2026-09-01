<template>
  <g :transform="`translate(${config.x}, ${config.y})`" class="truss" @click="handleClick()">

    <g v-if="config.direction === 'l'">
      <rect :x="80" :y="-70" :height="200" :width="70" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
      <rect :x="180" :y="-70" :height="200" :width="70" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
      <rect :x="310" :y="-50" :height="140" :width="110" rx="5" fill="#ccc" fill-opacity="0.5" stroke="#666" stroke-width="3"/>
      <rect :x="0" :y="0" :height="10" :width="600" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
    </g>
    <g v-else-if="config.direction === 'r'">
      <rect :x="180" :y="-50" :height="140" :width="110" rx="5" fill="#ccc" fill-opacity="0.5" stroke="#666" stroke-width="3"/>
      <rect :x="350" :y="-70" :height="200" :width="70" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
      <rect :x="450" :y="-70" :height="200" :width="70" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
      <rect :x="0" :y="0" :height="10" :width="600" rx="5" fill="#ccc" stroke="#666" stroke-width="3"/>
    </g>
    


    <text :x="0" :y="60">{{ config.name }}</text>
  </g>
</template>

<script setup lang="ts">
import { inject } from 'vue';

defineOptions({ name: 'YtTruss' });

interface UnitInfo { name?: string; status?: string; }
const props = withDefaults(defineProps<{
  config: Record<string, any>;
  info?: UnitInfo;
}>(), {
  info: () => ({}),
});

const openDialog = inject<(data: UnitInfo) => void>('openTrussDialog', () => undefined);
const handleClick = () => openDialog({ name: props.info.name || props.config.name, status: props.info.status || '正常' });
</script>

<style scoped>
.truss {
  cursor: pointer;
}
.truss:hover rect {
  stroke: #2563eb;
  stroke-width: 3;
}

</style>
