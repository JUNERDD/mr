# mr

一个用于标准 Git 仓库准备合并请求分支的 Node CLI。它基于 Pastel + Ink + React + Zod + TypeScript，提供 `mr` 交互式选择入口，保留 `mrm`、`mrt`、`mrp` 三个短命令，并把分支判断、冲突处理、推送、可选合并请求命令、中文 ASCII UI、dry-run、verbose 诊断和无颜色/无动画模式放到可维护的 Node 脚本里。

## 命令

```sh
mr master
mr test
mr prerelease

mr  # 交互式选择 master / test / prerelease
mrm # master
mrt # test
mrp # prerelease
mr --config # 交互式设置默认策略、无感模式和请求 provider
```

常用 DX 开关：

```sh
mr test --dry-run       # 只看计划，不修改本地或远程状态
mr test --rm-mr         # 先删除对应远程 MR 分支，再按所选策略重建
mr test --pr            # 直接推送当前分支作为请求源，不创建 mr/* 分支
mr test --detached      # 显式开启无感模式（默认已开启）
mr test --no-detached   # 临时使用传统切分支模式
mr test --verbose       # 输出实际执行的 git 命令和完整输出
mr test --quiet         # 只输出错误
mr test --no-color      # 禁用颜色，适合日志和无障碍场景
mr test --no-spinner    # 禁用交互式进度动画
mr -h                   # 查看帮助
mr -help                # 同样查看帮助
```

维护命令：

```sh
mr --config             # 交互式查看和设置默认策略、无感模式和请求 provider
mr --update             # 更新到最新 GitHub Release 预构建产物
mr --uninstall          # 卸载 mr
```

## 本机启用

一键安装：

```sh
curl -fsSL https://raw.githubusercontent.com/JUNERDD/mr/main/install.sh | bash
```

安装脚本默认下载 GitHub Release 中的预构建产物 `mr.tar.gz`，不会在本机执行 `npm ci` 或 TypeScript 构建。
命令链接会优先放到当前 `PATH` 中可写的目录，安装完成后当前终端通常可以直接执行 `mr`。

卸载：

```sh
mr --uninstall
```

也可以直接执行：

```sh
curl -fsSL https://raw.githubusercontent.com/JUNERDD/mr/main/uninstall.sh | bash
```

本地开发时，也可以在当前目录执行：

```sh
nvm use
npm install
npm run fix
npm run check
npm run build
npm link
```

`npm link` 使用的是 `dist/index.js`，也就是 TypeScript 源码经构建工具转换并压缩后的版本。
`npm run fix` 是一键修复入口，会先用 Oxfmt 格式化，再用 Oxlint 应用安全 lint fix。
`npm run check` 是本地和 CI 共用的质量门禁，会依次执行 Oxfmt 格式检查、Oxlint、TypeScript strict typecheck、Vitest、tsdown build 和 `node --check dist/index.js`。

如果要用当前工作区源码打一个本地预构建包，并覆盖本机已安装的 `mr`：

```sh
npm run install:local
```

该命令会先执行 `npm run build`，再生成 `artifacts/mr.tar.gz`，最后复用 `install.sh` 从这个本地包安装。已确认不需要重新构建时，可以执行：

```sh
MR_LOCAL_SKIP_BUILD=1 npm run install:local
```

指定安装某个 release：

```sh
MR_RELEASE_TAG=v0.3.0 \
curl -fsSL https://raw.githubusercontent.com/JUNERDD/mr/main/install.sh | bash
```

## 行为

