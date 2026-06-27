import AppIntents
import Foundation
import SwiftData

struct GetLastTranscriptionIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Last BlissfulScribe Transcription"
    static var description = IntentDescription("Returns the most recent BlissfulScribe transcription text.")

    static var openAppWhenRun: Bool = false

    @Parameter(title: "Prefer Enhanced", description: "Return the AI-enhanced version if available.", default: true)
    var preferEnhanced: Bool

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let container = try ModelContainer(for: Transcription.self)
        let context = container.mainContext

        guard let last = LastTranscriptionService.getLastTranscription(from: context) else {
            return .result(value: "", dialog: "No transcriptions found.")
        }

        let text: String
        if preferEnhanced, let enhanced = last.enhancedText, !enhanced.isEmpty {
            text = enhanced
        } else {
            text = last.text ?? ""
        }

        return .result(value: text, dialog: IntentDialog(stringLiteral: text.isEmpty ? "No text found." : text))
    }
}
