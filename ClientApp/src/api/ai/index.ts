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
	};
}
