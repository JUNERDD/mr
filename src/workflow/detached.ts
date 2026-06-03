import { mrBranchName, printDryRun } from '../core/dry-run.js'
import { CliError, compactOutput } from '../core/errors.js'
import { fetchRemoteBranch, getCurrentBranch, git, gitOutput, isAncestor, remoteBranchExists } from '../git/client.js'
import { commitTree, mergeTree, pushCommit } from '../git/plumbing.js'
import { deleteRemoteMrBranchIfRequested } from './delete-mr-branch.js'
import { resumeDetachedConflictIfAny, runStrategyInWorktree } from './detached-worktree.js'
import { createPrFromCurrentBranch } from './pr-mr.js'
import { prepareExistingMrForMerge, prepareExistingMrForMergeTarget, prepareExistingMrForRebase } from './mr-reuse.js'
import {
  type PullRequestResult,
  createPullRequest,
  getForkPoint,
  refreshTargetBranch,
  requestCompletionLines,
} from './mr-steps.js'
import { resolveMrStrategy } from './strategy.js'

class DetachedMergeConflictError extends CliError {}

export async function createMrDetached(targetBranch: string, context: any) {
  if (await resumeDetachedConflictIfAny(targetBranch, context)) {
    return
  }

  const strategy = await resolveMrStrategy(context)
  if (strategy === 'pr') {
    await createPrFromCurrentBranch(targetBranch, context)
    return
  }

  const currentBranch = await getCurrentBranch(context)
  const mrBranch = mrBranchName(targetBranch, currentBranch)

  if (context.dryRun) {
    await printDryRun(targetBranch, currentBranch, context, strategy, { detached: true })
    return
  }

  context.ui.panel('mr  无感合并请求', [
    `目标分支  ${targetBranch}`,
    `当前分支  ${currentBranch}`,
    `MR 分支   ${mrBranch}`,
    `模式      detached（不切本地分支）`,
  ])

  context.ui.step('检查', `确认远程目标分支 origin/${targetBranch}。`)
  const targetExists = await remoteBranchExists(targetBranch, context)
  if (!targetExists) {
    throw new CliError(`远程目标分支不存在: origin/${targetBranch}`, {
      next: ['检查目标分支名称，或改用 mr <target> 指定正确分支。'],
    })
  }

  await refreshTargetBranch(targetBranch, context)
  const currentMergedTarget = await isAncestor(currentBranch, `origin/${targetBranch}`, context)
  if (currentMergedTarget) {
    context.ui.panel('无需操作', [`${currentBranch} 已经合入 ${targetBranch}。`], { tone: 'success' })
    return
  }

  await deleteRemoteMrBranchIfRequested(mrBranch, context)

  if (strategy === 'rebase') {
    const forkPoint = await getForkPoint(targetBranch, currentBranch, context)
    if (!context.deleteMrBranch) {
      const existing = await prepareExistingMrForRebase(mrBranch, targetBranch, currentBranch, forkPoint, context)
      if (existing.done) {
        return
      }
    }

    const requestResult = await runStrategyInWorktree(targetBranch, strategy, context, { currentBranch, mrBranch })
    finishDetachedPanel(context, mrBranch, targetBranch, currentBranch, requestResult)
    return
  }

  if (strategy === 'merge-target') {
    if (!context.deleteMrBranch) {
      const existing = await prepareExistingMrForMergeTarget(mrBranch, targetBranch, currentBranch, context)
      if (existing.done) {
        return
      }
    }

    try {
      const requestResult = await buildMergeTargetDetached(mrBranch, targetBranch, currentBranch, context)
      finishDetachedPanel(context, mrBranch, targetBranch, currentBranch, requestResult)
    } catch (error) {
      if (error instanceof DetachedMergeConflictError) {
        const requestResult = await runStrategyInWorktree(targetBranch, strategy, context, { currentBranch, mrBranch })
        finishDetachedPanel(context, mrBranch, targetBranch, currentBranch, requestResult)
        return
      }

      throw error
    }

    return
  }

  if (!context.deleteMrBranch) {
    const existing = await prepareExistingMrForMerge(mrBranch, targetBranch, currentBranch, context)
    if (existing.done) {
      return
    }
  }

  try {
    const requestResult = await buildMergeDetached(mrBranch, targetBranch, currentBranch, context)
    finishDetachedPanel(context, mrBranch, targetBranch, currentBranch, requestResult)
  } catch (error) {
    if (error instanceof DetachedMergeConflictError) {
      const requestResult = await runStrategyInWorktree(targetBranch, strategy, context, { currentBranch, mrBranch })
      finishDetachedPanel(context, mrBranch, targetBranch, currentBranch, requestResult)
      return
    }

    throw error
  }
}

