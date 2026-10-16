import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'

const lock = JSON.parse(await readFile(new URL('../celld.lock.json', import.meta.url), 'utf8'))
const asset = lock.assets[`${process.platform}-${process.arch}`]
if (!asset) throw new Error('Pinned celld release has no binary for this platform')
const response = await fetch(`https://github.com/denoland/celld/releases/download/${lock.version}/${asset.name}`)
if (!response.ok) throw new Error(`Release download failed: ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(archive).digest('hex') !== asset.sha256) throw new Error('celld release digest mismatch')
const directory = resolve('.omx/local/celld-bin')
await mkdir(directory, { recursive: true, mode: 0o700 })
await writeFile(resolve(directory, 'celld.gz'), archive, { mode: 0o600 })
await writeFile(resolve(directory, 'celld'), gunzipSync(archive), { mode: 0o700 })
await chmod(resolve(directory, 'celld'), 0o700)
console.log(`Installed SHA256-verified celld ${lock.version} under ignored .omx/local/celld-bin`)
