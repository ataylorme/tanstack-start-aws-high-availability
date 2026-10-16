import { expect, it } from 'vitest'
import { requireNativeRejection } from '../experiments/celld/recovery/native-failure.ts'
it('requires a normal native rejection and optionally its exact diagnostic',()=> {
  const failure={status:1,signal:null,stderr:'LTX verification failed: transaction not available\n'}
  expect(requireNativeRejection(failure,'transaction not available')).toBe('LTX verification failed: transaction not available')
  expect(()=>requireNativeRejection(failure,'different error')).toThrow()
})
it.each([
  {status:null,signal:'SIGTERM',stderr:'LTX verification failed: timeout'},
  {status:1,signal:'SIGKILL',stderr:'LTX verification failed: interrupted'},
  {code:'ENOENT'},
  {status:101,signal:null,stderr:'panic'},
  {status:1,signal:null,stderr:'unrelated CLI failure'},
  {status:1,signal:null,stderr:'LTX verification failed: '},
  null,
])('does not misclassify execution failure as rejected recovery data: %j',failure=> {
  expect(()=>requireNativeRejection(failure)).toThrow()
})
