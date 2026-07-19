// Plain node test script for the E1 baked heightfield container — no test
// framework, no extra deps (mirrors tests/geometry.test.mjs). Run with:
//   node tests/heightfield.test.mjs   (from the repo root so the relative
//   src/ import resolves; heightfield.js is THREE-free so this needs no bundle).
//
// Covers: (1) allocation-free bilinear sampleHeight — texel centers return the
// stored value and midpoints interpolate (literal 4x2 poles+equator grid, plus
// a 4x3 grid whose interior equator row lets per-column bilinear + longitude
// wrap be asserted cleanly — a 4x2's two rows are BOTH poles, where column
// sampling is degenerate); (2) encode->decode round-trips heights and rivers
// (incl. per-node xyz/width, Strahler order, and mouthUnder) exactly, is
// byte-stable, and drops the non-persisted flow grid (sampleFlow -> 0).
import assert from 'node:assert'
import { makeHeightField, encodeHeightField, decodeHeightField } from '../src/heightfield.js'

let assertionCount = 0
function ok(cond, msg) {
  assertionCount++
  assert.ok(cond, msg)
}
function approx(a, b, msg, eps = 1e-9) {
  assertionCount++
  assert.ok(Math.abs(a - b) <= eps, msg + ' (got ' + a + ', want ' + b + ', |d|=' + Math.abs(a - b) + ')')
}

// Texel-center unit dir for grid cell (row r, col c), matching heightfield.js's
// equirect inverse (and erosion.js's fill convention): u=(c+0.5)/W, v=r/(H-1).
function dirForCell(r, c, W, H) {
  return dirForUV((c + 0.5) / W, H > 1 ? r / (H - 1) : 0)
}
function dirForUV(u, v) {
  const phi = (u - 0.5) * 2 * Math.PI
  const theta = v * Math.PI
  const st = Math.sin(theta)
  return { x: st * Math.cos(phi), y: Math.cos(theta), z: st * Math.sin(phi) }
}

const H_MIN = 0.5
const H_MAX = 1.5 // both exact in f32 so encode/decode round-trip is bit-exact
const RANGE = H_MAX - H_MIN
const deq = (u16) => H_MIN + (u16 / 65535) * RANGE

// ---------------------------------------------------------------------------
// (1a) Literal 4x2 grid: rows are the two poles. Uniform rows let us assert
// texel-center exactness at the poles and midpoint interpolation at the equator
// — exactly the "texel centers equal the stored value, midpoints interpolate"
// contract, on the spec's tiny 4x2 grid.
// ---------------------------------------------------------------------------
{
  const W = 4
  const H = 2
  const A = 10000 // uniform north row (v=0)
  const B = 55000 // uniform south row (v=1)
  const heights = new Uint16Array([A, A, A, A, B, B, B, B])
  const hf = makeHeightField({ width: W, height: H, hMin: H_MIN, hMax: H_MAX, heights })

  ok(hf.width === 4 && hf.height === 2, '4x2: width/height exposed')
  ok(hf.hMin === H_MIN && hf.hMax === H_MAX, '4x2: hMin/hMax exposed')

  // North pole (+Y) -> row 0; south pole (-Y) -> row 1. Rows uniform, so the
  // column blend at the pole collapses to the row's stored value.
  approx(hf.sampleHeight({ x: 0, y: 1, z: 0 }), deq(A), '4x2: north pole == stored north value')
  approx(hf.sampleHeight({ x: 0, y: -1, z: 0 }), deq(B), '4x2: south pole == stored south value')

  // Equator (v=0.5): halfway between the two rows -> midpoint interpolation.
  const eqMid = deq((A + B) / 2) // rows uniform, so bilinear q = (A+B)/2
  approx(hf.sampleHeight({ x: 1, y: 0, z: 0 }), eqMid, '4x2: equator interpolates rows')
  approx(hf.sampleHeight({ x: 0, y: 0, z: 1 }), eqMid, '4x2: equator interpolates rows (+Z)')
  approx(hf.sampleHeight({ x: -1, y: 0, z: 0 }), eqMid, '4x2: equator interpolates rows (-X seam)')
}

