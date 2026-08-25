<template>
	<div class="generator-page" v-loading="pageLoading">
		<header class="generator-header">
			<div>
				<span class="eyebrow">IOTSHARP · IMG2THREEJS PIPELINE</span>
				<h1>图片生成三维模型</h1>
				<p>上传设备或零件参考图，生成可编辑、可动画的 Three.js 模型，并自动校验为 GLB 存入模型资源库。</p>
			</div>
			<div class="header-actions">
				<el-tag :type="capabilities?.configured ? 'success' : 'warning'" effect="dark" round>
					{{ capabilities?.configured ? 'Worker 已连接' : '等待 Worker' }}
				</el-tag>
				<el-button @click="loadAll">刷新</el-button>
				<el-button type="primary" @click="router.push('/iot/digital-twin/workbench')">进入三维场景</el-button>
			</div>
		</header>

		<el-alert v-if="capabilities" :type="capabilities.configured ? 'success' : 'warning'" :closable="false" show-icon>
			<template #title>{{ capabilities.message }}</template>
			<template #default>
				img2threejs 是 Agent 驱动的代码建模流水线，不是浏览器端滤镜。IoTSharp 会持久化任务，Worker 按 <code>iotsharp-img2threejs-worker/v1</code> 合同返回 GLB。
			</template>
		</el-alert>

		<main class="generator-layout">
			<section class="generator-card create-card">
				<div class="card-heading"><div><span>CREATE</span><h2>新建生成任务</h2></div><el-tag type="info">图片 → Three.js → GLB</el-tag></div>
				<div class="create-grid">
					<label class="image-drop" :class="{ 'has-image': referencePreviewUrl }">
						<input type="file" accept="image/png,image/jpeg,image/webp" @change="selectReference" />
						<img v-if="referencePreviewUrl" :src="referencePreviewUrl" alt="参考图" />
						<div v-else><strong>上传参考图片</strong><span>PNG / JPEG / WebP，最大 {{ capabilities?.maxReferenceImageMb || 15 }} MB</span><small>建议：单个主体、轮廓清晰、背景干净、无遮挡</small></div>
						<i v-if="referencePreviewUrl">点击更换图片</i>
					</label>

					<el-form label-position="top" class="generation-form">
						<div class="form-row">
							<el-form-item label="模型名称"><el-input v-model="form.name" maxlength="80" placeholder="例如：AGV 搬运机器人" /></el-form-item>
							<el-form-item label="生成质量"><el-select v-model="form.qualityProfile"><el-option label="生产质量" value="Production" /><el-option label="快速预览" value="Preview" /><el-option label="结构草稿" value="Draft" /></el-select></el-form-item>
						</div>
						<el-form-item label="建模要求">
							<el-input v-model="form.prompt" type="textarea" :rows="6" maxlength="4000" show-word-limit placeholder="描述真实尺寸比例、必须拆分的部件、转轴/滑轨、材质颜色和需要动画的结构。例如：保留前后轮、举升平台和激光雷达为独立节点，整体以米为单位。" />
						</el-form-item>
						<div class="form-row">
							<el-form-item label="结果许可证"><el-input v-model="form.licenseType" maxlength="128" /></el-form-item>
							<el-form-item label="结构要求"><el-switch v-model="form.animationReady" active-text="可动画分层" inactive-text="静态模型" /></el-form-item>
						</div>
						<div class="rights-box">
							<el-checkbox v-model="form.referenceRightsConfirmed">我拥有参考图片及生成内容的使用权</el-checkbox>
							<el-checkbox v-model="form.commercialUseAllowed">生成结果允许当前项目商业使用</el-checkbox>
						</div>
						<el-button class="submit-button" type="primary" size="large" :loading="submitting" :disabled="!canSubmit" @click="createJob">
							创建 img2threejs 生成任务
						</el-button>
					</el-form>
				</div>
			</section>

			<aside class="generator-card pipeline-card">
				<div class="card-heading"><div><span>PIPELINE</span><h2>生成与入库流程</h2></div></div>
				<ol class="pipeline-list">
					<li><i>01</i><div><strong>参考图分析</strong><span>识别轮廓、比例、材质和关键结构</span></div></li>
					<li><i>02</i><div><strong>Sculpt Spec</strong><span>建立部件树、关节、材质与质量门槛</span></div></li>
					<li><i>03</i><div><strong>程序化建模</strong><span>生成可读、可编辑的 Three.js 工厂代码</span></div></li>
					<li><i>04</i><div><strong>视觉复核</strong><span>多视角对照参考图，未达标继续修正</span></div></li>
					<li><i>05</i><div><strong>安全入库</strong><span>导出 GLB、节点检查、Hash 去重并登记授权</span></div></li>
				</ol>
				<div class="pipeline-note"><strong>适合工业数字孪生</strong><span>优先用于机械设备、硬表面零件、AGV、输送机和仪表。单张图片看不到的背面结构只能推断，关键尺寸仍应使用 CAD 或多视图校正。</span></div>
			</aside>
		</main>

		<section class="generator-card jobs-card">
			<div class="card-heading"><div><span>JOBS</span><h2>生成任务</h2></div><small>{{ activeJobCount }} 个处理中 · 最近 100 条</small></div>
			<el-empty v-if="jobs.length === 0" description="还没有模型生成任务" />
			<div v-else class="jobs-table">
				<div v-for="job in jobs" :key="job.id" class="job-row">
					<div class="job-symbol" :class="`is-${job.status.toLowerCase()}`">{{ job.name.slice(0, 1).toUpperCase() }}</div>
					<div class="job-main"><strong>{{ job.name }}</strong><span>{{ job.referenceImageName }} · {{ formatBytes(job.referenceImageSize) }} · {{ job.qualityProfile }}</span><small>{{ formatDate(job.createdAt) }} · {{ job.createdBy }}</small></div>
					<div class="job-progress">
						<div><span>{{ job.stage }}</span><b>{{ job.progress }}%</b></div>
						<el-progress :percentage="job.progress" :status="progressStatus(job.status)" :show-text="false" />
						<small v-if="job.errorMessage" class="job-error">{{ job.errorMessage }}</small>
					</div>
					<el-tag :type="statusType(job.status)" effect="plain">{{ statusText(job.status) }}</el-tag>
					<div class="job-actions">
						<el-button v-if="job.status === 'Succeeded'" type="primary" plain size="small" @click="openPreview(job)">查看模型</el-button>
						<el-button v-if="['Failed','Cancelled','WaitingForWorker'].includes(job.status)" size="small" @click="retryJob(job)">重新排队</el-button>
						<el-button v-if="['Queued','Running','WaitingForWorker'].includes(job.status)" type="danger" text size="small" @click="cancelJob(job)">取消</el-button>
					</div>
				</div>
			</div>
		</section>

		<el-drawer v-model="previewVisible" title="生成结果对照" size="72%" destroy-on-close @closed="clearResultPreview">
			<div v-if="selectedJob" class="result-preview">
				<section><h3>参考图片</h3><div class="reference-preview"><img v-if="selectedReferenceUrl" :src="selectedReferenceUrl" alt="任务参考图" /><span v-else>正在加载参考图…</span></div></section>
				<section><h3>生成的 GLB 模型</h3><TwinModelPreview v-if="selectedJob.resultModelResourceId" :resource-id="selectedJob.resultModelResourceId" :file-name="selectedJob.resultModelResource?.originalFileName" /></section>
			</div>
			<template #footer><div class="drawer-footer"><span>模型已经通过 IoTSharp GLB 检查并进入租户模型库。</span><el-button type="primary" @click="router.push('/iot/digital-twin/workbench')">去场景中使用</el-button></div></template>
		</el-drawer>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { digitalTwinApi, type TwinModelGenerationCapabilities, type TwinModelGenerationJob, type TwinModelGenerationStatus } from '/@/api/digital-twin';
