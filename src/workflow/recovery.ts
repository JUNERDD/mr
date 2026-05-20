import { access } from 'node:fs/promises'
import { CliError, compactOutput } from '../core/errors.js'
import { git, gitOutput } from '../git/client.js'

type RecoveryResult = {
  attempted: boolean
  branch: string
  details: string[]
  restored: boolean
}

function asCliError(error: unknown) {
  if (error instanceof CliError) {
    return error
  }

  return new CliError((error as any)?.message ?? '未知错误。', {
    details: compactOutput((error as any)?.stack),
  })
}

export function withRecoveryDetails(error: unknown, recovery: RecoveryResult) {
  const cliError = asCliError(error)
  if (!recovery.attempted) {
    return cliError
  }

  const next = [...cliError.next]
  if (!recovery.restored) {
    next.push(`手动回到初始分支: git switch ${recovery.branch}`)
  }

  return new CliError(cliError.message, {
    exitCode: cliError.exitCode,
    details: [...cliError.details, ...recovery.details],
    next,
  })
}

export async function restoreInitialBranch(initialBranch: string, context: any): Promise<RecoveryResult> {
  const activeBranch = await gitOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], context)
  if (activeBranch === initialBranch) {
    return { attempted: false, branch: initialBranch, details: [], restored: true }
  }

  context.ui.step('恢复', `回到初始分支 ${initialBranch}。`)

  const details: string[] = []
  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })

  if (mergeHead.exitCode === 0) {
    const abort = await git(['merge', '--abort'], context, {
      allowFailure: true,
      label: '中止未完成合并',
      mutates: true,
    })

    if (abort.exitCode !== 0) {
      details.push('自动中止未完成合并失败。', ...compactOutput(abort.all))
    }
  }

  if ((await hasGitState('rebase-merge', context)) || (await hasGitState('rebase-apply', context))) {
    const abort = await git(['rebase', '--abort'], context, {
      allowFailure: true,
      label: '中止未完成 rebase',
      mutates: true,
    })

    if (abort.exitCode !== 0) {
      details.push('自动中止未完成 rebase 失败。', ...compactOutput(abort.all))
    }
  }

  const switched = await git(['switch', initialBranch], context, {
    allowFailure: true,
    label: `回到 ${initialBranch}`,
    mutates: true,
  })
  const finalBranch = await gitOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], context)

  if (finalBranch === initialBranch) {
    return {
      attempted: true,
      branch: initialBranch,
      details: [...details, `已自动回到初始分支: ${initialBranch}`],
      restored: true,
    }
  }

  return {
    attempted: true,
    branch: initialBranch,
    details: [...details, `自动回到初始分支失败: ${initialBranch}`, ...compactOutput(switched.all)],
    restored: false,
  }
}

async function hasGitState(path: string, context: any) {
  const gitPath = await gitOutput(['rev-parse', '--git-path', path], context)
  if (!gitPath) {
    return false
  }

  try {
    await access(gitPath)
    return true
  } catch {
    return false
  }
}
