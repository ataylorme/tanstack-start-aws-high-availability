// Strict extraction of Cargo-generated package identity fields, not a general TOML parser.
export function lockIdentities(lock: string): string[] {
  return lock.split('[[package]]').slice(1).map(section => {
    const field = (name: string, required = false) => {
      const lines = section.split('\n').filter(line => line.startsWith(name + ' = '))
      if (!lines.length && !required) return null
      if (lines.length !== 1) throw new Error('Missing or duplicate Cargo identity field')
      const value = lines[0]!.match(/^[a-z]+ = "([^"\\]+)"$/)?.[1]
      if (!value) throw new Error('Unsupported Cargo identity encoding')
      return value
    }
    const identity = {name:field('name',true),version:field('version',true),source:field('source'),checksum:field('checksum')}
    if (identity.checksum && !identity.source) throw new Error('Checksum without source')
    return JSON.stringify(identity)
  })
}
export function verifyLockSubset(upstream: string, selected: string) {
  const expected = new Set(lockIdentities(upstream))
  const root = JSON.stringify({name:'celld-lab-ltx-verifier',version:'0.0.0',source:null,checksum:null})
  const actual = lockIdentities(selected)
  if (!actual.length || actual.filter(value=>value===root).length!==1 || actual.some(value=>value!==root && !expected.has(value))) throw new Error('Verifier dependency identity outside approved upstream lock')
}
