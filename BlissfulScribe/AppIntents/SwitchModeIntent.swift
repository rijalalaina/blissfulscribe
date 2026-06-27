import AppIntents
import Foundation

struct SwitchModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Switch BlissfulScribe Mode"
    static var description = IntentDescription("Switch to a specific BlissfulScribe mode by name.")

    static var openAppWhenRun: Bool = false

    @Parameter(title: "Mode Name", description: "The name of the mode to activate.")
    var modeName: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let manager = ModeManager.shared
        let trimmed = modeName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        if let match = manager.configurations.first(where: { $0.name.lowercased() == trimmed }) {
            manager.setActiveConfiguration(match)
            return .result(dialog: "Switched to \(match.name)")
        }

        // Partial match fallback
        if let match = manager.configurations.first(where: { $0.name.lowercased().contains(trimmed) }) {
            manager.setActiveConfiguration(match)
            return .result(dialog: "Switched to \(match.name)")
        }

        let available = manager.configurations.map(\.name).joined(separator: ", ")
        throw IntentError.modeNotFound(modeName, available: available)
    }
}

extension IntentError {
    static func modeNotFound(_ name: String, available: String) -> IntentError {
        return .serviceNotAvailable
    }
}
