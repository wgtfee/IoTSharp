<template>
	<div class="twin-workbench" v-loading="pageLoading">
		<header class="twin-toolbar">
			<div class="twin-toolbar__title">
				<span class="twin-toolbar__eyebrow">IOTSHARP DIGITAL TWIN</span>
				<el-select v-model="selectedSceneId" class="scene-select" placeholder="选择场景" @change="loadScene">
					<el-option v-for="item in scenes" :key="item.id" :label="item.name" :value="item.id" />
				</el-select>
				<el-tag size="small" :type="currentScene?.status === 'Published' ? 'success' : 'warning'" effect="dark">
					{{ currentScene ? `${currentScene.status} · r${currentScene.revision}` : '未入库' }}
				</el-tag>
			</div>
			<div class="twin-toolbar__actions">
				<el-segmented v-model="viewportMode" :options="viewportModeOptions" @change="switchViewportMode" />
				<el-button @click="createDialogVisible = true">新建场景</el-button>
				<el-button type="warning" plain @click="applySilkCakeLineTemplate">50托盘丝饼线</el-button>
				<el-button @click="router.push('/iot/digital-twin/model-generator')">生成模型</el-button>
				<el-button @click="resourceDrawerVisible = true">模型资源库</el-button>
				<el-button :type="routeDrawMode ? 'warning' : 'default'" @click="toggleRouteDrawMode">{{ routeDrawMode ? '结束绘制' : '绘制路线' }}</el-button>
				<el-button :type="playing ? 'danger' : 'primary'" @click="togglePlaying">{{ playing ? '暂停' : '运行' }}</el-button>
				<el-button :loading="saving" :disabled="!currentScene" @click="saveDraft()">保存草稿</el-button>
				<el-button type="success" :loading="publishing" :disabled="!currentScene" @click="publishScene">发布</el-button>
				<el-dropdown trigger="click">
					<el-button>更多</el-button>
					<template #dropdown><el-dropdown-menu>
						<el-dropdown-item @click="validateScene">场景校验</el-dropdown-item>
						<el-dropdown-item @click="openVersions">版本与回滚</el-dropdown-item>
						<el-dropdown-item divided @click="exportManifest">导出 Manifest</el-dropdown-item>
					</el-dropdown-menu></template>
				</el-dropdown>
			</div>
		</header>

		<section class="twin-status-strip">
			<div><span>路线状态</span><strong :class="`is-${metrics.state}`">{{ routeStateText }}<small v-if="metrics.waitingEdgeId || metrics.waitingPointId"> · {{ waitingReasonText }}</small></strong></div>
			<div><span>位置</span><strong>{{ metrics.distanceMeters.toFixed(2) }} / {{ metrics.lengthMeters.toFixed(2) }} m</strong></div>
			<div><span>实时绑定</span><strong>{{ manifest.bindings.length }} 条 · {{ liveMode ? '轮询中' : '已暂停' }}</strong></div>
			<div><span>渲染</span><strong>{{ metrics.fps }} FPS · {{ metrics.drawCalls }} calls</strong></div>
			<div><span>场景规模</span><strong>{{ formatNumber(metrics.triangles) }} triangles</strong></div>
		</section>
		<section v-if="metrics.silkLine" class="twin-status-strip twin-status-strip--silk">
			<div><span>在线托盘</span><strong>{{ metrics.silkLine.onlinePallets }} · Loaded {{ metrics.silkLine.loadedPallets }} / Empty {{ metrics.silkLine.emptyPallets }}</strong></div>
			<div><span>等待与阻塞</span><strong>{{ metrics.silkLine.waitingPallets }} 个托盘 · {{ metrics.silkLine.blockedSections }} 段</strong></div>
			<div><span>丝车剩余</span><strong>{{ metrics.silkLine.cartRemaining }} 个丝饼</strong></div>
			<div><span>设备任务</span><strong>Robot {{ metrics.silkLine.robotState }} · Gantry {{ metrics.silkLine.gantryState }}</strong></div>
			<div><span>码垛进度</span><strong>{{ metrics.silkLine.stackOccupied }} / {{ metrics.silkLine.stackCapacity }}</strong></div>
		</section>

		<main class="twin-layout">
			<aside class="twin-panel twin-panel--left">
				<div class="twin-panel__heading">
					<div><span>SCENE</span><strong>场景与路线</strong></div>
					<el-switch v-model="liveMode" active-text="实时" inline-prompt @change="toggleLiveMode" />
				</div>
				<div class="twin-card">
					<label>场景名称</label><el-input v-model="manifest.name" maxlength="80" />
					<label>根 Asset（场景业务边界）</label>
					<el-select v-model="manifest.rootAssetId" filterable placeholder="必须选择" @change="changeRootAsset">
						<el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" />
					</el-select>
					<label>曲线类型</label><el-segmented v-model="route.curveKind" :options="curveOptions" @change="changeCurveKind" />
					<div class="twin-inline-control"><label>循环运行</label><el-switch v-model="route.loop" @change="changeLoop" /></div>
					<label>分流方式</label><el-segmented v-model="route.routingMode" :options="routingModeOptions" @change="syncRouteGraph" />
					<label>运行速度 {{ route.defaultSpeed.toFixed(1) }} m/s</label>
					<el-slider v-model="route.defaultSpeed" :min="0.1" :max="5" :step="0.1" @input="changeSpeed" />
				</div>
				<div v-if="manifest.runtime.silkLineSimulation" class="twin-card">
					<span class="twin-card__label">丝饼产线模拟参数</span>
					<div class="silk-simulation-grid">
						<label>塑料托盘数<el-input-number v-model="manifest.runtime.silkLineSimulation.palletCount" :min="1" :max="200" size="small" @change="applySilkSimulationOptions" /></label>
						<label>每车丝饼数<el-input-number v-model="manifest.runtime.silkLineSimulation.silkCakesPerCart" :min="1" :max="100" size="small" @change="applySilkSimulationOptions" /></label>
						<label>机器人节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.robotCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>桁架节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.gantryCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>换车延时(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.cartChangeDelaySeconds" :min="0" :max="300" :step="1" size="small" @change="applySilkSimulationOptions" /></label>
						<label>码垛 行/列/层<span><el-input-number v-model="manifest.runtime.silkLineSimulation.stackRows" :min="1" :max="10" size="small" @change="applySilkSimulationOptions" /><el-input-number v-model="manifest.runtime.silkLineSimulation.stackColumns" :min="1" :max="10" size="small" @change="applySilkSimulationOptions" /><el-input-number v-model="manifest.runtime.silkLineSimulation.stackLayers" :min="1" :max="20" size="small" @change="applySilkSimulationOptions" /></span></label>
					</div>
					<div class="twin-inline-control"><label>空丝车自动更换</label><el-switch v-model="manifest.runtime.silkLineSimulation.autoReplaceSilkCart" @change="applySilkSimulationOptions" /></div>
					<small>修改后重建仿真；保存草稿时参数、路线和资源对象一起入库。</small>
				</div>

				<div class="twin-panel__subheading"><strong>场景模型</strong><el-button size="small" text type="primary" @click="resourceDrawerVisible = true">添加</el-button></div>
				<div class="compact-list">
					<div v-for="item in modelObjects" :key="item.objectId" @click="selectSceneObject(item.objectId)"><span>{{ item.name }}</span><el-button text type="danger" size="small" @click.stop="removeModelObject(item.objectId)">移除</el-button></div>
					<small v-if="modelObjects.length === 0">尚未从资源库放置模型。</small>
				</div>

				<div class="twin-panel__subheading"><strong>路线控制点</strong><el-button size="small" text type="primary" @click="addRoutePoint">新增</el-button></div>
				<div class="twin-route-points">
					<div v-for="(point, index) in route.points" :key="point.pointId" class="twin-route-point" :class="{ 'is-selected': selected?.routePointIndex === index }">
						<div class="twin-route-point__title"><span>{{ index + 1 }}</span><el-input v-model="point.name" size="small" @change="syncRouteGraph" /><el-button circle text type="danger" size="small" :disabled="route.points.length <= 2" @click="removeRoutePoint(index)">×</el-button></div>
						<div class="twin-route-point__meta">
							<el-select v-model="point.kind" size="small" @change="syncRouteGraph"><el-option v-for="option in routePointKindOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-radio v-model="route.startPointId" :value="point.pointId" size="small" @change="syncRouteGraph">运行起点</el-radio>
						</div>
						<div v-if="['diverter','merger','sensor','processStation'].includes(point.kind || '')" class="twin-route-binding-grid">
							<el-select v-if="point.kind === 'diverter' || point.kind === 'merger'" v-model="point.actuatorBindingId" size="small" clearable placeholder="执行器/到位信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-select v-model="point.sensorBindingId" size="small" clearable placeholder="检测/工位信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						</div>
						<div v-if="['junction','diverter'].includes(point.kind || '')" class="twin-route-binding-grid">
							<el-select v-model="point.decisionMode" size="small" placeholder="岔口决策模式" @change="syncRouteGraph"><el-option v-for="option in junctionDecisionModeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-input-number v-model="point.decisionTimeoutSeconds" :min="1" :max="300" size="small" controls-position="right" aria-label="路由等待告警秒数" @change="syncRouteGraph" />
						</div>
						<div class="twin-coordinate-grid">
							<el-input-number v-model="point.position[0]" :step="0.1" size="small" controls-position="right" @change="updateRoutePoint(index)" />
							<el-input-number v-model="point.position[1]" :step="0.1" size="small" controls-position="right" @change="updateRoutePoint(index)" />
							<el-input-number v-model="point.position[2]" :step="0.1" size="small" controls-position="right" @change="updateRoutePoint(index)" />
						</div>
					</div>
				</div>

				<div class="twin-panel__subheading"><strong>交叉口与分支</strong><el-button size="small" text type="primary" @click="addStandaloneRoutePoint">新增分支节点</el-button></div>
				<div class="twin-card twin-route-graph-editor">
					<small>先放置节点，再连接路线边。连接数达到 3 的节点会自动标记为交叉口。</small>
					<div class="twin-route-edge-form">
						<el-select v-model="branchForm.fromPointId" size="small" placeholder="从节点"><el-option v-for="point in route.points" :key="point.pointId" :label="point.name" :value="point.pointId" /></el-select>
						<el-select v-model="branchForm.toPointId" size="small" placeholder="到节点"><el-option v-for="point in route.points" :key="point.pointId" :label="point.name" :value="point.pointId" :disabled="point.pointId === branchForm.fromPointId" /></el-select>
					</div>
					<div class="twin-inline-control"><el-checkbox v-model="branchForm.bidirectional">允许双向通行</el-checkbox><el-button size="small" type="primary" @click="addRouteEdge">连接分支</el-button></div>
				</div>
				<div class="twin-route-edges">
					<div v-for="edge in route.edges" :key="edge.edgeId" class="twin-route-edge" :class="{ 'is-blocked': edge.blocked }">
						<div class="twin-route-edge__header"><div><strong>{{ routeEdgeLabel(edge) }}</strong><small>{{ edge.bidirectional ? '双向' : '单向' }} · 优先级 {{ edge.priority || 0 }}</small></div><el-switch v-model="edge.blocked" size="small" inline-prompt active-text="封" inactive-text="通" @change="syncRouteGraph" /><el-button circle text type="danger" size="small" @click="removeRouteEdge(edge.edgeId)">×</el-button></div>
						<div class="twin-route-edge__settings">
							<div><label>容量</label><el-input-number v-model="edge.capacity" :min="1" :max="999" size="small" controls-position="right" @change="syncRouteGraph" /></div>
							<div><label>预览占用</label><el-input-number v-model="previewOccupancy[edge.edgeId]" :min="0" :max="999" size="small" controls-position="right" @change="applyRoutingPreview(false)" /></div>
						</div>
						<div class="twin-route-edge__settings">
							<div><label>占用来源</label><el-select v-model="edge.occupancyMode" size="small" @change="syncRouteGraph"><el-option v-for="option in occupancyModeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></div>
							<div><label>预占租约（秒）</label><el-input-number v-model="edge.reservationTimeoutSeconds" :min="1" :max="3600" size="small" controls-position="right" @change="syncRouteGraph" /></div>
						</div>
						<el-select v-model="edge.occupancyBindingId" size="small" clearable placeholder="绑定实时占用数量" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						<el-select v-model="edge.fullBindingId" size="small" clearable placeholder="绑定实时满位信号（可选）" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						<el-select v-model="edge.blockedBindingId" size="small" clearable placeholder="绑定故障/封锁信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
					</div>
				</div>
				<div v-if="junctionPoints.length" class="twin-panel__subheading"><strong>交叉口转向</strong><el-tag size="small" type="warning">橙色节点</el-tag></div>
				<div v-for="point in junctionPoints" :key="point.pointId" class="twin-card twin-junction-decision">
					<label>{{ point.name }} 的默认出口（{{ junctionDecisionModeOptions.find(item => item.value === point.decisionMode)?.label || '兼容模式' }}）</label>
					<el-select v-model="route.junctionDecisions[point.pointId]" size="small" placeholder="按优先级自动选择" clearable @change="syncRouteGraph">
						<el-option v-for="option in junctionEdgeOptions(point.pointId)" :key="option.value" :label="option.label" :value="option.value" :disabled="option.blocked" />
					</el-select>
				</div>

				<template v-if="route.routingMode === 'automatic'">
					<div class="twin-panel__subheading"><strong>自动选路规则</strong><el-tag size="small" type="success">包装物料</el-tag></div>
					<div class="twin-card twin-routing-preview">
						<label>预览物料属性（JSON）</label><el-input v-model="routingPayloadText" type="textarea" :rows="3" placeholder='{"sku":"B","weight":12.5}' />
						<el-button size="small" type="success" @click="applyRoutingPreview(true)">应用并重新选路</el-button>
					</div>
					<div class="twin-card twin-rule-form">
						<el-select v-model="ruleForm.junctionPointId" size="small" placeholder="选择分流节点" @change="ruleForm.edgeId = ''"><el-option v-for="point in decisionPoints" :key="point.pointId" :label="point.name" :value="point.pointId" /></el-select>
						<el-select v-model="ruleForm.edgeId" size="small" placeholder="规则命中后走哪条线"><el-option v-for="option in junctionEdgeOptions(ruleForm.junctionPointId)" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						<el-segmented v-model="ruleForm.source" :options="ruleSourceOptions" size="small" />
						<el-input v-if="ruleForm.source === 'payload'" v-model="ruleForm.payloadKey" size="small" placeholder="物料属性 Key，例如 sku" />
						<el-select v-else v-model="ruleForm.bindingId" size="small" filterable placeholder="选择 Device 信号绑定"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						<div class="twin-route-edge-form"><el-select v-model="ruleForm.operator" size="small"><el-option v-for="option in ruleOperatorOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select><el-input v-if="!['truthy','falsy'].includes(ruleForm.operator)" v-model="ruleForm.matchValue" size="small" placeholder="比较值" /></div>
						<el-input v-model="ruleForm.expectedActuatorValue" size="small" clearable placeholder="机构到位期望值（可选，如 Left）" />
						<el-button size="small" type="primary" @click="addDecisionRule">新增自动规则</el-button>
					</div>
					<div class="twin-route-rules"><div v-for="rule in route.decisionRules" :key="rule.ruleId"><div><strong>{{ rule.name }}</strong><small>{{ decisionRuleSummary(rule) }}</small></div><el-switch v-model="rule.enabled" size="small" @change="syncRouteGraph" /><el-button circle text type="danger" size="small" @click="removeDecisionRule(rule.ruleId)">×</el-button></div></div>
				</template>
			</aside>

			<section class="twin-viewport-shell">
				<ThreeJsEditorHost v-if="viewportMode === 'editor'" :key="editorInstanceKey" ref="professionalEditor" :manifest="manifest" @selection-change="selected = $event" @changed="markEditorChanged" @error="ElMessage.error($event)" />
				<div v-else ref="viewport" class="twin-viewport"></div>
				<div class="twin-viewport__hint"><template v-if="viewportMode === 'editor'">threejs-editor 专业模式：模型变换、节点/材质、灯光、相机和后期处理会随草稿入库。</template><template v-else-if="routeDrawMode">点击地面添加控制点；蓝色为途经点，橙色为分流器，紫色为汇流器，绿色为工位。</template><template v-else>绿色曲线是当前选路，红色输送段不可用；自动模式会按物料、Device 信号和容量选路。</template></div>
				<div class="twin-progress"><i :style="{ width: `${Math.round(metrics.progress * 100)}%` }"></i></div>
			</section>

			<aside class="twin-panel twin-panel--right">
				<div class="twin-panel__heading"><div><span>BINDING</span><strong>对象与数据绑定</strong></div></div>
				<div class="twin-card twin-selection-card">
					<span class="twin-card__label">当前选择</span><strong>{{ selected?.name ?? '未选择对象' }}</strong><small>{{ selected?.nodePath || selected?.path || '请在场景中选择模型节点' }}</small>
					<pre v-if="selectedRuntimeData" class="twin-runtime-detail">{{ selectedRuntimeData }}</pre>
					<el-button v-if="selected?.kind === 'scene-object'" size="small" @click="focusSelected">聚焦对象</el-button>
				</div>
				<div class="twin-card binding-form">
					<span class="twin-card__label">新增持久化绑定</span>
					<label>Device</label><el-select v-model="bindingForm.deviceId" filterable placeholder="选择根 Asset 下的设备" @change="bindingForm.key = ''"><el-option v-for="device in assetDevices" :key="device.id" :label="device.name" :value="device.id" /></el-select>
					<label>数据源</label><el-select v-model="bindingForm.sourceKind" @change="bindingForm.key = ''"><el-option label="遥测 Telemetry" value="telemetry" /><el-option label="属性 Attribute" value="attribute" /><el-option label="在线状态 Connectivity" value="connectivity" /></el-select>
					<label>数据 Key</label>
					<el-select v-if="bindingKeys.length" v-model="bindingForm.key" filterable allow-create placeholder="选择或输入 Key"><el-option v-for="key in bindingKeys" :key="key.value" :label="key.label" :value="key.value" /></el-select>
					<el-input v-else v-model="bindingForm.key" placeholder="例如 temperature / online" />
					<label>驱动目标</label><el-select v-model="bindingForm.targetKind"><el-option label="颜色" value="color" /><el-option label="可见性" value="visible" /><el-option label="旋转动画" value="animation" /><el-option label="路线进度" value="routeProgress" /><el-option label="分流/占用信号" value="customProperty" /><el-option label="透明度" value="opacity" /><el-option label="自定义数值" value="number" /></el-select>
					<el-button type="primary" :disabled="!canAddBinding" @click="addBinding">加入绑定清单</el-button>
					<small>保存草稿后写入 TwinObjectBindings；发布时同时生成版本绑定快照。</small>
				</div>
				<div class="binding-list">
					<div v-for="item in selectedBindings" :key="item.bindingId"><div><strong>{{ item.source.kind }} · {{ item.source.key }}</strong><small>→ {{ item.target.kind }} · {{ item.nodePath || '对象根节点' }}</small></div><el-button text type="danger" size="small" @click="removeBinding(item.bindingId)">删除</el-button></div>
				</div>
				<div class="twin-diagnostics">
					<div v-for="diagnostic in diagnostics" :key="`${diagnostic.code}-${diagnostic.path}`" :class="`is-${diagnostic.severity}`"><strong>{{ diagnostic.severity === 'error' ? '错误' : '提醒' }}</strong><span>{{ diagnostic.message }}</span></div>
					<div v-if="diagnostics.length === 0" class="is-success"><strong>通过</strong><span>当前 Manifest 未发现问题。</span></div>
				</div>
			</aside>
		</main>

		<el-dialog v-model="createDialogVisible" title="新建数字孪生场景" width="520px">
			<el-alert title="新场景默认生成：丝车、旋转台、上料机器人、双路分流、桁架码垛、空托盘回流和 50 个绿色塑料托盘。" type="success" :closable="false" style="margin-bottom:16px" />
			<el-form label-position="top"><el-form-item label="场景名称"><el-input v-model="createForm.name" /></el-form-item><el-form-item label="根 Asset"><el-select v-model="createForm.rootAssetId" filterable style="width:100%"><el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" /></el-select></el-form-item><el-form-item label="说明"><el-input v-model="createForm.description" type="textarea" /></el-form-item></el-form>
			<template #footer><el-button @click="createDialogVisible = false">取消</el-button><el-button type="primary" :loading="creating" @click="createScene">创建并入库</el-button></template>
		</el-dialog>

		<el-drawer v-model="resourceDrawerVisible" title="模型资源库" size="520px">
			<input ref="uploadInput" class="is-hidden" type="file" accept=".glb,model/gltf-binary" @change="uploadModel" />
			<div class="resource-actions"><el-button type="success" @click="router.push('/iot/digital-twin/model-generator')">图片生成模型</el-button><el-button type="primary" :loading="uploading" @click="uploadInput?.click()">上传 GLB</el-button><el-button @click="loadModels">刷新</el-button></div>
			<el-alert title="GLB、节点索引、Hash 和授权信息保存在 IoTSharp；场景只引用 resourceId。发布要求已确认商业使用授权。" type="info" :closable="false" />
			<div class="resource-grid">
				<div v-for="model in models" :key="model.id" class="resource-card"><div><strong>{{ model.name }}</strong><small>{{ model.originalFileName }} · {{ formatBytes(model.fileSize) }}</small><small>{{ model.modelMetadata.meshCount || 0 }} Mesh · {{ formatNumber(model.modelMetadata.triangleCount || 0) }} triangles</small></div><el-tag size="small" :type="model.processingStatus === 'Ready' ? 'success' : 'warning'">{{ model.processingStatus }}</el-tag><el-button type="primary" plain :disabled="model.processingStatus !== 'Ready'" @click="placeModel(model)">放入场景</el-button></div>
			</div>
			<el-divider>本次上传授权信息</el-divider>
			<el-form label-position="top"><el-form-item label="许可证"><el-input v-model="uploadForm.licenseType" /></el-form-item><el-form-item label="作者/来源方"><el-input v-model="uploadForm.author" /></el-form-item><el-form-item label="来源链接"><el-input v-model="uploadForm.sourceUrl" /></el-form-item><el-form-item><el-checkbox v-model="uploadForm.commercialUseAllowed">已确认允许当前项目商业使用</el-checkbox></el-form-item></el-form>
		</el-drawer>

		<el-drawer v-model="versionsDrawerVisible" title="发布版本与回滚" size="560px">
			<el-empty v-if="versions.length === 0" description="尚无发布版本" />
			<el-timeline v-else><el-timeline-item v-for="version in versions" :key="version.id" :timestamp="formatDate(version.createdAt)" :type="version.isCurrent ? 'success' : 'primary'"><div class="version-card"><strong>v{{ version.version }} <el-tag v-if="version.isCurrent" size="small" type="success">当前</el-tag></strong><span>{{ version.changeSummary || '无变更说明' }}</span><small>Hash {{ version.manifestHash.slice(0,16) }}… · {{ version.createdBy }}</small><el-button v-if="!version.isCurrent" size="small" @click="rollbackVersion(version.version)">切换到此版本</el-button></div></el-timeline-item></el-timeline>
		</el-drawer>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { assetApi } from '/@/api/asset';
import { digitalTwinApi, type DigitalTwinSceneDetail, type DigitalTwinSceneSummary, type TwinModelResource, type TwinSceneVersion } from '/@/api/digital-twin';
import { cloneTwinManifest, createDefaultTwinSceneManifest, createRouteDecisionRule, createRouteEdge, createRoutePoint, createSilkCakeLineTwinSceneManifest, normalizeTwinRoute, validateTwinSceneManifest, type TwinBindingTargetKind, type TwinObjectBindingDefinition, type TwinRouteDecisionRule, type TwinRouteDefinition, type TwinRouteEdgeDefinition, type TwinRouteRuleOperator, type TwinSceneManifest, type TwinVector3 } from '/@/digital-twin/contracts';
import ThreeJsEditorHost from '/@/digital-twin/components/ThreeJsEditorHost.vue';
import { ThreeJsEditorAdapter } from '/@/digital-twin/editor-adapter/ThreeJsEditorAdapter';
import type { TwinRuntimeMetrics, TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';

interface AssetOption { id: string; name: string; description?: string }
interface AssetKey { keyName: string; name?: string }
interface AssetDevice { id: string; name: string; attrs?: AssetKey[]; temps?: AssetKey[] }

const router = useRouter();
const viewport = ref<HTMLDivElement>();
const uploadInput = ref<HTMLInputElement>();
const adapter = ref<ThreeJsEditorAdapter>();
const professionalEditor = ref<any>();
const manifest = ref<TwinSceneManifest>(createSilkCakeLineTwinSceneManifest());
const scenes = ref<DigitalTwinSceneSummary[]>([]);
const currentScene = ref<DigitalTwinSceneDetail>();
const selectedSceneId = ref('');
const assets = ref<AssetOption[]>([]);
const assetDevices = ref<AssetDevice[]>([]);
const models = ref<TwinModelResource[]>([]);
const versions = ref<TwinSceneVersion[]>([]);
const selected = ref<TwinSelectionInfo | null>(null);
const diagnostics = ref(validateTwinSceneManifest(manifest.value));
const pageLoading = ref(false), saving = ref(false), creating = ref(false), publishing = ref(false), uploading = ref(false);
const playing = ref(false), liveMode = ref(false), routeDrawMode = ref(false);
const viewportMode = ref<'editor' | 'runtime'>('editor');
const editorInstanceKey = ref(0);
const createDialogVisible = ref(false), resourceDrawerVisible = ref(false), versionsDrawerVisible = ref(false);
let snapshotTimer: number | undefined;
const modelBufferCache = new Map<string, { fileName: string; buffer: ArrayBuffer }>();

const createForm = reactive({ name: '50托盘丝饼产线数字孪生', description: '丝车供料、旋转定位、机器人上料、分段输送、PLC 岔口、桁架码垛和空塑料托盘回流。', rootAssetId: '' });
const uploadForm = reactive({ licenseType: 'Proprietary', author: '', sourceUrl: '', commercialUseAllowed: false });
const bindingForm = reactive({ deviceId: '', sourceKind: 'telemetry' as 'telemetry' | 'attribute' | 'connectivity', key: '', targetKind: 'color' as TwinBindingTargetKind });
const branchForm = reactive({ fromPointId: '', toPointId: '', bidirectional: false });
const ruleForm = reactive({ junctionPointId: '', edgeId: '', source: 'payload' as 'payload' | 'binding', payloadKey: 'sku', bindingId: '', operator: 'equals' as TwinRouteRuleOperator, matchValue: '', expectedActuatorValue: '' });
const routingPayloadText = ref('{"sku":"A","weight":1}');
const previewOccupancy = reactive<Record<string, number>>({});
const route = computed(() => manifest.value.routes[0]);
const junctionPoints = computed(() => route.value.points.filter((point) => ['junction', 'diverter', 'merger'].includes(point.kind || '')));
const decisionPoints = computed(() => junctionPoints.value.filter((point) => route.value.edges.filter((edge) => edge.enabled !== false && (edge.fromPointId === point.pointId || (edge.bidirectional && edge.toPointId === point.pointId))).length >= 2));
const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model'));
const selectedBindings = computed(() => manifest.value.bindings.filter((item) => item.objectId === selected.value?.objectId));
const selectedRuntimeData = computed(() => selected.value?.runtimeData ? JSON.stringify(selected.value.runtimeData, null, 2) : '');
const canAddBinding = computed(() => Boolean(selected.value?.objectId && bindingForm.deviceId && (bindingForm.key || bindingForm.sourceKind === 'connectivity')));
const selectedDevice = computed(() => assetDevices.value.find((item) => item.id === bindingForm.deviceId));
const routeBindingOptions = computed(() => manifest.value.bindings
	.filter((binding) => binding.transform.kind === 'routeEvent')
	.map((binding) => ({ value: binding.bindingId, label: `${binding.source.key || binding.bindingId} · ${binding.source.kind}` })));
const bindingKeys = computed(() => {
	if (bindingForm.sourceKind === 'connectivity') return [{ label: 'online', value: 'online' }];
	const source = bindingForm.sourceKind === 'telemetry' ? selectedDevice.value?.temps : selectedDevice.value?.attrs;
	return (source || []).map((item) => ({ label: item.name ? `${item.name} (${item.keyName})` : item.keyName, value: item.keyName }));
});
const routeStateText = computed(() => ({ running: '运行中', waiting: '等待放行', paused: '已暂停', completed: '已完成' })[metrics.state]);
const waitingReasonText = computed(() => ({ ROUTE_NOT_READY: 'PLC 路由未就绪', DIVERTER_NOT_READY: '分流机构未到位', TARGET_SECTION_FULL: '目标段已满', TARGET_SECTION_BLOCKED: '目标段封锁', TARGET_SECTION_SIGNAL_STALE: '目标段信号失效' })[metrics.waitingReason || 'TARGET_SECTION_BLOCKED']);
const curveOptions = [{ label: '直线', value: 'line' }, { label: '平滑曲线', value: 'catmullRom' }];
const routingModeOptions = [{ label: '手动', value: 'manual' }, { label: '自动规则', value: 'automatic' }];
const occupancyModeOptions = [{ label: '运行时计算', value: 'calculated' }, { label: '离线仿真', value: 'simulation' }, { label: 'PLC / IoT 实时', value: 'live' }];
const junctionDecisionModeOptions = [{ label: 'PLC 决策', value: 'plc' }, { label: '离线规则', value: 'simulation' }, { label: '人工调试', value: 'manual' }];
const ruleSourceOptions = [{ label: '物料属性', value: 'payload' }, { label: 'Device 信号', value: 'binding' }];
const routePointKindOptions = [{ label: '途经点', value: 'waypoint' }, { label: '普通交叉口', value: 'junction' }, { label: '分流器', value: 'diverter' }, { label: '汇流器', value: 'merger' }, { label: '缓存段', value: 'buffer' }, { label: '加工工位', value: 'processStation' }, { label: '传感器', value: 'sensor' }, { label: '站点', value: 'station' }];
const ruleOperatorOptions = [{ label: '等于', value: 'equals' }, { label: '不等于', value: 'notEquals' }, { label: '大于', value: 'greaterThan' }, { label: '大于等于', value: 'greaterThanOrEqual' }, { label: '小于', value: 'lessThan' }, { label: '小于等于', value: 'lessThanOrEqual' }, { label: '包含', value: 'contains' }, { label: '为真', value: 'truthy' }, { label: '为假', value: 'falsy' }];
const viewportModeOptions = [{ label: '专业编辑', value: 'editor' }, { label: '路线运行', value: 'runtime' }];
const metrics = reactive<TwinRuntimeMetrics>({ state: 'paused', distanceMeters: 0, lengthMeters: 0, progress: 0, speed: 1.2, activePointIds: [], activeEdgeIds: [], unavailableEdgeIds: [], fps: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 });

const apiData = <T,>(response: any): T => response.data as T;
const createId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const normalizeManifest = (value: TwinSceneManifest): TwinSceneManifest => {
	const normalized = cloneTwinManifest(value);
	normalized.bindings = value.bindings || [];
	normalized.resources = value.resources || [];
	normalized.objects = value.objects || [];
	normalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);
	normalized.editorExtension = value.editorExtension || { source: 'threejs-editor', payloadVersion: 2 };
	return normalized;
};
const refreshDiagnostics = () => { diagnostics.value = validateTwinSceneManifest(manifest.value); };
const routePointName = (pointId: string) => route.value.points.find((point) => point.pointId === pointId)?.name || pointId;
const routeEdgeLabel = (edge: TwinRouteEdgeDefinition) => `${routePointName(edge.fromPointId)} ${edge.bidirectional ? '↔' : '→'} ${routePointName(edge.toPointId)}`;
const junctionEdgeOptions = (pointId: string) => route.value.edges
	.filter((edge) => edge.enabled !== false && (edge.fromPointId === pointId || (edge.bidirectional && edge.toPointId === pointId)))
	.map((edge) => ({ value: edge.edgeId, label: `${routeEdgeLabel(edge)}${edge.blocked ? '（已封锁）' : ''}`, blocked: edge.blocked === true }));
const decisionRuleSummary = (rule: TwinRouteDecisionRule) => {
	const source = rule.source === 'binding' ? routeBindingOptions.value.find((item) => item.value === rule.bindingId)?.label || rule.bindingId : `物料.${rule.payloadKey}`;
	const operator = ruleOperatorOptions.find((item) => item.value === rule.operator)?.label || rule.operator;
	const actuator = rule.expectedActuatorValue === undefined ? '' : ` · 到位=${String(rule.expectedActuatorValue)}`;
	return `${source} ${operator}${['truthy', 'falsy'].includes(rule.operator) ? '' : ` ${String(rule.matchValue ?? '')}`} → ${route.value.edges.find((edge) => edge.edgeId === rule.edgeId)?.name || rule.edgeId}${actuator}`;
};
const parsePreviewPayload = (showError: boolean): Record<string, unknown> | undefined => {
	try {
		const value = JSON.parse(routingPayloadText.value || '{}');
		if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('物料属性必须是 JSON 对象');
		return value as Record<string, unknown>;
	} catch (error) {
		if (showError) ElMessage.error(error instanceof Error ? error.message : '物料属性 JSON 无效');
		return undefined;
	}
};

const reconcileRouteEditorState = (value: TwinRouteDefinition) => {
	const pointIds = new Set(value.points.map((point) => point.pointId));
	const edgeIds = new Set(value.edges.map((edge) => edge.edgeId));
	const decisionPointIds = new Set(value.points
		.filter((point) => ['junction', 'diverter', 'merger'].includes(point.kind || ''))
		.filter((point) => value.edges.filter((edge) => edge.enabled !== false && (edge.fromPointId === point.pointId || (edge.bidirectional && edge.toPointId === point.pointId))).length >= 2)
		.map((point) => point.pointId));

	if (branchForm.fromPointId && !pointIds.has(branchForm.fromPointId)) branchForm.fromPointId = '';
	if (branchForm.toPointId && !pointIds.has(branchForm.toPointId)) branchForm.toPointId = '';
	if (ruleForm.junctionPointId && !decisionPointIds.has(ruleForm.junctionPointId)) {
		ruleForm.junctionPointId = '';
		ruleForm.edgeId = '';
	} else if (ruleForm.edgeId && !edgeIds.has(ruleForm.edgeId)) ruleForm.edgeId = '';

	for (const edgeId of Object.keys(previewOccupancy)) {
		if (!edgeIds.has(edgeId)) delete previewOccupancy[edgeId];
	}
	for (const edgeId of edgeIds) {
		if (previewOccupancy[edgeId] === undefined) previewOccupancy[edgeId] = 0;
	}

	if (selected.value?.kind === 'route-point' && selected.value.routePointId && !pointIds.has(selected.value.routePointId)) selected.value = null;
};

const applyRuntimeRoute = (value: TwinRouteDefinition) => {
	manifest.value.routes.splice(0, 1, value);
	reconcileRouteEditorState(value);
	refreshDiagnostics();
};

const initializeRuntime = () => {
	if (!viewport.value) return;
	adapter.value?.dispose();
	adapter.value = new ThreeJsEditorAdapter(viewport.value, cloneTwinManifest(manifest.value), {
		onSelectionChange: (value) => { selected.value = value; },
		onRouteChange: applyRuntimeRoute,
		onMetrics: (value) => Object.assign(metrics, value),
		onError: (message) => ElMessage.error(message),
	});
	const payload = parsePreviewPayload(false);
	if (payload) adapter.value.setRouteRoutingContext({ payload, edgeOccupancy: { ...previewOccupancy } });
};

const initializeViewport = async () => {
	selected.value = null;
	adapter.value?.dispose();
	adapter.value = undefined;
	if (viewportMode.value === 'editor') {
		editorInstanceKey.value += 1;
		await nextTick();
	} else {
		await nextTick();
		initializeRuntime();
	}
	await loadReferencedModels();
};

const loadAssets = async () => { const response = await assetApi().assetList({ offset: 0, limit: 500, name: '' }); assets.value = response.data.rows || []; };
const loadAssetDevices = async (assetId?: string | number | boolean | null) => {
	assetDevices.value = [];
	const id = typeof assetId === 'string' ? assetId : manifest.value.rootAssetId;
	if (!id) return;
	const response = await assetApi().relations({ assetId: id }); assetDevices.value = response.data.rows || []; refreshDiagnostics();
};
const changeRootAsset = async (assetId: string | number | boolean) => {
	if (typeof assetId !== 'string') return;
	for (const item of manifest.value.objects) item.assetId = assetId;
	for (const item of manifest.value.bindings) item.source.assetId = assetId;
	await loadAssetDevices(assetId); adapter.value?.loadManifest(manifest.value);
};
const loadModels = async () => { models.value = apiData<TwinModelResource[]>(await digitalTwinApi.listModels({})); };
const loadScenes = async () => { scenes.value = apiData<DigitalTwinSceneSummary[]>(await digitalTwinApi.listScenes()); };

const loadScene = async (sceneId: string | number | boolean) => {
	if (typeof sceneId !== 'string' || !sceneId) return;
	pageLoading.value = true;
	try {
		const detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(sceneId));
		currentScene.value = detail; selectedSceneId.value = detail.id; manifest.value = normalizeManifest(detail.draftPayload);
		for (const key of Object.keys(previewOccupancy)) delete previewOccupancy[key];
		for (const edge of route.value.edges) previewOccupancy[edge.edgeId] = 0;
		await loadAssetDevices(detail.rootAssetId); await initializeViewport(); refreshDiagnostics();
		if (liveMode.value) startSnapshotPolling();
	} catch { ElMessage.error('数字孪生场景加载失败'); }
	finally { pageLoading.value = false; }
};

