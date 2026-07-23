import Foundation
import TelemetryDeck
import os

/// Opt-in error/crash signal reporting via TelemetryDeck. Disabled unless the
/// user turns on Settings → Diagnostics → Help Improve BlissfulScribe.
final class DiagnosticsService {
    static let shared = DiagnosticsService()

    private var isStarted = false
    private let logger = Logger(subsystem: "com.goodtogreatmind.blissfulscribe", category: "Diagnostics")

    private init() {}

    /// Call once at app launch, from `init()` (not `.onAppear`), only when the user has opted in.
    func start() {
        guard !isStarted else { return }
        guard let appID = Bundle.main.object(forInfoDictionaryKey: "TelemetryDeckAppID") as? String,
              !appID.isEmpty, !appID.hasPrefix("YOUR-") else {
            logger.warning("TelemetryDeckAppID not configured — diagnostics disabled")
            return
        }

        TelemetryDeck.initialize(config: TelemetryDeck.Config(appID: appID))
        isStarted = true
        track("App.launched")
    }

    func track(_ signal: String, parameters: [String: String] = [:]) {
        guard isStarted else { return }
        TelemetryDeck.signal(signal, parameters: parameters)
    }

    /// Maps a thrown error to a stable, privacy-safe category — never the
    /// localized message, which could echo transcribed user speech.
    static func errorCategory(for error: Error) -> String {
        if let engineError = error as? BlissfulScribeEngineError { return "BlissfulScribeEngineError.\(engineError)" }
        if let licenseError = error as? LicenseError { return "LicenseError.\(licenseError)" }
        return String(describing: type(of: error))
    }
}
