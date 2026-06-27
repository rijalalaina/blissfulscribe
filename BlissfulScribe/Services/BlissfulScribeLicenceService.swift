import Foundation
import os

// ── Errors (shared, same as before) ─────────────────────────────────────────
// LicenseError is already defined in PolarService.swift — kept identical.

class BlissfulScribeLicenceService {

    // ── Configuration ────────────────────────────────────────────────────────
    // Replace with your actual Worker URL once deployed:
    //   wrangler deploy  →  https://blissfulscribe-licence.<account>.workers.dev
    // Or a custom route, e.g. https://licence.blissfulplan.com
    private let baseURL = "https://blissfulscribe-licence.goodtogreatmind.workers.dev"

    // Matches WORKER_API_KEY secret set on the Cloudflare Worker.
    // XOR-obfuscated so the key is not recoverable via `strings(1)`.
    private var apiKey: String {
        let x: [UInt8] = [0x42, 0x53, 0x2e, 0x6b, 0x4c, 0x9a, 0x7f, 0x3d]
        let ob: [UInt8] = [
            0x21, 0x37, 0x17, 0x53, 0x7d, 0xad, 0x4d, 0x5b, 0x7b, 0x67, 0x18, 0x5b, 0x28, 0xfe, 0x19, 0x09,
            0x75, 0x6a, 0x4d, 0x5e, 0x78, 0xad, 0x4a, 0x0e, 0x7a, 0x30, 0x1a, 0x09, 0x2f, 0xff, 0x1a, 0x0c,
            0x24, 0x63, 0x17, 0x5b, 0x2f, 0xae, 0x4c, 0x59, 0x75, 0x36, 0x1a, 0x52, 0x29, 0xa2, 0x48, 0x5f,
            0x7a, 0x36, 0x4c, 0x5f, 0x29, 0xfb, 0x1b, 0x0c, 0x75, 0x64, 0x16, 0x09, 0x7a, 0xfb, 0x19, 0x0d
        ]
        return String(bytes: ob.enumerated().map { $0.element ^ x[$0.offset % x.count] }, encoding: .utf8) ?? ""
    }

    private let logger = Logger(subsystem: "com.goodtogreatmind.blissfulscribe",
                                category: "LicenceService")

    // ── Codable Models ───────────────────────────────────────────────────────

    private struct ValidateRequest: Encodable {
        let key: String
        let activationId: String?
    }

    private struct ValidateResponse: Decodable {
        let valid: Bool
        let maxActivations: Int
    }

    private struct ActivateRequest: Encodable {
        let key: String
        let deviceId: String
        let deviceName: String
    }

    private struct ActivateResponse: Decodable {
        let activationId: String
        let maxActivations: Int
    }

    private struct DeactivateRequest: Encodable {
        let key: String
        let activationId: String
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private func makeRequest(path: String, body: Encodable) throws -> URLRequest {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw LicenseError.serverError(0)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        req.httpBody = try JSONEncoder().encode(body)
        return req
    }

    private func perform<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw LicenseError.serverError(0)
        }

        logger.debug("🔑 \(req.url?.path ?? "") → HTTP \(http.statusCode)")

        switch http.statusCode {
        case 200...299:
            return try JSONDecoder().decode(T.self, from: data)
        case 401:
            throw LicenseError.serverError(401)
        case 403:
            throw LicenseError.activationLimitReached
        case 404:
            throw LicenseError.keyNotFound
        default:
            let msg = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error ?? "HTTP \(http.statusCode)"
            logger.error("🔑 Error: \(msg, privacy: .public)")
            throw LicenseError.serverError(http.statusCode)
        }
    }

    // ── Public API (identical contract to PolarService) ──────────────────────

    /// Check if a key is valid and how many activations it has.
    /// Returns (isValid, requiresActivation, activationsLimit).
    func checkLicenseRequiresActivation(_ key: String) async throws
        -> (isValid: Bool, requiresActivation: Bool, activationsLimit: Int?)
    {
        let body = ValidateRequest(key: key, activationId: nil)
        let req = try makeRequest(path: "/validate", body: body)
        let resp = try await perform(req, as: ValidateResponse.self)

        let requiresActivation = resp.maxActivations > 0
        return (isValid: resp.valid, requiresActivation: requiresActivation, activationsLimit: resp.maxActivations)
    }

    /// Validate that an existing activationId is still live on this key.
    func validateLicenseKeyWithActivation(_ key: String, activationId: String) async throws -> Bool {
        let body = ValidateRequest(key: key, activationId: activationId)
        let req = try makeRequest(path: "/validate", body: body)
        let resp = try await perform(req, as: ValidateResponse.self)
        return resp.valid
    }

    /// Activate this device against the key.
    /// Returns (activationId, activationsLimit).
    func activateLicenseKey(_ key: String) async throws -> (activationId: String, activationsLimit: Int) {
        let deviceId = Obfuscator.getDeviceIdentifier()
        let deviceName = Host.current().localizedName ?? "Unknown Mac"

        let body = ActivateRequest(key: key, deviceId: deviceId, deviceName: deviceName)
        let req = try makeRequest(path: "/activate", body: body)
        let resp = try await perform(req, as: ActivateResponse.self)

        return (activationId: resp.activationId, activationsLimit: resp.maxActivations)
    }

    /// URL to open in browser for managing activations (deactivating old devices).
    func licencePortalURL(for key: String) -> URL? {
        let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
        return URL(string: "\(baseURL)/portal?key=\(encoded)")
    }

    /// Register the user's email for the trial drip sequence.
    /// Fire-and-forget — errors are silently ignored.
    func registerTrialEmail(_ email: String) {
        guard !email.isEmpty else { return }
        struct TrialStartBody: Encodable { let email: String }
        guard let req = try? makeRequest(path: "/trial-start", body: TrialStartBody(email: email)) else { return }
        Task { try? await URLSession.shared.data(for: req) }
    }
}
