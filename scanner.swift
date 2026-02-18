import CoreWLAN
import CoreLocation
import Foundation

// ── Output types ──
struct NetworkInfo: Codable {
    let ssid: String
    let bssid: String
    let rssi: Int
    let noise: Int
    let channel: Int
    let band: String
    let bandwidthMHz: Int
}

struct ScanResult: Codable {
    let timestamp: Double
    let networks: [NetworkInfo]
    let connectedSSID: String?
    let connectedBSSID: String?
    let connectedRSSI: Int?
    let connectedNoise: Int?
    let connectedTxRate: Double?
    let gatewayIP: String?
    let locationAuthorized: Bool
    let totalRawNetworks: Int
}

// ── Helpers ──
func bandName(_ channel: CWChannel?) -> String {
    guard let ch = channel else { return "unknown" }
    switch ch.channelBand {
    case .band2GHz: return "2.4GHz"
    case .band5GHz: return "5GHz"
    case .band6GHz: return "6GHz"
    @unknown default: return "unknown"
    }
}

func channelBandwidth(_ channel: CWChannel?) -> Int {
    guard let ch = channel else { return 20 }
    switch ch.channelWidth {
    case .width20MHz: return 20
    case .width40MHz: return 40
    case .width80MHz: return 80
    case .width160MHz: return 160
    @unknown default: return 20
    }
}

func getGatewayIP() -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/netstat")
    task.arguments = ["-rn"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do {
        try task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        for line in output.components(separatedBy: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            if parts.count >= 2 && parts[0] == "default" {
                return String(parts[1])
            }
        }
    } catch {}
    return nil
}

func outputJSON(_ result: ScanResult) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

func outputError(_ msg: String) {
    let err: [String: String] = ["error": msg]
    if let data = try? JSONSerialization.data(withJSONObject: err),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(1)
}

// ── Location Manager with RunLoop ──
class LocationHelper: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    var onAuthorized: ((Bool) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
    }

    func requestAndWait() -> Bool {
        let status = manager.authorizationStatus
        if status == .authorizedAlways || status == .authorized {
            return true
        }
        if status == .denied || status == .restricted {
            return false
        }
        // .notDetermined — request it, but don't block long
        // The actual permission dialog is shown asynchronously by macOS
        manager.requestAlwaysAuthorization()

        var authorized = false
        var resolved = false

        onAuthorized = { auth in
            authorized = auth
            resolved = true
            CFRunLoopStop(CFRunLoopGetMain())
        }

        // Only wait 2 seconds — if user hasn't pre-approved, just proceed
        // The dialog will appear, and next scan will have permission
        let deadline = Date().addingTimeInterval(2)
        while !resolved && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        }

        return authorized
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status != .notDetermined {
            let auth = (status == .authorizedAlways || status == .authorized)
            onAuthorized?(auth)
        }
    }
}

// ── Scan Wi-Fi ──
func performScan(locationAuthorized: Bool) {
    let client = CWWiFiClient.shared()
    guard let iface = client.interface() else {
        outputError("No Wi-Fi interface found")
        return
    }

    do {
        let scannedNetworks = try iface.scanForNetworks(withSSID: nil)
        let totalRaw = scannedNetworks.count

        // Build unique network list (best signal per identifier)
        var bestNetworks: [String: NetworkInfo] = [:]
        var hiddenCount = 0

        for n in scannedNetworks {
            var name = n.ssid
            let mac = n.bssid

            if name == nil || name!.isEmpty {
                hiddenCount += 1
                if let m = mac, !m.isEmpty, m != "unknown" {
                    name = "Hidden_\(m.suffix(8))"
                } else {
                    // Use channel + RSSI as differentiator
                    let ch = n.wlanChannel?.channelNumber ?? 0
                    let b = bandName(n.wlanChannel)
                    name = "AP_\(b)_ch\(ch)_\(hiddenCount)"
                }
            }

            let key = mac ?? name!
            let info = NetworkInfo(
                ssid: name!,
                bssid: mac ?? "redacted",
                rssi: n.rssiValue,
                noise: n.noiseMeasurement,
                channel: n.wlanChannel?.channelNumber ?? 0,
                band: bandName(n.wlanChannel),
                bandwidthMHz: channelBandwidth(n.wlanChannel)
            )

            if let existing = bestNetworks[key] {
                if info.rssi > existing.rssi { bestNetworks[key] = info }
            } else {
                bestNetworks[key] = info
            }
        }

        let networks = Array(bestNetworks.values).sorted { $0.rssi > $1.rssi }

        let result = ScanResult(
            timestamp: Date().timeIntervalSince1970,
            networks: networks,
            connectedSSID: iface.ssid(),
            connectedBSSID: iface.bssid(),
            connectedRSSI: iface.ssid() != nil ? iface.rssiValue() : nil,
            connectedNoise: iface.ssid() != nil ? iface.noiseMeasurement() : nil,
            connectedTxRate: iface.ssid() != nil ? iface.transmitRate() : nil,
            gatewayIP: getGatewayIP(),
            locationAuthorized: locationAuthorized,
            totalRawNetworks: totalRaw
        )

        outputJSON(result)
    } catch {
        outputError(error.localizedDescription)
    }
}

// ── Entry point ──
let locationHelper = LocationHelper()
let authorized = locationHelper.requestAndWait()
performScan(locationAuthorized: authorized)