import TwinModelPreview from '/@/digital-twin/components/TwinModelPreview.vue';

const router = useRouter();
const pageLoading = ref(true);
const submitting = ref(false);
const capabilities = ref<TwinModelGenerationCapabilities>();
const jobs = ref<TwinModelGenerationJob[]>([]);
const referenceFile = shallowRef<File>();
const referencePreviewUrl = ref('');
const previewVisible = ref(false);
const selectedJob = ref<TwinModelGenerationJob>();
const selectedReferenceUrl = ref('');
const form = reactive({ name: '', prompt: '', qualityProfile: 'Production', animationReady: true, licenseType: 'Proprietary-Generated', commercialUseAllowed: true, referenceRightsConfirmed: false });
let pollingTimer: number | undefined;

const apiData = <T>(response: any): T => (response?.data?.data ?? response?.data ?? response) as T;
const activeJobCount = computed(() => jobs.value.filter((item) => ['Queued', 'Running', 'WaitingForWorker'].includes(item.status)).length);
const canSubmit = computed(() => Boolean(referenceFile.value && form.name.trim() && form.prompt.trim() && form.referenceRightsConfirmed));

const loadAll = async () => {
	const [capabilityResponse, jobsResponse] = await Promise.all([digitalTwinApi.modelGenerationCapabilities(), digitalTwinApi.listModelGenerationJobs()]);
	capabilities.value = apiData<TwinModelGenerationCapabilities>(capabilityResponse);
	jobs.value = apiData<TwinModelGenerationJob[]>(jobsResponse);
};

