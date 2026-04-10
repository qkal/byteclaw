declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export interface TextItem {
    str: string;
  }

  export interface TextMarkedContent {
    type?: string;
  }

  export interface TextContent {
    items: (TextItem | TextMarkedContent)[];
  }

  export interface Viewport {
    width: number;
    height: number;
  }

  export interface PDFPageProxy {
    getTextContent(): Promise<TextContent>;
    getViewport(params: { scale: number }): Viewport;
    render(params: { canvas: unknown; viewport: Viewport }): { promise: Promise<void> };
  }

  export interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
  }

  export function getDocument(params: { data: Uint8Array; disableWorker?: boolean }): {
    promise: Promise<PDFDocumentProxy>;
  };
}
