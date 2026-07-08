import { printDryRun } from '../core/dry-run.js'
import { CliError, compactOutput } from '../core/errors.js'
import {
  ensureCleanWorkingTree,
  getCurrentBranch,
  getTrackedWorkingTreeStatus,
  git,
  isAncestor,
  remoteFetchRefspec,
  remoteBranchExists,
} from '../git/client.js'
import { createPullRequest, requestCompletionLines } from './mr-steps.js'

export async function createPrFromCurrentBranch(targetBranch: string, context: any) {
  const { ui } = context
  const currentBranch = await getCurrentBranch(context)

  if (context.dryRun) {
    await printDryRun(targetBranch, currentBranch, context, 'pr')
    const status = await getTrackedWorkingTreeStatus(context)
    if (status) {
      ui.status('warn', '工作区存在 tracked 改动；真实执行会先停止。')
    }

    return
  }

  await ensureCleanWorkingTree(context)

  ui.panel('mr  直接合并请求', [
    `目标分支  ${targetBranch}`,
    `当前分支  ${currentBranch}`,
    `请求源分支 ${currentBranch}`,
  ])

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

  ui.step('推送', `推送当前分支 ${currentBranch}。`)
  await git(['push', '--set-upstream', 'origin', `HEAD:${currentBranch}`], context, {
    label: `推送 ${currentBranch}`,
    mutates: true,
  })

  ui.step('合并请求', `确认合并请求: ${currentBranch} -> ${targetBranch}。`)
  const result = await createPullRequest(currentBranch, targetBranch, context)
  if (result.exitCode !== 0) {
    ui.status('warn', '合并请求命令未成功；当前分支已推送。')
  }

  ui.panel('完成', requestCompletionLines(currentBranch, targetBranch, result), { tone: 'success' })
}

async function refreshTargetBranch(targetBranch: string, context: any) {
  context.ui.step('检查', `刷新目标分支 origin/${targetBranch}。`)
  const result = await git(['fetch', 'origin', remoteFetchRefspec(targetBranch)], context, {
    allowFailure: true,
    label: `刷新 origin/${targetBranch}`,
    mutates: true,
  })

  if (result.exitCode !== 0) {
    throw new CliError(`刷新 origin/${targetBranch} 失败。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['确认网络、仓库权限和 origin 远程配置。'],
    })
  }
}
