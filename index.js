/**
 * dsh-voice —— 小鲸鱼的嗓子
 * ============================================================================
 * 只做一件事：**把文字变成一段语音**。不管"什么时候发、发到哪个群" —— 那是各平台桥的事。
 *
 * 对外的三张脸：
 *   服务  ctx.voice.speak(text, {preset}) → {path, ms, cached} | null
 *   工具  voice_speak / voice_status / voice_test
 *   路由  GET  /api/voice/status
 *         POST /api/voice/test      （设置页试听）
 *         GET  /api/voice/audio/:f  （把 mp3 递回浏览器）
 *
 * 音色只有 zh-CN-XiaoyiNeural 一个，四档语气靠 rate/pitch 两轴调（见 lib/tts.mjs）。
 * 依赖 msedge-tts：纯 JS、无编译、无 python。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { loadDeps } from './lib/deps.mjs'
import { makeApi } from './lib/api.mjs'
import { sendJson, sendBinary, readBody } from './lib/http.mjs'
import { PRESETS, DEFAULT_PRESET, MAX_CHARS, VOICE } from './lib/tts.mjs'

const PLUGIN_ID = 'voice'
const API_PREFIX = '/api/voice'

const { z, defineTool } = await loadDeps()

export const name = PLUGIN_ID
export const inject = ['tools', 'webServer']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  preset: z.string().default(DEFAULT_PRESET).extra('volatile', true),
  maxChars: z.number().default(MAX_CHARS).extra('volatile', true),
  home: z.string().default('').extra('volatile', true),
})

const textOutput = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v ?? '') }] }

export function apply(ctx, config = {}) {
  // ⚠️ 不要在这里调 Config(config)：schemastery 的对象**不是**解析函数，
  //    调它只会拿回一堆内部 schema（`{enabled:{}}`），家目录会变成 [object Object]。
  //    宿主已经按 Config 校验过一遍，这里直接用原始 config + 自己的兜底。
  const cfg = () => {
    const c = config || {}
    return {
      enabled: c.enabled !== false,
      preset: PRESETS[c.preset] ? c.preset : DEFAULT_PRESET,
      maxChars: Math.min(300, Math.max(20, Number(c.maxChars) || MAX_CHARS)),
      home: String(c.home || '').trim(),
    }
  }

  // 家目录：显式配置 > $DSH_HOME/voice > ~/.dsh/voice
  const resolveHome = () => {
    const explicit = cfg().home
    if (explicit) return explicit
    const base = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
    return join(base, 'voice')
  }
  const HOME = resolveHome()
  for (const sub of ['cache', 'covers', 'models']) {
    const p = join(HOME, sub)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }

  const log = (m) => { try { console.log(`[voice] ${m}`) } catch { /* 日志失败不影响合成 */ } }
  const api = makeApi({ home: HOME, getConfig: cfg, log })

  // ── 服务：别的插件（QQ/TG 桥）用这一行拿到嗓子 ───────────────────────────
  ctx.provide('voice', {
    speak: (text, opts) => api.synth(text, opts),
    cover: (name) => api.cover(name),
    status: () => api.status(),
    voice: VOICE,
  })

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args) {
      try { return await spec.execute(args) } catch (e) { return `出错：${String(e?.message ?? e).slice(0, 160)}` }
    },
  }))

  tool({
    name: 'voice_speak',
    description: '把一句话合成语音（小鲸鱼的音色）。返回文件路径，交给平台桥去发。preset: x1 原声 / x2 轻快 / x3 软糯 / x4 带刺。',
    parameters: {
      text: { required: true, type: 'string' },
      preset: { type: 'string' },
    },
    async execute({ text, preset }) {
      const r = await api.synth(text, { preset })
      if (!r) return '合成失败（接口不通或超时），改发文字吧'
      return `已合成：${r.path}（${r.ms}ms${r.cached ? '，命中缓存' : ''}，${r.text.length} 字）`
    },
  })

  tool({
    name: 'voice_status',
    description: '看语音插件状态：音色、语气档、缓存占用、翻唱库数量、家目录。',
    parameters: {},
    async execute() {
      const s = api.status()
      return [
        `音色 ${s.voice} · 默认档 ${s.preset} · ${s.enabled ? '已开' : '已关'}`,
        `缓存 ${s.cache.files} 个 / ${(s.cache.bytes / 1024 / 1024).toFixed(1)}MB · 翻唱 ${s.covers} 首`,
        `家目录 ${s.home}`,
      ].join('\n')
    },
  })

  tool({
    name: 'voice_test',
    description: '合成一句试听（返回可播放的 URL），用来调语气档。',
    parameters: {
      text: { type: 'string' },
      preset: { type: 'string' },
    },
    async execute({ text, preset }) {
      const r = await api.test({ text, preset })
      return r.ok ? `试听：${r.url}（${r.ms}ms${r.cached ? '，缓存' : ''}）` : `试听失败：${r.error}`
    },
  })

  // ── 路由 ────────────────────────────────────────────────────────────────
  const route = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const p = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && p === '/status') return sendJson(res, 200, api.status())

      if (req.method === 'POST' && p === '/config') {
        const body = await readBody(req)
        api.saveConfig(body || {})
        log('设置已保存：' + JSON.stringify(api.effective()))
        return sendJson(res, 200, api.status())
      }

      if (req.method === 'POST' && p === '/test') {
        const body = await readBody(req)
        const r = await api.test(body)
        return sendJson(res, r.ok ? 200 : 502, r)
      }

      // 音频：只允许读缓存目录里的文件（basename 防穿越）
      if (req.method === 'GET' && p.startsWith('/audio/')) {
        const f = basename(decodeURIComponent(p.slice('/audio/'.length)))
        const fp = join(api.ttsDir(), f)
        if (!/\.mp3$/i.test(f) || !existsSync(fp)) return sendJson(res, 404, { ok: false, error: '没有这个音频' })
        return sendBinary(res, 200, readFileSync(fp), 'audio/mpeg')
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 200) })
    }
  }

  if (ctx.webServer?.register) {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: route }), 'voice: 路由')
  }

  // 每天清一次过期缓存（零 token，纯 fs）
  try {
    const t = setInterval(() => { try { const n = api.prune(); if (n) log(`清掉 ${n} 个过期缓存`) } catch { /* ignore */ } }, 6 * 3600_000)
    t.unref?.()
    ctx.effect(() => () => clearInterval(t), 'voice: 缓存清理')
  } catch { /* 定时器起不来不影响合成 */ }

  log(`已挂载（家=${HOME}，音色=${VOICE}，档=${cfg().preset}）`)
}
