import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { verifyWorkflowPackage } from '../scripts/workflow-package'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
const name = '@ataylorme/tanstack-workflow-aws'
const version = '0.2.0-rc.1'
const artifact = { version, registry: 'https://npm.pkg.github.com', tarball: 'https://npm.pkg.github.com/download/test', integrity: 'sha512-fixture', sha256: 'a'.repeat(64), commit: 'b'.repeat(40), repository: 'https://github.com/ataylorme/tanstack-workflow-aws', pullRequest: 4 }
let manifest: { dependencies: Record<string, string> }
let installed: { version: string }
let lock: { packages: Record<string, { dependencies?: Record<string, string>; version?: string; resolved?: string; integrity?: string }> }
beforeEach(() => {
  manifest = { dependencies: { [name]: version } }
  installed = { version }
  lock = { packages: { '': { dependencies: { [name]: version } }, [`node_modules/${name}`]: { version, resolved: artifact.tarball, integrity: artifact.integrity } } }
  vi.mocked(readFileSync).mockImplementation(file => {
    const path = String(file)
    return JSON.stringify(path.endsWith('package-provenance.json') ? artifact : path.endsWith('package-lock.json') ? lock : path.includes('/node_modules/') ? installed : manifest)
  })
})
it('returns provenance only when the exact release, lock and installed version agree', () => {
  expect(verifyWorkflowPackage()).toEqual(artifact)
})
it('rejects a moving or local-file dependency', () => {
  manifest.dependencies[name] = '^0.2.0-rc.1'
  expect(() => verifyWorkflowPackage()).toThrow('exact registry release')
})
it('rejects an outdated installed package', () => {
  installed.version = '0.1.0'
  expect(() => verifyWorkflowPackage()).toThrow('Run npm ci')
})
it.each(['version', 'resolved', 'integrity'] as const)('rejects changed lockfile %s', field => {
  lock.packages[`node_modules/${name}`]![field] = 'different'
  expect(() => verifyWorkflowPackage()).toThrow()
})
