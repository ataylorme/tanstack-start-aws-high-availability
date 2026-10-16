import { execFileSync } from 'node:child_process'
import { expect,it } from 'vitest'
const script='experiments/celld/scripts/verify-aws.ts'
it('keeps the AWS retry probe plan-only unless explicitly executed',()=> {
  const output=execFileSync(process.execPath,[script,'--workflow-retry'],{encoding:'utf8',env:{...process.env,AWS_PROFILE:''}})
  expect(output).toContain('run-scoped evidence')
  expect(output).toContain('preserving the current recovery ledger')
})
it('rejects combining retry verification with a node-loss fault before AWS calls',()=> {
  expect(()=>execFileSync(process.execPath,[script,'--workflow-retry','--node-loss','--execute'],{stdio:'pipe',env:{...process.env,AWS_PROFILE:''}})).toThrow(/separately/)
})
it('refuses to send the local lab credential to remote endpoints',()=> {
  expect(()=>execFileSync(process.execPath,['experiments/celld/scripts/verify-workflow-retry.ts','http://example.invalid'],{stdio:'pipe',env:{...process.env,LAB_TOKEN_FILE:'/nonexistent-token-file'}})).toThrow(/Local probe only/)
})
