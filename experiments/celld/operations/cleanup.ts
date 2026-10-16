export interface CleanupStack {
  region: 'us-east-1' | 'us-west-2'
  stackName: string
  stackId: string
  status: string
  retained: Array<{ logicalId: string; type: string; physicalId: string }>
}
const suffixOrder = ['global', 'regional', 'ownership-writer', 'directory', 'directory-deployer'] as const
export function validateCleanupStacks(prefix: string, account: string, stacks: CleanupStack[]): CleanupStack[] {
  if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix) || !/^\d{12}$/.test(account) || stacks.length === 0) throw new Error('Invalid cleanup scope')
  const seen = new Set<string>()
  for (const stack of stacks) {
    const suffix = stack.stackName.slice(prefix.length + 1)
    if (!stack.stackName.startsWith(prefix + '-') || !(suffixOrder as readonly string[]).includes(suffix)
      || !['us-east-1', 'us-west-2'].includes(stack.region) || (stack.region === 'us-west-2' && suffix !== 'regional')
      || !stack.stackId.startsWith(`arn:aws:cloudformation:${stack.region}:${account}:stack/${stack.stackName}/`)
      || !/^(CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)$/.test(stack.status)) throw new Error('Cleanup includes an unowned, unexpected or busy stack')
    const key = `${stack.region}/${stack.stackName}`
    if (seen.has(key)) throw new Error('Duplicate cleanup stack')
    seen.add(key)
  }
  return [...stacks].sort((a, b) => {
    const order = (stack: CleanupStack) => suffixOrder.indexOf(stack.stackName.slice(prefix.length + 1) as typeof suffixOrder[number])
    return order(a) - order(b) || b.region.localeCompare(a.region)
  })
}
export function validateDeleteConfirmation(prefix: string, input: { execute: boolean; confirmation?: string | undefined; acknowledgedRetainedCosts: boolean }) {
  if (!input.execute || input.confirmation !== prefix || !input.acknowledgedRetainedCosts) throw new Error('Deletion requires explicit experiment-name confirmation and retained-cost acknowledgement')
}
