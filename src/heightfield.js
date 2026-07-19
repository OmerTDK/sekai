// heightfield.js — the baked equirect grid container (E1).
//
// Pure ESM, THREE-free (imports ONLY clamp from './util.js'), so BOTH the Node
// bake script (encode) AND the browser (decode) share one byte layout and one
// sampler. This module is the sampleHeight REPLACEMENT: an allocation-free
// bilinear read over a committed lat/long Uint16 height grid that is the single
// source of truth for terrain relief AND every sampleHeight(dir) caller.
//
// makeHeightField({width,height,hMin,hMax,heights,flow?,rivers?}) -> hf with:
//   hf.width/height/hMin/hMax                exposed
//   hf.sampleHeight(dir) -> number           allocation-free bilinear (u wraps,
//                                            v clamps at the poles), dequantized
//   hf.sampleFlow(dir)   -> 0..1             same over the flow grid; 0 if absent
//   hf.getRiverNetwork() -> {paths:[...]}    the traced river polylines
//   hf.hash()            -> uint32           determinism digest
//
//   encodeHeightField(hf) -> ArrayBuffer     LE binary (magic 'SKHF', version 1)
//   decodeHeightField(buf) -> hf             reconstructs a makeHeightField
//
// Equirect convention (shared with erosion.js's inverse-equirect fill):
//   theta = acos(clamp(y/r,-1,1)) in [0,PI]   (0 = +Y north pole, PI = south)
//   phi   = atan2(z,x) in [-PI,PI]
//   u = phi/(2PI)+0.5  (columns WRAP)     -> fx = u*width - 0.5   (texel centers)
//   v = theta/PI       (rows CLAMP)       -> fy = v*(height-1)    (poles at ends)
// A dir at grid cell (row r, col c)'s center samples exactly that cell's value.
//
// Determinism: no runtime RNG, no wall-clock reads. The committed .bin is loaded
// and never recomputed; encode/decode force little-endian so the file is
// byte-identical across machines regardless of host endianness.
import { clamp } from './util.js'

const INV_TWO_PI = 1 / (2 * Math.PI)
const INV_PI = 1 / Math.PI

// Magic 'SKHF' (Sekai HeightField) as bytes.
const MAGIC = [0x53, 0x4b, 0x48, 0x46] // S K H F
const VERSION = 1

/**
 * Build a heightfield container over a quantized Uint16 grid.
 * @param {{width:number,height:number,hMin:number,hMax:number,
 *          heights:Uint16Array, flow?:Uint16Array, rivers?:Array}} spec
 */
export function makeHeightField({ width, height, hMin, hMax, heights, flow, rivers }) {
  const W = width | 0
  const H = height | 0
  const range = hMax - hMin
  const paths = rivers || []

  // Shared bilinear over a Uint16 grid. Allocation-free: only scalar math, reads
  // `arr` in place, returns the interpolated raw value in [0,65535]. Columns wrap
  // (longitude seam), rows clamp (latitude poles). No object is created here.
  function bilinear(arr, dir) {
    const dx = dir.x
    const dy = dir.y
    const dz = dir.z
    let r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (r === 0) r = 1
    const ny = clamp(dy / r, -1, 1)
    const theta = Math.acos(ny) // [0, PI]
    const phi = Math.atan2(dz, dx) // [-PI, PI]
    const u = phi * INV_TWO_PI + 0.5 // [0, 1]
    const v = theta * INV_PI // [0, 1]
    const fx = u * W - 0.5
    const fy = v * (H - 1)
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const tx = fx - ix
    const ty = fy - iy
    // Columns WRAP into [0, W-1]. x1 is derived from the pre-wrap column.
    const x0 = ((ix % W) + W) % W
    const x1 = (((ix + 1) % W) + W) % W
    // Rows CLAMP into [0, H-1] — no v-wrap across the poles.
    const y0 = iy < 0 ? 0 : iy > H - 1 ? H - 1 : iy
    const y1p = y0 + 1
    const y1 = y1p > H - 1 ? H - 1 : y1p
    const r0 = y0 * W
    const r1 = y1 * W
    const h00 = arr[r0 + x0]
    const h10 = arr[r0 + x1]
    const h01 = arr[r1 + x0]
    const h11 = arr[r1 + x1]
    const top = h00 + (h10 - h00) * tx
    const bot = h01 + (h11 - h01) * tx
    return top + (bot - top) * ty
  }

  // Allocation-free grid sampleHeight — the analytic-sampler REPLACEMENT.
  function sampleHeight(dir) {
    return hMin + (bilinear(heights, dir) / 65535) * range
  }

  // Drainage/flow field in [0,1] (quantized over [0,1] at bake). 0 if no flow.
  function sampleFlow(dir) {
    if (!flow) return 0
    return bilinear(flow, dir) / 65535
  }

  const network = { paths }
  function getRiverNetwork() {
    return network
  }

  // Determinism digest: running u32 sum of all quantized heights, XOR the total
  // river node count shifted left by 1. Stable across encode/decode.
  function hash() {
    let sum = 0
    for (let i = 0; i < heights.length; i++) sum = (sum + heights[i]) >>> 0
    let nodeCount = 0
    for (let p = 0; p < paths.length; p++) nodeCount += paths[p].nodes.length / 3
    return (sum ^ (nodeCount << 1)) >>> 0
  }

  return {
    width: W,
    height: H,
    hMin,
    hMax,
    heights,
    flow,
    rivers: paths,
    sampleHeight,
    sampleFlow,
    getRiverNetwork,
    hash,
  }
}

