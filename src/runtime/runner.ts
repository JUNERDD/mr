import { execa } from 'execa'
import ora from 'ora'
import { CliError, compactOutput } from '../core/errors.js'
import { formatCommand } from '../core/format.js'
import { createUi } from '../ui/terminal.js'

const LINE_SPINNER = {
  interval: 80,
  frames: ['-', '\\', '|', '/'],
}

const SUCCESS_RESULT = { exitCode: 0, stdout: '', stderr: '', all: '' }

type RunOptions = {
  allowFailure?: boolean
  context?: any
  label?: string
  mutates?: boolean
  quiet?: boolean
  showOutput?: boolean
}

export async function run(
  command: string,
  args: string[],
  { label, allowFailure = false, quiet = false, showOutput = false, mutates = false, context }: RunOptions = {},
): Promise<any> {
  const ui = context?.ui ?? createUi()
  const verbose = Boolean(context?.verbose)
  const commandLabel = label ?? formatCommand(command, args)

  if (context?.dryRun && mutates) {
    if (!quiet) {
      ui.status('plan', commandLabel)
      ui.command(command, args)
    }

    return SUCCESS_RESULT
  }

  if (verbose) {
    ui.command(command, args)
  }

  let spinner = null
  if (!quiet && !ui.quiet) {
    if (ui.spinnerEnabled) {
      spinner = ora({
        text: commandLabel,
        spinner: LINE_SPINNER,
        stream: ui.stream,
        color: false,
        discardStdin: false,
        indent: 2,
      }).start()
    } else if (ui.liveStatusEnabled) {
      ui.status('run', commandLabel)
    }
  }

  const result = await execute(command, args, spinner, ui, commandLabel)
  const succeeded = result.exitCode === 0
  persistResult(spinner, ui, quiet, succeeded, commandLabel)
  maybePrintOutput(result, ui, quiet, verbose, showOutput, succeeded)

  if (!allowFailure && !succeeded) {
    throw new CliError(`${formatCommand(command, args)} 执行失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: verbose ? [] : ['追加 --verbose 可查看完整命令和输出。'],
    })
  }

  return result
}

async function execute(
  command: string,
  args: string[],
  spinner: any,
  ui: ReturnType<typeof createUi>,
  commandLabel: string,
) {
  try {
    return await execa(command, args, { all: true, reject: false })
  } catch (error: any) {
    if (spinner) {
      spinner.stopAndPersist({
        symbol: ui.colors.red('x'),
        text: commandLabel,
      })
    }

    if (error?.code === 'ENOENT') {
      throw new CliError(`缺少命令: ${command}`, {
        next: ['确认依赖已安装，并且命令在 PATH 中。'],
      })
    }

    throw new CliError(`无法执行命令: ${formatCommand(command, args)}`, {
      details: compactOutput(error?.shortMessage ?? error?.message),
    })
  }
}

function persistResult(
  spinner: any,
  ui: ReturnType<typeof createUi>,
  quiet: boolean,
  succeeded: boolean,
  commandLabel: string,
) {
  if (spinner) {
    spinner.stopAndPersist({
      symbol: succeeded ? ui.colors.cyan('+') : ui.colors.red('x'),
      text: commandLabel,
    })
  } else if (!quiet && !ui.quiet) {
    ui.status(succeeded ? 'ok' : 'err', commandLabel)
  }
}

function maybePrintOutput(
  result: any,
  ui: ReturnType<typeof createUi>,
  quiet: boolean,
  verbose: boolean,
  showOutput: boolean,
  succeeded: boolean,
) {
  const combinedOutput = result.all ?? result.stderr ?? result.stdout ?? ''
  if (!combinedOutput || quiet || ui.quiet || !(verbose || showOutput || !succeeded)) {
    return
  }

  ui.output(combinedOutput, {
    error: !succeeded,
    maxLines: verbose ? Infinity : 30,
  })
}
