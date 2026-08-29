from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"PATCH TARGET NOT FOUND: {path}\n{old[:400]}")
    file.write_text(text.replace(old, new, count), encoding="utf-8")


# 1. V6 migrated components are visual/model instances; the verified V6 route remains authoritative.
path = "ClientApp/src/digital-twin/components/ComponentConnectionEngine.ts"
replace(
    path,
    "const objects = asV7Objects(manifest).filter(isComponentSceneObject);",
    "const objects = asV7Objects(manifest).filter((item) => isComponentSceneObject(item) && item.component.properties?.routeManagedExternally !== true);",
)
replace(
    path,
    "const components = asV7Objects(manifest).filter(isComponentSceneObject);",
    "const components = asV7Objects(manifest).filter((item) => isComponentSceneObject(item) && item.component.properties?.routeManagedExternally !== true);",
)

# 2. Silk V6 -> V7 migration is idempotent, preserving edited transforms/properties.
path = "ClientApp/src/digital-twin/components/SilkV7ComponentMigration.ts"
replace(
    path,
    "\tconst objects = manifest.objects as TwinV7SceneObjectDefinition[];\n\tfor (let index = objects.length - 1; index >= 0; index -= 1) {\n\t\tconst candidate = objects[index];\n\t\tif (candidate.kind === 'component' && candidate.component?.properties?.[MIGRATION_FLAG] === true) objects.splice(index, 1);\n\t}\n\n\tconst migrated: TwinV7SceneObjectDefinition[] = [];",
    "\tconst objects = manifest.objects as TwinV7SceneObjectDefinition[];\n\tconst existing = objects.filter((candidate) => candidate.kind === 'component' && candidate.component?.properties?.[MIGRATION_FLAG] === true);\n\tif (existing.length > 0) {\n\t\tmanifest.connections ||= [];\n\t\treturn { migrated: false, componentCount: existing.length };\n\t}\n\n\tconst migrated: TwinV7SceneObjectDefinition[] = [];",
)

# 3. Workbench persists/validates connections, keeps components in the professional editor, and cleans graph on delete.
path = "ClientApp/src/views/iot/digital-twin/workbench.vue"
replace(
    path,
    "import { builtInComponentTemplates } from '/@/digital-twin/components';",
    "import { builtInComponentTemplates, migrateSilkLineInfrastructureToV7, removeConnectionsForObject, upsertGeneratedComponentRoute, validateV7ComponentManifest } from '/@/digital-twin/components';",
)
replace(
    path,
    "const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model'));",
    "const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model' || (item as any).kind === 'component'));",
)
replace(
    path,
    "\tnormalized.objects = value.objects || [];\n\tnormalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);",
    "\tnormalized.objects = value.objects || [];\n\tnormalized.connections = value.connections || [];\n\tnormalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);",
)
replace(
    path,
    "\tupgradeLegacySilkRouteLayout(normalized);\n\treturn normalized;",
    "\tupgradeLegacySilkRouteLayout(normalized);\n\tmigrateSilkLineInfrastructureToV7(normalized);\n\treturn normalized;",
)
replace(
    path,
    "const refreshDiagnostics = () => { diagnostics.value = validateTwinSceneManifest(manifest.value); };",
    "const refreshDiagnostics = () => { diagnostics.value = [...validateTwinSceneManifest(manifest.value), ...validateV7ComponentManifest(manifest.value)]; };",
)

