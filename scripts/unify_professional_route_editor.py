from pathlib import Path

path = Path('ClientApp/src/views/iot/digital-twin/workbench.vue')
text = path.read_text(encoding='utf-8')

replacements = [
(
"\t\t\t\t<ThreeJsEditorHost v-if=\"viewportMode === 'editor'\" :key=\"editorInstanceKey\" ref=\"professionalEditor\" :manifest=\"manifest\" @selection-change=\"selected = $event\" @changed=\"markEditorChanged\" @error=\"ElMessage.error($event)\" />",
"\t\t\t\t<ThreeJsEditorHost v-if=\"viewportMode === 'editor'\" :key=\"editorInstanceKey\" ref=\"professionalEditor\" :manifest=\"manifest\" @selection-change=\"selected = $event\" @route-change=\"applyRuntimeRoute\" @changed=\"markEditorChanged\" @error=\"ElMessage.error($event)\" />"
),
(
"\t\t\t\t<div class=\"twin-viewport__hint\"><template v-if=\"viewportMode === 'editor'\">threejs-editor 专业模式：模型变换、节点/材质、灯光、相机和后期处理会随草稿入库。</template><template v-else-if=\"routeDrawMode\">点击地面添加控制点；蓝色为途经点，橙色为分流器，紫色为汇流器，绿色为工位。</template><template v-else>绿色曲线是当前选路，红色输送段不可用；自动模式会按物料、Device 信号和容量选路。</template></div>",
"\t\t\t\t<div class=\"twin-viewport__hint\"><template v-if=\"viewportMode === 'editor'\">专业编辑是唯一工程坐标场景：模型、V7组件、Port、Connection、Section 与 Route 同图编辑；路线点可直接选择和拖动。</template><template v-else>运行预览只负责仿真/实时状态；工程位置以专业编辑场景为准。</template></div>"
),
(
"const viewportModeOptions = [{ label: '专业编辑', value: 'editor' }, { label: '路线运行', value: 'runtime' }];",
"const viewportModeOptions = [{ label: '专业编辑', value: 'editor' }, { label: '运行预览', value: 'runtime' }];"
),
(
"const toggleRouteDrawMode = async () => {\n\tif (viewportMode.value !== 'runtime') await switchViewportMode('runtime');\n\trouteDrawMode.value = !routeDrawMode.value; adapter.value?.setRouteDrawMode(routeDrawMode.value);\n};",
"const toggleRouteDrawMode = async () => {\n\tif (viewportMode.value !== 'editor') await switchViewportMode('editor');\n\trouteDrawMode.value = !routeDrawMode.value;\n\tprofessionalEditor.value?.setRouteEditMode(routeDrawMode.value);\n\tprofessionalEditor.value?.setRouteDrawMode(routeDrawMode.value);\n};"
),
(
"const changeCurveKind = (value: string | number | boolean) => adapter.value?.setRouteCurveKind(value as TwinRouteDefinition['curveKind']);\nconst changeLoop = (value: string | number | boolean) => adapter.value?.setRouteLoop(Boolean(value));",
"const changeCurveKind = async (value: string | number | boolean) => {\n\troute.value.curveKind = value as TwinRouteDefinition['curveKind'];\n\tawait syncRouteGraph();\n};\nconst changeLoop = async (value: string | number | boolean) => {\n\troute.value.loop = Boolean(value);\n\tawait syncRouteGraph();\n};"
),
(
"const syncRouteGraph = async () => {\n\tawait ensureRuntimeViewport();\n\tadapter.value?.setRoute(cloneTwinManifest({ ...manifest.value, routes: [route.value] }).routes[0]);\n\tconst payload = parsePreviewPayload(false);\n\tif (payload) adapter.value?.setRouteRoutingContext({ payload, edgeOccupancy: { ...previewOccupancy } });\n\trefreshDiagnostics();\n};",
"const syncRouteGraph = async () => {\n\tconst nextRoute = cloneTwinManifest({ ...manifest.value, routes: [route.value] }).routes[0];\n\tif (viewportMode.value === 'editor') {\n\t\tprofessionalEditor.value?.setRoute(nextRoute);\n\t\tprofessionalEditor.value?.refreshRouteOverlay();\n\t\trefreshDiagnostics();\n\t\treturn;\n\t}\n\tadapter.value?.setRoute(nextRoute);\n\tconst payload = parsePreviewPayload(false);\n\tif (payload) adapter.value?.setRouteRoutingContext({ payload, edgeOccupancy: { ...previewOccupancy } });\n\trefreshDiagnostics();\n};"
),
(
"const updateRoutePoint = async (index: number) => {\n\tawait ensureRuntimeViewport();\n\tconst point = route.value.points[index];\n\tif (point) adapter.value?.updateRoutePoint(index, [...point.position] as TwinVector3);\n};\nconst addRoutePoint = async () => { await ensureRuntimeViewport(); adapter.value?.addRoutePoint(); };",
"const updateRoutePoint = async (index: number) => {\n\tconst point = route.value.points[index];\n\tif (!point) return;\n\tif (viewportMode.value === 'editor') professionalEditor.value?.updateRoutePoint(index, [...point.position] as TwinVector3);\n\telse adapter.value?.updateRoutePoint(index, [...point.position] as TwinVector3);\n};\nconst addRoutePoint = async () => {\n\tif (viewportMode.value !== 'editor') await switchViewportMode('editor');\n\tprofessionalEditor.value?.setRouteEditMode(true);\n\tprofessionalEditor.value?.addRoutePoint();\n};"
),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f'Patch target not found:\n{old[:240]}')
    text = text.replace(old, new, 1)

