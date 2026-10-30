/** HTTP 面：状态 / 翻唱库查找 / 目录自建（不碰网络） */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApi } from '../lib/api.mjs'

let pass = 0, fail = 0
const ok = (n, c) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)) }

const home = mkdtempSync(join(tmpdir(), 'voice-api-'))
for (const d of ['cache', 'covers']) mkdirSync(join(home, d), { recursive: true })
writeFileSync(join(home, 'covers', '起风了-小鲸鱼.mp3'), Buffer.alloc(2048))
writeFileSync(join(home, 'covers', '夜曲-小鲸鱼.mp3'), Buffer.alloc(2048))

const api = makeApi({ home, getConfig: () => ({ enabled: true, preset: 'x2', maxChars: 120 }) })

const s = api.status()
ok('status.ok', s.ok === true)
ok('音色是 Xiaoyi', s.voice === 'zh-CN-XiaoyiNeural')
ok('四档语气', s.presets.length === 4)
ok('翻唱数 2', s.covers === 2)

ok('翻唱命中（中文）', api.cover('起风了')?.file === '起风了-小鲸鱼.mp3')
ok('翻唱命中（带空格）', !!api.cover(' 夜 曲 '))
ok('翻唱不命中', api.cover('不存在的歌') === null)
ok('空名不命中', api.cover('') === null)

console.log(`\n===== ✓ API ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
