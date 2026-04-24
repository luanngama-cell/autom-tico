const LOVABLE_PROJECT_ID_REGEX =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function getExternalBaseUrl(origin?: string) {
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const rawOrigin = origin ?? fallbackOrigin;

  if (!rawOrigin) return "";

  try {
    const url = new URL(rawOrigin);
    const hostname = url.hostname;
    const projectId = hostname.match(LOVABLE_PROJECT_ID_REGEX)?.[1];
    const isPreviewHost = hostname.includes("preview--") || hostname.includes("-dev.lovable.app");

    if (projectId && isPreviewHost) {
      return `https://project--${projectId}.lovable.app`;
    }

    return url.origin;
  } catch {
    return rawOrigin;
  }
}

export function getBiSnapshotUrl(origin?: string) {
  const baseUrl = getExternalBaseUrl(origin);
  return baseUrl ? `${baseUrl}/api/public/bi/snapshot` : "/api/public/bi/snapshot";
}