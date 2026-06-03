import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { buildDryRunCommands } from '../src/core/dry-run.js'
import { CliError } from '../src/core/errors.js'
import { formatCommand } from '../src/core/format.js'
import { resolveMaintenanceOptions } from '../src/commands/maintenance-options.js'
import { isInteractiveInvocation, normalizeHelpArgv, resolveTargetFromInvocation } from '../src/core/targets.js'
import {
  readDetachedSettings,
  readMrSettings,
  unsetDetachedConfig,
  unsetStrategyConfig,
  writeDetachedConfig,
  writeStrategyConfig,
} from '../src/core/settings.js'
import { assertConfigInteractiveTerminal, createConfigScopeChoices, createStrategyChoices } from '../src/ui/config.js'
import { createSelectConfig, selectTarget } from '../src/ui/select-target.js'
import { createUi, resolveColorEnabled } from '../src/ui/terminal.js'
import { withRecoveryDetails } from '../src/workflow/recovery.js'
import { resolveDetached, resolveMrStrategy } from '../src/workflow/strategy.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const execFileAsync = promisify(execFile)

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return listSourceFiles(path)
      }

      return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
    }),
  )

  return files.flat()
}

test('resolveTargetFromInvocation maps short binaries to target branches', () => {
  assert.equal(resolveTargetFromInvocation('mrm'), 'master')
  assert.equal(resolveTargetFromInvocation('mrt'), 'test')
  assert.equal(resolveTargetFromInvocation('mrp'), 'prerelease')
})

test('resolveTargetFromInvocation maps short target aliases', () => {
  assert.equal(resolveTargetFromInvocation('mr', 'mrm'), 'master')
  assert.equal(resolveTargetFromInvocation('mr', 'release/2026-05'), 'release/2026-05')
})

test('mr without a target is interactive, explicit targets are not', () => {
  assert.equal(isInteractiveInvocation('mr'), true)
  assert.equal(isInteractiveInvocation('mr', 'test'), false)
  assert.equal(isInteractiveInvocation('mrm'), false)
})

test('maintenance names remain valid target branches', () => {
  assert.equal(resolveTargetFromInvocation('mr', 'config'), 'config')
  assert.equal(resolveTargetFromInvocation('mr', 'update'), 'update')
  assert.equal(resolveTargetFromInvocation('mr', 'uninstall'), 'uninstall')
})

test('normalizeHelpArgv maps mr -help to --help', () => {
  assert.deepEqual(normalizeHelpArgv(['node', 'mr', '-help']), ['node', 'mr', '--help'])
  assert.deepEqual(normalizeHelpArgv(['node', 'mr', '-h']), ['node', 'mr', '-h'])
})

test('selectTarget fails fast outside an interactive terminal', async () => {
  await assert.rejects(
    selectTarget({ input: { isTTY: false } as any, output: { isTTY: false } as any, ui: createUi() }),
    /交互式终端/,
  )
})

test('assertConfigInteractiveTerminal explains non-interactive config usage', () => {
  assert.throws(
    () => assertConfigInteractiveTerminal({ isTTY: false } as any, { isTTY: false } as any),
    /mr --config 需要在交互式终端/,
  )
})

test('createSelectConfig maps the three target choices', () => {
  const ui = createUi({
    color: false,
    stream: {
      isTTY: false,
      write() {
        return true
      },
    } as any,
    env: {},
  })
  const config = createSelectConfig(ui)

  assert.equal(config.theme.indexMode, 'number')
  assert.deepEqual(
    config.choices.map((choice) => choice.value),
    ['master', 'test', 'prerelease'],
  )
})

test('createConfigScopeChoices follows git config scopes', () => {
  assert.deepEqual(
    createConfigScopeChoices(true).map((choice) => choice.value),
    ['local', 'global'],
  )
  assert.deepEqual(
    createConfigScopeChoices(false).map((choice) => choice.value),
    ['global'],
  )
})

test('createStrategyChoices exposes all MR strategies', () => {
  assert.deepEqual(
    createStrategyChoices().map((choice) => choice.value),
    ['merge', 'rebase', 'merge-target', 'pr'],
  )
})

test('formatCommand keeps shell-like output readable', () => {
  assert.equal(
    formatCommand('git', ['push', 'origin', 'HEAD:mr/master/feature/a']),
    'git push origin HEAD:mr/master/feature/a',
  )
  assert.equal(formatCommand('git', ['switch', 'feature with space']), 'git switch "feature with space"')
})

