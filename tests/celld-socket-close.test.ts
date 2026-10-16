import {it,expect,vi} from 'vitest'
import {observeSocketClose} from '../experiments/celld/operations/socket-close.ts'
it('allows the close timeout to reject before a later await without an unhandled rejection',async()=>{
  vi.useFakeTimers()
  try {
    const socket={onclose:null as WebSocket['onclose']},observed=observeSocketClose(socket,20)
    await vi.advanceTimersByTimeAsync(21)
    await expect(observed.result).rejects.toThrow('did not disconnect')
    observed.cancel();expect(socket.onclose).toBeNull()
  }finally{vi.useRealTimers()}
})
it('records the actual close code and cancels its timeout',async()=>{
  vi.useFakeTimers()
  try {
    const socket={onclose:null as WebSocket['onclose']},observed=observeSocketClose(socket,20)
    socket.onclose!.call(socket as WebSocket,{code:1006} as CloseEvent)
    expect((await observed.result).code).toBe(1006)
    expect(vi.getTimerCount()).toBe(0);observed.cancel()
  }finally{vi.useRealTimers()}
})
it('cancels an unused observation without a future timeout or listener',()=>{
  vi.useFakeTimers()
  try {
    const socket={onclose:null as WebSocket['onclose']},observed=observeSocketClose(socket,20)
    observed.cancel();expect(socket.onclose).toBeNull();expect(vi.getTimerCount()).toBe(0)
    expect(()=>observeSocketClose(socket,0)).toThrow('Invalid')
  }finally{vi.useRealTimers()}
})
