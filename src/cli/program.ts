import Pastel from 'pastel'
import { normalizeHelpArgv } from '../core/targets.js'
import { checkForUpdate } from '../runtime/update-check.js'
import { createUi } from '../ui/terminal.js'
import { setCurrentArgv } from './runtime-state.js'

declare const __PACKAGE_VERSION__: string

const DESCRIPTION = '从目标分支准备通用 Git 合并请求分支，并在本地处理冲突'
const PACKAGE_VERSION = typeof __PACKAGE_VERSION__ === 'undefined' ? '0.0.0-dev' : __PACKAGE_VERSION__

async function notifyUpdateIfAvailable(argv: string[]) {
  const update = await checkForUpdate({ argv, currentVersion: PACKAGE_VERSION })
  if (!update) {
    return
  }

  const ui = createUi({ color: argv.includes('--color') ? true : argv.includes('--no-color') ? false : undefined })
  ui.panel(
    '发现新版本',
    [
      `mr ${update.currentVersion} -> ${update.latestVersion}`,
      '运行 mr --update 更新到最新 GitHub Release。',
      '设置 MR_NO_UPDATE_CHECK=1 可关闭自动检查。',
    ],
    { tone: 'warn' },
  )
}

export async function main(argv = process.argv) {
  argv = normalizeHelpArgv(argv)
  setCurrentArgv(argv)
  await notifyUpdateIfAvailable(argv)

  await new Pastel({
    name: 'mr',
    version: PACKAGE_VERSION,
    description: DESCRIPTION,
    importMeta: import.meta,
  }).run(argv)
}
