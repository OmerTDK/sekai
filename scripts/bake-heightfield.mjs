// Node CLI: runs the deterministic CPU erosion bake for one seed and writes
// the committed public/bakes/<seed>.hf.bin — the SINGLE SOURCE OF TRUTH the
// browser loads at runtime instead of recomputing erosion (see E1 design
// doc, "Determinism"). Every import below is THREE-free / Node-importable
// on purpose: this script must never pull in the browser bundle.
//
// Usage (from the repo root, so 'public/bakes' resolves correctly):
//   node scripts/bake-heightfield.mjs [seed] [width] [height]
//   npm run bake                          -> aetherion-1, 2048x1024
//   npm run bake -- some-seed 1024 512    -> custom seed + grid size
//
// Determinism check: run this twice for the same seed/size and diff the
// two output files — they must be byte-identical (no Math.random/Date.now
// anywhere in the pipeline, see terrainField.js/erosion.js/heightfield.js).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createTerrainField } from '../src/terrainField.js'
import { bakeErosion } from '../src/erosion.js'
import { encodeHeightField } from '../src/heightfield.js'

const DEFAULT_SEED = 'aetherion-1'
const DEFAULT_WIDTH = 2048
const DEFAULT_HEIGHT = 1024

const seed = process.argv[2] || DEFAULT_SEED
const width = parseInt(process.argv[3], 10) || DEFAULT_WIDTH
const height = parseInt(process.argv[4], 10) || DEFAULT_HEIGHT

console.log(`[bake] seed=${seed} width=${width} height=${height}`)

const tf = createTerrainField(seed)
const hf = bakeErosion({ seed, analyticHeight: tf.analyticHeight, width, height })
const buf = encodeHeightField(hf)

const outDir = 'public/bakes'
const outPath = `${outDir}/${seed}.hf.bin`
mkdirSync(outDir, { recursive: true })
writeFileSync(outPath, Buffer.from(buf))

console.log(`[bake] wrote ${outPath} (${buf.byteLength} bytes)`)
console.log(`[bake] hash=${hf.hash()}`)