- 当前分支已经合入目标分支：直接退出，不推送分支，也不处理合并请求。
- 默认等同于 `--merge`：从目标分支准备 MR 分支，再把当前分支 merge 进去。
- 默认启用无感模式：不切换本地分支，不要求 tracked 工作区干净；需要传统切分支流程时使用 `--no-detached`、`MR_DETACHED=false` 或 `git config mr.detached false`。
- 远程 MR 分支已存在：默认统一复用已有 MR 分支，合入当前分支并同步目标分支。
- `--rm-mr`：在 MR 分支策略中，当前分支尚未合入目标分支时，先删除对应远程 `mr/<target>/<current>` 分支，再按所选策略重建；不能和 `--pr` 一起使用。
- 远程 MR 分支不存在：默认 `--merge` 会先从目标分支创建远程 MR 分支占位，再用无感模式准备并更新 MR 分支；传统模式会在本地从目标分支准备 MR 分支并合入当前分支。
- 远程 MR 分支检查使用完整 `refs/heads/<branch>` 精确匹配；如果检查后拉取 MR 分支时远端分支已消失，会按“不存在”继续创建或重新生成。
- 默认 `mr.requestProvider=auto`：MR 分支或当前分支推送完成后，会按 `origin` 自动识别 CNB/GitHub/GitLab 并执行对应 provider 预设；无法识别或 provider 为 `none` 时，只提示在 Git 平台手动创建合并请求。
- `--pr`：不创建 `mr/*` 分支，直接推送当前分支作为请求源；如果 provider 或自定义命令可用，则用当前分支和目标分支处理合并请求。
- 默认无感 merge / merge-target 冲突：进入临时 `git worktree`；在 worktree 内解决冲突并 `git add <files>` 后，回到主仓库重新运行 `mr <target> --detached` / `mrt --detached` 自动 resume、推送、处理合并请求并清理 worktree。
- 传统模式 merge 冲突：处于 MR 分支的待解决冲突状态；解决后 `git add <files>`，再重新运行 `mr <target> --no-detached` / `mrt --no-detached` 提交合并结果、推送并处理合并请求。
- `--rebase`：从当前分支准备 MR 分支，再 rebase 到目标分支。
- `--merge-target`：从当前分支准备 MR 分支，再把目标分支 merge 进去。
- `--pr` 和三种 MR 分支策略都适用于 `mr` 交互式选择、`mrm`、`mrt`、`mrp` 和 `mr <target>`；也可通过 `mr --config`、`git config mr.strategy pr|merge|rebase|merge-target` 或 `MR_STRATEGY=...` 设置默认策略。
- `--detached`：显式开启默认无感模式，正交于策略。happy path 用 `merge-tree` / `commit-tree` 推送 `mr/*` 分支，不切换本地分支、不要求 tracked 工作区干净；`--rebase` 或发生冲突时回退到临时 `git worktree`，在 worktree 内解决冲突后回到主仓库重跑 `mr <target> --detached` 自动 resume 并清理 worktree。
- `--pr` 在 detached 下本就无需切分支，行为与 `--pr` 一致。
- 传统内联模式的其他中途失败：自动尝试回到初始分支。
- 传统内联模式（`--no-detached` 或 `mr.detached=false`）要求 tracked 工作区干净，避免切换分支时带入未提交改动。
- 进度、诊断和错误写到 stderr，命令输出不会污染管道中的 stdout。

## 配置

默认策略遵循常见 CLI 分层：命令行 flag 只影响本次执行，环境变量适合 CI / 脚本，持久默认值写入配置。

优先级从高到低：

1. `--pr` / `--merge` / `--rebase` / `--merge-target`
2. `MR_STRATEGY=pr|merge|rebase|merge-target`
3. 当前仓库 `git config mr.strategy ...`
4. 全局用户 `git config --global mr.strategy ...`
5. 内置默认 `merge`

无感模式（detached）优先级从高到低：

1. `--detached` / `--no-detached`
2. `MR_DETACHED=true|false|1|0`
3. 当前仓库 `git config mr.detached true|false`
4. 全局用户 `git config --global mr.detached true|false`
5. 内置默认 `true`

标准 Git 没有统一的 PR/MR 创建命令；`mr` 默认只依赖 Git 完成分支准备和推送，合并请求创建通过 provider CLI 预设或自定义命令补齐。

