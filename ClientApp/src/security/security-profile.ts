import { Session } from '/@/utils/storage';

export type AuthenticationMode = 'Local' | 'Centralized';

export interface SecurityProfile {
	authenticationMode: AuthenticationMode;
	authorizationMode: AuthenticationMode;
	localUserManagementMode: 'Enabled' | 'ReadOnly' | 'Hidden';
	centralMode: boolean;
	hasAuthenticationCenter: boolean;
	authority: string | null;
	systemCode: string;
}

const apiBaseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
let cachedProfile: SecurityProfile | null = null;
let pendingProfile: Promise<SecurityProfile> | null = null;

const securityProfileUrl = `${apiBaseURL}/security/local-user-management`;

const normalizeMode = (value: unknown, centralMode: boolean): AuthenticationMode => {
	const normalized = String(value || (centralMode ? 'Centralized' : '')).toLowerCase();
	if (normalized === 'centralized') return 'Centralized';
	if (normalized === 'local' && !centralMode) return 'Local';
	throw new Error(`后端返回了无效的认证模式：${value || 'Unknown'}`);
};

const normalizeAuthority = (value: unknown) => {
	if (!value) return null;
	try {
		const url = new URL(String(value));
		if (import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(url.hostname) && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) {
			url.hostname = window.location.hostname;
		}
		return url.toString().replace(/\/$/, '');
	} catch {
		return null;
	}
};

const rememberProfile = (profile: SecurityProfile) => {
	cachedProfile = profile;
	Session.set('configured_auth_mode', profile.authenticationMode);
	if (profile.authority) Session.set('iam_authority', profile.authority);
	else Session.remove('iam_authority');
	return profile;
};

export const getCachedSecurityProfile = () => cachedProfile;

export async function loadSecurityProfile(force = false): Promise<SecurityProfile> {
	if (!force && cachedProfile) return cachedProfile;
	if (!force && pendingProfile) return pendingProfile;

	pendingProfile = fetch(securityProfileUrl, {
		method: 'GET',
		headers: { Accept: 'application/json' },
		cache: 'no-store',
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`认证配置读取失败（HTTP ${response.status}）`);
			const data = await response.json();
			const centralMode = data?.centralMode === true;
			const authenticationMode = normalizeMode(data?.authenticationMode, centralMode);
			const authorizationMode = normalizeMode(data?.authorizationMode, false);
			const authority = normalizeAuthority(data?.authority);
			const profile: SecurityProfile = {
				authenticationMode,
				authorizationMode,
				localUserManagementMode: ['Enabled', 'ReadOnly', 'Hidden'].includes(data?.localUserManagementMode || data?.mode)
					? (data?.localUserManagementMode || data?.mode)
					: 'Hidden',
				centralMode: authenticationMode === 'Centralized',
				hasAuthenticationCenter: data?.hasAuthenticationCenter === true && Boolean(authority),
				authority,
				systemCode: String(data?.systemCode || ''),
			};
			if (profile.centralMode && !profile.hasAuthenticationCenter) {
				throw new Error('系统已配置为认证中心模式，但认证中心地址无效。');
			}
			return rememberProfile(profile);
		})
		.finally(() => {
			pendingProfile = null;
		});

	return pendingProfile;
}
