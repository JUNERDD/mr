import { mrBranchName, printDryRun } from '../core/dry-run.js'
import { CliError, compactOutput } from '../core/errors.js'
import {
  ensureCleanWorkingTree,
  fetchRemoteBranch,
  getCurrentBranch,
  getTrackedWorkingTreeStatus,
  git,
  isAncestor,
  remoteBranchExists,
} from '../git/client.js'
import { run } from '../runtime/runner.js'
import { getActiveMrMerge, resumeActiveMrMerge } from './merge-resume.js'
import { restoreInitialBranch, withRecoveryDetails } from './recovery.js'

class MergeTargetConflictError extends CliError {}

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

export async function createMrByMergeTarget(targetBranch: string, context: any) {
  const { ui } = context
  const activeMerge = await getActiveMrMerge(targetBranch, context)
  if (activeMerge) {
    await resumeActiveMrMerge(activeMerge, targetBranch, context, pushAndEnsureRequest)
    return
  }

  const currentBranch = await getCurrentBranch(context)
  if (context.dryRun) {
    printDryRun(targetBranch, currentBranch, context, 'merge-target')
    const status = await getTrackedWorkingTreeStatus(context)
    if (status) {
      ui.status('warn', '工作区存在 tracked 改动；真实执行会先停止。')
    }

    return
  }

  await ensureCleanWorkingTree(context)
  const mrBranch = mrBranchName(targetBranch, currentBranch)

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

    const existingMr = await prepareExistingMrBranch(mrBranch, targetBranch, currentBranch, context)
    if (existingMr.done) {
      return
    }

    await prepareLocalMrBranch(mrBranch, currentBranch, context)
    await mergeTargetBranch(mrBranch, targetBranch, context)
    await pushAndEnsureRequest(mrBranch, targetBranch, false, context)
    await git(['switch', currentBranch], context, { label: `回到 ${currentBranch}`, mutates: true })
  } catch (error) {
    if (error instanceof MergeTargetConflictError) {
      throw error
    }

    const recovery = await restoreInitialBranch(currentBranch, context)
    throw withRecoveryDetails(error, recovery)
  }

  ui.panel('完成', [`合并请求  ${mrBranch} -> ${targetBranch}`, `已回到    ${currentBranch}`], { tone: 'success' })
}

async function refreshTargetBranch(targetBranch: string, context: any) {
  context.ui.step('检查', `刷新目标分支 origin/${targetBranch}。`)
  await fetchRemoteBranch(targetBranch, context)
}

async function prepareExistingMrBranch(mrBranch: string, targetBranch: string, currentBranch: string, context: any) {
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
    ui.step('合并请求', 'MR 分支已包含当前分支和目标分支，只创建远程合并请求。')
    await createPullRequest(mrBranch, targetBranch, context)
    ui.panel('完成', [`合并请求: ${mrBranch} -> ${targetBranch}`], { tone: 'success' })
    return { done: true }
  }

  ui.step('刷新', `从 ${currentBranch} 重新生成 ${mrBranch}，再合入 origin/${targetBranch}。`)
  return { done: false }
}

async function prepareLocalMrBranch(mrBranch: string, currentBranch: string, context: any) {
  context.ui.step('切换', `从 ${currentBranch} 准备本地 ${mrBranch}。`)
  await git(['switch', '-C', mrBranch, currentBranch], context, {
    label: `切换到 ${mrBranch}`,
    mutates: true,
  })
}

async function mergeTargetBranch(mrBranch: string, targetBranch: string, context: any) {
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

async function pushAndEnsureRequest(mrBranch: string, targetBranch: string, _requestCreated: boolean, context: any) {
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
