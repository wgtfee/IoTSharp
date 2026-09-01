<template>
  <g :transform="`translate(${x}, ${y})`">
    <!-- <rect :width="100" :height="100"/> -->

    <!-- <rect  :width="width" :height="height" fill="none" stroke="#ccc">
      <small-conveyer v-for="(config, index) in smallConveyerConfigList" :key="config.id" :config="config" :info="smallConveyerInfoList[index]"/>

      <RobotUnit v-for="(config, index) in robotConfigList" :key="config.id" :config="config" :info="robotInfoList[index]"/>
    </rect> -->

    <!-- 边框 -->
    <rect :width="3000" :height="2000" fill="none" stroke="#666"/>

    <!-- 小棍道 -->
    <small-conveyer v-for="(config, index) in smallConveyerConfigList" :key="config.name || index" :config="config" :info="getSmallConveyerConfig(config.name) || {}"/>

    <!-- 套袋机 -->
    <rect :x="910" :y="210" :width="200" :height="120" fill="none" stroke="#666" stroke-width="5"/>
    <rect :x="1000" :y="530" :width="200" :height="120" fill="none" stroke="#666" stroke-width="5"/>

    <!-- 外检机 -->
    <rect :x="1300" :y="1000" :width="260" :height="160" fill="none" stroke="#666" stroke-width="5"/>

    <!-- 丝车旋转台 -->
    <TurnplateUnit v-for="(config, index) in turnplateConfigList" :key="config.name || index" :config="config" :info="{}"/>

    <!-- 暂存区 -->
    <BufferUnit :config="bufferConfig" :info="{}"/>

    <!-- 取丝机器手 -->
    <RobotUnit v-for="(config, index) in robotConfigList" :key="config.name || index" :config="config" :info="getRobotInfo(config.name)"/>

  </g>
  
  
</template>

<script setup lang="ts">
import BufferUnit from './units/buffer.vue';
import RobotUnit from './units/robot.vue';
import SmallConveyer from './units/smallConveyer.vue';
import TurnplateUnit from './units/turnplate.vue';

defineOptions({ name: 'YtPackLine2' });

interface EquipmentInfo { name?: string; status?: string }
interface ConveyorInfo extends EquipmentInfo { count?: number; direction?: string }

const props = withDefaults(defineProps<{
  x?: number;
  y?: number;
  smallConveyerInfoList?: ConveyorInfo[];
  robotInfoList?: EquipmentInfo[];
}>(), {
  x: 0,
  y: 0,
  smallConveyerInfoList: () => [],
  robotInfoList: () => [],
});

