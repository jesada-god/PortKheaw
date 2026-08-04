/** Read-only deployment evidence. Contains no configuration or credential data. */
export const dynamic = 'force-dynamic';

function deploymentSha(): string {
  const value = process.env.PORTKHEAW_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown';
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : 'unknown';
}

function deploymentBuildTime(): string | null {
  const value = process.env.PORTKHEAW_BUILD_TIME;
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export async function GET(): Promise<Response> {
  return Response.json(
    { commitSha: deploymentSha(), buildTime: deploymentBuildTime() },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
