import { useApp } from 'ink'
import { argument, option } from 'pastel'
import { useCallback, useEffect, useMemo, useState } from 'react'
import zod from 'zod'
import { invokedNameFromArgv } from '../cli/invocation.js'
import { getCurrentArgv } from '../cli/runtime-state.js'
import { createContext } from '../core/context.js'
import { CliError, compactOutput } from '../core/errors.js'
import { isInteractiveInvocation, resolveTargetFromInvocation } from '../core/targets.js'
import { assertInteractiveTerminal, TargetPicker } from '../ui/select-target.js'
import { createMrFromTargetBranch } from '../workflow/create-mr.js'

export const description = `从目标分支准备 CNB 合并请求分支，并在本地处理冲突。

常用示例:
  mr                         交互式选择 master / test / prerelease
  mrm                        创建到 master 的合并请求
  mrt --dry-run              预览创建到 test 的执行计划
  mrp --verbose              创建到 prerelease，并显示完整命令输出
  mr release/2026-05         指定任意目标分支

维护命令:
  mr update                  更新到最新 release 预构建产物
  mr uninstall               卸载 mr

环境变量:
  NO_COLOR=1                 禁用颜色
  MR_NO_COLOR=1              仅对 mr 禁用颜色
  FORCE_COLOR=1              强制颜色
  DEBUG=mr                   等同于 --verbose`

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
  dryRun: zod.boolean().describe(option({ description: '打印执行计划，不修改本地或远程状态' })),
  pr: zod.boolean().describe(option({ description: '直接用当前分支作为 PR 源分支，不创建 MR 分支' })),
  verbose: zod.boolean().describe(option({ description: '显示 git/CNB 命令和完整输出' })),
  quiet: zod.boolean().describe(option({ description: '只输出错误' })),
  color: zod.boolean().describe(option({ description: '强制彩色输出' })),
  noColor: zod
    .boolean()
    .optional()
    .describe(option({ description: '禁用彩色输出' })),
  spinner: zod
    .boolean()
    .default(true)
    .describe(option({ description: '禁用交互式进度动画' })),
  merge: zod.boolean().describe(option({ description: '从目标分支准备 MR 分支，再 merge 当前分支；默认策略' })),
  rebase: zod.boolean().describe(option({ description: '从当前分支准备 MR 分支，再 rebase 到目标分支' })),
  mergeTarget: zod.boolean().describe(option({ description: '从当前分支准备 MR 分支，再 merge 目标分支' })),
})

type CommandArgs = zod.infer<typeof args>
type CommandOptions = zod.infer<typeof options>

type Props = {
  args: CommandArgs
  options: CommandOptions
}

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

export default function Index({ args: commandArgs, options: commandOptions }: Props) {
  const { exit } = useApp()
  const argv = getCurrentArgv()
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
  const targetArg = commandArgs[0]
  const interactive = isInteractiveInvocation(invokedName, targetArg)
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
  }, [fail, interactive, targetBranch])

  useEffect(() => {
    if (!targetBranch || started) {
      return
    }

    setStarted(true)
    void createMrFromTargetBranch(targetBranch, context)
      .then(() => exit())
      .catch(fail)
  }, [context, exit, fail, started, targetBranch])

  if (interactive && !targetBranch && process.stdin.isTTY && process.stderr.isTTY) {
    return <TargetPicker ui={context.ui} onSelect={setTargetBranch} onCancel={cancel} />
  }

  return null
}