合并请求 provider 默认是 `auto`，会按当前 `origin` 自动识别仓库类型，并且只在对应命令可用时启用预设：

- CNB remote：如果环境中可用 `git cnb`，执行 `git cnb pull create`，兼容旧行为。
- GitHub remote：如果环境中可用 `gh`，执行 `gh pr create`。
- GitLab remote：如果环境中可用 `glab`，执行 `glab mr create`。
- 无法识别或 provider 为 `none`：只用标准 Git 推送分支，并提示在 Git 平台手动创建合并请求。

需要固定 provider 时，配置 `mr.requestProvider` 或 `MR_REQUEST_PROVIDER`；固定为 `cnb`、`github` 或 `gitlab` 会直接使用对应预设，不再按 remote 重新判断：

```text
auto
none
cnb
github
gitlab
```

需要完全自定义命令时，配置 `mr.requestCommand` 或 `MR_REQUEST_COMMAND`；自定义命令优先级高于 provider 预设。命令会通过 `sh -c` 执行，并获得以下环境变量：

- `MR_SOURCE_BRANCH` / `MR_HEAD_BRANCH`：请求源分支，例如 `mr/test/feature/demo` 或 `feature/demo`
- `MR_TARGET_BRANCH` / `MR_BASE_BRANCH`：目标分支，例如 `test`

请求命令 / provider 优先级从高到低：

1. `MR_REQUEST_COMMAND='...'`
2. 当前仓库 `git config mr.requestCommand '...'`
3. 全局用户 `git config --global mr.requestCommand '...'`
4. `MR_REQUEST_PROVIDER=auto|none|cnb|github|gitlab`
5. 当前仓库 `git config mr.requestProvider ...`
6. 全局用户 `git config --global mr.requestProvider ...`
7. 内置默认 `auto`

示例：

```sh
git config --global mr.requestProvider github
git config --global mr.requestProvider gitlab
git config --global mr.requestProvider cnb
git config --global mr.requestProvider none
git config --global mr.requestCommand 'gh pr create --fill --head "$MR_SOURCE_BRANCH" --base "$MR_TARGET_BRANCH"'
git config --global mr.requestCommand 'glab mr create --fill --source-branch "$MR_SOURCE_BRANCH" --target-branch "$MR_TARGET_BRANCH"'
git config --global mr.requestCommand 'git cnb pull create -H "$MR_SOURCE_BRANCH" -B "$MR_TARGET_BRANCH"'
```

交互式设置默认策略、无感模式和请求 provider：

```sh
mr --config
```

脚本友好用法：

```sh
mr --config --show
mr --config --strategy rebase
mr --config --request-provider github
mr --config --request-command 'gh pr create --fill --head "$MR_SOURCE_BRANCH" --base "$MR_TARGET_BRANCH"'
mr --config --global --strategy pr
mr --config --global --request-provider none
mr --config --unset
mr --config --unset-request-command
mr --config --unset-request-provider
mr --config --detached
mr --config --no-detached
mr --config --global --detached
```

`mr --config --show` 会展示当前有效策略、detached 设置、provider 和合并请求命令；`mr --config --unset` 会清除所选作用域的 `mr.strategy` 和 `mr.detached`，不会删除已有的 `mr.requestProvider` 或 `mr.requestCommand`。需要禁用内置 provider 时使用 `mr --config --request-provider none`；需要删除自定义请求命令或 provider 时使用 `mr --config --unset-request-command` / `mr --config --unset-request-provider`。

## 分支逻辑图

图中 `B` 是当前业务分支，`T` 是目标分支，例如 `test`，`M` 是生成的 MR 分支 `mr/<T>/<B>`。

默认会走无感模式；下面这张图描述显式 `--no-detached` 或 `mr.detached=false` 时的传统内联流程。

