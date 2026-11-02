# herdr-omp-catppuccin

一份 herdr-app 的布局（配色按 Catppuccin Mocha），加上改过的 `spaces-tree` mod。
Herdr-app layout in a Catppuccin mood, plus a customized `spaces-tree` mod
(Spaces / Routing / Usage tabs).

```
layouts/main-log.json    左侧栏 + 工作区结构
layouts/terminals.json   herdr 主题、字号、颜色（Mocha）
mods/spaces-tree/        自定义 mod（Spaces / Routing / Usage）
omp/catppuccin-mocha.json  omp TUI 主题（Catppuccin Mocha）
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

除 `spaces-tree` 外，其余 mod 都是 herdr-app 自带的（`workspace-chrome`、`agents-tree`、
`tabs-panel`、`files`、`changes`、`prompts`、`notes`、`quests`、`workspace-status`）。

## spaces-tree 做了什么

- **Spaces**：空间列表，工作树挂在仓库下面，多机时按机器分组；显示当前分支、ahead/behind；
  右侧 `+` 只在 Spaces tab 出现。
- **Routing**：读 magpie web（`:3430`）的 `/api/gateway/trace`，按 `caller → 模型组 → 账号`
  聚合最近的网关决策：次数、平均耗时、重试、错误，`●` 表示正在回答的请求，
  `N rest` 是该模型下额度用满（`used >= 100%`）的账号数。
- **Usage**：magpie 的配额与当日用量。多账号的 plan 默认收起（只有标题行），点开列出每个账号；
  单账号直接展示。进度条显示**剩余**额度，右侧是距重置的时间。

## 安装

```sh
git clone https://github.com/AlanWanco/herdr-omp-catppuccin
cd herdr-omp-catppuccin
cp layouts/main-log.json ~/.config/herdr-app/layouts/
cp -r mods/spaces-tree   ~/.config/herdr-app/mods/
```

重启 herdr-app，然后切换到 `main-log` 布局（或在现有布局里把相应 block 换成 `spaces-tree`）。

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

## 已知的坑

- 这个面板里 `justify_between`、`flex_1`、`ml_auto` 会把后面的兄弟元素吞掉；
  文本元素上的百分比宽度会被内容顶开。所以列宽都是按 `layout()` 的侧栏宽度算成像素，
  行内徽章用固定宽度，保证对齐。
- 带小数的百分比（`"17.2%"`）不生效，只有整数。

## 许可

个人配置，随手取用；没有附带许可证。
