// ==UserScript==
// @name         SoundCloud downloader with ID3 metadata (for foobar)
// @namespace    https://github.com/adrxkn/Soundcloud-metadata-for-foobar
// @version      0.2
// @description  Download SoundCloud progressive MP3s and embed ID3 tags
// @match        https://soundcloud.com/*
// @grant        GM_xmlhttpRequest
// @connect      api-v2.soundcloud.com
// ==/UserScript==

(function () {
  'use strict'

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve()
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  async function loadDeps() {
    await loadScript('https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.js')
    await loadScript('https://cdn.jsdelivr.net/npm/browser-id3-writer@4.4.0/dist/browser-id3-writer.min.js')
  }

  function getCleanTrackUrl() {
    const u = new URL(location.href)
    return u.origin + u.pathname
  }

  let _clientId = null

  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const cid = new URL(url, location.href).searchParams.get('client_id')
      if (cid) _clientId = cid
    } catch (_) {}
    return origOpen.apply(this, arguments)
  }

  const origFetch = window.fetch
  window.fetch = function (input, init) {
    try {
      const urlStr = typeof input === 'string' ? input : input.url
      const cid = new URL(urlStr, location.href).searchParams.get('client_id')
      if (cid) _clientId = cid
    } catch (_) {}
    return origFetch.apply(this, arguments)
  }

  function waitForClientId(timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (_clientId) return resolve(_clientId)
      const start = Date.now()
      const iv = setInterval(() => {
        if (_clientId) { clearInterval(iv); resolve(_clientId) }
        else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error('Timed out waiting for client_id')) }
      }, 200)
    })
  }

  function sanitizeFilename(name) {
    return name.replace(/[\/\?<>\\:\*\|":]/g, '').replace(/\s+/g, ' ').trim()
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a')
    document.body.appendChild(a)
    a.href = url
    a.download = name
    a.click()
    a.remove()
  }

  const btn = {
    init() {
      this.el = document.createElement('button')
      this.el.textContent = '↓ MP3'
      this.el.classList.add('sc-button', 'sc-button-medium', 'sc-button-responsive', 'sc-button-secondary')
      this.el.style.cssText = 'font-weight:600;padding:0 12px;'
    },
    cb() {
      const par = document.querySelector('.sc-button-toolbar .sc-button-group')
      if (par && this.el.parentElement !== par) par.insertAdjacentElement('beforeend', this.el)
    },
    attach() {
      this.detach()
      this.observer = new MutationObserver(this.cb.bind(this))
      this.observer.observe(document.body, { childList: true, subtree: true })
      this.cb()
    },
    detach() {
      if (this.observer) this.observer.disconnect()
    }
  }
  btn.init()

  let controller = null

  async function load() {
    btn.detach()
    if (/^\/(you|stations|discover|stream|upload|search|settings)/.test(location.pathname)) return

    let clientId
    try {
      clientId = await waitForClientId()
    } catch (e) {
      console.warn('[SC-DL] Could not get client_id:', e.message)
      return
    }

    if (controller) { controller.abort(); controller = null }
    controller = new AbortController()

    let result
    try {
      const cleanUrl = getCleanTrackUrl()
      result = await fetch(
        `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(cleanUrl)}&client_id=${clientId}`,
        { signal: controller.signal }
      ).then(r => {
        if (!r.ok) throw new Error(`Resolve failed: HTTP ${r.status}`)
        return r.json()
      })
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[SC-DL] resolve error:', e.message)
      return
    }

    if (result.kind !== 'track') return

    btn.el.onclick = async () => {
      btn.el.textContent = 'Loading…'
      btn.el.disabled = true
      try {
        await loadDeps()

        const progressive = result.media.transcodings.find(t => t.format.protocol === 'progressive')
        if (!progressive) {
          alert('No progressive MP3 available for this track.')
          return
        }

        const info = await fetch(`${progressive.url}?client_id=${clientId}`).then(r => r.json())
        const mp3Url = info.url
        console.log('[SC-DL] mp3 url:', mp3Url)

        btn.el.textContent = 'Downloading…'

        const mp3ArrayBuffer = await fetch(mp3Url).then(r => {
          if (!r.ok) throw new Error(`MP3 fetch failed: HTTP ${r.status}`)
          return r.arrayBuffer()
        })

        let artworkUrl = (result.artwork_url || (result.user && result.user.avatar_url) || '').replace(/-large|large/g, 't500x500')
        let coverArrayBuffer = null
        if (artworkUrl) {
          try { coverArrayBuffer = await fetch(artworkUrl).then(r => r.arrayBuffer()) }
          catch (e) { console.warn('[SC-DL] artwork fetch failed', e.message) }
        }

        const artist = result.user?.name || result.user?.username || ''
        const title  = result.title || ''
        const album  = result.publisher_metadata?.release_title || ''
        const genre  = result.genre || ''
        const tag_list = result.tag_list || ''

        const writer = new window.ID3Writer(new Uint8Array(mp3ArrayBuffer))
        writer.setFrame('TIT2', title)
        writer.setFrame('TPE1', [artist])
        if (album)    writer.setFrame('TALB', album)
        if (genre)    writer.setFrame('TCON', [genre])
        writer.setFrame('COMM', { description: '', text: `Source: SoundCloud\nURL: ${location.href}` })
        if (tag_list) writer.setFrame('TXXX', { description: 'SOUNDCLOUD_TAGS', value: tag_list })
        if (coverArrayBuffer) writer.setFrame('APIC', { type: 3, data: coverArrayBuffer, description: 'cover' })
        writer.addTag()

        const taggedBlob = writer.getBlob()
        const filename   = sanitizeFilename(`${artist} - ${title}.mp3`)

        if (window.streamSaver?.createWriteStream) {
          try {
            const fileStream = streamSaver.createWriteStream(filename, { size: taggedBlob.size })
            await taggedBlob.stream().pipeTo(fileStream)
            return
          } catch (e) {
            console.warn('[SC-DL] StreamSaver failed, using fallback:', e.message)
          }
        }

        const objUrl = URL.createObjectURL(taggedBlob)
        triggerDownload(objUrl, filename)
        setTimeout(() => URL.revokeObjectURL(objUrl), 60000)

      } catch (err) {
        const msg = err?.message || err?.toString() || 'Unknown error'
        console.error('[SC-DL] download failed:', err)
        alert('Download failed: ' + msg)
      } finally {
        btn.el.textContent = '↓ MP3'
        btn.el.disabled = false
      }
    }

    btn.attach()
    console.log('[SC-DL] ready')
  }

  load()
  const origPushState = history.pushState
  history.pushState = function (...args) { origPushState.apply(this, args); setTimeout(load, 500) }
  window.addEventListener('popstate', () => setTimeout(load, 500))
})()
