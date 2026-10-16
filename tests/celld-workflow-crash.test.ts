import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {it,expect} from 'vitest'
const script=resolve('experiments/celld/scripts/verify-workflow-crash.ts')
it('does no local preparation or fault by default, without build/binary/token prerequisites',()=>{
  const cwd=mkdtempSync(resolve(tmpdir(),'celld-crash-plan-'))
  try {
    const output=execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,AWS_PROFILE:''}})
    expect(output).toContain('Plan only:');expect(output).toContain('No existing dev process, AWS')
    expect(readdirSync(cwd)).toEqual([])
  }finally{rmSync(cwd,{recursive:true,force:true})}
})
it.each(['archive','binary'])('rejects a mismatched %s before executing the native runtime or preparing a fixture',kind=>{
  const cwd=mkdtempSync(resolve(tmpdir(),'celld-crash-pin-'))
  try {
    const dir=resolve(cwd,'.omx/local/celld-bin'),lab=resolve(cwd,'experiments/celld');mkdirSync(dir,{recursive:true});mkdirSync(lab,{recursive:true})
    const archive=gzipSync('fixture binary that must never execute')
    const digest=createHash('sha256').update(archive).digest('hex')
    writeFileSync(resolve(lab,'celld.lock.json'),JSON.stringify({assets:{[`${process.platform}-${process.arch}`]:{sha256:kind==='archive'?'mismatch':digest}}}))
    writeFileSync(resolve(dir,'celld.gz'),archive);writeFileSync(resolve(dir,'celld'),'not the pinned binary')
    expect(()=>execFileSync(process.execPath,[script,'--execute'],{cwd,stdio:'pipe'})).toThrow(kind==='archive'?/release archive mismatch/:/binary differs from pinned official release/)
    expect(readdirSync(resolve(cwd,'.omx/local'))).toEqual(['celld-bin'])
  }finally{rmSync(cwd,{recursive:true,force:true})}
})
