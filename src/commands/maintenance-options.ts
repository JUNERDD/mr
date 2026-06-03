import { CliError } from '../core/errors.js'

export type MaintenanceCommand = 'config' | 'uninstall' | 'update'

export type CommandOptionsLike = {
  config?: boolean
  detached?: boolean
  dryRun?: boolean
  global?: boolean
  local?: boolean
  merge?: boolean
  mergeTarget?: boolean
  noDetached?: boolean
  pr?: boolean
  rebase?: boolean
  requestCommand?: unknown
  requestProvider?: unknown
  rmMr?: boolean
  show?: boolean
  strategy?: unknown
  uninstall?: boolean
  unset?: boolean
  unsetRequestCommand?: boolean
  unsetRequestProvider?: boolean
  update?: boolean
}

export function colorOptionFromArgv(argv: string[]) {
  if (argv.includes('--color')) {
    return true
  }

  if (argv.includes('--no-color')) {
    return false
  }

  return undefined
}

export function detachedOptionFromArgv(argv: string[]) {
  if (argv.includes('--detached')) {
    return true
  }

  if (argv.includes('--no-detached')) {
    return false
  }

  return undefined
}

export function resolveDetachedFromOptions(argv: string[], options: CommandOptionsLike) {
  const fromArgv = detachedOptionFromArgv(argv)
  if (fromArgv !== undefined) {
    return fromArgv
  }

  if (options.detached) {
    return true
  }

  if (options.noDetached) {
    return false
  }

  return undefined
}

export function resolveMaintenanceOptions(options: CommandOptionsLike, targetArg?: string) {
  const commands: MaintenanceCommand[] = []
  if (options.config) {
    commands.push('config')
  }
  if (options.update) {
    commands.push('update')
  }
  if (options.uninstall) {
    commands.push('uninstall')
  }

  if (commands.length > 1) {
    return {
      command: undefined,
      error: new CliError('只能指定一个维护选项。', {
        next: ['可选项: --config, --update, --uninstall'],
      }),
    }
  }

  // --detached / --no-detached 是正交修饰符：既能配合 --config 写入默认值，也能直接用于
  // mr <target> 工作流，所以它们既不属于 config-only，也不属于 MR 工作流互斥项。
  const configOnlyOptions = [
    options.global ? '--global' : null,
    options.local ? '--local' : null,
    options.show ? '--show' : null,
    options.strategy ? '--strategy' : null,
    options.requestCommand ? '--request-command' : null,
    options.requestProvider ? '--request-provider' : null,
    options.unset ? '--unset' : null,
    options.unsetRequestCommand ? '--unset-request-command' : null,
    options.unsetRequestProvider ? '--unset-request-provider' : null,
  ].filter(Boolean)

  if (!options.config && configOnlyOptions.length) {
    return {
      command: undefined,
      error: new CliError(`${configOnlyOptions.join(', ')} 需要和 --config 一起使用。`, {
        next: ['例如: mr --config --strategy rebase'],
      }),
    }
  }

  const mrWorkflowOptions = [
    options.dryRun ? '--dry-run' : null,
    options.pr ? '--pr' : null,
    options.merge ? '--merge' : null,
    options.rebase ? '--rebase' : null,
    options.mergeTarget ? '--merge-target' : null,
    options.rmMr ? '--rm-mr' : null,
  ].filter(Boolean)

  if (commands.length && mrWorkflowOptions.length) {
    return {
      command: undefined,
      error: new CliError(`维护选项不能和 MR 工作流选项 ${mrWorkflowOptions.join(', ')} 同时使用。`, {
        next: ['维护操作使用 --config / --update / --uninstall；创建合并请求时再使用 --dry-run / --rebase 等选项。'],
      }),
    }
  }

  if (commands.length && targetArg) {
    return {
      command: undefined,
      error: new CliError('维护选项不能和目标分支同时使用。', {
        next: ['例如: mr --config，或 mr release/2026-05'],
      }),
    }
  }

  return { command: commands[0], error: null }
}
