/** projectId legado para wa-api (cloud-v2 usa UUID de proyecto BBC). */
export function buildBuilderBotProjectId(businessSlug: string): string {
  const normalized = businessSlug
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const base = normalized ? `IV-${normalized}` : 'IV-PROJECT';
  return base.slice(0, 64);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBuilderBotCloudProjectUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}
