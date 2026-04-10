import { encodePngRgba, fillPixel } from "../media/png-encode.js";

const GLYPH_ROWS_5X7: Record<string, number[]> = {
  "0": [0b0_1110, 0b1_0001, 0b1_0011, 0b1_0101, 0b1_1001, 0b1_0001, 0b0_1110],
  "1": [0b0_0100, 0b0_1100, 0b0_0100, 0b0_0100, 0b0_0100, 0b0_0100, 0b0_1110],
  "2": [0b0_1110, 0b1_0001, 0b0_0001, 0b0_0010, 0b0_0100, 0b0_1000, 0b1_1111],
  "3": [0b1_1110, 0b0_0001, 0b0_0001, 0b0_1110, 0b0_0001, 0b0_0001, 0b1_1110],
  "4": [0b0_0010, 0b0_0110, 0b0_1010, 0b1_0010, 0b1_1111, 0b0_0010, 0b0_0010],
  "5": [0b1_1111, 0b1_0000, 0b1_1110, 0b0_0001, 0b0_0001, 0b1_0001, 0b0_1110],
  "6": [0b0_0110, 0b0_1000, 0b1_0000, 0b1_1110, 0b1_0001, 0b1_0001, 0b0_1110],
  "7": [0b1_1111, 0b0_0001, 0b0_0010, 0b0_0100, 0b0_1000, 0b0_1000, 0b0_1000],
  "8": [0b0_1110, 0b1_0001, 0b1_0001, 0b0_1110, 0b1_0001, 0b1_0001, 0b0_1110],
  "9": [0b0_1110, 0b1_0001, 0b1_0001, 0b0_1111, 0b0_0001, 0b0_0010, 0b0_1100],

  A: [0b0_1110, 0b1_0001, 0b1_0001, 0b1_1111, 0b1_0001, 0b1_0001, 0b1_0001],
  B: [0b1_1110, 0b1_0001, 0b1_0001, 0b1_1110, 0b1_0001, 0b1_0001, 0b1_1110],
  C: [0b0_1110, 0b1_0001, 0b1_0000, 0b1_0000, 0b1_0000, 0b1_0001, 0b0_1110],
  D: [0b1_1110, 0b1_0001, 0b1_0001, 0b1_0001, 0b1_0001, 0b1_0001, 0b1_1110],
  E: [0b1_1111, 0b1_0000, 0b1_0000, 0b1_1110, 0b1_0000, 0b1_0000, 0b1_1111],
  F: [0b1_1111, 0b1_0000, 0b1_0000, 0b1_1110, 0b1_0000, 0b1_0000, 0b1_0000],
  T: [0b1_1111, 0b0_0100, 0b0_0100, 0b0_0100, 0b0_0100, 0b0_0100, 0b0_0100],
};

