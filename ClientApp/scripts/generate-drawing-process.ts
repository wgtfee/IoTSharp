import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { validateV7ComponentManifest } from '../src/digital-twin/components';

const manifest = createDrawingPackagingProcessManifest();
const errors = [...validateTwinSceneManifest(manifest), ...validateV7ComponentManifest(manifest)].filter(d => d.severity === 'error' && d.code !== 'twin.component.resource.required');
assert.deepEqual(errors, [], '工艺模板合同不通过');
const payload = JSON.stringify(manifest, null, 2);
assert(!/https?:|data:|javascript:|<script/i.test(payload));
fs.mkdirSync('public/digital-twin/templates', { recursive: true });
fs.writeFileSync('public/digital-twin/templates/drawing-0911-process.scene.json', payload);
console.log(JSON.stringify({ name: manifest.name, objects: manifest.objects.length, behaviors: manifest.behaviors?.length, workPoints: manifest.workPoints?.length, materialSlots: manifest.materialSlots?.length, actuators: manifest.actuators?.length, databaseState: 'template-only; create via authenticated designer' }, null, 2));
