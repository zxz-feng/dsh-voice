/**
 * RVC 客户端（走 rvc-python 的 api 模式，默认 :5050）
 * ============================================================================
 * RVC 只做**音频→音频**（换音色），不做"文字→语音"。所以链路是两段：
 *
 *     文字 ─Edge TTS─> 普通说话声 ─RVC─> 她的声音
 *     原唱人声 ───────RVC──────────────> 她唱（旋律不变）
 *
 * 为什么值得做这条路：RVC 对素材极宽容（10 分钟音频就能训），比 GPT-SoVITS
 * 好训得多；代价是音质中等 —— 它会把 TTS 的机械感一起放大。
 *
 * 接口（rvc-python api 模式）：
 *   POST /convert  {audio_data: base64}      → 裸 wav 字节
 *   GET  /models                             → 模型名数组
 *   POST /models/{name}                      → 加载模型
 *   POST /params   {params: {...}}           → 调 f0up_key / index_rate / f0method
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const norm = (u) => String(u ?? '').trim().replace(/\/+$/, '')

/** 用 ffmpeg 转成 RVC 爱吃的单声道 44.1k wav（Edge TTS 给的是 mp3） */
export function toWav(inputPath, outPath, { sr = 44100 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-ar', String(sr), '-ac', '1', '-c:a', 'pcm_s16le', outPath])
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(outPath) : reject(new Error('ffmpeg 失败：' + err.slice(0, 120)))))
  })
}

/** 探活 + 当前加载的模型 */
export async function rvcInfo(baseUrl, timeoutMs = 4000) {
  const u = norm(baseUrl)
  if (!u) return { ok: false, error: '没配地址' }
  try {
    const [models, params] = await Promise.all([
      fetch(u + '/models', { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(u + '/params', { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    return { ok: true, models: Array.isArray(models) ? models : [], params: params || {} }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 80) }
  }
}

/** 加载模型（切换音色） */
export async function rvcLoadModel(baseUrl, name, timeoutMs = 30000) {
  const u = norm(baseUrl)
  if (!u || !name) return { ok: false, error: '缺地址或模型名' }
  const r = await fetch(u + '/models/' + encodeURIComponent(name), {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
  })
  return r.ok ? { ok: true } : { ok: false, error: 'HTTP ' + r.status }
}

/** 调参数（f0up_key 升调、index_rate 检索强度、f0method harvest/rmvpe） */
export async function rvcSetParams(baseUrl, params, timeoutMs = 10000) {
  const u = norm(baseUrl)
  if (!u) return { ok: false, error: '没配地址' }
  const r = await fetch(u + '/params', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: params || {} }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return r.ok ? { ok: true } : { ok: false, error: 'HTTP ' + r.status }
}

/**
 * 核心：把一段音频换成目标音色。
 * @param {Buffer} wavBuffer 输入 wav
 * @returns {Promise<Buffer>} 输出 wav
 */
export async function rvcConvert(wavBuffer, { baseUrl, timeoutMs = 120000 } = {}) {
  const u = norm(baseUrl)
  if (!u) throw new Error('没配 RVC 地址')
  const r = await fetch(u + '/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_data: wavBuffer.toString('base64') }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) {
    const why = await r.text().catch(() => '')
    throw new Error(`RVC HTTP ${r.status}${why ? '：' + why.slice(0, 80) : ''}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 2048) throw new Error(`RVC 返回太小（${buf.length}B）`)
  return buf
}

/**
 * 一步到位：文本 → Edge TTS → wav → RVC → 落盘。
 * @returns {Promise<{path:string, ms:number, cached:boolean, engine:'edge+rvc'}|null>}
 */
export async function edgePlusRvc(text, opts = {}) {
  const { dir, baseUrl, edgeSpeak, log = () => {} } = opts
  if (!norm(baseUrl) || !dir) return null
  const t = String(text ?? '').trim()
  if (!t) return null

  const key = createHash('sha1').update(['rvc', norm(baseUrl), opts.model || '', t].join('|')).digest('hex').slice(0, 20)
  const out = join(dir, key + '.wav')
  if (existsSync(out)) return { path: out, ms: 0, cached: true, engine: 'edge+rvc' }

  const t0 = Date.now()
  // 1) 先用 Edge 合成（这一步永远不会哑）
  const base = await edgeSpeak(t)
  if (!base?.path) return null
  // 2) 转 wav
  const wav = join(dir, key + '.src.wav')
  await toWav(base.path, wav)
  // 3) 换音色
  const buf = await rvcConvert(readFileSync(wav), { baseUrl, timeoutMs: opts.timeoutMs })
  writeFileSync(out, buf)
  log(`edge+rvc 完成：${Date.now() - t0}ms，${Math.round(buf.length / 1024)}KB`)
  return { path: out, ms: Date.now() - t0, cached: false, engine: 'edge+rvc' }
}
