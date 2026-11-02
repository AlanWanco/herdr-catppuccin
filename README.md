# herdr-omp-catppuccin

一份 herdr-app 的布局（配色按 Catppuccin Mocha），加上改过的 `spaces-tree` mod。
Herdr-app layout in a Catppuccin mood, plus a customized `spaces-tree` mod
(Spaces / Routing / Usage tabs).

```
layouts/main-log.json    左侧栏 + 工作区结构
layouts/terminals.json   herdr 主题、字号、颜色（Mocha）
mods/spaces-tree/        自定义 mod（Spaces / Routing / Usage）
mods/notes/               herdr 自带 notes mod 的本地修补
mods/agents-tree/         herdr 自带 agents-tree mod 的本地修补
mods/agent-menu/          agents-tree 的右键弹出菜单
mods/quests/              Quest board 的单条记录清理
omp/catppuccin-mocha.json omp TUI 主题（Catppuccin Mocha）
```

## 布局结构

```
row
├─ sidebar (268px)
│  ├─ brand         workspace-chrome   46px
│  ├─ spaces        spaces-tree        weight 1
│  ├─ agents        agents-tree        weight 1
│  └─ footer        workspace-chrome   69px
└─ work
   ├─ tabs         tabs-panel         42px
   ├─ body
   │  ├─ main      终端
   │  └─ panel (368px)
   │     ├─ files / changes / prompts / notes / quests
   └─ status       workspace-status   28px
```

`spaces-tree` 和 `agent-menu` 是自定义 mod；`notes`、`agents-tree`、`quests` 包含本仓库的修补。
其余依赖由 herdr-app 自带，包括 `workspace-chrome`、`tabs-panel`、`files`、`changes`、`prompts`、`workspace-status`。

## spaces-tree 做了什么

- **Spaces**：空间列表，工作树挂在仓库下面，多机时按机器分组；显示当前分支、ahead/behind；
  右侧 `+` 只在 Spaces tab 出现。
- **Routing**：读 magpie web（`:3430`）的 `/api/gateway/trace`，按 `caller → 模型组 → 账号`
  聚合最近的网关决策：次数、平均耗时、重试、错误，`●` 表示正在回答的请求，
  `N rest` 是该模型下额度用满（`used >= 100%`）的账号数。
- **Usage**：magpie 的配额与当日用量。多账号的 plan 默认收起（只有标题行），点开列出每个账号；
  单账号直接展示。进度条显示**剩余**额度，右侧是距重置的时间。

## 对自带 mod 的修补

`mods/notes`：
- “Pinned” 和 “This agent” 的行 id / pin id 分别带 `pinned-` / `mine-` 作用域，避免同一篇笔记的元素 id 重复。
- 打开笔记、切换笔记列表等异步入口使用 `cx.spawn`，读取完成后通过有效的异步上下文刷新界面，
  避免内容要等终端产生新消息才显示。点击事件的 `cx` 不能跨 `await` 使用。
- 打开失败时底部显示 `Could not open <name>`，不再一直停在省略号。

`mods/agents-tree`：
- **右键点击行**打开独立弹出菜单：重命名（改 tab 名）、归档、Catppuccin 颜色标签（14 色）。
  菜单覆盖在界面上，不挤动列表；行尾不再显示菜单 chevron。选项执行后关闭菜单，也可按 Esc 关闭。
- **Status 标题栏右侧的 Tags**：给 14 种颜色起名字（如 `red` → 服务维护）。名字显示在行的色点提示和右键菜单的标签行里；留空恢复颜色名。名字存于 herdr 共享状态，不进仓库。
- 归档的行收进列表底部的 **Archive** 分组，空分组也显示；正在跑（working/blocked）的会被自动取回，
  完成后保持在主列表，需要再次手动归档。
- 行尾的机器名（`mac-mini`）与分组标题重复，换成终端标题里的 **omp session title**：
  两行制，第一行只有 agent 名字（不缩），第二行缩进显示标题（`..` 截断），
  右侧依次是 space 胶囊、时长、状态圆点；右侧留出滚动条位置，圆点不会被压住。

`mods/quests`：
- 每条 quest 的 `Feedback to agent` 右侧提供 `Cancel`，删除该条记录所在机器上的缓存文件并移出看板。
  这是清理记录，不会中止 agent 或撤销已完成的工作。
- 删除失败时保留卡片并显示错误；等待已开始的勾选保存完成，再删除文件，避免保存和自动刷新把记录重新带回。
- 回归检查：`node --experimental-vm-modules --test tests/quests-cancel.test.mjs`（Node.js 20+）。

## 安装

```sh
git clone https://github.com/AlanWanco/herdr-omp-catppuccin
cd herdr-omp-catppuccin
cp layouts/main-log.json layouts/terminals.json ~/.config/herdr-app/layouts/
cp -r mods/spaces-tree mods/notes mods/agents-tree mods/agent-menu mods/quests ~/.config/herdr-app/mods/
```

文件会热加载；切换到 `main-log` 布局（或在现有布局里使用对应 mod）。

## omp 主题

`omp/catppuccin-mocha.json` 是 omp 的 TUI 主题，重点是**自己的消息一眼能认出来**：

```sh
cp omp/catppuccin-mocha.json ~/.omp/agent/themes/
# 然后 ~/.omp/agent/config.yml 里选它
# theme:
#   dark: catppuccin-mocha
```

- `userMessageText: #fab387`（peach）——你自己的话是橘色，助手正文保持终端默认白色；
- 其余按 Mocha：accent `#89b4fa`、mauve 标题、green/red 差异色、`surface1` 选中背景；
- 主题文件被监视，改完保存会即时生效（新会话或切换后）。

## 配置

源码里没有地址，两个端口固定（3425 key 鉴权的 API，3430 magpie web）：

```sh
# ~/.config/herdr-app/magpie-gateway.txt
your-gateway-host          # 只写主机名，没有的话默认 127.0.0.1
```

```sh
# ~/.config/herdr-app/magpie-web.key
<magpie web 的登录 key>     # 一行；没有它路由页会显示 reading magpie web…
```

API key 从 `omp auth export` 里取（`provider === "magpie"`），不落盘到仓库。

## 脱敏

仓库内容全部脱敏：

- 网关地址不写在源码里，改由 `~/.config/herdr-app/magpie-gateway.txt` 提供；
- 登录 key、账号（手机号/邮箱/用户名）、主目录路径都不在仓库里；
- 布局 JSON 只含 block id、mod 名和尺寸，不含目录、终端内容或机器名；
- commit 作者是统一的中性身份，不是个人邮箱。

## 许可

个人配置，随手取用；没有附带许可证。
