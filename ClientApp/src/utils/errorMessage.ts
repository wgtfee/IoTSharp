/** 兼容平台业务错误、Axios 错误和普通异常，不让错误提示本身再次抛错。 */
export function errorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
	if (typeof error === 'string' && error.trim()) return error;
	if (!error || typeof error !== 'object') return fallback;
	const value = error as Record<string, unknown>;
	const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : undefined;
	const data = response?.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : undefined;
	for (const message of [data?.msg, data?.message, value.msg, value.message, response?.statusText]) {
		if (typeof message === 'string' && message.trim()) return message;
	}
	return fallback;
}
