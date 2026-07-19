// Deterministic CPU hydraulic + thermal erosion and drainage extraction over an
// analytic height function. This is the ONE place erosion is computed; its
// committed output (public/bakes/<seed>.hf.bin) is what ships and is loaded at
// runtime. Pure ESM, THREE-free, and free of any wall-clock or RNG source — the
// grid and river polylines are byte-identical on every machine, so determinism
// survives even a future move to (non-bit-identical) GPU compute, which this
// replaces. See docs/design/epilogue-e1.md (BT3).
//
// Pipeline: (1) fill a raw lat/long grid from analyticHeight; (2) priority-flood
// depression fill (Barnes 2014); (3) D8 flow accumulation; (4) carve broad
// valleys from flow, widened by a separable Gaussian so they exceed the mesh
// Nyquist and read as real relief; (5) thermal relax to kill single-texel
// artifacts; (6) trace the drainage tree into smoothed river polylines.

import { SEA_LEVEL, clamp, smoothstep, hash01 } from './util.js'
import { makeHeightField } from './heightfield.js'

// --- Tunable constants (exported for ART tuning) ---------------------------
export const CARVE_MAX = 0.01 // deepest valley cut, planet-radius units
export const CARVE_GAMMA = 0.6 // flow^gamma shaping — <1 broadens the low-flow cut
export const RIVER_THRESHOLD = 1500 // min flow-accum (upstream cell count) for a river cell
export const CARVE_SPREAD_TEXELS = 7 // Gaussian radius that widens valleys past mesh Nyquist
export const THERMAL_TALUS = 0.006 // max per-texel slope before thermal relax bleeds it

// River half-widths (planet-radius units) — consumed straight into rivers.js.
export const RIVER_WIDTH_MIN = 0.0006 // headwater trickle
export const RIVER_WIDTH_MAX = 0.0026 // widest trunk (top Strahler order)
export const RIVER_WIDTH_FLOW = 0.0016 // extra half-width from sqrt(flow)

// --- Internal knobs --------------------------------------------------------
const FILL_EPS = 1e-6 // priority-flood epsilon slope — guarantees every land cell drains
const THERMAL_PASSES = 2
const RIVER_MAX_ORDER = 5 // Strahler order that maps to RIVER_WIDTH_MAX
const CHAIKIN_ITERS = 2
const TWO_PI = Math.PI * 2
const SQRT2 = Math.SQRT2

// 8-neighbour offsets (dr, dc, distance in texels). Fixed order → deterministic
// tie-breaks. Columns WRAP, rows CLAMP (applied per-use).
const NB = [
  [-1, -1, SQRT2],
  [-1, 0, 1],
  [-1, 1, SQRT2],
  [0, -1, 1],
  [0, 1, 1],
  [1, -1, SQRT2],
  [1, 0, 1],
  [1, 1, SQRT2],
]

/**
 * Deterministic erosion bake. Returns a makeHeightField result whose eroded
 * heights (Uint16), flow field (Uint16) and river polylines are the shipped
 * source of truth.
 *
 * @param {object}   o
 * @param {string}   o.seed            seed string (for river-width micro-jitter only)
 * @param {(dir:{x,y,z})=>number} o.analyticHeight  THREE-free height fn (terrainField)
 * @param {number}  [o.width=2048]
 * @param {number}  [o.height=1024]
 */
