import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const work=resolve('.omx/local/ltx-verifier')
const binary=resolve(work,'target/debug/celld-lab-bootstrap-verifier')
const attestation=JSON.parse(readFileSync(resolve(work,'attestation.json'),'utf8'))
const sha=(file: string)=>createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(attestation.sourceCommit,'90b43017241f81189453d326d05948f388b34652')
assert.equal(attestation.bootstrapHelperSha256,sha('experiments/celld/recovery/verify-bootstrap.rs'))
assert.equal(attestation.bootstrapBinarySha256,sha(binary))
assert.equal(attestation.lockSha256,sha(resolve(work,'Cargo.lock')))
const output=execFileSync(binary,[],{encoding:'utf8',timeout:10_000,maxBuffer:64*1024})
const checks=output.trim().split('\n')
assert.equal(checks.length,6)
assert.equal(checks.filter(line=>line.startsWith('PASS\t')).length,5)
assert.ok(checks.at(-1)?.startsWith('LIMIT\t'))
const evidence=resolve('.deploy/celld/bootstrap-probes');mkdirSync(evidence,{recursive:true,mode:0o700})
writeFileSync(resolve(evidence,`${randomUUID()}.json`),JSON.stringify({observedAt:new Date().toISOString(),attestation,checks,
  scope:'Actual pinned native decision core, deterministic offline bootstrap slice; node leases disabled explicitly. No storage CAS executed, actors or AWS calls. Not production fencing, full runtime behavior, import authorization or simultaneous-commit evidence.'}),{mode:0o600})
console.log(output.trim())
