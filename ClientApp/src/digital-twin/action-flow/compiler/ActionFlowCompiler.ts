import type { TwinSceneManifest } from '../../contracts';
import type { TwinActionFlowDefinitionV2, TwinActionFlowDiagnostic, TwinCompiledActionFlowPlan } from '../contracts/action-flow-v2';
import { validateActionFlow } from '../validation/ActionFlowValidator';

const stableNormalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(stableNormalize);
	if (value && typeof value === 'object') {
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (key === 'editor' || key === 'graphHash' || key === 'compiledPlanHash') continue;
			output[key] = stableNormalize((value as Record<string, unknown>)[key]);
		}
		return output;
	}
	return value;
};

export const stableActionFlowStringify = (value: unknown) => JSON.stringify(stableNormalize(value));

/** Deterministic 64-bit FNV-1a hash. It is a definition fingerprint, not a credential/security primitive. */
export const actionFlowHash = (value: unknown) => {
	const text = stableActionFlowStringify(value);
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * prime);
	}
	return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
};

export class ActionFlowCompileError extends Error {
	constructor(public readonly diagnostics: TwinActionFlowDiagnostic[]) {
		super(diagnostics.filter((item) => item.severity === 'error').map((item) => `${item.code}: ${item.message}`).join('\n') || 'Action Flow compile failed');
		this.name = 'ActionFlowCompileError';
	}
}

export const compileActionFlow = (flow: TwinActionFlowDefinitionV2, manifest?: TwinSceneManifest): TwinCompiledActionFlowPlan => {
	const diagnostics = validateActionFlow(flow, manifest, manifest?.actionFlows || [flow]);
	if (diagnostics.some((item) => item.severity === 'error')) throw new ActionFlowCompileError(diagnostics);
	const definitionForHash = {
		...flow,
		nodes: [...flow.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map((node) => ({ ...node, editor: undefined })),
		edges: [...flow.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
	};
	const graphHash = actionFlowHash(definitionForHash);
	const start = flow.nodes.find((item) => item.type === 'Start')!;
	const planBase = {
		flowId: flow.flowId,
		key: flow.key,
		name: flow.name,
		contractVersion: '2.0' as const,
		revision: flow.revision,
		entryNodeId: start.nodeId,
		nodes: flow.nodes.map((node) => ({ ...structuredClone(node), editor: undefined })),
		edges: flow.edges.map((edge) => structuredClone(edge)),
		policies: {
			defaultTimeoutSeconds: Math.max(0.1, Number(flow.policies?.defaultTimeoutSeconds || 300)),
			maxLoopIterations: Math.max(1, Math.floor(Number(flow.policies?.maxLoopIterations || 1000))),
			requireInterlockForCommands: flow.policies?.requireInterlockForCommands !== false,
			...structuredClone(flow.policies || {}),
		},
		graphHash,
	};
	const compiledPlanHash = actionFlowHash(planBase);
	return { ...planBase, compiledPlanHash };
};

export const compileActionFlows = (flows: TwinActionFlowDefinitionV2[], manifest?: TwinSceneManifest) => flows.map((flow) => compileActionFlow(flow, manifest));
