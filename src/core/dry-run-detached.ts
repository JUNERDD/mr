import type { MrStrategy } from './settings.js'

type DryRunCommand = {
  args: string[]
  command: string
  label: string
}

type DryRunOptions = { deleteMrBranch?: boolean; requestCommand?: string | null }

function remoteHeadRef(branch: string) {
  return `refs/heads/${branch}`
}

function remoteFetchRefspec(branch: string) {
  return `+${remoteHeadRef(branch)}:refs/remotes/origin/${branch}`
}

function deleteMrBranchDryRunCommands(mrBranch: string, options: DryRunOptions): DryRunCommand[] {
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

function requestCommandDryRunCommands(
  sourceBranch: string,
  targetBranch: string,
  options: DryRunOptions,
): DryRunCommand[] {
  return options.requestCommand
    ? [
        {
          label: `运行合并请求命令 ${sourceBranch} -> ${targetBranch}`,
          command: 'sh',
          args: ['-c', options.requestCommand],
        },
      ]
    : []
}

export function buildDetachedPlumbingDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  options: DryRunOptions,
  strategy: 'merge' | 'merge-target',
): DryRunCommand[] {
  const ours = strategy === 'merge-target' ? currentBranch : `origin/${targetBranch}`
  const theirs = strategy === 'merge-target' ? `origin/${targetBranch}` : currentBranch

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
      label: `内存合并 ${theirs} 到 ${ours}`,
      command: 'git',
      args: ['merge-tree', '--write-tree', '--messages', ours, theirs],
    },
    {
      label: `创建合并提交并推送到 ${mrBranch}`,
      command: 'git',
      args: ['commit-tree', 'MERGE_TREE', '-p', ours, '-p', theirs, '-m', `Merge into ${mrBranch}`],
    },
    {
      label: `推送 ${mrBranch}`,
      command: 'git',
      args: [
        'push',
        ...(strategy === 'merge-target' ? ['--force-with-lease'] : []),
        'origin',
        `COMMIT_OID:${remoteHeadRef(mrBranch)}`,
      ],
    },
    ...requestCommandDryRunCommands(mrBranch, targetBranch, options),
  ]
}

export function buildDetachedWorktreeDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  options: DryRunOptions,
  strategy: 'rebase' | 'merge',
): DryRunCommand[] {
  return [
    {
      label: `刷新 origin/${targetBranch}`,
      command: 'git',
      args: ['fetch', 'origin', remoteFetchRefspec(targetBranch)],
    },
    ...deleteMrBranchDryRunCommands(mrBranch, options),
    {
      label: `在临时 worktree 准备 ${mrBranch}（冲突或 ${strategy} 策略）`,
      command: 'git',
      args: [
        'worktree',
        'add',
        '-B',
        mrBranch,
        'WORKTREE_PATH',
        strategy === 'rebase' ? currentBranch : `origin/${targetBranch}`,
      ],
    },
    {
      label: strategy === 'rebase' ? `变基 ${mrBranch} 到 ${targetBranch}` : `在 worktree 内合并并推送 ${mrBranch}`,
      command: 'git',
      args:
        strategy === 'rebase'
          ? ['rebase', '--onto', `origin/${targetBranch}`, 'MERGE_BASE', mrBranch]
          : ['merge', '--no-edit', currentBranch],
    },
    ...requestCommandDryRunCommands(mrBranch, targetBranch, options),
  ]
}

export function buildDetachedDryRunCommands(
  targetBranch: string,
  currentBranch: string,
  mrBranch: string,
  strategy: MrStrategy,
  options: DryRunOptions,
): DryRunCommand[] {
  if (strategy === 'pr') {
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
      ...requestCommandDryRunCommands(currentBranch, targetBranch, options),
    ]
  }

  if (strategy === 'rebase') {
    return buildDetachedWorktreeDryRunCommands(targetBranch, currentBranch, mrBranch, options, 'rebase')
  }

  if (strategy === 'merge-target') {
    return buildDetachedPlumbingDryRunCommands(targetBranch, currentBranch, mrBranch, options, 'merge-target')
  }

  return buildDetachedPlumbingDryRunCommands(targetBranch, currentBranch, mrBranch, options, 'merge')
}
