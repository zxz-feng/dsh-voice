/**
 * Edge TTS 合成（免费、无 key、走 Edge 浏览器的朗读接口）
 *
 * ⚠️⚠️ 最大的坑（2026-10-30 实测踩过）：**prosody 必须传给 toFile()**，
 *   传给 setMetadata() 会被**静默忽略** —— 四个不同参数的样本 MD5 完全相同，
 *   听起来一模一样，还以为是"微软不给调"。这条有回归测试守着，别改回去。
 *
 * 音色：只保留 zh-CN-XiaoyiNeural（用户 2026-10-30 选定）。
 * 语气档：x1 原声 / x2 轻快 / x3 软糯 / x4 带刺 —— 靠 rate + pitch 两轴调出来。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export const VOICE = 'zh-CN-XiaoyiNeural'

/** 语气档：rate 改语速、pitch 改音高，两个轴就够拉开差别了 */
export const PRESETS = {
  x1: { label: '原声', rate: '+0%', pitch: '+0Hz' },
  x2: { label: '轻快', rate: '+12%', pitch: '+3Hz' },
  x3: { label: '软糯', rate: '-8%', pitch: '-2Hz' },
  x4: { label: '带刺', rate: '+5%', pitch: '+5Hz' },
}
export const DEFAULT_PRESET = 'x1'

/** QQ 语音上限 60 秒；中文约 4 字/秒 ⇒ 120 字留足余量 */
export const MAX_CHARS = 120
/** 单次合成超时 */
const TIMEOUT_MS = 15_000
/** 缓存保留天数 */
const MAX_AGE_DAYS = 7

/**
 * 清洗：CQ 码、链接、@、多余空白全去掉 —— 念出来会很怪
 * 保留标点（标点影响断句和语调）
 */
export function cleanForTTS(text) {
  return String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')          // CQ 码（图片/表情/at）
    .replace(/https?:\/\/\S+/g, ' ')         // 链接
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // emoji
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 超长截断：留个省略号，别把句子砍在半截 */
export function clampText(text, max = MAX_CHARS) {
  const t = String(text ?? '')
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const lastPunct = Math.max(...['。', '！', '？', '…', '，', '.', '!', '?'].map((p) => cut.lastIndexOf(p)))
  return (lastPunct > max * 0.5 ? cut.slice(0, lastPunct + 1) : cut) + '…'
}

/** 缓存键：音色+参数+文本，任何一项变了都要重新合成 */
export function cacheKey(text, preset = DEFAULT_PRESET) {
  const p = PRESETS[preset] || PRESETS[DEFAULT_PRESET]
  return createHash('sha1').update([VOICE, p.rate, p.pitch, text].join('\u0001')).digest('hex').slice(0, 20)
}

/** 清掉过期缓存（默认 7 天） */
export function pruneCache(dir, days = MAX_AGE_DAYS) {
  if (!existsSync(dir)) return 0
  const cut = Date.now() - days * 86400_000
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mp3')) continue
    const p = join(dir, f)
    try { if (statSync(p).mtimeMs < cut) { unlinkSync(p); n++ } } catch { /* 被别人删了就算了 */ }
  }
  return n
}

const inflight = new Map()   // 同文本并发时复用同一次合成

/**
 * 合成一句话
 * @returns {Promise<{path:string, cached:boolean, ms:number, text:string, preset:string}|null>}
 *          失败返回 null（调用方回落到文字，不要抛）
 */
export async function speak(text, { dir, preset = DEFAULT_PRESET, log = () => {}, timeoutMs = TIMEOUT_MS } = {}) {
  const t0 = Date.now()
  const clean = clampText(cleanForTTS(text))
  if (!clean) return null
  if (!dir) throw new Error('speak: 缺少 dir')

  mkdirSync(dir, { recursive: true })
  const key = cacheKey(clean, preset)
  const file = join(dir, `${key}.mp3`)

  if (existsSync(file) && statSync(file).size > 1024) {
    return { path: file, cached: true, ms: Date.now() - t0, text: clean, preset }
  }
  if (inflight.has(key)) return inflight.get(key)

  const p = PRESETS[preset] || PRESETS[DEFAULT_PRESET]
  const job = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tts = new MsEdgeTTS()
        await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        // ⭐ prosody 在第三个参数（toFile），不是 setMetadata —— 见文件头
        const r = await Promise.race([
          tts.toFile(dir, clean, { rate: p.rate, pitch: p.pitch }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('合成超时')), timeoutMs)),
        ])
        // toFile 固定写 audio.mp3，改名成缓存键
        const { renameSync } = await import('node:fs')
        if (r?.audioFilePath && r.audioFilePath !== file) renameSync(r.audioFilePath, file)
        const size = existsSync(file) ? statSync(file).size : 0
        if (size < 1024) throw new Error(`合成出来的文件太小（${size}B）`)
        log(`TTS ok（${clean.length} 字 / ${preset} / ${Date.now() - t0}ms / ${size}B）`)
        return { path: file, cached: false, ms: Date.now() - t0, text: clean, preset }
      } catch (e) {
        log(`TTS 第 ${attempt} 次失败：${String(e?.message ?? e).slice(0, 120)}`)
        if (attempt === 2) return null
        await new Promise((r) => setTimeout(r, 800))
      }
    }
    return null
  })().finally(() => inflight.delete(key))

  inflight.set(key, job)
  return job
}

/** 列出现有缓存（给状态页看） */
export function cacheStats(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 }
  let files = 0, bytes = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mp3')) continue
    files++
    try { bytes += statSync(join(dir, f)).size } catch { /* ignore */ }
  }
  return { files, bytes }
}
