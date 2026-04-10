declare module "@create-markdown/preview" {
  export interface PreviewThemeOptions {
    sanitize?: ((html: string) => string) | undefined;
  }

  export function applyPreviewTheme(html: string, options?: PreviewThemeOptions): string;
}