const loadReferencedModels = async () => {
	for (const object of modelObjects.value) {
		const model = models.value.find((item) => item.id === object.resourceId); if (!model) continue;
		try {
			let cached = modelBufferCache.get(model.id);
			if (!cached) {
				const response: any = await digitalTwinApi.downloadModel(model.id);
				const buffer = (response?.data instanceof ArrayBuffer ? response.data : response) as ArrayBuffer;
				cached = { fileName: model.originalFileName, buffer };
				modelBufferCache.set(model.id, cached);
			}
			if (viewportMode.value === 'editor') await professionalEditor.value?.loadGlbBuffer(object, cached.fileName, cached.buffer);
			else await adapter.value?.loadGlbBuffer(object.objectId, cached.fileName, cached.buffer);
		}
		catch { ElMessage.warning(`模型 ${model.name} 加载失败，场景其余部分仍可编辑`); }
	}
};

const createScene = async () => {
	if (!createForm.name.trim() || !createForm.rootAssetId) { ElMessage.warning('请填写场景名称并选择根 Asset'); return; }
	creating.value = true;
	try {
		const draft = createSilkCakeLineTwinSceneManifest(); draft.name = createForm.name.trim(); draft.description = createForm.description.trim(); draft.rootAssetId = createForm.rootAssetId;
		for (const object of draft.objects) object.assetId = createForm.rootAssetId;
		const detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.createScene({ name: draft.name, description: draft.description, rootAssetId: createForm.rootAssetId, draftPayload: draft }));
		createDialogVisible.value = false; viewportMode.value = 'runtime'; await loadScenes(); await loadScene(detail.id); ElMessage.success('丝饼产线、工艺参数、路线和 50 个塑料托盘配置已写入数据库，点击“运行”即可启动');
	} finally { creating.value = false; }
};

