import {
  type MediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { image: 40 },
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "minimax",
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { image: 50 },
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "minimax-portal",
};
