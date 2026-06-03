import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError, compactOutput } from '../core/errors.js'
import { git, gitOutput } from '../git/client.js'
import { rewriteRebaseConflictMarkers } from '../git/conflicts.js'
import { type PullRequestResult, requestCompletionLines } from './mr-steps.js'

export type ActiveMrRebase = {
  currentBranch: string
  mrBranch: string
}

type PushAndEnsureRequest = (mrBranch: string, targetBranch: string, context: any) => Promise<PullRequestResult>

export async function getActiveMrRebase(targetBranch: string, context: any): Promise<ActiveMrRebase | null> {
  for (const stateDirName of ['rebase-merge', 'rebase-apply']) {
    const stateDir = await gitOutput(['rev-parse', '--git-path', stateDirName], context)
    if (!stateDir) {
      continue
    }

    const headName = await readStateFile(stateDir, 'head-name')
    if (!headName) {
      continue
    }

    const mrBranch = headName.replace(/^refs\/heads\//u, '')
    const prefix = `mr/${targetBranch}/`
    if (!mrBranch.startsWith(prefix)) {
      continue
    }

    const currentBranch = mrBranch.slice(prefix.length)
    if (!currentBranch) {
      continue
    }

    return { currentBranch, mrBranch }
  }

  return null
}

export async function resumeActiveMrRebase(
  activeRebase: ActiveMrRebase,
  targetBranch: string,
  context: any,
  pushAndEnsureRequest: PushAndEnsureRequest,
) {
  const { currentBranch, mrBranch } = activeRebase
  context.ui.panel('mr  合并请求', [`目标分支  ${targetBranch}`, `当前分支  ${currentBranch}`, `MR 分支   ${mrBranch}`])

  const unmergedFiles = await getUnmergedFiles(context)
  if (unmergedFiles.length) {
    throw new CliError(`当前 ${mrBranch} 的 rebase 冲突尚未标记解决。`, {
      details: compactOutput(unmergedFiles.join('\n')),
      next: ['解决冲突后执行: git add <files>', `然后重新运行: mr ${targetBranch}`],
    })
  }

  context.ui.step('继续', `继续 ${mrBranch} 的 rebase。`)
  const result = await git(['-c', 'core.editor=true', 'rebase', '--continue'], context, {
    label: `继续变基 ${currentBranch}`,
    allowFailure: true,
    mutates: true,
  })

  if (result.exitCode !== 0) {
    await handleContinueFailure(result, currentBranch, targetBranch, mrBranch, context)
  }

  const requestResult = await pushAndEnsureRequest(mrBranch, targetBranch, context)
  await git(['switch', currentBranch], context, { label: `回到 ${currentBranch}`, mutates: true })
  context.ui.panel(
    '完成',
    [...requestCompletionLines(mrBranch, targetBranch, requestResult), `已回到    ${currentBranch}`],
    {
      tone: 'success',
    },
  )
}

async function handleContinueFailure(
  result: any,
  currentBranch: string,
  targetBranch: string,
  mrBranch: string,
  context: any,
) {
  const unmergedAfterContinue = await getUnmergedFiles(context)
  if (unmergedAfterContinue.length) {
    await rewriteRebaseConflictMarkers(currentBranch, targetBranch, context)
    throw new CliError(`继续变基 ${mrBranch} 到 ${targetBranch} 时发生冲突。`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: [
        `当前处于 ${mrBranch} 的 rebase 冲突状态，请直接解决冲突。`,
        '解决冲突后执行: git add <files>',
        `然后重新运行: mr ${targetBranch}`,
      ],
    })
  }

  throw new CliError(`继续变基 ${mrBranch} 到 ${targetBranch} 失败。`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: ['根据 git 输出处理后重试。'],
  })
}

async function readStateFile(stateDir: string, fileName: string) {
  try {
    return (await readFile(join(stateDir, fileName), 'utf8')).trim()
  } catch {
    return null
  }
}

async function getUnmergedFiles(context: any) {
  const result = await git(['diff', '--name-only', '--diff-filter=U'], context, {
    quiet: true,
    allowFailure: true,
  })

  if (result.exitCode === 0) {
    return result.stdout.split('\n').filter(Boolean)
  }

  throw new CliError('无法读取未解决冲突文件。', {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: ['确认当前仓库 rebase 状态正常后重试。'],
  })
}