old_place = """const placeComponentTemplate = async (resourceKey: string) => {
\tconst template = componentTemplates.find((item) => item.resourceKey === resourceKey);
\tif (!template) { ElMessage.error(`未找到组件模板 ${resourceKey}`); return; }
\tconst objectId = createId('component');
\tconst sectionId = `section-${objectId}`;
\tconst registered = models.value.find((item) => item.resourceKey === template.resourceKey && item.runtimeFormat === 'application/vnd.iotsharp.twin-component+json');
\tif (registered && !manifest.value.resources.some((item) => item.resourceId === registered.id)) {
\t\tmanifest.value.resources.push({ resourceId: registered.id, name: registered.name, status: 'ready' });
\t}
\t(manifest.value.objects as any[]).push({
\t\tobjectId,
\t\tname: template.name,
\t\tkind: 'component',
\t\tresourceId: registered?.id,
\t\tassetId: manifest.value.rootAssetId || undefined,
\t\tcomponent: {
\t\t\tresourceKey: template.resourceKey,
\t\t\tcomponentType: template.componentType,
\t\t\tgenerator: template.generator,
\t\t\tgeneratorVersion: template.generatorVersion,
\t\t\tproperties: structuredClone(template.defaultProperties),
\t\t\tsectionId,
\t\t},
\t\ttransform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
\t});
\tresourceDrawerVisible.value = false;
\tif (viewportMode.value !== 'runtime') await switchViewportMode('runtime');
\telse adapter.value?.loadManifest(manifest.value);
\trefreshDiagnostics();
\tElMessage.success(`${template.name} 已放入场景；参数随草稿保存，不需要修改场景代码。`);
};"""
new_place = """const placeComponentTemplate = async (resourceKey: string) => {
\tconst template = componentTemplates.find((item) => item.resourceKey === resourceKey);
\tif (!template) { ElMessage.error(`未找到组件模板 ${resourceKey}`); return; }
\tconst objectId = createId('component');
\tconst sectionId = `section-${objectId}`;
\tconst registered = models.value.find((item) => item.resourceKey === template.resourceKey && item.runtimeFormat === 'application/vnd.iotsharp.twin-component+json');
\tif (registered && !manifest.value.resources.some((item) => item.resourceId === registered.id)) manifest.value.resources.push({ resourceId: registered.id, name: registered.name, status: 'ready' });
\t(manifest.value.objects as any[]).push({ objectId, name: template.name, kind: 'component', resourceId: registered?.id, assetId: manifest.value.rootAssetId || undefined, component: { resourceKey: template.resourceKey, componentType: template.componentType, generator: template.generator, generatorVersion: template.generatorVersion, properties: structuredClone(template.defaultProperties), sectionId }, transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
\tmanifest.value.connections ||= [];
\tupsertGeneratedComponentRoute(manifest.value);
\tresourceDrawerVisible.value = false;
\tif (viewportMode.value === 'editor') {
\t\tprofessionalEditor.value?.reloadComponent(objectId);
\t\tprofessionalEditor.value?.selectObject(objectId);
\t} else adapter.value?.loadManifest(manifest.value);
\trefreshDiagnostics();
\tElMessage.success(`${template.name} 已放入场景；右侧 V7 属性面板可直接改参数、吸附端口并生成 Section / Route。`);
};"""
replace(path, old_place, new_place)
replace(
    path,
    "const removeModelObject = (objectId: string) => {\n\tif (viewportMode.value === 'editor') professionalEditor.value?.removeObject(objectId);",
    "const removeModelObject = (objectId: string) => {\n\tremoveConnectionsForObject(manifest.value, objectId);\n\tif (viewportMode.value === 'editor') professionalEditor.value?.removeObject(objectId);",
)

# 4. Procedural V6 runtime retains mechanics/entities but skips duplicate conveyor/station visuals once V7 instances exist.
path = "ClientApp/src/digital-twin/runtime/ProceduralPackagingLine.ts"
replace(
    path,
    "\tconstructor(route: TwinRouteDefinition, palletCount = 80, options: Partial<SilkLineSimulationOptions> = {}) {",
    "\tconstructor(route: TwinRouteDefinition, palletCount = 80, options: Partial<SilkLineSimulationOptions> = {}, visualOptions: { renderLegacyPlasticConveyors?: boolean; renderLegacyPreProcessStations?: boolean } = {}) {",
)
replace(
    path,
    "\t\tthis.buildFloorLabels();\n\t\tthis.buildPlasticConveyors();\n\t\tthis.buildPreProcessStations();",
    "\t\tthis.buildFloorLabels();\n\t\tif (visualOptions.renderLegacyPlasticConveyors !== false) this.buildPlasticConveyors();\n\t\tif (visualOptions.renderLegacyPreProcessStations !== false) this.buildPreProcessStations();",
)

path = "ClientApp/src/digital-twin/runtime/TwinRuntime.ts"
replace(
    path,
    "\t\t\tconst palletCount = silkLineDefinition.procedural?.palletCount ?? this.manifest.runtime.silkLineSimulation?.palletCount ?? 50;\n\t\t\tthis.packagingLine = new ProceduralPackagingLine(this.route, palletCount, this.manifest.runtime.silkLineSimulation);",
    "\t\t\tconst palletCount = silkLineDefinition.procedural?.palletCount ?? this.manifest.runtime.silkLineSimulation?.palletCount ?? 50;\n\t\t\tconst hasV7Infrastructure = (this.manifest.objects as any[]).some((item) => item.kind === 'component' && item.component?.properties?.silkV7Infrastructure === true);\n\t\t\tthis.packagingLine = new ProceduralPackagingLine(this.route, palletCount, this.manifest.runtime.silkLineSimulation, { renderLegacyPlasticConveyors: !hasV7Infrastructure, renderLegacyPreProcessStations: !hasV7Infrastructure });",
)

