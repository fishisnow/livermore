import AppKit
import WebKit
import UserNotifications

@main
struct LivermoreApplication {
    static func main() {
        if CommandLine.arguments.contains("--notification-stdin") { NotificationHelper.run(); return }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var traceWindows: [NSWindow] = []
    private var settingsWindow: NSWindow?
    private var settingsFields: [String: NSTextField] = [:]
    private var cursorToggle: NSButton?
    private var cursorStatusLabel: NSTextField?
    private var apiSettingsBeforeCursor: [String: String] = [:]
    private var host: Process?
    private var statusTimer: Timer?
    private var hostStartedAt = Date()
    private var quitting = false
    private var operationInProgress = false
    private var smokeCaptured = false
    private var pendingNotificationID: String?
    private var webReady = false
    private var isSmokeTest: Bool { ProcessInfo.processInfo.environment["LIVERMORE_DESKTOP_SMOKE_OUTPUT"] != nil }
    private var lastTraceURL: URL?
    private var lastTraceOpenedAt = Date.distantPast
    private var workspace: URL {
        if let override = ProcessInfo.processInfo.environment["LIVERMORE_DESKTOP_WORKSPACE"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Livermore", isDirectory: true)
    }
    private var resources: URL { Bundle.main.resourceURL!.appendingPathComponent("runtime") }
    private var node: URL { resources.appendingPathComponent("bin/node") }
    private let origin = URL(string: "http://127.0.0.1:4311")!
    private var logURL: URL { workspace.appendingPathComponent("data/runtime/desktop.log") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second launch focuses the existing instance instead of starting another backend.
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.livermore.desktop")
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            other.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }
        createMenu()
        createWindow()
        if !isSmokeTest {
            UNUserNotificationCenter.current().delegate = self
            refreshNotificationPermission(request: true)
        }
        do {
            try FileManager.default.createDirectory(at: workspace.appendingPathComponent("data/runtime"), withIntermediateDirectories: true)
            let firstLaunch = !FileManager.default.fileExists(atPath: workspace.appendingPathComponent(".desktop-initialized").path)
            if firstLaunch {
                let alert = NSAlert()
                alert.messageText = "欢迎使用 Livermore"
                alert.informativeText = "可以导入现有项目的配置、持仓和历史报告，也可以开始全新使用。数据保存在这台 Mac 上。"
                alert.addButton(withTitle: "导入现有项目")
                alert.addButton(withTitle: "开始全新使用")
                if alert.runModal() == .alertFirstButtonReturn {
                    guard let source = selectProject() else {
                        showProgress("尚未导入项目。请在 Agent 菜单中选择“导入现有项目”。")
                        return
                    }
                    showProgress("正在导入持仓和历史报告…")
                    runOperation("import", arguments: [source.path]) { [weak self] success in
                        guard let self else { return }
                        if success { self.finishFirstLaunch() }
                        else { self.showProgress("导入失败。请在菜单中重新导入，或打开设置后重新连接。") }
                    }
                    return
                }
                finishFirstLaunch()
            } else {
                startHost()
            }
        } catch { showError(error.localizedDescription) }
    }

    private func finishFirstLaunch() {
        FileManager.default.createFile(atPath: workspace.appendingPathComponent(".desktop-initialized").path, contents: Data())
        startHost()
    }

    private func createWindow() {
        let storedAppearance = UserDefaults.standard.string(forKey: "LivermoreAppearance") ?? "system"
        let appearance = ["system", "light", "dark"].contains(storedAppearance) && !isSmokeTest ? storedAppearance : "system"
        applyAppearance(appearance)
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        if isSmokeTest { configuration.websiteDataStore = .nonPersistent() }
        configuration.userContentController.add(self, name: "livermore")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.livermoreDesktop=true;window.livermoreInitialAppearance='\(appearance)';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        let visible = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let size = NSSize(width: min(1280, visible.width - 60), height: min(820, visible.height - 70))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Livermore"
        window.minSize = NSSize(width: 980, height: 660)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        if isSmokeTest || !window.setFrameUsingName("LivermoreMainWindowV2") { window.center() }
        if !isSmokeTest { window.setFrameAutosaveName("LivermoreMainWindowV2") }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showProgress("正在启动本地 Agent…")
    }

    private func createMenu() {
        let menu = NSMenu()
        let application = NSMenu()
        application.addItem(withTitle: "关于 Livermore", action: #selector(about), keyEquivalent: "")
        application.addItem(.separator())
        application.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        application.addItem(withTitle: "显示数据文件夹", action: #selector(openData), keyEquivalent: "")
        application.addItem(withTitle: "查看运行日志", action: #selector(openLogs), keyEquivalent: "")
        application.addItem(.separator())
        application.addItem(withTitle: "隐藏 Livermore", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        application.addItem(withTitle: "退出 Livermore", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = application; menu.addItem(appItem)

        let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("重做", "redo:", "Z"), ("剪切", "cut:", "x"),
                                       ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let editItem = NSMenuItem(); editItem.submenu = edit; menu.addItem(editItem)

        let view = NSMenu(title: "显示")
        for (index, title) in ["研究对话", "我的持仓", "定时任务", "研究能力"].enumerated() {
            let item = view.addItem(withTitle: title, action: #selector(navigateWorkspace(_:)), keyEquivalent: String(index + 1))
            item.tag = index; item.target = self
        }
        view.addItem(.separator())
        view.addItem(withTitle: "切换侧边栏", action: #selector(toggleSidebar), keyEquivalent: "\\").target = self
        view.addItem(withTitle: "切换任务检查栏", action: #selector(toggleInspector), keyEquivalent: "").target = self
        let viewItem = NSMenuItem(); viewItem.submenu = view; menu.addItem(viewItem)

        let agent = NSMenu(title: "Agent")
        agent.addItem(withTitle: "新对话", action: #selector(newConversation), keyEquivalent: "n")
        agent.addItem(withTitle: "显示主窗口", action: #selector(showMain), keyEquivalent: "0")
        agent.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "r")
        agent.addItem(withTitle: "Trace 观测台", action: #selector(openTraces), keyEquivalent: "t")
        agent.addItem(.separator())
        agent.addItem(withTitle: "导入现有项目…", action: #selector(importProject), keyEquivalent: "")
        agent.addItem(withTitle: "安装研究依赖（Phoenix / Futu）…", action: #selector(setup), keyEquivalent: "")
        agent.addItem(withTitle: "启用后台定时任务…", action: #selector(enableBackground), keyEquivalent: "")
        agent.addItem(withTitle: "停用后台定时任务…", action: #selector(disableBackground), keyEquivalent: "")
        let agentItem = NSMenuItem(); agentItem.submenu = agent; menu.addItem(agentItem)
        NSApp.mainMenu = menu
        for submenu in [application, agent] {
            for item in submenu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) && item.action != #selector(NSApplication.hide(_:)) {
                item.target = self
            }
        }
    }

    private func runtimeProcess(_ command: String, arguments: [String] = []) throws -> Process {
        let process = Process()
        process.executableURL = node
        process.arguments = [resources.appendingPathComponent("desktop/runtime-host.mjs").path, command, workspace.path, resources.path] + arguments
        process.currentDirectoryURL = workspace
        var environment = ProcessInfo.processInfo.environment
        // The app's own .env is authoritative, independent of a parent terminal.
        for key in environment.keys where key.hasSuffix("_API_KEY") || key.hasPrefix("PI_") || key.hasPrefix("FEISHU_") || key.hasPrefix("LIVERMORE_WEB_") {
            environment.removeValue(forKey: key)
        }
        environment["LIVERMORE_WORKSPACE"] = workspace.path
        environment["LIVERMORE_RESOURCE_ROOT"] = resources.path
        process.environment = environment
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: Data()) }
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()
        process.standardOutput = log
        process.standardError = log
        try process.run()
        try log.close()
        return process
    }

    private func startHost() {
        guard !quitting else { return }
        showProgress("正在启动本地 Agent…")
        do {
            // Clear an earlier ready marker before polling a new startup.
            try Data("{\"ready\":false}".utf8).write(to: workspace.appendingPathComponent("data/runtime/desktop-status.json"), options: .atomic)
            host = try runtimeProcess("start")
            hostStartedAt = Date()
            statusTimer?.invalidate()
            statusTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.pollStatus() }
        } catch { showError(error.localizedDescription) }
    }

    private func pollStatus() {
        let status = workspace.appendingPathComponent("data/runtime/desktop-status.json")
        guard let data = try? Data(contentsOf: status), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let error = value["error"] as? String {
            statusTimer?.invalidate(); showProgress(error); return
        }
        if value["ready"] as? Bool == true {
            statusTimer?.invalidate()
            webView.load(URLRequest(url: origin))
        } else if host?.isRunning == false || Date().timeIntervalSince(hostStartedAt) > 90 {
            statusTimer?.invalidate(); showProgress("本地服务未能启动。请从菜单打开运行日志，检查设置后重新连接。")
        }
    }

    private func stopHost() {
        statusTimer?.invalidate()
        guard let process = host, process.isRunning else { host = nil; return }
        process.terminate()
        process.waitUntilExit()
        host = nil
    }

    private func runOperation(_ command: String, arguments: [String] = [], completion: @escaping (Bool) -> Void) {
        guard !operationInProgress else { showError("另一项操作正在执行，请稍候。"); return }
        operationInProgress = true
        do {
            let process = try runtimeProcess(command, arguments: arguments)
            process.terminationHandler = { [weak self] completed in
                DispatchQueue.main.async {
                    self?.operationInProgress = false
                    let success = completed.terminationStatus == 0
                    if !success { self?.showError("操作未完成，请查看运行日志中的详细原因。") }
                    completion(success)
                }
            }
        } catch { operationInProgress = false; showError(error.localizedDescription); completion(false) }
    }

    private func showProgress(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{background:#f7f7f9;color:#222226;font:13px -apple-system;padding:20vh 12vw}h1{font-size:30px;font-weight:650;letter-spacing:-1px}p{line-height:1.8;margin:25px 0}small{color:#74747d;line-height:2}@media(prefers-color-scheme:dark){body{background:#1c1c1f;color:#eeeef2}small{color:#a1a1ab}}</style>
        <h1>Livermore</h1><p>\(escaped)</p><small>本地投资研究 · 对话 / 任务 / 持仓 / Trace<br>设置 ⌘, &nbsp; · &nbsp; 重新连接 ⌘R</small>
        """, baseURL: nil)
    }

    private func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "Livermore"; alert.informativeText = message; alert.runModal()
    }
    private func selectProject() -> URL? {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false; panel.message = "选择包含 .env 和 data/livermore.db 的原 Livermore 项目目录"
        return panel.runModal() == .OK ? panel.url : nil
    }
    @objc private func importProject() {
        guard let source = selectProject() else { return }
        let alert = NSAlert(); alert.messageText = "备份并导入现有项目？"
        alert.informativeText = "当前桌面版的数据、配置和 Skills 将完整备份后，再导入所选项目。原项目不会被修改。备份位于 Application Support 的 Livermore Backups 文件夹。"
        alert.addButton(withTitle: "备份并导入"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        stopHost(); showProgress("正在导入现有项目…")
        runOperation("import", arguments: [source.path, "--replace-existing"]) { [weak self] success in
            if success { self?.finishFirstLaunch() }
            else { self?.showProgress("导入未完成。请检查运行日志，并从 Agent 菜单重新导入。") }
        }
    }
    @objc private func showMain() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func newConversation() { showMain(); webView.evaluateJavaScript("window.livermoreUI?.newConversation()") }
    @objc private func toggleSidebar() { webView.evaluateJavaScript("window.livermoreUI?.toggleSidebar()") }
    @objc private func toggleInspector() { webView.evaluateJavaScript("window.livermoreUI?.toggleInspector()") }
    @objc private func navigateWorkspace(_ sender: NSMenuItem) {
        let names = ["chat", "portfolio", "tasks", "capabilities"]
        guard names.indices.contains(sender.tag) else { return }
        showMain(); webView.evaluateJavaScript("void window.livermoreUI?.setView('\(names[sender.tag])')")
    }
    private func applyAppearance(_ value: String) {
        NSApp.appearance = value == "dark" ? NSAppearance(named: .darkAqua) : value == "light" ? NSAppearance(named: .aqua) : nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == origin.host,
              message.frameInfo.securityOrigin.port == origin.port,
              let body = message.body as? [String: String] else { return }
        if body["type"] == "settings" { openSettings() }
        if body["type"] == "notification-status" { refreshNotificationPermission(request: false) }
        if body["type"] == "notification-permission" { refreshNotificationPermission(request: true, openSettings: true) }
        if body["type"] == "appearance", let value = body["value"], ["system", "light", "dark"].contains(value) {
            applyAppearance(value)
            if !isSmokeTest { UserDefaults.standard.set(value, forKey: "LivermoreAppearance") }
        }
    }
    private func refreshNotificationPermission(request: Bool, openSettings: Bool = false) {
        if isSmokeTest { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined && request {
                center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                    self.refreshNotificationPermission(request: false)
                }
                return
            }
            let status = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional ? "authorized" : settings.authorizationStatus == .denied ? "denied" : "not-determined"
            DispatchQueue.main.async {
                self.webView.evaluateJavaScript("window.livermoreUI?.notificationStatus('\(status)')")
                if openSettings && status == "denied", let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["alertId"] as? String, UUID(uuidString: id) != nil {
            DispatchQueue.main.async {
                self.showMain()
                self.pendingNotificationID = id
                self.openPendingNotification()
            }
        }
        completionHandler()
    }
    private func openPendingNotification() {
        guard webReady, let id = pendingNotificationID else { return }
        webView.evaluateJavaScript("!!window.livermoreUI && (window.livermoreUI.openNotification('\(id)'), true)") { result, _ in
            if result as? Bool == true { self.pendingNotificationID = nil }
        }
    }
    @objc private func reconnect() { guard !operationInProgress else { return }; webReady = false; stopHost(); startHost() }
    @objc private func openData() { NSWorkspace.shared.open(workspace) }
    @objc private func openLogs() { NSWorkspace.shared.open(logURL) }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Livermore", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0",
            .credits: NSAttributedString(string: "本地投资研究 Agent\n聊天、定时研究、持仓巡检与运行观测。")
        ])
    }
    @objc private func openTraces() { openTrace(URL(string: "http://127.0.0.1:6006")!) }
    @objc private func setup() {
        showProgress("正在安装研究依赖，首次下载 Python 与 Phoenix 可能需要几分钟…")
        runOperation("setup") { [weak self] success in
            if success { self?.showError("研究依赖已安装。请确保 Futu OpenD 已启动并登录。"); self?.reconnect() }
        }
    }
    @objc private func enableBackground() {
        let applicationPath = Bundle.main.bundleURL.path
        let userApplications = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/"
        guard applicationPath.hasPrefix("/Applications/") || applicationPath.hasPrefix(userApplications) else {
            showError("请先把 Livermore 拖入“应用程序”文件夹，再启用后台定时任务。")
            return
        }
        let alert = NSAlert(); alert.messageText = "启用后台定时研究？"
        alert.informativeText = "将注册 macOS 登录后运行的 Agent、飞书服务和定时研究任务。已有 Livermore 定时服务会切换到桌面版数据目录。关闭窗口或退出应用后任务仍会运行。请先把应用放入“应用程序”文件夹。"
        alert.addButton(withTitle: "启用"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        stopHost()
        runOperation("enable-background") { [weak self] _ in self?.startHost() }
    }
    @objc private func disableBackground() {
        let alert = NSAlert(); alert.messageText = "停用后台定时研究？"
        alert.informativeText = "退出应用后，研究任务和飞书对话将暂停；本地数据会保留。"
        alert.addButton(withTitle: "停用"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        stopHost()
        runOperation("disable-background") { [weak self] _ in self?.startHost() }
    }

    @objc private func openSettings() {
        if let existing = settingsWindow { existing.makeKeyAndOrderFront(nil); return }
        let settings = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 700),
                                styleMask: [.titled, .closable], backing: .buffered, defer: false)
        settings.title = "Livermore 设置"; settings.isReleasedWhenClosed = false
        let content = NSView(frame: settings.contentView!.bounds)
        let raw = (try? String(contentsOf: workspace.appendingPathComponent(".env"), encoding: .utf8)) ?? ""
        let values = Dictionary(raw.components(separatedBy: .newlines).compactMap { line -> (String, String)? in
            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, !line.trimmingCharacters(in: .whitespaces).hasPrefix("#") else { return nil }
            return (String(parts[0]).trimmingCharacters(in: .whitespaces), String(parts[1]).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")))
        }, uniquingKeysWith: { _, last in last })
        let toggle = NSButton(checkboxWithTitle: "使用 Cursor 订阅账号", target: self, action: #selector(toggleCursor))
        toggle.frame = NSRect(x: 24, y: 646, width: 290, height: 24)
        toggle.state = values["PI_PROVIDER"] == "cursor" ? .on : .off
        cursorToggle = toggle; content.addSubview(toggle)
        for (index, button) in [("登录 Cursor", #selector(loginCursor)), ("检查状态", #selector(checkCursor)), ("可用模型", #selector(cursorModels))].enumerated() {
            let action = NSButton(title: button.0, target: self, action: button.1)
            action.bezelStyle = .rounded; action.frame = NSRect(x: 24 + index * 150, y: 601, width: 138, height: 30)
            content.addSubview(action)
        }
        let cursorStatus = NSTextField(labelWithString: "Pi 原生工具调用 · 独立浏览器授权 · 不读取 IDE 或 CLI 凭据。")
        cursorStatus.frame = NSRect(x: 24, y: 573, width: 548, height: 22); cursorStatus.textColor = .secondaryLabelColor
        cursorStatusLabel = cursorStatus; content.addSubview(cursorStatus)
        let definitions = [("模型供应商", "PI_PROVIDER", "deepseek"), ("模型名称", "PI_MODEL", "deepseek-v4-flash"),
                           ("API 地址", "PI_BASE_URL", "https://api.deepseek.com"), ("模型 API Key", "PI_API_KEY", values["DEEPSEEK_API_KEY"] ?? ""),
                           ("飞书 App ID", "FEISHU_APP_ID", ""), ("飞书 App Secret", "FEISHU_APP_SECRET", ""),
                           ("Futu OpenD 地址", "FUTU_OPEND_HOST", "127.0.0.1"), ("Futu OpenD 端口", "FUTU_OPEND_PORT", "11111")]
        for (index, definition) in definitions.enumerated() {
            let (title, key, fallback) = definition
            let y = 520 - index * 48
            let label = NSTextField(labelWithString: title); label.frame = NSRect(x: 24, y: y + 3, width: 130, height: 20)
            let field: NSTextField = key.contains("KEY") || key.contains("SECRET") ? NSSecureTextField() : NSTextField()
            field.frame = NSRect(x: 164, y: y, width: 408, height: 28); field.stringValue = values[key].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
            settingsFields[key] = field; content.addSubview(label); content.addSubview(field)
        }
        apiSettingsBeforeCursor = ["PI_PROVIDER": values["PI_PROVIDER"] ?? "deepseek", "PI_MODEL": values["PI_MODEL"] ?? "deepseek-v4-flash", "PI_BASE_URL": values["PI_BASE_URL"] ?? ""]
        applyCursorState()
        let note = NSTextField(wrappingLabelWithString: "设置仅保存在本机 .env。后台模式下保存配置后，请再次选择“启用后台定时任务”以应用更改。")
        note.frame = NSRect(x: 24, y: 65, width: 548, height: 40); note.textColor = .secondaryLabelColor; content.addSubview(note)
        let save = NSButton(title: "保存并重新连接", target: self, action: #selector(saveSettings))
        save.bezelStyle = .rounded; save.frame = NSRect(x: 385, y: 20, width: 190, height: 32); content.addSubview(save)
        settings.contentView = content; settings.center(); settings.makeKeyAndOrderFront(nil); settingsWindow = settings
    }

    @objc private func toggleCursor() {
        if cursorToggle?.state == .on {
            for key in ["PI_PROVIDER", "PI_MODEL", "PI_BASE_URL"] { apiSettingsBeforeCursor[key] = settingsFields[key]?.stringValue ?? "" }
            settingsFields["PI_PROVIDER"]?.stringValue = "cursor"
            settingsFields["PI_MODEL"]?.stringValue = "auto"
            settingsFields["PI_BASE_URL"]?.stringValue = ""
        } else {
            for key in ["PI_PROVIDER", "PI_MODEL", "PI_BASE_URL"] { settingsFields[key]?.stringValue = apiSettingsBeforeCursor[key] ?? "" }
            if settingsFields["PI_PROVIDER"]?.stringValue == "cursor" { settingsFields["PI_PROVIDER"]?.stringValue = "deepseek"; settingsFields["PI_MODEL"]?.stringValue = "deepseek-v4-flash" }
        }
        applyCursorState()
    }
    private func applyCursorState() {
        let cursor = cursorToggle?.state == .on
        settingsFields["PI_PROVIDER"]?.isEditable = !cursor
        settingsFields["PI_BASE_URL"]?.isEnabled = !cursor
        settingsFields["PI_API_KEY"]?.isEnabled = !cursor
    }
    @objc private func loginCursor() {
        cursorStatusLabel?.stringValue = "正在打开 Cursor 官方登录页，请在浏览器中完成授权…"
        runOperation("cursor", arguments: ["login"]) { [weak self] success in
            self?.cursorStatusLabel?.stringValue = success ? "Cursor 已登录。勾选订阅模式、选择模型并保存即可使用。" : "登录未完成，请检查运行日志。"
        }
    }
    @objc private func checkCursor() {
        cursorStatusLabel?.stringValue = "正在检查 Cursor 登录状态…"
        runOperation("cursor", arguments: ["status"]) { [weak self] _ in self?.showCursorResult("status") }
    }
    @objc private func cursorModels() {
        cursorStatusLabel?.stringValue = "正在获取 Cursor 账号可用模型…"
        runOperation("cursor", arguments: ["models"]) { [weak self] _ in self?.showCursorResult("models") }
    }
    private func showCursorResult(_ command: String) {
        guard let data = try? Data(contentsOf: workspace.appendingPathComponent("data/runtime/cursor-\(command).json")),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let output = (result["output"] as? String) ?? (result["error"] as? String) ?? "请查看运行日志。"
        cursorStatusLabel?.stringValue = command == "status" ? String(output.prefix(100)) : "选择一个可用模型 ID 填入“模型名称”，然后保存。"
        if command == "models" {
            let alert = NSAlert(); alert.messageText = "Cursor 可用模型"; alert.informativeText = "选择模型列表中的 ID，或使用 auto 让 Cursor 自动选择。"
            alert.addButton(withTitle: "使用模型"); alert.addButton(withTitle: "取消")
            let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 44, width: 500, height: 256))
            scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
            let text = NSTextView(frame: scroll.bounds); text.string = output; text.isEditable = false
            text.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular); text.isVerticallyResizable = true
            scroll.documentView = text; accessory.addSubview(scroll)
            let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 500, height: 28))
            input.placeholderString = "输入模型 ID，例如 auto"; input.stringValue = "auto"
            accessory.addSubview(input); alert.accessoryView = accessory
            if alert.runModal() == .alertFirstButtonReturn && !input.stringValue.trimmingCharacters(in: .whitespaces).isEmpty {
                if cursorToggle?.state != .on { cursorToggle?.state = .on; toggleCursor() }
                settingsFields["PI_MODEL"]?.stringValue = input.stringValue.trimmingCharacters(in: .whitespaces)
            }
        }
    }

    @objc private func saveSettings() {
        let filename = workspace.appendingPathComponent(".env")
        do {
            var lines = try String(contentsOf: filename, encoding: .utf8).components(separatedBy: .newlines)
            for (key, field) in settingsFields {
                let serialized = try JSONSerialization.data(withJSONObject: field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), options: [.fragmentsAllowed, .withoutEscapingSlashes])
                let replacement = "\(key)=\(String(decoding: serialized, as: UTF8.self))"
                lines.removeAll { $0.split(separator: "=", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces) == key }
                lines.append(replacement)
            }
            try lines.joined(separator: "\n").write(to: filename, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: filename.path)
            settingsWindow?.close(); settingsWindow = nil; settingsFields.removeAll(); reconnect()
        } catch { showError(error.localizedDescription) }
    }

    private func openTrace(_ url: URL) {
        if lastTraceURL == url && Date().timeIntervalSince(lastTraceOpenedAt) < 1 { return }
        lastTraceURL = url; lastTraceOpenedAt = Date()
        let view = WKWebView(); view.navigationDelegate = self; view.uiDelegate = self
        let trace = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 860),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        trace.title = "Livermore · Trace"; trace.contentView = view; trace.isReleasedWhenClosed = false
        trace.center(); trace.makeKeyAndOrderFront(nil); traceWindows.append(trace); view.load(URLRequest(url: url))
    }
    private func routeLink(_ url: URL) {
        if ["127.0.0.1", "localhost"].contains(url.host ?? ""), url.port == 6006 { openTrace(url) }
        else if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if webView === self.webView, ["127.0.0.1", "localhost"].contains(url.host ?? ""), url.port == 6006 {
            decisionHandler(.cancel); openTrace(url); return
        }
        let local = ["127.0.0.1", "localhost"].contains(url.host ?? "") && [4311, 6006].contains(url.port ?? -1)
        if local || url.scheme == "about" { decisionHandler(.allow) }
        else { decisionHandler(.cancel); routeLink(url) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { routeLink(url) }; return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Livermore"; alert.informativeText = message
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        showError(message); completionHandler()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView, webView.url?.host == origin.host {
            webReady = true
            openPendingNotification()
        }
        guard !smokeCaptured, webView === self.webView, webView.url?.host == origin.host,
              let output = ProcessInfo.processInfo.environment["LIVERMORE_DESKTOP_SMOKE_OUTPUT"] else { return }
        smokeCaptured = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            self.captureVisualCase(output: output, index: 0, results: [])
        }
    }

    // Opt-in native visual regression checks. An ephemeral WebKit store and a temporary
    // backend workspace keep screenshots and appearance tests away from user data.
    private func captureVisualCase(output: String, index: Int, results: [[String: Any]]) {
        let cases: [(String, Int, Int, String, String, String)] = [
            ("default-light", 1280, 800, "light", "chat", ""),
            ("default-dark", 1280, 800, "dark", "chat", ""),
            ("compact-light", 1000, 640, "light", "chat", ""),
            ("compact-dark", 1000, 640, "dark", "chat", ""),
            ("wide-dark", 1920, 1080, "dark", "chat", ""),
            ("wide-light", 1920, 1080, "light", "chat", ""),
            ("portfolio-dark", 1280, 800, "dark", "portfolio", ""),
            ("portfolio-compact", 1000, 640, "light", "portfolio", ""),
            ("tasks-light", 1280, 800, "light", "tasks", ""),
            ("capabilities-dark", 1280, 800, "dark", "capabilities", ""),
            ("inspector-compact", 1000, 640, "dark", "chat", "window.livermoreUI.toggleInspector();"),
            ("collapsed-light", 1000, 640, "light", "chat", "window.livermoreUI.toggleSidebar();window.livermoreUI.toggleInspector();"),
            ("long-chat-dark", 1000, 640, "dark", "chat", "document.querySelector('#welcome').hidden=true;for(let i=0;i<20;i++){const m=document.createElement('article');m.className='message assistant';m.innerHTML='<div class=message-role>Livermore</div><div class=message-body><p>界面回归测试：检查长对话独立滚动和输入框位置，不是真实研究结论。</p></div>';document.querySelector('#messages').append(m);}const p=document.querySelector('#prompt');p.value=Array(20).fill('测试多行输入').join('\\n');p.dispatchEvent(new Event('input'));"),
            ("report-dark", 1280, 800, "dark", "tasks", "document.querySelector('[data-run-id]')?.click();"),
            ("system-appearance", 1280, 800, "system", "chat", "document.querySelector('#run-dialog').close();window.livermoreUI.newConversation();"),
            ("inbox-dark", 1280, 800, "dark", "chat", "document.body.dataset.inspector='open';"),
            ("notification-detail", 1280, 800, "dark", "chat", "document.querySelector('[data-notification-id]')?.click();"),
            ("task-config-dark", 1280, 800, "dark", "tasks", "document.querySelector('#notification-dialog').close();void window.livermoreUI.openTaskConfig('portfolio-risk-check');"),
            ("task-config-save", 1280, 800, "dark", "tasks", "document.querySelector('#task-enabled').checked=false;document.querySelector('#task-prompt').value+='\\n界面保存验证：强调组合风险。';document.querySelector('#task-config-form').requestSubmit();"),
            ("custom-task-new", 1280, 800, "dark", "tasks", "void window.livermoreUI.openNewTaskConfig();"),
            ("custom-task-saved", 1280, 800, "dark", "tasks", "document.querySelector('#task-name').value='界面测试自定义研究';document.querySelector('#task-config-form').requestSubmit();"),
            ("history-open", 1280, 800, "dark", "chat", "document.body.dataset.sidebar='expanded';void window.livermoreUI.openChat(document.querySelector('[data-chat-id]').dataset.chatId);"),
            ("history-new", 1280, 800, "dark", "chat", "window.livermoreUI.newConversation();"),
            ("history-reopen", 1280, 800, "dark", "chat", "void window.livermoreUI.openChat(document.querySelector('[data-chat-id]').dataset.chatId);"),
            ("settings-dark", 1280, 800, "dark", "chat", "document.querySelector('#native-settings').click();")
        ]
        guard index < cases.count else {
            let value: [String: Any] = ["tasks": results.first?["tasks"] ?? 0, "composer": true, "cases": results]
            if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: output + ".json"))
            }
            NSApp.terminate(nil); return
        }
        let (name, width, height, theme, view, action) = cases[index]
        window.setContentSize(NSSize(width: width, height: height))
        webView.evaluateJavaScript("window.livermoreUI.setAppearance('\(theme)');void window.livermoreUI.setView('\(view)');\(action)") { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                let script = """
                JSON.stringify((()=>{
                  const rect=s=>{const e=document.querySelector(s);if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
                  return {historyCount:document.querySelectorAll("[data-chat-id]").length,visibleChatMessages:document.querySelectorAll("#messages .message").length,customNameVisible:!!rect("#task-name-field"),notificationCards:document.querySelectorAll(".notification-card").length,inboxHasTasks:!!document.querySelector(".notification-rail #tasks"),notificationDialog:rect("#notification-dialog[open]"),taskEditor:rect("#task-config-dialog[open]"),taskPromptLoaded:document.querySelector("#task-prompt").value.includes("持仓风险巡检"),taskScheduleText:document.querySelector("#tasks").textContent,title:document.title,tasks:document.querySelectorAll('#tasks > *').length,theme:document.documentElement.dataset.theme,view:document.body.dataset.view,viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},frame:rect('.app-frame'),composer:rect('#composer'),sidebar:rect('.sidebar'),inspector:rect('.task-rail'),panel:rect('.workspace-panel[open]'),report:rect('#run-dialog[open]'),positions:document.querySelectorAll('#portfolio-rows tr').length,selected:document.querySelector('[aria-current="page"]')?.dataset.viewTarget,appearance:document.querySelector('#appearance').value,systemTheme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',messagesScrollable:document.querySelector('#messages').scrollHeight>document.querySelector('#messages').clientHeight,inputHeight:document.querySelector('#prompt').clientHeight,bridge:!!window.webkit?.messageHandlers?.livermore,reportTables:document.querySelectorAll('#dialog-report table').length,settingsVisible:document.body.classList.contains('is-desktop')};
                })())
                """
                self.webView.evaluateJavaScript(script) { result, error in
                    var record = ((result as? String)?.data(using: .utf8)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? ["error": error?.localizedDescription ?? "Evaluation failed"]
                    record["name"] = name
                    record["nativeAppearance"] = NSApp.appearance?.name.rawValue ?? "system"
                    if name == "settings-dark", let content = self.settingsWindow?.contentView {
                        record["settingsAppearance"] = content.effectiveAppearance.name.rawValue
                        if let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) {
                            content.cacheDisplay(in: content.bounds, to: bitmap)
                            if let png = bitmap.representation(using: .png, properties: [:]) {
                                try? png.write(to: URL(fileURLWithPath: output + "-native-settings-dark.png"))
                            }
                        }
                    }
                    let next = results + [record]
                    self.webView.takeSnapshot(with: nil) { image, _ in
                        if let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                           let png = bitmap.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: output + "-" + name + ".png"))
                            if index == 0 { try? png.write(to: URL(fileURLWithPath: output + ".png")) }
                        }
                        self.captureVisualCase(output: output, index: index + 1, results: next)
                    }
                }
            }
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showMain(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { quitting = true; stopHost() }
}
