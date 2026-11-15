import Foundation
import SwiftUI
import UniformTypeIdentifiers

@main
struct GVDGPhoneApp: App {
    @StateObject private var session = ActivitySession()

    var body: some Scene {
        WindowGroup { ActivityView(session: session) }
    }
}

private struct RouteDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let contents: Data

    init(_ route: ActivityTrack) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        contents = try encoder.encode(route.upload)
    }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else { throw ActivityFailure.storage }
        self.contents = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: contents) }
}

private struct ActivityView: View {
    enum Panel: String, CaseIterable { case record = "Record", routes = "Routes", connect = "Connect" }

    @ObservedObject var session: ActivitySession
    @State private var panel = Panel.record
    @State private var replacing = false
    @State private var upload: ActivityTrack?
    @State private var deleting: ActivityTrack?
    @State private var document: RouteDocument?
    @State private var exporting = false

    private let accent = Color(red: 0.68, green: 0.19, blue: 0.08)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Picker("Activity section", selection: $panel) {
                    ForEach(Panel.allCases, id: \.self) { item in Text(item.rawValue).tag(item) }
                }
                .pickerStyle(.segmented)
                if !session.message.isEmpty {
                    Label(session.message, systemImage: "info.circle")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                switch panel {
                case .record: record
                case .routes: routes
                case .connect: connection
                }
            }
            .frame(maxWidth: 560)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .tint(accent)
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "gvdg-activity") { result in
            switch result {
            case .success: session.message = "Route exported."
            case .failure: session.message = "The route export could not be written."
            }
            document = nil
        }
        .alert("Upload private route?", isPresented: Binding(get: { upload != nil }, set: { if !$0 { upload = nil } }), presenting: upload) { route in
            Button("Upload") { Task { await session.upload(route) } }
            Button("Keep on phone", role: .cancel) {}
        } message: { route in
            Text("This uploads the route’s precise GPS positions and times to your private club archive."
                + (route.ownerId == nil ? " The route will be linked to this account." : ""))
        }
        .alert("Remove route from phone?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { route in
            Button("Remove", role: .destructive) { session.remove(route) }
            Button("Cancel", role: .cancel) {}
        } message: { route in
            Text(route.serverId == nil ? "This route is saved only on this phone." : "Manage the uploaded copy on the club website.")
        }
        .alert("Replace the phone connection?", isPresented: $replacing) {
            Button("Get new code") { Task { await session.pair() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Saved activities keep their original owner. To revoke the old connection, remove it from the club website.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "figure.walk")
                .font(.system(size: 25, weight: .semibold))
                .frame(width: 48, height: 48)
                .foregroundStyle(accent)
                .background(accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("GREENVILLE DISC GOLF CLUB")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(accent)
                Text("Round activity")
                    .font(.largeTitle.weight(.heavy))
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }

    private var record: some View {
        VStack(alignment: .leading, spacing: 14) {
            Group {
                if let track = session.track {
                    if session.ownsActive { activeCard(track) }
                    else {
                        tile {
                            Text("Another account owns this activity").font(.title3.weight(.semibold))
                            Text("Connect that account to finish or export the saved route.").foregroundStyle(.secondary)
                        }
                    }
                } else {
                    tile {
                        Text("Ready to record").font(.subheadline.weight(.semibold)).foregroundStyle(accent)
                        Text("Record your walk").font(.title2.weight(.bold))
                        Text("Your phone records GPS locations while the activity runs, including when the screen is locked.")
                            .foregroundStyle(.secondary)
                        primary("Start activity", icon: "location.fill") { session.start() }
                    }
                }
            }
            rangeCard
        }
    }

    private func activeCard(_ track: ActivityTrack) -> some View {
        tile {
            Label(session.running ? "Recording" : "Paused", systemImage: session.running ? "record.circle" : "pause.circle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(accent)
            Text("\(track.recordedMeters) m")
                .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                .monospacedDigit()
                .accessibilityLabel("\(track.recordedMeters) meters recorded")
            Text("Recorded distance").font(.subheadline).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { controls }
                VStack(spacing: 10) { controls }
            }
        }
    }

    @ViewBuilder private var controls: some View {
        if session.running { primary("Pause", icon: "pause") { session.pause() } }
        else { primary("Resume", icon: "play") { session.start() } }
        Button { session.stop() } label: {
            Text("Stop and save").fontWeight(.semibold).frame(minHeight: 34).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    private var rangeCard: some View {
        tile {
            Text("Distance to basket").font(.title3.weight(.semibold))
            if let round = session.settings.device?.round, session.connected, round.status == "live", !round.holes.isEmpty {
                let selected = session.settings.hole ?? round.startingHole ?? round.holes[0].hole
                Text(round.courseName ?? "Live round").font(.subheadline).foregroundStyle(.secondary)
                Picker("Hole", selection: Binding(get: { selected }, set: session.choose)) {
                    ForEach(round.holes) { hole in
                        Text("Hole \(hole.hole)" + (hole.basket == nil ? " · no basket position" : "")).tag(hole.hole)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityLabel("Basket hole")
                TimelineView(.periodic(from: .now, by: 10)) { context in
                    let now = Int64(context.date.timeIntervalSince1970 * 1000)
                    if let feet = session.range(at: now) {
                        Text("\(feet) ft to basket").font(.headline.monospacedDigit())
                    } else {
                        Text(session.running ? "Waiting for a fresh GPS fix and saved basket" : "Start or resume for a fresh distance")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Toggle("Show distance on lock screen", isOn: Binding(get: { session.settings.lockDistance }, set: session.showLockDistance))
                    .font(.subheadline)
            } else {
                Text("Pair from a live scorecard to use its saved basket positions.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var routes: some View {
        VStack(alignment: .leading, spacing: 10) {
            if session.routes.isEmpty {
                tile {
                    Text("Saved routes").font(.title3.weight(.semibold))
                    Text("Stopped activities will appear here.").foregroundStyle(.secondary)
                }
            }
            ForEach(session.routes) { route in
                tile {
                    Text(Date(timeIntervalSince1970: Double(route.startedAt) / 1000), format: .dateTime.month().day().hour().minute())
                        .font(.headline)
                    Text("\(route.recordedMeters) m · \(route.pointCount) GPS fixes")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(route.serverId != nil ? "Uploaded to your private archive" : "On this phone")
                        .font(.caption.weight(.semibold)).foregroundStyle(accent)
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { routeActions(route) }
                        VStack(spacing: 10) { routeActions(route) }
                    }
                }
            }
        }
    }

    @ViewBuilder private func routeActions(_ route: ActivityTrack) -> some View {
        if route.serverId == nil && route.pointCount > 0 && session.connected {
            Button("Upload") { upload = route }.buttonStyle(.borderedProminent).disabled(session.busy)
        }
        Button("Export") {
            do { document = try RouteDocument(route); exporting = true }
            catch { session.message = "Could not prepare the route for export." }
        }
        .buttonStyle(.bordered)
        Button("Remove", role: .destructive) { deleting = route }.buttonStyle(.bordered).disabled(session.busy)
    }

    private var connection: some View {
        tile {
            Text(session.connected ? "Club account connected" : "Connect your club account").font(.title3.weight(.semibold))
            Text("Pairing enables private uploads and brings in basket positions from the live scorecard you pair with.")
                .foregroundStyle(.secondary)
            if let code = session.code {
                Text(code)
                    .font(.system(.largeTitle, design: .monospaced, weight: .heavy))
                    .foregroundStyle(accent)
                    .textSelection(.enabled)
                Text("Enter this code under Phone activity on the club website. Then return here and check the connection.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Link("Open club website", destination: ActivityAPI.website)
                primary("Check connection", icon: "arrow.clockwise") { Task { await session.connect() } }
                    .disabled(session.busy)
            } else if session.settings.device != nil {
                if session.connected, let expiry = session.settings.device?.expiresAt {
                    Text("Expires " + Date(timeIntervalSince1970: Double(expiry) / 1000).formatted(date: .abbreviated, time: .omitted))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                primary("Refresh connection", icon: "arrow.clockwise") { Task { await session.connect() } }
                    .disabled(session.busy)
                Button("Pair again") { replacing = true }.buttonStyle(.bordered).disabled(session.busy || session.running)
            } else {
                primary("Get pairing code", icon: "link") { Task { await session.pair() } }
                    .disabled(session.busy || session.running)
            }
        }
    }

    private func tile<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 19))
    }

    private func primary(_ label: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: icon).fontWeight(.semibold)
                .frame(minHeight: 34)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
    }
}
