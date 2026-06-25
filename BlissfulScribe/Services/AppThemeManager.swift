import AppKit

enum AppTheme: String, CaseIterable {
    case system = "system"
    case light  = "light"
    case dark   = "dark"

    static let userDefaultsKey = "BlissfulScribeAppTheme"

    var displayName: String {
        switch self {
        case .system: return "System"
        case .light:  return "Light"
        case .dark:   return "Dark"
        }
    }

    func apply() {
        switch self {
        case .light:  NSApp.appearance = NSAppearance(named: .aqua)
        case .dark:   NSApp.appearance = NSAppearance(named: .darkAqua)
        case .system: NSApp.appearance = nil
        }
    }

    static func applyStored() {
        let raw = UserDefaults.standard.string(forKey: userDefaultsKey) ?? "system"
        (AppTheme(rawValue: raw) ?? .system).apply()
    }
}
