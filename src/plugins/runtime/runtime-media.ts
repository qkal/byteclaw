import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { getImageMetadata, resizeToJpeg } from "../../media/image-ops.js";
import { detectMime } from "../../media/mime.js";
import { loadWebMedia } from "../../media/web-media.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeMedia(): PluginRuntime["media"] {
  return {
    detectMime,
    getImageMetadata,
    isVoiceCompatibleAudio,
    loadWebMedia,
    mediaKindFromMime,
    resizeToJpeg,
  };
}
