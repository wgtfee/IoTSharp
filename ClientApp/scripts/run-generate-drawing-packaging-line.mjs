import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const entry = process.argv.includes('--flow-safety') ? 'scripts/verify-action-flow-safety.ts'
	: process.argv.includes('--motion-limits') ? 'scripts/verify-actuator-motion-limits.ts'
	: process.argv.includes('--material-interactions') ? 'scripts/verify-material-interactions.ts'
	: process.argv.includes('--action-flows') ? 'scripts/verify-scene-action-flows.ts'
	: process.argv.includes('--generate-process') ? 'scripts/generate-drawing-process.ts'
	: process.argv.includes('--full-process') ? 'scripts/verify-drawing-full-process.ts'
	: process.argv.includes('--process-core') ? 'scripts/verify-drawing-process-core.ts'
	: process.argv.includes('--verify') ? 'scripts/verify-drawing-packaging-line.ts' : 'scripts/generate-drawing-packaging-line.ts';
const bundle = await build({ entryPoints: [path.resolve(entry)], bundle: true, platform: 'node', format: 'cjs', write: false,
	plugins: [{ name: 'iotsharp-source-alias', setup(context) { context.onResolve({ filter: /^\/@\// }, (args) => {
		const source = path.resolve('src', args.path.slice(3));
		return { path: [`${source}.ts`, `${source}.tsx`, path.join(source, 'index.ts')].find((file) => fs.existsSync(file)) || source };
	}); } }],
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