// ---------------------------------------------------------------------------
// (1b) 4x3 grid: the interior row r=1 is the equator (NOT a pole), so per-column
// texel centers, column midpoints, and the longitude wrap seam sample cleanly.
// Distinct values everywhere catch index/transpose bugs.
// ---------------------------------------------------------------------------
{
  const W = 4
  const H = 3
  // row 0 (north pole), row 1 (equator), row 2 (south pole)
  const heights = new Uint16Array([
    1000, 2000, 3000, 4000, // r0
    10000, 20000, 30000, 40000, // r1 (equator)
    50000, 52000, 54000, 56000, // r2
  ])
  const idx = (r, c) => r * W + c
  const hf = makeHeightField({ width: W, height: H, hMin: H_MIN, hMax: H_MAX, heights })

  // Texel-center exactness along the interior equator row (clean tx=0, ty≈0).
  for (let c = 0; c < W; c++) {
    approx(
      hf.sampleHeight(dirForCell(1, c, W, H)),
      deq(heights[idx(1, c)]),
      '4x3: equator texel center col ' + c + ' == stored',
    )
  }

  // Column midpoints on the equator interpolate adjacent columns.
  for (let c = 0; c < W - 1; c++) {
    const mid = dirForUV((c + 1) / W, 0.5) // u=(c+1)/W -> fx=c+0.5 -> tx=0.5
    approx(
      hf.sampleHeight(mid),
      deq((heights[idx(1, c)] + heights[idx(1, c + 1)]) / 2),
      '4x3: equator column midpoint ' + c + '->' + (c + 1) + ' interpolates',
    )
  }

  // Longitude wrap seam: between last column (3) and first column (0).
  const seam = dirForUV(1.0, 0.5) // u=1 -> fx=W-0.5 -> blends col W-1 and col 0
  approx(
    hf.sampleHeight(seam),
    deq((heights[idx(1, W - 1)] + heights[idx(1, 0)]) / 2),
    '4x3: longitude wrap seam interpolates col3<->col0',
  )

  // Row midpoint (v=0.25): halfway between north pole row 0 and equator row 1,
  // at a clean column center (tx=0).
  const c = 1
  const rowMid = dirForUV((c + 0.5) / W, 0.25) // fy = 0.25*(H-1)=0.5 -> ty=0.5
  approx(
    hf.sampleHeight(rowMid),
    deq((heights[idx(0, c)] + heights[idx(1, c)]) / 2),
    '4x3: row midpoint interpolates north<->equator',
  )
}

