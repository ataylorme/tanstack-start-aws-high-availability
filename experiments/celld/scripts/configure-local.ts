import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
try {
  await writeFile(new URL('../.dev.vars', import.meta.url), `REGION_MODE=primary\nLAB_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  console.log('Created owner-only .dev.vars; keep the token local.')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  console.log('Existing .dev.vars preserved; no secret rotation.')
}
