// Canvas label sprites: settlement name plates, topic labels, and speech
// bubbles, plus the shared distance-based scale-clamp helper they're all
// sized with. Topic/bubble text is untrusted (session topic / lastAction) —
// always drawn via canvas fillText, never innerHTML. Split out of world.js
// (see the M2 program plan) along that file's own section boundaries — no
// behavior change, only where this code lives.
import * as THREE from 'three'
import { clamp } from './util.js'

export const SETTLEMENT_LABEL_K = 0.022
export const SETTLEMENT_LABEL_MIN = 0.006
export const SETTLEMENT_LABEL_MAX = 0.085
export const TOPIC_LABEL_K = 0.02
export const TOPIC_LABEL_MIN = 0.0045
export const TOPIC_LABEL_MAX = 0.028
export const TOPIC_LABEL_REF_DIST = 1.15 // representative "up close" distance used to size topic labels once

const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, sans-serif'

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function buildSettlementCanvas(glyph, name, basenameRaw, accentCss) {
  const titleSize = 46
  const subSize = 30
  const padX = 26
  const padY = 18
  const gap = 6

  const meas = document.createElement('canvas').getContext('2d')
  const titleText = glyph + '  ' + name
  meas.font = '700 ' + titleSize + 'px ' + LABEL_FONT
  const titleW = meas.measureText(titleText).width
  meas.font = '500 ' + subSize + 'px ' + LABEL_FONT
  const subW = meas.measureText(basenameRaw).width

  const width = Math.ceil(Math.max(titleW, subW) + padX * 2)
  const height = Math.ceil(titleSize + subSize + gap + padY * 2)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(16,14,20,0.55)'
  roundRectPath(ctx, 1, 1, width - 2, height - 2, 18)
  ctx.fill()
  ctx.strokeStyle = accentCss
  ctx.lineWidth = 3
  roundRectPath(ctx, 1.5, 1.5, width - 3, height - 3, 18)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#f6ecd9'
  ctx.font = '700 ' + titleSize + 'px ' + LABEL_FONT
  ctx.fillText(titleText, width / 2, padY)

  ctx.fillStyle = 'rgba(216,206,196,0.72)'
  ctx.font = '500 ' + subSize + 'px ' + LABEL_FONT
  ctx.fillText(basenameRaw, width / 2, padY + titleSize + gap)

  return { canvas, aspect: width / height }
}

function buildTopicCanvas(text) {
  const size = 30
  const padX = 18
  const padY = 12

  const meas = document.createElement('canvas').getContext('2d')
  meas.font = '600 ' + size + 'px ' + LABEL_FONT
  const w = meas.measureText(text).width

  const width = Math.ceil(w + padX * 2)
  const height = Math.ceil(size + padY * 2)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(14,13,18,0.62)'
  roundRectPath(ctx, 1, 1, width - 2, height - 2, 12)
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#eee6d6'
  ctx.font = '600 ' + size + 'px ' + LABEL_FONT
  ctx.fillText(text, width / 2, padY)

  return { canvas, aspect: width / height }
}

export function makeSettlementSprite(glyph, name, basenameRaw, accentCss) {
  const { canvas, aspect } = buildSettlementCanvas(glyph, name, basenameRaw, accentCss)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  return sprite
}

export function makeTopicSprite(text) {
  const { canvas, aspect } = buildTopicCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  return sprite
}

export function refreshTopicSprite(sprite, text) {
  const { canvas, aspect } = buildTopicCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  sprite.material.map.dispose()
  sprite.material.map = tex
  sprite.material.needsUpdate = true
  sprite.userData.aspect = aspect
}

// Small rounded speech-bubble with a tail pointing down at the speaker.
// Text is untrusted (session lastAction) — canvas fillText only, same as topics.
function buildBubbleCanvas(text) {
  const size = 22
  const padX = 14
  const padY = 9
  const tail = 7

  const meas = document.createElement('canvas').getContext('2d')
  meas.font = '600 ' + size + 'px ' + LABEL_FONT
  const w = meas.measureText(text).width

  const width = Math.ceil(w + padX * 2)
  const bodyH = Math.ceil(size + padY * 2)
  const height = bodyH + tail

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(20,18,26,0.75)'
  roundRectPath(ctx, 1, 1, width - 2, bodyH - 2, 10)
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(width / 2 - tail, bodyH - 2)
  ctx.lineTo(width / 2 + tail, bodyH - 2)
  ctx.lineTo(width / 2, bodyH - 2 + tail)
  ctx.closePath()
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#f6ecd9'
  ctx.font = '600 ' + size + 'px ' + LABEL_FONT
  ctx.fillText(text, width / 2, padY)

  return { canvas, aspect: width / height }
}

export function makeBubbleSprite(text) {
  const { canvas, aspect } = buildBubbleCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  sprite.renderOrder = 2
  return sprite
}

export function refreshBubbleSprite(sprite, text) {
  const { canvas, aspect } = buildBubbleCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  sprite.material.map.dispose()
  sprite.material.map = tex
  sprite.material.needsUpdate = true
  sprite.userData.aspect = aspect
}

export function applyLabelScale(sprite, dist, k, min, max) {
  const s = clamp(dist * k, min, max)
  const aspect = sprite.userData.aspect || 2
  sprite.scale.set(s * aspect, s, 1)
}
