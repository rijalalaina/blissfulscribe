import Foundation
import SwiftData
import LLMkit

struct GeminiProvider: CloudProvider {
    let modelProvider: ModelProvider = .gemini
    let providerKey: String = "Gemini"
    let languageCodes: [String]? = nil
    let includesAutoDetect: Bool = false

    var models: [CloudModel] {[
        CloudModel(
            name: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            description: "Google's advanced model with high-quality transcription capabilities",
            provider: .gemini,
            speed: 0.7,
            accuracy: 0.97,
            isMultilingual: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: true, provider: .gemini)
        ),
        CloudModel(
            name: "gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            description: "Google's optimized model for low-latency transcription",
            provider: .gemini,
            speed: 0.9,
            accuracy: 0.95,
            isMultilingual: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: true, provider: .gemini)
        ),
        CloudModel(
            name: "gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro",
            description: "Google's latest model with enhanced transcription capabilities",
            provider: .gemini,
            speed: 0.75,
            accuracy: 0.97,
            isMultilingual: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: true, provider: .gemini)
        ),
        CloudModel(
            name: "gemini-3-flash-preview",
            displayName: "Gemini 3 Flash",
            description: "Google's newest fast model combining intelligence with superior speed",
            provider: .gemini,
            speed: 0.92,
            accuracy: 0.95,
            isMultilingual: true,
            supportedLanguages: LanguageDictionary.forProvider(isMultilingual: true, provider: .gemini)
        )
    ]}

    // Maximum bytes to send in a single Gemini request (~18 MB to stay under the 20 MB API limit).
    private static let chunkByteLimit = 18_000_000

    func transcribe(audioData: Data, fileName: String, apiKey: String, model: String, language: String?, prompt: String?, customVocabulary: [String]) async throws -> String {
        // Scale timeout with file size: 120 s base + 60 s per 10 MB, capped at 600 s.
        let timeout: TimeInterval = min(600, 120 + Double(audioData.count / 10_000_000) * 60)

        // If the audio fits in one request, send directly.
        if audioData.count <= Self.chunkByteLimit {
            return try await GeminiTranscriptionClient.transcribe(
                audioData: audioData,
                apiKey: apiKey,
                model: model,
                timeout: timeout
            )
        }

        // For large files: split into ~18 MB WAV chunks and concatenate results.
        // Chunks overlap by ~1 s of audio (16 000 Hz × 2 bytes × 1 s = 32 000 bytes) to
        // avoid cutting words at boundaries.
        let overlapBytes = 32_000
        var chunks: [Data] = []
        var offset = 0
        while offset < audioData.count {
            let end = min(offset + Self.chunkByteLimit, audioData.count)
            chunks.append(audioData[offset..<end])
            offset = max(0, end - overlapBytes)
            if offset >= audioData.count { break }
        }

        var parts: [String] = []
        for (i, chunk) in chunks.enumerated() {
            let chunkTimeout: TimeInterval = min(300, 120 + Double(chunk.count / 10_000_000) * 60)
            let text = try await GeminiTranscriptionClient.transcribe(
                audioData: chunk,
                apiKey: apiKey,
                model: model,
                timeout: chunkTimeout
            )
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { parts.append(trimmed) }
            // Brief pause between chunks to avoid rate-limiting
            if i < chunks.count - 1 { try await Task.sleep(nanoseconds: 500_000_000) }
        }
        return parts.joined(separator: " ")
    }

    func makeStreamingProvider(modelContext: ModelContext) -> (any StreamingTranscriptionProvider)? { nil }

    func verifyAPIKey(_ key: String) async -> (isValid: Bool, errorMessage: String?) {
        return await GeminiTranscriptionClient.verifyAPIKey(key)
    }
}
