import {
  fetchRemoteBranch,
  hasNoNewPatchChanges,
  hasNoUncontestedTreeChanges,
  hasSameReplayedCommitSeries,
  isAncestor,
  remoteBranchExists,
} from '../git/client.js'
import { createPullRequest, requestCompletionLines } from './mr-steps.js'

export async function prepareExistingMrForMerge(
  mrBranch: string,
  targetBranch: string,
  currentBranch: string,
  context: any,
) {
  if (!(await remoteBranchExists(mrBranch, context))) {
    return { exists: false, mergedToTarget: false, done: false }
  }

  const { ui } = context
  ui.step('检查', '发现远程 MR 分支，拉取最新状态。')
  const fetched = await fetchRemoteBranch(mrBranch, context, { allowMissing: true })
  if (!fetched) {
    ui.status('warn', `远程 MR 分支 origin/${mrBranch} 已不存在，将按不存在处理。`)
    return { exists: false, mergedToTarget: false, done: false }
  }

  const mrMergedTarget = await isAncestor(`origin/${mrBranch}`, `origin/${targetBranch}`, context)
  if (mrMergedTarget) {
    ui.step('准备', `使用已有 MR 分支，并合入 ${currentBranch} 与 origin/${targetBranch}。`)
  } else {
    ui.step('准备', `使用已有 MR 分支，合入 ${currentBranch} 并同步 origin/${targetBranch}。`)
  }

  return { exists: true, mergedToTarget: mrMergedTarget, done: false }
}

export async function prepareExistingMrForMergeTarget(
  mrBranch: string,
  targetBranch: string,
  currentBranch: string,
  context: any,
) {
  if (!(await remoteBranchExists(mrBranch, context))) {
    return { done: false }
  }

  const { ui } = context
  ui.step('检查', '发现远程 MR 分支，拉取最新状态。')
  const fetched = await fetchRemoteBranch(mrBranch, context, { allowMissing: true })
  if (!fetched) {
    ui.status('warn', `远程 MR 分支 origin/${mrBranch} 已不存在，将按不存在处理。`)
    return { done: false }
  }

  const mrMergedTarget = await isAncestor(`origin/${mrBranch}`, `origin/${targetBranch}`, context)
  const mrContainsCurrent = await isAncestor(currentBranch, `origin/${mrBranch}`, context)
  const mrContainsTarget = await isAncestor(`origin/${targetBranch}`, `origin/${mrBranch}`, context)

  if (mrContainsCurrent && mrContainsTarget && !mrMergedTarget) {
    ui.step('合并请求', 'MR 分支已包含当前分支和目标分支，只处理远程合并请求。')
    const result = await createPullRequest(mrBranch, targetBranch, context)
    ui.panel('完成', requestCompletionLines(mrBranch, targetBranch, result), { tone: 'success' })
    return { done: true }
  }

  ui.step('刷新', `从 ${currentBranch} 重新生成 ${mrBranch}，再合入 origin/${targetBranch}。`)
  return { done: false }
}

export async function prepareExistingMrForRebase(
  mrBranch: string,
  targetBranch: string,
  currentBranch: string,
  forkPoint: string,
  context: any,
) {
  if (!(await remoteBranchExists(mrBranch, context))) {
    return { done: false }
  }

  const { ui } = context
  ui.step('检查', '发现远程 MR 分支，拉取最新状态。')
  const fetched = await fetchRemoteBranch(mrBranch, context, { allowMissing: true })
  if (!fetched) {
    ui.status('warn', `远程 MR 分支 origin/${mrBranch} 已不存在，将按不存在处理。`)
    return { done: false }
  }

  const mrMergedTarget = await isAncestor(`origin/${mrBranch}`, `origin/${targetBranch}`, context)
  if (mrMergedTarget) {
    ui.step('刷新', `已有 MR 分支已合入目标分支，将从 ${currentBranch} 重新生成。`)
    return { done: false }
  }

  const mrBasedOnTarget = await isAncestor(`origin/${targetBranch}`, `origin/${mrBranch}`, context)
  const mrContainsCurrentBranch = await isAncestor(currentBranch, `origin/${mrBranch}`, context)
  const mrMatchesCurrentChanges =
    (await hasNoNewPatchChanges(`origin/${mrBranch}`, currentBranch, context)) &&
    (await hasNoNewPatchChanges(currentBranch, `origin/${mrBranch}`, context, `origin/${targetBranch}`))
  const mrReplaysCurrentCommits =
    (await hasSameReplayedCommitSeries(
      forkPoint,
      currentBranch,
      `origin/${targetBranch}`,
      `origin/${mrBranch}`,
      context,
    )) &&
    (await hasNoUncontestedTreeChanges(
      forkPoint,
      `origin/${targetBranch}`,
      currentBranch,
      `origin/${mrBranch}`,
      context,
    ))

  if (mrBasedOnTarget && (mrContainsCurrentBranch || mrMatchesCurrentChanges || mrReplaysCurrentCommits)) {
    const reason =
      mrReplaysCurrentCommits && !mrMatchesCurrentChanges && !mrContainsCurrentBranch
        ? 'MR 分支已包含当前分支的 rebase 提交序列，只处理远程合并请求。'
        : 'MR 分支已匹配当前分支的等价改动，只处理远程合并请求。'
    ui.step('合并请求', reason)
    const result = await createPullRequest(mrBranch, targetBranch, context)
    ui.panel('完成', requestCompletionLines(mrBranch, targetBranch, result), { tone: 'success' })
    return { done: true }
  }

  ui.step('刷新', `重新生成 ${mrBranch}，避免产生工具合并提交。`)
  return { done: false }
}
