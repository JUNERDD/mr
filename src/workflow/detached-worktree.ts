import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../core/errors.js'
import { fetchRemoteBranch, git, gitOutput, remoteBranchExists } from '../git/client.js'
import { addWorktree, getRepositoryTopLevel, listWorktrees, removeWorktree } from '../git/worktree.js'
import { getActiveMrMerge } from './merge-resume.js'
import {
  createPullRequest,
  getForkPoint,
  mergeCurrentBranchIntoMr,
  mergeOriginTargetIntoMr,
  mergeTargetBranchIntoMr,
  pushMrBranch,
  pushMrBranchForceWithLease,
  rebaseMrBranchOntoTarget,
} from './mr-steps.js'
import { resumeDetachedMrMerge, resumeDetachedMrRebase } from './detached-worktree-resume.js'
import { getActiveMrRebase } from './rebase-resume.js'
import type { MrStrategy } from '../core/settings.js'

export async function resumeDetachedConflictIfAny(targetBranch: string, context: any): Promise<boolean> {
  const prefix = `mr/${targetBranch}/`
  const worktrees = await listWorktrees(context)

  for (const entry of worktrees) {
    if (!entry.branch?.startsWith(prefix) || !entry.path) {
      continue
    }

    const wtContext = { ...context, cwd: entry.path }
    const currentBranch = entry.branch.slice(prefix.length)
    const mrBranch = entry.branch

    const activeMerge = await getActiveMrMerge(targetBranch, wtContext)
    if (activeMerge) {
      context.ui.panel('mr  无感合并请求', [
        `目标分支  ${targetBranch}`,
        `当前分支  ${currentBranch}`,
        `MR 分支   ${mrBranch}`,
        `worktree  ${entry.path}`,
      ])
      await resumeDetachedMrMerge(activeMerge, targetBranch, wtContext)
      await removeWorktree(entry.path, context)
      context.ui.panel(
        '完成',
        [
          `合并请求  ${mrBranch} -> ${targetBranch}`,
          `已清理 worktree`,
          `当前仍在  ${await getCurrentBranchSafe(context)}`,
        ],
        { tone: 'success' },
      )
      return true
    }

    const activeRebase = await getActiveMrRebase(targetBranch, wtContext)
    if (activeRebase) {
      context.ui.panel('mr  无感合并请求', [
        `目标分支  ${targetBranch}`,
        `当前分支  ${currentBranch}`,
        `MR 分支   ${mrBranch}`,
        `worktree  ${entry.path}`,
      ])
      await resumeDetachedMrRebase(activeRebase, targetBranch, wtContext)
      await removeWorktree(entry.path, context)
      context.ui.panel(
        '完成',
        [
          `合并请求  ${mrBranch} -> ${targetBranch}`,
          `已清理 worktree`,
          `当前仍在  ${await getCurrentBranchSafe(context)}`,
        ],
        { tone: 'success' },
      )
      return true
    }
  }

  return false
}

export async function runStrategyInWorktree(
  targetBranch: string,
  strategy: MrStrategy,
  context: any,
  { currentBranch, mrBranch }: { currentBranch: string; mrBranch: string },
) {
  const worktreePath = await resolveWorktreePath(mrBranch, context)
  const existing = (await listWorktrees(context)).find((w) => w.path === worktreePath)

  if (!existing) {
    const startPoint = await worktreeStartPoint(strategy, targetBranch, currentBranch, mrBranch, context)
    await mkdir(join(tmpdir(), 'mr-worktrees'), { recursive: true })
    context.ui.step('worktree', `在 ${worktreePath} 准备 ${mrBranch}。`)
    await addWorktree(worktreePath, mrBranch, startPoint, context)
  }

  const wtContext = { ...context, cwd: worktreePath }

  try {
    if (strategy === 'merge') {
      await runMergeInWorktree(targetBranch, currentBranch, mrBranch, wtContext, context)
      return
    }

    if (strategy === 'merge-target') {
      await runMergeTargetInWorktree(targetBranch, currentBranch, mrBranch, wtContext, context)
      return
    }

    if (strategy === 'rebase') {
      await runRebaseInWorktree(targetBranch, currentBranch, mrBranch, wtContext, context)
      return
    }
  } catch (error) {
    if (error instanceof CliError) {
      const next = [
        ...error.next,
        `worktree: ${worktreePath}`,
        '在该目录解决冲突并 git add 后，回到主仓库重跑: mr ' + targetBranch + ' --detached',
      ]
      throw new CliError(error.message, {
        exitCode: error.exitCode,
        details: error.details,
        next,
      })
    }

    throw error
  }
}

