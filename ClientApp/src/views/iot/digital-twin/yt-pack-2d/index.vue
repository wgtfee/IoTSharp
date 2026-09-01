<template>
  <div class="layout">
    <header class="scene-toolbar">
      <div>
        <small>YT PACK 2D</small>
        <strong>亚特包装线 2D 场景</strong>
        <span>SVG 工艺总览 · 滚轮缩放 · 中键拖动画布 · 点击设备查看状态</span>
      </div>
      <div class="scene-toolbar__actions">
        <el-button-group size="small">
          <el-button @click="zoomBy(0.85)">放大</el-button>
          <el-button @click="zoomBy(1.18)">缩小</el-button>
          <el-button @click="resetView">复位</el-button>
        </el-button-group>
        <el-button size="small" @click="router.push('/iot/digital-twin/workbench')">三维场景</el-button>
      </div>
    </header>
    <div class="scene-canvas">
    <svg ref="canvas" class="svgContainer" preserveAspectRatio="xMidYMid meet" 
      :viewBox="`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`"
      @wheel.prevent="handleWheel"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
      @mouseleave="handleMouseUp">

      <line-1 :x="3120" :y="1200" :small-conveyer-info-list="processedConveyerInfoList" :robot-info-list="robotInfoList"/>

      <line-2 :x="1800" :y="1200" :small-conveyer-info-list="smallConveyerInfoList" :robot-info-list="robotInfoList"/>

      <line-3 :x="100" :y="1000" />

    </svg>
    <div class="scene-coordinate">VIEWBOX {{ Math.round(viewBox.x) }}, {{ Math.round(viewBox.y) }} · {{ Math.round(viewBox.w) }} × {{ Math.round(viewBox.h) }}</div>
    </div>

    
    <!-- 弹窗 -->
    <div>
      <!-- 小棍道弹窗 -->
      <el-dialog v-model="smallConveyerDialogVisible" class="smallConveyerDialog" :title="`小辊道 · ${smallConveyerDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>方向：{{smallConveyerDialogData.direction}}</div>
        <div>数量：{{smallConveyerDialogData.count}}</div>
        <div>状态：{{smallConveyerDialogData.status}}</div>
      </el-dialog>

      <!-- 丝车旋转台弹窗 -->
      <el-dialog v-model="turnplateDialogVisible" class="turnplateDialog" :title="`丝车旋转台 · ${turnplateDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>状态：{{turnplateDialogData.status}}</div>
      </el-dialog>

      <!-- 暂存区弹窗 -->
      <el-dialog v-model="bufferDialogVisible" class="bufferDialog" :title="`暂存区 · ${bufferDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>状态：{{bufferDialogData.status}}</div>
      </el-dialog>

      <!-- 机器手弹窗 -->
      <el-dialog v-model="robotDialogVisible" class="robotDialog" :title="`机器人 · ${robotDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>状态：{{robotDialogData.status}}</div>
      </el-dialog>
      
      <!-- 大棍道弹窗 -->
      <el-dialog v-model="bigConveyerDialogVisible" class="bigConveyerDialog" :title="`大辊道 · ${bigConveyerDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>方向：{{bigConveyerDialogData.direction}}</div>
        <div>数量：{{bigConveyerDialogData.count}}</div>
        <div>状态：{{bigConveyerDialogData.status}}</div>
      </el-dialog>
      
      <!-- 桁架弹窗 -->
      <el-dialog v-model="trussDialogVisible" class="trussDialog" :title="`桁架 · ${trussDialogData.name || '未命名'}`" width="420px" append-to-body>
        <div>状态：{{trussDialogData.status}}</div>
      </el-dialog>



    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, provide, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import Line1 from './components/line1.vue';
import Line2 from './components/line2.vue';
import Line3 from './components/line3.vue';

defineOptions({ name: 'YtPack2dScene' });

interface ViewBox { x: number; y: number; w: number; h: number }
interface EquipmentInfo { name?: string; status?: string }
interface ConveyorInfo extends EquipmentInfo { count?: number; direction?: string }

const router = useRouter();
const canvas = ref<SVGSVGElement>();
const viewBox = reactive<ViewBox>({ x: 0, y: 0, w: 4950, h: 3300 });
const minViewBox = { w: 600, h: 400 };
const maxViewBox = { w: 60000, h: 40000 };
const isDragging = ref(false);
const startPoint = reactive({ x: 0, y: 0 });
const startViewBox = reactive({ x: 0, y: 0, w: 4950, h: 3300 });

