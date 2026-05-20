import { mrBranchName, printDryRun } from '../core/dry-run.js'
import { CliError, compactOutput } from '../core/errors.js'
import {
  ensureCleanWorkingTree,
  ensureGitContext,
  getCurrentBranch,
  getMergeBase,
  getTrackedWorkingTreeStatus,
  git,
  hasNoNewPatchChanges,
  hasNoUncontestedTreeChanges,
  hasSameReplayedCommitSeries,
  isAncestor,
  remoteBranchExists,
} from '../git/client.js'
import { rewriteRebaseConflictMarkers } from '../git/conflicts.js'
import { run } from '../runtime/runner.js'
import { createMrByMerge } from './merge-mr.js'
import { getActiveMrMerge } from './merge-resume.js'
import { createMrByMergeTarget } from './merge-target-mr.js'
import { createPrFromCurrentBranch } from './pr-mr.js'
import { getActiveMrRebase, resumeActiveMrRebase } from './rebase-resume.js'
import { restoreInitialBranch, withRecoveryDetails } from './recovery.js'
import { resolveMrStrategy } from './strategy.js'

class RebaseConflictError extends CliError {}

async function createPullRequest(
  mrBranch: string,
  targetBranch: string,
  context: any,
  { allowFailure = false, labelPrefix = '创建合并请求' } = {},
) {
  return run('git', ['cnb', 'pull', 'create', '-H', mrBranch, '-B', targetBranch], {
    label: `${labelPrefix} ${mrBranch} -> ${targetBranch}`,
    allowFailure,
    showOutput: true,
    mutates: true,
    context,
  })
}

export async function createMrFromTargetBranch(targetBranch: string, context: any) {
  await ensureGitContext(context)
  const activeRebase = await getActiveMrRebase(targetBranch, context)
  if (activeRebase && !context.dryRun) {
    await resumeActiveMrRebase(activeRebase, targetBranch, context, pushAndEnsureRequest)
    return
  }

  const strategy = await resolveMrStrategy(context)
  if (strategy === 'pr') {
    await createPrFromCurrentBranch(targetBranch, context)
    return
  }

  const activeMerge = await getActiveMrMerge(targetBranch, context)
  if (activeMerge && !context.dryRun) {
    await createMrByMerge(targetBranch, context)
    return
  }

  const currentBranch = await getCurrentBranch(context)
  const mrBranch = mrBranchName(targetBranch, currentBranch)
  if (!context.dryRun && (await remoteBranchExists(mrBranch, context))) {
    await createMrByMerge(targetBranch, context)
    return
  }

  if (strategy === 'merge') {
    await createMrByMerge(targetBranch, context)
    return
  }

  if (strategy === 'merge-target') {
    await createMrByMergeTarget(targetBranch, context)
    return
  }

  await createMrByRebase(targetBranch, context)
}

