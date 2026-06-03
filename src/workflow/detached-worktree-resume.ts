import { CliError } from '../core/errors.js'
import { fetchRemoteBranch, git, gitOutput, isAncestor } from '../git/client.js'
import { type PullRequestResult, createPullRequest, pushMrBranch, pushMrBranchForceWithLease } from './mr-steps.js'

export async function resumeDetachedMrMerge(
  activeMerge: { currentBranch: string; mrBranch: string },
  targetBranch: string,
  wtContext: any,
): Promise<PullRequestResult> {
  const { currentBranch, mrBranch } = activeMerge
  const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], wtContext, {
    quiet: true,
    allowFailure: true,
  })
  if (unmerged.exitCode === 0 && unmerged.stdout.split('\n').filter(Boolean).length) {
    throw new CliError(`当前 ${mrBranch} 的合并冲突尚未标记解决。`, {
      details: unmerged.stdout,
      next: ['在 worktree 内解决冲突并 git add 后，回到主仓库重跑: mr ' + targetBranch + ' --detached'],
    })
  }

  // merge-target 的 worktree 分支从当前分支重置而来，与远程 MR 分叉，必须 force-with-lease；
  // 普通 merge 的 worktree 基于 origin/MR，可走快进的普通推送。
  const head = await gitOutput(['rev-parse', 'HEAD'], wtContext)
  const force = head ? await isAncestor(currentBranch, head, wtContext) : true

  wtContext.ui.step('继续', `提交 ${mrBranch} 的合并结果。`)
  await git(['commit', '--no-edit'], wtContext, { label: '提交合并结果', mutates: true })
  if (force) {
    await fetchRemoteBranch(mrBranch, wtContext, { allowMissing: true })
    await pushMrBranchForceWithLease(mrBranch, wtContext)
  } else {
    await pushMrBranch(mrBranch, wtContext)
  }
  const result = await createPullRequest(mrBranch, targetBranch, wtContext, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    wtContext.ui.status('warn', '合并请求命令未成功；MR 分支已推送。')
  }
  return result
}

export async function resumeDetachedMrRebase(
  activeRebase: { currentBranch: string; mrBranch: string },
  targetBranch: string,
  wtContext: any,
): Promise<PullRequestResult> {
  const { currentBranch, mrBranch } = activeRebase
  const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], wtContext, {
    quiet: true,
    allowFailure: true,
  })
  if (unmerged.exitCode === 0 && unmerged.stdout.split('\n').filter(Boolean).length) {
    throw new CliError(`当前 ${mrBranch} 的 rebase 冲突尚未标记解决。`, {
      details: unmerged.stdout,
      next: ['在 worktree 内解决冲突并 git add 后，回到主仓库重跑: mr ' + targetBranch + ' --detached'],
    })
  }

  wtContext.ui.step('继续', `继续 ${mrBranch} 的 rebase。`)
  const result = await git(['-c', 'core.editor=true', 'rebase', '--continue'], wtContext, {
    label: `继续变基 ${currentBranch}`,
    allowFailure: true,
    mutates: true,
  })
  if (result.exitCode !== 0) {
    throw new CliError(`继续变基 ${mrBranch} 到 ${targetBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: result.all,
    })
  }

  await pushMrBranchForceWithLease(mrBranch, wtContext)
  const pr = await createPullRequest(mrBranch, targetBranch, wtContext, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (pr.exitCode !== 0) {
    wtContext.ui.status('warn', '合并请求命令未成功；MR 分支已推送。')
  }
  return pr
}