export function bakeErosion({ seed, analyticHeight, width = 2048, height = 1024 }) {
  const W = width | 0
  const H = height | 0
  const N = W * H

  // -----------------------------------------------------------------------
  // (1) FILL the raw grid from the analytic height. Texel-center convention
  //     MUST match heightfield.js sampleHeight's inverse so the mesh and the
  //     sampler read the exact same surface:
  //       col c -> u=(c+0.5)/W -> phi=(u-0.5)*2PI
  //       row r -> v=r/(H-1)   -> theta=v*PI
  //       dir = (sinθ·cosφ, cosθ, sinθ·sinφ)   (already unit length)
  // -----------------------------------------------------------------------
  const raw = new Float32Array(N)
  const cosPhi = new Float64Array(W)
  const sinPhi = new Float64Array(W)
  for (let c = 0; c < W; c++) {
    const phi = ((c + 0.5) / W - 0.5) * TWO_PI
    cosPhi[c] = Math.cos(phi)
    sinPhi[c] = Math.sin(phi)
  }
  const dir = { x: 0, y: 0, z: 0 } // reused scratch — analyticHeight only reads it
  let rawMax = -Infinity
  for (let r = 0; r < H; r++) {
    const theta = (H > 1 ? r / (H - 1) : 0) * Math.PI
    const sinT = Math.sin(theta)
    const cosT = Math.cos(theta)
    const rowBase = r * W
    for (let c = 0; c < W; c++) {
      dir.x = sinT * cosPhi[c]
      dir.y = cosT
      dir.z = sinT * sinPhi[c]
      const h = analyticHeight(dir)
      raw[rowBase + c] = h
      if (h > rawMax) rawMax = h
    }
  }

  // -----------------------------------------------------------------------
  // (2) PRIORITY-FLOOD depression fill (Barnes 2014, push-time-closed variant).
  //     Min-heap keyed by filled height, tie-broken by linear index (NO rng).
  //     Outlets: every ocean cell (raw<=SEA_LEVEL) and both pole rows. Each
  //     land cell ends with a strictly-downhill path to an outlet. The pop
  //     sequence is a valid topological (increasing-filled) order, reused below.
  // -----------------------------------------------------------------------
  const filled = new Float32Array(N)
  const closed = new Uint8Array(N)
  const popOrder = new Int32Array(N)
  let popCount = 0

  // Binary min-heap over (key=filled, idx). Capacity N — each cell pushed once.
  let hKey = new Float64Array(N)
  let hIdx = new Int32Array(N)
  let hSize = 0
  const heapPush = (key, idx) => {
    let i = hSize++
    hKey[i] = key
    hIdx[i] = idx
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hKey[p] < hKey[i] || (hKey[p] === hKey[i] && hIdx[p] < hIdx[i])) break
      const tk = hKey[p]
      hKey[p] = hKey[i]
      hKey[i] = tk
      const ti = hIdx[p]
      hIdx[p] = hIdx[i]
      hIdx[i] = ti
      i = p
    }
  }
  const heapPop = () => {
    const top = hIdx[0]
    hSize--
    if (hSize > 0) {
      hKey[0] = hKey[hSize]
      hIdx[0] = hIdx[hSize]
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const rr = l + 1
        let m = i
        if (l < hSize && (hKey[l] < hKey[m] || (hKey[l] === hKey[m] && hIdx[l] < hIdx[m]))) m = l
        if (rr < hSize && (hKey[rr] < hKey[m] || (hKey[rr] === hKey[m] && hIdx[rr] < hIdx[m]))) m = rr
        if (m === i) break
        const tk = hKey[m]
        hKey[m] = hKey[i]
        hKey[i] = tk
        const ti = hIdx[m]
        hIdx[m] = hIdx[i]
        hIdx[i] = ti
        i = m
      }
    }
    return top
  }

  for (let r = 0; r < H; r++) {
    const poleRow = r === 0 || r === H - 1
    const rowBase = r * W
    for (let c = 0; c < W; c++) {
      const i = rowBase + c
      if (poleRow || raw[i] <= SEA_LEVEL) {
        filled[i] = raw[i]
        closed[i] = 1
        heapPush(filled[i], i)
      }
    }
  }

  while (hSize > 0) {
    const i = heapPop()
    popOrder[popCount++] = i
    const r = (i / W) | 0
    const c = i - r * W
    const fi = filled[i]
    for (let k = 0; k < 8; k++) {
      const nr = r + NB[k][0]
      if (nr < 0 || nr >= H) continue
      let nc = c + NB[k][1]
      if (nc < 0) nc += W
      else if (nc >= W) nc -= W
      const j = nr * W + nc
      if (closed[j]) continue
      closed[j] = 1
      const lift = fi + FILL_EPS
      filled[j] = raw[j] > lift ? raw[j] : lift
      heapPush(filled[j], j)
    }
  }
  hKey = null
  hIdx = null

  // -----------------------------------------------------------------------
  // (3) D8 flow. Receiver = steepest-descent neighbour on the FILLED grid
  //     (drop / texel-distance), tie-broken by index. Every non-outlet land
  //     cell has a strictly-lower flood parent, so a receiver always exists.
  //     Then accumulate in decreasing-filled order (reversed pop sequence):
  //     a cell's donors (higher filled) are all processed before it.
  // -----------------------------------------------------------------------
  const receiver = new Int32Array(N).fill(-1)
  for (let r = 0; r < H; r++) {
    const rowBase = r * W
    for (let c = 0; c < W; c++) {
      const i = rowBase + c
      const fi = filled[i]
      let best = -1
      let bestSlope = 0
      for (let k = 0; k < 8; k++) {
        const nr = r + NB[k][0]
        if (nr < 0 || nr >= H) continue
        let nc = c + NB[k][1]
        if (nc < 0) nc += W
        else if (nc >= W) nc -= W
        const j = nr * W + nc
        const fj = filled[j]
        if (fj < fi) {
          const slope = (fi - fj) / NB[k][2]
          if (slope > bestSlope || (slope === bestSlope && best >= 0 && j < best)) {
            bestSlope = slope
            best = j
          }
        }
      }
      receiver[i] = best
    }
  }

  const accum = new Float64Array(N).fill(1)
  for (let k = popCount - 1; k >= 0; k--) {
    const i = popOrder[k]
    const ri = receiver[i]
    if (ri >= 0) accum[ri] += accum[i]
  }
  // Normalise by the largest LAND drainage (a river mouth), not an ocean sink
  // that may gather a whole continent — keeps carve/river dynamic range on land.
  let maxAccum = 1
  for (let i = 0; i < N; i++) {
    if (raw[i] > SEA_LEVEL && accum[i] > maxAccum) maxAccum = accum[i]
  }
  const invLogMax = 1 / Math.log1p(maxAccum)
  const fNorm = new Float32Array(N)
  for (let i = 0; i < N; i++) fNorm[i] = Math.log1p(accum[i]) * invLogMax

  // -----------------------------------------------------------------------
  // (4) CARVE broad valleys from flow, tapered out of the buildable lowland
  //     band and boosted in the highlands, then WIDENED by a separable Gaussian
  //     so the valley spans several mesh texels and renders as real relief.
  //     coastTaper -> 0 below SEA_LEVEL+0.006 protects settlement ground.
  // -----------------------------------------------------------------------
  const CT_LO = SEA_LEVEL + 0.006
  const CT_HI = SEA_LEVEL + 0.02
  const HB_LO = SEA_LEVEL + 0.01
  let carve = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const h = raw[i]
    if (h <= SEA_LEVEL) continue // ocean floor untouched
    const ct = smoothstep(CT_LO, CT_HI, h)
    if (ct <= 0) continue // buildable lowlands barely move
    const hb = 0.4 + 0.6 * smoothstep(HB_LO, rawMax, h)
    carve[i] = CARVE_MAX * Math.pow(fNorm[i], CARVE_GAMMA) * hb * ct
  }
  const carveBlur = gaussianBlurSeparable(carve, W, H, CARVE_SPREAD_TEXELS)

  // River-channel mask (land cells with enough flow). Channels reaching the
  // coast are allowed below SEA_LEVEL so the river meets the sea; other land is
  // never sunk below sea level by the carve.
  const riverCell = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (raw[i] > SEA_LEVEL && accum[i] > RIVER_THRESHOLD) riverCell[i] = 1
  }

  const eroded = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    let e = raw[i] - carveBlur[i]
    if (raw[i] > SEA_LEVEL && riverCell[i] === 0 && e < SEA_LEVEL) e = SEA_LEVEL
    eroded[i] = e
  }

  // -----------------------------------------------------------------------
  // (5) THERMAL relax — slope-limited Jacobi passes that shave single-texel
  //     spikes (e.g. sharp coastal steps where a channel drops below sea).
  // -----------------------------------------------------------------------
  thermalRelax(eroded, W, H, THERMAL_TALUS, THERMAL_PASSES)

  // Final quantization range from the actual eroded extent (carve can dip a
  // channel just under the raw minimum) so dequant never clamps.
  let hMin = Infinity
  let hMax = -Infinity
  for (let i = 0; i < N; i++) {
    const e = eroded[i]
    if (e < hMin) hMin = e
    if (e > hMax) hMax = e
  }
  if (!(hMax > hMin)) hMax = hMin + 1e-6 // guard a degenerate flat world

  const heights = new Uint16Array(N)
  const invRange = 1 / (hMax - hMin)
  for (let i = 0; i < N; i++) {
    const q = clamp((eroded[i] - hMin) * invRange, 0, 1)
    heights[i] = (q * 65535 + 0.5) | 0
  }
  const flow = new Uint16Array(N)
  for (let i = 0; i < N; i++) {
    const q = clamp(fNorm[i], 0, 1)
    flow[i] = (q * 65535 + 0.5) | 0
  }

  // -----------------------------------------------------------------------
  // (6) RIVERS. Strahler order per river cell (decreasing-filled order so a
  //     cell's donors are known before it), then trace segments between
  //     headwaters / confluences / mouths, smooth, and emit polylines.
  // -----------------------------------------------------------------------
  const order = new Int16Array(N) // Strahler order (0 = not a river cell)
  const donMaxOrder = new Int16Array(N)
  const donMaxCount = new Uint8Array(N)
  const riverDonors = new Uint8Array(N) // # of river donors (any order): confluence test
  for (let k = popCount - 1; k >= 0; k--) {
    const i = popOrder[k]
    if (!riverCell[i]) continue
    let o
    if (donMaxOrder[i] === 0)
      o = 1 // headwater
    else if (donMaxCount[i] >= 2)
      o = donMaxOrder[i] + 1 // >=2 streams of top order meet
    else o = donMaxOrder[i]
    order[i] = o
    const ri = receiver[i]
    if (ri >= 0 && riverCell[ri]) {
      riverDonors[ri]++
      if (o > donMaxOrder[ri]) {
        donMaxOrder[ri] = o
        donMaxCount[ri] = 1
      } else if (o === donMaxOrder[ri]) {
        donMaxCount[ri]++
      }
    }
  }

  const rivers = []
  for (let i = 0; i < N; i++) {
    if (!riverCell[i]) continue
    const donors = riverDonors[i]
    // Segment starts at every headwater (0 donors) and every confluence (>=2);
    // interior cells (1 donor) are walked through by the segment above them.
    if (donors === 1) continue
    const seg = traceSegment(i)
    if (seg) rivers.push(seg)
  }

  return makeHeightField({ width: W, height: H, hMin, hMax, heights, flow, rivers })

  // --- river tracing (closes over the grids above) -----------------------

  function traceSegment(start) {
    const cells = [start]
    let mouthUnder = false
    let cur = start
    for (let guard = 0; guard < N; guard++) {
      const nxt = receiver[cur]
      if (nxt < 0) break // interior sink (rare) — segment just ends
      if (raw[nxt] <= SEA_LEVEL) {
        // Reached the sea: the first ocean cell is the mouth; push one more
        // cell seaward so the ribbon end tucks under the ocean shell.
        cells.push(nxt)
        const sea2 = receiver[nxt]
        if (sea2 >= 0) cells.push(sea2)
        mouthUnder = true
        break
      }
      cells.push(nxt)
      if (riverDonors[nxt] >= 2) break // confluence — segment ends here (shared node)
      cur = nxt
    }
    if (cells.length < 2) return null

    const segOrder = order[start] || 1
    const orderT = clamp((segOrder - 1) / (RIVER_MAX_ORDER - 1), 0, 1)
    const baseW = RIVER_WIDTH_MIN + (RIVER_WIDTH_MAX - RIVER_WIDTH_MIN) * orderT
    // Deterministic per-river width jitter, keyed by the start cell so it is
    // stable regardless of iteration order (order-independent hashing).
    const jitter = 0.9 + 0.2 * hash01(seed + ':river:' + start)

    const pts = []
    const d = [0, 0, 0]
    let lastW = baseW
    for (let n = 0; n < cells.length; n++) {
      const idx = cells[n]
      cellDirInto(idx, d)
      let w
      if (raw[idx] <= SEA_LEVEL) {
        w = lastW // ocean mouth / seaward node — keep trunk width, no pinch
      } else {
        w = (baseW + Math.sqrt(fNorm[idx]) * RIVER_WIDTH_FLOW) * jitter
        lastW = w
      }
      pts.push([d[0], d[1], d[2], w])
    }

    const sm = chaikin(pts, CHAIKIN_ITERS)
    const M = sm.length
    const nodes = new Float32Array(M * 3)
    const widths = new Float32Array(M)
    for (let n = 0; n < M; n++) {
      const p = sm[n]
      const inv = 1 / (Math.hypot(p[0], p[1], p[2]) || 1)
      nodes[n * 3] = p[0] * inv
      nodes[n * 3 + 1] = p[1] * inv
      nodes[n * 3 + 2] = p[2] * inv
      widths[n] = p[3]
    }
    return { nodes, widths, order: segOrder, mouthUnder }
  }

  function cellDirInto(idx, out) {
    const r = (idx / W) | 0
    const c = idx - r * W
    const phi = ((c + 0.5) / W - 0.5) * TWO_PI
    const theta = (H > 1 ? r / (H - 1) : 0) * Math.PI
    const sinT = Math.sin(theta)
    out[0] = sinT * Math.cos(phi)
    out[1] = Math.cos(theta)
    out[2] = sinT * Math.sin(phi)
    return out
  }
}

