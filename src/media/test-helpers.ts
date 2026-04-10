export function createPngBufferWithDimensions(params: { width: number; height: number }): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrLength = Buffer.from([0x00, 0x00, 0x00, 0x0D]);
  const ihdrType = Buffer.from("IHDR", "ascii");
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(params.width, 0);
  ihdrData.writeUInt32BE(params.height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const ihdrCrc = Buffer.alloc(4);
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
  return Buffer.concat([signature, ihdrLength, ihdrType, ihdrData, ihdrCrc, iend]);
}

export function createJpegBufferWithDimensions(params: { width: number; height: number }): Buffer {
  if (params.width > 0xFF_FF || params.height > 0xFF_FF) {
    throw new Error("Synthetic JPEG helper only supports 16-bit dimensions");
  }

  const app0 = Buffer.from([
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof0 = Buffer.from([
    0xFF,
    0xC0,
    0x00,
    0x11,
    0x08,
    params.height >> 8,
    params.height & 0xFF,
    params.width >> 8,
    params.width & 0xFF,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  const sos = Buffer.from([
    0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, sof0, sos, Buffer.from([0xFF, 0xD9])]);
}
