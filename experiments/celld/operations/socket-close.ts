/** Observe immediately, but allow a later process-death barrier to await it.
 * The internal rejection observer prevents timeout from bypassing caller cleanup.
 */
export function observeSocketClose(socket:Pick<WebSocket,'onclose'>,timeoutMs:number) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0) throw new Error('Invalid socket-close deadline')
  let timer:ReturnType<typeof setTimeout>|undefined
  const result=new Promise<{code:number;at:string}>((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Old socket did not disconnect after process death')),timeoutMs)
    socket.onclose=event=>{clearTimeout(timer);resolve({code:event.code,at:new Date().toISOString()})}
  })
  void result.catch(()=>{})
  return {result,cancel:()=>{clearTimeout(timer);socket.onclose=null}}
}
