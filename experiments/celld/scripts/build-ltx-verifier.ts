import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyLockSubset } from '../recovery/lock-provenance.ts'

const pin = JSON.parse(readFileSync('experiments/celld/celld.lock.json', 'utf8'))
const source = resolve('.omx/local/celld-v0.6.2')
if (!existsSync(source)) {
  mkdirSync(resolve('.omx/local'), { recursive: true, mode: 0o700 })
  execFileSync('git', ['clone', '--depth', '1', '--branch', 'v0.6.2', 'https://github.com/denoland/celld.git', source], { stdio: 'inherit', timeout: 120_000 })
}
const git = (args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
const expected = '90b43017241f81189453d326d05948f388b34652'
if (git(['rev-parse', 'HEAD']) !== expected || git(['status', '--porcelain'])) throw new Error('Requires clean upstream source at the approved celld v0.6.2 commit')
const upstream = git(['remote', 'get-url', 'origin'])
if (!/^https:\/\/github\.com\/denoland\/celld(?:\.git)?$/.test(upstream)) throw new Error('Unexpected source origin')
if (pin.sourceCommit !== expected || pin.version !== 'v0.6.2') throw new Error('Runtime source pin mismatch')
const work = resolve('.omx/local/ltx-verifier')
mkdirSync(resolve(work, 'src'), { recursive: true, mode: 0o700 })
// No new application dependencies: use the already selected pinned runtime's
// own decoder library, with its upstream transitive dependency definitions.
const tokioVersion = readFileSync(resolve(source, 'Cargo.lock'), 'utf8').match(/name = "tokio"\nversion = "([^"]+)"/)?.[1]
if (!tokioVersion) throw new Error('Missing upstream async runtime pin')
writeFileSync(resolve(work, 'Cargo.toml'), `[package]\nname = "celld-lab-ltx-verifier"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\ncelld-ltx = { path = ${JSON.stringify(resolve(source, 'crates/ltx'))}, default-features = false }\ncelld-logic = { path = ${JSON.stringify(resolve(source, 'crates/logic'))} }\ntokio = { version = "=${tokioVersion}", features = ["rt-multi-thread"] }\n[[bin]]\nname = "celld-lab-bootstrap-verifier"\npath = "src/bootstrap.rs"\n`, { mode: 0o600 })
cpSync('experiments/celld/recovery/verify-bootstrap.rs', resolve(work, 'src/bootstrap.rs'))
cpSync('experiments/celld/recovery/verify-ltx.rs', resolve(work, 'src/main.rs'))
// Seed from upstream rather than independently selecting newer transitive SDKs.
cpSync(resolve(source, 'Cargo.lock'), resolve(work, 'Cargo.lock'))
// Match the native logic crate's MSRV without changing the user's default toolchain.
const toolchain = '1.94.1'
// Resolve metadata without compiling dependencies/build scripts. Validate the
// resulting source/checksum identities BEFORE executing any dependency code.
execFileSync('cargo', [`+${toolchain}`, 'metadata', '--format-version', '1', '--manifest-path', resolve(work, 'Cargo.toml')], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 10 * 60_000 })
verifyLockSubset(readFileSync(resolve(source, 'Cargo.lock'), 'utf8'), readFileSync(resolve(work, 'Cargo.lock'), 'utf8'))
// Resolve the root once, validate source+checksum identities, then prohibit lock changes.
execFileSync('cargo', [`+${toolchain}`, 'build', '--locked', '--manifest-path', resolve(work, 'Cargo.toml')], { stdio: 'inherit', timeout: 10 * 60_000 })
const compiler = execFileSync('rustc', [`+${toolchain}`, '-Vv'], { encoding: 'utf8' }).trim()
const cargoVersion = execFileSync('cargo', [`+${toolchain}`, '-V'], { encoding: 'utf8' }).trim()
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
writeFileSync(resolve(work, 'attestation.json'), JSON.stringify({ sourceCommit: expected, toolchain, compiler, cargoVersion, rustflags: process.env.RUSTFLAGS ?? '', cargoEncodedRustflags: process.env.CARGO_ENCODED_RUSTFLAGS ?? '', helperSha256: hash('experiments/celld/recovery/verify-ltx.rs'), binarySha256: hash(resolve(work, 'target/debug/celld-lab-ltx-verifier')), lockSha256: hash(resolve(work, 'Cargo.lock')), bootstrapHelperSha256: hash('experiments/celld/recovery/verify-bootstrap.rs'), bootstrapBinarySha256: hash(resolve(work, 'target/debug/celld-lab-bootstrap-verifier')) }), { mode: 0o600 })
console.log('Built offline verifier from pinned celld decoder. No AWS mutations or ownership imports.')
