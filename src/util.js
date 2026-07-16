// Shared deterministic helpers. Everything visual/positional derives from
// string seeds so the same planet + settlements come back on every launch.
import { createNoise3D } from 'simplex-noise'

export const SEA_LEVEL = 1.0

export function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^= h >>> 16) >>> 0
  }
}

export function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic RNG (0..1) from a string seed. */
export function rngFromString(s) {
  return mulberry32(xmur3(s)())
}

/** Single deterministic 0..1 value from a string. */
export function hash01(s) {
  return xmur3(s)() / 4294967296
}

/** Seeded 3D simplex noise, range roughly [-1, 1]. */
export function makeNoise3D(seedStr) {
  return createNoise3D(rngFromString(seedStr))
}

/** Fractal brownian motion over a seeded noise3 fn. Returns roughly [-1, 1]. */
export function fbm(noise3, x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

/** Ridged multifractal — sharp mountain crests. Returns roughly [0, 1]. */
export function ridged(noise3, x, y, z, octaves = 4, lacunarity = 2.1, gain = 0.55) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const r = 1 - Math.abs(noise3(x * freq, y * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Fantasy proper noun from a seed string, e.g. planet or settlement names. */
export function fantasyName(seedStr) {
  const rng = rngFromString(seedStr)
  const a = ['Ae', 'Va', 'Tho', 'Ori', 'Elu', 'Mar', 'Cal', 'Ny', 'Sera', 'Um', 'Kor', 'Ithi']
  const b = ['ther', 'lan', 'ric', 'mun', 'dra', 'vel', 'thas', 'gorn', 'lith', 'ran']
  const c = ['ia', 'or', 'eth', 'une', 'ara', 'is', 'ov', 'em']
  const pick = (arr) => arr[Math.floor(rng() * arr.length)]
  return pick(a) + pick(b) + (rng() < 0.6 ? pick(c) : '')
}