const applySilkCakeLineTemplate = async () => {
	if (!currentScene.value) {
		createForm.name = '50托盘丝饼产线数字孪生';
		createForm.description = '丝车供料、旋转定位、机器人上料、分段输送、PLC 岔口、桁架码垛和空塑料托盘回流。';
		createDialogVisible.value = true;
		return;
	}
	const confirmed = await ElMessageBox.confirm('这会替换当前场景草稿中的对象、路线、丝饼仿真参数和编辑器快照，并立即保存到数据库；历史发布版本不受影响。', '应用 50 托盘丝饼产线模板', { type: 'warning' })
		.then(() => true)
		.catch(() => false);
	if (!confirmed) return;
	const draft = createSilkCakeLineTwinSceneManifest();
	draft.sceneId = manifest.value.sceneId;
	draft.rootAssetId = manifest.value.rootAssetId;
	for (const object of draft.objects) object.assetId = draft.rootAssetId || undefined;
	manifest.value = draft;
	for (const key of Object.keys(previewOccupancy)) delete previewOccupancy[key];
	for (const edge of route.value.edges) previewOccupancy[edge.edgeId] = 0;
	routingPayloadText.value = '{"sku":"A","weight":1}';
	playing.value = false;
	liveMode.value = false;
	routeDrawMode.value = false;
	viewportMode.value = 'runtime';
	await initializeViewport();
	refreshDiagnostics();
	if (await saveDraft(true)) ElMessage.success('丝饼产线已生成并入库，点击“运行”即可观察机器人上料、分段阻塞、桁架码垛和空托盘回流');
};

