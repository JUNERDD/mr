import type { MrStrategy } from './settings.js'

type DryRunOptions = { deleteMrBranch?: boolean }

export function mrBranchName(targetBranch: string, currentBranch: string) {
  return `mr/${targetBranch}/${currentBranch}`
}

function remoteHeadRef(branch: string) {
  return `refs/heads/${branch}`
}

function remoteFetchRefspec(branch: string) {
  return `+${remoteHeadRef(branch)}:refs/remotes/origin/${branch}`
}

export function buildDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  strategy: MrStrategy = 'merge',
  options: DryRunOptions = {},
) {
  const mrBranch = mrBranchName(targetBranch, currentBranch)

  if (strategy === 'rebase') {
    return buildRebaseDryRunCommands(targetBranch, currentBranch, mrBranch, options)
  }

  if (strategy === 'pr') {
    return buildPrDryRunCommands(targetBranch, currentBranch)
  }

  if (strategy === 'merge-target') {
    return buildMergeTargetDryRunCommands(targetBranch, currentBranch, mrBranch, options)
  }

  return buildMergeDryRunCommands(targetBranch, currentBranch, mrBranch, options)
}

function deleteMrBranchDryRunCommands(mrBranch: string, options: DryRunOptions) {
  return options.deleteMrBranch
    ? [
        {
          label: `删除远程 MR 分支 origin/${mrBranch}`,
          command: 'git',
          args: ['push', 'origin', `:${remoteHeadRef(mrBranch)}`],
        },
      ]
    : []
}

function buildMergeDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  options: DryRunOptions,
) {
  return [
    {
      label: `刷新 origin/${targetBranch}`,
      command: 'git',
      args: ['fetch', 'origin', remoteFetchRefspec(targetBranch)],
    },
    {
      label: `检查远程 MR 分支 origin/${mrBranch}`,
      command: 'git',
      args: ['ls-remote', '--exit-code', '--heads', 'origin', remoteHeadRef(mrBranch)],
    },
    ...deleteMrBranchDryRunCommands(mrBranch, options),
    {
      label: `必要时从目标分支创建远程 MR 分支 ${mrBranch}`,
      command: 'git',
      args: ['push', 'origin', `refs/remotes/origin/${targetBranch}:refs/heads/${mrBranch}`],
    },
    {
      label: `准备本地冲突处理分支 ${mrBranch}`,
      command: 'git',
      args: ['switch', '-C', mrBranch, `origin/${targetBranch}`],
    },
    {
      label: `设置 ${mrBranch} 的 upstream`,
      command: 'git',
      args: ['branch', '--set-upstream-to', `origin/${mrBranch}`, mrBranch],
    },
    {
      label: `合入当前分支 ${currentBranch}`,
      command: 'git',
      args: ['merge', '--no-edit', currentBranch],
    },
    {
      label: `推送更新后的 ${mrBranch}`,
      command: 'git',
      args: ['push', 'origin', `HEAD:${mrBranch}`],
    },
    {
      label: `创建合并请求 ${mrBranch} -> ${targetBranch}`,
      command: 'git',
      args: ['cnb', 'pull', 'create', '-H', mrBranch, '-B', targetBranch],
    },
    {
      label: `回到当前分支 ${currentBranch}`,
      command: 'git',
      args: ['switch', currentBranch],
    },
  ]
}

function buildPrDryRunCommands(targetBranch: string, currentBranch: string) {
  return [
    {
      label: `刷新 origin/${targetBranch}`,
      command: 'git',
      args: ['fetch', 'origin', remoteFetchRefspec(targetBranch)],
    },
    {
      label: `推送当前分支 ${currentBranch}`,
      command: 'git',
      args: ['push', '--set-upstream', 'origin', `HEAD:${currentBranch}`],
    },
    {
      label: `创建合并请求 ${currentBranch} -> ${targetBranch}`,
      command: 'git',
      args: ['cnb', 'pull', 'create', '-H', currentBranch, '-B', targetBranch],
    },
  ]
}

function buildRebaseDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  options: DryRunOptions,
) {
  return [
    {
      label: `刷新 origin/${targetBranch}`,
      command: 'git',
      args: ['fetch', 'origin', remoteFetchRefspec(targetBranch)],
    },
    {
      label: `检查远程 MR 分支 origin/${mrBranch}`,
      command: 'git',
      args: ['ls-remote', '--exit-code', '--heads', 'origin', remoteHeadRef(mrBranch)],
    },
    ...deleteMrBranchDryRunCommands(mrBranch, options),
    {
      label: `从当前分支重建本地 MR 分支 ${mrBranch}`,
      command: 'git',
      args: ['switch', '-C', mrBranch, currentBranch],
    },
    {
      label: `计算 ${targetBranch} 和 ${currentBranch} 的共同祖先`,
      command: 'git',
      args: ['merge-base', `origin/${targetBranch}`, currentBranch],
    },
    {
      label: `把 ${mrBranch} 变基到 ${targetBranch}`,
      command: 'git',
      args: ['rebase', '--onto', `origin/${targetBranch}`, 'MERGE_BASE', mrBranch],
    },
    {
      label: `推送更新后的 ${mrBranch}`,
      command: 'git',
      args: ['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:${mrBranch}`],
    },
    {
      label: `创建合并请求 ${mrBranch} -> ${targetBranch}`,
      command: 'git',
      args: ['cnb', 'pull', 'create', '-H', mrBranch, '-B', targetBranch],
    },
    {
      label: `回到当前分支 ${currentBranch}`,
      command: 'git',
      args: ['switch', currentBranch],
    },
  ]
}

function buildMergeTargetDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  options: DryRunOptions,
) {
  return [
    {
      label: `刷新 origin/${targetBranch}`,
      command: 'git',
      args: ['fetch', 'origin', remoteFetchRefspec(targetBranch)],
    },
    {
      label: `检查远程 MR 分支 origin/${mrBranch}`,
      command: 'git',
      args: ['ls-remote', '--exit-code', '--heads', 'origin', remoteHeadRef(mrBranch)],
    },
    ...deleteMrBranchDryRunCommands(mrBranch, options),
    {
      label: `从当前分支准备本地 MR 分支 ${mrBranch}`,
      command: 'git',
      args: ['switch', '-C', mrBranch, currentBranch],
    },
    {
      label: `合入目标分支 ${targetBranch}`,
      command: 'git',
      args: ['merge', '--no-edit', `origin/${targetBranch}`],
    },
    {
      label: `推送更新后的 ${mrBranch}`,
      command: 'git',
      args: ['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:${mrBranch}`],
    },
    {
      label: `创建合并请求 ${mrBranch} -> ${targetBranch}`,
      command: 'git',
      args: ['cnb', 'pull', 'create', '-H', mrBranch, '-B', targetBranch],
    },
    {
      label: `回到当前分支 ${currentBranch}`,
      command: 'git',
      args: ['switch', currentBranch],
    },
  ]
}

export function printDryRun(targetBranch: string, currentBranch: string, context: any, strategy: MrStrategy = 'merge') {
  const { ui } = context
  const mrBranch = mrBranchName(targetBranch, currentBranch)

  // dry-run 与正式执行用同样的品牌面板节奏:标题 + 三字段 + 一空行 + dim 免责声明,
  // 然后逐条列出计划命令(? 符号),提示语用 . 标记结束。
  ui.panel('mr  预览', [
    `目标分支  ${targetBranch}`,
    `当前分支  ${currentBranch}`,
    `MR 分支   ${mrBranch}`,
    '',
    ui.colors.dim('不会修改本地分支、远程分支或创建合并请求。'),
  ])

  ui.status('info', `整合策略: ${strategy}`)
  for (const command of buildDryRunCommands(targetBranch, currentBranch, strategy, {
    deleteMrBranch: context.deleteMrBranch && strategy !== 'pr',
  })) {
    ui.status('plan', command.label)
    ui.command(command.command, command.args)
  }

  ui.status('info', '真实执行时会根据远程分支状态跳过不需要的步骤。')
}
