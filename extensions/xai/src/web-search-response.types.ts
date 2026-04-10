export interface XaiWebSearchResponse {
  output?: {
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
    }>;
  }[];
  output_text?: string;
  citations?: string[];
  inline_citations?: {
    start_index: number;
    end_index: number;
    url: string;
  }[];
}
