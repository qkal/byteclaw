export const MOCK_OPENAI_RESPONSES_PROVIDER_ID = "mock-openai";

export function buildOpenAiResponsesTestModel(id = "gpt-5.4") {
  return {
    api: "openai-responses",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 4096,
    name: id,
    reasoning: false,
  } as const;
}

export function buildOpenAiResponsesProviderConfig(baseUrl: string, modelId = "gpt-5.4") {
  return {
    api: "openai-responses",
    apiKey: "test",
    baseUrl,
    models: [buildOpenAiResponsesTestModel(modelId)],
  } as const;
}

export function buildMockOpenAiResponsesProvider(baseUrl: string, modelId = "gpt-5.4") {
  return {
    config: buildOpenAiResponsesProviderConfig(baseUrl, modelId),
    modelId,
    modelRef: `${MOCK_OPENAI_RESPONSES_PROVIDER_ID}/${modelId}`,
    providerId: MOCK_OPENAI_RESPONSES_PROVIDER_ID,
  } as const;
}