const selectReference = (event: Event) => {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) return;
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { ElMessage.error('只支持 PNG、JPEG 或 WebP 图片'); return; }
	if (file.size > (capabilities.value?.maxReferenceImageMb || 15) * 1024 * 1024) { ElMessage.error('参考图片过大'); return; }
	referenceFile.value = file;
	if (referencePreviewUrl.value) URL.revokeObjectURL(referencePreviewUrl.value);
	referencePreviewUrl.value = URL.createObjectURL(file);
	if (!form.name) form.name = file.name.replace(/\.[^.]+$/, '');
};

const createJob = async () => {
	if (!canSubmit.value || !referenceFile.value) return;
	submitting.value = true;
	try {
		const data = new FormData();
		data.append('referenceImage', referenceFile.value);
		data.append('name', form.name.trim());
		data.append('prompt', form.prompt.trim());
		data.append('qualityProfile', form.qualityProfile);
		data.append('animationReady', String(form.animationReady));
		data.append('licenseType', form.licenseType.trim() || 'Proprietary-Generated');
		data.append('commercialUseAllowed', String(form.commercialUseAllowed));
		data.append('referenceRightsConfirmed', String(form.referenceRightsConfirmed));
		await digitalTwinApi.createModelGenerationJob(data);
		ElMessage.success(capabilities.value?.configured ? '生成任务已进入队列' : '任务已入库，配置 Worker 后会自动生成');
		form.name = ''; form.prompt = ''; form.referenceRightsConfirmed = false;
		referenceFile.value = undefined;
		if (referencePreviewUrl.value) URL.revokeObjectURL(referencePreviewUrl.value);
		referencePreviewUrl.value = '';
		await loadAll();
	} catch (error: any) { ElMessage.error(error?.msg || '创建生成任务失败'); }
	finally { submitting.value = false; }
};

const cancelJob = async (job: TwinModelGenerationJob) => {
	await ElMessageBox.confirm(`确认取消“${job.name}”的生成任务？`, '取消生成');
	await digitalTwinApi.cancelModelGenerationJob(job.id); await loadAll(); ElMessage.success('任务已取消');
};
const retryJob = async (job: TwinModelGenerationJob) => { await digitalTwinApi.retryModelGenerationJob(job.id); await loadAll(); ElMessage.success('任务已重新排队'); };

