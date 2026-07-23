import SwiftUI

struct DiagnosticsSettingsView: View {
    @AppStorage("enableDiagnostics") private var enableDiagnostics = false
    @State private var isExportingLogs = false
    @State private var exportedLogURL: URL?
    @State private var showLogExportError = false
    @State private var logExportError: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Help Improve BlissfulScribe", isOn: $enableDiagnostics)
            Text("Sends anonymous error signals to help us catch problems — no audio, transcripts, or personal data. Takes effect after restarting BlissfulScribe.")
                .font(.caption)
                .foregroundColor(.secondary)
        }

        LabeledContent {
            HStack(spacing: 8) {
                if let url = exportedLogURL {
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    }

                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(AppTheme.Status.positive)
                }

                Button("Export") {
                    exportDiagnosticLogs()
                }
                .disabled(isExportingLogs)
            }
        } label: {
            HStack(spacing: 4) {
                if isExportingLogs {
                    ProgressView()
                        .controlSize(.small)
                }
                Text("Export Logs")
            }
        }
        .alert("Export Failed", isPresented: $showLogExportError) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(logExportError)
        }
    }

    private func exportDiagnosticLogs() {
        isExportingLogs = true
        exportedLogURL = nil

        Task {
            do {
                let url = try await LogExporter.shared.exportLogs()
                await MainActor.run {
                    exportedLogURL = url
                    isExportingLogs = false
                }
            } catch {
                await MainActor.run {
                    logExportError = error.localizedDescription
                    showLogExportError = true
                    isExportingLogs = false
                }
            }
        }
    }
}