// ---------------------------------------------------------------------------
// (2) encode -> decode round-trips heights + rivers exactly, is byte-stable,
// preserves the determinism hash, and drops the (non-persisted) flow grid.
// ---------------------------------------------------------------------------
{
  const W = 4
  const H = 2
  // Distinct per-cell heights catch encode/decode ordering bugs.
  const heights = new Uint16Array([100, 200, 300, 400, 60000, 60001, 60002, 60003])
  // Flow is a bake-time intermediate — set to all-max here to prove it is NOT
  // persisted (decoded field must report sampleFlow == 0).
  const flow = new Uint16Array([65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535])
  // Rivers: node values are all f32-exact so equality is bit-exact. Order values
  // and both mouthUnder states are exercised (packed into the order byte).
  const rivers = [
    {
      nodes: new Float32Array([0, 1, 0, 0.5, 0.5, 0.5, 1, 0, 0]),
      widths: new Float32Array([0.0009765625, 0.00390625, 0.015625]),
      order: 3,
      mouthUnder: true,
    },
    {
      nodes: new Float32Array([-1, 0, 0, 0, -1, 0]),
      widths: new Float32Array([0.001953125, 0.0078125]),
      order: 1,
      mouthUnder: false,
    },
  ]
  const hf = makeHeightField({ width: W, height: H, hMin: H_MIN, hMax: H_MAX, heights, flow, rivers })

  // Flow present on the source field.
  approx(hf.sampleFlow({ x: 1, y: 0, z: 0 }), 1.0, 'source: sampleFlow reads the flow grid')

  const buf = encodeHeightField(hf)
  ok(buf instanceof ArrayBuffer, 'encode returns an ArrayBuffer')
  const dec = decodeHeightField(buf)

  // Scalars.
  ok(dec.width === W && dec.height === H, 'round-trip: width/height')
  ok(dec.hMin === H_MIN && dec.hMax === H_MAX, 'round-trip: hMin/hMax (f32-exact)')

  // Heights element-wise exact.
  ok(dec.heights.length === heights.length, 'round-trip: heights length')
  for (let i = 0; i < heights.length; i++) {
    ok(dec.heights[i] === heights[i], 'round-trip: height[' + i + '] exact')
  }

  // Rivers element-wise exact, including nodes, widths, order, mouthUnder.
  const net = dec.getRiverNetwork()
  ok(net.paths.length === rivers.length, 'round-trip: river count')
  ok(net.paths === dec.rivers, 'getRiverNetwork().paths is the rivers array')
  for (let p = 0; p < rivers.length; p++) {
    const a = rivers[p]
    const b = net.paths[p]
    ok(b.nodes.length === a.nodes.length, 'round-trip: river ' + p + ' node count')
    for (let k = 0; k < a.nodes.length; k++) {
      ok(b.nodes[k] === a.nodes[k], 'round-trip: river ' + p + ' node[' + k + '] exact')
    }
    ok(b.widths.length === a.widths.length, 'round-trip: river ' + p + ' width count')
    for (let k = 0; k < a.widths.length; k++) {
      ok(b.widths[k] === a.widths[k], 'round-trip: river ' + p + ' width[' + k + '] exact')
    }
    ok(b.order === a.order, 'round-trip: river ' + p + ' Strahler order')
    ok(b.mouthUnder === a.mouthUnder, 'round-trip: river ' + p + ' mouthUnder flag')
  }

  // Determinism hash survives the round-trip.
  ok(dec.hash() === hf.hash(), 'round-trip: hash() stable')
  ok((dec.hash() >>> 0) === dec.hash(), 'hash() is an unsigned 32-bit value')

  // sampleHeight parity after decode.
  for (const dir of [
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0.3, y: -0.6, z: 0.7 },
  ]) {
    approx(dec.sampleHeight(dir), hf.sampleHeight(dir), 'round-trip: sampleHeight parity')
  }

  // Flow is NOT persisted -> decoded field reports 0.
  approx(dec.sampleFlow({ x: 1, y: 0, z: 0 }), 0, 'round-trip: flow not persisted (sampleFlow == 0)')

  // Byte-stable: re-encoding the decoded field reproduces the same bytes.
  const buf2 = encodeHeightField(dec)
  const b1 = new Uint8Array(buf)
  const b2 = new Uint8Array(buf2)
  ok(b1.length === b2.length, 'byte-stable: encode length matches')
  let identical = true
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] !== b2[i]) {
      identical = false
      break
    }
  }
  ok(identical, 'byte-stable: encode(decode(encode)) is byte-identical')

  // Node Buffer input path (decode accepts a TypedArray / Buffer view too).
  const decFromBuffer = decodeHeightField(Buffer.from(buf))
  ok(decFromBuffer.hash() === hf.hash(), 'decode accepts a Node Buffer view')
}

// ---------------------------------------------------------------------------
// (3) Bad-magic / bad-version buffers throw (guards a corrupt/foreign .bin).
// ---------------------------------------------------------------------------
{
  const bad = new ArrayBuffer(32)
  let threw = false
  try {
    decodeHeightField(bad)
  } catch {
    threw = true
  }
  ok(threw, 'decode throws on bad magic')
}

console.log(
  'heightfield.test: ' +
    assertionCount +
    ' assertions passed (bilinear sampleHeight: 4x2 poles+equator & 4x3 interior-row ' +
    'columns/wrap; encode/decode round-trip of heights+rivers+order+mouthUnder; ' +
    'byte-stability; hash determinism; flow-not-persisted; bad-magic guard)',
)
