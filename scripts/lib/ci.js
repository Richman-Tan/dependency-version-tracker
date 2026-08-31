/**
 * Host-CI adaptation. The extraction itself is plain Node and runs anywhere;
 * only two things differ between hosts — how a warning is annotated so it
 * surfaces in the run UI, and how a run links back to itself.
 *
 * GitHub Actions and Azure Pipelines are both recognised; anywhere else
 * (a laptop, another CI) degrades to plain text and no link.
 */

/** Format a warning in the host CI's annotation syntax. */
export function formatWarning(message, env = process.env) {
  if (env.GITHUB_ACTIONS) return `::warning::${message}`;
  if (env.TF_BUILD) return `##vso[task.logissue type=warning]${message}`;
  return `WARNING: ${message}`;
}

/** URL of the current run, or null when not running on a recognised CI. */
export function runUrl(env = process.env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  const collection = env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  if (collection && env.SYSTEM_TEAMPROJECT && env.BUILD_BUILDID) {
    // Project names routinely contain spaces, and the collection URI may or
    // may not carry a trailing slash depending on how it was configured.
    const base = collection.endsWith("/") ? collection : `${collection}/`;
    return `${base}${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}`;
  }
  return null;
}

/** Format a fatal error in the host CI's annotation syntax. */
export function formatError(message, env = process.env) {
  if (env.GITHUB_ACTIONS) return `::error::${message}`;
  if (env.TF_BUILD) return `##vso[task.logissue type=error]${message}`;
  return `ERROR: ${message}`;
}
