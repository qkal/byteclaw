export interface MSTeamsAttachmentLike {
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
}

export interface MSTeamsAccessTokenProvider {
  getAccessToken: (scope: string) => Promise<string>;
}

export interface MSTeamsInboundMedia {
  path: string;
  contentType?: string;
  placeholder: string;
}

export interface MSTeamsHtmlAttachmentSummary {
  htmlAttachments: number;
  imgTags: number;
  dataImages: number;
  cidImages: number;
  srcHosts: string[];
  attachmentTags: number;
  attachmentIds: string[];
}

export interface MSTeamsGraphMediaResult {
  media: MSTeamsInboundMedia[];
  hostedCount?: number;
  attachmentCount?: number;
  hostedStatus?: number;
  attachmentStatus?: number;
  messageUrl?: string;
  tokenError?: boolean;
}
