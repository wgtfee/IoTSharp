<template>
  <g :transform="`translate(${config.x}, ${config.y})`" class="buffer" @click="handleClick()">

    <circle :cx="0" :cy="0" :r="config.r" 
      fill="none" 
      stroke="#ccc" 
      :stroke-width="config.r * 0.28"
      :stroke-dasharray="`${2 * Math.PI * config.r * 2 / 3} ${2 * Math.PI * config.r / 3}`"
      transform="rotate(150)"/>

    <circle v-for="i in config.n" :key="i"
      :cx="config.r * Math.cos(Math.PI * (150 + 240 * (i - 1) / (config.n - 1)) / 180)"
      :cy="config.r * Math.sin(Math.PI * (150 + 240 * (i - 1) / (config.n - 1)) / 180)"
      r="15" fill-opacity="0.3" fill="#666" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>

    <!-- 文本 -->
    <g v-if="config.textLocation" :transform="`translate(${config.width/2}, ${config.height/2})`">
      <text v-if="config.textLocation === 'u'" :y="-config.height+10">{{ config.name }}</text>
      <text v-else-if="config.textLocation === 'd'" :y="config.height">{{ config.name }}</text>
      <text v-else-if="config.textLocation === 'l'" :x="-config.width-60">{{ config.name }}</text>
      <text v-else-if="config.textLocation === 'r'" :x="config.width-10">{{ config.name }}</text>
      <text v-else>{{config.name}}</text>
    </g>
    <text v-else>{{config.name}}</text>

    <!-- 丝饼 -->
    <!-- <g v-if="info.count">
      <template v-if="config.direction.includes('u')">
        <circle v-for="i in info.count" :key="i" :cx="20" :cy="15 + (i - 1) * 30" :r="15" fill-opacity="0.1" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>
      </template>
      <template v-else-if="config.direction.includes('d')">
        <circle v-for="i in info.count" :key="i" :cx="20" :cy="config.height - (15 + (i - 1) * 30)" :r="15" fill-opacity="0.1" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>
      </template>
      <template v-else-if="config.direction.includes('l')">
        <circle v-for="i in info.count" :key="i" :cx="15 + (i - 1) * 30" :cy="20" :r="15" fill-opacity="0.1" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>
      </template>
      <template v-else-if="config.direction.includes('r')">
        <circle v-for="i in info.count" :key="i" :cx="config.width - (15 + (i - 1) * 30)" :cy="20" :r="15" fill-opacity="0.1" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/>
      </template>
    </g> -->

  </g>
</template>

<script setup lang="ts">
import { inject } from 'vue';

defineOptions({ name: 'YtBuffer' });

interface UnitInfo { name?: string; status?: string; }
const props = withDefaults(defineProps<{
  config: Record<string, any>;
  info?: UnitInfo;
}>(), {
  info: () => ({}),
});

const openDialog = inject<(data: UnitInfo) => void>('openBufferDialog', () => undefined);
const handleClick = () => openDialog({ name: props.info.name || props.config.name, status: props.info.status || '正常' });
</script>

<style scoped>
.buffer {
  cursor: pointer;
}
.buffer:hover circle:nth-of-type(n+2) {
  stroke: #2563eb;
  stroke-width: 3;
}

</style>
