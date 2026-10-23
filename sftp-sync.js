#!/usr/bin/env node
// Daily sync: SFTP (Azure Blob Storage, jheacloudservice) -> Supabase Storage.
//
// The SFTP has one folder per destination bucket:
//   /imagenes        -> Lucas_imagenes         (product images, <codigo>.png)
//   /fichastecnicas  -> Lucas_fichas_tecnicas  (data sheets,    <codigo>.pdf)
// It replaces the old FTP (migrate.js) and Drive (drive-sync.js) syncs, which
// fed those same buckets.
//
// Stateless: each run lists the SFTP folder and the bucket, and uploads a file
// when it is missing from the bucket OR its size differs (= the file was
// replaced on the SFTP with the same name). Nothing is ever deleted from the
// bucket. A run that is cut off just resumes on the next one.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env.migration') })

const SftpClient = require('ssh2-sftp-client')
const { createClient } = require('@supabase/supabase-js')

const env = process.env
const REQUIRED = ['SFTP_HOST', 'SFTP_USER', 'SFTP_PASSWORD', 'SFTP_SUPABASE_URL', 'SFTP_SUPABASE_SERVICE_ROLE_KEY']
for (const k of REQUIRED) {
  if (!env[k]) { console.error(`Missing ${k} in env/.env.migration`); process.exit(1) }
}

const PAIRS = [
  { dir: '/imagenes', bucket: env.SFTP_IMAGES_BUCKET || 'Lucas_imagenes' },
  { dir: '/fichastecnicas', bucket: env.SFTP_FICHAS_BUCKET || 'Lucas_fichas_tecnicas' },
]
const CONCURRENCY = 5
// `node sftp-sync.js test` uploads at most this many files per folder.
const LIMIT = process.argv[2] === 'test' ? 10 : Infinity

const supabase = createClient(env.SFTP_SUPABASE_URL, env.SFTP_SUPABASE_SERVICE_ROLE_KEY, {
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
    '.pdf': 'application/pdf',
  }[ext] || 'application/octet-stream'
}

// Supabase Storage rejects most non-ASCII characters in object keys. Normalize
// diacritics (á→a, ñ→n) and replace any remaining non-printable-ASCII byte
// with a dash so the upload key is always accepted. Same rule the old syncs
// used, so keys already in the buckets keep matching.
function sanitizeKey(p) {
  return p
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '-')
}

async function sftpClient(attempts = 3) {
  for (let n = 1; ; n++) {
    const client = new SftpClient()
    try {
      await client.connect({
        host: env.SFTP_HOST,
        port: parseInt(env.SFTP_PORT) || 22,
        username: env.SFTP_USER,
        password: env.SFTP_PASSWORD,
        readyTimeout: 60_000,
        // Azure drops SFTP connections idle for ~2 min; keep them talking.
        keepaliveInterval: 15_000,
      })
      return client
    } catch (err) {
      if (n >= attempts) throw err
      console.warn(`[sftp-sync] connect failed (${err.code || err.message}), retrying ...`)
      await new Promise(r => setTimeout(r, 3000 * n))
    }
  }
}

async function walkSftp(client, dir, prefix, out) {
  for (const item of await client.list(dir)) {
    const full = `${dir}/${item.name}`
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.type === 'd') await walkSftp(client, full, rel, out)
    else if (item.type === '-') out.push({ path: full, name: item.name, size: item.size, key: sanitizeKey(rel) })
  }
  return out
}

// key -> size in bytes, for every object in the bucket.
async function listRemote(bucket, prefix, out) {
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw error
    if (!data || data.length === 0) break
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name
      if (item.id === null) await listRemote(bucket, full, out) // folders have id === null
      else out.set(full, item.metadata?.size)
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function syncPair({ dir, bucket }) {
  const tag = `[sftp-sync ${dir}]`
  // A fresh connection per folder: one opened at start would sit idle while
  // the previous folder uploads, and Azure closes it.
  const scanClient = await sftpClient()
  let files
  try {
    files = await walkSftp(scanClient, dir, '', [])
  } finally {
    await scanClient.end()
  }
  console.log(`${tag} SFTP files: ${files.length}`)

  const remote = await listRemote(bucket, '', new Map())
  console.log(`${tag} Already in bucket "${bucket}": ${remote.size}`)

  const missing = files.filter(f => !remote.has(f.key))
  const changed = files.filter(f => remote.has(f.key) && remote.get(f.key) !== f.size)
  const todo = [...missing, ...changed].slice(0, LIMIT)
  console.log(`${tag} New: ${missing.length}  Replaced (size differs): ${changed.length}  Uploading: ${todo.length}`)
  if (todo.length === 0) return { done: 0, failed: 0 }

  let i = 0, done = 0, failed = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    let client = await sftpClient()
    // If the connection dropped, reconnect and retry the file once.
    async function download(file) {
      try {
        return await client.get(file.path)
      } catch (err) {
        console.warn(`${tag} retry ${file.path} on a new connection: ${err.message || err}`)
        await client.end().catch(() => {})
        client = await sftpClient()
        return await client.get(file.path)
      }
    }
    try {
      while (i < todo.length) {
        const file = todo[i++]
        try {
          const buffer = await download(file)
          const { error } = await supabase.storage
            .from(bucket)
            .upload(file.key, buffer, { contentType: mimeFor(file.name), upsert: true })
          if (error) throw error
          done++
          console.log(`${tag} OK  ${file.key}`)
        } catch (err) {
          failed++
          console.error(`${tag} ERR ${file.path}: ${err.message || err}`)
        }
      }
    } finally {
      await client.end().catch(() => {})
    }
  })
  await Promise.all(workers)
  console.log(`${tag} Done. Uploaded:${done}  Failed:${failed}`)
  return { done, failed }
}

async function sync() {
  console.log(`[sftp-sync] Connecting to ${env.SFTP_HOST} ...`)
  let failed = 0
  for (const pair of PAIRS) failed += (await syncPair(pair)).failed
  if (failed > 0) process.exit(1) // fail the CI run so you get notified
}

sync().catch(e => { console.error(e); process.exit(1) })
