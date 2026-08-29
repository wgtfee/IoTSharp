<template>
	<div class="scene-center" v-loading="loading">
		<header>
			<div><small>DIGITAL TWIN GOVERNANCE</small><h2>数字孪生场景中心</h2><p>草稿、发布版本和线上运行清单分离管理。</p></div>
			<div><el-button @click="loadScenes">刷新</el-button><el-button type="primary" @click="router.push('/iot/digital-twin/workbench')">新建 / 编辑场景</el-button></div>
		</header>
		<el-empty v-if="!loading && scenes.length === 0" description="暂无数据库场景" />
		<div v-else class="scene-grid">
			<article v-for="scene in scenes" :key="scene.id">
				<div class="scene-title"><div><small>{{ scene.sceneKey }}</small><h3>{{ scene.name }}</h3></div><el-tag :type="publicationState(scene).type">{{ publicationState(scene).label }}</el-tag></div>
				<p>{{ scene.description || '暂无描述' }}</p>
				<dl><div><dt>根 Asset</dt><dd>{{ scene.rootAssetName || scene.rootAssetId }}</dd></div><div><dt>草稿</dt><dd>r{{ scene.revision }}</dd></div><div><dt>线上版本</dt><dd>{{ scene.publishedVersion ? `v${scene.publishedVersion}` : '未发布' }}</dd></div><div><dt>更新时间</dt><dd>{{ formatDate(scene.updatedAt) }}</dd></div></dl>
				<footer><el-button size="small" @click="edit(scene)">编辑草稿</el-button><el-button size="small" @click="viewDraft(scene)">查看草稿</el-button><el-button size="small" type="primary" :loading="publishingSceneId === scene.id" :disabled="scene.publishedSourceRevision === scene.revision" @click="publish(scene)">{{ scene.publishedVersion ? '发布新版本' : '发布' }}</el-button><el-button size="small" :disabled="!scene.publishedVersion" type="success" @click="viewPublished(scene)">查看线上</el-button><el-button size="small" @click="openVersions(scene)">版本历史</el-button><el-button size="small" type="danger" plain :loading="deletingSceneId === scene.id" @click="remove(scene)">删除</el-button></footer>
			</article>
		</div>
		<el-drawer v-model="drawer" :title="`${selected?.name || ''} · 版本历史`" size="600px">
			<el-empty v-if="versions.length === 0" description="尚无发布版本" />
			<el-timeline v-else><el-timeline-item v-for="version in versions" :key="version.id" :timestamp="formatDate(version.createdAt)" :type="version.isCurrent ? 'success' : 'primary'">
				<div class="version"><strong>v{{ version.version }} <el-tag v-if="version.isCurrent" size="small" type="success">线上</el-tag></strong><span>来源草稿 r{{ version.sourceDraftRevision }} · {{ version.changeSummary || '无说明' }}</span><small>{{ version.manifestHash.slice(0, 20) }}…</small><div><el-button size="small" @click="viewVersion(version.version)">只读查看</el-button><el-button v-if="!version.isCurrent" size="small" type="warning" @click="restoreDraft(version.version)">创建回退草稿</el-button></div></div>
			</el-timeline-item></el-timeline>
		</el-drawer>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { digitalTwinApi, type DigitalTwinSceneSummary, type TwinSceneVersion } from '/@/api/digital-twin';

const router = useRouter();
const loading = ref(false), drawer = ref(false), publishingSceneId = ref(''), deletingSceneId = ref('');
const scenes = ref<DigitalTwinSceneSummary[]>([]), versions = ref<TwinSceneVersion[]>([]);
const selected = ref<DigitalTwinSceneSummary>();
const apiData = <T,>(response: any): T => response.data as T;
const apiErrorMessage = (error: any, fallback: string) => error?.msg
	|| error?.response?.data?.msg
	|| (typeof error?.response?.data === 'string' ? error.response.data : '')
	|| error?.message
	|| fallback;
const loadScenes = async () => { loading.value = true; try { scenes.value = apiData(await digitalTwinApi.listScenes()); } finally { loading.value = false; } };
const publicationState = (scene: DigitalTwinSceneSummary) => !scene.publishedVersion
	? { label: '仅草稿', type: 'info' as const }
	: scene.publishedSourceRevision === scene.revision ? { label: '已发布', type: 'success' as const } : { label: '发布后已修改', type: 'warning' as const };
