/**
 * RVC 客户端：假服务器测协议，真合成只在 SKIP_NET!=1 时跑。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rvcConvert, rvcInfo, rvcLoadModel, rvcSetParams, edgePlusRvc } from '../lib/rvc.mjs'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? ' — ' + e : ''))) }

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096, 3)])
let lastB64 = '', lastParams = null, lastModel = null, mode = 'ok'
const srv = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => {
    const j = b ? JSON.parse(b) : {}
    if (req.url === '/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(['anjie.pth', 'other.pth']))
    }
    if (req.url === '/params' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ f0up_key: 0, index_rate: 0.5 }))
    }
    if (req.url === '/params' && req.method === 'POST') { lastParams = j.params; res.writeHead(200); return res.end('{}') }
    if (req.url.startsWith('/models/') && req.method === 'POST') { lastModel = decodeURIComponent(req.url.slice(8)); res.writeHead(200); return res.end('{}') }
    if (req.url === '/convert') {
      lastB64 = j.audio_data || ''
      if (mode === 'fail') { res.writeHead(500); return res.end('模型没加载') }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      return res.end(WAV)
    }
    res.writeHead(404); res.end()
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${srv.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'rvc-'))

const inp = Buffer.from('fake-wav-bytes')
const out = await rvcConvert(inp, { baseUrl })
ok('转换返回 wav', out.length === WAV.length && out.subarray(0, 4).toString() === 'RIFF')
ok('请求体是 base64', Buffer.from(lastB64, 'base64').toString() === 'fake-wav-bytes')

const info = await rvcInfo(baseUrl)
ok('info 拿到模型列表', info.ok && info.models.includes('anjie.pth'))
ok('info 拿到参数', info.params?.index_rate === 0.5)

ok('加载模型', (await rvcLoadModel(baseUrl, 'anjie.pth')).ok && lastModel === 'anjie.pth')
ok('调参数', (await rvcSetParams(baseUrl, { f0up_key: 3 })).ok && lastParams?.f0up_key === 3)

mode = 'fail'
let e1 = ''
try { await rvcConvert(inp, { baseUrl }) } catch (e) { e1 = e.message }
ok('500 会抛错', e1.includes('500'), e1)
mode = 'ok'

let e2 = ''
try { await rvcConvert(inp, { baseUrl: '' }) } catch (e) { e2 = e.message }
ok('没配地址抛错', e2.includes('没配'), e2)

ok('没配地址时 edgePlusRvc 返回 null', (await edgePlusRvc('你好', { dir, baseUrl: '' })) === null)

if (process.env.SKIP_NET === '1') {
  console.log('\n（SKIP_NET=1，跳过 edge+rvc 真链路）')
} else {
  // 真链路：Edge 合成 → ffmpeg 转 wav → RVC（假服务器返回固定 wav）
  const r = await edgePlusRvc('测试一下这条链路。', {
    dir, baseUrl,
    edgeSpeak: async () => ({ path: (await import('../lib/tts.mjs')).speak ? (await (await import('../lib/tts.mjs')).speak('测试一下这条链路。', { dir, preset: 'x1' }))?.path : null }),
  })
  ok('edge+rvc 真链路出文件', !!r?.path && r.engine === 'edge+rvc')
}

srv.close()
console.log(`\n===== ✓ RVC ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
