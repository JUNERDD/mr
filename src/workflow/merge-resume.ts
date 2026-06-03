import { CliError, compactOutput } from '../core/errors.js'
import { getCurrentBranch, git } from '../git/client.js'
import type { PullRequestResult } from './mr-steps.js'

type ActiveMrMerge = {
  currentBranch: string
  mrBranch: string
}

type PushAndEnsureRequest = (
  mrBranch: string,
  targetBranch: string,
  requestCreated: boolean,
  context: any,
) => Promise<PullRequestResult | undefined>

export async function getActiveMrMerge(targetBranch: string, context: any): Promise<ActiveMrMerge | null> {
  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], context, {
    allowFailure: true,
    quiet: true,
  })
  if (mergeHead.exitCode !== 0) {
    return null
  }

  const branch = await getCurrentBranch(context)
  const prefix = `mr/${targetBranch}/`
  if (!branch.startsWith(prefix)) {
    return null
  }

  return { currentBranch: branch.slice(prefix.length), mrBranch: branch }
}

export async function resumeActiveMrMerge(
  activeMerge: ActiveMrMerge,
  targetBranch: string,
  context: any,
  pushAndEnsureRequest: PushAndEnsureRequest,
) {
  const { currentBranch, mrBranch } = activeMerge
  context.ui.panel('mr  合并请求', [`目标分支  ${targetBranch}`, `当前分支  ${currentBranch}`, `MR 分支   ${mrBranch}`])

  const unmergedFiles = await getUnmergedFiles(context)
  if (unmergedFiles.length) {
    throw new CliError(`当前 ${mrBranch} 的合并冲突尚未标记解决。`, {
      details: compactOutput(unmergedFiles.join('\n')),
      next: ['解决冲突后执行: git add <files>', `然后重新运行: mr ${targetBranch}`],
    })
  }

  context.ui.step('继续', `提交 ${mrBranch} 的合并结果。`)
  await git(['commit', '--no-edit'], context, { label: '提交合并结果', mutates: true })
  await pushAndEnsureRequest(mrBranch, targetBranch, false, context)
  await git(['switch', currentBranch], context, { label: `回到 ${currentBranch}`, mutates: true })
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
    next: ['确认当前仓库合并状态正常后重试。'],
  })
}