test('resolveColorEnabled follows explicit flags and terminal conventions', () => {
  assert.equal(resolveColorEnabled(true, { NO_COLOR: '1' }, { isTTY: false } as any), true)
  assert.equal(resolveColorEnabled(false, { FORCE_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { NO_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { MR_NO_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { TERM: 'dumb' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { FORCE_COLOR: '1' }, { isTTY: false } as any), true)
  assert.equal(resolveColorEnabled(undefined, {}, { isTTY: true } as any), true)
})

test('buildDryRunCommands includes the core MR workflow', () => {
  const commands = buildDryRunCommands('test', 'feature/demo')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +refs/heads/test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin refs/heads/mr/test/feature/demo',
    'git push origin refs/remotes/origin/test:refs/heads/mr/test/feature/demo',
    'git switch -C mr/test/feature/demo origin/test',
    'git branch --set-upstream-to origin/mr/test/feature/demo mr/test/feature/demo',
    'git merge --no-edit feature/demo',
    'git push origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands includes MR branch deletion when requested', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'merge', { deleteMrBranch: true })
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered.slice(0, 3), [
    'git fetch origin +refs/heads/test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin refs/heads/mr/test/feature/demo',
    'git push origin :refs/heads/mr/test/feature/demo',
  ])
})

test('buildDryRunCommands supports the rebase strategy', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'rebase')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +refs/heads/test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin refs/heads/mr/test/feature/demo',
    'git switch -C mr/test/feature/demo feature/demo',
    'git merge-base origin/test feature/demo',
    'git rebase --onto origin/test MERGE_BASE mr/test/feature/demo',
    'git push --force-with-lease --set-upstream origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands supports the merge-target strategy', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'merge-target')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +refs/heads/test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin refs/heads/mr/test/feature/demo',
    'git switch -C mr/test/feature/demo feature/demo',
    'git merge --no-edit origin/test',
    'git push --force-with-lease --set-upstream origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands supports direct PR creation from the current branch', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'pr')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +refs/heads/test:refs/remotes/origin/test',
    'git push --set-upstream origin HEAD:feature/demo',
    'git cnb pull create -H feature/demo -B test',
  ])
})

test('resolveMrStrategy accepts flags and environment configuration', async () => {
  assert.equal(await resolveMrStrategy({ merge: true, env: { MR_STRATEGY: 'rebase' } }), 'merge')
  assert.equal(await resolveMrStrategy({ rebase: true }), 'rebase')
  assert.equal(await resolveMrStrategy({ mergeTarget: true }), 'merge-target')
  assert.equal(await resolveMrStrategy({ pr: true }), 'pr')
  assert.equal(await resolveMrStrategy({ env: { MR_STRATEGY: 'merge_target' } }), 'merge-target')
})

test('resolveMrStrategy reads git config when no flag or environment override exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-strategy-'))
  const originalCwd = process.cwd()

  try {
    await execFileAsync('git', ['init'], { cwd: root })
    await execFileAsync('git', ['config', 'mr.strategy', 'merge-target'], { cwd: root })
    process.chdir(root)

    assert.equal(await resolveMrStrategy({ env: {} }), 'merge-target')
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('readMrSettings reports effective strategy by precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-settings-'))
  const repo = join(root, 'repo')
  const globalConfig = join(root, 'global.gitconfig')
  const originalCwd = process.cwd()
  const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL

  try {
    await execFileAsync('git', ['init', repo])
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    await execFileAsync('git', ['config', '--global', 'mr.strategy', 'rebase'])
    await execFileAsync('git', ['config', 'mr.strategy', 'merge-target'], { cwd: repo })
    process.chdir(repo)

    const settings = await readMrSettings({ env: {}, ui: createUi({ quiet: true }) })
    assert.equal(settings.effective, 'merge-target')
    assert.equal(settings.source, 'local')
    assert.equal(settings.global, 'rebase')
    assert.equal(settings.local, 'merge-target')

    const envSettings = await readMrSettings({ env: { MR_STRATEGY: 'pr' }, ui: createUi({ quiet: true }) })
    assert.equal(envSettings.effective, 'pr')
    assert.equal(envSettings.source, 'environment')
  } finally {
    process.chdir(originalCwd)
    if (originalGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('writeStrategyConfig and unsetStrategyConfig update git config scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-settings-write-'))
  const originalCwd = process.cwd()

  try {
    await execFileAsync('git', ['init'], { cwd: root })
    process.chdir(root)

    const context = { env: {}, ui: createUi({ quiet: true }) }
    await writeStrategyConfig('rebase', 'local', context)
    assert.equal((await execFileAsync('git', ['config', '--local', '--get', 'mr.strategy'])).stdout.trim(), 'rebase')

    assert.equal(await unsetStrategyConfig('local', context), true)
    assert.equal(await unsetStrategyConfig('local', context), false)
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveDetached accepts flags and environment configuration', async () => {
  assert.equal(await resolveDetached({ detached: true }), true)
  assert.equal(await resolveDetached({ detached: false }), false)
  assert.equal(await resolveDetached({ env: { MR_DETACHED: 'true' } }), true)
  assert.equal(await resolveDetached({ env: { MR_DETACHED: '0' } }), false)
})

