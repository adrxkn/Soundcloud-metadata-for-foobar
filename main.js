// ==UserScript==
// @name         SoundCloud downloader with ID3 metadata (for foobar)
// @namespace    https://github.com/adrxkn/Soundcloud-metadata-for-foobar
// @version      0.3
// @description  Download SoundCloud progressive MP3s and embed ID3 tags
// @match        https://soundcloud.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve()
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = () => reject(new Error('Failed to load: ' + src))
      document.head.appendChild(s)
    })
  }

  async function loadDeps() {
    await loadScript('https://cdn.jsdelivr.net/npm/browser-id3-writer@4.0.0/dist/browser-id3-writer.min.js')
  }

  let pickedDirHandle = null

  async function pickFolder() {
    if (!window.showDirectoryPicker) {
      alert('Your browser does not support folder picking.\nFiles will download to your default Downloads folder.')
      return false
    }
    try {
      pickedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      return true
    } catch (e) {
      if (e.name === 'AbortError') return false
    }
  }

  async function saveToFolder(blob, filename) {

    const picked = await pickFolder()
    if (!picked && !pickedDirHandle) {

      return false
    }
    const fileHandle = await pickedDirHandle.getFileHandle(filename, { create: true })
    const writable   = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
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
      const urlStr = typeof input === 'string' ? input : input?.url
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
        else if (Date.now() - start > timeout) {
          clearInterval(iv)
          reject(new Error('Timed out waiting for client_id — try refreshing the page'))
        }
      }, 200)
    })
  }

  function getCleanTrackUrl() {
    const u = new URL(location.href)
    return u.origin + u.pathname
  }

  function sanitizeFilename(name) {
    return name.replace(/[\/\?<>\\:\*\|":]/g, '').replace(/\s+/g, ' ').trim()
  }

  function fallbackDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    document.body.appendChild(a)
    a.href = url
    a.download = filename
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
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
    },
    setLabel(text) { this.el.textContent = text },
    setDisabled(v) { this.el.disabled = v }
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
      console.warn('[SC-DL]', e.message)
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
      btn.setLabel('Loading')
      btn.setDisabled(true)
      try {
        await loadDeps()

        // Verify ID3Writer loaded correctly before proceeding
        if (typeof window.ID3Writer !== 'function') {
          throw new Error('ID3Writer failed to load — check your browser console for network errors')
        }

        const progressive = result.media.transcodings.find(t => t.format.protocol === 'progressive')
        if (!progressive) {
          alert('No progressive MP3 available for this track.')
          return
        }

        const info   = await fetch(`${progressive.url}?client_id=${clientId}`).then(r => r.json())
        const mp3Url = info.url
        console.log('[SC-DL] mp3 url:', mp3Url)

        btn.setLabel('Fetching MP3')
        const mp3ArrayBuffer = await fetch(mp3Url).then(r => {
          if (!r.ok) throw new Error(`MP3 fetch failed: HTTP ${r.status}`)
          return r.arrayBuffer()
        })

        // artwork
        let artworkUrl = (result.artwork_url || result.user?.avatar_url || '')
          .replace(/-large\./, '-t500x500.')
          .replace(/-large$/, '-t500x500')
        let coverArrayBuffer = null
        if (artworkUrl) {
          try {
            const artResp = await fetch(artworkUrl)
            if (artResp.ok) {
              coverArrayBuffer = await artResp.arrayBuffer()
            } else {
              console.warn('[SC-DL] artwork returned', artResp.status, '— skipping cover art')
            }
          } catch (e) {
            console.warn('[SC-DL] artwork fetch failed:', e.message)
          }
        }

        // metadata
        const artist   = result.user?.name || result.user?.username || ''
        const title    = result.title || ''
        const album    = result.publisher_metadata?.release_title || ''
        const genre    = result.genre || ''
        const tag_list = result.tag_list || ''
        const filename = sanitizeFilename(`${artist} - ${title}.mp3`)

        btn.setLabel('Writing tags')

        // Write ID3 tags
        const writer = new window.ID3Writer(new Uint8Array(mp3ArrayBuffer))
        writer.setFrame('TIT2', title)
        writer.setFrame('TPE1', [artist])
        if (album)    writer.setFrame('TALB', album)
        if (genre)    writer.setFrame('TCON', [genre])
        writer.setFrame('COMM', {
          description: '',
          text: `Source: SoundCloud\nURL: ${location.href}`
        })
        if (tag_list) writer.setFrame('TXXX', {
          description: 'SOUNDCLOUD_TAGS',
          value: tag_list
        })
        writer.setFrame('APIC', {
          type: 3,
          data: coverArrayBuffer,
          description: 'cover',
          useUnicodeEncoding: false,
          mimeType: artworkUrl.includes('.png') ? 'image/png' : 'image/jpeg'
        })
        writer.addTag()

        const taggedBlob = writer.getBlob()

        btn.setLabel('Saving')
        try {
          const saved = await saveToFolder(taggedBlob, filename)
          if (!saved) {
            fallbackDownload(taggedBlob, filename)
          }
        } catch (e) {
          console.warn('[SC-DL] folder save failed, using fallback:', e.message)
          fallbackDownload(taggedBlob, filename)
        }

        console.log('[SC-DL] saved:', filename)

      } catch (err) {
        const msg = err?.message || err?.toString() || 'Unknown error'
        console.error('[SC-DL] download failed:', err)
        alert('Download failed: ' + msg)
      } finally {
        btn.setLabel('↓ MP3')
        btn.setDisabled(false)
      }
    }

    btn.attach()
    console.log('[SC-DL] ready')
  }

  load()

  const origPushState = history.pushState
  history.pushState = function (...args) {
    origPushState.apply(this, args)
    setTimeout(load, 500)
  }
  window.addEventListener('popstate', () => setTimeout(load, 500))
})()
