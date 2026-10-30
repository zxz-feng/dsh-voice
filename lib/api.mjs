/**
 * 语音插件的 HTTP 面：工具和设置页**都走这里**，谁都不许自己拼路径。
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { speak, cacheStats, pruneCache, PRESETS, VOICE, DEFAULT_PRESET, MAX_CHARS } from './tts.mjs'

export function makeApi({ home, getConfig, log = () => {} }) {
  const ttsDir = () => join(home, 'cache')
  const coversDir = () => join(home, 'covers')
  const settingsFile = () => join(home, 'settings.json')

  /** 落盘的设置优先于插件 Config —— 设置页改完立刻生效，不用重启宿主 */
  const fileSettings = () => {
    try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) } catch { return {} }
  }
  const effective = () => ({ ...getConfig(), ...fileSettings() })

  const saveConfig = (patch = {}) => {
    const cur = fileSettings()
    const next = { ...cur }
    if (patch.preset !== undefined && PRESETS[patch.preset]) next.preset = patch.preset
    if (patch.maxChars !== undefined) next.maxChars = Math.min(300, Math.max(20, Number(patch.maxChars) || MAX_CHARS))
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
    return next
  }

  const status = () => {
    const cfg = effective()
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      voice: VOICE,
      preset: cfg.preset || DEFAULT_PRESET,
      presets: Object.entries(PRESETS).map(([k, v]) => ({ key: k, label: v.label, rate: v.rate, pitch: v.pitch })),
      maxChars: cfg.maxChars || MAX_CHARS,
      cache: cacheStats(ttsDir()),
      covers: existsSync(coversDir()) ? readdirSync(coversDir()).filter((f) => /\.(mp3|wav|amr)$/i.test(f)).length : 0,
      home,
    }
  }

  /** 试听：合成一句，返回可直接播放的 URL */
  const test = async ({ text, preset } = {}) => {
    const cfg = effective()
    const t = String(text || '你好呀，我是小鲸鱼。').slice(0, 300)
    const r = await speak(t, { dir: ttsDir(), preset: preset || cfg.preset || DEFAULT_PRESET, log })
    if (!r) return { ok: false, error: '合成失败（接口不通或超时）' }
    return { ok: true, url: `/api/voice/audio/${basename(r.path)}`, ms: r.ms, cached: r.cached, text: r.text }
  }

  /** 给别的插件用（QQ/TG 桥）：合成并返回绝对路径 */
  const synth = async (text, opts = {}) => {
    const cfg = effective()
    if (cfg.enabled === false) return null
    return speak(text, { dir: ttsDir(), preset: opts.preset || cfg.preset || DEFAULT_PRESET, log })
  }

  /** 翻唱成品：按歌名模糊找 */
  const cover = (name) => {
    const d = coversDir()
    if (!existsSync(d) || !name) return null
    const want = String(name).toLowerCase().replace(/\s+/g, '')
    const files = readdirSync(d).filter((f) => /\.(mp3|wav|amr)$/i.test(f))
    const hit = files.find((f) => f.toLowerCase().replace(/\s+/g, '').includes(want))
    if (!hit) return null
    const p = join(d, hit)
    return { path: p, file: hit, bytes: statSync(p).size }
  }

  return { status, test, synth, cover, saveConfig, effective, ttsDir, coversDir, prune: () => pruneCache(ttsDir()) }
}
