<template>
	<div class="model-preview">
		<div ref="container" class="model-preview__canvas"></div>
		<div v-if="loading" class="model-preview__state">正在加载生成模型…</div>
		<div v-else-if="error" class="model-preview__state is-error">{{ error }}</div>
		<div v-else class="model-preview__metrics">{{ metrics.triangles.toLocaleString('zh-CN') }} triangles · {{ metrics.drawCalls }} calls</div>
	</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { digitalTwinApi } from '/@/api/digital-twin';
import { createDefaultTwinSceneManifest } from '/@/digital-twin/contracts';
import { TwinRuntime } from '/@/digital-twin/runtime/TwinRuntime';

const props = defineProps<{ resourceId: string; fileName?: string }>();
const container = ref<HTMLDivElement>();
const loading = ref(true);
const error = ref('');
const metrics = reactive({ triangles: 0, drawCalls: 0 });
let runtime: TwinRuntime | undefined;
let mounted = false;

const load = async () => {
	if (!mounted || !container.value || !props.resourceId) return;
	runtime?.dispose();
	runtime = undefined;
	container.value.innerHTML = '';
	loading.value = true;
	error.value = '';
	try {
		const manifest = createDefaultTwinSceneManifest();
		manifest.name = '生成模型预览';
		manifest.world.showGround = true;
		manifest.objects = [{
			objectId: 'preview-object', name: props.fileName || '生成模型', kind: 'model', resourceId: props.resourceId,
			transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
		}];
		manifest.resources = [{ resourceId: props.resourceId, name: props.fileName || '生成模型', sourceFileName: props.fileName || 'model.glb', status: 'ready' }];
		runtime = new TwinRuntime(container.value, manifest, {
			onMetrics: (value) => { metrics.triangles = value.triangles; metrics.drawCalls = value.drawCalls; },
			onError: (message) => { error.value = message; },
		});
		const response: any = await digitalTwinApi.downloadModel(props.resourceId);
		const buffer = (response?.data instanceof ArrayBuffer ? response.data : response) as ArrayBuffer;
		await runtime.loadGlbBuffer('preview-object', props.fileName || 'model.glb', buffer);
		runtime.focusSelected();
	} catch (reason: any) {
		error.value = reason?.msg || reason?.message || '生成模型预览加载失败';
	} finally {
		loading.value = false;
	}
};

onMounted(() => { mounted = true; load(); });
watch(() => props.resourceId, () => load());
onBeforeUnmount(() => { mounted = false; runtime?.dispose(); runtime = undefined; });
</script>

<style scoped lang="scss">
.model-preview{position:relative;width:100%;height:100%;min-height:360px;overflow:hidden;border-radius:14px;background:#06101d}.model-preview__canvas{position:absolute;inset:0}.model-preview__canvas :deep(canvas){display:block;width:100%;height:100%}.model-preview__state{position:absolute;inset:0;display:grid;place-items:center;color:#7dd3fc;background:rgba(6,16,29,.82)}.model-preview__state.is-error{color:#fca5a5}.model-preview__metrics{position:absolute;right:12px;bottom:12px;padding:6px 9px;border:1px solid rgba(148,163,184,.2);border-radius:8px;color:#cbd5e1;background:rgba(6,16,29,.8);font-size:11px}
</style>
