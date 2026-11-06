import AppKit
import UserNotifications

// The same signed app executable can deliver from a launchd worker without opening
// a second window. It never requests permission from a background process.
enum NotificationHelper {
    static func run() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count <= 16_384,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = input["id"] as? String, UUID(uuidString: id) != nil,
              let title = input["title"] as? String, let body = input["body"] as? String else {
            finish(false, "通知数据无效。")
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                finish(false, "macOS 通知未获授权；请在 Livermore 消息栏开启通知。消息已保存在本地。")
            }
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(160))
            content.subtitle = input["severity"] as? String == "critical" ? "高优先级风险提醒" : "投资研究消息"
            content.body = String(body.prefix(360))
            content.sound = .default
            content.threadIdentifier = "livermore-research"
            content.userInfo = ["alertId": id]
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
                if let error { finish(false, error.localizedDescription) }
                finish(true, nil)
            }
        }
        NSApplication.shared.run()
    }
    private static func finish(_ ok: Bool, _ error: String?) -> Never {
        var result: [String: Any] = ["ok": ok]
        if let error { result["error"] = error }
        let data = try! JSONSerialization.data(withJSONObject: result)
        FileHandle.standardOutput.write(data)
        exit(ok ? 0 : 1)
    }
}
