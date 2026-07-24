import SwiftUI

/// Short, actionable checklist shown from the Dashboard's Help & Resources
/// card. Covers what onboarding doesn't: choosing a model, setting up
/// Modes, and tuning preferences. Full explanations live on the website
/// guide this links out to.
struct GettingStartedView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            header

            ScrollView {
                VStack(spacing: 10) {
                    GettingStartedStepRow(
                        number: 1,
                        icon: "checkmark.seal.fill",
                        color: AppTheme.Sidebar.dashboard,
                        title: "Finish the onboarding tour",
                        description: "Grants permissions and downloads your first model. If you skipped it, restart it from Settings → General."
                    )
                    GettingStartedStepRow(
                        number: 2,
                        icon: "sparkles",
                        color: AppTheme.Sidebar.models,
                        title: "Choose the right transcription model",
                        description: "Local models are private and work offline; Cloud models give the best accuracy but need an API key.",
                        actionLabel: "Go to AI Models",
                        destination: "AI Models",
                        dismiss: { dismiss() }
                    )
                    GettingStartedStepRow(
                        number: 3,
                        icon: "square.stack.3d.up.fill",
                        color: AppTheme.Sidebar.modes,
                        title: "Set up Modes",
                        description: "Separate profiles for chat, email, or code — each with its own model and style.",
                        actionLabel: "Go to Modes",
                        destination: "Modes",
                        dismiss: { dismiss() }
                    )
                    GettingStartedStepRow(
                        number: 4,
                        icon: "slider.horizontal.3",
                        color: AppTheme.Sidebar.audio,
                        title: "Tune your preferences",
                        description: "Set a global hotkey, choose auto-paste vs. clipboard, and configure audio privacy.",
                        actionLabel: "Go to Settings",
                        destination: "Settings",
                        dismiss: { dismiss() }
                    )
                    GettingStartedStepRow(
                        number: 5,
                        icon: "mic.fill",
                        color: AppTheme.Sidebar.dashboard,
                        title: "Start transcribing",
                        description: "Press your hotkey, speak, press it again — that's the whole workflow."
                    )
                }
                .padding(20)
            }

            footer
        }
        .frame(width: 460, height: 580)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Getting Started")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                Text("Five steps to get the most out of BlissfulScribe")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.Text.secondary)
            }
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(20)
    }

    private var footer: some View {
        Button {
            if let url = URL(string: "https://scribe.blissfulplan.com/docs") {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack {
                Text("View full guide online")
                    .fontWeight(.semibold)
                Spacer()
                Image(systemName: "arrow.up.right")
            }
            .font(.system(size: 13))
            .padding(12)
            .background(AppTheme.Surface.subtle)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }
}

private struct GettingStartedStepRow: View {
    let number: Int
    let icon: String
    let color: Color
    let title: String
    let description: String
    var actionLabel: String?
    var destination: String?
    var dismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            DashboardIconGlyph(systemName: icon, color: color, size: 14, frameSize: 26)

            VStack(alignment: .leading, spacing: 4) {
                Text("\(number). \(title)")
                    .font(.system(size: 13, weight: .semibold))
                Text(description)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.Text.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let actionLabel, let destination, let dismiss {
                    Button {
                        NotificationCenter.default.post(
                            name: .navigateToDestination,
                            object: nil,
                            userInfo: ["destination": destination]
                        )
                        dismiss()
                    } label: {
                        Text(actionLabel)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(color)
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(AppTheme.Surface.subtle)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
