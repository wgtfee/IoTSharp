import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [path.resolve('scripts/generate-drawing-packaging-line.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
	plugins: [{ name: 'iotsharp-source-alias', setup(context) { context.onResolve({ filter: /^\/@\// }, (args) => {
		const source = path.resolve('src', args.path.slice(3));
		return { path: [`${source}.ts`, `${source}.tsx`, path.join(source, 'index.ts')].find((file) => fs.existsSync(file)) || source };
	}); } }],
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
