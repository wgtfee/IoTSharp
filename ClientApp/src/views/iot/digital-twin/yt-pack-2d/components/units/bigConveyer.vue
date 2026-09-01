<template>
  <g :transform="`translate(${config.x}, ${config.y})`" class="bigConveyer" @click="handleClick()">

    <!-- 辊道 -->
    <rect :height="config.height" :width="config.width" :rx="config.rx" stroke="#666" fill="#ccc"/>

    <!-- 外边 -->
    <!-- <g v-if="config.border" fill="#555">
      <rect v-if="config.border.includes('u')" :x="0" :y="-5" :width="config.width" :height="5" :rx="1"/>
      <rect v-if="config.border.includes('d')" :x="0" :y="config.height" :width="config.width" :height="5" :rx="1"/>
      <rect v-if="config.border.includes('l')" :x="-5" :y="0" :width="5" :height="config.height" :rx="1"/>
      <rect v-if="config.border.includes('r')" :x="config.width" :y="0" :width="5" :height="config.height" :rx="1"/>
    </g> -->

    <!-- 内边 -->
    <g v-if="config.border" fill="#555">
      <rect v-if="config.border.includes('u')" :x="0" :y="0" :width="config.width" :height="10"/>
      <rect v-if="config.border.includes('d')" :x="0" :y="config.height-10" :width="config.width" :height="10"/>
      <rect v-if="config.border.includes('l')" :x="0" :y="0" :width="10" :height="config.height"/>
      <rect v-if="config.border.includes('r')" :x="config.width-10" :y="0" :width="10" :height="config.height"/>
    </g>

    <!-- 箭头方向 -->
    <g v-if="config.direction" :transform="`translate(${config.width / 2}, ${config.height / 2})`" stroke="#555" stroke-width="1.5">
      <!-- <path v-if="config.direction.includes('u')" d="M 0 6 L 0 -4 M -2 -1 L 0 -4 L 2 -1"/>
      <path v-if="config.direction.includes('d')" d="M 0 -6 L 0 4 M -2 1 L 0 4 L 2 1"/>
      <path v-if="config.direction.includes('l')" d="M 6 0 L -4 0 M -1 -2 L -4 0 L -1 2"/>
      <path v-if="config.direction.includes('r')" d="M -6 0 L 4 0 M 1 -2 L 4 0 L 1 2"/> -->
      <path v-if="config.direction.includes('u')" d="M 0 0 L 0 -10 M -2 -7 L 0 -10 L 2 -7"/>
      <path v-if="config.direction.includes('d')" d="M 0 0 L 0 10 M -2 7 L 0 10 L 2 7"/>
      <path v-if="config.direction.includes('l')" d="M 0 0 L -10 0 M -7 -2 L -10 0 L -7 2"/>
      <path v-if="config.direction.includes('r')" d="M 0 0 L 10 0 M 7 -2 L 10 0 L 7 2"/>
    </g>

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

    <!-- <circle v-for="i in count" :key="i" :cx="width > height ? 15 + (i - 1) * 30 : 15" :cy="width > height ? 15 : 15 + (i - 1) * 30" :r="15" fill-opacity="0.1" stroke="#666" stroke-width="2" stroke-dasharray="5,3"/> -->

    <!-- <g v-if="direction" :transform="`translate(${width/2}, ${height/2})`">
      <path v-if="direction === 'left'" d="M 6 0 L -4 0 M -1 -2 L -4 0 L -1 2" stroke="#333" stroke-width="1.5" fill="none"/>
      <path v-else-if="direction === 'right'" d="M -6 0 L 4 0 M 1 -2 L 4 0 L 1 2" stroke="#333" stroke-width="1.5" fill="none"/>
      <path v-else-if="direction === 'up'" d="M 0 6 L 0 -4 M -2 -1 L 0 -4 L 2 -1" stroke="#333" stroke-width="1.5" fill="none"/>
      <path v-else-if="direction === 'down'" d="M 0 -6 L 0 4 M -2 1 L 0 4 L 2 1" stroke="#333" stroke-width="1.5" fill="none"/>
    </g>

    <text v-if="textLocation === 'left'" :x="width-100" :y="height/2+5">{{ name }}：{{ count }}</text>
    <text v-if="textLocation === 'right'" :x="width+10" :y="height/2+5">{{ name }}：{{ count }}</text>
    <text v-if="textLocation === 'up'" :x="width/2-30" :y="-10">{{ name }}：{{ count }}</text>
    <text v-if="textLocation === 'down'" :x="width/2-30" :y="height+20">{{ name }}：{{ count }}</text> -->
  </g>
</template>

<script setup lang="ts">
import { inject } from 'vue';

defineOptions({ name: 'YtBigConveyer' });

interface UnitInfo { name?: string; status?: string; count?: number; direction?: string; }
const props = withDefaults(defineProps<{
  config: Record<string, any>;
  info?: UnitInfo;
}>(), {
  info: () => ({}),
});

const openDialog = inject<(data: UnitInfo) => void>('openBigConveyerDialog', () => undefined);
const handleClick = () => openDialog({
  name: props.info.name || props.config.name,
  count: props.info.count ?? 0,
  direction: props.info.direction || props.config.direction || '-',
  status: props.info.status || '正常',
});
</script>

<style scoped>
.bigConveyer {
  cursor: pointer;
}
.bigConveyer:hover rect {
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
