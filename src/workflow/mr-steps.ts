import { CliError, compactOutput } from '../core/errors.js'
import { readRequestCommandSettings } from '../core/request-command.js'
import { fetchRemoteBranch, getMergeBase, git } from '../git/client.js'
import { rewriteRebaseConflictMarkers } from '../git/conflicts.js'
import { run } from '../runtime/runner.js'

export class MergeConflictError extends CliError {}
export class RebaseConflictError extends CliError {}
export class MergeTargetConflictError extends CliError {}

export type PullRequestResult = {
  all: string
  exitCode: number
  skipped?: boolean
  stderr: string
  stdout: string
}

export async function createPullRequest(
  mrBranch: string,
  targetBranch: string,
  context: any,
  { allowFailure = false, labelPrefix = '处理合并请求', promptWhenMissing = true } = {},
): Promise<PullRequestResult> {
  const requestCommand = (await readRequestCommandSettings(context)).effective
  if (!requestCommand) {
    if (promptWhenMissing) {
      context.ui.status('info', `已推送 ${mrBranch}，请在 Git 平台创建合并请求到 ${targetBranch}。`)
    }
    return { exitCode: 0, stdout: '', stderr: '', all: '', skipped: true }
  }

  return run('sh', ['-c', requestCommand], {
    label: `${labelPrefix} ${mrBranch} -> ${targetBranch}`,
    allowFailure,
    env: requestCommandEnv(mrBranch, targetBranch),
    showOutput: true,
    mutates: true,
    context,
  })
}

export function requestCompletionLines(sourceBranch: string, targetBranch: string, result?: { skipped?: boolean }) {
  return result?.skipped
    ? [`请求源已就绪 ${sourceBranch}`, `手动创建  ${sourceBranch} -> ${targetBranch}`]
    : [`合并请求  ${sourceBranch} -> ${targetBranch}`]
}

function requestCommandEnv(sourceBranch: string, targetBranch: string) {
  return {
    MR_BASE_BRANCH: targetBranch,
    MR_HEAD_BRANCH: sourceBranch,
    MR_SOURCE_BRANCH: sourceBranch,
    MR_TARGET_BRANCH: targetBranch,
  }
}

export async function refreshTargetBranch(targetBranch: string, context: any) {
  context.ui.step('检查', `刷新目标分支 origin/${targetBranch}。`)
  await fetchRemoteBranch(targetBranch, context)
}

export async function mergeCurrentBranchIntoMr(
  mrBranch: string,
  currentBranch: string,
  targetBranch: string,
  context: any,
  { requestCreated = false }: { requestCreated?: boolean } = {},
) {
  context.ui.step('合并', `把 ${currentBranch} 合入 ${mrBranch}。`)
  const result = await git(['merge', '--no-edit', currentBranch], context, {
    label: `合并 ${currentBranch}`,
    allowFailure: true,
    mutates: true,
  })

  if (result.exitCode === 0) {
    return
  }

  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })
  if (mergeHead.exitCode !== 0) {
    throw new CliError(`合并 ${currentBranch} 到 ${mrBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['追加 --verbose 查看完整命令和输出后重试。'],
    })
  }

  const next = [
    `当前停留在 ${mrBranch} 的冲突状态，请直接解决冲突。`,
    '解决冲突后执行: git add <files>',
    `然后重新运行: mr ${targetBranch}`,
  ]
  if (!requestCreated) {
    next.push(`或推送后在 Git 平台手动创建合并请求: ${mrBranch} -> ${targetBranch}`)
  }

  throw new MergeConflictError(`合并 ${currentBranch} 到 ${mrBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next,
  })
}

export async function mergeTargetBranchIntoMr(mrBranch: string, targetBranch: string, context: any) {
  context.ui.step('合并', `把 origin/${targetBranch} 合入 ${mrBranch}。`)
  const result = await git(['merge', '--no-edit', `origin/${targetBranch}`], context, {
    label: `合并 origin/${targetBranch}`,
    allowFailure: true,
    mutates: true,
  })

  if (result.exitCode === 0) {
    return
  }

  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })
  if (mergeHead.exitCode !== 0) {
    throw new CliError(`合并 origin/${targetBranch} 到 ${mrBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['追加 --verbose 查看完整命令和输出后重试。'],
    })
  }

  throw new MergeConflictError(`合并 origin/${targetBranch} 到 ${mrBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: [
      `当前停留在 ${mrBranch} 的冲突状态，请直接解决冲突。`,
      '解决冲突后执行: git add <files>',
      `然后重新运行: mr ${targetBranch}`,
    ],
  })
}

export async function mergeOriginTargetIntoMr(mrBranch: string, targetBranch: string, context: any) {
  context.ui.step('合并', `把 origin/${targetBranch} 合入 ${mrBranch}。`)
  const result = await git(['merge', '--no-edit', `origin/${targetBranch}`], context, {
    label: `合并 origin/${targetBranch}`,
    allowFailure: true,
    mutates: true,
  })

  if (result.exitCode === 0) {
    return
  }

  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })
  if (mergeHead.exitCode !== 0) {
    throw new CliError(`合并 origin/${targetBranch} 到 ${mrBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['追加 --verbose 查看完整命令和输出后重试。'],
    })
  }

  throw new MergeTargetConflictError(`合并 origin/${targetBranch} 到 ${mrBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: [
      `当前停留在 ${mrBranch} 的冲突状态，请直接解决冲突。`,
      '解决冲突后执行: git add <files>',
      `然后重新运行: mr ${targetBranch} --merge-target`,
    ],
  })
}

export async function rebaseMrBranchOntoTarget(
  mrBranch: string,
  currentBranch: string,
  targetBranch: string,
  forkPoint: string,
  context: any,
) {
  context.ui.step('变基', `把 ${mrBranch} 变基到 origin/${targetBranch}。`)
  const result = await git(['rebase', '--onto', `origin/${targetBranch}`, forkPoint, mrBranch], context, {
    label: `变基 ${currentBranch}`,
    allowFailure: true,
    mutates: true,
  })

  if (result.exitCode === 0) {
    return
  }

  const rebaseHead = await git(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })
  if (rebaseHead.exitCode !== 0) {
    throw new CliError(`变基 ${mrBranch} 到 ${targetBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['追加 --verbose 查看完整命令和输出后重试。'],
    })
  }

  await rewriteRebaseConflictMarkers(currentBranch, targetBranch, context)

  throw new RebaseConflictError(`变基 ${mrBranch} 到 ${targetBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: [
      `当前处于 ${mrBranch} 的 rebase 冲突状态，请直接解决冲突。`,
      '解决冲突后执行: git add <files>',
      `然后重新运行: mr ${targetBranch}`,
    ],
  })
}

export async function pushMrBranch(mrBranch: string, context: any) {
  await git(['push', 'origin', `HEAD:${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })
}

export async function pushMrBranchForceWithLease(mrBranch: string, context: any) {
  await git(['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })
}

export async function getForkPoint(targetBranch: string, currentBranch: string, context: any) {
  return getMergeBase(`origin/${targetBranch}`, currentBranch, context)
}
