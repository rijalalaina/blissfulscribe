import Foundation
import SwiftData
import LLMkit

struct DeepgramProvider: CloudProvider {
    let modelProvider: ModelProvider = .deepgram
    let providerKey: String = "Deepgram"
    let languageCodes: [String]? = [
        "ar", "be", "bg", "bn", "bs", "ca", "cs", "da", "de", "el",
        "en", "es", "et", "fa", "fi", "fr", "he", "hi", "hr", "hu",
        "id", "it", "ja", "kn", "ko", "lt", "lv", "mk", "mr", "ms",
        "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv",
        "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "zh"
    ]
    let includesAutoDetect: Bool = true

    var models: [CloudModel] {[
        CloudModel(
            name: "nova-3",
            displayName: "Nova 3",
            description: "Deepgram's latest Nova 3 model for fast, accurate transcription",
            provider: .deepgram,
            speed: 0.99,
            accuracy: 0.96,
            isMultilingual: true,
            supportsStreaming: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: true, provider: .deepgram)
        ),
        CloudModel(
            name: "nova-3-medical",
            displayName: "Nova 3 Medical",
            description: "Specialized medical transcription model optimized for clinical environments",
            provider: .deepgram,
            speed: 0.99,
            accuracy: 0.96,
            isMultilingual: false,
            supportsStreaming: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: false, provider: .deepgram)
        )
    ]}

    func transcribe(audioData: Data, fileName: String, apiKey: String, model: String, language: String?, prompt: String?, customVocabulary: [String]) async throws -> String {
        return try await DeepgramClient.transcribe(
            audioData: audioData,
            apiKey: apiKey,
            model: model,
            language: language,
            smartFormat: true,
            punctuate: true,
            paragraphs: true,
            customVocabulary: customVocabulary,
            // Raw binary upload (no base64) — scales timeout with file size.
            // 90 s base + 30 s per 5 MB, capped at 300 s.
            timeout: min(300, 90 + Double(audioData.count / 5_000_000) * 30)
        )
    }

    func makeStreamingProvider(modelContext: ModelContext) -> (any StreamingTranscriptionProvider)? {
        DeepgramStreamingProvider(modelContext: modelContext)
    }

    func verifyAPIKey(_ key: String) async -> (isValid: Bool, errorMessage: String?) {
        return await DeepgramClient.verifyAPIKey(key)
    }
}