const openPreview = async (job: TwinModelGenerationJob) => {
	selectedJob.value = job; previewVisible.value = true;
	try {
		const response: any = await digitalTwinApi.getModelGenerationReference(job.id);
		const blob = (response?.data instanceof Blob ? response.data : response) as Blob;
		selectedReferenceUrl.value = URL.createObjectURL(blob);
	} catch { ElMessage.warning('参考图片加载失败，但生成模型仍可查看'); }
};
const clearResultPreview = () => { if (selectedReferenceUrl.value) URL.revokeObjectURL(selectedReferenceUrl.value); selectedReferenceUrl.value = ''; selectedJob.value = undefined; };

const statusText = (status: TwinModelGenerationStatus) => ({ WaitingForWorker: '等待 Worker', Queued: '排队中', Running: '生成中', Succeeded: '已完成', Failed: '失败', Cancelled: '已取消' }[status]);
const statusType = (status: TwinModelGenerationStatus): 'success' | 'warning' | 'danger' | 'info' | 'primary' => status === 'Succeeded' ? 'success' : status === 'Failed' ? 'danger' : status === 'Running' ? 'primary' : status === 'Queued' || status === 'WaitingForWorker' ? 'warning' : 'info';
const progressStatus = (status: TwinModelGenerationStatus): '' | 'success' | 'exception' | 'warning' => status === 'Succeeded' ? 'success' : status === 'Failed' ? 'exception' : status === 'WaitingForWorker' ? 'warning' : '';
const formatBytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB`;
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

onMounted(async () => {
	try { await loadAll(); }
	finally { pageLoading.value = false; }
	pollingTimer = window.setInterval(() => { if (activeJobCount.value) loadAll(); }, 4000);
});
onBeforeUnmount(() => { if (pollingTimer) window.clearInterval(pollingTimer); if (referencePreviewUrl.value) URL.revokeObjectURL(referencePreviewUrl.value); clearResultPreview(); });
</script>

<style scoped lang="scss">
.generator-page{min-height:100%;padding:24px;background:radial-gradient(circle at 8% 0,rgba(14,165,233,.12),transparent 28%),#07101b;color:#dbeafe}.generator-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.eyebrow,.card-heading span{display:block;margin-bottom:6px;color:#38bdf8;font-size:10px;font-weight:700;letter-spacing:.16em}.generator-header h1{margin:0 0 8px;color:#f8fafc;font-size:27px}.generator-header p{max-width:780px;margin:0;color:#94a3b8;line-height:1.65}.header-actions{display:flex;align-items:center;gap:10px}.generator-page :deep(.el-alert){margin-bottom:18px;border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.8)}.generator-page :deep(.el-alert__description){color:#94a3b8}.generator-page code{color:#7dd3fc}.generator-layout{display:grid;grid-template-columns:minmax(680px,1fr) 330px;gap:18px}.generator-card{border:1px solid rgba(148,163,184,.17);border-radius:16px;background:linear-gradient(145deg,rgba(16,29,46,.96),rgba(8,18,31,.96));box-shadow:0 18px 48px rgba(0,0,0,.18)}.create-card,.pipeline-card,.jobs-card{padding:18px}.card-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.card-heading h2{margin:0;color:#f1f5f9;font-size:17px}.card-heading small{color:#64748b}.create-grid{display:grid;grid-template-columns:300px 1fr;gap:20px}.image-drop{position:relative;display:grid;min-height:365px;place-items:center;overflow:hidden;border:1px dashed rgba(56,189,248,.45);border-radius:13px;background:rgba(2,12,23,.6);cursor:pointer}.image-drop:hover{border-color:#38bdf8}.image-drop input{display:none}.image-drop div{display:flex;flex-direction:column;align-items:center;padding:24px;text-align:center}.image-drop strong{color:#e0f2fe;font-size:17px}.image-drop span{margin:8px 0 18px;color:#7dd3fc;font-size:12px}.image-drop small{max-width:220px;color:#64748b;line-height:1.7}.image-drop img{width:100%;height:100%;object-fit:contain}.image-drop i{position:absolute;right:10px;bottom:10px;padding:5px 8px;border-radius:7px;color:#bae6fd;background:rgba(2,12,23,.82);font-size:10px;font-style:normal}.generation-form :deep(.el-form-item){margin-bottom:14px}.generation-form :deep(.el-form-item__label){color:#94a3b8}.generation-form :deep(.el-input__wrapper),.generation-form :deep(.el-textarea__inner),.generation-form :deep(.el-select__wrapper){box-shadow:0 0 0 1px rgba(148,163,184,.18) inset;background:#091625;color:#e2e8f0}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.rights-box{display:flex;flex-direction:column;gap:7px;margin:2px 0 16px;padding:10px 12px;border-radius:9px;background:rgba(2,12,23,.58)}.rights-box :deep(.el-checkbox__label){color:#cbd5e1}.submit-button{width:100%}.pipeline-list{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;list-style:none}.pipeline-list li{display:flex;gap:12px;padding:11px;border-radius:10px;background:rgba(2,12,23,.52)}.pipeline-list i{display:grid;flex:0 0 30px;height:30px;place-items:center;border:1px solid rgba(56,189,248,.28);border-radius:8px;color:#38bdf8;font-size:9px;font-style:normal}.pipeline-list div{display:flex;min-width:0;flex-direction:column;gap:4px}.pipeline-list strong{color:#dbeafe;font-size:12px}.pipeline-list span{color:#64748b;font-size:10px;line-height:1.5}.pipeline-note{display:flex;flex-direction:column;gap:7px;margin-top:13px;padding:12px;border:1px solid rgba(245,158,11,.2);border-radius:10px;background:rgba(120,53,15,.12)}.pipeline-note strong{color:#fbbf24;font-size:12px}.pipeline-note span{color:#94a3b8;font-size:10px;line-height:1.65}.jobs-card{margin-top:18px}.jobs-table{display:flex;flex-direction:column}.job-row{display:grid;grid-template-columns:42px minmax(220px,1.2fr) minmax(260px,1fr) 105px 160px;align-items:center;gap:14px;padding:13px 4px;border-top:1px solid rgba(148,163,184,.11)}.job-symbol{display:grid;width:38px;height:38px;place-items:center;border-radius:10px;color:#7dd3fc;background:rgba(14,165,233,.14);font-weight:700}.job-symbol.is-succeeded{color:#86efac;background:rgba(34,197,94,.14)}.job-symbol.is-failed{color:#fca5a5;background:rgba(239,68,68,.14)}.job-main,.job-progress{display:flex;min-width:0;flex-direction:column;gap:4px}.job-main strong{overflow:hidden;color:#e2e8f0;text-overflow:ellipsis;white-space:nowrap}.job-main span,.job-main small,.job-progress small{overflow:hidden;color:#64748b;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.job-progress>div{display:flex;justify-content:space-between;gap:12px;color:#94a3b8;font-size:10px}.job-progress b{color:#cbd5e1}.job-error{color:#fca5a5!important}.job-actions{display:flex;justify-content:flex-end;gap:3px}.result-preview{display:grid;height:calc(100vh - 165px);grid-template-columns:38% 62%;gap:16px}.result-preview section{display:flex;min-height:0;flex-direction:column}.result-preview h3{margin:0 0 10px;color:#334155;font-size:14px}.reference-preview{display:grid;min-height:360px;flex:1;place-items:center;overflow:hidden;border-radius:14px;background:#06101d;color:#94a3b8}.reference-preview img{width:100%;height:100%;object-fit:contain}.drawer-footer{display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:12px}@media(max-width:1200px){.generator-layout{grid-template-columns:1fr}.create-grid{grid-template-columns:260px 1fr}.pipeline-card{display:none}.job-row{grid-template-columns:42px 1fr 1fr 100px}.job-actions{grid-column:2/-1}.result-preview{grid-template-columns:1fr;height:auto}.reference-preview{height:320px}}@media(max-width:760px){.generator-page{padding:14px}.generator-header{flex-direction:column}.create-grid,.form-row{grid-template-columns:1fr}.image-drop{min-height:260px}.job-row{grid-template-columns:42px 1fr}.job-progress,.job-row>.el-tag,.job-actions{grid-column:2}.result-preview{display:block}}
</style>
