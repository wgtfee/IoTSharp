import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

// 只在内存中使用 HEAD 源码作对照，避免为定位回归而覆盖用户工作区。
const baseline = process.argv.includes('--baseline');
const throughV15 = process.argv.includes('--through-v15');
const repository = path.resolve('..');
const baselineRevision = baseline ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim() : undefined;
const changed = new Set(baseline ? execFileSync('git', ['diff', '--name-only', baselineRevision, '--', 'ClientApp/src/digital-twin'], { cwd: repository, encoding: 'utf8' }).trim().split(/\r?\n/) : []);
const entry = path.resolve('scripts/verify-v7-components.ts');
console.log(`V7 regression: ${baseline ? `HEAD baseline ${baselineRevision}` : 'working tree'}, ${throughV15 ? 'through V15' : 'full suite'}`);

const result = await build({
	entryPoints: [path.resolve('scripts/verify-v7-components.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
	plugins: [{
		name: 'iotsharp-source-alias',
		setup(context) {
			context.onLoad({ filter: /\.ts$/ }, (args) => {
				const relative = path.relative(repository, args.path).replaceAll('\\', '/');
				if (!changed.has(relative) && !(throughV15 && args.path === entry)) return;
				let contents = changed.has(relative)
					? execFileSync('git', ['show', `${baselineRevision}:${relative}`], { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
					: fs.readFileSync(args.path, 'utf8');
				if (throughV15 && args.path === entry) {
					const marker = 'const v18FullManifest =';
					if (!contents.includes(marker)) throw new Error('V15/V18 验收分界已改变，请先更新专项回归入口。');
					contents = contents.replace(marker, `console.log('V7 through V15 passed'); process.exit(0); ${marker}`);
				}
				return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
			});
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
