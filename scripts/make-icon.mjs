// Node CLI: writes build/icon.png, a 1024x1024 procedural planet on a deep
// space background, for electron-builder to convert into the packaged app's
// .icns (see mac.icon in electron-builder.yml). Zero npm dependencies — only
// node:zlib (for the PNG IDAT deflate stream) and node:fs — matching the
// codebase's node-builtins-only ethos for build/server tooling.
//
// Usage (from the repo root, so 'build/icon.png' resolves correctly):
//   node scripts/make-icon.mjs
//   npm run icon
//
// Fully deterministic: every pixel is a closed-form function of its (x, y)
// coordinates and a handful of hardcoded constants below — no Math.random,
// no Date.now, no external input. Running this twice produces byte-identical
// output, so it's safe (and cheap) to run on every pack/dist build.
import zlib from 'node:zlib'
import fs from 'node:fs'

const W = 1024
const H = 1024
const CX = W / 2
const CY = H / 2
const R = 400 // planet radius in pixels

const SPACE = [4, 6, 12]
const OCEAN = [30, 90, 150]
const LAND = [70, 130, 60]
const ATMOSPHERE = [120, 180, 255]

// Fixed landmass blobs: each contributes a gaussian "how much land here"
// weight, hardcoded (not random) so the icon is reproducible across builds.
const BLOBS = [
  { cx: 430, cy: 470, r: 120 },
  { cx: 600, cy: 560, r: 140 },
  { cx: 520, cy: 660, r: 90 },
]

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// Standard smoothstep: 0 below edge0, 1 above edge1, cubic ease between.
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

// Computes the final (r, g, b) for one pixel: space background, ocean/land
// planet disc with a day-light gradient, then an atmosphere rim blended on
// top near the planet's edge.
function shadePixel(x, y) {
  let r = SPACE[0]
  let g = SPACE[1]
  let b = SPACE[2]

  const dx = x - CX
  const dy = y - CY
  const d = Math.hypot(dx, dy)

  if (d <= R) {
    r = OCEAN[0]
    g = OCEAN[1]
    b = OCEAN[2]

    // Landmass: blend toward land green by the summed gaussian weight of
    // every blob, capped at 1 so overlapping blobs don't overshoot.
    let landWeight = 0
    for (const blob of BLOBS) {
      const bdx = x - blob.cx
      const bdy = y - blob.cy
      landWeight += Math.exp(-(bdx * bdx + bdy * bdy) / (2 * blob.r * blob.r))
    }
    const landT = Math.min(1, landWeight)
    r = lerp(r, LAND[0], landT)
    g = lerp(g, LAND[1], landT)
    b = lerp(b, LAND[2], landT)

    // Day-light gradient: top-left limb lit, lower-right terminator dark.
    const light = 0.55 + 0.45 * clamp((-dx - dy) / (1.4 * R) + 0.5, 0, 1)
    r *= light
    g *= light
    b *= light
  }

  // Atmosphere rim: a smoothstep bump that rises from R-6 to R and falls
  // back from R to R+16, peaking (weight 1) exactly at the planet's edge.
  if (d >= R - 6 && d <= R + 16) {
    const rise = smoothstep(R - 6, R, d)
    const fall = 1 - smoothstep(R, R + 16, d)
    const w = rise * fall
    r = lerp(r, ATMOSPHERE[0], w)
    g = lerp(g, ATMOSPHERE[1], w)
    b = lerp(b, ATMOSPHERE[2], w)
  }

  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)]
}

function buildRgba() {
  const rgba = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4
      const [r, g, b] = shadePixel(x, y)
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = 255
    }
  }
  return rgba
}

// Prepends a 0x00 (filter type "None") byte to every scanline, the raw
// pixel layout zlib.deflateSync compresses into a PNG IDAT stream.
function toRawScanlines(rgba) {
  const rowBytes = W * 4
  const raw = Buffer.alloc(H * (1 + rowBytes))
  for (let y = 0; y < H; y++) {
    const rawOffset = y * (1 + rowBytes)
    raw[rawOffset] = 0 // filter type: None
    rgba.copy(raw, rawOffset + 1, y * rowBytes, y * rowBytes + rowBytes)
  }
  return raw
}

// Standard PNG/zlib CRC-32 (polynomial 0xEDB88320), computed once as a
// 256-entry lookup table.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// One PNG chunk: 4-byte big-endian length, 4-byte ASCII type, data, then a
// 4-byte big-endian CRC-32 over (type + data).
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function encodePng(rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(W, 0)
  ihdrData.writeUInt32BE(H, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0 // compression method
  ihdrData[11] = 0 // filter method
  ihdrData[12] = 0 // interlace method

  const idatData = zlib.deflateSync(toRawScanlines(rgba))

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const rgba = buildRgba()
const png = encodePng(rgba)

fs.mkdirSync('build', { recursive: true })
fs.writeFileSync('build/icon.png', png)

console.log(`[make-icon] wrote build/icon.png (${W}x${H}, ${png.length} bytes)`)
