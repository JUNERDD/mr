import { mrBranchName, printDryRun } from '../core/dry-run.js'
import { CliError, compactOutput } from '../core/errors.js'
import {
  ensureCleanWorkingTree,
  getCurrentBranch,
  getTrackedWorkingTreeStatus,
  git,
  isAncestor,
  remoteBranchExists,
} from '../git/client.js'
import { run } from '../runtime/runner.js'
import { getActiveMrMerge, resumeActiveMrMerge } from './merge-resume.js'
import { restoreInitialBranch, withRecoveryDetails } from './recovery.js'

class MergeConflictError extends CliError {}

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

export async function createMrByMerge(targetBranch: string, context: any) {
  const { ui } = context
  const activeMerge = await getActiveMrMerge(targetBranch, context)
  if (activeMerge) {
    await resumeActiveMrMerge(activeMerge, targetBranch, context, pushAndEnsureRequest)
    return
  }

  const currentBranch = await getCurrentBranch(context)

  if (context.dryRun) {
    printDryRun(targetBranch, currentBranch, context, 'merge')
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
    const existingMr = await prepareExistingMrBranch(
      mrBranch,
      targetBranch,
      currentBranch,
      currentMergedTarget,
      context,
    )
    if (existingMr.done) {
      return
    }

    if (!existingMr.exists) {
      if (currentMergedTarget) {
        ui.panel('无需操作', [`${currentBranch} 已经合入 ${targetBranch}。`], { tone: 'success' })
        return
      }

      await createRemoteMrBranch(mrBranch, context)
    }

    const requestCreated = await createInitialRequestIfNeeded(
      mrBranch,
      targetBranch,
      existingMr.mergedToTarget,
      context,
    )
    await prepareLocalMrBranch(mrBranch, targetBranch, existingMr.exists, context)
    await mergeCurrentBranch(mrBranch, currentBranch, targetBranch, requestCreated, context)
    await mergeTargetBranch(mrBranch, targetBranch, context)
    await pushAndEnsureRequest(mrBranch, targetBranch, requestCreated, context)
    await git(['switch', currentBranch], context, { label: `回到 ${currentBranch}`, mutates: true })
  } catch (error) {
    if (error instanceof MergeConflictError) {
      throw error
    }

    const recovery = await restoreInitialBranch(currentBranch, context)
    throw withRecoveryDetails(error, recovery)
  }

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
  currentMergedTarget: boolean,
  context: any,
) {
  if (!(await remoteBranchExists(mrBranch, context))) {
    return { exists: false, mergedToTarget: false, done: false }
  }

  const { ui } = context
  ui.step('检查', '发现远程 MR 分支，拉取最新状态。')
  await git(['fetch', 'origin', `+${mrBranch}:refs/remotes/origin/${mrBranch}`], context, {
    label: `刷新 origin/${mrBranch}`,
    mutates: true,
  })

  const mrMergedTarget = await isAncestor(`origin/${mrBranch}`, `origin/${targetBranch}`, context)

  if (currentMergedTarget) {
    ui.panel('无需操作', [`${currentBranch} 已经合入 ${targetBranch}。`], { tone: 'success' })
    return { exists: true, mergedToTarget: mrMergedTarget, done: true }
  }

  if (mrMergedTarget) {
    ui.step('准备', `使用已有 MR 分支，并合入 ${currentBranch} 与 origin/${targetBranch}。`)
  } else {
    ui.step('准备', `使用已有 MR 分支，合入 ${currentBranch} 并同步 origin/${targetBranch}。`)
  }

  return { exists: true, mergedToTarget: mrMergedTarget, done: false }
}

async function createRemoteMrBranch(mrBranch: string, context: any) {
  context.ui.step('创建', '远程 MR 分支不存在，先推送当前分支作为合并请求入口。')
  await git(['push', 'origin', `HEAD:${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })
  await git(['fetch', 'origin', `+${mrBranch}:refs/remotes/origin/${mrBranch}`], context, {
    label: `刷新 origin/${mrBranch}`,
    mutates: true,
  })
}

async function createInitialRequestIfNeeded(
  mrBranch: string,
  targetBranch: string,
  mrMergedTarget: boolean,
  context: any,
) {
  if (mrMergedTarget) {
    return false
  }

  context.ui.step('合并请求', `创建合并请求: ${mrBranch} -> ${targetBranch}。`)
  const result = await createPullRequest(mrBranch, targetBranch, context, { allowFailure: true })
  if (result.exitCode === 0) {
    return true
  }

  context.ui.status('warn', '合并请求创建未成功，可能已存在或当前无差异；推送后会重试。')
  return false
}

async function prepareLocalMrBranch(mrBranch: string, targetBranch: string, mrBranchExists: boolean, context: any) {
  const source = mrBranchExists ? `origin/${mrBranch}` : `origin/${targetBranch}`
  context.ui.step('切换', `从 ${source} 准备本地 ${mrBranch}。`)
  await git(['switch', '-C', mrBranch, source], context, {
    label: `切换到 ${mrBranch}`,
    mutates: true,
  })
  await git(['branch', '--set-upstream-to', `origin/${mrBranch}`, mrBranch], context, {
    label: '设置 upstream',
    mutates: true,
  })
}

async function mergeCurrentBranch(
  mrBranch: string,
  currentBranch: string,
  targetBranch: string,
  requestCreated: boolean,
  context: any,
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
    next.push(`或手动创建合并请求: git cnb pull create -H ${mrBranch} -B ${targetBranch}`)
  }

  throw new MergeConflictError(`合并 ${currentBranch} 到 ${mrBranch} 时发生冲突。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next,
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

async function pushAndEnsureRequest(mrBranch: string, targetBranch: string, requestCreated: boolean, context: any) {
  context.ui.step('推送', `推送 ${mrBranch}，更新远程 MR 分支。`)
  await git(['push', 'origin', `HEAD:${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })

  if (!requestCreated) {
    context.ui.step('合并请求', `推送后确认合并请求: ${mrBranch} -> ${targetBranch}。`)
    const result = await createPullRequest(mrBranch, targetBranch, context, {
      allowFailure: true,
      labelPrefix: '确认合并请求',
    })
    if (result.exitCode !== 0) {
      context.ui.status('warn', '合并请求创建未成功，可能已存在；MR 分支已推送。')
    }
  }
}
