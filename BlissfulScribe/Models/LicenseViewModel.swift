import Foundation
import AppKit
import Combine
import os

@MainActor
class LicenseViewModel: ObservableObject {
    enum LicenseState: Equatable {
        case unlicensed
        case trial(remaining: Int)   // remaining = free transcriptions left
        case trialExpired
        case licensed
    }

    @Published private(set) var licenseState: LicenseState = .unlicensed
    @Published var licenseKey: String = ""
    @Published var isValidating = false
    @Published var validationMessage: String?
    @Published var validationSuccess: Bool = false
    @Published private(set) var activationsLimit: Int = 0

    static let freeTranscriptionLimit = 20
    private let polarService = BlissfulScribeLicenceService()
    private let logger = Logger(subsystem: "com.goodtogreatmind.blissfulscribe", category: "LicenseViewModel")
    private let userDefaults = UserDefaults.standard
    private let licenseManager = LicenseManager.shared
    private var cancellables = Set<AnyCancellable>()

    init() {
        loadLicenseState()

        // Count every successfully completed transcription against the free tier.
        // .transcriptionCompleted is posted by TranscriptionPipeline for every
        // transcription regardless of output mode (paste, respond, custom command).
        NotificationCenter.default.publisher(for: .transcriptionCompleted)
            .receive(on: DispatchQueue.main)
            .compactMap { $0.object as? Transcription }
            .filter { $0.transcriptionStatus == TranscriptionStatus.completed.rawValue }
            .sink { [weak self] _ in
                guard let self, !self.isLicensed else { return }
                self.licenseManager.incrementTranscriptionsUsed()
                UserDefaults.standard.synchronize()
                self.refreshTrialState()
            }
            .store(in: &cancellables)

        // Also refresh state on explicit license change events.
        NotificationCenter.default.publisher(for: .licenseStatusChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self, !self.isLicensed else { return }
                self.refreshTrialState()
            }
            .store(in: &cancellables)
    }

    func startTrial() {
        licenseManager.startTrialIfNeeded()
        refreshTrialState()
        NotificationCenter.default.post(name: .licenseStatusChanged, object: nil)
        requestLicenseCelebration()
    }

    /// Called by TranscriptionDelivery after each successful delivery.
    func recordTranscriptionUsed() {
        guard !isLicensed else { return }
        licenseManager.incrementTranscriptionsUsed()
        refreshTrialState()
        NotificationCenter.default.post(name: .licenseStatusChanged, object: nil)
    }

    /// Static check used by the engine to gate recording without creating a new instance.
    static func canCurrentlyUseApp() -> Bool {
        if LicenseManager.shared.licenseKey != nil { return true }
        return LicenseManager.shared.transcriptionsUsed < freeTranscriptionLimit
    }

    private func loadLicenseState() {
        // Check for existing license key first
        if let storedLicenseKey = licenseManager.licenseKey {
            self.licenseKey = storedLicenseKey
            if licenseManager.activationId != nil || !userDefaults.bool(forKey: "BlissfulScribeLicenseRequiresActivation") {
                licenseState = .licensed
                activationsLimit = userDefaults.activationsLimit
                return
            }
        }
        // Load free-transcription-based trial state
        refreshTrialState()
    }

    var isLicensed: Bool {
        if case .licensed = licenseState {
            return true
        }

        return false
    }

    private func setUnlicensedState() {
        licenseState = .unlicensed
    }

    private func refreshTrialState() {
        let used = licenseManager.transcriptionsUsed
        let limit = LicenseViewModel.freeTranscriptionLimit
        if used >= limit {
            licenseState = .trialExpired
        } else {
            licenseState = .trial(remaining: limit - used)
        }
    }
    
    var canUseApp: Bool {
        switch licenseState {
        case .licensed, .trial:
            return true
        case .unlicensed, .trialExpired:
            return false
        }
    }

    var usageRestrictionMessage: String? {
        // No longer used for nagware — blocking is done at the recording gate.
        return nil
    }
    
    func openPurchaseLink() {
        if let url = URL(string: "https://scribe.blissfulplan.com/buy") {
            NSWorkspace.shared.open(url)
        }
    }
    
