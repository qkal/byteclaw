declare module "@napi-rs/canvas" {
  export interface Canvas {
    toBuffer(type?: string): Buffer;
  }

  export function createCanvas(width: number, height: number): Canvas;
}
