/**
 * GPT-SoVITS 客户端（走它自带的 api_v2.py）
 * ============================================================================
 * 为什么不在这台机器上跑模型：1.7G 内存 / 2 核 / 无 GPU，加载就要 2~4G，
 * 一跑就把 QQ 和 TG 两个桥一起挤死。所以模型跑在**你自己的机器**上，
 * 这边只发 HTTP。地址可以是 Tailscale 内网地址，也可以是 frp 映射的公网口。
 *
 * ⚠️ 三个硬事实（来自 api_v2.py 的 TTS_Request）：
 *   1. `ref_audio_path` **必填**，没有默认值、没有 ref_free 开关 ——
 *      few-shot 架构每次合成都要一段 3~10 秒音频当音色条件。
 *      所谓"只给文本"= 把这条路径写死在配置里，由服务端替你带上。
 *   2. `prompt_text` 是那段参考音频的原文，给准确一点音色更稳。
 *   3. 返回的是**裸 wav 字节**，不是 JSON —— 别 .json()。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const key = (o) => createHash('sha1')
  .update(['gsv', o.baseUrl, o.refAudioPath, o.promptText || '', o.text].join('|'))
  .digest('hex').slice(0, 20)

/**
 * @returns {Promise<{path:string, ms:number, cached:boolean, engine:'gptsovits'}|null>}
 */
export async function gptsovitsSpeak(text, opts = {}) {
  const t = String(text ?? '').trim()
  const baseUrl = String(opts.baseUrl ?? '').trim().replace(/\/+$/, '')
  const refAudioPath = String(opts.refAudioPath ?? '').trim()
  if (!t || !baseUrl || !refAudioPath) return null

  const dir = opts.dir
  const fp = join(dir, key({ baseUrl, refAudioPath, promptText: opts.promptText, text: t }) + '.wav')
  if (existsSync(fp)) return { path: fp, ms: 0, cached: true, engine: 'gptsovits' }

  const t0 = Date.now()
  const body = {
    text: t,
    text_lang: opts.textLang || 'zh',
    ref_audio_path: refAudioPath,
    prompt_text: opts.promptText || '',
    prompt_lang: opts.promptLang || 'zh',
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: Number(opts.speed) > 0 ? Number(opts.speed) : 1.0,
  }
  const r = await fetch(baseUrl + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(opts.timeoutMs) || 30000),
  })
  if (!r.ok) {
    const why = await r.text().catch(() => '')
    throw new Error(`HTTP ${r.status}${why ? '：' + why.slice(0, 80) : ''}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('返回了空音频')
  if (buf.length < 2048) throw new Error(`音频太小（${buf.length}B），八成是报错文本`)
  writeFileSync(fp, buf)
  return { path: fp, ms: Date.now() - t0, cached: false, engine: 'gptsovits' }
}

/** 探活：api_v2 有没有起来、模型加载了没 */
export async function gptsovitsPing(baseUrl, timeoutMs = 4000) {
  const u = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!u) return { ok: false, error: '没配地址' }
  try {
    const r = await fetch(u + '/docs', { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 80) }
  }
}
