import { Session } from '/@/utils/storage';

const STATE_KEY = 'industrial.iot.oidc.state';
const VERIFIER_KEY = 'industrial.iot.oidc.verifier';
const RETURN_URL_KEY = 'industrial.iot.oidc.return-url';
const ACCESS_EXPIRES_KEY = 'industrial.iot.oidc.access-expires-at';
const SESSION_EXPIRES_KEY = 'industrial.iot.iam.session-expires-at';
const IAM_SESSION_SAFETY_MS = 7.5 * 60 * 60 * 1000;

function gatewayOrigin() {
	const configured = import.meta.env.VITE_IAM_AUTHORITY;
	if (configured) return configured.replace(/\/$/, '');
	return window.location.port === '27915' ? 'http://localhost:5202' : window.location.origin;
}

function redirectUri() {
	return import.meta.env.VITE_IAM_REDIRECT_URI || `${gatewayOrigin()}/iot/`;
}

function base64Url(bytes: Uint8Array) {
	let binary = '';
	bytes.forEach((b) => (binary += String.fromCharCode(b)));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBase64Url(byteLength = 32) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function sha256Base64Url(value: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return base64Url(new Uint8Array(digest));
}

export function hasOidcCallback() {
	const query = new URLSearchParams(window.location.search);
	return query.has('code') && query.has('state');
}

export async function establishIamSession(userName: string, password: string, tenant?: string) {
	const response = await fetch(new URL('/account/login', gatewayOrigin()), {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userName, password, tenant: tenant || null }),
	});
	if (!response.ok) {
		const result = await response.json().catch(() => ({}));
		throw new Error(result.error || 'IAM 用户名或密码错误。');
	}
	Session.set(SESSION_EXPIRES_KEY, Date.now() + IAM_SESSION_SAFETY_MS);
}

export async function beginOidcLogin(returnUrl = '/dashboard') {
	const state = randomBase64Url(24);
	const verifier = randomBase64Url(64);
	const challenge = await sha256Base64Url(verifier);
	Session.set(STATE_KEY, state);
	Session.set(VERIFIER_KEY, verifier);
	Session.set(RETURN_URL_KEY, returnUrl || '/dashboard');

	const url = new URL('/connect/authorize', gatewayOrigin());
	url.searchParams.set('client_id', import.meta.env.VITE_IAM_CLIENT_ID || 'industrial-iot-web');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', redirectUri());
	url.searchParams.set('scope', 'openid profile industrial-platform');
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	window.location.assign(url.toString());
}

export async function completeOidcLogin() {
	const query = new URLSearchParams(window.location.search);
	const code = query.get('code');
	const state = query.get('state');
	const expectedState = Session.get(STATE_KEY) as string | undefined;
	const verifier = Session.get(VERIFIER_KEY) as string | undefined;
	const returnUrl = (Session.get(RETURN_URL_KEY) as string | undefined) || '/dashboard';

	if (!code || !state || !expectedState || state !== expectedState || !verifier) {
		clearOidcTransientState();
		throw new Error('IAM 登录回调校验失败，请重新登录。');
	}

	const token = await exchangeToken({
		grant_type: 'authorization_code',
		client_id: import.meta.env.VITE_IAM_CLIENT_ID || 'industrial-iot-web',
		code,
		redirect_uri: redirectUri(),
		code_verifier: verifier,
	});

	Session.set('token', token.access_token);
	Session.set('iam_auth_mode', 'Centralized');
	Session.set(ACCESS_EXPIRES_KEY, Date.now() + Math.max(0, Number(token.expires_in || 0)) * 1000);
	clearOidcTransientState();
	window.history.replaceState({}, document.title, window.location.pathname);
	return safeReturnUrl(returnUrl);
}

export function isCentralAuthentication() {
	return Session.get('iam_auth_mode') === 'Centralized';
}

export function isCentralTokenNearExpiry(skewSeconds = 60) {
	if (!isCentralAuthentication()) return false;
	const expiresAt = Number(Session.get(ACCESS_EXPIRES_KEY) || 0);
	return expiresAt > 0 && expiresAt <= Date.now() + Math.max(0, skewSeconds) * 1000;
}

export function canSilentlyRenewIamSession() {
	if (!isCentralAuthentication()) return false;
	const expiresAt = Number(Session.get(SESSION_EXPIRES_KEY) || 0);
	return expiresAt > Date.now() + 60 * 1000;
}

export function currentReturnUrl() {
	const hash = window.location.hash || '#/dashboard';
	const value = hash.startsWith('#') ? hash.substring(1) : hash;
	return safeReturnUrl(value);
}

export function clearIamBrowserSession() {
	Session.remove('iam_auth_mode');
	Session.remove(ACCESS_EXPIRES_KEY);
	Session.remove(SESSION_EXPIRES_KEY);
	clearOidcTransientState();
	void endIamServerSession();
}

export async function logoutIamSession() {
	Session.remove('iam_auth_mode');
	Session.remove(ACCESS_EXPIRES_KEY);
	Session.remove(SESSION_EXPIRES_KEY);
	clearOidcTransientState();
	await endIamServerSession();
}

async function endIamServerSession() {
	try {
		await fetch(new URL('/account/logout', gatewayOrigin()), {
			method: 'POST',
			credentials: 'include',
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
	} catch {
		// Local browser credentials were already removed. IAM unavailability must not
		// reopen the local session or block the logout flow.
	}
}

function safeReturnUrl(value: string) {
	return value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

function clearOidcTransientState() {
	Session.remove(STATE_KEY);
	Session.remove(VERIFIER_KEY);
	Session.remove(RETURN_URL_KEY);
}

async function exchangeToken(values: Record<string, string>) {
	const response = await fetch(new URL('/connect/token', gatewayOrigin()), {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(values),
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok || !result.access_token)
		throw new Error(result.error_description || result.error || 'IAM Token 获取失败。');
	return result;
}
