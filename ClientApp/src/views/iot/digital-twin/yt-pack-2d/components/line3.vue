<template>
  <g :transform="`translate(${x}, ${y})`">
    
    <!-- 边框 -->
    <rect :width="4600" :height="1300" fill="none" stroke="#666"/>

    <!-- 大棍道 -->
    <BigConveyer v-for="(config, index) in bigConveyerConfigList" :key="config.name || index" :config="config" :info="{}"/>

    <!-- 栈板台 -->
    <g fill="#ccc" stroke="#666" stroke-width="4">
      <rect :x="3085" :y="-880" :width="150" :height="160" :rx="5"/>
      <rect :x="3435" :y="-880" :width="150" :height="160" :rx="5"/>
      <rect :x="3915" :y="-880" :width="150" :height="160" :rx="5"/>
      <rect :x="4265" :y="-880" :width="150" :height="160" :rx="5"/>
    </g>

    <!-- 机器手 -->
    <RobotUnit v-for="(config, index) in robotConfigList" :key="config.name || index" :config="config" :info="{}"/>

    <!-- 桁架 -->
    <TrussUnit v-for="(config, index) in trussConfigList" :key="config.name || index" :config="config" :info="{}"/>

    <!-- 半成品库 -->
    <g>
      <rect :x="0" :y="-880" :width="3000" :height="880" fill="#ccc" :rx="10" stroke="#666"/>
      <text :x="1200" :y="-400" font-size="150">半成品库</text>
    </g>


  </g>
  
  
</template>

<script setup lang="ts">
import BigConveyer from './units/bigConveyer.vue';
import RobotUnit from './units/robot.vue';
import TrussUnit from './units/truss.vue';

defineOptions({ name: 'YtPackLine3' });

interface EquipmentInfo { name?: string; status?: string }
interface ConveyorInfo extends EquipmentInfo { count?: number; direction?: string }

withDefaults(defineProps<{
  x?: number;
  y?: number;
  bigConveyerInfoList?: ConveyorInfo[];
}>(), {
  x: 0,
  y: 0,
  bigConveyerInfoList: () => [],
});

const bigConveyerConfigList = [
        {name: 'L3_DGD_001', textLocation: 'r', x: 100, y: 300, width: 90, height: 200, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_002', textLocation: 'l', x: 100, y: 190, width: 90, height: 110, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_003', textLocation: 'u', x: 100, y: 100, width: 90, height: 90, rx: 5, border: 'ul', direction: 'r',},
        
        {name: 'L3_DGD_004', textLocation: 'u', x: 190, y: 100, width: 240, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_005', textLocation: 'u', x: 430, y: 100, width: 70, height: 90, rx: 5, border: 'u', direction: 'r',},
        
        {name: 'L3_DGD_006', textLocation: 'l', x: 430, y: 190, width: 70, height: 110, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_007', textLocation: 'l', x: 430, y: 300, width: 70, height: 90, rx: 5, border: 'dl', direction: 'u',},
        
        {name: 'L3_DGD_008', textLocation: 'u', x: 500, y: 300, width: 220, height: 90, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L3_DGD_009', textLocation: 'u', x: 720, y: 300, width: 70, height: 90, rx: 5, border: 'ur', direction: 'l',},
        
        {name: 'L3_DGD_010', textLocation: 'l', x: 720, y: 390, width: 70, height: 440, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_011', textLocation: 'l', x: 720, y: 830, width: 70, height: 200, rx: 5, border: 'lr', direction: 'u',},

        
        {name: 'L3_DGD_012', textLocation: 'u', x: 500, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_013', textLocation: 'u', x: 780, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_014', textLocation: 'u', x: 1060, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_015', textLocation: 'u', x: 1340, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_016', textLocation: 'u', x: 1620, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_017', textLocation: 'u', x: 1900, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_018', textLocation: 'u', x: 2180, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_019', textLocation: 'u', x: 2460, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_020', textLocation: 'u', x: 2740, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_021', textLocation: 'u', x: 3020, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'r',},

        {name: 'L3_DGD_022', textLocation: 'd', x: 3300, y: 100, width: 70, height: 90, rx: 5, border: 'd', direction: 'u',},
        {name: 'L3_DGD_023', textLocation: 'u', x: 3370, y: 100, width: 200, height: 90, rx: 5, border: 'ud', direction: 'lr',},
        {name: 'L3_DGD_024', textLocation: 'u', x: 3570, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'lr',},
        {name: 'L3_DGD_025', textLocation: 'u', x: 3850, y: 100, width: 280, height: 90, rx: 5, border: 'ud', direction: 'lr',},
        // {name: 'L3_DGD_0251', textLocation: 'd', x: 3930, y: 100, width: 300, height: 90, rx: 5, border: 'ud', direction: 'lr',},

        {name: 'L3_DGD_026', textLocation: 'r', x: 3300, y: -700, width: 70, height: 800, rx: 5, border: 'lr', direction: 'u',},
        
        {name: 'L3_DGD_027', textLocation: 'r', x: 4130, y: 100, width: 70, height: 90, rx: 5, border: 'r', direction: 'u',},
        {name: 'L3_DGD_028', textLocation: 'r', x: 4130, y: 190, width: 70, height: 110, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_029', textLocation: 'r', x: 4130, y: 300, width: 70, height: 90, rx: 5, border: 'dr', direction: 'u',},
        {name: 'L3_DGD_030', textLocation: 'd', x: 4000, y: 300, width: 130, height: 90, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L3_DGD_031', textLocation: 'u', x: 3930, y: 300, width: 70, height: 90, rx: 5, border: 'ul', direction: 'r',},
        {name: 'L3_DGD_032', textLocation: 'r', x: 3930, y: 390, width: 70, height: 350, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_033', textLocation: 'r', x: 3930, y: 740, width: 70, height: 260, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_034', textLocation: 'r', x: 3930, y: 900, width: 70, height: 180, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L3_DGD_035', textLocation: 'r', x: 3930, y: 1080, width: 70, height: 90, rx: 5, border: 'dl', direction: 'u',},
        {name: 'L3_DGD_036', textLocation: 'r', x: 4000, y: 1080, width: 120, height: 90, rx: 5, border: 'ud', direction: 'l',},
        
        {name: 'L3_DGD_037', textLocation: 'r', x: 4130, y: -700, width: 70, height: 800, rx: 5, border: 'lr', direction: 'u',},

      ];
const robotConfigList = [
        {name: 'L3_JQS_001', x: 3335, y: -800, r: 240,},
        {name: 'L3_JQS_002', x: 4165, y: -800, r: 240,},
      ];
const trussConfigList = [
        {name: 'L2_HJ001', x: 390, y: 530, direction: 'l'},
        {name: 'L2_HJ002', x: 3730, y: 530, direction: 'r'},
      ];
</script>

<style scoped>



</style>
