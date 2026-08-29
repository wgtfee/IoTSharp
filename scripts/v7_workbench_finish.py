from pathlib import Path

WORKBENCH = Path('ClientApp/src/views/iot/digital-twin/workbench.vue')
WORKFLOW = Path('.github/workflows/develop-platform-contract.yml')
SELF = Path(__file__)


def replace(old: str, new: str, count: int = 1) -> None:
    text = WORKBENCH.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'WORKBENCH PATCH TARGET NOT FOUND:\n{old[:500]}')
    WORKBENCH.write_text(text.replace(old, new, count), encoding='utf-8')


replace(
    "import { builtInComponentTemplates } from '/@/digital-twin/components';",
    "import { builtInComponentTemplates, migrateSilkLineInfrastructureToV7, removeConnectionsForObject, upsertGeneratedComponentRoute, validateV7ComponentManifest } from '/@/digital-twin/components';",
)
replace(
    "const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model'));",
    "const modelObjects = computed(() => manifest.value.objects.filter((item) => item.kind === 'model' || (item as any).kind === 'component'));",
)
replace(
    "\tnormalized.objects = value.objects || [];\n\tnormalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);",
    "\tnormalized.objects = value.objects || [];\n\tnormalized.connections = value.connections || [];\n\tnormalized.routes = (value.routes?.length ? value.routes : createDefaultTwinSceneManifest().routes).map(normalizeTwinRoute);",
)
replace(
    "\tupgradeLegacySilkRouteLayout(normalized);\n\treturn normalized;",
    "\tupgradeLegacySilkRouteLayout(normalized);\n\tmigrateSilkLineInfrastructureToV7(normalized);\n\treturn normalized;",
)
replace(
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
replace(old_place, new_place)
replace(
    "const removeModelObject = (objectId: string) => {\n\tif (viewportMode.value === 'editor') professionalEditor.value?.removeObject(objectId);",
    "const removeModelObject = (objectId: string) => {\n\tremoveConnectionsForObject(manifest.value, objectId);\n\tif (viewportMode.value === 'editor') professionalEditor.value?.removeObject(objectId);",
)

# Restore the normal contract workflow in the same final commit.
WORKFLOW.write_text("""name: IoTSharp Develop Platform Contract

on:
  push:
    branches: [ Develop ]
  pull_request:
    branches: [ Develop ]
  workflow_dispatch:

permissions:
  contents: read
  statuses: write

jobs:
  contract:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - name: Validate IoT IAM and traffic-health contract
        shell: python
        run: |
          from pathlib import Path

          startup = Path('IoTSharp/Startup.cs').read_text(encoding='utf-8-sig')
          health = Path('IoTSharp/Health/V071HealthEndpoints.cs').read_text(encoding='utf-8-sig')
          oidc = Path('ClientApp/src/security/oidc.ts').read_text(encoding='utf-8-sig')

          for marker in [
              'AddIndustrialSecurity(Configuration)',
              'UseIndustrialSecurity()',
              'MapIndustrialSecurityCacheInvalidation()',
              'MapIndustrialLocalUserManagementInfo()',
              'MapIndustrialEmergencyValidation()',
              'MapV071Health("iotsharp")',
          ]:
              assert marker in startup, f'Missing IoT security/health contract: {marker}'

          for marker in [
              "VITE_IAM_CLIENT_ID || 'industrial-iot-web'",
              "url.searchParams.set('code_challenge_method', 'S256')",
              "'/connect/token'",
              "'/account/login'",
          ]:
              assert marker in oidc, f'Missing IoT web OIDC contract: {marker}'

          assert 'endpoints.MapGet("/health/traffic"' in health
          assert 'StatusCodes.Status503ServiceUnavailable' in health
          for critical in ['"oracle"', '"clickhouse"', '"sonnet"', '"sql"']:
              assert critical in health, f'Missing critical database family classification: {critical}'
          assert 'DependencyCriticality.Degradable' in health
          print('IoTSharp Develop IAM/traffic-health contract OK')

      - name: Publish validation status
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const passed = '${{ job.status }}' === 'success';
            await github.rest.repos.createCommitStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              sha: context.sha,
              state: passed ? 'success' : 'failure',
              context: 'ci/iot-platform-contract',
              description: passed ? 'IoT platform contract passed' : 'IoT platform contract failed',
              target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
            });
""", encoding='utf-8')

# Remove this one-shot helper from the final tree.
SELF.unlink()
print('V7 workbench integration patched; workflow restored; helper removed')
