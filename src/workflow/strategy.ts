import { CliError } from '../core/errors.js'
import { gitOutput } from '../git/client.js'

export type MrStrategy = 'pr' | 'merge' | 'rebase' | 'merge-target'

export async function resolveMrStrategy(context: any): Promise<MrStrategy> {
  const value =
    resolveFlagStrategy(context) ??
    context.strategy ??
    context.env?.MR_STRATEGY ??
    (await gitOutput(['config', '--get', 'mr.strategy'], context)) ??
    (await resolveLegacyRebaseConfig(context)) ??
    'merge'

  return normalizeMrStrategy(value)
}

function normalizeMrStrategy(value: string): MrStrategy {
  const normalized = value.trim().toLowerCase().replace(/_/gu, '-')
  if (normalized === 'pr' || normalized === 'merge' || normalized === 'rebase' || normalized === 'merge-target') {
    return normalized
  }

  throw new CliError(`不支持的 MR 策略: ${value}`, {
    next: ['可选值: pr, merge, rebase, merge-target', '例如: git config mr.strategy merge-target'],
  })
}

function resolveFlagStrategy(context: any) {
  const strategies = [
    context.pr ? 'pr' : null,
    context.merge ? 'merge' : null,
    context.rebase ? 'rebase' : null,
    context.mergeTarget ? 'merge-target' : null,
  ].filter(Boolean)

  if (strategies.length > 1) {
    throw new CliError('只能指定一个 MR 策略选项。', {
      next: ['可选项: --pr, --merge, --rebase, --merge-target'],
    })
  }

  return strategies[0] ?? null
}

async function resolveLegacyRebaseConfig(context: any) {
  const value = await gitOutput(['config', '--bool', '--get', 'mr.rebase'], context)
  if (value === 'true') {
    return 'rebase'
  }

  if (value === 'false') {
    return 'merge'
  }

  return null
}