const saveDraft = async (silent = false) => {
	if (!currentScene.value) { ElMessage.warning('请先新建或选择数据库场景'); return false; }
	if (viewportMode.value === 'editor') professionalEditor.value?.captureManifest(manifest.value);
	refreshDiagnostics(); const errors = diagnostics.value.filter((item) => item.severity === 'error');
	if (errors.length) { ElMessage.error(`存在 ${errors.length} 个阻断错误，无法保存`); return false; }
	saving.value = true;
	try {
		let detail = currentScene.value;
		if (detail.name !== manifest.value.name || detail.description !== manifest.value.description || detail.rootAssetId !== manifest.value.rootAssetId) {
			detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.updateScene(detail.id, { name: manifest.value.name, description: manifest.value.description, rootAssetId: String(manifest.value.rootAssetId) }));
		}
		detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.saveDraft(detail.id, detail.revision, manifest.value));
		currentScene.value = detail;
		const persistedManifest = normalizeManifest(detail.draftPayload);
		if (viewportMode.value === 'editor') Object.assign(manifest.value, persistedManifest);
		else { manifest.value = persistedManifest; adapter.value?.loadManifest(manifest.value); }
		await loadScenes();
		if (!silent) ElMessage.success(`草稿 r${detail.revision} 已保存；${detail.bindings.length} 条资源/数据绑定已入库`);
		return true;
	} catch (error: any) { ElMessage.error(error?.msg || '草稿保存失败，可能存在版本冲突'); return false; }
	finally { saving.value = false; }
};

