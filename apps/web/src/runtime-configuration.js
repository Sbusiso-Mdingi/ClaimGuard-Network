export function injectRuntimeConfiguration(
  content,
  {
    apiBaseUrl = process.env.CLAIMGUARD_API_BASE_URL || "http://127.0.0.1:3004",
    clerkProxyUrl = String(process.env.CLERK_PROXY_URL || "").trim(),
    env = process.env,
  } = {},
) {
  const scriptString = (value) => JSON.stringify(String(value || "")).slice(1, -1);
  return content
    .replaceAll("__SENTRY_DSN_WEB__", scriptString(env.SENTRY_DSN_WEB || ""))
    .replaceAll("__NODE_ENV__", scriptString(env.NODE_ENV || "development"))
    .replaceAll("__CLAIMGUARD_RELEASE__", scriptString(env.CLAIMGUARD_RELEASE || ""))
    .replaceAll("__CLAIMGUARD_API_BASE_URL__", scriptString(apiBaseUrl))
    .replaceAll(
      "__PUBLIC_ORGANISATION_URL_SCHEME__",
      scriptString(env.PUBLIC_ORGANISATION_URL_SCHEME || "https"),
    )
    .replaceAll(
      "__PUBLIC_ORGANISATION_HOST__",
      scriptString(env.PUBLIC_ORGANISATION_HOST || "localhost:3002"),
    )
    .replaceAll(
      "__RUNTIME_CLERK_PUBLISHABLE_KEY__",
      scriptString(env.CLERK_PUBLISHABLE_KEY || ""),
    )
    .replaceAll("__RUNTIME_CLERK_PROXY_URL__", scriptString(clerkProxyUrl));
}
