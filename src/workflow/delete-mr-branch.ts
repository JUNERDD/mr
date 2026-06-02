import { CliError, compactOutput } from '../core/errors.js'
import { git, remoteBranchExists, remoteHeadRef } from '../git/client.js'

export async function deleteRemoteMrBranchIfRequested(mrBranch: string, context: any) {
  if (!context.deleteMrBranch) {
    return
  }

  const { ui } = context
  ui.step('删除', `先删除远程 MR 分支 origin/${mrBranch}。`)
  if (!(await remoteBranchExists(mrBranch, context))) {
    ui.status('skip', `远程 MR 分支 origin/${mrBranch} 不存在。`)
    return
  }

  const result = await git(['push', 'origin', `:${remoteHeadRef(mrBranch)}`], context, {
    allowFailure: true,
    label: `删除 origin/${mrBranch}`,
    mutates: true,
  })
  if (result.exitCode === 0) {
    return
  }

  if (
    /remote ref does not exist|couldn'?t find remote ref|could not find remote ref/iu.test(String(result.all ?? ''))
  ) {
    ui.status('skip', `远程 MR 分支 origin/${mrBranch} 已不存在。`)
    return
  }

  throw new CliError(`删除远程 MR 分支失败: origin/${mrBranch}`, {
    exitCode: result.exitCode || 1,
    details: compactOutput(result.all),
    next: ['确认网络、仓库权限和远程分支保护规则后重试。'],
  })
}
