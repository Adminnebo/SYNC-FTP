#!/usr/bin/env node
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env.migration') })

const ftp = require('basic-ftp')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const { Writable } = require('stream')

const env = process.env
const REQUIRED = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET']
for (const k of REQUIRED) {
  if (!env[k]) { console.error(`Missing ${k} in .env.migration`); process.exit(1) }
}

const FTP_PORT = parseInt(env.FTP_PORT) || 21
const FTP_BASE = env.FTP_BASE_PATH || '/'
const DISCOVERY = path.join(__dirname, 'discovery.json')
const LOG = path.join(__dirname, 'migration.log.json')
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|svg|avif|heic|heif)$/i
const CONCURRENCY = 5

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function ftpClient() {
  const client = new ftp.Client(60_000)
  client.ftp.verbose = false
  await client.access({
    host: env.FTP_HOST,
    port: FTP_PORT,
    user: env.FTP_USER,
    password: env.FTP_PASSWORD,
    secure: false,
  })
  return client
}

async function walk(client, dir, out = []) {
  const list = await client.list(dir)
  for (const item of list) {
    const full = (dir.endsWith('/') ? dir : dir + '/') + item.name
    if (item.isDirectory) {
      await walk(client, full, out)
    } else if (item.isFile) {
      out.push({ path: full, name: item.name, size: item.size })
    }
  }
  return out
}

async function discover() {
  console.log(`Connecting to ${env.FTP_HOST}:${FTP_PORT} ...`)
  const client = await ftpClient()
  try {
    console.log(`Walking ${FTP_BASE} ...`)
    const all = await walk(client, FTP_BASE)
    const images = all.filter(f => IMG_EXT.test(f.name))
    const totalBytes = images.reduce((a, b) => a + b.size, 0)
    fs.writeFileSync(DISCOVERY, JSON.stringify({
      ftpBase: FTP_BASE,
      scannedAt: new Date().toISOString(),
      totalFiles: all.length,
      imageFiles: images.length,
      totalImageBytes: totalBytes,
      files: images,
    }, null, 2))
    console.log(`\nFound: ${all.length} files total, ${images.length} images (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`)
    console.log(`Saved to ${DISCOVERY}`)
    if (images.length > 0) {
      console.log('\nFirst 10 image samples:')
      images.slice(0, 10).forEach(f => console.log(`  ${f.path}  (${(f.size / 1024).toFixed(1)} KB)`))
    }
    if (all.length > images.length) {
      const nonImg = all.filter(f => !IMG_EXT.test(f.name))
      console.log(`\n${nonImg.length} non-image files were skipped. Examples:`)
      nonImg.slice(0, 5).forEach(f => console.log(`  ${f.path}`))
    }
  } finally {
    client.close()
  }
}

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

function storagePathFor(ftpPath) {
  let p = ftpPath
  if (p.startsWith(FTP_BASE) && FTP_BASE !== '/') p = p.slice(FTP_BASE.length)
  while (p.startsWith('/')) p = p.slice(1)
  return sanitizeKey(p)
}

async function uploadOne(client, file) {
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await client.downloadTo(sink, file.path)
  const buffer = Buffer.concat(chunks)
  const storagePath = storagePathFor(file.path)
  const { error } = await supabase.storage
    .from(env.SUPABASE_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeFor(file.name), upsert: true })
  if (error) throw error
  return storagePath
}

function loadLog() {
  if (fs.existsSync(LOG)) return JSON.parse(fs.readFileSync(LOG, 'utf8'))
  return { uploaded: {}, failed: {}, startedAt: new Date().toISOString() }
}
function saveLog(log) { fs.writeFileSync(LOG, JSON.stringify(log, null, 2)) }

