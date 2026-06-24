import Foundation
import os

// ── Errors (shared, same as before) ─────────────────────────────────────────
// LicenseError is already defined in PolarService.swift — kept identical.

class BlissfulScribeLicenceService {

    // ── Configuration ────────────────────────────────────────────────────────
    // Replace with your actual Worker URL once deployed:
    //   wrangler deploy  →  https://blissfulscribe-licence.<account>.workers.dev
    // Or a custom route, e.g. https://licence.blissfulplan.com
    private let baseURL = "https://blissfulscribe-licence.ACCOUNT.workers.dev"

    // Must match the WORKER_API_KEY secret you set with:
    //   wrangler secret put WORKER_API_KEY
    // Keep this obfuscated in production using the existing Obfuscator pattern.
    private let apiKey = "REPLACE_WORKER_API_KEY"

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
}
