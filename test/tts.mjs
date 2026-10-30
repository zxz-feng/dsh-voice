/**
 * 纯函数 + 一次真合成。零 token（不碰大模型），只碰微软的免费接口。
 * 设 SKIP_NET=1 可跳过真合成（离线环境跑）。
 */
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanForTTS, clampText, cacheKey, speak, PRESETS, DEFAULT_PRESET, MAX_CHARS } from '../lib/tts.mjs'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log(`  ✗ ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`))
}
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)) }

console.log('— 清洗 —')
eq('去 CQ 码', cleanForTTS('看这个[CQ:image,file=a.jpg]好看吗'), '看这个 好看吗')
eq('去链接', cleanForTTS('看 https://b23.tv/xx 这个'), '看 这个')
eq('去 @', cleanForTTS('@小鲸鱼 在吗'), '在吗')
eq('折叠空白', cleanForTTS('  a   b  '), 'a b')
ok('保留标点', cleanForTTS('真的吗？好！').includes('？'))

console.log('— 截断 —')
eq('短句不动', clampText('你好'), '你好')
ok('长句截断', clampText('啊'.repeat(200)).length <= MAX_CHARS + 1)
ok('截断留省略号', clampText('句子。'.repeat(60)).endsWith('…'))
ok('优先断在标点', clampText('一二三四五六七八九十。'.repeat(20)).includes('。'))

console.log('— 缓存键 —')
ok('同文本同档同键', cacheKey('你好', 'x1') === cacheKey('你好', 'x1'))
ok('换档换键', cacheKey('你好', 'x1') !== cacheKey('你好', 'x4'))
ok('换文本换键', cacheKey('你好', 'x1') !== cacheKey('再见', 'x1'))
eq('未知档回落默认', cacheKey('你好', 'nope'), cacheKey('你好', DEFAULT_PRESET))
ok('四档齐全', ['x1', 'x2', 'x3', 'x4'].every((k) => PRESETS[k]))

if (process.env.SKIP_NET === '1') {
  console.log('\n（SKIP_NET=1，跳过真合成）')
} else {
  console.log('— 真合成（微软免费接口）—')
  const dir = mkdtempSync(join(tmpdir(), 'voice-'))
  const t0 = Date.now()
  const a = await speak('测试一下，我是小鲸鱼。', { dir, preset: 'x1' })
  ok('合成成功', !!a && existsSync(a.path) && statSync(a.path).size > 1024)
  ok('耗时 <8s', Date.now() - t0 < 8000)

  const b = await speak('测试一下，我是小鲸鱼。', { dir, preset: 'x1' })
  ok('第二次命中缓存', !!b?.cached)
  ok('缓存 0ms 级', (b?.ms ?? 999) < 50)

  // ⭐ 回归：prosody 必须真的生效 —— 以前传给 setMetadata 会被静默忽略，
  //    结果四档文件一模一样（MD5 相同）。这里用"不同档 → 不同文件 → 不同字节数"守住。
  const c = await speak('测试一下，我是小鲸鱼。', { dir, preset: 'x3' })
  ok('换档生成新文件', !!c && c.path !== a.path)
  ok('换档字节数不同（prosody 真生效）', statSync(c.path).size !== statSync(a.path).size)
}

console.log(`\n===== ✓ TTS ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
