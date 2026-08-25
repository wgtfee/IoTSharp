import request from '/@/utils/request';

export interface AiMcpSettings {
	name: string;
	enable: boolean;
	mcpApiKey: string;
}

export interface SaveAiMcpSettings {
	name: string;
	enable: boolean;
	regenerateApiKey?: boolean;
}

export type AiSettingsScope = 'customer' | 'tenant';

export interface McpToolDefinition {
	id: string;
	name: string;
	title: string;
	description: string;
	handlerType: 'HttpApi';
	inputSchemaJson: string;
	httpMethod: string;
	endpointTemplate: string;
	hasProtectedHeaders: boolean;
	timeoutSeconds: number;
	enabled: boolean;
	readOnlyHint: boolean;
	allowPrivateNetwork: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SaveMcpToolDefinition {
	name: string;
	title: string;
	description: string;
	handlerType: 'HttpApi';
	inputSchemaJson: string;
	httpMethod: string;
	endpointTemplate: string;
	headersJson?: string | null;
	timeoutSeconds: number;
	enabled: boolean;
	readOnlyHint: boolean;
	allowPrivateNetwork: boolean;
}

export interface McpToolExecutionResult {
	succeeded: boolean;
	statusCode?: number;
	durationMs: number;
	contentType?: string;
	body?: string;
	errorMessage?: string;
}

export interface McpToolInvocation {
	id: string;
	toolName: string;
	invocationSource: string;
	argumentKeys: string;
	startedAt: string;
	durationMs: number;
	succeeded: boolean;
	statusCode?: number;
	responseSize: number;
	errorMessage?: string;
}

const normalizeSettings = (value: any): AiMcpSettings => ({
	name: value?.name || '',
	enable: value?.enable !== false,
	mcpApiKey: value?.mcpApiKey || value?.mcP_API_KEY || value?.MCP_API_KEY || '',
});

export function aiApi() {
	const settingsUrl = (scope: AiSettingsScope, scopeId: string) => scope === 'tenant'
		? `/api/Tenants/${scopeId}/ai`
		: `/api/Customers/${scopeId}/ai`;

	return {
		async getSettings(scope: AiSettingsScope, scopeId: string): Promise<AiMcpSettings> {
			const response: any = await request({ url: settingsUrl(scope, scopeId), method: 'get' });
			return normalizeSettings(response.data);
		},
		async saveSettings(scope: AiSettingsScope, scopeId: string, payload: SaveAiMcpSettings): Promise<AiMcpSettings> {
			const response: any = await request({ url: settingsUrl(scope, scopeId), method: 'post', data: payload });
			return normalizeSettings(response.data);
		},
		async getTools(scope: AiSettingsScope, scopeId: string): Promise<McpToolDefinition[]> {
			const response: any = await request({ url: `/api/mcp-tools/${scope}/${scopeId}`, method: 'get' });
			return response.data || [];
		},
		async createTool(scope: AiSettingsScope, scopeId: string, payload: SaveMcpToolDefinition): Promise<McpToolDefinition> {
			const response: any = await request({ url: `/api/mcp-tools/${scope}/${scopeId}`, method: 'post', data: payload });
			return response.data;
		},
		async updateTool(scope: AiSettingsScope, scopeId: string, id: string, payload: SaveMcpToolDefinition): Promise<McpToolDefinition> {
			const response: any = await request({ url: `/api/mcp-tools/${scope}/${scopeId}/${id}`, method: 'put', data: payload });
			return response.data;
		},
		async deleteTool(scope: AiSettingsScope, scopeId: string, id: string): Promise<void> {
			await request({ url: `/api/mcp-tools/${scope}/${scopeId}/${id}`, method: 'delete' });
		},
		async testTool(scope: AiSettingsScope, scopeId: string, id: string, argumentsValue: Record<string, unknown>): Promise<McpToolExecutionResult> {
			const response: any = await request({
				url: `/api/mcp-tools/${scope}/${scopeId}/${id}/test`,
				method: 'post',
				data: { arguments: argumentsValue },
			});
			return response.data;
		},
		async getToolInvocations(scope: AiSettingsScope, scopeId: string, id: string): Promise<McpToolInvocation[]> {
			const response: any = await request({ url: `/api/mcp-tools/${scope}/${scopeId}/${id}/invocations`, method: 'get' });
			return response.data || [];
		},
	};
}
