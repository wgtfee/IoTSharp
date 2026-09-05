<template>
	<div class="twin-viewer" v-loading="loading">
		<header>
			<div><small>READ-ONLY RUNTIME</small><h3>{{ title }}</h3><span>{{ versionLabel }}</span></div>
			<div><el-button @click="router.push('/iot/digital-twin/scenes')">场景中心</el-button><el-button v-if="sceneId" @click="router.push({ path:'/iot/digital-twin/workbench', query:{ sceneId } })">编辑草稿</el-button><el-button type="primary" @click="toggleRunning">{{ running ? '暂停' : '运行' }}</el-button></div>
		</header>
		<div ref="container" class="canvas"></div>
		<div class="metrics"><span>{{ running ? 'RUNNING' : 'PAUSED' }}</span><span>{{ metrics.fps }} FPS</span><span>{{ metrics.triangles.toLocaleString('zh-CN') }} triangles</span><span v-if="metrics.silkLine">托盘 {{ metrics.silkLine.onlinePallets }} · 等待 {{ metrics.silkLine.waitingPallets }}</span></div>
		<el-alert v-if="error" class="error" :title="error" type="error" :closable="false" show-icon />
		<div v-if="statusVisible && selected && statusAnchor.visible" class="object-status-card" :class="`is-${statusCardPlacement.side}`" :style="statusCardPlacement.cardStyle" @pointerdown.stop @click.stop>
			<div class="object-status-card__arrow" :style="statusCardPlacement.arrowStyle" />
			<div class="object-status-card__head"><div><small>OBJECT STATUS</small><strong>{{ selected.name || '运行对象' }}</strong><span>{{ selected.entityId || selected.equipmentId || selected.objectId || selected.nodePath }}</span></div><div class="object-status-card__actions"><el-tag :type="selectedStatus.type" effect="dark" size="small">{{ selectedStatus.label }}</el-tag><button type="button" title="关闭" @click="statusVisible=false">×</button></div></div>
			<div class="object-status-card__grid"><div><label>信号</label><b>{{ signalSummary }}</b></div><div><label>位置</label><b>{{ positionText }}</b></div><div><label>类型</label><b>{{ selected.entityType || selected.equipmentType || selected.kind || '-' }}</b></div><div><label>更新</label><b>{{ latestTimestamp }}</b></div></div>
			<div v-if="bindingRows.length" class="object-status-card__signals"><div v-for="row in bindingRows.slice(0,4)" :key="row.key"><span>{{ row.key }}</span><code>{{ row.value }}</code><i :class="`is-${row.quality}`">{{ row.quality }}</i></div><small v-if="bindingRows.length>4">另有 {{ bindingRows.length-4 }} 条点位</small></div>
			<div v-else class="object-status-card__empty">当前对象未绑定持久化信号</div>
			<div v-if="runtimeSummaryRows.length" class="object-status-card__summary"><div v-for="row in runtimeSummaryRows" :key="row.label"><label>{{ row.label }}</label><b>{{ row.value }}</b></div></div>
			<pre v-if="runtimeDetail" class="runtime-detail">{{ runtimeDetail }}</pre>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { digitalTwinApi, type DigitalTwinSceneDetail, type TwinDataUpdate, type TwinRuntimeSnapshot, type TwinSceneVersion } from '/@/api/digital-twin';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import { TwinRuntime, type TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';
import { buildRuntimeStatusCardPlacement, buildRuntimeSummaryRows } from '/@/digital-twin/runtime/RuntimeStatusUiSupport';

const route = useRoute(), router = useRouter();
const container = ref<HTMLDivElement>(), loading = ref(true), error = ref(''), title = ref('数字孪生场景'), versionLabel = ref('');
const sceneId = typeof route.query.sceneId === 'string' ? route.query.sceneId : '';
const running = ref(true);
const metrics = reactive<any>({ fps: 0, triangles: 0 });
const statusVisible = ref(false), selected = ref<TwinSelectionInfo | null>(null), versionNo = ref(0), manifestRef = ref<TwinSceneManifest>();
const latestUpdates = ref<Record<string, TwinDataUpdate>>({});
let runtime: TwinRuntime | undefined;
let pollTimer: number | undefined;
let anchorFrame = 0;
const statusAnchor = reactive({ x:0, y:0, width:1, height:1, visible:false });
const apiData = <T,>(response: any): T => response.data as T;
const selectedBindings = computed(() => selected.value?.objectId ? (manifestRef.value?.bindings || []).filter((binding) => binding.objectId === selected.value?.objectId) : []);
const bindingRows = computed(() => selectedBindings.value.map((binding) => {
	const update = latestUpdates.value[binding.bindingId];
	return { key: `${binding.source.kind} · ${binding.source.key || '-'}`, device: binding.source.deviceId || '-', value: update ? formatValue(update.value) : '等待数据', quality: update ? (update.stale ? 'stale' : update.quality) : 'waiting', timestamp: update?.sourceTimestamp ? new Date(update.sourceTimestamp).toLocaleString('zh-CN',{hour12:false}) : '-' };
}));
const signalSummary = computed(() => bindingRows.value.length ? `${bindingRows.value.filter(row => row.quality !== 'waiting').length}/${bindingRows.value.length} 条已收到` : selected.value?.runtimeData ? '内部运行数据可用 · 无持久化点位' : '未绑定信号');
const positionText = computed(() => selected.value?.worldPosition ? `X ${selected.value.worldPosition[0].toFixed(2)} · Y ${selected.value.worldPosition[1].toFixed(2)} · Z ${selected.value.worldPosition[2].toFixed(2)} m` : '-');
const runtimeDetail = computed(() => selected.value?.runtimeData ? JSON.stringify(selected.value.runtimeData,null,2) : '');
const runtimeSummaryRows = computed(() => buildRuntimeSummaryRows(selected.value?.runtimeData));
const latestTimestamp = computed(() => { const values=bindingRows.value.map(row=>row.timestamp).filter(value=>value&&value!=='-').sort(); return values.at(-1)||'-'; });
const selectedStatus = computed<{label:string;type:'success'|'warning'|'danger'|'info'}>(() => { const qualities=bindingRows.value.map(row=>row.quality); if(qualities.some(q=>['bad','missing','stale'].includes(q)))return{label:'数据异常',type:'danger'};if(bindingRows.value.length&&!qualities.includes('waiting'))return{label:'信号正常',type:'success'};if(selected.value?.runtimeData)return{label:'运行中',type:'success'};return bindingRows.value.length?{label:'等待数据',type:'warning'}:{label:'未绑定',type:'info'}; });
const statusCardPlacement = computed(() => buildRuntimeStatusCardPlacement(statusAnchor, 344, 18, 88));
const formatValue=(value:unknown)=>{if(value===null||value===undefined)return '-';if(typeof value==='object'){try{return JSON.stringify(value)}catch{return String(value)}}return String(value)};
const updateStatusAnchor=()=>{
	const anchor=runtime?.getSelectionScreenAnchor();
	if(anchor){Object.assign(statusAnchor,anchor);if(selected.value)selected.value.worldPosition=anchor.worldPosition}
	else statusAnchor.visible=false;
	anchorFrame=requestAnimationFrame(updateStatusAnchor);
};

const loadModels = async (manifest: TwinSceneManifest) => {
	if (!runtime) return;
	for (const object of manifest.objects.filter((item) => item.kind === 'model' && item.resourceId)) {
		try {
			const resource = manifest.resources.find((item) => item.resourceId === object.resourceId);
			const response: any = await digitalTwinApi.downloadModel(object.resourceId!);
			await runtime.loadGlbBuffer(object.objectId, resource?.sourceFileName || `${object.name}.glb`, response?.data instanceof ArrayBuffer ? response.data : response);
		} catch (reason: any) { error.value = `模型 ${object.name} 加载失败：${reason?.msg || reason?.message || '未知错误'}`; }
	}
};

const load = async () => {
	if (!sceneId) { error.value = '缺少 sceneId'; return; }
	const scene = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(sceneId));
	title.value = scene.name;
	let manifest: TwinSceneManifest = scene.draftPayload;
	const requestedVersion = Number(route.query.version || 0);
	if (requestedVersion > 0) {
		const version = apiData<TwinSceneVersion>(await digitalTwinApi.getVersion(sceneId, requestedVersion));
		if (!version.manifest) throw new Error('发布版本未返回 Manifest');
		manifest = version.manifest;
		versionNo.value = version.version;
		versionLabel.value = `不可变发布版本 v${version.version} · 来源草稿 r${version.sourceDraftRevision}`;
	} else { versionNo.value = scene.publishedVersion || 0; versionLabel.value = `草稿 r${scene.revision} · 只读预览`; }
	manifestRef.value = structuredClone(manifest);
	await nextTick();
	if (!container.value) return;
	runtime = new TwinRuntime(container.value, manifest, { onSelectionChange: (value) => { selected.value=value; statusVisible.value=Boolean(value?.kind && value.kind!=='route-point'); }, onMetrics: (value) => Object.assign(metrics, value), onError: (message) => { error.value = message; } }, { readOnly: true });
	runtime.setRunning(true);
	if(!anchorFrame)anchorFrame=requestAnimationFrame(updateStatusAnchor);
	await loadModels(manifest);
	startPolling();
};
const poll = async () => { if(!sceneId)return;try{const snapshot=apiData<TwinRuntimeSnapshot>(await digitalTwinApi.snapshot(sceneId,versionNo.value||undefined));const updates=snapshot?.updates||[];latestUpdates.value=Object.fromEntries(updates.map(update=>[update.bindingId,update]));runtime?.applyDataUpdates(updates)}catch{/* 下一轮重试 */} };
const startPolling=()=>{stopPolling();void poll();pollTimer=window.setInterval(poll,1000)};
const stopPolling=()=>{if(pollTimer!==undefined)window.clearInterval(pollTimer);pollTimer=undefined};
const toggleRunning = () => { running.value = !running.value; runtime?.setRunning(running.value); };
onMounted(async () => { try { await load(); } catch (reason: any) { error.value = reason?.msg || reason?.message || '场景加载失败'; } finally { loading.value = false; } });
onBeforeUnmount(() => { stopPolling(); if(anchorFrame)cancelAnimationFrame(anchorFrame);anchorFrame=0; runtime?.dispose(); runtime = undefined; });
</script>