```mermaid
flowchart TD
  A["执行 mr*<br/>mr / mrm / mrt / mrp / mr &lt;target&gt;"] --> B["解析目标分支 T<br/>mrm=master, mrt=test, mrp=prerelease"]
  B --> C["解析策略<br/>--pr 或 --merge / --rebase / --merge-target<br/>可加 --rm-mr 先删远程 M<br/>mr --config / git config 可设置默认"]
  C --> D["要求 tracked 工作区干净<br/>fetch origin/T"]
  D --> E{"当前是否处于 M 的<br/>未完成 merge/rebase 状态?"}

  E -- "是: merge 状态" --> F["用户已解决冲突并 git add 后<br/>重新执行 mr*"]
  F --> G["git commit --no-edit<br/>push M<br/>处理合并请求"]

  E -- "是: rebase 状态" --> H["用户已解决冲突并 git add 后<br/>重新执行 mr*"]
  H --> I["git rebase --continue<br/>push --force-with-lease M<br/>处理合并请求"]

  E -- "否" --> J{"B 是否已经合入 origin/T?"}
  J -- "是" --> K["无需操作<br/>不处理合并请求"]
  J -- "否" --> PR{"是否 --pr?"}

  PR -- "是" --> PR1["push 当前分支 B"]
  PR1 --> PR2["处理合并请求<br/>有请求命令则执行<br/>否则提示手动创建"]
  PR2 --> U

  PR -- "否" --> RM{"是否 --rm-mr?"}

  RM -- "是" --> RM1["删除远程 M<br/>不存在则继续"]
  RM1 --> N{"所选策略"}
  RM -- "否" --> L{"远程 MR 分支<br/>refs/heads/M 是否精确存在?"}

  L -- "存在" --> M1["统一复用 origin/M<br/>不按策略重建"]
  M1 --> M0{"fetch origin/M<br/>是否成功?"}
  M0 -- "成功" --> M2["git switch -C M origin/M"]
  M0 -- "分支已消失" --> N
  M2 --> M3["merge B<br/>把当前业务改动合入已有 MR 分支"]
  M3 --> C1{"冲突?"}
  C1 -- "否" --> M4["merge origin/T<br/>同步目标分支"]
  C1 -- "是" --> Y
  M4 --> C2{"冲突?"}
  C2 -- "否" --> P["push M"]
  C2 -- "是" --> Y

  L -- "不存在" --> N
  N -- "--merge 或默认" --> O1["从 origin/T 创建远程 M 占位<br/>避免冲突态与远程 MR 分叉"]
  O1 --> O2["git switch -C M origin/T"]
  O2 --> O3["merge B<br/>从目标分支合入当前业务分支"]
  O3 --> C3{"冲突?"}
  C3 -- "否" --> P
  C3 -- "是" --> Y

  N -- "--rebase" --> R1["git switch -C M B"]
  R1 --> R2["git rebase --onto origin/T<br/>把业务提交重放到目标分支上"]
  R2 --> C4{"冲突?"}
  C4 -- "否" --> R3["push --force-with-lease M"]
  C4 -- "是" --> Y
  R3 --> Q

  N -- "--merge-target" --> S1["git switch -C M B"]
  S1 --> S2["merge origin/T<br/>从当前业务分支合入目标分支"]
  S2 --> C5{"冲突?"}
  C5 -- "否" --> S3["push --force-with-lease M"]
  C5 -- "是" --> Y
  S3 --> Q

  P --> Q["处理合并请求<br/>有请求命令则执行<br/>否则提示手动创建"]
  Q --> U{"请求命令是否成功<br/>或未配置?"}
  U -- "成功 / 未配置" --> V["完成<br/>切回 B"]
  U -- "失败" --> W["不阻断<br/>MR 分支已推送，直接完成并切回 B"]

  Y["停在 M 的冲突状态<br/>手动解决冲突并 git add"]
  Y --> Z["重新执行同一个 mr* 命令<br/>自动继续 commit 或 rebase"]
```