function finishDetachedPanel(
  context: any,
  mrBranch: string,
  targetBranch: string,
  currentBranch: string,
  requestResult?: PullRequestResult,
) {
  context.ui.panel(
    '完成',
    [...requestCompletionLines(mrBranch, targetBranch, requestResult), `未切换分支  当前仍在 ${currentBranch}`],
    {
      tone: 'success',
    },
  )
}

async function buildMergeDetached(mrBranch: string, targetBranch: string, currentBranch: string, context: any) {
  if (!(await remoteBranchExists(mrBranch, context))) {
    context.ui.step('创建', `远程 MR 分支不存在，从 origin/${targetBranch} 创建 ${mrBranch}。`)
    await git(['push', 'origin', `refs/remotes/origin/${targetBranch}:refs/heads/${mrBranch}`], context, {
      label: `推送 ${mrBranch}`,
      mutates: true,
    })
  }

  await fetchRemoteBranch(mrBranch, context)
  const baseOid = await resolveOid(`origin/${mrBranch}`, context)
  let head = baseOid
  let changed = false

  // 仅在远程 MR 尚未包含当前分支时才造合并提交，避免无改动重跑时堆叠空合并提交。
  if (!(await isAncestor(currentBranch, baseOid, context))) {
    head = await mergeAndCommit(head, currentBranch, `Merge ${currentBranch} into ${mrBranch}`, context)
    changed = true
  }

  if (!(await isAncestor(`origin/${targetBranch}`, head, context))) {
    head = await mergeAndCommit(
      head,
      `origin/${targetBranch}`,
      `Merge origin/${targetBranch} into ${mrBranch}`,
      context,
    )
    changed = true
  }

  if (changed) {
    context.ui.step('推送', `推送 ${mrBranch}。`)
    await pushCommit(head, mrBranch, context)
  } else {
    context.ui.status('skip', `${mrBranch} 已包含当前分支与目标分支，无需更新。`)
  }
  return ensurePullRequest(mrBranch, targetBranch, context)
}

async function buildMergeTargetDetached(mrBranch: string, targetBranch: string, currentBranch: string, context: any) {
  // 当前分支已包含目标分支时无需再造合并提交，直接用当前分支作为 MR 内容。
  const head = (await isAncestor(`origin/${targetBranch}`, currentBranch, context))
    ? await resolveOid(currentBranch, context)
    : await mergeAndCommit(
        currentBranch,
        `origin/${targetBranch}`,
        `Merge origin/${targetBranch} into ${mrBranch}`,
        context,
      )

  context.ui.step('推送', `使用 force-with-lease 更新 ${mrBranch}。`)
  await pushCommit(head, mrBranch, context, { force: true })
  return ensurePullRequest(mrBranch, targetBranch, context)
}

async function resolveOid(ref: string, context: any) {
  const oid = await gitOutput(['rev-parse', '--verify', ref], context)
  if (!oid) {
    throw new CliError(`无法解析提交: ${ref}`, {
      next: ['确认相关分支已 fetch，并且本地仓库历史完整。'],
    })
  }

  return oid
}

async function mergeAndCommit(base: string, incoming: string, message: string, context: any) {
  context.ui.step('合并', `内存合并 ${incoming} 到 ${base}。`)
  const result = await mergeTree(base, incoming, context)
  if (result.conflict) {
    throw new DetachedMergeConflictError(`合并 ${incoming} 到 ${base} 时发生冲突。`, {
      details: compactOutput(result.messages),
      next: ['将切换到临时 worktree 继续处理冲突。'],
    })
  }

  return commitTree(result.tree, [base, incoming], message, context)
}

async function ensurePullRequest(mrBranch: string, targetBranch: string, context: any): Promise<PullRequestResult> {
  context.ui.step('合并请求', `处理合并请求: ${mrBranch} -> ${targetBranch}。`)
  const result = await createPullRequest(mrBranch, targetBranch, context, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    context.ui.status('warn', '合并请求命令未成功；MR 分支已推送。')
  }
  return result
}
