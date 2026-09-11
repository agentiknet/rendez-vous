import { deflateSync } from "node:zlib"

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

const CRC_TABLE = buildCrcTable()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    const index = (crc ^ byte) & 0xff
    const entry = CRC_TABLE[index]
    if (entry === undefined) {
      throw new Error(`crc table index out of range: ${index}`)
    }
    crc = entry ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii")
  const body = Buffer.concat([typeBytes, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 1-bit grayscale PNG: sample 0 renders black, sample 1 renders white. */
export function encodeMonochromePng(
  width: number,
  height: number,
  isBlack: (x: number, y: number) => boolean,
): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8)
  const raw = Buffer.alloc((bytesPerRow + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (bytesPerRow + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      if (isBlack(x, y)) continue
      const byteIndex = rowStart + 1 + Math.floor(x / 8)
      const bitIndex = 7 - (x % 8)
      const current = raw[byteIndex]
      if (current === undefined) {
        throw new Error(`png row byte index out of range: ${byteIndex}`)
      }
      raw[byteIndex] = current | (1 << bitIndex)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  const idat = deflateSync(raw)

  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}
