import {
  type MediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";

export const zaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { image: 60 },
  capabilities: ["image"],
  defaultModels: { image: "glm-4.6v" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "zai",
};
