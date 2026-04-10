import { fetchWithSsrFGuard } from "../../../api.js";

interface GuardedJsonApiRequestParams {
  url: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  allowNotFound?: boolean;
  allowedHostnames: string[];
  auditContext: string;
  errorPrefix: string;
}

export async function guardedJsonApiRequest<T = unknown>(
  params: GuardedJsonApiRequestParams,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    auditContext: params.auditContext,
    init: {
      body: params.body ? JSON.stringify(params.body) : undefined,
      headers: params.headers,
      method: params.method,
    },
    policy: { allowedHostnames: params.allowedHostnames },
    url: params.url,
  });

  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        return undefined as T;
      }
      const errorText = await response.text();
      throw new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  } finally {
    await release();
  }
}
