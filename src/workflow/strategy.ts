import { CliError } from '../core/errors.js'
import { type MrStrategy, normalizeMrStrategy, readMrSettings } from '../core/settings.js'

export async function resolveMrStrategy(context: any): Promise<MrStrategy> {
  const value = resolveFlagStrategy(context) ?? context.strategy

  if (value) {
    return normalizeMrStrategy(value)
  }

  return (await readMrSettings(context)).effective
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