const smallConveyerInfoList = reactive<ConveyorInfo[]>([
        {name: 'L2_XGD_001', count: 6},
        {name: 'L2_XGD_002', count: 6},
        {name: 'L2_XGD_003', count: 6},
        {name: 'L2_XGD_004', count: 6},
        {name: 'L2_XGD_005', count: 6},
        {name: 'L2_XGD_006', count: 6},
        {name: 'L2_XGD_007', count: 6},
        {name: 'L2_XGD_008', count: 6},
        {name: 'L2_XGD_009', count: 6},
        {name: 'L2_XGD_010', count: 6},
        
        {name: 'L2_XGD_011', count: 6},
        {name: 'L2_XGD_012', count: 6},
        {name: 'L2_XGD_013', count: 6},
        {name: 'L2_XGD_014', count: 6},
        {name: 'L2_XGD_015', count: 6},
        {name: 'L2_XGD_016', count: 6},
        {name: 'L2_XGD_017', count: 6},
        {name: 'L2_XGD_018', count: 6},
        {name: 'L2_XGD_019', count: 6},
        {name: 'L2_XGD_020', count: 6},
        
        {name: 'L2_XGD_021', count: 3},
        {name: 'L2_XGD_022', count: 3},
        {name: 'L2_XGD_023', count: 3},
        {name: 'L2_XGD_024', count: 6},
        {name: 'L2_XGD_025', count: 15},
        {name: 'L2_XGD_026', count: 0},
        {name: 'L2_XGD_027', count: 9},
        {name: 'L2_XGD_028', count: 12},
        {name: 'L2_XGD_029', count: 12},
        {name: 'L2_XGD_030', count: 0},
        
        {name: 'L2_XGD_031', count: 12},
        {name: 'L2_XGD_032', count: 6},
        {name: 'L2_XGD_033', count: 6},
        {name: 'L2_XGD_034', count: 6},
        {name: 'L2_XGD_035', count: 9},
        {name: 'L2_XGD_036', count: 3},
        {name: 'L2_XGD_037', count: 9},
        {name: 'L2_XGD_038', count: 0},
        {name: 'L2_XGD_039', count: 9},
        {name: 'L2_XGD_040', count: 0},
        
        {name: 'L2_XGD_041', count: 9},
        {name: 'L2_XGD_0422', count: 8},
        {name: 'L2_XGD_042', count: 20},
        {name: 'L2_XGD_043', count: 10},
        {name: 'L2_XGD_044', count: 8},
        {name: 'L2_XGD_045', count: 2},
        {name: 'L2_XGD_046', count: 2},
        {name: 'L2_XGD_047', count: 8},
        {name: 'L2_XGD_048', count: 4},
        {name: 'L2_XGD_049', count: 4},
        {name: 'L2_XGD_050', count: 4},
        
        {name: 'L2_XGD_051', count: 0},
        {name: 'L2_XGD_052', count: 4},
        {name: 'L2_XGD_053', count: 4},
        {name: 'L2_XGD_054', count: 4},
        {name: 'L2_XGD_055', count: 0},
        {name: 'L2_XGD_056', count: 4},
        {name: 'L2_XGD_057', count: 4},
        {name: 'L2_XGD_058', count: 4},
        {name: 'L2_XGD_059', count: 4},
        {name: 'L2_XGD_060', count: 0},
      ]);
const robotInfoList = reactive<EquipmentInfo[]>([
        {name: 'L2_QSJQS_001'},
        {name: 'L2_QSJQS_002'},
      ]);

const smallConveyerDialogVisible = ref(false);
const smallConveyerDialogData = reactive({ name: '', count: 0, direction: '', status: '' });
const turnplateDialogVisible = ref(false);
const turnplateDialogData = reactive({ name: '', status: '' });
const bufferDialogVisible = ref(false);
const bufferDialogData = reactive({ name: '', status: '' });
const robotDialogVisible = ref(false);
const robotDialogData = reactive({ name: '', status: '' });
const bigConveyerDialogVisible = ref(false);
const bigConveyerDialogData = reactive({ name: '', count: 0, direction: '', status: '' });
const trussDialogVisible = ref(false);
const trussDialogData = reactive({ name: '', status: '' });

const processedConveyerInfoList = computed(() => {
  const result = smallConveyerInfoList.map(item => ({ ...item, count: item.count ?? 0 }));
  const redistribute = (sourceName: string, targetName: string, maximum: number) => {
    const source = result.find(item => item.name === sourceName);
    const target = result.find(item => item.name === targetName);
    if (!source || !target || source.count <= maximum) return;
    target.count += source.count - maximum;
    source.count = maximum;
  };
  redistribute('L2_XGD_031', 'L2_XGD_030', 10);
  redistribute('L2_XGD_0422', 'L2_XGD_040', 4);
  return result;
});

