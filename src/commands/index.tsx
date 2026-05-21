import { useApp } from 'ink'
import { argument, option } from 'pastel'
import { useCallback, useEffect, useMemo, useState } from 'react'
import zod from 'zod'
import { invokedNameFromArgv } from '../cli/invocation.js'
import { getCurrentArgv } from '../cli/runtime-state.js'
import { createContext } from '../core/context.js'
import { CliError, compactOutput } from '../core/errors.js'
import { MR_STRATEGY_VALUES } from '../core/settings.js'
import { isInteractiveInvocation, resolveTargetFromInvocation } from '../core/targets.js'
import { runLifecycleCommand } from '../runtime/lifecycle.js'
import { assertInteractiveTerminal, TargetPicker } from '../ui/select-target.js'
import { ConfigCommand } from '../workflow/config-command.js'
import { createMrFromTargetBranch } from '../workflow/create-mr.js'

export const description = `从目标分支准备 CNB 合并请求分支，并在本地处理冲突。

常用示例:
  mr                         交互式选择 master / test / prerelease
  mrm                        创建到 master 的合并请求
  mrt --dry-run              预览创建到 test 的执行计划
  mrp --verbose              创建到 prerelease，并显示完整命令输出
  mr release/2026-05         指定任意目标分支

维护命令:
  mr --config                交互式查看和设置默认 MR 策略
  mr --update                更新到最新 release 预构建产物
  mr --uninstall             卸载 mr

环境变量:
  NO_COLOR=1                 禁用颜色
  MR_NO_COLOR=1              仅对 mr 禁用颜色
  FORCE_COLOR=1              强制颜色
  DEBUG=mr                   等同于 --verbose`

const describedFlag = (description: string, defaultValueDescription = '关闭') =>
  option({ description, defaultValueDescription })

export const args = zod.tuple([
  zod
    .string()
    .optional()
    .describe(
      argument({
        name: 'target',
        description: '目标分支，例如 master、test、prerelease',
      }),
    ),
])

export const options = zod.object({
  config: zod.boolean().describe(describedFlag('交互式查看和设置默认 MR 策略')),
  dryRun: zod.boolean().describe(describedFlag('打印执行计划，不修改本地或远程状态')),
  global: zod.boolean().describe(describedFlag('配合 --config 写入全局 Git config')),
  local: zod.boolean().describe(describedFlag('配合 --config 写入当前仓库 Git config')),
  pr: zod.boolean().describe(describedFlag('临时覆盖为直接 PR 策略，不创建 MR 分支', '未指定')),
  show: zod.boolean().describe(describedFlag('配合 --config 只显示当前配置')),
  strategy: zod
    .enum(MR_STRATEGY_VALUES)
    .optional()
    .describe(
      option({
        description: '配合 --config 非交互设置默认 MR 策略',
        valueDescription: 'strategy',
      }),
    ),
  uninstall: zod.boolean().describe(describedFlag('卸载 mr')),
  update: zod.boolean().describe(describedFlag('更新到最新 release 预构建产物')),
  unset: zod.boolean().describe(describedFlag('配合 --config 清除指定作用域的 mr.strategy')),
  verbose: zod.boolean().describe(describedFlag('显示 git/CNB 命令和完整输出')),
  quiet: zod.boolean().describe(describedFlag('只输出错误')),
  color: zod.boolean().describe(describedFlag('强制彩色输出', '自动')),
  noColor: zod.boolean().optional().describe(describedFlag('禁用彩色输出', '自动')),
  spinner: zod
    .boolean()
    .default(true)
    .describe(option({ description: '禁用交互式进度动画' })),
  merge: zod.boolean().describe(describedFlag('临时覆盖为 merge 策略；未指定策略时读取 mr --config', '按配置')),
  rebase: zod.boolean().describe(describedFlag('临时覆盖为 rebase 策略', '未指定')),
  mergeTarget: zod.boolean().describe(describedFlag('临时覆盖为 merge-target 策略', '未指定')),
})

type CommandArgs = zod.infer<typeof args>
type CommandOptions = zod.infer<typeof options>

type Props = {
  args: CommandArgs
  options: CommandOptions
}