const validateScene = async () => {
	refreshDiagnostics(); if (!currentScene.value) { ElMessage.warning('当前只是未入库模板'); return; }
	if (!(await saveDraft(true))) return;
	const result = apiData<{ valid: boolean; diagnostics: any[] }>(await digitalTwinApi.validateScene(currentScene.value.id, false)); diagnostics.value = result.diagnostics;
	result.valid ? ElMessage.success('前后端场景校验通过') : ElMessage.error('后端引用校验未通过');
};

const publishScene = async () => {
	if (!currentScene.value || !(await saveDraft(true))) return;
	publishing.value = true;
	try {
		const validation = apiData<{ valid: boolean; diagnostics: any[] }>(await digitalTwinApi.validateScene(currentScene.value.id, true)); diagnostics.value = validation.diagnostics;
		if (!validation.valid) { ElMessage.error('发布校验未通过，请检查模型授权和 Device 引用'); return; }
		const summary = `发布于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
		const version = apiData<TwinSceneVersion>(await digitalTwinApi.publishScene(currentScene.value.id, currentScene.value.revision, summary));
		await loadScene(currentScene.value.id); await loadScenes(); ElMessage.success(`v${version.version} 已发布，绑定和路线版本快照已入库`);
	} finally { publishing.value = false; }
};

const openVersions = async () => {
	if (!currentScene.value) { ElMessage.warning('当前场景尚未入库'); return; }
	versions.value = apiData<TwinSceneVersion[]>(await digitalTwinApi.listVersions(currentScene.value.id)); versionsDrawerVisible.value = true;
};
const rollbackVersion = async (version: number) => {
	if (!currentScene.value) return;
	await ElMessageBox.confirm(`运行态将切换到 v${version} 的 Manifest 与绑定快照，草稿不会被覆盖。`, '确认回滚发布指针');
	await digitalTwinApi.rollback(currentScene.value.id, version); await openVersions(); await loadScene(currentScene.value.id); ElMessage.success(`运行态已切换到 v${version}`);
};

const uploadModel = async (event: Event) => {
	const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return;
	if (!uploadForm.commercialUseAllowed) { ElMessage.warning('请先确认该模型的商业使用授权'); return; }
	uploading.value = true;
	try {
		const data = new FormData(); data.append('file', file); data.append('name', file.name.replace(/\.glb$/i, '')); data.append('resourceKey', createId('model'));
		data.append('sourceType', 'Upload'); data.append('licenseType', uploadForm.licenseType); data.append('author', uploadForm.author); data.append('sourceUrl', uploadForm.sourceUrl); data.append('commercialUseAllowed', String(uploadForm.commercialUseAllowed));
		await digitalTwinApi.uploadModel(data); await loadModels(); ElMessage.success('GLB 已校验、计算 Hash 并存入租户模型资源库');
	} finally { uploading.value = false; }
};

const placeModel = async (model: TwinModelResource) => {
	const objectId = createId('object');
	if (!manifest.value.resources.some((item) => item.resourceId === model.id)) manifest.value.resources.push({ resourceId: model.id, name: model.name, sourceFileName: model.originalFileName, status: 'ready' });
	manifest.value.objects.push({ objectId, name: model.name, kind: 'model', resourceId: model.id, assetId: manifest.value.rootAssetId || undefined, transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
	adapter.value?.loadManifest(manifest.value);
	try {
		let cached = modelBufferCache.get(model.id);
		if (!cached) {
			const response: any = await digitalTwinApi.downloadModel(model.id);
			const buffer = (response?.data instanceof ArrayBuffer ? response.data : response) as ArrayBuffer;
			cached = { fileName: model.originalFileName, buffer };
			modelBufferCache.set(model.id, cached);
		}
		const object = manifest.value.objects.find((item) => item.objectId === objectId)!;
		if (viewportMode.value === 'editor') await professionalEditor.value?.loadGlbBuffer(object, cached.fileName, cached.buffer);
		else await adapter.value?.loadGlbBuffer(objectId, cached.fileName, cached.buffer);
		resourceDrawerVisible.value = false; refreshDiagnostics(); ElMessage.success('模型已放入 threejs-editor；保存后资源绑定和编辑快照会写入数据库');
	}
	catch { removeModelObject(objectId); ElMessage.error('模型内容下载或解析失败'); }
};
const removeModelObject = (objectId: string) => {
	if (viewportMode.value === 'editor') professionalEditor.value?.removeObject(objectId);
	const index = manifest.value.objects.findIndex((item) => item.objectId === objectId); if (index >= 0) manifest.value.objects.splice(index, 1);
	manifest.value.bindings = manifest.value.bindings.filter((item) => item.objectId !== objectId);
	const used = new Set(manifest.value.objects.map((item) => item.resourceId).filter(Boolean)); manifest.value.resources = manifest.value.resources.filter((item) => used.has(item.resourceId));
	if (viewportMode.value === 'runtime') { initializeRuntime(); loadReferencedModels(); }
	refreshDiagnostics();
};

const bindingTransform = (target: TwinBindingTargetKind): TwinObjectBindingDefinition['transform'] => {
	if (target === 'color') return { kind: 'booleanColor', trueColor: '#22c55e', falseColor: '#ef4444' };
	if (target === 'visible') return { kind: 'booleanVisibility' };
	if (target === 'animation') return { kind: 'booleanAnimation', trueValue: { speed: 2 }, falseValue: { speed: 0 } };
	if (target === 'routeProgress') return { kind: 'routeProgress', factor: 1, offset: 0 };
	if (target === 'customProperty') return { kind: 'routeEvent' };
	if (target === 'opacity') return { kind: 'numberScale', factor: 1, min: 0, max: 1 };
	return { kind: 'identity' };
};
const addBinding = () => {
	if (!selected.value?.objectId || !canAddBinding.value) return;
	const key = bindingForm.sourceKind === 'connectivity' ? (bindingForm.key || 'online') : bindingForm.key;
	manifest.value.bindings.push({ bindingId: createId('binding'), objectId: selected.value.objectId, nodePath: selected.value.nodePath, source: { kind: bindingForm.sourceKind, assetId: manifest.value.rootAssetId || undefined, deviceId: bindingForm.deviceId, key }, target: { kind: bindingForm.targetKind, property: bindingForm.targetKind === 'animation' ? 'rotation.y' : bindingForm.targetKind === 'customProperty' ? 'routeSignal' : undefined }, transform: bindingTransform(bindingForm.targetKind), staleAfterMs: 10000, priority: 0, enabled: true });
	adapter.value?.loadManifest(manifest.value); refreshDiagnostics(); ElMessage.success('绑定已加入草稿；点击“保存草稿”后正式入库');
};
const removeBinding = (bindingId: string) => {
	manifest.value.bindings = manifest.value.bindings.filter((item) => item.bindingId !== bindingId);
	for (const point of route.value.points) {
		if (point.actuatorBindingId === bindingId) delete point.actuatorBindingId;
		if (point.sensorBindingId === bindingId) delete point.sensorBindingId;
	}
	for (const edge of route.value.edges) {
		if (edge.occupancyBindingId === bindingId) delete edge.occupancyBindingId;
		if (edge.fullBindingId === bindingId) delete edge.fullBindingId;
		if (edge.blockedBindingId === bindingId) delete edge.blockedBindingId;
	}
	route.value.decisionRules = route.value.decisionRules.filter((rule) => rule.bindingId !== bindingId);
	adapter.value?.loadManifest(manifest.value);
	refreshDiagnostics();
};

const refreshSnapshot = async () => {
	if (!liveMode.value || !currentScene.value?.publishedVersionId) return;
	try { adapter.value?.applyDataUpdates(apiData<any>(await digitalTwinApi.snapshot(currentScene.value.id)).updates || []); } catch { /* 下一轮自动重试。 */ }
};
const stopSnapshotPolling = () => { if (snapshotTimer !== undefined) window.clearInterval(snapshotTimer); snapshotTimer = undefined; };
const startSnapshotPolling = () => { stopSnapshotPolling(); refreshSnapshot(); snapshotTimer = window.setInterval(refreshSnapshot, 2000); };
const switchViewportMode = async (value: string | number | boolean) => {
	// 从专业编辑器离开前先把尚未保存的变换写回内存 Manifest，路线运行才能立即看到最新位置。
	professionalEditor.value?.captureManifest(manifest.value);
	viewportMode.value = value === 'runtime' ? 'runtime' : 'editor';
	playing.value = false; routeDrawMode.value = false;
	await initializeViewport();
};
const toggleLiveMode = async (value: string | number | boolean) => {
	liveMode.value = Boolean(value); manifest.value.runtime.dataMode = liveMode.value ? 'live' : 'simulation';
	if (liveMode.value && viewportMode.value !== 'runtime') await switchViewportMode('runtime');
	liveMode.value ? startSnapshotPolling() : stopSnapshotPolling();
};
const togglePlaying = async () => {
	if (viewportMode.value !== 'runtime') await switchViewportMode('runtime');
	playing.value = !playing.value; adapter.value?.setRunning(playing.value);
};
const toggleRouteDrawMode = async () => {
	if (viewportMode.value !== 'runtime') await switchViewportMode('runtime');
	routeDrawMode.value = !routeDrawMode.value; adapter.value?.setRouteDrawMode(routeDrawMode.value);
};
const changeSpeed = (value: number | number[]) => adapter.value?.setSpeed(Array.isArray(value) ? value[0] : value);
const applySilkSimulationOptions = async () => {
	const options = manifest.value.runtime.silkLineSimulation;
	if (!options) return;
	const procedural = manifest.value.objects.find((item) => ['packaging-line', 'silk-cake-line'].includes(item.procedural?.preset || ''));
	if (procedural?.procedural) procedural.procedural.palletCount = options.palletCount;
	playing.value = false;
	if (viewportMode.value === 'runtime') await initializeViewport();
	else await switchViewportMode('runtime');
	refreshDiagnostics();
};
const changeCurveKind = (value: string | number | boolean) => adapter.value?.setRouteCurveKind(value as TwinRouteDefinition['curveKind']);
const changeLoop = (value: string | number | boolean) => adapter.value?.setRouteLoop(Boolean(value));
const ensureRuntimeViewport = async () => {
	if (viewportMode.value !== 'runtime') await switchViewportMode('runtime');
};
const syncRouteGraph = async () => {
	await ensureRuntimeViewport();
	adapter.value?.setRoute(cloneTwinManifest({ ...manifest.value, routes: [route.value] }).routes[0]);
	const payload = parsePreviewPayload(false);
	if (payload) adapter.value?.setRouteRoutingContext({ payload, edgeOccupancy: { ...previewOccupancy } });
	refreshDiagnostics();
};
const applyRoutingPreview = async (notify = true) => {
	const payload = parsePreviewPayload(notify);
	if (!payload) return;
	await ensureRuntimeViewport();
	adapter.value?.setRouteRoutingContext({ payload, edgeOccupancy: { ...previewOccupancy } });
	if (notify) {
		playing.value = false;
		adapter.value?.resetRoute();
		ElMessage.success('已按物料属性、实时信号和输送段容量重新计算路线');
	}
};
const recalculateJunctionKinds = (downgrade = false) => {
	const counts = new Map<string, number>();
	for (const edge of route.value.edges.filter((item) => item.enabled !== false)) {
		counts.set(edge.fromPointId, (counts.get(edge.fromPointId) || 0) + 1);
		counts.set(edge.toPointId, (counts.get(edge.toPointId) || 0) + 1);
	}
	for (const point of route.value.points) {
		if ((counts.get(point.pointId) || 0) >= 3 && (!point.kind || point.kind === 'waypoint')) point.kind = 'junction';
		else if (downgrade && point.kind === 'junction') {
			point.kind = 'waypoint';
			delete route.value.junctionDecisions[point.pointId];
		}
	}
};
const addStandaloneRoutePoint = async () => {
	const last = route.value.points[route.value.points.length - 1]?.position || [0, 0.72, 0];
	const point = createRoutePoint([last[0], last[1], last[2] + 2], route.value.points.length);
	point.name = `分支节点 ${route.value.points.length + 1}`;
	route.value.points.push(point);
	branchForm.toPointId = point.pointId;
	await syncRouteGraph();
};
const addRouteEdge = async () => {
	if (!branchForm.fromPointId || !branchForm.toPointId || branchForm.fromPointId === branchForm.toPointId) { ElMessage.warning('请选择两个不同的路线节点'); return; }
	const duplicate = route.value.edges.some((edge) => edge.fromPointId === branchForm.fromPointId && edge.toPointId === branchForm.toPointId);
	if (duplicate) { ElMessage.warning('这两个节点已经存在同向连线'); return; }
	const edge = createRouteEdge(branchForm.fromPointId, branchForm.toPointId, route.value.edges.length);
	edge.bidirectional = branchForm.bidirectional;
	route.value.edges.push(edge);
	previewOccupancy[edge.edgeId] = 0;
	recalculateJunctionKinds();
	const fromPoint = route.value.points.find((point) => point.pointId === branchForm.fromPointId);
	if (fromPoint && ['junction', 'diverter'].includes(fromPoint.kind || '') && !route.value.junctionDecisions[fromPoint.pointId]) {
		const firstAvailable = junctionEdgeOptions(fromPoint.pointId).find((item) => !item.blocked);
		if (firstAvailable) route.value.junctionDecisions[fromPoint.pointId] = firstAvailable.value;
	}
	await syncRouteGraph();
	ElMessage.success('分支已连接；橙色节点表示交叉口');
};
const removeRouteEdge = async (edgeId: string) => {
	route.value.edges = route.value.edges.filter((edge) => edge.edgeId !== edgeId);
	delete previewOccupancy[edgeId];
	route.value.decisionRules = route.value.decisionRules.filter((rule) => rule.edgeId !== edgeId);
	for (const [pointId, selectedEdgeId] of Object.entries(route.value.junctionDecisions)) {
		if (selectedEdgeId === edgeId) delete route.value.junctionDecisions[pointId];
	}
	recalculateJunctionKinds(true);
	await syncRouteGraph();
};
const parseRuleValue = (value: string): string | number | boolean => {
	if (value.toLowerCase() === 'true') return true;
	if (value.toLowerCase() === 'false') return false;
	if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
	return value;
};
const addDecisionRule = async () => {
	if (!ruleForm.junctionPointId || !ruleForm.edgeId) { ElMessage.warning('请选择分流节点和目标输送线'); return; }
	if (ruleForm.source === 'payload' && !ruleForm.payloadKey.trim()) { ElMessage.warning('请填写物料属性 Key'); return; }
	if (ruleForm.source === 'binding' && !ruleForm.bindingId) { ElMessage.warning('请选择 Device 信号绑定'); return; }
	const rule = createRouteDecisionRule(ruleForm.junctionPointId, ruleForm.edgeId, route.value.decisionRules.length);
	rule.source = ruleForm.source;
	rule.payloadKey = ruleForm.source === 'payload' ? ruleForm.payloadKey.trim() : undefined;
	rule.bindingId = ruleForm.source === 'binding' ? ruleForm.bindingId : undefined;
	rule.operator = ruleForm.operator;
	rule.matchValue = ['truthy', 'falsy'].includes(rule.operator) ? undefined : parseRuleValue(ruleForm.matchValue);
	rule.expectedActuatorValue = ruleForm.expectedActuatorValue.trim() ? parseRuleValue(ruleForm.expectedActuatorValue) : undefined;
	rule.priority = 100;
	route.value.decisionRules.push(rule);
	await syncRouteGraph();
	ElMessage.success('自动选路规则已加入路线草稿');
};
const removeDecisionRule = async (ruleId: string) => {
	route.value.decisionRules = route.value.decisionRules.filter((rule) => rule.ruleId !== ruleId);
	await syncRouteGraph();
};
const updateRoutePoint = async (index: number) => {
	await ensureRuntimeViewport();
	const point = route.value.points[index];
	if (point) adapter.value?.updateRoutePoint(index, [...point.position] as TwinVector3);
};
const addRoutePoint = async () => { await ensureRuntimeViewport(); adapter.value?.addRoutePoint(); };
const removeRoutePoint = async (index: number) => {
	await ensureRuntimeViewport();
	const point = route.value.points[index];
	const currentAdapter = adapter.value;
	if (!point || !currentAdapter) return;

	// 控制点删除会同时删除相邻路线边。页面表单持有的是 ID，必须一起清理，否则 Element Plus 会继续显示旧标签。
	const removedEdgeIds = new Set(route.value.edges
		.filter((edge) => edge.fromPointId === point.pointId || edge.toPointId === point.pointId)
		.map((edge) => edge.edgeId));
	if (branchForm.fromPointId === point.pointId) branchForm.fromPointId = '';
	if (branchForm.toPointId === point.pointId) branchForm.toPointId = '';
	if (ruleForm.junctionPointId === point.pointId) {
		ruleForm.junctionPointId = '';
		ruleForm.edgeId = '';
	} else if (removedEdgeIds.has(ruleForm.edgeId)) ruleForm.edgeId = '';
	for (const edgeId of removedEdgeIds) delete previewOccupancy[edgeId];
	if (selected.value?.kind === 'route-point') selected.value = null;

	currentAdapter.removeRoutePoint(index);
	// 事件回调会同步 Manifest；这里再从运行时读取一次，避免任何视图切换时序导致左侧列表保留旧数组。
	applyRuntimeRoute(currentAdapter.getRoute());
};
const focusSelected = () => viewportMode.value === 'editor' ? professionalEditor.value?.focusSelected() : adapter.value?.focusSelected();
const selectSceneObject = (objectId: string) => { if (viewportMode.value === 'editor') professionalEditor.value?.selectObject(objectId); };
const markEditorChanged = () => { refreshDiagnostics(); };
const exportManifest = () => { const blob = new Blob([JSON.stringify(manifest.value, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${manifest.value.name.replace(/[\\/:*?"<>|]/g, '-')}.twin.json`; anchor.click(); URL.revokeObjectURL(url); };
const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value || 0);
const formatBytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