async function runMergeInWorktree(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  wtContext: any,
  mainContext: any,
) {
  const mrExists = await remoteBranchExists(mrBranch, mainContext)
  if (mrExists) {
    await fetchRemoteBranch(mrBranch, mainContext)
    await git(['branch', '--set-upstream-to', `origin/${mrBranch}`, mrBranch], wtContext, {
      label: '设置 upstream',
      mutates: true,
    })
  } else {
    await createRemoteMrBranchFromTarget(mrBranch, targetBranch, mainContext)
    await fetchRemoteBranch(mrBranch, mainContext)
  }

  await mergeCurrentBranchIntoMr(mrBranch, currentBranch, targetBranch, wtContext)
  await mergeTargetBranchIntoMr(mrBranch, targetBranch, wtContext)
  await pushMrBranch(mrBranch, wtContext)
  const result = await createPullRequest(mrBranch, targetBranch, wtContext, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    wtContext.ui.status('warn', '合并请求创建未成功，可能已存在；MR 分支已推送。')
  }

  await removeWorktree(wtContext.cwd, mainContext)
}

async function runMergeTargetInWorktree(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  wtContext: any,
  mainContext: any,
) {
  await mergeOriginTargetIntoMr(mrBranch, targetBranch, wtContext)
  await pushMrBranchForceWithLease(mrBranch, wtContext)
  const result = await createPullRequest(mrBranch, targetBranch, wtContext, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    wtContext.ui.status('warn', '合并请求创建未成功，可能已存在；MR 分支已推送。')
  }

  await removeWorktree(wtContext.cwd, mainContext)
}

async function runRebaseInWorktree(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  wtContext: any,
  mainContext: any,
) {
  const forkPoint = await getForkPoint(targetBranch, currentBranch, mainContext)
  await rebaseMrBranchOntoTarget(mrBranch, currentBranch, targetBranch, forkPoint, wtContext)
  await pushMrBranchForceWithLease(mrBranch, wtContext)
  const result = await createPullRequest(mrBranch, targetBranch, wtContext, {
    allowFailure: true,
    labelPrefix: '确认合并请求',
  })
  if (result.exitCode !== 0) {
    wtContext.ui.status('warn', '合并请求创建未成功，可能已存在；MR 分支已推送。')
  }

  await removeWorktree(wtContext.cwd, mainContext)
}

async function worktreeStartPoint(
  strategy: MrStrategy,
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  context: any,
) {
  if (strategy === 'rebase' || strategy === 'merge-target') {
    return currentBranch
  }

  if (await remoteBranchExists(mrBranch, context)) {
    const fetched = await fetchRemoteBranch(mrBranch, context, { allowMissing: true })
    if (fetched) {
      return `origin/${mrBranch}`
    }
  }

  return `origin/${targetBranch}`
}

async function createRemoteMrBranchFromTarget(mrBranch: string, targetBranch: string, context: any) {
  context.ui.step('创建', `远程 MR 分支不存在，从 origin/${targetBranch} 创建 ${mrBranch}。`)
  await git(['push', 'origin', `refs/remotes/origin/${targetBranch}:refs/heads/${mrBranch}`], context, {
    label: `推送 ${mrBranch}`,
    mutates: true,
  })
}

async function resolveWorktreePath(mrBranch: string, context: any) {
  const top = await getRepositoryTopLevel(context)
  const hash = createHash('sha256').update(top).digest('hex').slice(0, 8)
  const safe = mrBranch.replace(/[^a-zA-Z0-9._-]+/gu, '_')
  return join(tmpdir(), 'mr-worktrees', `${hash}-${safe}`)
}

async function getCurrentBranchSafe(context: any) {
  return (await gitOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], context)) ?? '(detached)'
}
