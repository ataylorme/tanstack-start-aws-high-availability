// Short-lived, path-bound authentication before an unauthenticated caller can
// allocate a Durable Object/socket. Tickets are not ownership/fencing authority.
const protocolPrefix = 'celld-ticket-'
async function key(secret, usages) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages)
}
export async function issueSocketTicket(path, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ path, expires: now + 30_000, nonce: crypto.randomUUID() })).toString('base64url')
  const signature = await crypto.subtle.sign('HMAC', await key(secret, ['sign']), new TextEncoder().encode(payload))
  return `${protocolPrefix}${payload}.${Buffer.from(signature).toString('base64url')}`
}
export async function validSocketTicket(protocols, path, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof protocols !== 'string' || protocols.length > 1024) return false
  const parts = protocols.split(',').map(value => value.trim())
  if (!parts.includes('celld-v1')) return false
  const ticket = parts.find(value => value.startsWith(protocolPrefix))?.slice(protocolPrefix.length)
  if (!ticket || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return false
  try {
    const [payload, signature] = ticket.split('.')
    if (!(await crypto.subtle.verify('HMAC', await key(secret, ['verify']), Buffer.from(signature, 'base64url'), new TextEncoder().encode(payload)))) return false
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return value.path === path && Number.isSafeInteger(value.expires) && value.expires > now && value.expires <= now + 30_000
  } catch { return false }
}
