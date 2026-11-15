import ActivityKit
import SwiftUI
import WidgetKit

@main
struct GVDGActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RoundActivityAttributes.self) { context in
            HStack(spacing: 14) {
                Image(systemName: "figure.walk")
                    .font(.title2)
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("GVDG activity").font(.headline)
                    detail(context).font(.subheadline)
                }
                Spacer()
            }
            .padding()
            .activityBackgroundTint(Color.black.opacity(0.78))
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "figure.walk").foregroundStyle(.orange)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text("GVDG activity").font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    detail(context)
                }
            } compactLeading: {
                Image(systemName: "figure.walk").foregroundStyle(.orange).accessibilityLabel("GVDG activity")
            } compactTrailing: {
                if !context.isStale, let feet = context.state.basketFeet {
                    Text("\(feet)′").monospacedDigit().privacySensitive()
                } else {
                    Image(systemName: context.state.status == "Paused" ? "pause.fill" : "location")
                }
            } minimal: {
                Image(systemName: context.state.status == "Paused" ? "pause.fill" : "figure.walk")
                    .accessibilityLabel(context.state.status)
            }
        }
    }

    private func detail(_ context: ActivityViewContext<RoundActivityAttributes>) -> some View {
        let value: String
        if context.isStale && context.state.expectsFix { value = "Waiting for a fresh GPS fix" }
        else if let feet = context.state.basketFeet { value = "\(feet) ft to basket" }
        else if context.state.expectsFix { value = "Waiting for GPS" }
        else { value = context.state.status }
        return Text(value).privacySensitive(context.state.basketFeet != nil && !context.isStale)
    }
}
