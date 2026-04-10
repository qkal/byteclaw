import {
  type MediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";

export const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  capabilities: ["image"],
  defaultModels: { image: "auto" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "openrouter",
};