    func validateLicense() async {
        let normalizedLicenseKey = licenseKey.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedLicenseKey.isEmpty else {
            validationSuccess = false
            validationMessage = String(localized: "Please enter a license key")
            return
        }
        
        licenseKey = normalizedLicenseKey
        isValidating = true
        validationSuccess = false
        validationMessage = nil
        
        do {
            // First, check if the license is valid and if it requires activation
            let licenseCheck = try await polarService.checkLicenseRequiresActivation(normalizedLicenseKey)
            
            if !licenseCheck.isValid {
                validationSuccess = false
                validationMessage = String(localized: "This license has been revoked or disabled. Please contact support.")
                isValidating = false
                return
            }
            
            // Handle based on whether activation is required
            if licenseCheck.requiresActivation {
                // If we already have an activation ID, try to validate with it first
                if let existingActivationId = licenseManager.activationId {
                    let isValid = (try? await polarService.validateLicenseKeyWithActivation(normalizedLicenseKey, activationId: existingActivationId)) ?? false
                    if isValid {
                        let limit = licenseCheck.activationsLimit ?? userDefaults.activationsLimit
                        licenseManager.licenseKey = normalizedLicenseKey
                        userDefaults.set(true, forKey: "BlissfulScribeLicenseRequiresActivation")
                        activationsLimit = limit
                        userDefaults.activationsLimit = limit
                        completeSuccessfulValidation(message: String(localized: "License activated successfully!"))
                        isValidating = false
                        return
                    }
                    // Activation is stale (deleted from portal) — clear it and create a new one
                    licenseManager.activationId = nil
                }

                // Need to create a new activation
                let (newActivationId, limit) = try await polarService.activateLicenseKey(normalizedLicenseKey)

                // Store activation details
                licenseManager.licenseKey = normalizedLicenseKey
                licenseManager.activationId = newActivationId
                userDefaults.set(true, forKey: "BlissfulScribeLicenseRequiresActivation")
                self.activationsLimit = limit
                userDefaults.activationsLimit = limit

            } else {
                // This license doesn't require activation (unlimited devices)
                licenseManager.licenseKey = normalizedLicenseKey
                licenseManager.activationId = nil
                userDefaults.set(false, forKey: "BlissfulScribeLicenseRequiresActivation")
                self.activationsLimit = licenseCheck.activationsLimit ?? 0
                userDefaults.activationsLimit = licenseCheck.activationsLimit ?? 0

                // Update the license state for unlimited license
                completeSuccessfulValidation(message: String(localized: "License validated successfully!"))
                isValidating = false
                return
            }
            
            // Update the license state for activated license
            completeSuccessfulValidation(message: String(localized: "License activated successfully!"))

        } catch LicenseError.keyNotFound {
            validationSuccess = false
            validationMessage = String(localized: "License key not found. Please double-check your key and try again.")
        } catch LicenseError.activationLimitReached {
            validationSuccess = false
            validationMessage = String(localized: "This license has reached its device limit. Visit the License Management Portal to deactivate other devices.")
        } catch LicenseError.serverError(let code) {
            validationSuccess = false
            validationMessage = String(
                format: String(localized: "Server error (%d). Please try again later or contact support."),
                code
            )
        } catch let urlError as URLError {
            validationSuccess = false
            logger.error("🔑 License network error: \(urlError, privacy: .public)")
            validationMessage = String(localized: "Could not reach the server. Please check your internet connection and try again.")
        } catch {
            validationSuccess = false
            logger.error("🔑 Unexpected license error: \(error, privacy: .public)")
            validationMessage = String(
                format: String(localized: "An unexpected error occurred. Please try again or contact support at %@"),
                "support@scribe.blissfulplan.com"
            )
        }
        
        isValidating = false
    }

    private func completeSuccessfulValidation(message: String) {
        licenseState = .licensed
        validationSuccess = true
        validationMessage = message
        NotificationCenter.default.post(name: .licenseStatusChanged, object: nil)
        requestLicenseCelebration()
    }

    private func requestLicenseCelebration() {
        NotificationCenter.default.post(name: .licenseCelebrationRequested, object: nil)
    }
    
    func removeLicense() {
        // Remove only the license credentials. Trial history stays intact.
        licenseManager.removeStoredLicense()

        // Reset UserDefaults flags
        userDefaults.set(false, forKey: "BlissfulScribeLicenseRequiresActivation")
        userDefaults.activationsLimit = 0

        licenseKey = ""
        validationMessage = nil
        validationSuccess = false
        activationsLimit = 0
        loadLicenseState()
        NotificationCenter.default.post(name: .licenseStatusChanged, object: nil)
    }
}


// UserDefaults extension for non-sensitive license settings
extension UserDefaults {
    var activationsLimit: Int {
        get { integer(forKey: "BlissfulScribeActivationsLimit") }
        set { set(newValue, forKey: "BlissfulScribeActivationsLimit") }
    }
}
