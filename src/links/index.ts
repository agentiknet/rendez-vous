import qrcode from "qrcode-generator"
import { normalizeCode } from "../rooms/code.ts"
import { encodeMonochromePng } from "./png.ts"

export interface JoinLinkOptions {
  publicUrl: string
  whatsappNumber: string | undefined
  telegramBot: string | undefined
  smsNumber: string | undefined
}

export interface JoinLinks {
  web: string
  whatsapp: string | undefined
  telegram: string | undefined
  sms: string | undefined
}

export function joinLinks(code: string, opts: JoinLinkOptions): JoinLinks {
  const normalized = normalizeCode(code)
  if (normalized === undefined) {
    throw new Error(`invalid room code: "${code}"`)
  }
  return {
    web: `${opts.publicUrl}/r/${normalized}`,
    whatsapp:
      opts.whatsappNumber === undefined
        ? undefined
        : `https://wa.me/${opts.whatsappNumber}?text=${encodeURIComponent(`join ${normalized}`)}`,
    telegram: opts.telegramBot === undefined ? undefined : `https://t.me/${opts.telegramBot}?start=${normalized}`,
    // `?&body=` (not `?body=`) prefills the message body on both iOS and
    // Android — `?body=` alone is silently dropped on iOS (docs/AGENTPUSH.md §9.5).
    sms:
      opts.smsNumber === undefined
        ? undefined
        : `sms:+${opts.smsNumber}?&body=${encodeURIComponent(`join ${normalized}`)}`,
  }
}

const QUIET_ZONE = 4
const PNG_SCALE = 8

function buildMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M")
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const matrix: boolean[][] = []
  for (let row = 0; row < size; row++) {
    const line: boolean[] = []
    for (let col = 0; col < size; col++) {
      line.push(qr.isDark(row, col))
    }
    matrix.push(line)
  }
  return matrix
}

function moduleAt(matrix: readonly (readonly boolean[])[], row: number, col: number): boolean {
  const line = matrix[row]
  if (line === undefined) return false
  const value = line[col]
  return value === undefined ? false : value
}

export function qrSvg(text: string): string {
  const matrix = buildMatrix(text)
  const size = matrix.length
  const dimension = size + QUIET_ZONE * 2
  const cells: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (moduleAt(matrix, row, col)) {
        cells.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`)
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>` +
    `<path d="${cells.join("")}" fill="#000000"/>` +
    `</svg>`
  )
}

export async function qrPng(text: string): Promise<Uint8Array> {
  const matrix = buildMatrix(text)
  const size = matrix.length
  const dimension = (size + QUIET_ZONE * 2) * PNG_SCALE
  return encodeMonochromePng(dimension, dimension, (x, y) => {
    const row = Math.floor(y / PNG_SCALE) - QUIET_ZONE
    const col = Math.floor(x / PNG_SCALE) - QUIET_ZONE
    if (row < 0 || col < 0 || row >= size || col >= size) return false
    return moduleAt(matrix, row, col)
  })
}