# 5. Professional editor auto-snaps on transform release. Apply snapped manifest transform directly to the root.
path = "ClientApp/src/digital-twin/editor-adapter/ThreeEditorCoreHost.ts"
replace(
    path,
    "import { defaultComponentRegistry, isComponentSceneObject, type TwinComponentDefinition } from '/@/digital-twin/components';",
    "import { defaultComponentRegistry, isComponentSceneObject, snapAndConnectNearestComponent, type TwinComponentDefinition } from '/@/digital-twin/components';",
)
replace(
    path,
    "\t\tthis.editor.viewer.transformControls.dragChangeCallback = (dragging: boolean) => {\n\t\t\tif (!dragging) {\n\t\t\t\tthis.syncTransformsToManifest();\n\t\t\t\tthis.events.onChanged?.();\n\t\t\t}\n\t\t};",
    "\t\tthis.editor.viewer.transformControls.dragChangeCallback = (dragging: boolean) => {\n\t\t\tif (!dragging) {\n\t\t\t\tthis.syncTransformsToManifest();\n\t\t\t\tconst selectedId = this.selectedObjectId;\n\t\t\t\tconst selected = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === selectedId);\n\t\t\t\tif (selectedId && isComponentSceneObject(selected)) {\n\t\t\t\t\tconst snapped = snapAndConnectNearestComponent(this.manifest, selectedId, { maxDistance: 1.5, preferFacingPorts: true });\n\t\t\t\t\tif (snapped) {\n\t\t\t\t\t\tconst root = this.loadedModels.get(selectedId)?.root;\n\t\t\t\t\t\tif (root) { root.position.set(...selected.transform.position); root.rotation.set(...selected.transform.rotation); root.scale.set(...selected.transform.scale); root.updateMatrixWorld?.(true); }\n\t\t\t\t\t\tthis.selectObject(selectedId);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\tthis.events.onChanged?.();\n\t\t\t}\n\t\t};",
)
replace(
    path,
    "\treloadAllComponents() {\n\t\tthis.syncTransformsToManifest();\n\t\tfor (const model of [...this.loadedModels.values()].filter((item) => item.kind === 'component')) this.removeObject(model.objectId, false);",
    "\treloadAllComponents() {\n\t\tfor (const model of [...this.loadedModels.values()].filter((item) => item.kind === 'component')) this.removeObject(model.objectId, false);",
)

# 6. Server manifest normalization/publish validation accepts V7 physical Connection graph.
path = "IoTSharp/Services/DigitalTwin/TwinManifestInspector.cs"
replace(
    path,
    '        root["objects"] ??= new JsonArray();\n        root["bindings"] ??= new JsonArray();',
    '        root["objects"] ??= new JsonArray();\n        root["connections"] ??= new JsonArray();\n        root["bindings"] ??= new JsonArray();',
)
replace(
    path,
    "        var objectIds = InspectObjects(manifest, rootAssetId, result);\n        InspectBindings(manifest, objectIds, result);",
    "        var objectIds = InspectObjects(manifest, rootAssetId, result);\n        InspectConnections(manifest, objectIds, result);\n        InspectBindings(manifest, objectIds, result);",
)
marker = "    private static void InspectBindings(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)\n"
method = '''    private static void InspectConnections(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)\n    {\n        if (!manifest.TryGetProperty("connections", out var connections) || connections.ValueKind != JsonValueKind.Array)\n        {\n            result.Diagnostics.Add(Error("twin.connections.invalid", "connections 必须是数组。", "connections"));\n            return;\n        }\n        var ids = new HashSet<string>(StringComparer.Ordinal);\n        var occupiedPorts = new HashSet<string>(StringComparer.Ordinal);\n        var index = 0;\n        foreach (var connection in connections.EnumerateArray())\n        {\n            var path = $"connections[{index}]";\n            if (!TryGetNonEmptyString(connection, "connectionId", out var id) || !ids.Add(id))\n                result.Diagnostics.Add(Error("twin.connection.id.invalid", "connectionId 不能为空且必须唯一。", $"{path}.connectionId"));\n            foreach (var endpointName in new[] { "from", "to" })\n            {\n                if (!connection.TryGetProperty(endpointName, out var endpoint) || endpoint.ValueKind != JsonValueKind.Object ||\n                    !TryGetNonEmptyString(endpoint, "objectId", out var objectId) || !objectIds.Contains(objectId) ||\n                    !TryGetNonEmptyString(endpoint, "portId", out var portId))\n                {\n                    result.Diagnostics.Add(Error("twin.connection.endpoint.invalid", "Connection 端点必须引用已存在对象和非空 portId。", $"{path}.{endpointName}"));\n                    continue;\n                }\n                if (!occupiedPorts.Add($"{objectId}::{portId}"))\n                    result.Diagnostics.Add(Error("twin.connection.port.duplicate", "同一个物理端口不能同时连接多个端点。", $"{path}.{endpointName}"));\n            }\n            index += 1;\n        }\n    }\n\n'''
replace(path, marker, method + marker)

print("V7 remaining integration patch applied")
