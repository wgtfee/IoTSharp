# Third-party notices for the IoTSharp digital-twin editor

The digital-twin editor contains or depends on the following third-party work. This file supplements, and does not replace, the license files shipped with the relevant source or package.

## threejs-editor / three-editor-cores

- Project: `z2586300277/threejs-editor`
- Editor baseline commit: `d7e2ddf6cc1fa8c626356a3606167abff68daaed`
- Vendored core source: `z2586300277/three-editor-cores`
- Core source commit: `98197115af2318ed20f334873517018509b8e079`
- License: Apache License 2.0
- Vendored location: `src/digital-twin/vendor/three-editor-cores`
- License copy: `src/digital-twin/vendor/three-editor-cores/LICENSE`

IoTSharp keeps its storage, resource authorization, scene versions, Device bindings and route runtime outside the vendored editor source. Local modifications are implemented in `src/digital-twin/editor-adapter/ThreeEditorCoreHost.ts` and `src/digital-twin/components/ThreeJsEditorHost.vue`.

## Draco decoder

- Project: Google Draco
- License: Apache License 2.0
- Location: `public/iotsharp-three-editor/draco`

The decoder files are distributed with the fixed upstream editor-core source and are used only to load Draco-compressed GLB resources.

## Additional runtime dependencies

| Package | Resolved version | License |
| --- | --- | --- |
| `cannon-es` | 0.20.0 | MIT |
| `dat.gui` | 0.7.9 | Apache-2.0 |
| `gsap` | 3.15.0 | Standard no-charge license; see the package metadata and `https://gsap.com/standard-license` |
| `proj4` | 2.21.0 | MIT |

Resolved versions are fixed by `package-lock.json`. Review this notice and the resolved package licenses whenever dependencies or upstream commits change.
