import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { createContext } from '../src/core/context.js'
import { createUi } from '../src/ui/terminal.js'
import { createMrFromTargetBranch } from '../src/workflow/create-mr.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd })
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd })
  return result.stdout.trim()
}

test('creates the MR branch by merging current changes by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)

    const context = createContext({
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..origin/mr/test/feature/demo']),
      '1',
    )
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('auto-detected CNB repositories create the request with git cnb by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-cnb-auto-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const requestLog = join(root, 'request.log')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then echo "$*" >> "$MR_CNB_LOG"; exit 0; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', `url.${pathToFileURL(remote).href}.insteadOf`, 'https://cnb.cool/example/repo.git'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', 'https://cnb.cool/example/repo.git'])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      env: { MR_CNB_LOG: requestLog },
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await readFile(requestLog, 'utf8'), 'pull create -H mr/test/feature/demo -B test\n')
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('does not reuse a remote branch that only suffix-matches the MR branch name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-suffix-match-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])
    await git(repo, ['push', 'origin', 'HEAD:foo/mr/test/feature/demo'])

    process.chdir(repo)

    const context = createContext({
      detached: false,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('recreates the MR branch when it disappears before fetching existing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-fetch-race-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH
  const originalRealGit = process.env.REAL_GIT
  const originalDeleteRef = process.env.MR_DELETE_REF_ON_FETCH
  const originalDeleteBranch = process.env.MR_DELETE_BRANCH_ON_FETCH
  const originalRaceDone = process.env.MR_RACE_DONE

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const raceDone = join(root, 'race-done')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'real_git="${REAL_GIT:-git}"',
        'if [ "$1" = "fetch" ] && [ "$2" = "origin" ] && [ "${3:-}" = "${MR_DELETE_REF_ON_FETCH:-}" ] && [ -n "${MR_DELETE_BRANCH_ON_FETCH:-}" ] && [ -n "${MR_RACE_DONE:-}" ] && [ ! -f "$MR_RACE_DONE" ]; then',
        '  : > "$MR_RACE_DONE"',
        '  "$real_git" push origin ":refs/heads/$MR_DELETE_BRANCH_ON_FETCH" >/dev/null 2>&1 || true',
        'fi',
        'exec "$real_git" "$@"',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git'), 0o755)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])
    await git(repo, ['push', 'origin', 'HEAD:mr/test/feature/demo'])

    const realGit = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim()
    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`
    process.env.REAL_GIT = realGit
    process.env.MR_DELETE_REF_ON_FETCH = '+refs/heads/mr/test/feature/demo:refs/remotes/origin/mr/test/feature/demo'
    process.env.MR_DELETE_BRANCH_ON_FETCH = 'mr/test/feature/demo'
    process.env.MR_RACE_DONE = raceDone

    const context = createContext({
      detached: false,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    if (originalRealGit === undefined) {
      delete process.env.REAL_GIT
    } else {
      process.env.REAL_GIT = originalRealGit
    }
    if (originalDeleteRef === undefined) {
      delete process.env.MR_DELETE_REF_ON_FETCH
    } else {
      process.env.MR_DELETE_REF_ON_FETCH = originalDeleteRef
    }
    if (originalDeleteBranch === undefined) {
      delete process.env.MR_DELETE_BRANCH_ON_FETCH
    } else {
      process.env.MR_DELETE_BRANCH_ON_FETCH = originalDeleteBranch
    }
    if (originalRaceDone === undefined) {
      delete process.env.MR_RACE_DONE
    } else {
      process.env.MR_RACE_DONE = originalRaceDone
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('direct PR strategy pushes the current branch and runs the configured request command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-pr-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const requestLog = join(root, 'request.log')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)

    const context = createContext({
      env: {
        MR_REQUEST_COMMAND: 'printf "%s -> %s\\n" "$MR_SOURCE_BRANCH" "$MR_TARGET_BRANCH" >> "$MR_REQUEST_LOG"',
        MR_REQUEST_LOG: requestLog,
      },
      pr: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    assert.equal(
      await gitOutput(repo, ['rev-parse', 'origin/feature/demo']),
      await gitOutput(repo, ['rev-parse', 'feature/demo']),
    )
    assert.equal(await readFile(requestLog, 'utf8'), 'feature/demo -> test\n')
    await assert.rejects(execFileAsync('git', ['rev-parse', 'origin/mr/test/feature/demo'], { cwd: repo }))
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('direct PR mode exits without pushing when current branch is already merged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-pr-merged-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    await git(repo, ['switch', '-c', 'test'])
    await git(repo, ['push', '-u', 'origin', 'test'])
    await git(repo, ['switch', 'feature/demo'])

    process.chdir(repo)

    const context = createContext({
      pr: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await assert.rejects(execFileAsync('git', ['rev-parse', 'origin/feature/demo'], { cwd: repo }))
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('reuses an existing MR branch regardless of the requested MR strategy', async () => {
  const strategies = [
    { name: 'default', options: {} },
    { name: 'merge', options: { merge: true } },
    { name: 'rebase', options: { rebase: true } },
    { name: 'merge-target', options: { mergeTarget: true } },
  ]

  for (const strategy of strategies) {
    const root = await mkdtemp(join(tmpdir(), `mr-existing-${strategy.name}-`))
    const originalCwd = process.cwd()

    try {
      const remote = join(root, 'origin.git')
      const repo = join(root, 'repo')
      await mkdir(repo)

      await git(root, ['init', '--bare', remote])
      await git(repo, ['init'])
      await git(repo, ['config', 'user.name', 'Test User'])
      await git(repo, ['config', 'user.email', 'test@example.com'])
      await writeFile(join(repo, 'README.md'), 'base\n')
      await git(repo, ['add', 'README.md'])
      await git(repo, ['commit', '-m', 'base'])
      await git(repo, ['branch', '-M', 'main'])
      await git(repo, ['remote', 'add', 'origin', remote])
      await git(repo, ['push', '-u', 'origin', 'main'])

      await git(repo, ['switch', '-c', 'test'])
      await writeFile(join(repo, 'target-one.txt'), 'target one\n')
      await git(repo, ['add', 'target-one.txt'])
      await git(repo, ['commit', '-m', 'target one'])
      await git(repo, ['push', '-u', 'origin', 'test'])

      await git(repo, ['switch', 'main'])
      await git(repo, ['switch', '-c', 'feature/demo'])
      await writeFile(join(repo, 'feature-one.txt'), 'feature one\n')
      await git(repo, ['add', 'feature-one.txt'])
      await git(repo, ['commit', '-m', 'feature one'])

      await git(repo, ['switch', '-c', 'mr/test/feature/demo'])
      await writeFile(join(repo, 'mr-only.txt'), 'mr only\n')
      await git(repo, ['add', 'mr-only.txt'])
      await git(repo, ['commit', '-m', 'mr only'])
      await git(repo, ['push', '-u', 'origin', 'HEAD:mr/test/feature/demo'])

      await git(repo, ['switch', 'test'])
      await writeFile(join(repo, 'target-two.txt'), 'target two\n')
      await git(repo, ['add', 'target-two.txt'])
      await git(repo, ['commit', '-m', 'target two'])
      await git(repo, ['push'])

      await git(repo, ['switch', 'feature/demo'])
      await writeFile(join(repo, 'feature-two.txt'), 'feature two\n')
      await git(repo, ['add', 'feature-two.txt'])
      await git(repo, ['commit', '-m', 'feature two'])

      process.chdir(repo)

      const context = createContext({
        ...strategy.options,
        detached: false,
        ui: createUi({
          quiet: true,
          stream: {
            isTTY: false,
            write() {
              return true
            },
          } as any,
        }),
      })

      await createMrFromTargetBranch('test', context)

      assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
      await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
      await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:mr-only.txt']), 'mr only')
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:feature-two.txt']), 'feature two')
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:target-two.txt']), 'target two')
    } finally {
      process.chdir(originalCwd)
      await rm(root, { recursive: true, force: true })
    }
  }
}, 60_000)

test('removes an existing MR branch before recreating it when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-rm-mr-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    await git(repo, ['switch', '-c', 'mr/test/feature/demo'])
    await writeFile(join(repo, 'mr-only.txt'), 'stale\n')
    await git(repo, ['add', 'mr-only.txt'])
    await git(repo, ['commit', '-m', 'stale mr'])
    await git(repo, ['push', '-u', 'origin', 'HEAD:mr/test/feature/demo'])
    await git(repo, ['switch', 'feature/demo'])

    process.chdir(repo)

    const context = createContext({
      detached: false,
      deleteMrBranch: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    await assert.rejects(execFileAsync('git', ['show', 'origin/mr/test/feature/demo:mr-only.txt'], { cwd: repo }))
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('creates the MR branch from current changes before merging the target when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-target-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)

    const context = createContext({
      detached: false,
      mergeTarget: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'feature/demo..origin/mr/test/feature/demo']),
      '1',
    )
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('creates the MR branch by rebasing current changes when configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-rebase-'))
  const originalCwd = process.cwd()

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await mkdir(repo)

    await git(root, ['init', '--bare', remote])
    await git(repo, ['init'])
    await git(repo, ['config', 'user.name', 'Test User'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)

    const context = createContext({
      detached: false,
      rebase: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'mr/test/feature/demo'])
    assert.equal(await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..mr/test/feature/demo']), '0')
    assert.equal(await gitOutput(repo, ['log', '--format=%s', 'origin/test..mr/test/feature/demo']), 'feature')
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})
