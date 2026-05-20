import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'

const execFileAsync = promisify(execFile)
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('installer links into a writable PATH directory so mr is immediately available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-install-'))

  try {
    const home = join(root, 'home')
    const pathBin = join(home, '.local/bin')
    const installDir = join(home, '.local/share/mr')
    const packageDir = join(root, 'package/mr')
    const archivePath = join(root, 'mr.tar.gz')
    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await mkdir(pathBin, { recursive: true })

    await writeFile(join(packageDir, 'dist/index.js'), ['#!/usr/bin/env node', 'console.log("0.0.0")', ''].join('\n'))
    await chmod(join(packageDir, 'dist/index.js'), 0o755)
    await writeFile(join(packageDir, 'package.json'), '{"name":"mr","version":"0.0.0"}\n')
    await writeFile(join(packageDir, 'README.md'), '# mr\n')
    await writeFile(join(packageDir, 'install.sh'), '#!/usr/bin/env bash\n')
    await writeFile(join(packageDir, 'uninstall.sh'), '#!/usr/bin/env bash\n')

    await execFileAsync('tar', ['-czf', archivePath, '-C', join(root, 'package'), 'mr'])

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${pathBin}:${process.env.PATH ?? ''}`,
      MR_INSTALL_DIR: installDir,
      MR_RC: join(home, '.shellrc'),
      MR_TARBALL_URL: `file://${archivePath}`,
    }
    delete env.MR_BIN_DIR

    const install = await execFileAsync('bash', [join(projectRoot, 'install.sh')], { env })
    assert.match(install.stdout, new RegExp(`命令链接目录: ${pathBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(install.stdout, /可以直接使用: mr --version/)
    assert.equal(await readlink(join(pathBin, 'mr')), join(installDir, 'dist/index.js'))

    const installed = await execFileAsync('mr', ['--version'], { env })
    assert.equal(installed.stdout.trim(), '0.0.0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