const smallConveyerConfigList = [
        //整体宽1400，高1300

        // 回流循环
        {name: 'L2_XGD_001', textLocation: 'u', x: 1100, y: 1300, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_002', textLocation: 'u', x: 1300, y: 1300, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_003', textLocation: 'u', x: 1500, y: 1300, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_004', textLocation: 'u', x: 1700, y: 1300, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_005', textLocation: 'u', x: 1900, y: 1300, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},

        {name: 'L2_XGD_006', textLocation: 'd', x: 1100, y: 1340, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_007', textLocation: 'd', x: 1300, y: 1340, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_008', textLocation: 'd', x: 1500, y: 1340, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_009', textLocation: 'd', x: 1700, y: 1340, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_010', textLocation: 'd', x: 1900, y: 1340, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},

        {name: 'L2_XGD_0111', textLocation: 'l', x: 1060, y: 1300, width: 40, height: 80, rx: 5, border: 'dl', direction: 'u',},
        {name: 'L2_XGD_011', textLocation: 'l', x: 1060, y: 1100, width: 40, height: 200, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0112', textLocation: 'l', x: 1060, y: 1060, width: 40, height: 40, rx: 5, border: 'ul', direction: 'r',},

        {name: 'L2_XGD_012', textLocation: 'd', x: 1100, y: 1060, width: 200, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_013', textLocation: 'd', x: 1300, y: 1060, width: 260, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_014', textLocation: 'd', x: 1560, y: 1060, width: 200, height: 40, rx: 5, border: 'ud', direction: 'r',},

        {name: 'L2_XGD_0151', textLocation: 'r', x: 1760, y: 830, width: 40, height: 80, rx: 5, border: 'ur', direction: 'u',},
        {name: 'L2_XGD_0152', textLocation: 'r', x: 1760, y: 1060, width: 40, height: 40, rx: 5, border: 'dr', direction: 'u',},
        {name: 'L2_XGD_015', textLocation: 'r', x: 1760, y: 910, width: 40, height: 150, rx: 5, border: 'lr', direction: 'u',},

        {name: 'L2_XGD_016', textLocation: 'u', x: 760, y: 830, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_017', textLocation: 'u', x: 960, y: 830, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_018', textLocation: 'u', x: 1160, y: 830, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_019', textLocation: 'u', x: 1360, y: 830, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_020', textLocation: 'u', x: 1560, y: 830, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},

        {name: 'L2_XGD_021', textLocation: 'd', x: 760, y: 870, width: 110, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_022', textLocation: 'd', x: 870, y: 870, width: 110, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_023', textLocation: 'd', x: 980, y: 870, width: 110, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_024', textLocation: 'd', x: 1090, y: 870, width: 200, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_025', textLocation: 'd', x: 1290, y: 870, width: 470, height: 40, rx: 5, border: 'ud', direction: 'l',},

        {name: 'L2_XGD_0261', textLocation: 'l', x: 720, y: 750, width: 40, height: 40, rx: 5, border: 'l', direction: 'ur',},
        {name: 'L2_XGD_026', textLocation: 'l', x: 720, y: 790, width: 40, height: 40, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0262', textLocation: 'l', x: 720, y: 830, width: 40, height: 80, rx: 5, border: 'ld', direction: 'u',},

        {name: 'L2_XGD_027', textLocation: 'u', x: 760, y: 750, width: 290, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_028', textLocation: 'u', x: 1050, y: 750, width: 380, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_029', textLocation: 'u', x: 1430, y: 750, width: 410, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_030', textLocation: 'u', x: 1840, y: 750, width: 100, height: 40, rx: 5, border: 'ud', direction: 'r',},

        {name: 'L2_XGD_0311', textLocation: 'r', x: 1940, y: 750, width: 40, height: 40, rx: 5, border: 'ur', direction: 'd',},
        {name: 'L2_XGD_031', textLocation: 'l', x: 1940, y: 790, width: 40, height: 270, rx: 5, border: 'lr', direction: 'd',},

        {name: 'L2_XGD_0321', textLocation: 'l', x: 1940, y: 1060, width: 40, height: 40, rx: 5, border: 'dl', direction: 'r',},
        {name: 'L2_XGD_032', textLocation: 'd', x: 1980, y: 1060, width: 120, height: 40, rx: 5, border: 'ud', direction: 'r',},

        {name: 'L2_XGD_0331', textLocation: 'r', x: 2100, y: 1060, width: 40, height: 40, rx: 5, border: 'r', direction: 'd',},
        {name: 'L2_XGD_033', textLocation: 'r', x: 2100, y: 1100, width: 40, height: 200, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_0332', textLocation: 'r', x: 2100, y: 1300, width: 40, height: 80, rx: 5, border: 'dr', direction: 'd',},



        {name: 'L2_XGD_0341', textLocation: 'l', x: 720, y: 530, width: 40, height: 40, rx: 5, border: 'l', direction: 'ur',},
        {name: 'L2_XGD_034', textLocation: 'l', x: 720, y: 570, width: 40, height: 180, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0351', textLocation: 'l', x: 720, y: 210, width: 40, height: 40, rx: 5, border: 'ul', direction: 'r',},
        {name: 'L2_XGD_035', textLocation: 'l', x: 720, y: 250, width: 40, height: 280, rx: 5, border: 'lr', direction: 'u',},

        // 套袋机
        {name: 'L2_XGD_036', textLocation: 'u', x: 760, y: 530, width: 160, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_0361', textLocation: 'u', x: 920, y: 530, width: 40, height: 40, rx: 5, border: 'ur', direction: 'd',},
        {name: 'L2_XGD_0371', textLocation: 'u', x: 920, y: 570, width: 40, height: 40, rx: 5, border: 'dl', direction: 'r',},
        {name: 'L2_XGD_037', textLocation: 'u', x: 960, y: 570, width: 360, height: 40, rx: 5, border: 'ud', direction: 'r',},

        // 套袋机
        {name: 'L2_XGD_038', textLocation: 'u', x: 760, y: 210, width: 80, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_0381', textLocation: 'u', x: 840, y: 210, width: 40, height: 40, rx: 5, border: 'ur', direction: 'd',},
        {name: 'L2_XGD_0391', textLocation: 'u', x: 840, y: 250, width: 40, height: 40, rx: 5, border: 'ld', direction: 'r',},
        {name: 'L2_XGD_039', textLocation: 'u', x: 880, y: 250, width: 440, height: 40, rx: 5, border: 'ud', direction: 'r',},

        {name: 'L2_XGD_040', textLocation: 'l', x: 1320, y: 100, width: 40, height: 150, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0401', textLocation: 'l', x: 1320, y: 250, width: 40, height: 40, rx: 5, border: 'r', direction: 'u',},
        {name: 'L2_XGD_041', textLocation: 'l', x: 1320, y: 290, width: 40, height: 280, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0411', textLocation: 'l', x: 1320, y: 570, width: 40, height: 40, rx: 5, border: 'dr', direction: 'u',},

        {name: 'L2_XGD_0421', textLocation: 'u', x: 1320, y: 60, width: 40, height: 40, rx: 5, border: 'ul', direction: 'r',},
        {name: 'L2_XGD_0422', textLocation: 'd', x: 1360, y: 60, width: 90, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_0423', textLocation: 'u', x: 1450, y: 60, width: 40, height: 40, rx: 5, border: 'u', direction: 'r',},
        {name: 'L2_XGD_042', textLocation: 'u', x: 1490, y: 60, width: 590, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_0424', textLocation: 'u', x: 2080, y: 60, width: 80, height: 40, rx: 5, border: 'ur', direction: 'd',},

        {name: 'L2_XGD_043', textLocation: 'r', x: 1450, y: 100, width: 40, height: 460, rx: 5, border: 'lr', direction: 'u',},
        {name: 'L2_XGD_0431', textLocation: 'd', x: 1450, y: 560, width: 40, height: 40, rx: 5, border: 'ld', direction: 'u',},

        {name: 'L2_XGD_0441', textLocation: 'u', x: 1490, y: 560, width: 190, height: 40, rx: 5, border: 'ud', direction: 'l',}, 
        {name: 'L2_XGD_0442', textLocation: 'u', x: 1680, y: 560, width: 40, height: 40, rx: 5, border: 'u', direction: 'ld',},
        {name: 'L2_XGD_044', textLocation: 'u', x: 1720, y: 560, width: 260, height: 40, rx: 5, border: 'ud', direction: 'l',},
        {name: 'L2_XGD_0443', textLocation: 'u', x: 1980, y: 560, width: 40, height: 40, rx: 5, border: 'u', direction: 'l',},
        {name: 'L2_XGD_0444', textLocation: 'u', x: 2020, y: 560, width: 60, height: 40, rx: 5, border: 'ud', direction: 'l',},
        
        {name: 'L2_XGD_045', textLocation: 'l', x: 1680, y: 600, width: 40, height: 80, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_046', textLocation: 'l', x: 1980, y: 600, width: 40, height: 80, rx: 5, border: 'lr', direction: 'u',},

        
        {name: 'L2_XGD_0471', textLocation: 'd', x: 1680, y: 680, width: 40, height: 40, rx: 5, border: 'dl', direction: 'r',},
        {name: 'L2_XGD_047', textLocation: 'd', x: 1720, y: 680, width: 260, height: 40, rx: 5, border: 'ud', direction: 'r',},
        {name: 'L2_XGD_0472', textLocation: 'd', x: 1980, y: 680, width: 40, height: 40, rx: 5, border: 'd', direction: 'ur',},
        {name: 'L2_XGD_0473', textLocation: 'd', x: 2020, y: 680, width: 60, height: 40, rx: 5, border: 'ud', direction: 'r',},



        {name: 'L2_XGD_048', textLocation: 'l', x: 2080, y: 100, width: 40, height: 180, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_049', textLocation: 'l', x: 2080, y: 280, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_050', textLocation: 'l', x: 2080, y: 420, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_0511', textLocation: 'l', x: 2080, y: 560, width: 40, height: 40, rx: 5, border: 'r', direction: 'dl',},
        {name: 'L2_XGD_051', textLocation: 'l', x: 2080, y: 600, width: 40, height: 80, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_0512', textLocation: 'l', x: 2080, y: 680, width: 40, height: 40, rx: 5, border: 'r', direction: 'd',},

        {name: 'L2_XGD_052', textLocation: 'r', x: 2120, y: 100, width: 40, height: 180, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_053', textLocation: 'r', x: 2120, y: 280, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_054', textLocation: 'r', x: 2120, y: 420, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_055', textLocation: 'r', x: 2120, y: 560, width: 40, height: 160, rx: 5, border: 'lr', direction: 'd',},



        {name: 'L2_XGD_056', textLocation: 'l', x: 2080, y: 720, width: 40, height: 160, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_057', textLocation: 'l', x: 2080, y: 880, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},

        {name: 'L2_XGD_058', textLocation: 'r', x: 2120, y: 720, width: 40, height: 160, rx: 5, border: 'lr', direction: 'd',},
        {name: 'L2_XGD_059', textLocation: 'r', x: 2120, y: 880, width: 40, height: 140, rx: 5, border: 'lr', direction: 'd',},

        {name: 'L2_XGD_060', textLocation: 'r', x: 2080, y: 1020, width: 80, height: 40, rx: 5, border: 'lr', direction: 'd',},
      ];
const robotConfigList = [
        {name: 'L2_QSJQS_001', x: 1600, y: 1550, r: 260,},
        {name: 'L2_QSJQS_002', x: 1780, y: 400, r: 200,},
      ];
const turnplateConfigList = [
        {name: 'L2_SCXZT_001', x: 1370, y: 1550, r: 130},
        {name: 'L2_SCXZT_002', x: 1830, y: 1550, r: 130},
      ];
const bufferConfig = {name: 'L2_ZCQ001', x: 1780, y: 400, r:185, n: 27};

const getSmallConveyerConfig = (name: string) => props.smallConveyerInfoList.find(item => item.name === name) || {};
const getRobotInfo = (name: string) => props.robotInfoList.find(item => item.name === name) || {};
</script>

<style scoped>
/* .robot-unit {
  cursor: pointer;
}
.robot-unit:hover circle {
  stroke: #2563eb;
  stroke-width: 3;
} */

</style>
