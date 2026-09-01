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
				<el-button @click="router.push('/iot/digital-twin/2d-scene')">2D 场景</el-button>
				<el-segmented v-model="viewportMode" :options="viewportModeOptions" @change="switchViewportMode" />
				<el-button @click="createDialogVisible = true">新建场景</el-button>
				<el-button type="warning" plain @click="applySilkCakeLineTemplate">完整工艺 V6</el-button>
				<el-button @click="router.push('/iot/digital-twin/model-generator')">生成模型</el-button>
				<el-button @click="resourceDrawerVisible = true">模型资源库</el-button>
				<el-button :type="routeDrawMode ? 'warning' : 'default'" :disabled="routeIsGenerated" @click="toggleRouteDrawMode">{{ routeDrawMode ? '结束绘制' : '绘制路线' }}</el-button>
				<el-button :type="playing ? 'danger' : 'primary'" @click="togglePlaying">{{ playing ? '暂停' : '运行' }}</el-button>
				<el-button :loading="saving" :disabled="!currentScene" @click="saveDraft()">保存草稿</el-button>
				<el-button type="success" :loading="publishing" :disabled="!currentScene" @click="publishScene">发布</el-button>
				<el-dropdown trigger="click">
					<el-button>更多</el-button>
					<template #dropdown><el-dropdown-menu>
						<el-dropdown-item @click="router.push('/iot/digital-twin/scenes')">场景中心</el-dropdown-item>
						<el-dropdown-item v-if="currentScene?.publishedVersion" @click="router.push({ path:'/iot/digital-twin/viewer', query:{ sceneId: currentScene.id, version: currentScene.publishedVersion } })">查看线上版本</el-dropdown-item>
						<el-dropdown-item @click="validateScene">场景校验</el-dropdown-item>
						<el-dropdown-item @click="openVersions">版本与回滚</el-dropdown-item>
						<el-dropdown-item divided @click="exportManifest">导出 Manifest</el-dropdown-item>
					</el-dropdown-menu></template>
				</el-dropdown>
			</div>
		</header>

		<section v-if="viewportMode === 'runtime'" class="twin-status-strip">
			<div><span>路线状态</span><strong :class="`is-${metrics.state}`">{{ routeStateText }}<small v-if="metrics.waitingEdgeId || metrics.waitingPointId"> · {{ waitingReasonText }}</small></strong></div>
			<div><span>位置</span><strong>{{ metrics.distanceMeters.toFixed(2) }} / {{ metrics.lengthMeters.toFixed(2) }} m</strong></div>
			<div><span>实时绑定</span><strong>{{ manifest.bindings.length }} 条 · {{ liveMode ? '轮询中' : '已暂停' }}</strong></div>
			<div><span>渲染</span><strong>{{ metrics.fps }} FPS · {{ metrics.drawCalls }} calls</strong></div>
			<div><span>场景规模</span><strong>{{ formatNumber(metrics.triangles) }} triangles</strong></div>
		</section>
		<section v-if="viewportMode === 'runtime' && metrics.silkLine" class="twin-status-strip twin-status-strip--silk">
			<div><span>双面丝车</span><strong>{{ metrics.silkLine.cartSide }} 面 · Row {{ metrics.silkLine.cartRow }} · {{ metrics.silkLine.cartRemaining }}/{{ metrics.silkLine.cartCapacity }}</strong></div>
			<div><span>Robot 1×6</span><strong>{{ metrics.silkLine.robotState }} · Batch {{ metrics.silkLine.robotBatchSize }}/6 · 空托 {{ metrics.silkLine.loadingBufferReady }}/6 · 短回流 {{ metrics.silkLine.emptyBypassCount }}</strong></div>
			<div><span>外检机</span><strong>{{ metrics.silkLine.inspectionState }} · PASS {{ metrics.silkLine.inspectionPassed }} · NG {{ metrics.silkLine.inspectionNg }} · {{ Math.round(metrics.silkLine.inspectionProgress * 100) }}%</strong></div>
			<div><span>套袋机</span><strong>{{ metrics.silkLine.baggingState }} · Completed {{ metrics.silkLine.baggingCompleted }} · {{ Math.round(metrics.silkLine.baggingProgress * 100) }}%</strong></div>
			<div><span>Gantry 2×3</span><strong>{{ metrics.silkLine.gantryState }} · A {{ metrics.silkLine.gantryLaneA }}/3 · B {{ metrics.silkLine.gantryLaneB }}/3</strong></div>
			<div><span>木托盘码垛</span><strong>Layer {{ metrics.silkLine.woodenPalletLayer }}/{{ metrics.silkLine.woodenPalletLayers }} · {{ metrics.silkLine.woodenPalletCakes }}/{{ metrics.silkLine.woodenPalletCapacity }}</strong></div>
			<div><span>后处理/入库</span><strong>{{ metrics.silkLine.woodenPalletStage }} · C{{ metrics.silkLine.coveredPackages }} L{{ metrics.silkLine.labeledPackages }} W{{ metrics.silkLine.wrappedPackages }} · Stored {{ metrics.silkLine.storedPackages }}</strong></div>
			<div><span>循环托盘</span><strong>在线 {{ metrics.silkLine.onlinePallets }} · Loaded {{ metrics.silkLine.loadedPallets }} · Empty {{ metrics.silkLine.emptyPallets }}</strong></div>
			<div><span>等待与阻塞</span><strong>{{ metrics.silkLine.waitingPallets }} 个托盘 · {{ metrics.silkLine.blockedSections }} 段</strong></div>
		</section>

		<main class="twin-layout" :class="{ 'is-left-collapsed': leftPanelCollapsed, 'is-right-collapsed': rightPanelCollapsed }">
			<aside v-show="!leftPanelCollapsed" class="twin-panel twin-panel--left">
				<div class="twin-panel__heading">
					<div><span>SCENE</span><strong>场景与路线</strong></div>
					<el-switch v-if="viewportMode === 'runtime'" v-model="liveMode" active-text="实时" inline-prompt @change="toggleLiveMode" />
				</div>
				<div class="twin-card">
					<el-alert v-if="routeIsGenerated" type="info" :closable="false" show-icon title="当前路线由 V7 组件端口 Connection 自动生成；请移动组件或修改连接，路线控制点只读。" />
					<label>场景名称</label><el-input v-model="manifest.name" maxlength="80" />
					<label>根 Asset（场景业务边界）</label>
					<el-select v-model="manifest.rootAssetId" filterable clearable placeholder="未绑定，请选择资产" @change="changeRootAsset">
						<el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" />
					</el-select>
					<div v-if="assets.length === 0" class="root-asset-help"><small>资产库当前没有数据。请先新建产线根资产，再回来绑定场景。</small><span><el-button link type="primary" @click="router.push('/iot/assets/assetlist')">去资产管理</el-button><el-button link @click="loadAssets">刷新</el-button></span></div>
					<small v-else-if="!manifest.rootAssetId" class="root-asset-warning">当前是旧场景/未入库模板，尚未设置业务边界；选择后保存草稿即可入库。</small>
					<label>曲线类型</label><el-segmented v-model="route.curveKind" :options="curveOptions" @change="changeCurveKind" />
					<div class="twin-inline-control"><label>循环运行</label><el-switch v-model="route.loop" @change="changeLoop" /></div>
					<label>分流方式</label><el-segmented v-model="route.routingMode" :options="routingModeOptions" @change="syncRouteGraph" />
					<label>运行速度 {{ route.defaultSpeed.toFixed(1) }} m/s</label>
					<el-slider v-model="route.defaultSpeed" :min="0.1" :max="5" :step="0.1" @input="changeSpeed" />
				</div>
				<div v-if="manifest.runtime.silkLineSimulation" class="twin-card">
					<span class="twin-card__label">丝饼完整工艺 V6 参数</span>
					<div class="silk-simulation-grid">
						<label>塑料托盘数<el-input-number v-model="manifest.runtime.silkLineSimulation.palletCount" :min="6" :max="200" size="small" @change="applySilkSimulationOptions" /></label>
						<label>每车丝饼数（A/B 3×6）<el-input-number v-model="manifest.runtime.silkLineSimulation.silkCakesPerCart" :min="36" :max="36" disabled size="small" /></label>
						<label>机器人节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.robotCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>机器人空抓批次率<el-input-number v-model="manifest.runtime.silkLineSimulation.emptyPalletBatchRate" :min="0" :max="1" :step="0.01" :precision="2" size="small" @change="applySilkSimulationOptions" /></label>
						<label>外检节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.inspectionCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>外检 NG 率<el-input-number v-model="manifest.runtime.silkLineSimulation.inspectionNgRate" :min="0" :max="1" :step="0.01" :precision="2" size="small" @change="applySilkSimulationOptions" /></label>
						<label>套袋节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.baggingCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>桁架节拍(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.gantryCycleSeconds" :min="0.2" :max="120" :step="0.5" size="small" @change="applySilkSimulationOptions" /></label>
						<label>换车延时(s)<el-input-number v-model="manifest.runtime.silkLineSimulation.cartChangeDelaySeconds" :min="0" :max="300" :step="1" size="small" @change="applySilkSimulationOptions" /></label>
						<label>木托盘 行/列/层（固定）<span><el-input-number v-model="manifest.runtime.silkLineSimulation.stackRows" disabled size="small" /><el-input-number v-model="manifest.runtime.silkLineSimulation.stackColumns" disabled size="small" /><el-input-number v-model="manifest.runtime.silkLineSimulation.stackLayers" disabled size="small" /></span></label>
					</div>
					<div class="twin-inline-control"><label>空丝车自动更换</label><el-switch v-model="manifest.runtime.silkLineSimulation.autoReplaceSilkCart" @change="applySilkSimulationOptions" /></div>
					<small>固定工艺：Robot 1×6、Gantry 2×3、木托盘 8 层 × 6 = 48 件；修改节拍后重建仿真并随草稿入库。</small>
				</div>

				<div class="twin-panel__subheading"><strong>场景对象</strong><el-button size="small" text type="primary" @click="resourceDrawerVisible = true">添加</el-button></div>
				<div class="compact-list">
					<div v-for="item in modelObjects" :key="item.objectId" @click="selectSceneObject(item.objectId)"><span>{{ item.name }}</span><el-button v-if="item.kind !== 'equipment'" text type="danger" size="small" @click.stop="removeModelObject(item.objectId)">移除</el-button></div>
					<small v-if="modelObjects.length === 0">当前场景还没有可编辑对象。</small>
				</div>

				<div class="twin-panel__subheading"><strong>路线控制点</strong><el-button size="small" text type="primary" :disabled="routeIsGenerated" @click="addRoutePoint">新增</el-button></div>
				<div class="twin-route-points">
					<div v-for="(point, index) in route.points" :key="point.pointId" class="twin-route-point" :class="{ 'is-selected': selected?.routeId === route.routeId && selected?.routePointIndex === index }">
						<div class="twin-route-point__title"><span>{{ index + 1 }}</span><el-input v-model="point.name" size="small" @change="syncRouteGraph" /><el-button circle text type="danger" size="small" :disabled="routeIsGenerated || route.points.length <= 2" @click="removeRoutePoint(index)">×</el-button></div>
						<div class="twin-route-point__meta">
							<el-select v-model="point.kind" size="small" @change="changeRoutePointKind(point)"><el-option v-for="option in routePointKindOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-radio v-model="route.startPointId" :value="point.pointId" size="small" @change="syncRouteGraph">运行起点</el-radio>
						</div>
						<div v-if="['diverter','merger','sensor','processStation'].includes(point.kind || '')" class="twin-route-binding-grid">
							<el-select v-if="point.kind === 'diverter' || point.kind === 'merger'" v-model="point.actuatorBindingId" size="small" clearable placeholder="执行器/到位信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-select v-model="point.sensorBindingId" size="small" clearable placeholder="检测/工位信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						</div>
						<div v-if="point.kind === 'processStation' && point.process" class="twin-route-process-grid">
							<el-select v-model="point.process.type" size="small" placeholder="工位类型" @change="syncRouteGraph"><el-option v-for="option in processTypeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-input-number v-model="point.process.cycleSeconds" :min="0.2" :max="300" :step="0.5" size="small" controls-position="right" @change="syncRouteGraph" />
							<el-select v-model="point.process.completeBindingId" size="small" clearable placeholder="完成信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-select v-if="point.process.type === 'external-inspection'" v-model="point.process.resultBindingId" size="small" clearable placeholder="检测结果信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
							<el-select v-model="point.process.faultBindingId" size="small" clearable placeholder="故障信号" @change="syncRouteGraph"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
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

				<div class="twin-panel__subheading"><strong>交叉口与分支</strong><el-button size="small" text type="primary" :disabled="routeIsGenerated" @click="addStandaloneRoutePoint">新增分支节点</el-button></div>
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
							<div><label>辊道规格</label><el-select v-model="edge.conveyorSizeClass" size="small" @change="changeConveyorSizeClass(edge)"><el-option v-for="option in conveyorSizeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></div>
							<div><label>输送对象</label><el-select v-model="edge.transportUnitType" size="small" @change="syncRouteGraph"><el-option v-for="option in transportUnitOptions(edge)" :key="option.value" :label="option.label" :value="option.value" /></el-select></div>
						</div>
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
				<template v-if="secondaryConveyorRoutes.length">
					<div class="twin-panel__subheading"><strong>后包装大型辊道</strong><el-tag size="small" type="info">独立输送对象</el-tag></div>
					<div v-for="secondaryRoute in secondaryConveyorRoutes" :key="secondaryRoute.routeId" class="twin-card twin-secondary-route">
						<div class="twin-inline-control"><strong>{{ secondaryRoute.name }}</strong><small>{{ secondaryRoute.edges.length }} 段 · 随场景草稿入库</small></div>
						<div v-for="edge in secondaryRoute.edges" :key="`${secondaryRoute.routeId}:${edge.edgeId}`" class="twin-route-edge">
							<div class="twin-route-edge__header"><div><strong>{{ edge.name || edge.edgeId }}</strong><small>{{ edge.edgeId }}</small></div><el-switch v-model="edge.blocked" size="small" inline-prompt active-text="封" inactive-text="通" @change="refreshDiagnostics" /></div>
							<div class="twin-route-edge__settings">
								<div><label>辊道规格</label><el-select v-model="edge.conveyorSizeClass" size="small" @change="changeConveyorSizeClass(edge, false)"><el-option v-for="option in conveyorSizeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></div>
								<div><label>输送对象</label><el-select v-model="edge.transportUnitType" size="small" @change="refreshDiagnostics"><el-option v-for="option in transportUnitOptions(edge)" :key="option.value" :label="option.label" :value="option.value" /></el-select></div>
							</div>
							<div class="twin-route-edge__settings">
								<div><label>容量</label><el-input-number v-model="edge.capacity" :min="1" :max="999" size="small" controls-position="right" @change="refreshDiagnostics" /></div>
								<div><label>预占租约（秒）</label><el-input-number v-model="edge.reservationTimeoutSeconds" :min="1" :max="3600" size="small" controls-position="right" @change="refreshDiagnostics" /></div>
							</div>
							<el-select v-model="edge.blockedBindingId" size="small" clearable placeholder="绑定故障/封锁信号（可选）" @change="refreshDiagnostics"><el-option v-for="option in routeBindingOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
						</div>
					</div>
				</template>
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

			<section
				class="twin-viewport-shell"
				:class="{ 'is-resource-drag-over': resourceDragOver }"
				@dragenter.prevent="handleViewportDragEnter"
				@dragover.prevent="handleViewportDragOver"
				@dragleave="handleViewportDragLeave"
				@drop.prevent="handleViewportDrop"
			>
				<el-button class="twin-panel-toggle twin-panel-toggle--left" circle size="small" :title="leftPanelCollapsed ? '展开场景与路线' : '收起场景与路线'" @click="leftPanelCollapsed = !leftPanelCollapsed">{{ leftPanelCollapsed ? '›' : '‹' }}</el-button>
				<el-button class="twin-panel-toggle twin-panel-toggle--right" circle size="small" :title="rightPanelCollapsed ? '展开对象与数据绑定' : '收起对象与数据绑定'" @click="rightPanelCollapsed = !rightPanelCollapsed">{{ rightPanelCollapsed ? '‹' : '›' }}</el-button>
				<ThreeJsEditorHost v-if="viewportMode === 'editor'" :key="editorInstanceKey" ref="professionalEditor" :manifest="manifest" @selection-change="handleSelectionChange" @route-change="applyRuntimeRoute" @changed="markEditorChanged" @error="ElMessage.error($event)" />
				<div v-else ref="viewport" class="twin-viewport"></div>
				<div v-if="resourceDragOver" class="twin-resource-drop-target"><strong>释放到这里</strong><span>将按当前鼠标落点创建或移动对象</span></div>
				<div class="twin-viewport__hint"><template v-if="viewportMode === 'editor'">专业编辑是唯一工程坐标场景：模型、V7组件、Port、Connection、Section 与 Route 同图编辑；路线点可直接选择和拖动。</template><template v-else>运行预览只负责仿真/实时状态；工程位置以专业编辑场景为准。</template></div>
				<div v-if="viewportMode === 'runtime'" class="twin-progress"><i :style="{ width: `${Math.round(metrics.progress * 100)}%` }"></i></div>
			</section>

			<aside v-show="!rightPanelCollapsed" class="twin-panel twin-panel--right">
				<div class="twin-panel__heading"><div><span>BINDING</span><strong>对象与数据绑定</strong></div></div>
				<div class="twin-card twin-selection-card">
					<span class="twin-card__label">当前选择</span><strong>{{ selected?.name ?? '未选择对象' }}</strong><small>{{ selected?.nodePath || selected?.path || '请在场景中选择模型节点' }}</small>
					<pre v-if="viewportMode === 'runtime' && selectedRuntimeData" class="twin-runtime-detail">{{ selectedRuntimeData }}</pre>
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
			<el-alert title="新场景默认生成：丝车、旋转台、上料机器人、双路分流、分层安全桁架、正交回流缓存环和 80 个全在线绿色塑料托盘。" type="success" :closable="false" style="margin-bottom:16px" />
			<el-alert v-if="assets.length === 0" title="资产库为空：请先到资产管理新建产线根资产，再创建数字孪生场景。" type="warning" :closable="false" show-icon style="margin-bottom:16px"><template #default><el-button link type="primary" @click="router.push('/iot/assets/assetlist')">打开资产管理</el-button><el-button link @click="loadAssets">刷新资产</el-button></template></el-alert>
			<el-form label-position="top"><el-form-item label="场景名称"><el-input v-model="createForm.name" /></el-form-item><el-form-item label="根 Asset"><el-select v-model="createForm.rootAssetId" filterable style="width:100%"><el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" /></el-select></el-form-item><el-form-item label="说明"><el-input v-model="createForm.description" type="textarea" /></el-form-item></el-form>
			<template #footer><el-button @click="createDialogVisible = false">取消</el-button><el-button type="primary" :loading="creating" :disabled="assets.length === 0" @click="createScene">创建并入库</el-button></template>
		</el-dialog>

		<el-dialog v-model="deviceStatusDialogVisible" width="720px" class="twin-device-status-dialog" destroy-on-close>
			<template #header>
				<div class="device-status-heading"><div><small>DEVICE STATUS</small><strong>{{ selected?.name || '驱动电机' }}</strong><span>{{ selected?.equipmentId || selected?.nodePath || selected?.objectId }}</span></div><el-tag :type="motorStatus.type" effect="dark" size="large">{{ motorStatus.label }}</el-tag></div>
			</template>
			<el-descriptions :column="2" border>
				<el-descriptions-item label="设备类型">驱动电机</el-descriptions-item>
				<el-descriptions-item label="数据模式">{{ liveMode ? 'PLC / IoT 实时' : '场景仿真' }}</el-descriptions-item>
				<el-descriptions-item label="场景对象">{{ selectedObjectName }}</el-descriptions-item>
				<el-descriptions-item label="绑定设备">{{ selectedEquipmentDeviceNames || '未绑定 Device' }}</el-descriptions-item>
				<el-descriptions-item label="节点路径" :span="2">{{ selected?.nodePath || selected?.path || '-' }}</el-descriptions-item>
				<el-descriptions-item label="最近数据" :span="2">{{ motorLatestTimestamp }}</el-descriptions-item>
			</el-descriptions>
			<div class="device-status-section"><div><strong>实时点位</strong><small>{{ motorBindingRows.length }} 条与当前对象关联的持久化绑定</small></div>
				<el-alert v-if="motorBindingRows.length === 0" title="当前电机尚未绑定遥测、属性或在线状态；下面的运行状态仅来自场景仿真。" type="warning" :closable="false" show-icon />
				<el-table v-else :data="motorBindingRows" max-height="280" stripe>
					<el-table-column prop="key" label="点位" min-width="130" />
					<el-table-column prop="device" label="Device" min-width="150" />
					<el-table-column label="当前值" min-width="120"><template #default="scope"><code>{{ scope.row.value }}</code></template></el-table-column>
					<el-table-column label="质量" width="95"><template #default="scope"><el-tag size="small" :type="scope.row.qualityType">{{ scope.row.quality }}</el-tag></template></el-table-column>
					<el-table-column prop="timestamp" label="更新时间" min-width="170" />
				</el-table>
			</div>
			<template #footer><el-button @click="deviceStatusDialogVisible = false">关闭</el-button><el-button type="primary" @click="openSelectedBindingPanel">配置数据绑定</el-button></template>
		</el-dialog>

		<el-drawer v-model="resourceDrawerVisible" title="模型资源库" size="520px" :modal="false" :lock-scroll="false" :close-on-click-modal="false">
			<input ref="uploadInput" class="is-hidden" type="file" accept=".glb,model/gltf-binary" @change="uploadModel" />
			<div class="resource-actions"><el-button type="success" @click="router.push('/iot/digital-twin/model-generator')">图片生成模型</el-button><el-button type="primary" :loading="uploading" @click="uploadInput?.click()">上传 GLB</el-button><el-button type="warning" plain :loading="registeringComponents" @click="registerAllBuiltInComponents">组件入库</el-button><el-button @click="loadModels">刷新</el-button></div>
			<el-alert title="按住任意资源卡片可拖到专业编辑画布；也可点击“放入场景”。GLB 来自数据库，参数化组件由 Component Registry 生成。" type="info" :closable="false" />
			<el-divider>丝饼线整机设备</el-divider>
			<div class="resource-grid">
				<div v-for="equipment in equipmentLibraryItems" :key="equipment.equipmentType" class="resource-card is-draggable" draggable="true" @dragstart="beginResourceDrag($event, { kind: 'equipment', equipmentType: equipment.equipmentType })" @dragend="endResourceDrag">
					<div><strong>{{ equipment.name }}</strong><small>程序化整机 · {{ equipment.equipmentType }}</small><small>可整体选择、移动并绑定设备数据</small></div>
					<el-tag size="small" :type="isEquipmentInScene(equipment.equipmentType) ? 'success' : 'info'">{{ isEquipmentInScene(equipment.equipmentType) ? '场景中已装配' : '内置整机' }}</el-tag>
					<el-button type="primary" plain @click="placeEquipmentTemplate(equipment.equipmentType)">{{ isEquipmentInScene(equipment.equipmentType) ? '定位对象' : '放入场景' }}</el-button>
				</div>
			</div>
			<el-divider>内置参数化 / 智能模型</el-divider>
			<div class="resource-grid">
				<div v-for="template in componentTemplates" :key="template.resourceKey" class="resource-card is-draggable" draggable="true" @dragstart="beginResourceDrag($event, { kind: 'component', resourceKey: template.resourceKey })" @dragend="endResourceDrag">
					<div><strong>{{ template.name }}</strong><small>{{ template.resourceType }} · {{ template.componentType }}</small><small>{{ template.tags.join(' · ') }}</small></div>
					<el-tag size="small" :type="registeredComponentResource(template.resourceKey) ? 'success' : 'warning'">{{ registeredComponentResource(template.resourceKey) ? '数据库已注册' : '待注册' }}</el-tag>
					<el-button type="primary" plain @click="placeComponentTemplate(template.resourceKey)">放入场景</el-button>
				</div>
			</div>
			<el-divider>GLB 模型资源</el-divider>
			<div class="resource-grid">
				<div v-for="model in glbModels" :key="model.id" class="resource-card" :class="{ 'is-draggable': model.processingStatus === 'Ready', 'is-disabled': model.processingStatus !== 'Ready' }" :draggable="model.processingStatus === 'Ready'" @dragstart="beginResourceDrag($event, { kind: 'model', modelId: model.id })" @dragend="endResourceDrag"><div><strong>{{ model.name }}</strong><small>{{ model.originalFileName }} · {{ formatBytes(model.fileSize) }}</small><small>{{ model.modelMetadata.meshCount || 0 }} Mesh · {{ formatNumber(model.modelMetadata.triangleCount || 0) }} triangles</small></div><el-tag size="small" :type="model.processingStatus === 'Ready' ? 'success' : 'warning'">{{ model.processingStatus }}</el-tag><el-button type="primary" plain :disabled="model.processingStatus !== 'Ready'" @click="placeModel(model)">放入场景</el-button></div>
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
import { useRoute, useRouter } from 'vue-router';
import { assetApi } from '/@/api/asset';
import { digitalTwinApi, type DigitalTwinSceneDetail, type DigitalTwinSceneSummary, type TwinDataUpdate, type TwinModelResource, type TwinRuntimeSnapshot, type TwinSceneVersion } from '/@/api/digital-twin';
import { cloneTwinManifest, createDefaultTwinSceneManifest, createRouteDecisionRule, createRouteEdge, createRoutePoint, createSilkCakeEquipmentObjectDefinitions, createSilkCakeLineTwinSceneManifest, normalizeTwinRoute, validateTwinSceneManifest, type TwinBindingTargetKind, type TwinEquipmentType, type TwinObjectBindingDefinition, type TwinRouteDecisionRule, type TwinRouteDefinition, type TwinRouteEdgeDefinition, type TwinRoutePointDefinition, type TwinRouteRuleOperator, type TwinSceneManifest, type TwinSceneObjectDefinition, type TwinVector3 } from '/@/digital-twin/contracts';
import ThreeJsEditorHost from '/@/digital-twin/components/ThreeJsEditorHost.vue';
import { builtInComponentResourceRegistrations, builtInComponentTemplates, migrateSilkLineInfrastructureToV7, removeConnectionsForObject, upsertGeneratedComponentRoute, validateV7ComponentManifest } from '/@/digital-twin/components';
import { ThreeJsEditorAdapter } from '/@/digital-twin/editor-adapter/ThreeJsEditorAdapter';
import type { TwinRuntimeMetrics, TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';

interface AssetOption { id: string; name: string; description?: string }
interface AssetKey { keyName: string; name?: string }
interface AssetDevice { id: string; name: string; attrs?: AssetKey[]; temps?: AssetKey[] }

const router = useRouter();
const currentRoute = useRoute();
const viewport = ref<HTMLDivElement>();
const uploadInput = ref<HTMLInputElement>();
const leftPanelCollapsed = ref(false);
const rightPanelCollapsed = ref(false);
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
const pageLoading = ref(false), saving = ref(false), creating = ref(false), publishing = ref(false), uploading = ref(false), registeringComponents = ref(false);
const playing = ref(false), liveMode = ref(false), routeDrawMode = ref(false);
const viewportMode = ref<'editor' | 'runtime'>('editor');
const editorInstanceKey = ref(0);
const createDialogVisible = ref(false), resourceDrawerVisible = ref(false), versionsDrawerVisible = ref(false), deviceStatusDialogVisible = ref(false);
const resourceDragOver = ref(false);
const latestBindingUpdates = ref<Record<string, TwinDataUpdate>>({});
let snapshotTimer: number | undefined;
const modelBufferCache = new Map<string, { fileName: string; buffer: ArrayBuffer }>();
type TwinLibraryDragPayload =
	| { kind: 'component'; resourceKey: string }
	| { kind: 'model'; modelId: string }
	| { kind: 'equipment'; equipmentType: TwinEquipmentType };
type TwinPlacementOptions = { position?: TwinVector3; keepLibraryOpen?: boolean };
const twinLibraryDragMime = 'application/x-iotsharp-twin-resource';
const activeLibraryDrag = ref<TwinLibraryDragPayload>();
let viewportDragDepth = 0;
const apiErrorMessage = (error: any, fallback: string) => error?.msg
	|| error?.response?.data?.msg
	|| (typeof error?.response?.data === 'string' ? error.response.data : '')
	|| error?.message
	|| fallback;
const showBlockingDiagnostics = async (title: string, items: Array<{ message: string; path?: string }>) => {
	const lines = items.slice(0, 12).map((item, index) => `${index + 1}. ${item.path || 'manifest'}：${item.message}`);
	if (items.length > 12) lines.push(`另有 ${items.length - 12} 项，请查看右侧“发布前校验”。`);
	await ElMessageBox.alert(lines.join('\n'), title, { type: 'error', confirmButtonText: '知道了' });
};

const createForm = reactive({ name: '丝饼完整工艺数字孪生 V6', description: '80托盘全在线闭环；Robot 1×6 后先识别空托，空托短回流，有料托经过外检、套袋、套袋后 A/B 分流、Gantry 2×3、木托盘8层及后包装入库。', rootAssetId: '' });
const uploadForm = reactive({ licenseType: 'Proprietary', author: '', sourceUrl: '', commercialUseAllowed: false });
const bindingForm = reactive({ deviceId: '', sourceKind: 'telemetry' as 'telemetry' | 'attribute' | 'connectivity', key: '', targetKind: 'color' as TwinBindingTargetKind });
const branchForm = reactive({ fromPointId: '', toPointId: '', bidirectional: false });
const ruleForm = reactive({ junctionPointId: '', edgeId: '', source: 'payload' as 'payload' | 'binding', payloadKey: 'sku', bindingId: '', operator: 'equals' as TwinRouteRuleOperator, matchValue: '', expectedActuatorValue: '' });
const routingPayloadText = ref('{"sku":"A","weight":1}');
const previewOccupancy = reactive<Record<string, number>>({});
const route = computed(() => manifest.value.routes[0]);
const routeIsGenerated = computed(() => route.value?.generatedBy === 'component-connections');
const secondaryConveyorRoutes = computed(() => manifest.value.routes.slice(1).filter((item) => item.edges.length > 0));
const junctionPoints = computed(() => route.value.points.filter((point) => ['junction', 'diverter', 'merger'].includes(point.kind || '')));
const decisionPoints = computed(() => junctionPoints.value.filter((point) => route.value.edges.filter((edge) => edge.enabled !== false && (edge.fromPointId === point.pointId || (edge.bidirectional && edge.toPointId === point.pointId))).length >= 2));
const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model' || item.kind === 'equipment' || (item as any).kind === 'component'));
const glbModels = computed(() => models.value.filter((item) => item.runtimeFormat !== 'application/vnd.iotsharp.twin-component+json'));
const componentTemplates = builtInComponentTemplates;
const equipmentLibraryItems = createSilkCakeEquipmentObjectDefinitions().map((item) => ({ name: item.name, equipmentType: item.equipment!.equipmentType }));
const selectedBindings = computed(() => manifest.value.bindings.filter((item) => item.objectId === selected.value?.objectId));
const selectedEquipmentBindings = computed(() => {
	const nodePath = selected.value?.nodePath || '';
	return selectedBindings.value.filter((binding) => !binding.nodePath || !nodePath || binding.nodePath === nodePath || binding.nodePath.startsWith(`${nodePath}/`) || nodePath.startsWith(`${binding.nodePath}/`));
});
const selectedRuntimeData = computed(() => selected.value?.runtimeData ? JSON.stringify(selected.value.runtimeData, null, 2) : '');
const selectedObjectName = computed(() => manifest.value.objects.find((item) => item.objectId === selected.value?.objectId)?.name || selected.value?.name || '-');
const motorBindingRows = computed(() => selectedEquipmentBindings.value.map((binding) => {
	const update = latestBindingUpdates.value[binding.bindingId];
	const device = assetDevices.value.find((item) => item.id === binding.source.deviceId);
	const quality = update ? (update.stale ? 'stale' : update.quality) : (liveMode.value ? 'waiting' : 'simulation');
	return {
		bindingId: binding.bindingId,
		key: `${binding.source.kind} · ${binding.source.key || '-'}`,
		device: device?.name || binding.source.deviceId || '未指定',
		value: update ? formatStatusValue(update.value) : (liveMode.value ? '等待数据' : '仿真'),
		quality,
		qualityType: quality === 'good' ? 'success' : quality === 'simulation' ? 'info' : quality === 'waiting' ? 'warning' : 'danger',
		timestamp: update?.sourceTimestamp ? formatDate(update.sourceTimestamp) : '-',
	};
}));
const selectedEquipmentDeviceNames = computed(() => [...new Set(motorBindingRows.value.map((item) => item.device).filter(Boolean))].join('、'));
const motorLatestTimestamp = computed(() => {
	const timestamps = selectedEquipmentBindings.value.map((binding) => latestBindingUpdates.value[binding.bindingId]?.sourceTimestamp).filter(Boolean) as string[];
	const sorted = timestamps.sort();
	return sorted.length ? formatDate(sorted[sorted.length - 1]) : (liveMode.value ? '等待首帧数据' : '仿真模式无 PLC 时间戳');
});
const motorStatus = computed<{ label: string; type: 'success' | 'warning' | 'danger' | 'info' }>(() => {
	const updates = selectedEquipmentBindings.value.map((binding) => latestBindingUpdates.value[binding.bindingId]).filter(Boolean) as TwinDataUpdate[];
	if (updates.some((update) => update.stale || ['stale', 'missing', 'bad'].includes(update.quality))) return { label: '数据异常', type: 'danger' };
	const keyed = updates.map((update) => ({ key: String(update.key || '').toLocaleLowerCase(), value: update.value }));
	if (keyed.some((item) => /online|connected|通信/.test(item.key) && !statusValueIsTrue(item.value))) return { label: '离线', type: 'danger' };
	if (keyed.some((item) => /fault|alarm|error|故障|报警/.test(item.key) && statusValueIsTrue(item.value))) return { label: '故障', type: 'danger' };
	const running = keyed.find((item) => /running|run|enabled|start|运行|启动/.test(item.key));
	if (running) return statusValueIsTrue(running.value) ? { label: '运行中', type: 'success' } : { label: '已停止', type: 'info' };
	if (liveMode.value) return updates.length ? { label: '在线', type: 'success' } : { label: '等待数据', type: 'warning' };
	return playing.value ? { label: '仿真运行', type: 'success' } : { label: '仿真停止', type: 'info' };
});
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
const waitingReasonText = computed(() => ({ ROUTE_NOT_READY: 'PLC 路由未就绪', DIVERTER_NOT_READY: '分流机构未到位', TARGET_SECTION_FULL: '目标段已满', TARGET_SECTION_BLOCKED: '目标段封锁', TARGET_SECTION_SIGNAL_STALE: '目标段信号失效', TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED: '输送对象类型不允许' })[metrics.waitingReason || 'TARGET_SECTION_BLOCKED']);
const curveOptions = [{ label: '直线', value: 'line' }, { label: '平滑曲线', value: 'catmullRom' }];
const routingModeOptions = [{ label: '手动', value: 'manual' }, { label: '自动规则', value: 'automatic' }];
const occupancyModeOptions = [{ label: '运行时计算', value: 'calculated' }, { label: '离线仿真', value: 'simulation' }, { label: 'PLC / IoT 实时', value: 'live' }];
const junctionDecisionModeOptions = [{ label: 'PLC 决策', value: 'plc' }, { label: '离线规则', value: 'simulation' }, { label: '人工调试', value: 'manual' }];
const ruleSourceOptions = [{ label: '物料属性', value: 'payload' }, { label: 'Device 信号', value: 'binding' }];
const routePointKindOptions = [{ label: '途经点', value: 'waypoint' }, { label: '普通交叉口', value: 'junction' }, { label: '分流器', value: 'diverter' }, { label: '汇流器', value: 'merger' }, { label: '缓存段', value: 'buffer' }, { label: '加工工位', value: 'processStation' }, { label: '传感器', value: 'sensor' }, { label: '站点', value: 'station' }];
const processTypeOptions = [{ label: '机器人上料', value: 'robot-loading' }, { label: '外检机', value: 'external-inspection' }, { label: '套袋机', value: 'bagging' }, { label: '桁架码垛', value: 'gantry-stacking' }, { label: '扫码工位', value: 'scan' }];
const conveyorSizeOptions = [{ label: '小辊道', value: 'small' }, { label: '大辊道', value: 'large' }];
const ruleOperatorOptions = [{ label: '等于', value: 'equals' }, { label: '不等于', value: 'notEquals' }, { label: '大于', value: 'greaterThan' }, { label: '大于等于', value: 'greaterThanOrEqual' }, { label: '小于', value: 'lessThan' }, { label: '小于等于', value: 'lessThanOrEqual' }, { label: '包含', value: 'contains' }, { label: '为真', value: 'truthy' }, { label: '为假', value: 'falsy' }];
const viewportModeOptions = [{ label: '专业编辑', value: 'editor' }, { label: '运行预览', value: 'runtime' }];
const metrics = reactive<TwinRuntimeMetrics>({ state: 'paused', distanceMeters: 0, lengthMeters: 0, progress: 0, speed: 1.2, activePointIds: [], activeEdgeIds: [], unavailableEdgeIds: [], fps: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 });

const apiData = <T,>(response: any): T => response.data as T;
const createId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const upgradeLegacySilkRouteLayout = (value: TwinSceneManifest) => {
	const isSilkLine = value.objects.some((item) => ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
	const isV5Preset = value.objects.some((item) => item.procedural?.preset === 'silk-cake-packaging-line');
	const silkRoute = value.routes.find((item) => item.routeId === 'silk-cake-line-main');
	if (!isSilkLine || !silkRoute) return;
	if (isV5Preset) {
		for (const object of value.objects.filter((item) => item.procedural?.preset === 'silk-cake-packaging-line')) object.procedural!.palletCount = 80;
		if (value.runtime.silkLineSimulation) {
			value.runtime.silkLineSimulation.palletCount = 80;
			value.runtime.silkLineSimulation.palletPopulationMode = 'closed-loop';
			value.runtime.silkLineSimulation.silkCakesPerCart = 36;
			value.runtime.silkLineSimulation.stackRows = 2;
			value.runtime.silkLineSimulation.stackColumns = 3;
			value.runtime.silkLineSimulation.stackLayers = 8;
			value.runtime.silkLineSimulation.inspectionCycleSeconds ??= 2;
			value.runtime.silkLineSimulation.inspectionNgRate ??= 0;
			value.runtime.silkLineSimulation.baggingCycleSeconds ??= 3;
			value.runtime.silkLineSimulation.emptyPalletBatchRate ??= 0.1;
		}
	}
	const legacy: Record<string, TwinVector3> = {
		'silk-source': [-16, 0.92, -6], 'silk-loading': [-10, 0.92, -6], 'silk-buffer': [-4, 0.92, -6], 'silk-diverter': [2, 0.92, -6],
		'silk-left-buffer': [8, 0.92, -10], 'silk-left-inspection': [15, 0.92, -10], 'silk-right-buffer': [8, 0.92, -2], 'silk-right-inspection': [15, 0.92, -2],
		'silk-merger': [20, 0.92, -6], 'silk-gantry': [25, 0.92, -6], 'silk-return-east': [25, 0.92, 8], 'silk-return-west': [-16, 0.92, 8],
	};
	const templateRoute = createSilkCakeLineTwinSceneManifest().routes[0];
	const target = new Map(templateRoute.points.map((point) => [point.pointId, point]));
	const samePosition = (left: TwinVector3, right: TwinVector3) => left.every((component, index) => Math.abs(component - right[index]) < 0.001);
	const isPreV6Route = isV5Preset && !silkRoute.points.some((point) => point.pointId === 'silk-external-inspection');
	if (isPreV6Route) {
		const v5Positions: Record<string, TwinVector3> = {
			'silk-diverter': [5.1, 0.92, -5.8],
			'silk-left-buffer': [6.8, 0.92, -7.6],
			'silk-left-inspection': [13.2, 0.92, -7.6],
			'silk-right-buffer': [6.8, 0.92, -4.2],
			'silk-right-inspection': [13.2, 0.92, -4.2],
			'silk-merger': [15, 0.92, -4.2],
			'silk-gantry': [15, 0.92, -7.6],
			'silk-return-east': [44, 0.92, -4.2],
			'silk-return-northeast': [44, 0.92, 34],
		};
		for (const point of silkRoute.points) {
			const oldPosition = v5Positions[point.pointId];
			const nextPoint = target.get(point.pointId);
			if (oldPosition && nextPoint && samePosition(point.position, oldPosition)) point.position = [...nextPoint.position] as TwinVector3;
			if (nextPoint && ['silk-left-inspection', 'silk-right-inspection', 'silk-gantry'].includes(point.pointId)) {
				point.name = nextPoint.name;
				point.process = nextPoint.process ? structuredClone(nextPoint.process) : point.process;
			}
		}
		for (const point of templateRoute.points) {
			if (!silkRoute.points.some((candidate) => candidate.pointId === point.pointId)) silkRoute.points.push(structuredClone(point));
		}
		const templateEdges = new Map(templateRoute.edges.map((edge) => [edge.edgeId, edge]));
		for (const edge of silkRoute.edges) {
			const nextEdge = templateEdges.get(edge.edgeId);
			if (!nextEdge) continue;
			edge.fromPointId = nextEdge.fromPointId;
			edge.toPointId = nextEdge.toPointId;
			edge.name = nextEdge.name;
			edge.capacity = nextEdge.capacity;
			edge.conveyorSizeClass = nextEdge.conveyorSizeClass;
			edge.transportUnitType = nextEdge.transportUnitType;
		}
		for (const edge of templateRoute.edges) {
			if (!silkRoute.edges.some((candidate) => candidate.edgeId === edge.edgeId)) silkRoute.edges.push(structuredClone(edge));
		}
		if (value.name === '丝饼完整工艺数字孪生 V5') value.name = '丝饼完整工艺数字孪生 V6';
		for (const object of value.objects.filter((item) => item.procedural?.preset === 'silk-cake-packaging-line')) {
			if (object.name === '程序化丝饼完整工艺 V5') object.name = '程序化丝饼完整工艺 V6';
		}
	}
	// V6.1：外检前必须具备独立空托检测与短回流。旧 V6 场景只补缺失节点/边，
	// 不覆盖用户已经移动过的外检、套袋、A/B 分流与桁架坐标。
	const emptyReturnPointIds = new Set(['silk-empty-return-southeast', 'silk-empty-return-southwest']);
	const routeBufferForEmpty = silkRoute.points.find((point) => point.pointId === 'silk-buffer');
	const routeSourceForEmpty = silkRoute.points.find((point) => point.pointId === 'silk-source');
	for (const point of templateRoute.points.filter((item) => emptyReturnPointIds.has(item.pointId))) {
		if (silkRoute.points.some((candidate) => candidate.pointId === point.pointId)) continue;
		const inserted = structuredClone(point);
		if (routeBufferForEmpty && routeSourceForEmpty) {
			// 短回流放在主线正 Z 反侧，负 Z 一侧留给丝车进入旋转台。
			const returnZ = Math.max(routeBufferForEmpty.position[2], routeSourceForEmpty.position[2]) + 5.8;
			inserted.position = inserted.pointId === 'silk-empty-return-southeast'
				? [routeBufferForEmpty.position[0], routeBufferForEmpty.position[1], returnZ]
				: [routeSourceForEmpty.position[0] - 1.8, routeSourceForEmpty.position[1], returnZ];
		}
		silkRoute.points.push(inserted);
	}
	// 早期 V6.1 的 z=-9.6 会碰旋转包络，随后使用的 z=-16 又会封住丝车进场通道。
	// 仅迁移仍保持这两组内置坐标的场景，用户手工移动过的控制点不覆盖。
	const previousEmptyReturnPositions: Record<string, TwinVector3[]> = {
		'silk-empty-return-southeast': [[3.2, 0.92, -9.6], [3.2, 0.92, -16]],
		'silk-empty-return-southwest': [[-12.8, 0.92, -9.6], [-12.8, 0.92, -16]],
	};
	for (const point of silkRoute.points) {
		const previous = previousEmptyReturnPositions[point.pointId] || [];
		const nextPoint = target.get(point.pointId);
		if (nextPoint && previous.some((position) => samePosition(point.position, position))) point.position = [...nextPoint.position] as TwinVector3;
	}
	const emptyReturnEdgeIds = new Set(['silk-edge-empty-return-drop', 'silk-edge-empty-return-main', 'silk-edge-empty-return-rise']);
	for (const edge of templateRoute.edges.filter((item) => emptyReturnEdgeIds.has(item.edgeId))) {
		if (!silkRoute.edges.some((candidate) => candidate.edgeId === edge.edgeId)) silkRoute.edges.push(structuredClone(edge));
	}
	const loadCheck = silkRoute.points.find((point) => point.pointId === 'silk-buffer');
	const templateLoadCheck = target.get('silk-buffer');
	if (loadCheck && templateLoadCheck) {
		loadCheck.kind = 'diverter';
		loadCheck.name = templateLoadCheck.name;
		loadCheck.decisionMode ??= 'simulation';
		loadCheck.decisionTimeoutSeconds ??= 10;
	}
	const returnMerger = silkRoute.points.find((point) => point.pointId === 'silk-source');
	const templateReturnMerger = target.get('silk-source');
	if (returnMerger && templateReturnMerger) {
		returnMerger.kind = 'merger';
		returnMerger.name = templateReturnMerger.name;
	}
	silkRoute.junctionDecisions = { ...(silkRoute.junctionDecisions || {}), 'silk-buffer': 'silk-edge-external-inspection' };
	const emptyRule = templateRoute.decisionRules?.find((rule) => rule.ruleId === 'silk-rule-empty-return');
	if (emptyRule && !silkRoute.decisionRules?.some((rule) => rule.ruleId === emptyRule.ruleId)) {
		silkRoute.decisionRules = [...(silkRoute.decisionRules || []), structuredClone(emptyRule)];
	}
	for (const edge of silkRoute.edges) {
		edge.conveyorSizeClass ??= 'small';
		edge.transportUnitType ??= 'plastic-pallet';
	}
	for (const point of silkRoute.points.filter((item) => item.kind === 'processStation' && !item.process)) {
		point.process = { type: point.pointId === 'silk-loading' ? 'robot-loading' : point.pointId === 'silk-gantry' ? 'gantry-stacking' : 'scan', cycleSeconds: 2 };
	}
	const woodRoute = createSilkCakeLineTwinSceneManifest().routes.find((item) => item.routeId === 'silk-wood-packaging-route');
	if (isV5Preset && woodRoute && !value.routes.some((item) => item.routeId === woodRoute.routeId)) value.routes.push(structuredClone(woodRoute));
	const legacyMatches = silkRoute.points.filter((point) => legacy[point.pointId] && samePosition(point.position, legacy[point.pointId])).length;
	// 仅迁移能确认为旧内置模板的场景；单独拖动过的控制点保持用户坐标不变。
	if (legacyMatches >= 8) {
		for (const point of silkRoute.points) {
			const oldPosition = legacy[point.pointId], nextPoint = target.get(point.pointId);
			if (oldPosition && nextPoint && samePosition(point.position, oldPosition)) {
				point.position = [...nextPoint.position] as TwinVector3;
				point.name = nextPoint.name;
			}
		}
		const templateEdges = new Map(templateRoute.edges.map((edge) => [edge.edgeId, edge]));
		for (const edge of silkRoute.edges) {
			const templateEdge = templateEdges.get(edge.edgeId);
			if (!templateEdge) continue;
			edge.fromPointId = templateEdge.fromPointId;
			edge.toPointId = templateEdge.toPointId;
			edge.name = templateEdge.name;
			edge.capacity = templateEdge.capacity;
		}
	}
	// 修复首版 V4 中“回流辊道接到 -10，而路线仍接到 -16”的机器人上料段错位。
	// 三个点都仍是内置默认值时才升级；用户手工编辑过其中任一点则保持原样。
	const previousRobotReturnLayout: Record<string, TwinVector3> = {
		'silk-source': [-16, 0.92, -6],
		'silk-loading': [-10, 0.92, -6],
		'silk-buffer': [-4, 0.92, -5.8],
	};
	const robotReturnPoints = silkRoute.points.filter((point) => previousRobotReturnLayout[point.pointId]);
	if (robotReturnPoints.length === 3 && robotReturnPoints.every((point) => samePosition(point.position, previousRobotReturnLayout[point.pointId]))) {
		for (const point of robotReturnPoints) {
			const nextPoint = target.get(point.pointId);
			if (!nextPoint) continue;
			point.position = [...nextPoint.position] as TwinVector3;
			point.name = nextPoint.name;
		}
	}
	const previousClosedLoopCorners: Record<string, TwinVector3> = {
		'silk-return-east': [15, 0.92, 4.8],
		'silk-return-west': [-12.5, 0.92, 4.8],
	};
	const closedLoopCorners = silkRoute.points.filter((point) => previousClosedLoopCorners[point.pointId]);
	if (closedLoopCorners.length === 2 && closedLoopCorners.every((point) => samePosition(point.position, previousClosedLoopCorners[point.pointId]))) {
		for (const point of closedLoopCorners) {
			const nextPoint = target.get(point.pointId);
			if (!nextPoint) continue;
			point.position = [...nextPoint.position] as TwinVector3;
			point.name = nextPoint.name;
		}
		for (const edge of silkRoute.edges) {
			const nextEdge = templateRoute.edges.find((candidate) => candidate.edgeId === edge.edgeId);
			if (nextEdge) edge.capacity = nextEdge.capacity;
		}
	}
	if (isV5Preset) {
		// V4 的长回流仍是两段斜线，80 托盘在斜角处会互锁。V5 补成四边正交缓存环；
		// 只把可识别的旧内置坐标迁移，用户手工坐标继续保留。
		const previousV4Corners: Record<string, TwinVector3> = {
			'silk-return-east': [34, 0.92, 30],
			'silk-return-west': [-38, 0.92, 30],
		};
		for (const point of silkRoute.points) {
			const previous = previousV4Corners[point.pointId];
			const next = target.get(point.pointId);
			if (previous && next && samePosition(point.position, previous)) {
				point.position = [...next.position] as TwinVector3;
				point.name = next.name;
			}
		}
		for (const point of templateRoute.points) {
			if (!silkRoute.points.some((candidate) => candidate.pointId === point.pointId)) silkRoute.points.push(structuredClone(point));
		}
		const templateEdges = new Map(templateRoute.edges.map((edge) => [edge.edgeId, edge]));
		for (const edge of silkRoute.edges) {
			const templateEdge = templateEdges.get(edge.edgeId);
			if (!templateEdge || !edge.edgeId.startsWith('silk-edge-return')) continue;
			edge.fromPointId = templateEdge.fromPointId;
			edge.toPointId = templateEdge.toPointId;
			edge.name = templateEdge.name;
			edge.capacity = templateEdge.capacity;
		}
		for (const edge of templateRoute.edges) {
			if (!silkRoute.edges.some((candidate) => candidate.edgeId === edge.edgeId)) silkRoute.edges.push(structuredClone(edge));
		}
	}
};
const normalizeManifest = (value: TwinSceneManifest): TwinSceneManifest => {
	const normalized = cloneTwinManifest(value);
	normalized.bindings = value.bindings || [];
	normalized.resources = value.resources || [];
	normalized.objects = value.objects || [];
	normalized.connections = value.connections || [];
	normalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);
	normalized.editorExtension = value.editorExtension || { source: 'threejs-editor', payloadVersion: 2 };
	upgradeLegacySilkRouteLayout(normalized);
	migrateSilkLineInfrastructureToV7(normalized);
	return normalized;
};
const refreshDiagnostics = () => { diagnostics.value = [...validateTwinSceneManifest(manifest.value), ...validateV7ComponentManifest(manifest.value)]; };
const routePointName = (pointId: string) => route.value.points.find((point) => point.pointId === pointId)?.name || pointId;
const routeEdgeLabel = (edge: TwinRouteEdgeDefinition) => `${routePointName(edge.fromPointId)} ${edge.bidirectional ? '↔' : '→'} ${routePointName(edge.toPointId)}`;
const transportUnitOptions = (edge: TwinRouteEdgeDefinition) => edge.conveyorSizeClass === 'large'
	? [{ label: '木托盘', value: 'wooden-pallet' }, { label: '纸箱', value: 'carton' }]
	: [{ label: '塑料托盘', value: 'plastic-pallet' }, { label: '纸箱', value: 'carton' }];
const changeConveyorSizeClass = (edge: TwinRouteEdgeDefinition, synchronizeRuntime = true) => {
	const allowed = new Set(transportUnitOptions(edge).map((item) => item.value));
	if (!edge.transportUnitType || !allowed.has(edge.transportUnitType)) edge.transportUnitType = edge.conveyorSizeClass === 'large' ? 'wooden-pallet' : 'plastic-pallet';
	if (synchronizeRuntime) syncRouteGraph();
	else refreshDiagnostics();
};
const changeRoutePointKind = (point: TwinRoutePointDefinition) => {
	if (point.kind === 'processStation' && !point.process) point.process = { type: 'scan', cycleSeconds: 2 };
	if (point.kind !== 'processStation') delete point.process;
	syncRouteGraph();
};
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
	const routeIndex = manifest.value.routes.findIndex((item) => item.routeId === value.routeId);
	if (routeIndex >= 0) manifest.value.routes.splice(routeIndex, 1, value);
	else if (manifest.value.routes.length) manifest.value.routes.splice(0, 1, value);
	else manifest.value.routes.push(value);
	if (value.routeId === route.value?.routeId) reconcileRouteEditorState(value);
	refreshDiagnostics();
};

const isMotorSelection = (value: TwinSelectionInfo | null) => {
	if (!value || value.kind === 'route-point') return false;
	if (String(value.equipmentType || '').toLocaleLowerCase() === 'motor') return true;
	return /motor|drive[_ -]?motor|电机|马达|减速机/i.test(`${value.name || ''} ${value.nodePath || ''} ${value.path || ''}`);
};
const handleSelectionChange = (value: TwinSelectionInfo | null) => {
	selected.value = value;
	if (viewportMode.value === 'runtime' && isMotorSelection(value)) deviceStatusDialogVisible.value = true;
};
const openSelectedBindingPanel = () => {
	deviceStatusDialogVisible.value = false;
	rightPanelCollapsed.value = false;
};
const statusValueIsTrue = (value: unknown) => {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	return ['true', '1', 'on', 'running', 'run', 'online', 'yes', '启动', '运行', '在线'].includes(String(value ?? '').trim().toLocaleLowerCase());
};
const formatStatusValue = (value: unknown) => {
	if (value === null || value === undefined) return '-';
	if (typeof value === 'object') {
		try { return JSON.stringify(value); } catch { return String(value); }
	}
	return String(value);
};

const initializeRuntime = () => {
	if (!viewport.value) return;
	adapter.value?.dispose();
	adapter.value = new ThreeJsEditorAdapter(viewport.value, cloneTwinManifest(manifest.value), {
		onSelectionChange: handleSelectionChange,
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
	const nextAssetId = typeof assetId === 'string' && assetId ? assetId : null;
	manifest.value.rootAssetId = nextAssetId;
	for (const item of manifest.value.objects) {
		if (nextAssetId) item.assetId = nextAssetId;
		else delete item.assetId;
	}
	for (const item of manifest.value.bindings) {
		if (nextAssetId) item.source.assetId = nextAssetId;
		else delete item.source.assetId;
	}
	await loadAssetDevices(nextAssetId); adapter.value?.loadManifest(manifest.value); refreshDiagnostics();
};
const loadModels = async () => { models.value = apiData<TwinModelResource[]>(await digitalTwinApi.listModels({})); };
const registeredComponentResource = (resourceKey: string) => {
	const registration = builtInComponentResourceRegistrations.find((item) => item.resourceKey === resourceKey);
	return models.value.find((item) => item.resourceKey === resourceKey
		&& item.runtimeFormat === 'application/vnd.iotsharp.twin-component+json'
		&& item.modelMetadata?.resourceKey === resourceKey
		&& item.modelMetadata?.componentType === registration?.componentType
		&& item.modelMetadata?.generator === registration?.generator
		&& item.modelMetadata?.generatorVersion === registration?.generatorVersion
		&& Array.isArray(item.modelMetadata?.ports)
		&& item.modelMetadata.ports.length > 0
		&& Array.isArray(item.modelMetadata?.bindingSlots)
		&& item.modelMetadata.bindingSlots.length === (registration?.bindingSlots.length || 0)
		&& (registration?.bindingSlots || []).every((slot: any) => item.modelMetadata.bindingSlots?.some((stored: any) => stored.slotId === slot.slotId && stored.semantic === slot.semantic)));
};
const bindRegisteredComponentResources = () => {
	const listedResourceIds = new Set(manifest.value.resources.map((item) => item.resourceId));
	const replacedResourceIds = new Set<string>();
	for (const object of manifest.value.objects as any[]) {
		if (object.kind !== 'component' || !object.component?.resourceKey) continue;
		const resource = registeredComponentResource(object.component.resourceKey);
		if (!resource) continue;
		if (object.resourceId && object.resourceId !== resource.id) replacedResourceIds.add(object.resourceId);
		object.resourceId = resource.id;
		if (!listedResourceIds.has(resource.id)) {
			manifest.value.resources.push({ resourceId: resource.id, name: resource.name, status: 'ready' });
			listedResourceIds.add(resource.id);
		}
	}
	if (replacedResourceIds.size) {
		const referencedResourceIds = new Set(manifest.value.objects.map((item) => item.resourceId).filter((value): value is string => Boolean(value)));
		manifest.value.resources = manifest.value.resources.filter((item) => !replacedResourceIds.has(item.resourceId) || referencedResourceIds.has(item.resourceId));
	}
};
const ensureManifestComponentResourcesRegistered = async () => {
	const requiredKeys = new Set((manifest.value.objects as any[])
		.filter((item) => item.kind === 'component' && item.component?.resourceKey)
		.map((item) => String(item.component.resourceKey)));
	const missing = builtInComponentResourceRegistrations.filter((item) => requiredKeys.has(item.resourceKey) && !registeredComponentResource(item.resourceKey));
	if (missing.length) {
		await digitalTwinApi.registerComponentResources(missing);
		await loadModels();
	}
	bindRegisteredComponentResources();
	const unresolved = (manifest.value.objects as any[]).filter((item) => item.kind === 'component' && !item.resourceId);
	if (unresolved.length) throw new Error(`以下组件尚未注册到数据库模型资源库：${unresolved.map((item) => item.name || item.objectId).join('、')}`);
};
const registerAllBuiltInComponents = async () => {
	registeringComponents.value = true;
	try {
		await digitalTwinApi.registerComponentResources(builtInComponentResourceRegistrations);
		await loadModels();
		bindRegisteredComponentResources();
		refreshDiagnostics();
		ElMessage.success(`${builtInComponentResourceRegistrations.length} 个内置组件已注册到当前租户数据库模型资源库`);
	} catch (error: any) {
		ElMessage.error(apiErrorMessage(error, '组件资源注册失败，请确认当前账号具有管理员权限'));
	} finally { registeringComponents.value = false; }
};
const loadScenes = async () => { scenes.value = apiData<DigitalTwinSceneSummary[]>(await digitalTwinApi.listScenes()); };

const loadScene = async (sceneId: string | number | boolean) => {
	if (typeof sceneId !== 'string' || !sceneId) return;
	pageLoading.value = true;
	try {
		const detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(sceneId));
		latestBindingUpdates.value = {};
		currentScene.value = detail; selectedSceneId.value = detail.id; manifest.value = normalizeManifest(detail.draftPayload);
		bindRegisteredComponentResources();
		for (const key of Object.keys(previewOccupancy)) delete previewOccupancy[key];
		for (const edge of route.value.edges) previewOccupancy[edge.edgeId] = 0;
		await loadAssetDevices(detail.rootAssetId); await initializeViewport(); refreshDiagnostics();
		if (liveMode.value) startSnapshotPolling();
	} catch { ElMessage.error('数字孪生场景加载失败'); }
	finally { pageLoading.value = false; }
};

const loadReferencedModels = async () => {
	for (const object of modelObjects.value) {
		if (object.kind !== 'model') continue;
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
		createDialogVisible.value = false; viewportMode.value = 'runtime'; await loadScenes(); await loadScene(detail.id); ElMessage.success('丝饼完整工艺 V6、外检前空托短回流、外检/套袋和 80 托盘闭环配置已写入数据库，点击“运行”即可启动');
	} finally { creating.value = false; }
};

const applySilkCakeLineTemplate = async () => {
	if (!currentScene.value) {
		createForm.name = '丝饼完整工艺数字孪生 V6';
		createForm.description = '80托盘全在线闭环、双面丝车3×6、机器人1×6、分层安全桁架2×3、木托盘8层、盖板、贴标、缠膜和立体库入库。';
		createDialogVisible.value = true;
		return;
	}
	const confirmed = await ElMessageBox.confirm('这会将当前草稿升级为 V6 完整工艺，加入外检/套袋正式工位、辊道输送对象属性、右移后的 Gantry 和 80 托盘闭环后立即入库；历史发布版本不受影响。', '应用丝饼完整工艺 V6', { type: 'warning' })
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
	if (await saveDraft(true)) ElMessage.success('V6 已生成并入库：点击“运行”观察外检前空托短回流、套袋后 A/B 分流、2×3 分层码垛及完整闭环');
};

const saveDraft = async (silent = false) => {
	if (!currentScene.value) { ElMessage.warning('请先新建或选择数据库场景'); return false; }
	try {
		await ensureManifestComponentResourcesRegistered();
		if (viewportMode.value === 'editor') professionalEditor.value?.captureManifest(manifest.value);
	} catch (error: any) {
		ElMessage.error(apiErrorMessage(error, '组件资源入库或 Three Editor 状态提取失败，请检查权限与场景数据'));
		return false;
	}
	refreshDiagnostics(); const errors = diagnostics.value.filter((item) => item.severity === 'error');
	if (errors.length) { await showBlockingDiagnostics('草稿校验未通过', errors); return false; }
	saving.value = true;
	let detail: DigitalTwinSceneDetail | undefined;
	try {
		detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.saveDraft(currentScene.value.id, currentScene.value.revision, manifest.value));
	} catch (error: any) {
		// 保存请求可能已在服务器原子提交，但响应在返回途中失败。重新读取后，
		// 若服务器 Manifest 与当前编辑内容一致，就恢复 revision 并按成功处理。
		try {
			const latest = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(currentScene.value.id));
			if (JSON.stringify(normalizeManifest(latest.draftPayload)) === JSON.stringify(normalizeManifest(manifest.value))) detail = latest;
		} catch { /* 保留原始提交错误 */ }
		if (!detail) {
			ElMessage.error(apiErrorMessage(error, '草稿提交失败，可能存在版本冲突'));
			saving.value = false;
			return false;
		}
	}
	currentScene.value = detail;
	try {
		const persistedManifest = normalizeManifest(detail.draftPayload);
		if (viewportMode.value === 'editor') Object.assign(manifest.value, persistedManifest);
		else { manifest.value = persistedManifest; adapter.value?.loadManifest(manifest.value); }
	} catch { ElMessage.warning(`草稿 r${detail.revision} 已提交成功，但本地视图重载失败；重新打开场景即可恢复`); }
	try { await loadScenes(); }
	catch { ElMessage.warning(`草稿 r${detail.revision} 已提交成功，但场景列表刷新失败`); }
	if (!silent) ElMessage.success(`草稿 r${detail.revision} 已原子保存；元数据、Manifest 及 ${detail.bindings.length} 条资源/数据绑定已一次入库`);
	saving.value = false;
	return true;
};

