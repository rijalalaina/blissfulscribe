import Foundation
import os

/// Manages license data using secure Keychain storage (non-syncable, device-local).
final class LicenseManager {
    static let shared = LicenseManager()

    private let keychain = KeychainService.shared
    private let logger = Logger(subsystem: "com.goodtogreatmind.blissfulscribe", category: "LicenseManager")

    private let licenseKeyIdentifier = "blissfulscribe.license.key"
    private let trialStartDateIdentifier = "blissfulscribe.license.trialStartDate"
    private let activationIdIdentifier = "blissfulscribe.license.activationId"

    private init() {}

    // MARK: - License Key

    var licenseKey: String? {
        get { keychain.getString(forKey: licenseKeyIdentifier, syncable: false) }
        set {
            if let value = newValue {
                keychain.save(value, forKey: licenseKeyIdentifier, syncable: false)
            } else {
                keychain.delete(forKey: licenseKeyIdentifier, syncable: false)
            }
        }
    }

    // MARK: - Trial Start Date

    private(set) var trialStartDate: Date? {
        get {
            guard let data = keychain.getData(forKey: trialStartDateIdentifier, syncable: false),
                  let timestamp = String(data: data, encoding: .utf8),
                  let timeInterval = Double(timestamp) else {
                return nil
            }
            return Date(timeIntervalSince1970: timeInterval)
        }
        set {
            if let date = newValue {
                let timestamp = String(date.timeIntervalSince1970)
                keychain.save(timestamp, forKey: trialStartDateIdentifier, syncable: false)
            } else {
                keychain.delete(forKey: trialStartDateIdentifier, syncable: false)
            }
        }
    }

    @discardableResult
    func startTrialIfNeeded() -> Bool {
        guard trialStartDate == nil else {
            return false
        }

        trialStartDate = Date()
        return true
    }

    // MARK: - Activation ID

    var activationId: String? {
        get { keychain.getString(forKey: activationIdIdentifier, syncable: false) }
        set {
            if let value = newValue {
                keychain.save(value, forKey: activationIdIdentifier, syncable: false)
            } else {
                keychain.delete(forKey: activationIdIdentifier, syncable: false)
            }
        }
    }

    // MARK: - Free Transcription Counter

    private let transcriptionsUsedKey = "BlissfulScribeTranscriptionsUsed"

    var transcriptionsUsed: Int {
        get { UserDefaults.standard.integer(forKey: transcriptionsUsedKey) }
        set { UserDefaults.standard.set(newValue, forKey: transcriptionsUsedKey) }
    }

    func incrementTranscriptionsUsed() {
        transcriptionsUsed += 1
    }

    // MARK: - License management

    func removeStoredLicense() {
        licenseKey = nil
        activationId = nil
    }

    /// Removes all license data including trial counter.
    func removeAll() {
        licenseKey = nil
        trialStartDate = nil
        activationId = nil
        transcriptionsUsed = 0
    }
}
