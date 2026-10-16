import { expect, it } from 'vitest'
import { lockIdentities, verifyLockSubset } from '../experiments/celld/recovery/lock-provenance.ts'
const dependency='[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "registry+approved"\nchecksum = "abc"\n'
const root='[[package]]\nname = "celld-lab-ltx-verifier"\nversion = "0.0.0"\n'
it('permits a subset only with the exact local root',()=> {
  expect(()=>verifyLockSubset(dependency,root+dependency)).not.toThrow()
  expect(()=>verifyLockSubset(dependency,dependency)).toThrow()
})
it.each(['registry+other','git+unapproved'])('rejects same version from changed source %s',source=> {
  expect(()=>verifyLockSubset(dependency,root+dependency.replace('registry+approved',source))).toThrow()
})
it('rejects changed checksums at the same name/version/source',()=> {
  expect(()=>verifyLockSubset(dependency,root+dependency.replace('"abc"','"changed"'))).toThrow()
})
it('rejects malformed or duplicate identity fields',()=> {
  expect(()=>lockIdentities('[[package]]\nname = "fixture"\n')).toThrow()
  expect(()=>lockIdentities(dependency+'name = "duplicate"\n')).toThrow()
})
