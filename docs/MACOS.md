# Livermore macOS 桌面版

桌面版使用 AppKit 原生窗口与系统 WebKit，安装包中包含独立 Node 运行环境和 Agent 后端。聊天、持仓、任务、运行记录和报告在应用窗口中查看；Trace 在应用内另开窗口，新闻来源链接使用系统默认浏览器。

## 桌面工作台与外观

界面铺满窗口，左侧导航在研究对话、我的持仓、任务与记录、研究能力之间切换。聊天消息与右侧任务检查栏独立滚动，输入框固定在聊天区底部。全屏时展开工作区域，不保留网页式的外侧留白；窗口较窄时，任务检查栏默认收起，可从顶部右侧按钮打开，再次点击或按 Esc 收起。左侧导航也可收为图标栏。

左下角“外观”提供跟随系统、浅色、深色三种选项，选择会保存在本机。外观同时应用于聊天、持仓、报告预览、能力清单，以及 macOS 标题栏和原生设置窗口。默认窗口内容区为 1280 × 820，首次打开时根据屏幕可用空间缩小，后续记住窗口位置和尺寸。

`⌘N` 新建对话；`⌘1` 至 `⌘4` 切换四个工作区；`⌘\` 切换侧边栏。也可使用原生“显示”菜单完成导航。

## 安装

支持 macOS 14 或更新版本。构建产物与构建电脑架构一致：Apple Silicon 对应 `arm64`，Intel 对应 `x64`。

1. 打开 `release/Livermore-0.1.0-arm64.dmg`。
2. 将 `Livermore.app` 拖入 `Applications`。
3. 在“应用程序”或 Spotlight 中打开 Livermore。
4. 首次启动选择导入原项目，或全新使用；在“Livermore → 设置”中填写模型与飞书配置。

本机构建使用 ad-hoc 签名，没有 Apple Developer ID 签名或公证。在其他电脑上若被 Gatekeeper 拦截，可在核实来源后通过“系统设置 → 隐私与安全性 → 仍要打开”授权。公开分发前应使用自己的 Developer ID 对应用及内置可执行文件签名并公证。

## 导入现有项目

首次启动选择“导入现有项目”，选择包含 `.env` 和 `data/livermore.db` 的 Livermore 项目根目录。

导入内容包括 `.env`、SQLite 业务数据库（通过在线备份读取 WAL）、持仓、订阅、运行记录、报告和 Skills。报告的绝对路径会切换到新的数据目录；原项目不会被修改。首次启动创建的空数据库允许直接导入；非空数据库须在菜单中确认“备份并导入”。导入先在临时目录完成，再将原桌面工作区完整移入 `~/Library/Application Support/Livermore Backups/`，最后切换新工作区；失败会保留原数据。原来未结束的任务在副本中标记为失败并清理任务锁，避免被当作桌面版仍在运行的任务。

Python 虚拟环境不会被直接搬动。已有的 `FUTU_PYTHON` 配置仍可使用；在新电脑上使用“Agent → 安装研究依赖”创建独立的 Python 环境。Phoenix 的历史 Trace 数据仍位于原安装目录；若原 Phoenix 已运行，桌面版 Trace 窗口可继续查看它。

## 本地数据

默认保存到：

```text
~/Library/Application Support/Livermore/
  .env
  data/livermore.db
  data/reports/
  data/runtime/desktop.log
  data/phoenix/
  skills/
  .venv-futu/
  .venv-phoenix/
