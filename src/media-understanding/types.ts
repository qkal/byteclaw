import type { ProviderRequestTransportOverrides } from "../agents/provider-request-config.js";

export type MediaUnderstandingKind =
  | "audio.transcription"
  | "video.description"
  | "image.description";

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export interface MediaAttachment {
  path?: string;
  url?: string;
  mime?: string;
  index: number;
  alreadyTranscribed?: boolean;
}

export interface MediaUnderstandingOutput {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
}

export type MediaUnderstandingDecisionOutcome =
  | "success"
  | "skipped"
  | "disabled"
  | "no-attachment"
  | "scope-deny";

export interface MediaUnderstandingModelDecision {
  provider?: string;
  model?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
}

export interface MediaUnderstandingAttachmentDecision {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[];
  chosen?: MediaUnderstandingModelDecision;
}

export interface MediaUnderstandingDecision {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
}

export interface AudioTranscriptionRequest {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export interface AudioTranscriptionResult {
  text: string;
  model?: string;
}

export interface VideoDescriptionRequest {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export interface VideoDescriptionResult {
  text: string;
  model?: string;
}

export interface ImageDescriptionRequest {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  agentDir: string;
  cfg: import("../config/config.js").OpenClawConfig;
  model: string;
  provider: string;
}

export interface ImagesDescriptionInput {
  buffer: Buffer;
  fileName: string;
  mime?: string;
}

export interface ImagesDescriptionRequest {
  images: ImagesDescriptionInput[];
  model: string;
  provider: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  agentDir: string;
  cfg: import("../config/config.js").OpenClawConfig;
}

export interface ImageDescriptionResult {
  text: string;
  model?: string;
}

export interface ImagesDescriptionResult {
  text: string;
  model?: string;
}

export interface MediaUnderstandingProvider {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: "pdf"[];
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
}