const validateScene = async () => {
	refreshDiagnostics(); if (!currentScene.value) { ElMessage.warning('当前只是未入库模板'); return; }
	if (!(await saveDraft(true))) return;
	const result = apiData<{ valid: boolean; diagnostics: any[] }>(await digitalTwinApi.validateScene(currentScene.value.id, false)); diagnostics.value = result.diagnostics;
	result.valid ? ElMessage.success('前后端场景校验通过') : ElMessage.error('后端引用校验未通过');
};

const publishScene = async () => {
	if (!currentScene.value) return;
	if (viewportMode.value === 'editor') professionalEditor.value?.captureManifest(manifest.value);
	const persisted = normalizeManifest(currentScene.value.draftPayload);
	if (JSON.stringify(persisted) !== JSON.stringify(manifest.value) && !(await saveDraft(true))) return;
	publishing.value = true;
	try {
		const validation = apiData<{ valid: boolean; diagnostics: any[] }>(await digitalTwinApi.validateScene(currentScene.value.id, true)); diagnostics.value = validation.diagnostics;
		if (!validation.valid) {
			await showBlockingDiagnostics('发布校验未通过', validation.diagnostics.filter((item) => item.severity === 'error'));
			return;
		}
		const summary = `发布于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
		const version = apiData<TwinSceneVersion>(await digitalTwinApi.publishScene(currentScene.value.id, currentScene.value.revision, summary));
		ElMessage.success(`v${version.version} 已发布，Manifest、绑定和路线版本快照已不可变入库`);
		try { await loadScene(currentScene.value.id); await loadScenes(); }
		catch { ElMessage.warning(`v${version.version} 已发布成功，但页面刷新失败；发布结果不受影响`); }
	} catch (error: any) {
		ElMessage.error(apiErrorMessage(error, '发布提交失败'));
	} finally { publishing.value = false; }
};

const openVersions = async () => {
	if (!currentScene.value) { ElMessage.warning('当前场景尚未入库'); return; }
	versions.value = apiData<TwinSceneVersion[]>(await digitalTwinApi.listVersions(currentScene.value.id)); versionsDrawerVisible.value = true;
};
const rollbackVersion = async (version: number) => {
	if (!currentScene.value) return;
	await ElMessageBox.confirm(`将以不可变版本 v${version} 创建一个新的草稿 revision；当前线上发布版本不会改变，确认后仍需重新发布。`, '从历史版本创建草稿');
	const detail = apiData<DigitalTwinSceneDetail>(await digitalTwinApi.rollback(currentScene.value.id, version));
	currentScene.value = detail;
	manifest.value = normalizeManifest(detail.draftPayload);
	bindRegisteredComponentResources();
	await initializeViewport();
	await openVersions();
	ElMessage.success(`已从 v${version} 创建草稿 r${detail.revision}；当前发布版本保持不变`);
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

const placeComponentTemplate = async (resourceKey: string, options: TwinPlacementOptions = {}) => {
	const template = componentTemplates.find((item) => item.resourceKey === resourceKey);
	if (!template) { ElMessage.error(`未找到组件模板 ${resourceKey}`); return; }
	let registered = registeredComponentResource(template.resourceKey);
	if (!registered) {
		const registration = builtInComponentResourceRegistrations.find((item) => item.resourceKey === template.resourceKey);
		if (!registration) { ElMessage.error(`组件注册数据不存在：${template.resourceKey}`); return; }
		try {
			registered = apiData<TwinModelResource>(await digitalTwinApi.upsertComponentResource(registration));
			models.value = [...models.value.filter((item) => item.id !== registered!.id), registered];
		} catch (error: any) {
			ElMessage.error(apiErrorMessage(error, '组件必须先注册到数据库；请确认当前账号具有管理员权限'));
			return;
		}
	}
	const objectId = createId('component');
	const sectionId = `section-${objectId}`;
	if (registered && !manifest.value.resources.some((item) => item.resourceId === registered.id)) manifest.value.resources.push({ resourceId: registered.id, name: registered.name, status: 'ready' });
	const position: TwinVector3 = options.position ? [...options.position] : [0, 0, 0];
	(manifest.value.objects as any[]).push({ objectId, name: template.name, kind: 'component', resourceId: registered?.id, assetId: manifest.value.rootAssetId || undefined, component: { resourceKey: template.resourceKey, componentType: template.componentType, generator: template.generator, generatorVersion: template.generatorVersion, properties: structuredClone(template.defaultProperties), sectionId }, transform: { position, rotation: [0,0,0], scale: [1,1,1] } });
	manifest.value.connections ||= [];
	upsertGeneratedComponentRoute(manifest.value);
	if (!options.keepLibraryOpen) resourceDrawerVisible.value = false;
	if (viewportMode.value === 'editor') {
		professionalEditor.value?.reloadComponent(objectId);
		professionalEditor.value?.selectObject(objectId);
	} else adapter.value?.loadManifest(manifest.value);
	refreshDiagnostics();
	ElMessage.success(`${template.name} 已放入场景；右侧 V7 属性面板可直接改参数、吸附端口并生成 Section / Route。`);
};

const placeModel = async (model: TwinModelResource, options: TwinPlacementOptions = {}) => {
	if (model.processingStatus !== 'Ready') { ElMessage.warning(`${model.name} 尚未处理完成，暂时不能放入场景`); return; }
	const objectId = createId('object');
	if (!manifest.value.resources.some((item) => item.resourceId === model.id)) manifest.value.resources.push({ resourceId: model.id, name: model.name, sourceFileName: model.originalFileName, status: 'ready' });
	const position: TwinVector3 = options.position ? [...options.position] : [0, 0, 0];
	manifest.value.objects.push({ objectId, name: model.name, kind: 'model', resourceId: model.id, assetId: manifest.value.rootAssetId || undefined, transform: { position, rotation: [0,0,0], scale: [1,1,1] } });
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
		if (!options.keepLibraryOpen) resourceDrawerVisible.value = false;
		refreshDiagnostics(); ElMessage.success(options.position ? '模型已按落点放入 threejs-editor；保存后资源绑定会写入数据库' : '模型已放入 threejs-editor；保存后资源绑定会写入数据库');
	}
	catch { removeModelObject(objectId); ElMessage.error('模型内容下载或解析失败'); }
};

const silkProceduralParent = () => manifest.value.objects.find((item) => item.kind === 'procedural'
	&& ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
const equipmentObject = (equipmentType: TwinEquipmentType) => manifest.value.objects.find((item) => item.kind === 'equipment'
	&& item.equipment?.equipmentType === equipmentType
	&& item.equipment.parentObjectId === silkProceduralParent()?.objectId);
const isEquipmentInScene = (equipmentType: TwinEquipmentType) => Boolean(equipmentObject(equipmentType));

const placeEquipmentTemplate = async (equipmentType: TwinEquipmentType, options: TwinPlacementOptions = {}) => {
	const parent = silkProceduralParent();
	if (!parent) {
		ElMessage.warning('程序化整机依赖丝饼产线，请先应用“丝饼完整工艺”模板');
		return;
	}
	let object = equipmentObject(equipmentType);
	let created = false;
	if (!object) {
		const template = createSilkCakeEquipmentObjectDefinitions(parent.objectId).find((item) => item.equipment?.equipmentType === equipmentType);
		if (!template) { ElMessage.error(`未找到整机模板 ${equipmentType}`); return; }
		object = JSON.parse(JSON.stringify(template)) as TwinSceneObjectDefinition;
		if (manifest.value.objects.some((item) => item.objectId === object!.objectId)) object.objectId = createId('equipment');
		if (manifest.value.rootAssetId) object.assetId = manifest.value.rootAssetId;
		manifest.value.objects.push(object);
		created = true;
	}
	if (!options.keepLibraryOpen) resourceDrawerVisible.value = false;
	if (viewportMode.value === 'editor') {
		if (created) professionalEditor.value?.reloadProceduralReferences();
		if (options.position) professionalEditor.value?.setObjectWorldPosition(object.objectId, options.position);
		professionalEditor.value?.selectObject(object.objectId);
		if (!options.position) professionalEditor.value?.focusSelected();
	} else adapter.value?.loadManifest(manifest.value);
	refreshDiagnostics();
	ElMessage.success(options.position ? `${object.name} 已移动到拖拽落点` : created ? `${object.name} 已作为独立整机对象放入场景` : `${object.name} 已在场景中定位`);
};

const isTwinLibraryDragPayload = (value: any): value is TwinLibraryDragPayload => value?.kind === 'component' && typeof value.resourceKey === 'string'
	|| value?.kind === 'model' && typeof value.modelId === 'string'
	|| value?.kind === 'equipment' && typeof value.equipmentType === 'string';
const beginResourceDrag = (event: DragEvent, payload: TwinLibraryDragPayload) => {
	activeLibraryDrag.value = payload;
	if (!event.dataTransfer) return;
	const serialized = JSON.stringify(payload);
	event.dataTransfer.effectAllowed = 'copyMove';
	event.dataTransfer.setData(twinLibraryDragMime, serialized);
	event.dataTransfer.setData('text/plain', serialized);
};
const endResourceDrag = () => {
	activeLibraryDrag.value = undefined;
	resourceDragOver.value = false;
	viewportDragDepth = 0;
};
const handleViewportDragEnter = () => {
	if (!activeLibraryDrag.value) return;
	viewportDragDepth += 1;
	resourceDragOver.value = true;
};
const handleViewportDragOver = (event: DragEvent) => {
	if (!activeLibraryDrag.value) return;
	resourceDragOver.value = true;
	if (event.dataTransfer) event.dataTransfer.dropEffect = activeLibraryDrag.value.kind === 'equipment' && isEquipmentInScene(activeLibraryDrag.value.equipmentType) ? 'move' : 'copy';
};
const handleViewportDragLeave = () => {
	viewportDragDepth = Math.max(0, viewportDragDepth - 1);
	if (viewportDragDepth === 0) resourceDragOver.value = false;
};
const placeLibraryResource = async (payload: TwinLibraryDragPayload, position: TwinVector3) => {
	const options: TwinPlacementOptions = { position, keepLibraryOpen: true };
	if (payload.kind === 'component') return placeComponentTemplate(payload.resourceKey, options);
	if (payload.kind === 'equipment') return placeEquipmentTemplate(payload.equipmentType, options);
	const model = models.value.find((item) => item.id === payload.modelId);
	if (!model) { ElMessage.error('拖拽的 GLB 模型资源已经不存在，请刷新模型库'); return; }
	return placeModel(model, options);
};
const handleViewportDrop = async (event: DragEvent) => {
	const serialized = event.dataTransfer?.getData(twinLibraryDragMime) || event.dataTransfer?.getData('text/plain');
	let payload = activeLibraryDrag.value;
	try {
		const parsed = serialized ? JSON.parse(serialized) : undefined;
		if (isTwinLibraryDragPayload(parsed)) payload = parsed;
	} catch { /* 仅接受 IoTSharp 模型库产生的结构化拖拽数据。 */ }
	resourceDragOver.value = false;
	viewportDragDepth = 0;
	if (!payload) return;
	const clientX = event.clientX, clientY = event.clientY;
	if (viewportMode.value !== 'editor') await switchViewportMode('editor');
	await nextTick();
	const position = await professionalEditor.value?.worldPositionFromClientPoint(clientX, clientY, 0) as TwinVector3 | undefined;
	if (!position) { ElMessage.warning('当前视角没有与场景地面相交，请调整视角后重试'); return; }
	await placeLibraryResource(payload, position);
};
const removeModelObject = (objectId: string) => {
	removeConnectionsForObject(manifest.value, objectId);
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
	try {
		const snapshot = apiData<TwinRuntimeSnapshot>(await digitalTwinApi.snapshot(currentScene.value.id));
		const updates = snapshot.updates || [];
		if (updates.length) {
			const next = { ...latestBindingUpdates.value };
			for (const update of updates) {
				if (update.bindingKey) next[update.bindingKey] = update;
				if (update.bindingId) next[update.bindingId] = update;
			}
			latestBindingUpdates.value = next;
		}
		adapter.value?.applyDataUpdates(updates);
	} catch { /* 下一轮自动重试。 */ }
};
const stopSnapshotPolling = () => { if (snapshotTimer !== undefined) window.clearInterval(snapshotTimer); snapshotTimer = undefined; };
const startSnapshotPolling = () => { stopSnapshotPolling(); refreshSnapshot(); snapshotTimer = window.setInterval(refreshSnapshot, 2000); };
const switchViewportMode = async (value: string | number | boolean) => {
	// 从专业编辑器离开前先把尚未保存的变换写回内存 Manifest，路线运行才能立即看到最新位置。
	try {
		professionalEditor.value?.captureManifest(manifest.value);
	} catch (error: any) {
		// 编辑器扩展快照属于附加信息，绝不能阻塞基础 Manifest 的运行预览。
		ElMessage.warning(`专业编辑快照同步失败，已继续打开运行预览：${error?.message || '未知错误'}`);
	}
	const nextMode = value === 'runtime' ? 'runtime' : 'editor';
	viewportMode.value = nextMode;
	if (nextMode === 'editor') deviceStatusDialogVisible.value = false;
	playing.value = false; routeDrawMode.value = false;
	await initializeViewport();
	// 与场景中心保持一致：用户主动进入“运行预览”时，离线仿真立即启动。
	if (nextMode === 'runtime' && !liveMode.value && adapter.value) {
		playing.value = true;
		adapter.value.setRunning(true);
	}
};
const toggleLiveMode = async (value: string | number | boolean) => {
	liveMode.value = Boolean(value); manifest.value.runtime.dataMode = liveMode.value ? 'live' : 'simulation';
	if (liveMode.value && viewportMode.value !== 'runtime') await switchViewportMode('runtime');
	liveMode.value ? startSnapshotPolling() : stopSnapshotPolling();
};
const togglePlaying = async () => {
	if (viewportMode.value !== 'runtime') {
		await switchViewportMode('runtime');
		return;
	}
	playing.value = !playing.value; adapter.value?.setRunning(playing.value);
};
const restoreGeneratedRoute = (notify = true) => {
	upsertGeneratedComponentRoute(manifest.value);
	routeDrawMode.value = false;
	professionalEditor.value?.setRouteDrawMode(false);
	professionalEditor.value?.refreshRouteOverlay();
	refreshDiagnostics();
	if (notify) ElMessage.warning('自动路线只读，请通过移动参数化组件或修改端口 Connection 调整路线。');
};
const ensureManualRouteEditing = () => {
	if (!routeIsGenerated.value) return true;
	restoreGeneratedRoute();
	return false;
};
const toggleRouteDrawMode = async () => {
	if (!ensureManualRouteEditing()) return;
	if (viewportMode.value !== 'editor') await switchViewportMode('editor');
	routeDrawMode.value = !routeDrawMode.value;
	professionalEditor.value?.setRouteEditMode(routeDrawMode.value);
	professionalEditor.value?.setRouteDrawMode(routeDrawMode.value);
};
const changeSpeed = (value: number | number[]) => adapter.value?.setSpeed(Array.isArray(value) ? value[0] : value);
const applySilkSimulationOptions = async () => {
	const options = manifest.value.runtime.silkLineSimulation;
	if (!options) return;
	const procedural = manifest.value.objects.find((item) => ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
	if (procedural?.procedural) procedural.procedural.palletCount = options.palletCount;
	playing.value = false;
	if (viewportMode.value === 'runtime') await initializeViewport();
	else await switchViewportMode('runtime');
	refreshDiagnostics();
};
const changeCurveKind = async (value: string | number | boolean) => {
	if (!ensureManualRouteEditing()) return;
	route.value.curveKind = value as TwinRouteDefinition['curveKind'];
	await syncRouteGraph();
};
const changeLoop = async (value: string | number | boolean) => {
	if (!ensureManualRouteEditing()) return;
	route.value.loop = Boolean(value);
	await syncRouteGraph();
};
const ensureRuntimeViewport = async () => {
	if (viewportMode.value !== 'runtime') await switchViewportMode('runtime');
};
const syncRouteGraph = async () => {
	if (routeIsGenerated.value) { restoreGeneratedRoute(); return; }
	const nextRoute = cloneTwinManifest({ ...manifest.value, routes: [route.value] }).routes[0];
	if (viewportMode.value === 'editor') {
		professionalEditor.value?.setRoute(nextRoute);
		professionalEditor.value?.refreshRouteOverlay();
		refreshDiagnostics();
		return;
	}
	adapter.value?.setRoute(nextRoute);
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
	if (!ensureManualRouteEditing()) return;
	const last = route.value.points[route.value.points.length - 1]?.position || [0, 0.72, 0];
	const point = createRoutePoint([last[0], last[1], last[2] + 2], route.value.points.length);
	point.name = `分支节点 ${route.value.points.length + 1}`;
	route.value.points.push(point);
	branchForm.toPointId = point.pointId;
	await syncRouteGraph();
};
const addRouteEdge = async () => {
	if (!ensureManualRouteEditing()) return;
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
	if (!ensureManualRouteEditing()) return;
	route.value.edges = route.value.edges.filter((edge) => edge.edgeId !== edgeId);
	delete previewOccupancy[edgeId];
	route.value.decisionRules = route.value.decisionRules.filter((rule) => rule.edgeId !== edgeId);
	for (const [pointId, selectedEdgeId] of Object.entries(route.value.junctionDecisions)) {
		if (selectedEdgeId === edgeId) delete route.value.junctionDecisions[pointId];
	}
	recalculateJunctionKinds(true);
	await syncRouteGraph();
};
const parseRuleValue = (value: unknown): string | number | boolean => {
	const normalized = String(value ?? '');
	if (normalized.toLocaleLowerCase() === 'true') return true;
	if (normalized.toLocaleLowerCase() === 'false') return false;
	if (normalized.trim() !== '' && Number.isFinite(Number(normalized))) return Number(normalized);
	return normalized;
};
const addDecisionRule = async () => {
	if (!ensureManualRouteEditing()) return;
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
	if (!ensureManualRouteEditing()) return;
	route.value.decisionRules = route.value.decisionRules.filter((rule) => rule.ruleId !== ruleId);
	await syncRouteGraph();
};
const updateRoutePoint = async (index: number) => {
	if (!ensureManualRouteEditing()) return;
	const point = route.value.points[index];
	if (!point) return;
	if (viewportMode.value === 'editor') professionalEditor.value?.updateRoutePoint(index, [...point.position] as TwinVector3);
	else adapter.value?.updateRoutePoint(index, [...point.position] as TwinVector3);
};
const addRoutePoint = async () => {
	if (!ensureManualRouteEditing()) return;
	if (viewportMode.value !== 'editor') await switchViewportMode('editor');
	professionalEditor.value?.setRouteEditMode(true);
	professionalEditor.value?.addRoutePoint();
};
const removeRoutePoint = async (index: number) => {
	if (!ensureManualRouteEditing()) return;
	const point = route.value.points[index];
	if (!point) return;

	// 路线编辑统一在专业场景中；删除节点时仍同步清理页面上按 ID 持有的表单状态。
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

	if (viewportMode.value === 'editor') {
		professionalEditor.value?.removeRoutePoint(index);
		const currentRoute = professionalEditor.value?.getRoute();
		if (currentRoute) applyRuntimeRoute(currentRoute);
		return;
	}
	const currentAdapter = adapter.value;
	if (!currentAdapter) return;
	currentAdapter.removeRoutePoint(index);
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
	try {
		await Promise.all([loadAssets(), loadModels(), loadScenes()]);
		await nextTick();
		const requestedSceneId = typeof currentRoute.query.sceneId === 'string' ? currentRoute.query.sceneId : '';
		const targetScene = scenes.value.find((item) => item.id === requestedSceneId) || scenes.value[0];
		if (targetScene) await loadScene(targetScene.id);
		else { await initializeViewport(); createDialogVisible.value = true; }
	}
	finally { pageLoading.value = false; }
});
onBeforeUnmount(() => { stopSnapshotPolling(); adapter.value?.dispose(); adapter.value = undefined; professionalEditor.value = undefined; modelBufferCache.clear(); });
</script>

<style scoped lang="scss">
.twin-workbench{--border:rgba(148,163,184,.2);--panel:rgba(8,19,34,.97);display:flex;flex-direction:column;height:calc(100vh - 132px);height:calc(100dvh - 132px);min-height:560px;margin:-15px;color:#dbeafe;background:#07111f;overflow:hidden}.twin-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:70px;padding:10px 18px;border-bottom:1px solid var(--border);background:#07111f}.twin-toolbar__title,.twin-toolbar__actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.twin-toolbar__title{min-width:320px}.scene-select{width:220px}.twin-toolbar__eyebrow,.twin-panel__heading span{font-size:10px;font-weight:800;letter-spacing:.15em;color:#38bdf8}.is-hidden{display:none}
.twin-status-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--border);background:#0a1728}.twin-status-strip>div{display:flex;flex-direction:column;gap:4px;padding:9px 15px;border-right:1px solid var(--border)}.twin-status-strip span,.twin-card__label{font-size:11px;color:#7f95ad}.twin-status-strip strong{font-size:12px}.twin-status-strip strong small{font:inherit}.is-running{color:#4ade80}.is-paused{color:#fbbf24}.is-waiting{color:#fb7185}.is-completed{color:#38bdf8}
.twin-layout{display:grid;grid-template-columns:300px minmax(420px,1fr) 310px;min-height:0;flex:1;overflow:hidden;transition:grid-template-columns .2s ease}.twin-layout.is-left-collapsed{grid-template-columns:0 minmax(420px,1fr) 310px}.twin-layout.is-right-collapsed{grid-template-columns:300px minmax(420px,1fr) 0}.twin-layout.is-left-collapsed.is-right-collapsed{grid-template-columns:0 minmax(420px,1fr) 0}.twin-panel{height:100%;min-height:0;padding:14px;background:var(--panel);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.twin-panel--left{grid-column:1;border-right:1px solid var(--border)}.twin-panel--right{grid-column:3;border-left:1px solid var(--border)}.twin-panel__heading{position:sticky;top:-14px;z-index:4;margin:-14px -14px 0;padding:14px;border-bottom:1px solid var(--border);background:var(--panel)}.twin-panel__heading,.twin-panel__subheading,.twin-inline-control{display:flex;align-items:center;justify-content:space-between;gap:10px}.twin-panel__heading>div{display:flex;flex-direction:column;gap:5px}.twin-panel__heading strong,.twin-panel__subheading strong{color:#f8fafc}.twin-panel__subheading{margin-top:18px}.root-asset-help{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px;border:1px solid rgba(245,158,11,.32);border-radius:8px;background:rgba(245,158,11,.08)}.root-asset-help span{display:flex;flex-shrink:0}.root-asset-warning{color:#fbbf24!important}
.twin-card{display:flex;flex-direction:column;gap:9px;margin-top:14px;padding:13px;border:1px solid var(--border);border-radius:12px;background:rgba(15,31,52,.82)}.twin-card label{font-size:12px;color:#9fb2c8}.twin-card small,.compact-list small,.binding-list small,.resource-card small,.version-card small{line-height:1.5;color:#7890a8;word-break:break-all}.twin-selection-card>strong,.resource-card strong{color:#f8fafc}.compact-list,.binding-list,.resource-grid{display:flex;flex-direction:column;gap:8px;margin-top:10px}.compact-list>div,.binding-list>div{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:rgba(15,31,52,.65)}.binding-list>div>div{display:flex;flex-direction:column;gap:3px}
.twin-runtime-detail{max-height:230px;margin:0;padding:9px;border:1px solid rgba(56,189,248,.22);border-radius:8px;background:rgba(2,8,23,.72);overflow:auto;color:#bae6fd;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.silk-simulation-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.silk-simulation-grid>label{display:flex;flex-direction:column;gap:4px}.silk-simulation-grid>label>span{display:flex;gap:3px}.silk-simulation-grid :deep(.el-input-number){width:100%}.twin-status-strip--silk{background:#0b1d27}.twin-status-strip--silk strong{color:#a7f3d0}
.twin-route-points{display:flex;flex-direction:column;gap:8px;margin-top:10px}.twin-route-point{padding:9px;border:1px solid var(--border);border-radius:10px;background:rgba(15,31,52,.65)}.twin-route-point.is-selected{border-color:#38bdf8}.twin-route-point__title{display:grid;grid-template-columns:24px 1fr 28px;align-items:center;gap:6px}.twin-route-point__title>span{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;font-size:11px;background:rgba(14,165,233,.2);color:#7dd3fc}.twin-route-point__meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}.twin-route-point__meta :deep(.el-select){width:130px}.twin-route-binding-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}.twin-route-process-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px;padding:7px;border:1px solid rgba(56,189,248,.26);border-radius:7px}.twin-route-process-grid :deep(.el-input-number){width:100%}.twin-coordinate-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:7px}.twin-coordinate-grid :deep(.el-input-number){width:100%}.twin-route-graph-editor{gap:8px}.twin-route-edge-form{display:grid;grid-template-columns:1fr 1fr;gap:6px}.twin-route-edges{display:flex;flex-direction:column;gap:7px;margin-top:9px}.twin-route-edge{display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:9px;border:1px solid var(--border);border-radius:9px;background:rgba(15,31,52,.65)}.twin-route-edge.is-blocked{border-color:rgba(239,68,68,.5)}.twin-route-edge__header{display:grid;grid-template-columns:minmax(0,1fr) auto 28px;align-items:center;gap:7px}.twin-route-edge__header>div{display:flex;min-width:0;flex-direction:column;gap:2px}.twin-route-edge__settings{display:grid;grid-template-columns:1fr 1fr;gap:6px}.twin-route-edge__settings>div{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:5px}.twin-route-edge__settings label{font-size:10px}.twin-route-edge strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.twin-route-edge small{font-size:10px;color:#7890a8}.twin-junction-decision{border-color:rgba(245,158,11,.35)}.twin-routing-preview{border-color:rgba(34,197,94,.32)}.twin-route-rules{display:flex;flex-direction:column;gap:7px;margin-top:9px}.twin-route-rules>div{display:grid;grid-template-columns:minmax(0,1fr) auto 28px;align-items:center;gap:7px;padding:8px 9px;border:1px solid rgba(34,197,94,.3);border-radius:9px;background:rgba(15,31,52,.65)}.twin-route-rules>div>div{display:flex;min-width:0;flex-direction:column;gap:2px}.twin-route-rules strong{font-size:11px}.twin-route-rules small{overflow:hidden;font-size:10px;color:#7890a8;text-overflow:ellipsis;white-space:nowrap}
.twin-secondary-route{border-color:rgba(168,85,247,.28)}.twin-secondary-route>.twin-inline-control strong{font-size:12px;color:#e9d5ff}.twin-secondary-route>.twin-inline-control small{text-align:right}
.twin-viewport-shell{grid-column:2;position:relative;min-width:0;min-height:560px;background:#050c16}.twin-viewport-shell.is-resource-drag-over{box-shadow:inset 0 0 0 2px #38bdf8}.twin-viewport{position:absolute;inset:0}.twin-viewport :deep(canvas){display:block;width:100%;height:100%;outline:none}.twin-panel-toggle{position:absolute;top:12px;z-index:12;width:30px;height:30px;border-color:rgba(56,189,248,.42);background:rgba(7,17,31,.88);color:#7dd3fc;font-size:20px}.twin-panel-toggle--left{left:10px}.twin-panel-toggle--right{right:10px}.twin-resource-drop-target{position:absolute;inset:18px;z-index:30;display:grid;place-content:center;gap:5px;border:2px dashed rgba(56,189,248,.8);border-radius:18px;color:#e0f2fe;background:rgba(3,15,28,.58);text-align:center;pointer-events:none;backdrop-filter:blur(2px)}.twin-resource-drop-target strong{font-size:18px}.twin-resource-drop-target span{font-size:11px;color:#7dd3fc}.twin-viewport__hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 11px;border:1px solid var(--border);border-radius:20px;font-size:11px;color:#9fb2c8;background:rgba(3,10,19,.8);pointer-events:none}.twin-progress{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(56,189,248,.12)}.twin-progress i{display:block;height:100%;background:#38bdf8;transition:width .15s linear}
.twin-diagnostics{display:flex;flex-direction:column;gap:7px;margin-top:14px}.twin-diagnostics>div{display:grid;grid-template-columns:42px 1fr;gap:7px;padding:8px;border-radius:8px;font-size:11px;line-height:1.45}.twin-diagnostics .is-error{background:rgba(239,68,68,.12);color:#fca5a5}.twin-diagnostics .is-warning{background:rgba(245,158,11,.12);color:#fcd34d}.twin-diagnostics .is-success{background:rgba(34,197,94,.12);color:#86efac}.resource-actions{display:flex;gap:8px;margin-bottom:12px}.resource-grid{margin-top:14px}.resource-card{display:grid;grid-template-columns:1fr auto;gap:8px;padding:13px;border:1px solid var(--el-border-color);border-radius:10px;transition:border-color .15s ease,box-shadow .15s ease,opacity .15s ease}.resource-card.is-draggable{cursor:grab;user-select:none}.resource-card.is-draggable:hover{border-color:#409eff;box-shadow:0 5px 18px rgba(64,158,255,.14)}.resource-card.is-draggable:active{cursor:grabbing}.resource-card.is-disabled{opacity:.62}.resource-card>div,.version-card{display:flex;flex-direction:column;gap:5px}.resource-card>.el-button{grid-column:1/-1}.version-card>span{color:var(--el-text-color-regular)}
.device-status-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding-right:26px}.device-status-heading>div{display:flex;min-width:0;flex-direction:column;gap:4px}.device-status-heading small{font-size:10px;font-weight:800;letter-spacing:.16em;color:#0ea5e9}.device-status-heading strong{font-size:20px;color:var(--el-text-color-primary)}.device-status-heading span{overflow:hidden;color:var(--el-text-color-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.device-status-section{display:flex;flex-direction:column;gap:12px;margin-top:18px}.device-status-section>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.device-status-section>div small{color:var(--el-text-color-secondary)}.device-status-section code{color:#0284c7;font-weight:700}
@media(max-width:1200px){.twin-layout{grid-template-columns:260px minmax(360px,1fr) 280px}.twin-layout.is-left-collapsed{grid-template-columns:0 minmax(360px,1fr) 280px}.twin-layout.is-right-collapsed{grid-template-columns:260px minmax(360px,1fr) 0}.twin-layout.is-left-collapsed.is-right-collapsed{grid-template-columns:0 minmax(360px,1fr) 0}.twin-toolbar{align-items:flex-start;flex-direction:column}.twin-status-strip{grid-template-columns:repeat(3,1fr)}}
</style>