const openSmallConveyerDialog = (data: ConveyorInfo = {}) => {
  Object.assign(smallConveyerDialogData, {
    name: data.name || '',
    count: data.count ?? 0,
    direction: data.direction || '-',
    status: data.status || '正常',
  });
  smallConveyerDialogVisible.value = true;
};
const openTurnplateDialog = (data: EquipmentInfo = {}) => {
  Object.assign(turnplateDialogData, { name: data.name || '', status: data.status || '正常' });
  turnplateDialogVisible.value = true;
};
const openBufferDialog = (data: EquipmentInfo = {}) => {
  Object.assign(bufferDialogData, { name: data.name || '', status: data.status || '正常' });
  bufferDialogVisible.value = true;
};
const openRobotDialog = (data: EquipmentInfo = {}) => {
  Object.assign(robotDialogData, { name: data.name || '', status: data.status || '正常' });
  robotDialogVisible.value = true;
};
const openBigConveyerDialog = (data: ConveyorInfo = {}) => {
  Object.assign(bigConveyerDialogData, {
    name: data.name || '',
    count: data.count ?? 0,
    direction: data.direction || '-',
    status: data.status || '正常',
  });
  bigConveyerDialogVisible.value = true;
};
const openTrussDialog = (data: EquipmentInfo = {}) => {
  Object.assign(trussDialogData, { name: data.name || '', status: data.status || '正常' });
  trussDialogVisible.value = true;
};

provide('openSmallConveyerDialog', openSmallConveyerDialog);
provide('openTurnplateDialog', openTurnplateDialog);
provide('openBufferDialog', openBufferDialog);
provide('openRobotDialog', openRobotDialog);
provide('openBigConveyerDialog', openBigConveyerDialog);
provide('openTrussDialog', openTrussDialog);

const resetView = () => Object.assign(viewBox, { x: 0, y: 0, w: 4950, h: 3300 });
const zoomBy = (scale: number) => {
  const nextWidth = viewBox.w * scale;
  const nextHeight = viewBox.h * scale;
  if (nextWidth < minViewBox.w || nextHeight < minViewBox.h || nextWidth > maxViewBox.w || nextHeight > maxViewBox.h) return;
  const centerX = viewBox.x + viewBox.w / 2;
  const centerY = viewBox.y + viewBox.h / 2;
  Object.assign(viewBox, { x: centerX - nextWidth / 2, y: centerY - nextHeight / 2, w: nextWidth, h: nextHeight });
};
const handleWheel = (event: WheelEvent) => {
  const scale = event.deltaY > 0 ? 1.1 : 0.9;
  const nextWidth = viewBox.w * scale;
  const nextHeight = viewBox.h * scale;
  if (nextWidth < minViewBox.w || nextHeight < minViewBox.h || nextWidth > maxViewBox.w || nextHeight > maxViewBox.h) return;
  const bounds = canvas.value?.getBoundingClientRect();
  if (!bounds) return;
  const mouseX = (event.clientX - bounds.left) / Math.max(bounds.width, 1) * viewBox.w + viewBox.x;
  const mouseY = (event.clientY - bounds.top) / Math.max(bounds.height, 1) * viewBox.h + viewBox.y;
  viewBox.x = mouseX - (mouseX - viewBox.x) * scale;
  viewBox.y = mouseY - (mouseY - viewBox.y) * scale;
  viewBox.w = nextWidth;
  viewBox.h = nextHeight;
};
const handleMouseDown = (event: MouseEvent) => {
  if (event.button !== 1) return;
  event.preventDefault();
  isDragging.value = true;
  Object.assign(startPoint, { x: event.clientX, y: event.clientY });
  Object.assign(startViewBox, viewBox);
  if (canvas.value) canvas.value.style.cursor = 'grabbing';
};
const handleMouseMove = (event: MouseEvent) => {
  if (!isDragging.value) return;
  const bounds = canvas.value?.getBoundingClientRect();
  if (!bounds) return;
  viewBox.x = startViewBox.x - (event.clientX - startPoint.x) * (startViewBox.w / Math.max(bounds.width, 1));
  viewBox.y = startViewBox.y - (event.clientY - startPoint.y) * (startViewBox.h / Math.max(bounds.height, 1));
};
const handleMouseUp = () => {
  isDragging.value = false;
  if (canvas.value) canvas.value.style.cursor = 'default';
};
</script>

<style scoped>
.layout{
  width: 100%;
  height: calc(100vh - 132px);
  height: calc(100dvh - 132px);
  min-height: 560px;
  margin: -15px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #dbeafe;
  background: #07111f;
  user-select: none;
}
.scene-toolbar{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 72px;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(148,163,184,.2);
  background: #07111f;
}
.scene-toolbar>div:first-child{display:flex;flex-direction:column;gap:3px}
.scene-toolbar small{font-size:10px;font-weight:800;letter-spacing:.16em;color:#38bdf8}
.scene-toolbar strong{font-size:18px;color:#f8fafc}
.scene-toolbar span{font-size:11px;color:#8da2bb}
.scene-toolbar__actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.scene-canvas{
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.svgContainer{
  width: 100%;
  height: 100%;
  cursor: default;
  background: #f8fafc;
  touch-action: none;
}
.svgContainer text{font-family:Inter,"Microsoft YaHei",sans-serif;fill:#334155}
.scene-coordinate{
  position:absolute;
  right:14px;
  bottom:12px;
  padding:5px 8px;
  border:1px solid rgba(56,189,248,.24);
  border-radius:7px;
  color:#94a3b8;
  background:rgba(7,17,31,.86);
  font:10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;
  pointer-events:none;
}



</style>
