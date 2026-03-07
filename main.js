// ==UserScript==
// @name         SoundCloud downloader with ID3 metadata (for foobar)
// @namespace    https://github.com/adrxkn/Soundcloud-metadata-for-foobar
// @version      0.1
// @description  Download SoundCloud progressive MP3s and embed ID3 tags (title, artist, cover, tags/genre, comment) so files are foobar-ready. Uses StreamSaver.js for saving and browser-id3-writer to write tags in-browser.
// @match        https://soundcloud.com/*
// @grant        none
// ==/UserScript==

(function () {
	'use strict'

	// load StreamSaver if not already present (relies on you having set streamSaver.mitm elsewhere if needed)
	if (typeof streamSaver === 'undefined') {
		const s = document.createElement('script')
		s.src = 'https://unpkg.com/streamsaver@2.0.5/StreamSaver.min.js'
		document.head.appendChild(s)
	}

	// load browser-id3-writer
	async function loadId3Writer() {
		if (window.ID3Writer) return
		await new Promise((resolve, reject) => {
			const s = document.createElement('script')
			// pinned to a known distribution; adjust version if needed
			s.src = 'https://cdn.jsdelivr.net/npm/browser-id3-writer@4.0.0/dist/browser-id3-writer.min.js'
			s.onload = resolve
			s.onerror = reject
			document.head.appendChild(s)
		})
	}

	function hook(obj, name, callback, type) {
		const fn = obj[name]
		obj[name] = function (...args) {
			if (type === 'before') callback.apply(this, args)
			fn.apply(this, args)
			if (type === 'after') callback.apply(this, args)
		}
		return () => {
			// restore
			obj[name] = fn
		}
	}

	function sanitizeFilename(name) {
		// remove characters not allowed on many filesystems
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
			this.el.textContent = 'Download'
			this.el.classList.add('sc-button', 'sc-button-medium', 'sc-button-icon', 'sc-button-responsive', 'sc-button-secondary', 'sc-button-download')
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

	async function getClientId() {
		return new Promise(resolve => {
			const restore = hook(
				XMLHttpRequest.prototype,
				'open',
				async (method, url) => {
					try {
						const u = new URL(url, document.baseURI)
						const clientId = u.searchParams.get('client_id')
						if (!clientId) return
						console.log('got clientId', clientId)
						restore()
						resolve(clientId)
					} catch (e) {
						// ignore
					}
				},
				'after'
			)
		})
	}

	const clientIdPromise = getClientId()
	let controller = null

	async function arrayBufferFromUrl(url) {
		// fetch with CORS; SoundCloud allows cross-origin for media/artwork
		const resp = await fetch(url)
		if (!resp.ok) throw new Error('Failed to fetch ' + url)
		return resp.arrayBuffer()
	}

	async function load(by) {
		btn.detach()
		console.log('load by', by, location.href)
		if (/^(\/(you|stations|discover|stream|upload|search|settings))/.test(location.pathname)) return
		const clientId = await clientIdPromise
		if (!clientId) {
			console.warn('no client id yet')
			return
		}
		if (controller) {
			controller.abort()
			controller = null
		}
		controller = new AbortController()
		const result = await fetch(
			`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(location.href)}&client_id=${clientId}`,
			{ signal: controller.signal }
		).then(r => r.json())
		console.log('result', result)
		if (result.kind !== 'track') return

		btn.el.onclick = async () => {
			try {
				// prefer progressive transcoding (direct mp3)
				const progressive = result.media.transcodings.find(t => t.format.protocol === 'progressive')
				if (progressive) {
					// If library not loaded, load it
					await loadId3Writer()

					// get the real mp3 URL (SoundCloud gives a redirector)
					const info = await fetch(progressive.url + `?client_id=${clientId}`).then(r => r.json())
					const mp3Url = info.url
					console.log('progressive url', mp3Url)

					// fetch mp3 arrayBuffer
					const mp3ArrayBuffer = await arrayBufferFromUrl(mp3Url)

					// fetch artwork (prefer track artwork, fallback to user avatar)
					let artworkUrl = result.artwork_url || result.user && result.user.avatar_url
					if (artworkUrl) {
						// artwork URLs often include size tokens like "-large" or "-t50x50"
						// common trick: request a larger size
						artworkUrl = artworkUrl.replace('-large', '-t500x500').replace('large', 't500x500')
					}

					let coverArrayBuffer = null
					try {
						if (artworkUrl) coverArrayBuffer = await arrayBufferFromUrl(artworkUrl)
					} catch (e) {
						console.warn('could not fetch artwork', e)
						coverArrayBuffer = null
					}

					// prepare metadata
					const artist = (result.user && (result.user.name || result.user.username)) || ''
					const title = result.title || ''
					const album = result.publisher_metadata && result.publisher_metadata.release_title ? result.publisher_metadata.release_title : ''
					const genre = result.genre || ''
					const tag_list = result.tag_list || ''
					const comment = `Source: SoundCloud\nURL: ${location.href}`

					// write ID3 tags using browser-id3-writer
					// ID3Writer expects a Uint8Array
					const writer = new window.ID3Writer(new Uint8Array(mp3ArrayBuffer))

					// standard frames
					writer.setFrame('TIT2', title)
					writer.setFrame('TPE1', [artist])
					if (album) writer.setFrame('TALB', album)
					if (genre) writer.setFrame('TCON', [genre])

					// add a comment with the original SoundCloud URL and other info
					writer.setFrame('COMM', {
						description: '',
						text: comment
					})

					// write tags/tags-list into a TXXX custom frame for foobar to pick up if needed
					if (tag_list) {
						writer.setFrame('TXXX', {
							description: 'SOUNDCLOUD_TAGS',
							value: tag_list
						})
					}

					// embed cover art if available
					if (coverArrayBuffer) {
						writer.setFrame('APIC', {
							type: 3,
							data: coverArrayBuffer,
							description: 'cover'
						})
					}

					// apply tags
					writer.addTag()

					// get the tagged blob
					const taggedBlob = writer.getBlob()

					// filename: "Artist - Title.mp3" sanitized
					const filename = sanitizeFilename(`${artist} - ${title}.mp3`)

					// Use StreamSaver to save file (preserves streaming behaviour for larger result.blobs)
					if (window.streamSaver && streamSaver.createWriteStream) {
						try {
							// streamSaver expects a stream. Convert Blob to stream
							const fileStream = streamSaver.createWriteStream(filename, { size: taggedBlob.size })
							if (taggedBlob.stream) {
								// modern browsers: use blob.stream()
								const readable = taggedBlob.stream()
								return readable.pipeTo(fileStream)
							} else {
								// fallback: use getReader + writer
								const reader = new Response(taggedBlob).body.getReader()
								const writerStream = fileStream.getWriter()
								const pump = () => reader.read().then(({ done, value }) => done ? writerStream.close() : writerStream.write(value).then(pump))
								return pump()
							}
						} catch (e) {
							console.warn('StreamSaver saving failed, falling back to link download', e)
						}
					}

					// fallback: create object URL and trigger normal download
					const url = URL.createObjectURL(taggedBlob)
					triggerDownload(url, filename)
					setTimeout(() => URL.revokeObjectURL(url), 60 * 1000)
					return
				}

				// no progressive - fallback to previous streaming method (no tagging)
				alert('Sorry, downloading this music is currently unsupported (no progressive mp3).')
			} catch (err) {
				console.error('download failed', err)
				alert('Download failed: ' + (err && err.message ? err.message : String(err)))
			}
		}

		btn.attach()
		console.log('attached (metadata-enabled)')
	}

	load('init')
	hook(history, 'pushState', () => load('pushState'), 'after')
	window.addEventListener('popstate', () => load('popstate'))
})()
