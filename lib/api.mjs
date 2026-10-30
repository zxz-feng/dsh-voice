/**
 * 语音插件的 HTTP 面：工具和设置页**都走这里**，谁都不许自己拼路径。
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { speak, cacheStats, pruneCache, PRESETS, VOICE, DEFAULT_PRESET, MAX_CHARS } from './tts.mjs'
import { gptsovitsSpeak, gptsovitsPing } from './gptsovits.mjs'
import { edgePlusRvc, rvcInfo, rvcLoadModel, rvcSetParams } from './rvc.mjs'

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
    if (patch.engine !== undefined) {
      next.engine = ['gptsovits', 'edge+rvc'].includes(patch.engine) ? patch.engine : 'edge'
    }
    for (const k of ['rvcUrl', 'rvcModel']) {
      if (patch[k] !== undefined) next[k] = String(patch[k] ?? '').slice(0, 300)
    }
    if (patch.rvcPitch !== undefined) next.rvcPitch = Math.max(-24, Math.min(24, Number(patch.rvcPitch) || 0))
    if (patch.rvcIndexRate !== undefined) next.rvcIndexRate = Math.max(0, Math.min(1, Number(patch.rvcIndexRate)))
    for (const k of ['gptsovitsUrl', 'gptsovitsRef', 'gptsovitsPrompt', 'gptsovitsPromptLang', 'gptsovitsTextLang']) {
      if (patch[k] !== undefined) next[k] = String(patch[k] ?? '').slice(0, 300)
    }
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
      engine: cfg.engine || 'edge',
      rvc: { url: cfg.rvcUrl || '', model: cfg.rvcModel || '', pitch: cfg.rvcPitch ?? 0, indexRate: cfg.rvcIndexRate ?? 0.5 },
      gptsovits: {
        url: cfg.gptsovitsUrl || '',
        ref: cfg.gptsovitsRef || '',
        prompt: cfg.gptsovitsPrompt || '',
      },
      home,
    }
  }

  /** 试听：合成一句，返回可直接播放的 URL */

  /**
   * 给别的插件用（QQ/TG 桥）：合成并返回绝对路径。
   * 引擎选择：设置里选 gptsovits 且配了地址 → 先试它；失败/没配 → 回落 Edge TTS。
   * 回落是**故意的**：宁可声音不像，也不能因为远端没开就哑掉。
   */
  const synth = async (text, opts = {}) => {
    const cfg = effective()
    if (cfg.enabled === false) return null
    const engine = opts.engine || cfg.engine
    if (engine === 'edge+rvc' && cfg.rvcUrl) {
      try {
        const r = await edgePlusRvc(text, {
          dir: ttsDir(),
          baseUrl: cfg.rvcUrl,
          model: cfg.rvcModel,
          edgeSpeak: (t) => speak(t, { dir: ttsDir(), preset: opts.preset || cfg.preset || DEFAULT_PRESET, log }),
          log,
        })
        if (r) return r
      } catch (e) {
        log('edge+rvc 失败，回落 Edge TTS：' + String(e?.message ?? e).slice(0, 80))
      }
    }
    const wantGsv = engine === 'gptsovits' && cfg.gptsovitsUrl && cfg.gptsovitsRef
    if (wantGsv) {
      try {
        const r = await gptsovitsSpeak(text, {
          dir: ttsDir(),
          baseUrl: cfg.gptsovitsUrl,
          refAudioPath: cfg.gptsovitsRef,
          promptText: cfg.gptsovitsPrompt || '',
          promptLang: cfg.gptsovitsPromptLang || 'zh',
          textLang: cfg.gptsovitsTextLang || 'zh',
          log,
        })
        if (r) return r
      } catch (e) {
        log('GPT-SoVITS 失败，回落 Edge TTS：' + String(e?.message ?? e).slice(0, 80))
      }
    }
    return speak(text, { dir: ttsDir(), preset: opts.preset || cfg.preset || DEFAULT_PRESET, log })
  }

  const test = async ({ text, preset, engine } = {}) => {
    const t = String(text || '你好呀，我是小鲸鱼。').slice(0, 300)
    const r = await synth(t, { preset, engine })
    if (!r) return { ok: false, error: '合成失败（接口不通或超时）' }
    return {
      ok: true, url: `/api/voice/audio/${basename(r.path)}`, ms: r.ms,
      cached: r.cached, engine: r.engine || 'edge', text: r.text || t,
    }
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

  return {
    status, test, synth, cover, saveConfig, effective, ttsDir, coversDir,
    ping: () => gptsovitsPing(effective().gptsovitsUrl),
    rvcInfo: () => rvcInfo(effective().rvcUrl),
    rvcLoad: (name) => rvcLoadModel(effective().rvcUrl, name),
    rvcParams: (prm) => rvcSetParams(effective().rvcUrl, prm),
    prune: () => pruneCache(ttsDir()),
  }
}
