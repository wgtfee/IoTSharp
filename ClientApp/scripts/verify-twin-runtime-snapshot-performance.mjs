#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const readArg = (name) => {
	const exact = args.find((item) => item === `--${name}`);
	if (exact) {
		const index = args.indexOf(exact);
		return args[index + 1];
	}
	const inline = args.find((item) => item.startsWith(`--${name}=`));
	return inline?.slice(name.length + 3);
};

const baseUrl = String(readArg('base-url') || process.env.IOTSHARP_BASE_URL || 'http://localhost:27915').replace(/\/$/, '');
const sceneId = String(readArg('scene-id') || process.env.IOTSHARP_SCENE_ID || '').trim();
const versionRaw = readArg('version') || process.env.IOTSHARP_SCENE_VERSION;
const token = String(readArg('token') || process.env.IOTSHARP_TOKEN || '').trim();
const samples = Math.max(5, Number(readArg('samples') || process.env.IOTSHARP_SNAPSHOT_SAMPLES || 50));
const warmups = Math.max(1, Number(readArg('warmups') || process.env.IOTSHARP_SNAPSHOT_WARMUPS || 5));
const thresholdMs = Math.max(1, Number(readArg('threshold-ms') || process.env.IOTSHARP_SNAPSHOT_P95_THRESHOLD_MS || 150));
const version = versionRaw === undefined || versionRaw === '' ? undefined : Number(versionRaw);

if (!sceneId) {
	console.error('Twin snapshot performance FAIL: 缺少 sceneId。请使用 --scene-id <guid> 或 IOTSHARP_SCENE_ID。');
	process.exit(2);
}
if (!token) {
	console.error('Twin snapshot performance FAIL: Snapshot API 需要登录授权。请使用 --token <bearer> 或 IOTSHARP_TOKEN；脚本不会保存 Token。');
	process.exit(2);
}
if (version !== undefined && (!Number.isInteger(version) || version <= 0)) {
	console.error(`Twin snapshot performance FAIL: version 必须是正整数，当前=${versionRaw}`);
	process.exit(2);
}

const endpoint = `${baseUrl}/api/digital-twin/runtime/snapshot`;
const requestSnapshot = async (sinceTimestamp) => {
	const body = { sceneId };
	if (version !== undefined) body.version = version;
	if (sinceTimestamp) body.sinceTimestamp = sinceTimestamp;
	const startedAt = performance.now();
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const elapsedMs = performance.now() - startedAt;
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
	let json;
	try { json = JSON.parse(text); }
	catch { throw new Error(`Snapshot 返回非 JSON：${text.slice(0, 500)}`); }
	const data = json?.data ?? json?.Data ?? json;
	const serverTimestamp = data?.serverTimestamp ?? data?.ServerTimestamp;
	if (!serverTimestamp) throw new Error(`Snapshot 返回缺少 serverTimestamp：${text.slice(0, 500)}`);
	const apiCode = json?.code ?? json?.Code;
	if (apiCode !== undefined && Number(apiCode) !== 0 && String(apiCode).toLowerCase() !== 'success') {
		throw new Error(`Snapshot 业务失败 code=${apiCode}: ${json?.msg ?? json?.message ?? ''}`);
	}
	return { elapsedMs, bytes: Buffer.byteLength(text), serverTimestamp, updateCount: (data?.updates ?? data?.Updates ?? []).length };
};

const percentile = (values, ratio) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
};

try {
	let sinceTimestamp;
	// 第一次请求建立 Published Binding Cache；后续预热均使用 sinceTimestamp 走增量热路径。
	const cold = await requestSnapshot();
	sinceTimestamp = cold.serverTimestamp;
	for (let index = 0; index < warmups; index += 1) {
		const warm = await requestSnapshot(sinceTimestamp);
		sinceTimestamp = warm.serverTimestamp;
	}

	const latencySamples = [];
	const payloadSamples = [];
	let totalUpdates = 0;
	for (let index = 0; index < samples; index += 1) {
		const sample = await requestSnapshot(sinceTimestamp);
		sinceTimestamp = sample.serverTimestamp;
		latencySamples.push(sample.elapsedMs);
		payloadSamples.push(sample.bytes);
		totalUpdates += sample.updateCount;
	}

	const avg = latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length;
	const p95 = percentile(latencySamples, 0.95);
	const max = Math.max(...latencySamples);
	const avgPayloadKb = payloadSamples.reduce((sum, value) => sum + value, 0) / payloadSamples.length / 1024;
	const summary = `samples=${samples}, warmups=${warmups}, avg=${avg.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${max.toFixed(2)}ms, avgPayload=${avgPayloadKb.toFixed(2)}KB, updates=${totalUpdates}, incremental=true`;
	if (p95 >= thresholdMs) {
		console.error(`Twin snapshot performance FAIL: ${summary}, threshold=${thresholdMs.toFixed(2)}ms`);
		process.exit(1);
	}
	console.info(`Twin snapshot performance PASS: ${summary}, threshold=${thresholdMs.toFixed(2)}ms`);
} catch (error) {
	console.error(`Twin snapshot performance FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
