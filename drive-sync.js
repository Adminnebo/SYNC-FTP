#!/usr/bin/env node
// Daily sync: images from a PUBLIC Google Drive folder -> Supabase Storage.
//
// Mirrors migrate.js `sync` but the source is a Google Drive folder instead of
// an FTP. Because the folder is public ("anyone with the link"), a plain
// Google API key is enough to both LIST the folder and DOWNLOAD each file — no
// service account / OAuth needed. It is stateless: each run lists what already
// exists in the bucket and uploads only the missing images.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env.migration') })

const { createClient } = require('@supabase/supabase-js')

const env = process.env
const REQUIRED = ['GOOGLE_API_KEY', 'DRIVE_FOLDER_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET']
for (const k of REQUIRED) {
  if (!env[k]) { console.error(`Missing ${k} in env/.env.migration`); process.exit(1) }
}

const API_KEY = env.GOOGLE_API_KEY
const FOLDER_ID = env.DRIVE_FOLDER_ID
const BUCKET = env.SUPABASE_BUCKET
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|svg|avif|heic|heif)$/i
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const CONCURRENCY = 5

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function mimeFor(name) {
  const ext = (name.toLowerCase().match(/\.[^.]+$/) || [''])[0]
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.heic': 'image/heic', '.heif': 'image/heif',
  }[ext] || 'application/octet-stream'
}

// Supabase Storage rejects most non-ASCII characters in object keys. Normalize
// diacritics (á→a, ñ→n) and replace any remaining non-printable-ASCII byte
// with a dash so the upload key is always accepted.
function sanitizeKey(p) {
  return p
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '-')
}

// --- Google Drive (public folder, API key only) ----------------------------

async function driveList(folderId) {
  const out = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      key: API_KEY,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`)
    if (!res.ok) throw new Error(`Drive list failed ${res.status}: ${await res.text()}`)
    const data = await res.json()
    out.push(...(data.files || []))
    pageToken = data.nextPageToken || ''
  } while (pageToken)
  return out
}

async function walkDrive(folderId, prefix, acc) {
  const items = await driveList(folderId)
  for (const it of items) {
    const rel = prefix ? `${prefix}/${it.name}` : it.name
    if (it.mimeType === FOLDER_MIME) {
      await walkDrive(it.id, rel, acc)
    } else if (IMG_EXT.test(it.name) || (it.mimeType || '').startsWith('image/')) {
      acc.push({ id: it.id, name: it.name, key: sanitizeKey(rel) })
    }
  }
  return acc
}

async function driveDownload(id) {
  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${API_KEY}&supportsAllDrives=true`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Drive download failed ${res.status}: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

// --- Supabase Storage ------------------------------------------------------

async function listRemoteKeys(prefix, out) {
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw error
    if (!data || data.length === 0) break
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name
      if (item.id === null) await listRemoteKeys(full, out) // folders have id === null
      else out.add(full)
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function uploadOne(file) {
  const buffer = await driveDownload(file.id)
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(file.key, buffer, { contentType: mimeFor(file.name), upsert: true })
  if (error) throw error
  return file.key
}

async function sync() {
  console.log(`[drive-sync] Listing Drive folder ${FOLDER_ID} ...`)
  const images = await walkDrive(FOLDER_ID, '', [])
  console.log(`[drive-sync] Drive images: ${images.length}`)

  console.log(`[drive-sync] Listing existing objects in bucket "${BUCKET}" ...`)
  const remote = await listRemoteKeys('', new Set())
  console.log(`[drive-sync] Already in bucket: ${remote.size}`)

  const todo = images.filter(f => !remote.has(f.key))
  console.log(`[drive-sync] New images to upload: ${todo.length}`)
  if (todo.length === 0) { console.log('[drive-sync] Nothing new. Done.'); return }

  let i = 0, done = 0, failed = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const file = todo[i++]
      try {
        const key = await uploadOne(file)
        done++
        console.log(`[drive-sync] OK  ${key}`)
      } catch (err) {
        failed++
        console.error(`[drive-sync] ERR ${file.name}: ${err.message || err}`)
      }
    }
  })
  await Promise.all(workers)
  console.log(`[drive-sync] Done. Uploaded:${done}  Failed:${failed}`)
  if (failed > 0) process.exit(1) // fail the CI run so you get notified
}

sync().catch(e => { console.error(e); process.exit(1) })
