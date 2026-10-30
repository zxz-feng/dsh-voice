/**
 * dsh-voice —— 浏览器半端（「设置」里的「语音」那一页）
 * ============================================================================
 * 只干三件事：看嗓子好不好、换语气档、试听。
 * 语气档写进 `$DSH_HOME/voice/settings.json`，**下一句群消息就按新档走**，
 * 不用重启宿主 —— 这一点和 QQ/TG 那两个插件的设置页是同一个规矩。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    const API = '/api/voice'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录）' : res.status === 403 ? '（非同源被拦）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-voice-wrap] { display:flex; flex-direction:column; gap:14px; padding:2px 0 8px; }
[data-voice-card] { border:1px solid rgba(127,127,127,.22); border-radius:10px; padding:12px 14px; }
[data-voice-card] h4 { margin:0 0 10px; font-size:13px; font-weight:600; opacity:.85; }
[data-voice-row] { display:flex; align-items:center; gap:10px; margin:8px 0; flex-wrap:wrap; }
[data-voice-row] label { min-width:88px; font-size:13px; opacity:.8; }
[data-voice-presets] { display:flex; gap:8px; flex-wrap:wrap; }
[data-voice-pill] { border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit;
  border-radius:999px; padding:5px 12px; font-size:13px; cursor:pointer; }
[data-voice-pill][data-on="1"] { border-color:#4c8dff; background:rgba(76,141,255,.14); }
[data-voice-input] { flex:1; min-width:220px; padding:6px 9px; font-size:13px; color:inherit;
  background:rgba(127,127,127,.08); border:1px solid rgba(127,127,127,.3); border-radius:7px; }
[data-voice-btn] { padding:6px 14px; font-size:13px; border-radius:7px; cursor:pointer;
  border:1px solid rgba(127,127,127,.35); background:rgba(127,127,127,.1); color:inherit; }
[data-voice-btn][data-primary="1"] { border-color:#4c8dff; background:rgba(76,141,255,.18); }
[data-voice-btn]:disabled { opacity:.5; cursor:not-allowed; }
[data-voice-msg] { font-size:12px; opacity:.8; min-height:16px; }
[data-voice-msg][data-kind="err"] { color:#ff6b6b; }
[data-voice-msg][data-kind="ok"] { color:#4cc38a; }
[data-voice-stat] { display:flex; gap:16px; font-size:12px; opacity:.7; flex-wrap:wrap; }
[data-voice-audio] { width:100%; margin-top:8px; }
`
    if (!document.querySelector('style[data-voice-css]')) {
      const el = document.createElement('style')
      el.setAttribute('data-voice-css', '')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    function Panel() {
      const [st, setSt] = useState(null)
      const [preset, setPreset] = useState('')
      const [maxChars, setMaxChars] = useState('')
      const [text, setText] = useState('哼，你才想起来找我啊。行吧，今天心情好，不跟你计较。')
      const [url, setUrl] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState({ kind: '', text: '' })

      const load = useCallback(async () => {
        try {
          const s = await jget('/status')
          setSt(s); setPreset(s.preset); setMaxChars(String(s.maxChars))
        } catch (e) { setMsg({ kind: 'err', text: '读取失败：' + e.message }) }
      }, [])
      useEffect(() => { load() }, [load])

      const save = async () => {
        setBusy(true); setMsg({ kind: '', text: '' })
        try {
          const s = await jpost('/config', { preset, maxChars: Number(maxChars) })
          setSt(s); setMsg({ kind: 'ok', text: '已保存 —— 下一句群消息就按新档走' })
        } catch (e) { setMsg({ kind: 'err', text: '保存失败：' + e.message }) }
        setBusy(false)
      }
      const test = async () => {
        setBusy(true); setMsg({ kind: '', text: '' })
        try {
          const r = await jpost('/test', { text, preset })
          if (r.ok) { setUrl(r.url + '?t=' + Date.now()); setMsg({ kind: 'ok', text: `合成好了（${r.ms}ms${r.cached ? '，命中缓存' : ''}）` }) }
          else setMsg({ kind: 'err', text: r.error || '合成失败' })
        } catch (e) { setMsg({ kind: 'err', text: '合成失败：' + e.message }) }
        setBusy(false)
      }

      if (!st) return h('div', { 'data-voice-wrap': '' }, h('div', { 'data-voice-msg': '' }, '读取中…'))
      return h('div', { 'data-voice-wrap': '' },
        h('div', { 'data-voice-card': '' },
          h('h4', {}, '嗓子'),
          h('div', { 'data-voice-stat': '' },
            h('span', {}, '音色：' + st.voice),
            h('span', {}, '缓存：' + (st.cache?.files ?? 0) + ' 条 / ' + Math.round((st.cache?.bytes ?? 0) / 1048576) + 'MB'),
            h('span', {}, '翻唱库：' + st.covers + ' 首'),
            h('span', {}, '状态：' + (st.enabled ? '开' : '关'))),
          h('div', { 'data-voice-row': '' },
            h('label', {}, '语气档'),
            h('div', { 'data-voice-presets': '' }, (st.presets || []).map((p) => h('button', {
              key: p.key, 'data-voice-pill': '', 'data-on': preset === p.key ? '1' : '0',
              onClick: () => setPreset(p.key), title: `语速 ${p.rate} / 音高 ${p.pitch}`,
            }, p.label)))),
          h('div', { 'data-voice-row': '' },
            h('label', {}, '最长字数'),
            h('input', {
              'data-voice-input': '', type: 'number', min: 20, max: 300, value: maxChars,
              onChange: (e) => setMaxChars(e.target.value),
            }),
            h('button', { 'data-voice-btn': '', 'data-primary': '1', disabled: busy, onClick: save }, '保存'))),

        h('div', { 'data-voice-card': '' },
          h('h4', {}, '试听'),
          h('div', { 'data-voice-row': '' },
            h('input', {
              'data-voice-input': '', value: text, placeholder: '输入一句，用当前语气档念出来',
              onChange: (e) => setText(e.target.value),
            }),
            h('button', { 'data-voice-btn': '', disabled: busy, onClick: test }, busy ? '合成中…' : '念这句')),
          url ? h('audio', { 'data-voice-audio': '', src: url, controls: true }) : null,
          h('div', { 'data-voice-msg': '', 'data-kind': msg.kind }, msg.text)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'voice', order: 60, label: '语音' },
          () => h(Panel),
        ))
      },
    }
  },
})
