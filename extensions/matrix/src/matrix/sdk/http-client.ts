import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import { buildHttpError } from "./event-helpers.js";
import { type HttpMethod, type QueryParams, performMatrixRequest } from "./transport.js";

interface MatrixAuthedHttpClientParams {
  homeserver: string;
  accessToken: string;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}

export class MatrixAuthedHttpClient {
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly ssrfPolicy?: SsrFPolicy;
  private readonly dispatcherPolicy?: PinnedDispatcherPolicy;

  constructor(params: MatrixAuthedHttpClientParams) {
    this.homeserver = params.homeserver;
    this.accessToken = params.accessToken;
    this.ssrfPolicy = params.ssrfPolicy;
    this.dispatcherPolicy = params.dispatcherPolicy;
  }

  async requestJson(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<unknown> {
    const { response, text } = await performMatrixRequest({
      accessToken: this.accessToken,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
      body: params.body,
      dispatcherPolicy: this.dispatcherPolicy,
      endpoint: params.endpoint,
      homeserver: this.homeserver,
      method: params.method,
      qs: params.qs,
      ssrfPolicy: this.ssrfPolicy,
      timeoutMs: params.timeoutMs,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      if (!text.trim()) {
        return {};
      }
      return JSON.parse(text);
    }
    return text;
  }

  async requestRaw(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    timeoutMs: number;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<Buffer> {
    const { response, buffer } = await performMatrixRequest({
      accessToken: this.accessToken,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
      dispatcherPolicy: this.dispatcherPolicy,
      endpoint: params.endpoint,
      homeserver: this.homeserver,
      maxBytes: params.maxBytes,
      method: params.method,
      qs: params.qs,
      raw: true,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      timeoutMs: params.timeoutMs,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }
}
