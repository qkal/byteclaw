export interface WebhookResponsePayload {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}