无感模式是内置默认；它在策略解析后走独立路径，不切本地分支：

```mermaid
flowchart TD
  D0["默认 detached / --detached"] --> D1{"遗留冲突 worktree?"}
  D1 -- "是" --> D2["worktree 内 resume<br/>push + 处理请求 + 删除 worktree"]
  D1 -- "否" --> D3{"策略"}
  D3 -- "pr" --> D4["push B + 处理请求"]
  D3 -- "rebase" --> D5["临时 worktree 变基"]
  D3 -- "merge / merge-target" --> D6["merge-tree 内存合并"]
  D6 --> D7{"冲突?"}
  D7 -- "否" --> D8["commit-tree + push OID + 处理请求"]
  D7 -- "是" --> D9["临时 worktree 真实 merge<br/>解决后重跑 mr --detached"]
```

## UI / DX

- `mr -h`、`mr -help`、`mr --help` 都展示 Pastel 根据 Zod schema 生成的参数、选项和版本信息。
- Pastel 会给布尔 flag 展示默认值；`--dry-run` 等显示“关闭”表示该 flag 默认不启用，`--merge` / `--rebase` / `--merge-target` 显示的是“是否临时覆盖策略”，真正的默认策略由 `mr --config` 决定，内置默认是 `merge`；无感模式的内置默认是开启，`--no-detached` 用于临时关闭。
- `mr` 会进入 Ink 键盘交互选择，支持上下键、数字键 `1-3`、回车确认、`q` 或 `Ctrl-C` 取消。
- `mr --config` 会进入 Ink 键盘交互设置，先选择写入当前仓库还是全局用户配置，再选择默认策略、无感模式和请求 provider；脚本环境可用 `mr --config --strategy rebase`、`mr --config --request-provider github`、`mr --config --request-command '...'`、`mr --config --global --strategy pr`、`mr --config --show` 或 `mr --config --unset`。
- `mr --update` 会重新执行已安装的 `install.sh`，下载最新 release 预构建产物并覆盖当前安装。
- `mr --uninstall` 会执行已安装的 `uninstall.sh`，删除命令链接、安装目录和 shell 配置片段。
- 如果旧安装目录只有 `dist/` 而缺少 `install.sh` / `uninstall.sh`，`--update` / `--uninstall` 会回退到 GitHub 上的官方脚本，并沿用当前安装目录和命令目录。
- `--version` 输出当前版本。
- `--dry-run` 展示可能执行的 git 命令和可选合并请求命令，不修改本地分支、远程分支或创建合并请求。
- `--rm-mr` 先删除对应远程 MR 分支，再按 `--merge`、`--rebase` 或 `--merge-target` 重建。
- `--pr`、`--merge`、`--rebase`、`--merge-target` 可临时覆盖 `mr.strategy` 配置。
- 默认输出只保留关键步骤；`--verbose` 才展示完整命令和完整输出。
- 错误会给出可执行的下一步，例如缺少依赖、目标分支不存在、工作区不干净或合并冲突。
- 颜色遵循 `NO_COLOR`、`MR_NO_COLOR`、`FORCE_COLOR`、`TERM=dumb` 和 `--no-color` / `--color`。
- 非 TTY 或 CI 环境自动禁用动画，避免日志被 spinner 刷屏。
- 交互式终端中会按 24 小时缓存检查一次 GitHub latest release；发现新版本时在 stderr 提示 `mr --update`。`--quiet`、CI、非 TTY、`mr --update`、`mr --uninstall`、帮助和版本输出会跳过检查，网络失败会静默忽略。
- 需要关闭新版本自动检查时，设置 `MR_NO_UPDATE_CHECK=1`；兼容通用关闭变量 `NO_UPDATE_NOTIFIER=1`。

运行耗时命令时，交互式终端会显示单行 ASCII spinner；非 TTY、CI、`TERM=dumb`、无颜色输出或 `--no-spinner` 时降级为稳定文本状态：

