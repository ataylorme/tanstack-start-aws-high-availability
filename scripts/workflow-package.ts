import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

// npm ci verifies the downloaded tarball against the lockfile's integrity hash.
// Check that runners, installed package, and public provenance agree before AWS calls.
export function verifyWorkflowPackage() {
  const artifact = readJson('../src/events/package-provenance.json') as {
    repository: string; pullRequest: number; commit: string; version: string
    registry: string; tarball: string; integrity: string; sha256: string
  }
  const name = '@ataylorme/tanstack-workflow-aws'
  const manifest = readJson('../package.json')
  const lock = readJson('../package-lock.json')
  const installed = readJson(`../node_modules/${name}/package.json`)
  assert.equal(manifest.dependencies[name], artifact.version, 'Expected the exact registry release')
  assert.equal(lock.packages[''].dependencies[name], artifact.version)
  assert.equal(lock.packages[`node_modules/${name}`].version, artifact.version)
  assert.equal(lock.packages[`node_modules/${name}`].resolved, artifact.tarball)
  assert.equal(lock.packages[`node_modules/${name}`].integrity, artifact.integrity)
  assert.equal(installed.version, artifact.version, 'Run npm ci to install the locked release')
  assert.equal(new URL(artifact.tarball).origin, artifact.registry)
  return artifact
}
