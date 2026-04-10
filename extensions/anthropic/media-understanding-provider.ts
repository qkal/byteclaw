import {
  type MediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";

export const anthropicMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { image: 20 },
  capabilities: ["image"],
  defaultModels: { image: "claude-opus-4-6" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "anthropic",
  nativeDocumentInputs: ["pdf"],
};
