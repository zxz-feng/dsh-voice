/**
 * 语音插件的 HTTP 面：工具和设置页**都走这里**，谁都不许自己拼路径。
 */
import { remoteSing } from './remote-sing.mjs'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { speak, cacheStats, pruneCache, PRESETS, VOICE, DEFAULT_PRESET, MAX_CHARS } from './tts.mjs'
import { gptsovitsSpeak, gptsovitsPing } from './gptsovits.mjs'
import { edgePlusRvc, rvcInfo, rvcPing, rvcLoadModel, rvcSetParams } from './rvc.mjs'

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
    if (patch.maxChars !== undefined) next.maxChars = Math.min(3000, Math.max(20, Number(patch.maxChars) || MAX_CHARS))
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    if (patch.engine !== undefined) {
      next.engine = ['gptsovits', 'edge+rvc'].includes(patch.engine) ? patch.engine : 'edge'
    }
    for (const k of ['rvcUrl', 'rvcModel']) {
      if (patch[k] !== undefined) next[k] = String(patch[k] ?? '').slice(0, 300)
    }
    if (patch.rvcPitch !== undefined) next.rvcPitch = Math.max(-24, Math.min(24, Number(patch.rvcPitch) || 0))
    if (patch.rvcIndexRate !== undefined) next.rvcIndexRate = Math.max(0, Math.min(1, Number(patch.rvcIndexRate)))
    // 咬字参数「固定」开关：开了才给本地 /sing 传 force=1，让每段都用上面这套
    // protect/index_rate，不再按每段音频自动调。默认关 —— 2026-11-08 主人要求
    // 先做成可切换、不默认生效（安静或混响重的曲子可能因此咬字变糊）。
    if (patch.rvcForce !== undefined) next.rvcForce = !!patch.rvcForce
    // 本地 /sing 接口（demucs 分离 + RVC + 混音都在那台机器上做）
    if (patch.singUrl !== undefined) next.singUrl = String(patch.singUrl ?? '').slice(0, 300)
    for (const k of ['gptsovitsUrl', 'gptsovitsRef', 'gptsovitsPrompt', 'gptsovitsPromptLang', 'gptsovitsTextLang']) {
      if (patch[k] !== undefined) next[k] = String(patch[k] ?? '').slice(0, 300)
    }
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
    return next
  }

  /**
   * 问本地 /sing 有哪些模型（设置页的模型名要做成下拉，不能让人手打）。
   * 2026-11-07 主人要求：「最好能在 dsh 里面切换」。
   * 服务那头 rvc_models/ 下每个一级目录就是一个模型，所以向它现问，
   * 不在设置里另存一份名单 —— 两边不一致比没有更糟。
   */
  // 嗓子名 → 人话。名字归本地 rvc_models/ 目录，小名归这里（和 QQ 桥那份一致）。
  // 加新模型只要丢目录，没写小名就显示原名，不报错。
  const MODEL_LABELS = {
    amiya: '阿米娅 · 初版（唱得最稳）',
    amiya2: '阿米娅 · 重训（100 轮那版）',
    anjie: '安洁莉娜 · 初版',
    anjie2: '安洁莉娜 · 重训',
    feiyu: '肥鱼大小姐（她自己的声音）',
  }
  const DEFAULT_MODEL = 'amiya'

  /** 有哪些嗓子 + 小名 + 谁是默认；连不上返回空数组 */
  const singModelList = async (url) => {
    const base = String(url || effective().singUrl || '').trim()
    if (!base) return []
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(6000) })
      if (!r.ok) return []
      const j = await r.json()
      const models = Array.isArray(j.models) ? j.models.map(String) : []
      return models.map((m) => ({
        id: m,
        label: MODEL_LABELS[m] ? `${m} · ${MODEL_LABELS[m]}` : m,
        isDefault: m === DEFAULT_MODEL,
      }))
    } catch { return [] }
  }

  const singModels = async (url) => (await singModelList(url)).map((m) => m.id)

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
      sing: { url: cfg.singUrl || '' },
      rvc: { url: cfg.rvcUrl || '', model: cfg.rvcModel || '', pitch: cfg.rvcPitch ?? 0, indexRate: cfg.rvcIndexRate ?? 0.5, force: !!cfg.rvcForce },
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
  /**
   * RVC 熔断：本地那台机器随时可能休眠，而连不上的代价是**整条合成超时**
   * （实测 12.28 秒才回落，把 QQ 桥的 12 秒预算吃光 → 语音直接变成文字）。
   * 所以探活失败后 60 秒内不再尝试，直接走 Edge。
   */
  // 本地只有一块 GPU：并发合成会在 GPT-SoVITS 里排队，排在后面的那个等到超时，
  // 于是「一条成功、下一条掉 Edge」。串行化：前一个结束（不管成败）再发下一个。
  let gsvChain = Promise.resolve()
  const gsvSerial = (fn) => {
    const run = gsvChain.then(fn, fn)
    gsvChain = run.then(() => undefined, () => undefined)
    return run
  }

  let rvcDownUntil = 0
  const RVC_RETRY_MS = 20_000

  const synth = async (text, opts = {}) => {
    const cfg = effective()
    if (cfg.enabled === false) return null
    const engine = opts.engine || cfg.engine
    if (engine === 'edge+rvc' && cfg.rvcUrl && Date.now() >= rvcDownUntil) {
      try {
        if (!(await rvcPing(cfg.rvcUrl))) throw new Error('RVC 连不上（本地机器休眠 / 隧道断）')
        const r = await edgePlusRvc(text, {
          dir: ttsDir(),
          baseUrl: cfg.rvcUrl,
          model: cfg.rvcModel,
          edgeSpeak: (t) => speak(t, { dir: ttsDir(), preset: opts.preset || cfg.preset || DEFAULT_PRESET, log }),
          log,
        })
        if (r) return r
      } catch (e) {
        rvcDownUntil = Date.now() + RVC_RETRY_MS
        log('edge+rvc 失败，回落 Edge TTS：' + String(e?.message ?? e).slice(0, 80)
          + `（${Math.round(RVC_RETRY_MS / 1000)} 秒内不再试 RVC）`)
      }
    }
    const wantGsv = engine === 'gptsovits' && cfg.gptsovitsUrl && cfg.gptsovitsRef
    if (wantGsv) {
      try {
        const r = await gsvSerial(() => gptsovitsSpeak(text, {
          dir: ttsDir(),
          baseUrl: cfg.gptsovitsUrl,
          refAudioPath: cfg.gptsovitsRef,
          promptText: cfg.gptsovitsPrompt || '',
          promptLang: cfg.gptsovitsPromptLang || 'zh',
          textLang: cfg.gptsovitsTextLang || 'zh',
          timeoutMs: 90000,
          log,
        }))
        if (r) return r
      } catch (e) {
        log('GPT-SoVITS 失败，回落 Edge TTS：' + String(e?.message ?? e).slice(0, 80))
      }
    }
    return speak(text, { dir: ttsDir(), preset: opts.preset || cfg.preset || DEFAULT_PRESET, log })
  }

  const test = async ({ text, preset, engine } = {}) => {
    const t = String(text || '你好呀，我是小鲸鱼。').slice(0, 3000)
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
    status, test, synth, cover, saveConfig, effective, ttsDir, coversDir, singModels, singModelList,
    ping: () => gptsovitsPing(effective().gptsovitsUrl),
    /** 一首歌 → 她唱（走本地 /sing）；没配就报错，由调用方回落原曲 */
    sing: async ({ inputPath, outPath, pitch } = {}) => {
      const cfg = effective()
      if (!cfg.singUrl) throw new Error('没配 singUrl')
      if (!inputPath) throw new Error('没给输入文件')
      const out = outPath || join(coversDir(), `sing-${Date.now()}.mp3`)
      if (!existsSync(coversDir())) mkdirSync(coversDir(), { recursive: true })
      const r = await remoteSing({
        url: cfg.singUrl,
        inputPath,
        outPath: out,
        pitch: pitch ?? (cfg.rvcPitch ?? 0),
        model: cfg.rvcModel || '',
      })
      return { ok: true, path: r.path, bytes: r.bytes }
    },
    rvcInfo: () => rvcInfo(effective().rvcUrl),
    rvcLoad: (name) => rvcLoadModel(effective().rvcUrl, name),
    rvcParams: (prm) => rvcSetParams(effective().rvcUrl, prm),
    prune: () => pruneCache(ttsDir()),
  }
}
