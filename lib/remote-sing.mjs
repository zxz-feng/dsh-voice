/**
 * 远程换声：把一首歌发给本地那台机器的 /sing，拿回「她唱的」mp3
 *
 * 为什么在本地：云端只有 1.7G 内存，demucs 一加载就被 OOM 杀掉
 *（2026-10-30 21:16:47，python RSS 876MB，kernel oom-kill）。
 * 本地有 GPU，分离 1 分钟音频 2~5 秒。
 */
import { readFile, writeFile } from 'node:fs/promises'

export async function remoteSing({ url, inputPath, outPath, pitch = 0, model = '', timeoutMs = 180_000 }) {
  const base = String(url ?? '').replace(/\/+$/, '')
  if (!base) throw new Error('没配 singUrl（本地 /sing 接口地址）')
  const buf = await readFile(inputPath)
  if (!buf.length) throw new Error('输入音频是空的')

  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'in.mp3')
  fd.append('pitch', String(pitch))
  if (model) fd.append('model_name', model)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}/sing`, { method: 'POST', body: fd, signal: ctrl.signal })
    if (!r.ok) throw new Error(`/sing 返回 ${r.status}`)
    const out = Buffer.from(await r.arrayBuffer())
    // 少于 2KB 基本是错误页/空音频，别当成功往下走
    if (out.length < 2048) throw new Error(`返回太小（${out.length}B），不像音频`)
    await writeFile(outPath, out)
    return { path: outPath, bytes: out.length }
  } finally {
    clearTimeout(timer)
  }
}