onMounted(async () => {
	pageLoading.value = true;
	try { await Promise.all([loadAssets(), loadModels(), loadScenes()]); await nextTick(); if (scenes.value[0]) await loadScene(scenes.value[0].id); else { await initializeViewport(); createDialogVisible.value = true; } }
	finally { pageLoading.value = false; }
});
onBeforeUnmount(() => { stopSnapshotPolling(); adapter.value?.dispose(); adapter.value = undefined; professionalEditor.value = undefined; modelBufferCache.clear(); });
</script>

<style scoped lang="scss">
.twin-workbench{--border:rgba(148,163,184,.2);--panel:rgba(8,19,34,.97);display:flex;flex-direction:column;min-height:calc(100vh - 132px);margin:-15px;color:#dbeafe;background:#07111f;overflow:hidden}.twin-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:70px;padding:10px 18px;border-bottom:1px solid var(--border);background:#07111f}.twin-toolbar__title,.twin-toolbar__actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.twin-toolbar__title{min-width:320px}.scene-select{width:220px}.twin-toolbar__eyebrow,.twin-panel__heading span{font-size:10px;font-weight:800;letter-spacing:.15em;color:#38bdf8}.is-hidden{display:none}
.twin-status-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--border);background:#0a1728}.twin-status-strip>div{display:flex;flex-direction:column;gap:4px;padding:9px 15px;border-right:1px solid var(--border)}.twin-status-strip span,.twin-card__label{font-size:11px;color:#7f95ad}.twin-status-strip strong{font-size:12px}.twin-status-strip strong small{font:inherit}.is-running{color:#4ade80}.is-paused{color:#fbbf24}.is-waiting{color:#fb7185}.is-completed{color:#38bdf8}
.twin-layout{display:grid;grid-template-columns:300px minmax(420px,1fr) 310px;min-height:0;flex:1}.twin-panel{min-height:0;padding:14px;background:var(--panel);overflow:auto}.twin-panel--left{border-right:1px solid var(--border)}.twin-panel--right{border-left:1px solid var(--border)}.twin-panel__heading,.twin-panel__subheading,.twin-inline-control{display:flex;align-items:center;justify-content:space-between;gap:10px}.twin-panel__heading>div{display:flex;flex-direction:column;gap:5px}.twin-panel__heading strong,.twin-panel__subheading strong{color:#f8fafc}.twin-panel__subheading{margin-top:18px}
.twin-card{display:flex;flex-direction:column;gap:9px;margin-top:14px;padding:13px;border:1px solid var(--border);border-radius:12px;background:rgba(15,31,52,.82)}.twin-card label{font-size:12px;color:#9fb2c8}.twin-card small,.compact-list small,.binding-list small,.resource-card small,.version-card small{line-height:1.5;color:#7890a8;word-break:break-all}.twin-selection-card>strong,.resource-card strong{color:#f8fafc}.compact-list,.binding-list,.resource-grid{display:flex;flex-direction:column;gap:8px;margin-top:10px}.compact-list>div,.binding-list>div{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:rgba(15,31,52,.65)}.binding-list>div>div{display:flex;flex-direction:column;gap:3px}
.twin-runtime-detail{max-height:230px;margin:0;padding:9px;border:1px solid rgba(56,189,248,.22);border-radius:8px;background:rgba(2,8,23,.72);overflow:auto;color:#bae6fd;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.silk-simulation-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.silk-simulation-grid>label{display:flex;flex-direction:column;gap:4px}.silk-simulation-grid>label>span{display:flex;gap:3px}.silk-simulation-grid :deep(.el-input-number){width:100%}.twin-status-strip--silk{background:#0b1d27}.twin-status-strip--silk strong{color:#a7f3d0}
.twin-route-points{display:flex;flex-direction:column;gap:8px;margin-top:10px}.twin-route-point{padding:9px;border:1px solid var(--border);border-radius:10px;background:rgba(15,31,52,.65)}.twin-route-point.is-selected{border-color:#38bdf8}.twin-route-point__title{display:grid;grid-template-columns:24px 1fr 28px;align-items:center;gap:6px}.twin-route-point__title>span{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;font-size:11px;background:rgba(14,165,233,.2);color:#7dd3fc}.twin-route-point__meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}.twin-route-point__meta :deep(.el-select){width:130px}.twin-route-binding-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}.twin-coordinate-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:7px}.twin-coordinate-grid :deep(.el-input-number){width:100%}.twin-route-graph-editor{gap:8px}.twin-route-edge-form{display:grid;grid-template-columns:1fr 1fr;gap:6px}.twin-route-edges{display:flex;flex-direction:column;gap:7px;margin-top:9px}.twin-route-edge{display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:9px;border:1px solid var(--border);border-radius:9px;background:rgba(15,31,52,.65)}.twin-route-edge.is-blocked{border-color:rgba(239,68,68,.5)}.twin-route-edge__header{display:grid;grid-template-columns:minmax(0,1fr) auto 28px;align-items:center;gap:7px}.twin-route-edge__header>div{display:flex;min-width:0;flex-direction:column;gap:2px}.twin-route-edge__settings{display:grid;grid-template-columns:1fr 1fr;gap:6px}.twin-route-edge__settings>div{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:5px}.twin-route-edge__settings label{font-size:10px}.twin-route-edge strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.twin-route-edge small{font-size:10px;color:#7890a8}.twin-junction-decision{border-color:rgba(245,158,11,.35)}.twin-routing-preview{border-color:rgba(34,197,94,.32)}.twin-route-rules{display:flex;flex-direction:column;gap:7px;margin-top:9px}.twin-route-rules>div{display:grid;grid-template-columns:minmax(0,1fr) auto 28px;align-items:center;gap:7px;padding:8px 9px;border:1px solid rgba(34,197,94,.3);border-radius:9px;background:rgba(15,31,52,.65)}.twin-route-rules>div>div{display:flex;min-width:0;flex-direction:column;gap:2px}.twin-route-rules strong{font-size:11px}.twin-route-rules small{overflow:hidden;font-size:10px;color:#7890a8;text-overflow:ellipsis;white-space:nowrap}
.twin-viewport-shell{position:relative;min-width:0;min-height:560px;background:#050c16}.twin-viewport{position:absolute;inset:0}.twin-viewport :deep(canvas){display:block;width:100%;height:100%;outline:none}.twin-viewport__hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 11px;border:1px solid var(--border);border-radius:20px;font-size:11px;color:#9fb2c8;background:rgba(3,10,19,.8);pointer-events:none}.twin-progress{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(56,189,248,.12)}.twin-progress i{display:block;height:100%;background:#38bdf8;transition:width .15s linear}
.twin-diagnostics{display:flex;flex-direction:column;gap:7px;margin-top:14px}.twin-diagnostics>div{display:grid;grid-template-columns:42px 1fr;gap:7px;padding:8px;border-radius:8px;font-size:11px;line-height:1.45}.twin-diagnostics .is-error{background:rgba(239,68,68,.12);color:#fca5a5}.twin-diagnostics .is-warning{background:rgba(245,158,11,.12);color:#fcd34d}.twin-diagnostics .is-success{background:rgba(34,197,94,.12);color:#86efac}.resource-actions{display:flex;gap:8px;margin-bottom:12px}.resource-grid{margin-top:14px}.resource-card{display:grid;grid-template-columns:1fr auto;gap:8px;padding:13px;border:1px solid var(--el-border-color);border-radius:10px}.resource-card>div,.version-card{display:flex;flex-direction:column;gap:5px}.resource-card>.el-button{grid-column:1/-1}.version-card>span{color:var(--el-text-color-regular)}
@media(max-width:1200px){.twin-layout{grid-template-columns:260px minmax(360px,1fr) 280px}.twin-toolbar{align-items:flex-start;flex-direction:column}.twin-status-strip{grid-template-columns:repeat(3,1fr)}}
</style>
