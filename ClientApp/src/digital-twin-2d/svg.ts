const dangerousContainer = /<(script|foreignObject|iframe|object|embed|link|meta)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;
const dangerousSelfClosing = /<(script|foreignObject|iframe|object|embed|link|meta)(\s[^>]*)?\/?\s*>/gi;
const eventAttribute = /\s+on[a-z][a-z0-9:_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const externalHref = /\s+(?:xlink:)?href\s*=\s*(?:"(?:https?:|\/\/|javascript:|data:)[^"]*"|'(?:https?:|\/\/|javascript:|data:)[^']*')/gi;
const externalUrl = /url\(\s*['"]?(?:https?:|\/\/|javascript:|data:)[^)]+\)/gi;
const cssImport = /@import\s+(?:url\()?\s*['"]?(?:https?:|\/\/|data:)[^;)}]+[;)}]?/gi;
const javascript = /javascript\s*:/gi;

export const sanitizeTwin2DSvg = (input: string) => {
	let value = String(input || '').trim();
	if (!value) return '';
	value = value.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
	value = value.replace(dangerousContainer, '').replace(dangerousSelfClosing, '');
	value = value.replace(eventAttribute, '').replace(externalHref, '').replace(externalUrl, 'none').replace(cssImport, '').replace(javascript, '');
	return value;
};

export const isSafeTwin2DSvg = (input: string) => {
	const sanitized = sanitizeTwin2DSvg(input);
	return Boolean(sanitized) && /<svg\b|<(g|path|rect|circle|ellipse|line|polyline|polygon|text)\b/i.test(sanitized);
};

export const extractTwin2DSvgBody = (input: string) => {
	const sanitized = sanitizeTwin2DSvg(input);
	const match = sanitized.match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i);
	return match ? match[1] : sanitized;
};