const edit = (scene: DigitalTwinSceneSummary) => router.push({ path: '/iot/digital-twin/workbench', query: { sceneId: scene.id } });
const viewDraft = (scene: DigitalTwinSceneSummary) => router.push({ path: '/iot/digital-twin/viewer', query: { sceneId: scene.id, mode: 'draft' } });
const viewPublished = (scene: DigitalTwinSceneSummary) => router.push({ path: '/iot/digital-twin/viewer', query: { sceneId: scene.id, version: scene.publishedVersion } });
const publish = async (scene: DigitalTwinSceneSummary) => {
	const confirmed = await ElMessageBox.confirm(`发布 ${scene.name} 的草稿 r${scene.revision}？发布后将生成不可变线上版本。`, '发布场景', { type: 'warning' })
		.then(() => true).catch(() => false);
	if (!confirmed) return;
	publishingSceneId.value = scene.id;
	try {
		const validation = apiData<{ valid: boolean; diagnostics: Array<{ severity: string; message: string; path?: string }> }>(await digitalTwinApi.validateScene(scene.id, true));
		if (!validation.valid) {
			const errors = validation.diagnostics.filter((item) => item.severity === 'error');
			await ElMessageBox.alert(errors.map((item) => `${item.path || 'manifest'}：${item.message}`).join('\n'), '发布校验未通过', { type: 'error' });
			return;
		}
		const version = apiData<TwinSceneVersion>(await digitalTwinApi.publishScene(scene.id, scene.revision, `从场景中心发布于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`));
		ElMessage.success(`${scene.name} 已发布为 v${version.version}`);
		await loadScenes();
	} catch (error: any) {
		ElMessage.error(apiErrorMessage(error, '场景发布失败'));
	} finally { publishingSceneId.value = ''; }
};
const remove = async (scene: DigitalTwinSceneSummary) => {
	const publishedWarning = scene.publishedVersion
		? `场景当前线上版本为 v${scene.publishedVersion}。删除会立即下线该场景并从场景中心隐藏，但不可变历史版本仍保留在数据库审计记录中。`
		: '删除会从场景中心隐藏该草稿，资源模型本身不会被删除。';
	const confirmed = await ElMessageBox.confirm(`${publishedWarning}\n\n确认删除“${scene.name}”？`, '删除数字孪生场景', {
		type: 'error',
		confirmButtonText: '确认删除',
		cancelButtonText: '取消',
	}).then(() => true).catch(() => false);
	if (!confirmed) return;
	deletingSceneId.value = scene.id;
	try {
		await digitalTwinApi.deleteScene(scene.id);
		if (selected.value?.id === scene.id) { drawer.value = false; selected.value = undefined; versions.value = []; }
		ElMessage.success(`${scene.name} 已${scene.publishedVersion ? '下线并' : ''}软删除`);
		await loadScenes();
	} catch (error: any) {
		ElMessage.error(apiErrorMessage(error, '场景删除失败'));
	} finally { deletingSceneId.value = ''; }
};
const openVersions = async (scene: DigitalTwinSceneSummary) => { selected.value = scene; versions.value = apiData(await digitalTwinApi.listVersions(scene.id)); drawer.value = true; };
const viewVersion = (version: number) => selected.value && router.push({ path: '/iot/digital-twin/viewer', query: { sceneId: selected.value.id, version } });
const restoreDraft = async (version: number) => {
	if (!selected.value) return;
	await ElMessageBox.confirm(`从 v${version} 创建新草稿，不改变当前线上版本。`, '创建回退草稿');
	const detail: any = apiData(await digitalTwinApi.rollback(selected.value.id, version));
	ElMessage.success(`已创建草稿 r${detail.revision}`);
	await loadScenes();
	const scene = scenes.value.find((item) => item.id === selected.value?.id);
	if (scene) await openVersions(scene);
};
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
onMounted(loadScenes);
</script>

<style scoped lang="scss">
.scene-center{min-height:calc(100vh - 132px);margin:-15px;padding:24px;color:#dbeafe;background:#07111f}.scene-center>header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:22px}.scene-center h2,.scene-center h3,.scene-center p{margin:4px 0}.scene-center header small,.scene-title small{color:#38bdf8;letter-spacing:.12em}.scene-center header p,article>p{color:#8ea6bf}.scene-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}.scene-grid article{padding:18px;border:1px solid rgba(148,163,184,.2);border-radius:14px;background:#0b192b}.scene-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.scene-title h3{color:#f8fafc}dl{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}dl div{padding:9px;border-radius:8px;background:rgba(15,31,52,.8)}dt{font-size:11px;color:#7890a8}dd{margin:3px 0 0;font-size:12px;word-break:break-all}article footer{display:flex;gap:7px;flex-wrap:wrap}.version{display:flex;flex-direction:column;gap:7px}.version small{color:#7890a8}
</style>
