// POSTER EXPORT — high-resolution PNG capture. Pure on-demand capture: no
// scene object, no per-frame update. capture() re-renders the CURRENT camera
// view through the existing post-processing chain (scene → scattering →
// clouds → bloom → dither) at 2-4x the window resolution, downloads it as a
// PNG, then restores the renderer/camera to exactly how it found them —
// even if the render throws. Presentation-only (COVENANT-safe): it reads
// pixels off the canvas and writes nothing to world state.
import * as THREE from 'three/webgpu'
import { clamp } from './util.js'

// A real poster-sized PNG data URL is always many kilobytes; a blank/failed
// readback collapses to a tiny string (e.g. 'data:,' for a 0x0 canvas, or a
// trivially-compressible near-empty image). Anything under this is treated
// as a failed toDataURL() and triggers the toBlob() fallback below.
const MIN_DATA_URL_LENGTH = 4096

/**
 * @param {{ renderer: THREE.WebGPURenderer, post: THREE.PostProcessing, camera: THREE.PerspectiveCamera }} deps
 * @returns {{ capture: (scale?: number) => Promise<void> }}
 */
export function createPosterExport({ renderer, post, camera }) {
  const sizeScratch = new THREE.Vector2()

  async function capture(scale = 3) {
    const posterScale = clamp(scale, 1, 4)

    // 1) Snapshot everything capture() is about to change, so it can be
    // restored exactly regardless of how the render below goes.
    const dpr = renderer.getPixelRatio()
    renderer.getSize(sizeScratch)
    const prevWidth = sizeScratch.x
    const prevHeight = sizeScratch.y
    const prevAspect = camera.aspect

    // 2) Hide the UI/HUD for a clean plate (ui.css: body.capturing #planet-ui,
    // body.capturing .hud { visibility: hidden }).
    document.body.classList.add('capturing')

    try {
      // 3) Blow the backbuffer up to poster resolution. The `false` third
      // arg (updateStyle) keeps the on-page canvas's CSS size fixed, so the
      // page never jumps — only the backing pixel buffer grows. The aspect
      // ratio (innerWidth/innerHeight) doesn't change, but call
      // updateProjectionMatrix() defensively anyway.
      renderer.setPixelRatio(1)
      renderer.setSize(Math.round(innerWidth * posterScale), Math.round(innerHeight * posterScale), false)
      camera.updateProjectionMatrix()

      // 4) One fresh full-res frame through the whole post chain.
      await post.renderAsync()

      // 5+6) Read the pixels back and trigger the download.
      const planetName = document.querySelector('#title .planet-name')?.textContent || 'planet'
      const filename = `${planetName}-poster.png`
      await downloadCanvas(renderer.domElement, filename)
    } finally {
      // 7) ALWAYS restore, even if the render above threw — a failed capture
      // must never leave the live view resized.
      renderer.setPixelRatio(dpr)
      renderer.setSize(prevWidth, prevHeight, false)
      camera.aspect = prevAspect
      camera.updateProjectionMatrix()
      document.body.classList.remove('capturing')
    }
  }

  return { capture }
}

// Read the canvas back as a PNG and download it. Prefers the synchronous
// toDataURL() path (works on the default WebGL2 backend right after an
// awaited renderAsync()); falls back to the async toBlob() path when that
// comes back blank/undersized. NOTE: the true-WebGPU backend
// (?renderer=webgpu) may not preserve the drawing buffer for toDataURL(), so
// poster capture there is best-effort and more likely to need this fallback.
async function downloadCanvas(canvas, filename) {
  let dataUrl = null
  try {
    dataUrl = canvas.toDataURL('image/png')
  } catch {
    dataUrl = null // tainted or unsupported canvas readback
  }

  if (dataUrl && dataUrl.length > MIN_DATA_URL_LENGTH) {
    triggerDownload(dataUrl, filename)
    return
  }

  if (typeof canvas.toBlob !== 'function') return

  await new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        const objectUrl = URL.createObjectURL(blob)
        triggerDownload(objectUrl, filename)
        // Give the download a moment to start before freeing the blob URL.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
      }
      resolve()
    }, 'image/png')
  })
}

function triggerDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
