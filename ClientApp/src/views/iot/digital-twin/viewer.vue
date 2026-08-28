<template>
	<div class="twin-viewer" v-loading="loading">
		<header>
			<div><small>READ-ONLY RUNTIME</small><h3>{{ title }}</h3><span>{{ versionLabel }}</span></div>
			<div><el-button @click="router.push('/iot/digital-twin/scenes')">场景中心</el-button><el-button v-if="sceneId" @click="router.push({ path:'/iot/digital-twin/workbench', query:{ sceneId } })">编辑草稿</el-button><el-button type="primary" @click="toggleRunning">{{ running ? '暂停' : '运行' }}</el-button></div>
		</header>
		<div ref="container" class="canvas"></div>
		<div class="metrics"><span>{{ running ? 'RUNNING' : 'PAUSED' }}</span><span>{{ metrics.fps }} FPS</span><span>{{ metrics.triangles.toLocaleString('zh-CN') }} triangles</span><span v-if="metrics.silkLine">托盘 {{ metrics.silkLine.onlinePallets }} · 等待 {{ metrics.silkLine.waitingPallets }}</span></div>
		<el-alert v-if="error" class="error" :title="error" type="error" :closable="false" show-icon />
	</div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { digitalTwinApi, type DigitalTwinSceneDetail, type TwinSceneVersion } from '/@/api/digital-twin';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import { TwinRuntime } from '/@/digital-twin/runtime/TwinRuntime';

const route = useRoute(), router = useRouter();
const container = ref<HTMLDivElement>(), loading = ref(true), error = ref(''), title = ref('数字孪生场景'), versionLabel = ref('');
const sceneId = typeof route.query.sceneId === 'string' ? route.query.sceneId : '';
const running = ref(true);
const metrics = reactive<any>({ fps: 0, triangles: 0 });
let runtime: TwinRuntime | undefined;
const apiData = <T,>(response: any): T => response.data as T;

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
		versionLabel.value = `不可变发布版本 v${version.version} · 来源草稿 r${version.sourceDraftRevision}`;
	} else versionLabel.value = `草稿 r${scene.revision} · 只读预览`;
	await nextTick();
	if (!container.value) return;
	runtime = new TwinRuntime(container.value, manifest, { onMetrics: (value) => Object.assign(metrics, value), onError: (message) => { error.value = message; } });
	runtime.setRunning(true);
	await loadModels(manifest);
};
const toggleRunning = () => { running.value = !running.value; runtime?.setRunning(running.value); };
onMounted(async () => { try { await load(); } catch (reason: any) { error.value = reason?.msg || reason?.message || '场景加载失败'; } finally { loading.value = false; } });
onBeforeUnmount(() => { runtime?.dispose(); runtime = undefined; });
</script>

<style scoped lang="scss">
.twin-viewer{position:relative;height:calc(100vh - 132px);min-height:620px;margin:-15px;overflow:hidden;background:#050c16}.twin-viewer header{position:absolute;z-index:5;top:0;right:0;left:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:13px 18px;border-bottom:1px solid rgba(148,163,184,.2);color:#dbeafe;background:rgba(7,17,31,.92);backdrop-filter:blur(10px)}header h3{margin:2px 0;color:#f8fafc}header small{color:#38bdf8;letter-spacing:.14em}header span{font-size:11px;color:#8ea6bf}.canvas{position:absolute;inset:0}.canvas :deep(canvas){display:block;width:100%;height:100%}.metrics{position:absolute;right:18px;bottom:18px;display:flex;gap:12px;padding:9px 12px;border:1px solid rgba(56,189,248,.28);border-radius:10px;color:#bae6fd;background:rgba(3,10,19,.86);font-size:11px}.error{position:absolute;top:90px;left:50%;z-index:6;width:min(680px,80%);transform:translateX(-50%)}
</style>
