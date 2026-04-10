export function createInternalHookEventPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
) {
  return {
    action,
    context,
    messages: [],
    sessionKey,
    timestamp: new Date(),
    type,
  };
}