test('readDetachedSettings reports effective detached by precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-settings-'))
  const repo = join(root, 'repo')
  const globalConfig = join(root, 'global.gitconfig')
  const originalCwd = process.cwd()
  const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL

  try {
    await execFileAsync('git', ['init', repo])
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    await execFileAsync('git', ['config', '--global', 'mr.detached', 'false'])
    await execFileAsync('git', ['config', 'mr.detached', 'true'], { cwd: repo })
    process.chdir(repo)

    const settings = await readDetachedSettings({ env: {}, ui: createUi({ quiet: true }) })
    assert.equal(settings.effective, true)
    assert.equal(settings.source, 'local')

    const envSettings = await readDetachedSettings({ env: { MR_DETACHED: 'false' }, ui: createUi({ quiet: true }) })
    assert.equal(envSettings.effective, false)
    assert.equal(envSettings.source, 'environment')
  } finally {
    process.chdir(originalCwd)
    if (originalGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('writeDetachedConfig and unsetDetachedConfig update git config scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-write-'))
  const originalCwd = process.cwd()

  try {
    await execFileAsync('git', ['init'], { cwd: root })
    process.chdir(root)

    const context = { env: {}, ui: createUi({ quiet: true }) }
    await writeDetachedConfig(true, 'local', context)
    assert.equal(
      (await execFileAsync('git', ['config', '--bool', '--local', '--get', 'mr.detached'])).stdout.trim(),
      'true',
    )

    assert.equal(await unsetDetachedConfig('local', context), true)
    assert.equal(await unsetDetachedConfig('local', context), false)
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('buildDryRunCommands supports detached merge plumbing', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'merge', { detached: true })
  assert.ok(commands.some((command) => command.label.includes('内存合并')))
  assert.ok(commands.some((command) => command.args[0] === 'merge-tree'))
})

test('resolveMrStrategy rejects conflicting strategy flags', async () => {
  await assert.rejects(resolveMrStrategy({ pr: true, rebase: true }), /只能指定一个 MR 策略选项/)
})

test('--detached works as a workflow modifier and a --config setter', () => {
  assert.deepEqual(resolveMaintenanceOptions({ detached: true }, 'master'), { command: undefined, error: null })
  assert.deepEqual(resolveMaintenanceOptions({ noDetached: true }, 'master'), { command: undefined, error: null })

  const configDetached = resolveMaintenanceOptions({ config: true, detached: true })
  assert.equal(configDetached.command, 'config')
  assert.equal(configDetached.error, null)
})

test('--detached still cannot mix with conflicting maintenance or strategy flags', () => {
  assert.equal(resolveMaintenanceOptions({ config: true, merge: true }).error?.constructor, CliError)
  assert.equal(resolveMaintenanceOptions({ strategy: 'rebase' }).error?.constructor, CliError)
})

test('withRecoveryDetails preserves the original error and records branch recovery', () => {
  const error = new CliError('合并失败。', {
    exitCode: 7,
    details: ['merge output'],
    next: ['处理冲突'],
  })

  const recovered = withRecoveryDetails(error, {
    attempted: true,
    branch: 'feature/demo',
    details: ['已自动回到初始分支: feature/demo'],
    restored: true,
  })

  assert.equal(recovered.message, '合并失败。')
  assert.equal(recovered.exitCode, 7)
  assert.deepEqual(recovered.details, ['merge output', '已自动回到初始分支: feature/demo'])
  assert.deepEqual(recovered.next, ['处理冲突'])
})

test('source files stay below the 300 line module limit', async () => {
  const sourceFiles = await listSourceFiles(join(projectRoot, 'src'))

  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8')
    const lineCount = source.trimEnd().split('\n').length
    assert.ok(lineCount <= 300, `${file} has ${lineCount} lines`)
  }
})