old_remove = """const removeRoutePoint = async (index: number) => {
\tawait ensureRuntimeViewport();
\tconst point = route.value.points[index];
\tconst currentAdapter = adapter.value;
\tif (!point || !currentAdapter) return;

\t// 控制点删除会同时删除相邻路线边。页面表单持有的是 ID，必须一起清理，否则 Element Plus 会继续显示旧标签。
\tconst removedEdgeIds = new Set(route.value.edges
\t\t.filter((edge) => edge.fromPointId === point.pointId || edge.toPointId === point.pointId)
\t\t.map((edge) => edge.edgeId));
\tif (branchForm.fromPointId === point.pointId) branchForm.fromPointId = '';
\tif (branchForm.toPointId === point.pointId) branchForm.toPointId = '';
\tif (ruleForm.junctionPointId === point.pointId) {
\t\truleForm.junctionPointId = '';
\t\truleForm.edgeId = '';
\t} else if (removedEdgeIds.has(ruleForm.edgeId)) ruleForm.edgeId = '';
\tfor (const edgeId of removedEdgeIds) delete previewOccupancy[edgeId];
\tif (selected.value?.kind === 'route-point') selected.value = null;

\tcurrentAdapter.removeRoutePoint(index);
\t// 事件回调会同步 Manifest；这里再从运行时读取一次，避免任何视图切换时序导致左侧列表保留旧数组。
\tapplyRuntimeRoute(currentAdapter.getRoute());
};"""

new_remove = """const removeRoutePoint = async (index: number) => {
\tconst point = route.value.points[index];
\tif (!point) return;

\t// 路线编辑统一在专业场景中；删除节点时仍同步清理页面上按 ID 持有的表单状态。
\tconst removedEdgeIds = new Set(route.value.edges
\t\t.filter((edge) => edge.fromPointId === point.pointId || edge.toPointId === point.pointId)
\t\t.map((edge) => edge.edgeId));
\tif (branchForm.fromPointId === point.pointId) branchForm.fromPointId = '';
\tif (branchForm.toPointId === point.pointId) branchForm.toPointId = '';
\tif (ruleForm.junctionPointId === point.pointId) {
\t\truleForm.junctionPointId = '';
\t\truleForm.edgeId = '';
\t} else if (removedEdgeIds.has(ruleForm.edgeId)) ruleForm.edgeId = '';
\tfor (const edgeId of removedEdgeIds) delete previewOccupancy[edgeId];
\tif (selected.value?.kind === 'route-point') selected.value = null;

\tif (viewportMode.value === 'editor') {
\t\tprofessionalEditor.value?.removeRoutePoint(index);
\t\tconst currentRoute = professionalEditor.value?.getRoute();
\t\tif (currentRoute) applyRuntimeRoute(currentRoute);
\t\treturn;
\t}
\tconst currentAdapter = adapter.value;
\tif (!currentAdapter) return;
\tcurrentAdapter.removeRoutePoint(index);
\tapplyRuntimeRoute(currentAdapter.getRoute());
};"""

if old_remove not in text:
    raise SystemExit('removeRoutePoint patch target not found')
text = text.replace(old_remove, new_remove, 1)

path.write_text(text, encoding='utf-8')
print('Workbench route editing unified into professional editor scene')
