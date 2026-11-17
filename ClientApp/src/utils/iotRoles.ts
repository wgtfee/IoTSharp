/**
 * Identity roles arrive as a comma-delimited string from Account/MyInfo.
 * The admin/common aliases only support legacy client-side route metadata.
 * They do NOT confer backend permissions, which are always evaluated server-side.
 */
export function normalizeIoTUserRoles(raw: unknown): string[] {
    const values = (Array.isArray(raw) ? raw : [raw])
        .flatMap(value => typeof value === 'string' ? value.split(/[,;]/) : [])
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    // Never trust legacy UI-only aliases from a cached session as role grants.
    const roles = new Set(values.filter(role => role !== 'admin' && role !== 'common'));
    if (roles.has('systemadmin')) roles.add('admin');
    if (roles.size > 0) roles.add('common');
    return Array.from(roles);
}