```text
- \ | /
```

## 工程结构

源码使用 TypeScript/TSX，按职责拆分到目录，并通过测试约束每个 `src/**/*.ts(x)` 不超过 300 行。发布入口是 `src/index.ts`，构建由 tsdown/Rolldown 输出压缩后的 `dist/index.js`、`dist/commands/*.js` 和共享 chunks：

- `src/index.ts`：构建入口和兜底错误输出。
- `src/commands/`：Pastel command、Zod 参数/选项 schema 和 React/Ink 命令组件。
- `src/cli/`：Pastel 启动、生命周期命令分流、调用入口状态。
- `src/workflow/`：MR 分支准备、策略执行、冲突恢复和请求命令编排。
- `src/git/` / `src/runtime/`：Git 命令执行、安装更新卸载、退出码和诊断。
- `src/ui/`：终端输出、颜色、动画策略和 Ink `mr` 键盘交互选择。
- `src/core/`：dry-run、目标分支、格式化、错误等可测试纯逻辑。
- `test/`：Vitest 单元测试。
- `.oxfmtrc.json`：Oxfmt 格式化配置，作为 `npm run check` 的第一道质量门禁。
- `.oxlintrc.json`：Oxlint 配置，用于快速静态检查 TypeScript、Node 和 Vitest 代码。
- `vitest.config.ts`：Vitest 配置；Git 集成测试会修改进程级 cwd/env，因此测试文件串行执行并使用更高超时。
- `tsdown.config.ts`：tsdown 构建配置，输出 bundled + minified + code-splitting 的 Pastel 可发现命令目录，并保留 `dist/index.js` 可执行权限。
- `scripts/package-release.sh`：把 `dist/`、`package.json`、`README.md`、`install.sh`、`uninstall.sh` 打包成安装脚本使用的 release 产物。

## CI/CD

GitHub Actions 会在 PR 和 `main` 推送时执行：

- `npm ci`
- `npm run check`，包括 Oxfmt、Oxlint、TypeScript strict typecheck、Vitest、tsdown build 和 dist 语法检查
- `npm run pack:release`
- 解压 `artifacts/mr.tar.gz` 并执行 `dist/index.js --version` 做冒烟验证

推送 `v*` tag 时，流水线会把以下文件发布到对应 GitHub Release：

- `mr.tar.gz`
- `mr.sha256`

发布新版本：

```sh
npm run release:patch
git push origin main --follow-tags
```

需要发 minor 或 major 时，改用 `npm run release:minor` 或 `npm run release:major`。发布脚本会先执行 `npm run check`，再由 `npm version` 自动更新 `package.json` / `package-lock.json`、创建 release commit 和 `v*` tag。CI 在 tag 构建时会校验 tag 版本必须等于 `package.json` 版本，避免发出版本号不一致的产物。

## 依赖

需要本机可用：

- Node.js 20.12+，用于运行预构建产物
- Node.js 22.18+，用于本地开发构建和 CI；仓库提供 `.node-version` 和 `.nvmrc`
- npm 10.9+，本地开发推荐使用 `packageManager` 中声明的版本
- Git

安装预构建产物只需要 Node.js、Git、curl 和 tar；npm 只用于本地开发和 CI 构建。

## 安装路径

默认安装到：

```text
~/.local/share/mr
```

命令链接默认优先放到当前 `PATH` 中可写的目录，从而安装后无需 `source` 即可直接使用。找不到合适目录时回退到：

```text
~/.local/bin
```

回退时安装脚本会把该目录写入 shell 配置，新终端自动生效。

可以通过环境变量覆盖：

```sh
MR_INSTALL_DIR="$HOME/.mr" \
MR_BIN_DIR="$HOME/bin" \
curl -fsSL https://raw.githubusercontent.com/JUNERDD/mr/main/install.sh | bash
```

## License

MIT