<style scoped lang="scss">
.twin-viewer{position:relative;height:calc(100vh - 132px);min-height:620px;margin:-15px;overflow:hidden;background:#050c16}.twin-viewer header{position:absolute;z-index:5;top:0;right:0;left:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:13px 18px;border-bottom:1px solid rgba(148,163,184,.2);color:#dbeafe;background:rgba(7,17,31,.92);backdrop-filter:blur(10px)}header h3{margin:2px 0;color:#f8fafc}header small{color:#38bdf8;letter-spacing:.14em}header span{font-size:11px;color:#8ea6bf}.canvas{position:absolute;inset:0}.canvas :deep(canvas){display:block;width:100%;height:100%}.metrics{position:absolute;right:18px;bottom:18px;display:flex;gap:12px;padding:9px 12px;border:1px solid rgba(56,189,248,.28);border-radius:10px;color:#bae6fd;background:rgba(3,10,19,.86);font-size:11px}.error{position:absolute;top:90px;left:50%;z-index:6;width:min(680px,80%);transform:translateX(-50%)}
.object-status-card{position:absolute;z-index:9;width:344px;padding:12px;border:1px solid rgba(56,189,248,.42);border-radius:12px;background:rgba(5,16,29,.94);box-shadow:0 16px 42px rgba(0,0,0,.48),0 0 0 1px rgba(56,189,248,.08) inset;color:#dbeafe;backdrop-filter:blur(10px);pointer-events:auto}.object-status-card__arrow{position:absolute;width:13px;height:13px;background:#07111f}.object-status-card.is-above .object-status-card__arrow{bottom:-7px;border-right:1px solid rgba(56,189,248,.42);border-bottom:1px solid rgba(56,189,248,.42);transform:translateX(-50%) rotate(45deg)}.object-status-card.is-below .object-status-card__arrow{top:-7px;border-left:1px solid rgba(56,189,248,.42);border-top:1px solid rgba(56,189,248,.42);transform:translateX(-50%) rotate(45deg)}.object-status-card__head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:9px;border-bottom:1px solid rgba(148,163,184,.15)}.object-status-card__head>div:first-child{display:flex;min-width:0;flex-direction:column;gap:2px}.object-status-card__head small{font-size:8px;letter-spacing:.14em;color:#38bdf8}.object-status-card__head strong{overflow:hidden;font-size:14px;color:#f8fafc;text-overflow:ellipsis;white-space:nowrap}.object-status-card__head span{max-width:210px;overflow:hidden;font-size:9px;color:#64748b;text-overflow:ellipsis;white-space:nowrap}.object-status-card__actions{display:flex;align-items:center;gap:6px}.object-status-card__actions button{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:rgba(148,163,184,.12);color:#94a3b8;font-size:17px;cursor:pointer}.object-status-card__grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.object-status-card__grid>div{display:flex;min-width:0;flex-direction:column;gap:2px;padding:6px 7px;border-radius:7px;background:rgba(15,31,52,.72)}.object-status-card__grid label{font-size:8px;color:#64748b}.object-status-card__grid b{overflow:hidden;font-size:10px;font-weight:500;color:#cbd5e1;text-overflow:ellipsis;white-space:nowrap}.object-status-card__signals{display:grid;gap:4px;margin-top:8px}.object-status-card__signals>div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:7px;padding:5px 7px;border-radius:6px;background:rgba(15,31,52,.58);font-size:9px}.object-status-card__signals span{overflow:hidden;color:#94a3b8;text-overflow:ellipsis;white-space:nowrap}.object-status-card__signals code{color:#f8fafc}.object-status-card__signals i{font-style:normal;color:#94a3b8}.object-status-card__signals i.is-good{color:#4ade80}.object-status-card__signals i.is-stale,.object-status-card__signals i.is-waiting{color:#facc15}.object-status-card__signals i.is-bad,.object-status-card__signals i.is-missing{color:#f87171}.object-status-card__signals>small,.object-status-card__empty{margin-top:3px;font-size:9px;color:#64748b}.object-status-card__summary{display:grid;grid-template-columns:1fr 1fr;gap:4px 7px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(148,163,184,.12)}.object-status-card__summary>div{display:flex;min-width:0;justify-content:space-between;gap:7px;padding:4px 6px;border-radius:5px;background:rgba(15,31,52,.45)}.object-status-card__summary label{color:#64748b;font-size:8px}.object-status-card__summary b{overflow:hidden;color:#dbeafe;font-size:9px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.runtime-detail{max-height:92px;margin:8px 0 0;padding:7px;overflow:auto;border-radius:7px;background:#030914;color:#86efac;font-size:9px}
</style>
