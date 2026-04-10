import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { expandTilde } from "./platform.js";

// Canonical media tags. `qqmedia` is the generic auto-routing tag.
const VALID_TAGS = ["qqimg", "qqvoice", "qqvideo", "qqfile", "qqmedia"] as const;

// Lowercased aliases that should normalize to the canonical tag set.
const TAG_ALIASES: Record<string, (typeof VALID_TAGS)[number]> = {
  attach: "qqmedia",
  attachment: "qqmedia",
  audio: "qqvoice",
  doc: "qqfile",
  document: "qqfile",
  file: "qqfile",
  image: "qqimg",
  img: "qqimg",
  media: "qqmedia",
  photo: "qqimg",
  pic: "qqimg",
  picture: "qqimg",
  qq_attachment: "qqmedia",
  qq_audio: "qqvoice",
  qq_doc: "qqfile",
  qq_file: "qqfile",
  qq_image: "qqimg",
  qq_img: "qqimg",
  qq_media: "qqmedia",
  qq_photo: "qqimg",
  qq_pic: "qqimg",
  qq_picture: "qqimg",
  qq_send: "qqmedia",
  qq_video: "qqvideo",
  qq_voice: "qqvoice",
  qqattachment: "qqmedia",
  qqaudio: "qqvoice",
  qqdoc: "qqfile",
  qqimage: "qqimg",
  qqphoto: "qqimg",
  qqpic: "qqimg",
  qqpicture: "qqimg",
  qqsend: "qqmedia",
  send: "qqmedia",
  video: "qqvideo",
  voice: "qqvoice",
};

const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

const LEFT_BRACKET = "(?:[<＜<]|&lt;)";
const RIGHT_BRACKET = "(?:[>＞>]|&gt;)";
/** Match self-closing media-tag syntax with file/src/path/url attributes. */
export const SELF_CLOSING_TAG_REGEX = new RegExp(
  "`?" +
    LEFT_BRACKET +
    String.raw`\s*(` +
    TAG_NAME_PATTERN +
    ")" +
    String.raw`(?:\s+(?!file|src|path|url)[a-z_-]+\s*=\s*["']?[^"'\s＜<>＞>]*?["']?)*` +
    String.raw`\s+(?:file|src|path|url)\s*=\s*` +
    "[\"']?" +
    String.raw`([^"'\s>＞]+?)` +
    "[\"']?" +
    String.raw`(?:\s+[a-z_-]+\s*=\s*["']?[^"'\s＜<>＞>]*?["']?)*` +
    String.raw`\s*/?` +
    String.raw`\s*` +
    RIGHT_BRACKET +
    "`?",
  "gi",
);

/** Match malformed wrapped media tags that should be normalized. */
export const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  "`?" +
    LEFT_BRACKET +
    String.raw`\s*(` +
    TAG_NAME_PATTERN +
    String.raw`)\s*` +
    RIGHT_BRACKET +
    String.raw`["']?\s*` +
    "([^<＜<＞>\"'`]+?)" +
    String.raw`\s*["']?` +
    LEFT_BRACKET +
    String.raw`\s*/?\s*(?:` +
    TAG_NAME_PATTERN +
    String.raw`)\s*` +
    RIGHT_BRACKET +
    "`?",
  "gi",
);

/** Normalize a raw tag name into the canonical tag set. */
function resolveTagName(raw: string): (typeof VALID_TAGS)[number] {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as (typeof VALID_TAGS)[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

/** Match wrapped tags whose bodies need newline and tab cleanup. */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "(" +
    LEFT_BRACKET +
    String.raw`\s*(?:` +
    TAG_NAME_PATTERN +
    String.raw`)\s*` +
    RIGHT_BRACKET +
    ")" +
    String.raw`([\s\S]*?)` +
    "(" +
    LEFT_BRACKET +
    String.raw`\s*/?\s*(?:` +
    TAG_NAME_PATTERN +
    String.raw`)\s*` +
    RIGHT_BRACKET +
    ")",
  "gi",
);

/** Normalize malformed media-tag output into canonical wrapped tags. */
export function normalizeMediaTags(text: string): string {
  let cleaned = text.replace(SELF_CLOSING_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) {
      return _match;
    }
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });

  cleaned = cleaned.replace(
    MULTILINE_TAG_CLEANUP,
    (_m, open: string, body: string, close: string) => {
      const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
      return open + flat + close;
    },
  );

  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) {
      return _match;
    }
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });
}