// ---------------------------------------------------------------------------
// (De)serialization — little-endian, byte-identical across machines.
//
// Layout:
//   'SKHF' (4 bytes) | u32 version=1 | u32 width | u32 height |
//   f32 hMin | f32 hMax | u32 riverCount |
//   u16[width*height] heights |
//   per river: u32 nodeCount, nodeCount*(f32 x, f32 y, f32 z, f32 width), u8 order
//
// The u8 order byte carries the Strahler order in its low 7 bits and the
// mouthUnder flag in bit 7 (order is always small; this keeps the layout a
// single byte while letting mouthUnder round-trip). The flow grid is a bake-time
// intermediate and is NOT persisted — a decoded field's sampleFlow returns 0.
// ---------------------------------------------------------------------------

const HEADER_BYTES = 4 /*magic*/ + 4 /*version*/ + 4 /*width*/ + 4 /*height*/ + 4 /*hMin*/ + 4 /*hMax*/ + 4 /*riverCount*/

/** Serialize a heightfield to a fresh little-endian ArrayBuffer. */
export function encodeHeightField(hf) {
  const { width, height, hMin, hMax, heights } = hf
  const paths = hf.rivers || (hf.getRiverNetwork ? hf.getRiverNetwork().paths : []) || []

  let size = HEADER_BYTES + width * height * 2
  for (let p = 0; p < paths.length; p++) {
    const nodeCount = paths[p].widths ? paths[p].widths.length : paths[p].nodes.length / 3
    size += 4 + nodeCount * 16 + 1
  }

  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let o = 0
  dv.setUint8(o++, MAGIC[0])
  dv.setUint8(o++, MAGIC[1])
  dv.setUint8(o++, MAGIC[2])
  dv.setUint8(o++, MAGIC[3])
  dv.setUint32(o, VERSION, true)
  o += 4
  dv.setUint32(o, width, true)
  o += 4
  dv.setUint32(o, height, true)
  o += 4
  dv.setFloat32(o, hMin, true)
  o += 4
  dv.setFloat32(o, hMax, true)
  o += 4
  dv.setUint32(o, paths.length, true)
  o += 4

  for (let i = 0; i < heights.length; i++) {
    dv.setUint16(o, heights[i], true)
    o += 2
  }

  for (let p = 0; p < paths.length; p++) {
    const path = paths[p]
    const nodes = path.nodes
    const widths = path.widths
    const nodeCount = widths ? widths.length : nodes.length / 3
    dv.setUint32(o, nodeCount, true)
    o += 4
    for (let n = 0; n < nodeCount; n++) {
      dv.setFloat32(o, nodes[n * 3], true)
      o += 4
      dv.setFloat32(o, nodes[n * 3 + 1], true)
      o += 4
      dv.setFloat32(o, nodes[n * 3 + 2], true)
      o += 4
      dv.setFloat32(o, widths[n], true)
      o += 4
    }
    let orderByte = (path.order | 0) & 0x7f
    if (path.mouthUnder) orderByte |= 0x80
    dv.setUint8(o++, orderByte)
  }

  return buf
}

// Accept an ArrayBuffer, a TypedArray, or a Node Buffer (a Uint8Array view).
function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf
  if (ArrayBuffer.isView(buf)) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  throw new Error('decodeHeightField: expected ArrayBuffer or TypedArray')
}

/** Deserialize a heightfield from a little-endian buffer. */
export function decodeHeightField(buf) {
  const dv = new DataView(toArrayBuffer(buf))
  let o = 0
  const m0 = dv.getUint8(o++)
  const m1 = dv.getUint8(o++)
  const m2 = dv.getUint8(o++)
  const m3 = dv.getUint8(o++)
  if (m0 !== MAGIC[0] || m1 !== MAGIC[1] || m2 !== MAGIC[2] || m3 !== MAGIC[3]) {
    throw new Error('decodeHeightField: bad magic (expected SKHF)')
  }
  const version = dv.getUint32(o, true)
  o += 4
  if (version !== VERSION) {
    throw new Error('decodeHeightField: unsupported version ' + version)
  }
  const width = dv.getUint32(o, true)
  o += 4
  const height = dv.getUint32(o, true)
  o += 4
  const hMin = dv.getFloat32(o, true)
  o += 4
  const hMax = dv.getFloat32(o, true)
  o += 4
  const riverCount = dv.getUint32(o, true)
  o += 4

  const n = width * height
  const heights = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    heights[i] = dv.getUint16(o, true)
    o += 2
  }

  const rivers = new Array(riverCount)
  for (let r = 0; r < riverCount; r++) {
    const nodeCount = dv.getUint32(o, true)
    o += 4
    const nodes = new Float32Array(nodeCount * 3)
    const widths = new Float32Array(nodeCount)
    for (let k = 0; k < nodeCount; k++) {
      nodes[k * 3] = dv.getFloat32(o, true)
      o += 4
      nodes[k * 3 + 1] = dv.getFloat32(o, true)
      o += 4
      nodes[k * 3 + 2] = dv.getFloat32(o, true)
      o += 4
      widths[k] = dv.getFloat32(o, true)
      o += 4
    }
    const orderByte = dv.getUint8(o++)
    rivers[r] = {
      nodes,
      widths,
      order: orderByte & 0x7f,
      mouthUnder: (orderByte & 0x80) !== 0,
    }
  }

  return makeHeightField({ width, height, hMin, hMax, heights, rivers })
}
