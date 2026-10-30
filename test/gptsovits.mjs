/**
 * GPT-SoVITS 客户端：用本地假服务器测，不依赖真模型、零 token。
 * 守三件事：① 请求体字段对（ref_audio_path 必填）② 裸 wav 能落盘 ③ 远端挂了要回落 Edge
 */
import { createServer } from 'node:http'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gptsovitsSpeak, gptsovitsPing } from '../lib/gptsovits.mjs'

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (extra ? ' — ' + extra : ''))) }

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096, 7)])
let lastBody = null
let mode = 'ok'
const srv = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => {
    if (req.url === '/docs') { res.writeHead(200); return res.end('swagger') }
    lastBody = JSON.parse(b || '{}')
    if (mode === 'fail') { res.writeHead(500); return res.end('模型没加载') }
    if (mode === 'empty') { res.writeHead(200); return res.end(Buffer.alloc(0)) }
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(WAV)
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${srv.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'gsv-'))

const r1 = await gptsovitsSpeak('你好呀', { dir, baseUrl, refAudioPath: '/x/ref.wav', promptText: '参考原文' })
ok('合成成功', !!r1?.path && existsSync(r1.path))
ok('落盘是 wav 大小', r1 && statSync(r1.path).size === WAV.length)
ok('请求带 ref_audio_path', lastBody?.ref_audio_path === '/x/ref.wav')
ok('请求带 prompt_text', lastBody?.prompt_text === '参考原文')
ok('请求带 text_lang', lastBody?.text_lang === 'zh')
ok('media_type=wav', lastBody?.media_type === 'wav')

const r2 = await gptsovitsSpeak('你好呀', { dir, baseUrl, refAudioPath: '/x/ref.wav', promptText: '参考原文' })
ok('第二次命中缓存', r2?.cached === true && r2.ms === 0)

mode = 'fail'
let threw = ''
try { await gptsovitsSpeak('另一句', { dir, baseUrl, refAudioPath: '/x/ref.wav' }) } catch (e) { threw = e.message }
ok('远端 500 会抛错（交给上层回落）', threw.includes('500'), threw)

mode = 'empty'
let threw2 = ''
try { await gptsovitsSpeak('第三句', { dir, baseUrl, refAudioPath: '/x/ref.wav' }) } catch (e) { threw2 = e.message }
ok('空音频会抛错', threw2.includes('空音频'), threw2)

ok('没配地址返回 null', (await gptsovitsSpeak('x', { dir, baseUrl: '', refAudioPath: '/x' })) === null)
ok('没配参考音频返回 null', (await gptsovitsSpeak('x', { dir, baseUrl, refAudioPath: '' })) === null)

mode = 'ok'
const p1 = await gptsovitsPing(baseUrl)
ok('探活 ok', p1.ok === true)
const p2 = await gptsovitsPing('http://127.0.0.1:1')
ok('探活失败不抛', p2.ok === false && !!p2.error)

srv.close()
console.log(`\n===== ✓ GPT-SoVITS ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