```

通过菜单“显示数据文件夹”和“查看运行日志”可以直接打开。应用升级替换 `.app` 时，这些文件会保留。安装包不包含开发电脑的 `.env`、数据库、报告或 Python 环境。

桌面版内部服务只绑定 `127.0.0.1:4311`，原命令行开发版默认使用 `4310`。无需浏览器访问内部地址。桌面版健康检查验证工作区标识，避免误连接其他实例。

## 研究依赖与后台运行

聊天和本地数据管理使用应用自带的 Node，无需系统安装 Node 或 npm。模型与市场资讯仍需联网。持仓行情查询还需要用户安装、启动并登录 Futu OpenD。

“Agent → 安装研究依赖（Phoenix / Futu）”通过 `uv` 安装 Python 3.12、Phoenix 和 Futu SDK。构建机器已安装 `uv` 时，构建脚本会一并打包该工具；否则需要先安装 `uv`。首次安装会下载依赖，日志位于 `data/runtime/desktop.log`。

“Agent → 启用后台定时任务”将现有 `com.livermore.*` LaunchAgent 切换为桌面版内置运行环境和数据目录，安装配置中的研究日程及飞书长连接。启用前应先把应用放进“应用程序”。之后关闭窗口或退出应用都不会停止后台研究。

尚未启用后台模式时，关闭窗口只隐藏主窗口，点击 Dock 图标可恢复；使用 `⌘Q` 退出会停止应用托管的服务。已单独启动的任务可以完成，历史数据会保留。停用后台任务通过菜单完成。

快捷键：`⌘,` 打开设置，`⌘R` 重新连接，`⌘T` 打开 Trace，`⌘0` 显示主窗口，`⌘Q` 退出。

## 消息中心与任务配置

“任务与记录”右上角提供“新增研究任务”，可新建自己的主题研究任务。自定义任务使用独立 Pi Agent、现有只读工具与 Skills，执行后自动保存 Markdown 报告、Trace 和消息。默认暂停定时；确认 Prompt 后可立即运行验证，再开启计划。删除自定义任务会停止后续计划，保留运行历史和报告。

左侧“历史会话”保留全部已开始的对话，按最近活动排序，可加载更早会话。点击“新对话”只进入新会话，不清除已有内容；应用退出或内存缓存被回收后，重新打开历史会话仍可加载本地工具上下文并继续提问。生成中的会话不可删除，删除其他会话也需要明确确认。历史不自动过期。旧版未落盘且已经丢失的会话无法自动恢复。

聊天右侧是最近推送消息，不再混合任务和运行记录。消息保存在 SQLite `alerts`，卡片显示优先级、摘要、未读状态以及 Mac / 飞书等渠道的独立投递结果。点击卡片预览 Markdown、标为已读，并可打开对应完整报告与 Trace。历史消息不会在升级时重发系统通知。

macOS 通知默认启用，首次打开新版应用会请求系统授权；拒绝后可以在消息栏进入系统设置。后台任务使用应用内原生通知辅助入口投递，不需要弹出主窗口；通知权限、系统专注模式和系统显示设置会影响可见性。通知只显示短摘要，完整消息始终保存在本地；点击通知回到消息详情。飞书投递不受 Mac 权限影响。实现采用 Apple [UserNotifications 授权与本地通知 API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter)。

“任务与记录”中的现有任务可打开“Prompt 与定时”：配置启停、运行日、时区、多组时间/模式和任务指令。日报保留 `{{sources}}` 用来注入实时来源；巡检持仓与价格口径、工具权限和确定性复核仍由代码管理。配置保存在业务数据库 `task_configurations`，有版本冲突保护；保存后下一次运行读取，已经开始的任务继续使用其启动时的配置。任务默认仅周一至周五，不内置交易所休市日历。

应用打开时托管本地调度器；启用后台模式后由 `com.livermore.tasks` 每分钟检查计划，应用退出后仍可运行。按任务、当地日期和时点持久化去重。启动/唤醒只补发最近两分钟内的时点，休眠期间不保证准点执行。旧静态计划按工作区归属迁移并备份到 `data/runtime/legacy-schedules/`。

## Cursor 订阅账号

桌面设置页提供“使用 Cursor 订阅账号”开关、“登录 Cursor”、“检查状态”和“可用模型”。登录通过 Pi OAuth 流程打开 Cursor 官方浏览器授权页，为 Livermore 创建独立会话。不需要安装 Cursor CLI，不读取 IDE、CLI 或全局 Pi 的已有凭据。

勾选订阅模式时，供应商切换为 `cursor`、默认模型设为 `auto`，API 地址与 API Key 输入框停用。可从账号返回的模型列表选择其他模型 ID。保存后聊天、定时研究和飞书对话统一使用所选模型；后台模式下需要再次启用后台任务以重新加载配置。

Livermore 使用 Pi 1.5.0 加载社区扩展 `@rahularya01/pi-cursor@1.4.39`，通过原生 Cursor 协议返回标准 Pi ToolCall；Pi 在父进程校验并执行已注册的工具，再将 ToolResult 交回同一模型会话。独立子进程不会继承其他服务的 API Key 或 Node 预加载配置。该扩展不是 Cursor 官方 SDK，协议变动可能影响可用性；服务端支持的搜索等操作不属于 Livermore 本地工具。会话中的持仓和研究材料作为模型上下文发送到 Cursor，适用账号模型权限、额度和计费规则。

授权凭据位于 `~/Library/Application Support/Livermore/data/runtime/pi-cursor/auth.json`（目录 0700、文件 0600），缓存和会话日志也位于该目录，可能包含研究上下文，请按敏感本地数据保护。`livermore cursor logout` 仅清除 Livermore 的授权。Trace 展示 Provider 返回的用量，其中部分可能为扩展估算；不把 DeepSeek 单价用于订阅调用。成本字段 0 表示没有计算 API 费用，不能作为 Cursor 订阅账单。可运行 `livermore cursor verify`，使用合成数据验证“模型 → Pi 工具 → 模型续答”，不触发持仓巡检或飞书通知。

## 构建与验证

构建机器需要 Node 22+、npm 和 Xcode Command Line Tools。依赖安装后执行：

```bash
npm run desktop:update
```

会退出正在运行的应用，打包后覆盖 `/Applications/Livermore.app` 并重新打开。默认只构建 `.app`；需要 DMG 时执行 `npm run desktop:update -- --dmg`，只打包不打开时加 `--no-open`。

也可以只构建：

```bash
npm run desktop:build
```

生成 `release/macos.noindex/Livermore.app` 和 `release/` 下对应架构的 DMG。构建目录和归档目录使用 `.noindex` 后缀，避免临时应用和旧版应用进入 Spotlight；打包完成会清理本次临时目录。仅构建应用时可用 `npm run desktop:build -- --app-only`。每次构建使用隔离目录，旧构建会在 `.noindex` 目录中归档，正式安装入口为 `/Applications/Livermore.app`。

```bash
npm run desktop:verify
npm run desktop:verify-gui
```

第一项验证活跃 SQLite/WAL 数据迁移、路径重写、覆盖保护，以及在没有仓库和开发 PATH 的独立目录启动打包的后端。第二项启动真实 AppKit/WebKit 窗口，使用模拟持仓和运行记录检查 25 种尺寸、主题与页面组合，验证窗口铺满、长对话与多行输入、导航、检查栏开合、持仓、Markdown 报告预览、消息卡片、任务配置编辑与保存、新增研究任务、历史会话切换与恢复、系统外观及原生设置窗口，并输出截图。测试使用临时目录和临时 WebKit 存储，不改变用户外观设置，不触发投资任务或发送飞书消息。