function drawGlyph5x7(params: {
  buf: Buffer;
  width: number;
  x: number;
  y: number;
  char: string;
  scale: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const rows = GLYPH_ROWS_5X7[params.char];
  if (!rows) {
    return;
  }
  for (let row = 0; row < 7; row += 1) {
    const bits = rows[row] ?? 0;
    for (let col = 0; col < 5; col += 1) {
      const on = (bits & (1 << (4 - col))) !== 0;
      if (!on) {
        continue;
      }
      for (let dy = 0; dy < params.scale; dy += 1) {
        for (let dx = 0; dx < params.scale; dx += 1) {
          fillPixel(
            params.buf,
            params.x + col * params.scale + dx,
            params.y + row * params.scale + dy,
            params.width,
            params.color.r,
            params.color.g,
            params.color.b,
            params.color.a ?? 255,
          );
        }
      }
    }
  }
}

function drawText(params: {
  buf: Buffer;
  width: number;
  x: number;
  y: number;
  text: string;
  scale: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const text = params.text.toUpperCase();
  let cursorX = params.x;
  for (const raw of text) {
    const ch = raw in GLYPH_ROWS_5X7 ? raw : raw.toUpperCase();
    drawGlyph5x7({
      buf: params.buf,
      char: ch,
      color: params.color,
      scale: params.scale,
      width: params.width,
      x: cursorX,
      y: params.y,
    });
    cursorX += 6 * params.scale;
  }
}

function measureTextWidthPx(text: string, scale: number) {
  return text.length * 6 * scale - scale; // 5px glyph + 1px space
}

function fillRect(params: {
  buf: Buffer;
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const startX = Math.max(0, params.x);
  const startY = Math.max(0, params.y);
  const endX = Math.min(params.width, params.x + params.w);
  const endY = Math.min(params.height, params.y + params.h);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      fillPixel(
        params.buf,
        x,
        y,
        params.width,
        params.color.r,
        params.color.g,
        params.color.b,
        params.color.a ?? 255,
      );
    }
  }
}

function fillEllipse(params: {
  buf: Buffer;
  width: number;
  height: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  for (
    let y = Math.max(0, params.cy - params.ry);
    y <= Math.min(params.height - 1, params.cy + params.ry);
    y += 1
  ) {
    for (
      let x = Math.max(0, params.cx - params.rx);
      x <= Math.min(params.width - 1, params.cx + params.rx);
      x += 1
    ) {
      const dx = (x - params.cx) / params.rx;
      const dy = (y - params.cy) / params.ry;
      if (dx * dx + dy * dy <= 1) {
        fillPixel(
          params.buf,
          x,
          y,
          params.width,
          params.color.r,
          params.color.g,
          params.color.b,
          params.color.a ?? 255,
        );
      }
    }
  }
}

function fillTriangle(params: {
  buf: Buffer;
  width: number;
  height: number;
  a: { x: number; y: number };
  b: { x: number; y: number };
  c: { x: number; y: number };
  color: { r: number; g: number; b: number; a?: number };
}) {
  const minX = Math.max(0, Math.min(params.a.x, params.b.x, params.c.x));
  const maxX = Math.min(params.width - 1, Math.max(params.a.x, params.b.x, params.c.x));
  const minY = Math.max(0, Math.min(params.a.y, params.b.y, params.c.y));
  const maxY = Math.min(params.height - 1, Math.max(params.a.y, params.b.y, params.c.y));
  const area =
    (params.b.x - params.a.x) * (params.c.y - params.a.y) -
    (params.b.y - params.a.y) * (params.c.x - params.a.x);
  if (area === 0) {
    return;
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w0 =
        (params.b.x - params.a.x) * (y - params.a.y) - (params.b.y - params.a.y) * (x - params.a.x);
      const w1 =
        (params.c.x - params.b.x) * (y - params.b.y) - (params.c.y - params.b.y) * (x - params.b.x);
      const w2 =
        (params.a.x - params.c.x) * (y - params.c.y) - (params.a.y - params.c.y) * (x - params.c.x);
      if ((w0 <= 0 && w1 <= 0 && w2 <= 0) || (w0 >= 0 && w1 >= 0 && w2 >= 0)) {
        fillPixel(
          params.buf,
          x,
          y,
          params.width,
          params.color.r,
          params.color.g,
          params.color.b,
          params.color.a ?? 255,
        );
      }
    }
  }
}

export function renderCatNoncePngBase64(nonce: string): string {
  const top = "CAT";
  const bottom = nonce.toUpperCase();

  const scale = 12;
  const pad = 18;
  const gap = 18;

  const topWidth = measureTextWidthPx(top, scale);
  const bottomWidth = measureTextWidthPx(bottom, scale);
  const width = Math.max(topWidth, bottomWidth) + pad * 2;
  const height = pad * 2 + 7 * scale + gap + 7 * scale;

  const buf = Buffer.alloc(width * height * 4, 255);
  const black = { b: 0, g: 0, r: 0 };

  drawText({
    buf,
    color: black,
    scale,
    text: top,
    width,
    x: Math.floor((width - topWidth) / 2),
    y: pad,
  });

  drawText({
    buf,
    color: black,
    scale,
    text: bottom,
    width,
    x: Math.floor((width - bottomWidth) / 2),
    y: pad + 7 * scale + gap,
  });

  const png = encodePngRgba(buf, width, height);
  return png.toString("base64");
}

export function renderCatFacePngBase64(): string {
  const width = 256;
  const height = 256;
  const buf = Buffer.alloc(width * height * 4, 255);
  const outline = { b: 40, g: 40, r: 40 };
  const innerEar = { b: 193, g: 182, r: 245 };
  const nose = { b: 138, g: 102, r: 222 };
  const whisker = { b: 30, g: 30, r: 30 };

  fillTriangle({
    a: { x: 62, y: 86 },
    b: { x: 106, y: 18 },
    buf,
    c: { x: 136, y: 104 },
    color: outline,
    height,
    width,
  });
  fillTriangle({
    a: { x: 194, y: 86 },
    b: { x: 150, y: 18 },
    buf,
    c: { x: 120, y: 104 },
    color: outline,
    height,
    width,
  });
  fillTriangle({
    a: { x: 78, y: 82 },
    b: { x: 106, y: 38 },
    buf,
    c: { x: 122, y: 92 },
    color: innerEar,
    height,
    width,
  });
  fillTriangle({
    a: { x: 178, y: 82 },
    b: { x: 150, y: 38 },
    buf,
    c: { x: 134, y: 92 },
    color: innerEar,
    height,
    width,
  });
  fillEllipse({
    buf,
    color: outline,
    cx: 128,
    cy: 142,
    height,
    rx: 82,
    ry: 78,
    width,
  });
  fillEllipse({
    buf,
    color: { b: 255, g: 255, r: 255 },
    cx: 98,
    cy: 126,
    height,
    rx: 9,
    ry: 12,
    width,
  });
  fillEllipse({
    buf,
    color: { b: 255, g: 255, r: 255 },
    cx: 158,
    cy: 126,
    height,
    rx: 9,
    ry: 12,
    width,
  });
  fillEllipse({
    buf,
    color: { b: 255, g: 255, r: 255 },
    cx: 128,
    cy: 158,
    height,
    rx: 22,
    ry: 18,
    width,
  });
  fillTriangle({
    a: { x: 128, y: 150 },
    b: { x: 118, y: 164 },
    buf,
    c: { x: 138, y: 164 },
    color: nose,
    height,
    width,
  });
  fillRect({ buf, color: whisker, h: 16, height, w: 2, width, x: 127, y: 164 });
  fillRect({ buf, color: whisker, h: 2, height, w: 42, width, x: 74, y: 161 });
  fillRect({ buf, color: whisker, h: 2, height, w: 42, width, x: 140, y: 161 });
  fillRect({ buf, color: whisker, h: 2, height, w: 38, width, x: 76, y: 173 });
  fillRect({ buf, color: whisker, h: 2, height, w: 38, width, x: 142, y: 173 });
  fillRect({ buf, color: whisker, h: 2, height, w: 30, width, x: 85, y: 185 });
  fillRect({ buf, color: whisker, h: 2, height, w: 30, width, x: 141, y: 185 });
  drawText({
    buf,
    color: outline,
    scale: 10,
    text: "CAT",
    width,
    x: Math.floor((width - measureTextWidthPx("CAT", 10)) / 2),
    y: 212,
  });

  const png = encodePngRgba(buf, width, height);
  return png.toString("base64");
}