// Chaikin corner-cutting on [x,y,z,w] tuples; endpoints preserved. Smooths the
// polyline into a clean ribbon path (widths ride along as a 4th channel).
function chaikin(pts, iters) {
  let cur = pts
  for (let it = 0; it < iters; it++) {
    if (cur.length < 3) break
    const out = [cur[0]]
    for (let k = 0; k < cur.length - 1; k++) {
      const p = cur[k]
      const q = cur[k + 1]
      out.push([
        0.75 * p[0] + 0.25 * q[0],
        0.75 * p[1] + 0.25 * q[1],
        0.75 * p[2] + 0.25 * q[2],
        0.75 * p[3] + 0.25 * q[3],
      ])
      out.push([
        0.25 * p[0] + 0.75 * q[0],
        0.25 * p[1] + 0.75 * q[1],
        0.25 * p[2] + 0.75 * q[2],
        0.25 * p[3] + 0.75 * q[3],
      ])
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

// Slope-limited thermal erosion (Jacobi). Each undirected 4-edge is visited
// once per pass; where the height difference exceeds `talus`, half the excess
// moves downhill. Columns WRAP, rows CLAMP. Conserves mass, deterministic.
function thermalRelax(h, W, H, talus, passes) {
  const N = W * H
  const delta = new Float64Array(N)
  for (let p = 0; p < passes; p++) {
    delta.fill(0)
    for (let r = 0; r < H; r++) {
      const rowBase = r * W
      const hasDown = r < H - 1
      for (let c = 0; c < W; c++) {
        const i = rowBase + c
        const hi = h[i]
        // right edge (column wrap)
        {
          const j = rowBase + (c + 1 === W ? 0 : c + 1)
          const diff = hi - h[j]
          const ad = diff < 0 ? -diff : diff
          if (ad > talus) {
            const move = 0.5 * (ad - talus)
            if (diff > 0) {
              delta[i] -= move
              delta[j] += move
            } else {
              delta[i] += move
              delta[j] -= move
            }
          }
        }
        // down edge (row clamp -> skip at the bottom row)
        if (hasDown) {
          const j = i + W
          const diff = hi - h[j]
          const ad = diff < 0 ? -diff : diff
          if (ad > talus) {
            const move = 0.5 * (ad - talus)
            if (diff > 0) {
              delta[i] -= move
              delta[j] += move
            } else {
              delta[i] += move
              delta[j] -= move
            }
          }
        }
      }
    }
    for (let i = 0; i < N; i++) h[i] += delta[i]
  }
}

// Separable Gaussian blur of a scalar field: columns WRAP, rows CLAMP. Returns a
// fresh Float64Array. Radius ~7 widens carve valleys past the mesh Nyquist.
function gaussianBlurSeparable(src, W, H, radius) {
  const R = radius | 0
  const kernel = gaussianKernel(R)
  const tmp = new Float64Array(W * H)
  const out = new Float64Array(W * H)
  // horizontal (wrap)
  for (let r = 0; r < H; r++) {
    const rowBase = r * W
    for (let c = 0; c < W; c++) {
      let acc = 0
      for (let t = -R; t <= R; t++) {
        let cc = c + t
        if (cc < 0) cc = ((cc % W) + W) % W
        else if (cc >= W) cc %= W
        acc += src[rowBase + cc] * kernel[t + R]
      }
      tmp[rowBase + c] = acc
    }
  }
  // vertical (clamp)
  for (let r = 0; r < H; r++) {
    const rowBase = r * W
    for (let c = 0; c < W; c++) {
      let acc = 0
      for (let t = -R; t <= R; t++) {
        let rr = r + t
        if (rr < 0) rr = 0
        else if (rr >= H) rr = H - 1
        acc += tmp[rr * W + c] * kernel[t + R]
      }
      out[rowBase + c] = acc
    }
  }
  return out
}

function gaussianKernel(radius) {
  const R = radius | 0
  const sigma = R > 0 ? R / 2 : 1
  const k = new Float64Array(2 * R + 1)
  let sum = 0
  for (let t = -R; t <= R; t++) {
    const v = Math.exp(-(t * t) / (2 * sigma * sigma))
    k[t + R] = v
    sum += v
  }
  const inv = 1 / sum
  for (let i = 0; i < k.length; i++) k[i] *= inv
  return k
}
