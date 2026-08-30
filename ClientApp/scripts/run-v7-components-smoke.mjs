import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const result = await build({
	entryPoints: [path.resolve('scripts/verify-v7-components.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
	plugins: [{
		name: 'iotsharp-source-alias',
		setup(context) {
			context.onResolve({ filter: /^\/@\// }, (args) => {
				const sourcePath = path.resolve('src', args.path.slice(3));
				const resolved = [`${sourcePath}.ts`, `${sourcePath}.tsx`, path.join(sourcePath, 'index.ts')].find((candidate) => fs.existsSync(candidate));
				return { path: resolved || sourcePath };
			});
		},
	}],
});

const module = { exports: {} };
// 两个工艺组件的文字牌使用 Canvas；Node 专项测试只验证几何、端口和拓扑，返回空上下文即可跳过贴图。
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
const execute = new Function('require', 'module', 'exports', result.outputFiles[0].text);
execute(createRequire(import.meta.url), module, module.exports);