async function migrate(limit = Infinity) {
  if (!fs.existsSync(DISCOVERY)) {
    console.error('Run "node migrate.js discover" first.')
    process.exit(1)
  }
  const { files } = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'))
  const log = loadLog()
  // Re-runs: forget prior failures so re-attempted files only show their new outcome.
  log.failed = {}
  const todo = files.filter(f => !log.uploaded[f.path]).slice(0, limit)
  const alreadyDone = Object.keys(log.uploaded).length
  console.log(`To upload: ${todo.length} (already done: ${alreadyDone}, total in discovery: ${files.length})`)
  if (todo.length === 0) { console.log('Nothing to do.'); return }

  let i = 0, done = 0, failed = 0
  const start = Date.now()
  let lastSave = 0

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const client = await ftpClient()
    try {
      while (i < todo.length) {
        const idx = i++
        const file = todo[idx]
        try {
          const storagePath = await uploadOne(client, file)
          log.uploaded[file.path] = { storagePath, size: file.size, uploadedAt: new Date().toISOString() }
          done++
        } catch (err) {
          log.failed[file.path] = { error: err.message || String(err), at: new Date().toISOString() }
          failed++
        }
        const totalDone = done + failed
        if (totalDone - lastSave >= 25 || totalDone === todo.length) {
          saveLog(log)
          lastSave = totalDone
          const elapsed = (Date.now() - start) / 1000
          const rate = totalDone / Math.max(elapsed, 1)
          const eta = (todo.length - totalDone) / Math.max(rate, 0.1)
          process.stdout.write(`\r  ${totalDone}/${todo.length}  OK:${done}  ERR:${failed}  ${rate.toFixed(1)}/s  ETA ${(eta / 60).toFixed(1)}min      `)
        }
      }
    } finally {
      client.close()
    }
  })
  await Promise.all(workers)
  saveLog(log)
  console.log(`\n\nDone. OK:${done}  ERR:${failed}`)
  if (failed > 0) console.log(`Failed entries are in ${LOG} under "failed". Re-run "node migrate.js run" to retry (succeeded uploads are skipped).`)
  if (done > 0) {
    const example = Object.values(log.uploaded)[0]
    const publicUrl = supabase.storage.from(env.SUPABASE_BUCKET).getPublicUrl(example.storagePath).data.publicUrl
    console.log(`\nExample public URL: ${publicUrl}`)
  }
}

// --- Daily sync (stateless, for cloud cron) --------------------------------
// Unlike `run`, which trusts the local migration.log.json to know what was
// already uploaded, `sync` asks Supabase Storage directly which object keys
// exist and uploads only the FTP images that are missing. That makes it safe
// on ephemeral runners (GitHub Actions) where no state persists between runs.

async function listRemoteKeys(prefix, out) {
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase.storage
      .from(env.SUPABASE_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw error
    if (!data || data.length === 0) break
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name
      // Folders come back with id === null; files carry a real id.
      if (item.id === null) await listRemoteKeys(full, out)
      else out.add(full)
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function sync() {
  console.log(`[sync] Connecting to FTP ${env.FTP_HOST}:${FTP_PORT} ...`)
  const scanClient = await ftpClient()
  let images
  try {
    images = (await walk(scanClient, FTP_BASE)).filter(f => IMG_EXT.test(f.name))
  } finally {
    scanClient.close()
  }
  console.log(`[sync] FTP images: ${images.length}`)

  console.log('[sync] Listing existing objects in Supabase bucket ...')
  const remote = await listRemoteKeys('', new Set())
  console.log(`[sync] Already in bucket: ${remote.size}`)

  const todo = images.filter(f => !remote.has(storagePathFor(f.path)))
  console.log(`[sync] New images to upload: ${todo.length}`)
  if (todo.length === 0) { console.log('[sync] Nothing new. Done.'); return }

  let i = 0, done = 0, failed = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const client = await ftpClient()
    try {
      while (i < todo.length) {
        const file = todo[i++]
        try {
          const storagePath = await uploadOne(client, file)
          done++
          console.log(`[sync] OK  ${storagePath}`)
        } catch (err) {
          failed++
          console.error(`[sync] ERR ${file.path}: ${err.message || err}`)
        }
      }
    } finally {
      client.close()
    }
  })
  await Promise.all(workers)
  console.log(`[sync] Done. Uploaded:${done}  Failed:${failed}`)
  // Non-zero exit on failures so the CI run is marked red and you get notified.
  if (failed > 0) process.exit(1)
}

const cmd = process.argv[2]
if (cmd === 'sync') {
  sync().catch(e => { console.error(e); process.exit(1) })
} else if (cmd === 'discover') {
  discover().catch(e => { console.error(e); process.exit(1) })
} else if (cmd === 'test') {
  migrate(10).catch(e => { console.error(e); process.exit(1) })
} else if (cmd === 'run') {
  migrate().catch(e => { console.error(e); process.exit(1) })
} else {
  console.log('Usage: node migrate.js [discover|test|run|sync]')
  console.log('  discover  Connect to FTP, list all images, save discovery.json. Does NOT upload.')
  console.log('  test      Upload first 10 images to Supabase Storage. Sanity check.')
  console.log('  run       Full migration with concurrency, progress, and resume support.')
  console.log('  sync      Stateless daily sync: upload only FTP images not already in the bucket.')
  process.exit(1)
}
