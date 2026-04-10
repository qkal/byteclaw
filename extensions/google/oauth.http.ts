import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { response, release } = await fetchWithSsrFGuard({
    init,
    timeoutMs,
    url,
  });
  try {
    const body = await response.arrayBuffer();
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } finally {
    await release();
  }
}