async function createMrByRebase(targetBranch: string, context: any) {
  const { ui } = context

  const currentBranch = await getCurrentBranch(context)

  if (context.dryRun) {
    // 编辑性排版:品牌面板永远是输出的第一眼,工作区脏不脏的提醒留到末尾做收尾脚注,
    // 不去抢 "mr 预览" 这个标题的注意力。
    printDryRun(targetBranch, currentBranch, context, 'rebase')
    const status = await getTrackedWorkingTreeStatus(context)
    if (status) {
      ui.status('warn', '工作区存在 tracked 改动；真实执行会先停止。')
    }

    return
  }

  await ensureCleanWorkingTree(context)

  const mrBranch = mrBranchName(targetBranch, currentBranch)
  // 品牌面板:整次执行里唯一一处 bold cyan "mr",副标题给出本次任务定语,
  // 正文用对齐到 col 11 的 key/value 列表(中文 4 字 = 8 visual col + 2 空格),
  // 让目标 / 当前 / MR 三个字段在视觉上形成一根隐形垂直线。
  ui.panel('mr  合并请求', [`目标分支  ${targetBranch}`, `当前分支  ${currentBranch}`, `MR 分支   ${mrBranch}`])

  try {
    ui.step('检查', `确认远程目标分支 origin/${targetBranch}。`)
    const targetExists = await remoteBranchExists(targetBranch, context)
    if (!targetExists) {
      throw new CliError(`远程目标分支不存在: origin/${targetBranch}`, {
        next: ['检查目标分支名称，或改用 mr <target> 指定正确分支。'],
      })
    }

    await refreshTargetBranch(targetBranch, context)
    const currentMergedTarget = await isAncestor(currentBranch, `origin/${targetBranch}`, context)
    if (currentMergedTarget) {
      ui.panel('无需操作', [`${currentBranch} 已经合入 ${targetBranch}。`], { tone: 'success' })
      return
    }

    const forkPoint = await getMergeBase(`origin/${targetBranch}`, currentBranch, context)
    const existingMr = await prepareExistingMrBranch(mrBranch, targetBranch, currentBranch, forkPoint, context)

    if (existingMr.done) {
      return
    }

    await prepareLocalMrBranch(mrBranch, currentBranch, context)
    await rebaseMrBranch(mrBranch, currentBranch, targetBranch, forkPoint, context)
    await pushAndEnsureRequest(mrBranch, targetBranch, context)
    await git(['switch', currentBranch], context, { label: `回到 ${currentBranch}`, mutates: true })
  } catch (error) {
    if (error instanceof RebaseConflictError) {
      throw error
    }

    const recovery = await restoreInitialBranch(currentBranch, context)
    throw withRecoveryDetails(error, recovery)
  }

  // 完成面板:与品牌面板同样的对齐方式,但只剩两行,刻意短小,
  // 形成"开 — 步骤 — 收"的三段结构,最后一行是当前分支,告诉用户你在哪。
  ui.panel('完成', [`合并请求  ${mrBranch} -> ${targetBranch}`, `已回到    ${currentBranch}`], { tone: 'success' })
}

async function refreshTargetBranch(targetBranch: string, context: any) {
  context.ui.step('检查', `刷新目标分支 origin/${targetBranch}。`)
  await git(['fetch', 'origin', `+${targetBranch}:refs/remotes/origin/${targetBranch}`], context, {
    label: `刷新 origin/${targetBranch}`,
    mutates: true,
  })
}

async function prepareExistingMrBranch(
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
  await git(['fetch', 'origin', `+${mrBranch}:refs/remotes/origin/${mrBranch}`], context, {
    label: `刷新 origin/${mrBranch}`,
    mutates: true,
  })

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
        ? 'MR 分支已包含当前分支的 rebase 提交序列，只创建远程合并请求。'
        : 'MR 分支已匹配当前分支的等价改动，只创建远程合并请求。'
    ui.step('合并请求', reason)
    await createPullRequest(mrBranch, targetBranch, context)
    ui.panel('完成', [`合并请求: ${mrBranch} -> ${targetBranch}`], { tone: 'success' })
    return { done: true }
  }

  ui.step('刷新', `重新生成 ${mrBranch}，避免产生工具合并提交。`)
  return { done: false }
}

async function prepareLocalMrBranch(mrBranch: string, currentBranch: string, context: any) {
  context.ui.step('切换', `从 ${currentBranch} 重建本地 ${mrBranch}。`)
  await git(['switch', '-C', mrBranch, currentBranch], context, {
    label: `切换到 ${mrBranch}`,
    mutates: true,
  })
}

async function rebaseMrBranch(
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

  const next = [
    `当前处于 ${mrBranch} 的 rebase 冲突状态，请直接解决冲突。`,
    '解决冲突后执行: git add <files>',
    `然后重新运行: mr ${targetBranch}`,
  ]

  throw new RebaseConflictError(`变基 ${mrBranch} 到 ${targetBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next,
  })
}

async function pushAndEnsureRequest(mrBranch: string, targetBranch: string, context: any) {
  context.ui.step('推送', `使用 force-with-lease 更新 ${mrBranch}。`)
  await git(['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })

  context.ui.step('合并请求', `创建合并请求: ${mrBranch} -> ${targetBranch}。`)
  const result = await createPullRequest(mrBranch, targetBranch, context, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    context.ui.status('warn', '合并请求创建未成功，可能已存在；MR 分支已推送。')
  }
}