type MaintenanceCommand = 'config' | 'uninstall' | 'update'

function colorOptionFromArgv(argv: string[]) {
  if (argv.includes('--color')) {
    return true
  }

  if (argv.includes('--no-color')) {
    return false
  }

  return undefined
}

function toCliError(error: any) {
  if (error instanceof CliError) {
    return error
  }

  return new CliError(error?.message ?? '未知错误。', { details: compactOutput(error?.stack) })
}

function resolveMaintenanceOptions(options: CommandOptions, targetArg?: string) {
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

  const configOnlyOptions = [
    options.global ? '--global' : null,
    options.local ? '--local' : null,
    options.show ? '--show' : null,
    options.strategy ? '--strategy' : null,
    options.unset ? '--unset' : null,
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

export default function Index({ args: commandArgs, options: commandOptions }: Props) {
  const { exit } = useApp()
  const argv = getCurrentArgv()
  const targetArg = commandArgs[0]
  const { command: maintenanceCommand, error: maintenanceError } = useMemo(
    () => resolveMaintenanceOptions(commandOptions, targetArg),
    [commandOptions, targetArg],
  )
  const context = useMemo(
    () =>
      createContext({
        color: colorOptionFromArgv(argv),
        dryRun: commandOptions.dryRun,
        merge: commandOptions.merge,
        mergeTarget: commandOptions.mergeTarget,
        quiet: commandOptions.quiet,
        pr: commandOptions.pr,
        rebase: commandOptions.rebase,
        spinner: commandOptions.spinner,
        verbose: commandOptions.verbose,
      }),
    [argv, commandOptions],
  )
  const invokedName = invokedNameFromArgv(argv)
  const interactive = !maintenanceCommand && isInteractiveInvocation(invokedName, targetArg)
  const [targetBranch, setTargetBranch] = useState(() =>
    interactive ? undefined : resolveTargetFromInvocation(invokedName, targetArg),
  )
  const [started, setStarted] = useState(false)

  const fail = useCallback(
    (error: unknown) => {
      const cliError = toCliError(error)
      context.ui.error(cliError)
      process.exitCode = cliError.exitCode || 1
      exit()
    },
    [context, exit],
  )

  const cancel = useCallback(() => {
    fail(new CliError('已取消选择。', { exitCode: 130 }))
  }, [fail])

  useEffect(() => {
    if (maintenanceError) {
      fail(maintenanceError)
    }
  }, [fail, maintenanceError])

  useEffect(() => {
    if (!maintenanceCommand || maintenanceCommand === 'config' || started || maintenanceError) {
      return
    }

    setStarted(true)
    void runLifecycleCommand(maintenanceCommand, { argv })
      .then((exitCode) => {
        process.exitCode = exitCode
        exit()
      })
      .catch(fail)
  }, [argv, exit, fail, maintenanceCommand, maintenanceError, started])

  useEffect(() => {
    if (maintenanceCommand || maintenanceError) {
      return
    }

    if (targetBranch) {
      return
    }

    if (!interactive) {
      fail(
        new CliError('未指定目标分支。', {
          next: ['使用 mr master、mr test、mr prerelease，或通过 mr 进入交互式选择。'],
        }),
      )
      return
    }

    try {
      assertInteractiveTerminal(process.stdin, process.stderr)
    } catch (error) {
      fail(error)
    }
  }, [fail, interactive, maintenanceCommand, maintenanceError, targetBranch])

  useEffect(() => {
    if (maintenanceCommand || maintenanceError || !targetBranch || started) {
      return
    }

    setStarted(true)
    void createMrFromTargetBranch(targetBranch, context)
      .then(() => exit())
      .catch(fail)
  }, [context, exit, fail, maintenanceCommand, maintenanceError, started, targetBranch])

  if (maintenanceError) {
    return null
  }

  if (maintenanceCommand === 'config') {
    return <ConfigCommand options={commandOptions} />
  }

  if (!maintenanceCommand && interactive && !targetBranch && process.stdin.isTTY && process.stderr.isTTY) {
    return <TargetPicker ui={context.ui} onSelect={setTargetBranch} onCancel={cancel} />
  }

  return null
}
