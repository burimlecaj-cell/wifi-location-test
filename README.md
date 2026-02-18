# Wi-Fi RTT Triangulation Engine

A real-time indoor/urban positioning system that estimates location using Wi-Fi signal strength (RSSI), network round-trip time (RTT), and browser GPS. Built to demonstrate how Wi-Fi triangulation can supplement GPS in environments where satellite signals are weak or unreliable — dense urban areas, indoors, parking garages, tunnels, etc.

**Live demo:** [wifi-location-test.vercel.app](https://wifi-location-test.vercel.app)

---

## What This Does

### The Problem

GPS relies on line-of-sight to satellites. In urban canyons (tall buildings), indoors, or underground, GPS accuracy degrades from ~3m to 50-100m+ or fails entirely. Devices often fall back to Wi-Fi-based positioning (using known AP databases), but that's a black box controlled by Google/Apple.

### Our Approach

This project scans nearby Wi-Fi access points directly and uses signal physics to estimate position:

1. **RSSI-to-Distance Conversion** — Each Wi-Fi AP broadcasts at a known power level. Signal strength decays with distance following the log-distance path loss model: `d = 10^((TxPower - RSSI) / (10 * n))`. We use frequency-aware path loss exponents (2.4GHz: n=2.8, 5GHz: n=3.2, 6GHz: n=3.5) since higher frequencies attenuate faster.

2. **Trilateration** — With 3+ distance estimates from different APs, we solve for position using Weighted Nonlinear Least Squares (WNLS) with momentum-based gradient descent. Each AP is weighted by its signal-to-noise ratio (SNR) — stronger, cleaner signals get more influence.

3. **RTT Measurement** — Round-trip time to the gateway router is measured using TCP SYN timing (nanosecond precision) and ICMP ping. While network-layer RTT includes processing overhead that makes pure distance calculation impractical (~3ms = ~450km at light speed), the relative timing and jitter provide useful signal quality metrics.

4. **Kalman Filtering** — Position estimates are smoothed over time using a 1D Kalman filter per axis, reducing jitter from noisy RSSI readings.

5. **GPS Anchor** — The browser's Geolocation API provides a GPS fix as a reference point. Wi-Fi trilateration gives meter-level offsets from this anchor, which are converted to real GPS coordinates using geodetic math.

### Pages

| Page | URL | Description |
|------|-----|-------------|
| **Triangulation Engine** | `/` | Interactive canvas showing AP positions, distance circles, trilateration math, RSSI/RTT data, Kalman-filtered position estimate, and GPS coordinates |
| **Live Map** | `/map.html` | Real-time OpenStreetMap with GPS tracking, accuracy circles, movement trail, speed/altitude, and optional Wi-Fi position overlay |

---

## Deployment Modes

### Static (Vercel)

The live demo loads pre-captured Wi-Fi scan data from `scan-data.json` and uses browser GPS. No backend server required. This mode works **anywhere in the world** on any device with a browser.

The scan data includes 11 APs across 2.4GHz, 5GHz, and 6GHz bands captured at the reference location. The GPS anchor is automatically set from the saved coordinates.

### Local Server (Full Wi-Fi Scanning)

For real-time scanning, run the Node.js server on macOS. This mode:
- Scans nearby APs every 3 seconds via CoreWLAN
- Measures gateway RTT with TCP SYN timing and ICMP ping
- Streams data to the browser via WebSocket
- Works at **any location** — the scanner discovers whatever APs are nearby

### Platform Support

| Platform | Wi-Fi Scanning | GPS | Live Map |
|----------|---------------|-----|----------|
| macOS (local server) | Full | Yes | Yes |
| Windows/Linux | No (CoreWLAN is macOS-only) | Yes | Yes |
| Any browser (Vercel) | Saved data only | Yes | Yes |
| Mobile browser | Saved data only | Yes | Yes |

> **Note:** macOS requires Location Services permission for the scanner app to read SSID/BSSID data. Full SSID visibility requires an Apple Developer certificate ($99/year). Without it, SSIDs appear redacted but the scanner still detects APs by channel and band.

---

## Local Development Setup

### Prerequisites

- **macOS** (required for Wi-Fi scanning; saved data mode works on any OS)
- **Node.js 18+**
- **Xcode Command Line Tools** (for compiling the Swift scanner)

### Install

```bash
git clone <repo-url>
cd wifi-location-test
npm install
```

### Compile the Wi-Fi Scanner (macOS only)

```bash
mkdir -p WifiScanner.app/Contents/MacOS

swiftc scanner.swift \
  -o WifiScanner.app/Contents/MacOS/wifi-scanner \
  -framework CoreWLAN \
  -framework CoreLocation \
  -framework Foundation

# Create Info.plist (required for Location Services)
cat > WifiScanner.app/Contents/Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.wifitriangulation.scanner</string>
    <key>CFBundleName</key>
    <string>WifiScanner</string>
    <key>CFBundleExecutable</key>
    <string>wifi-scanner</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSLocationUsageDescription</key>
    <string>Wi-Fi scanning requires location access to read network details.</string>
    <key>NSLocationWhenInUseUsageDescription</key>
    <string>Wi-Fi scanning requires location access to read network details.</string>
    <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
    <string>Wi-Fi scanning requires location access to read network details.</string>
</dict>
</plist>
EOF

codesign --force --sign - WifiScanner.app
```

### Enable Location Services

1. Open **System Settings > Privacy & Security > Location Services**
2. Enable Location Services (if not already)
3. Find **WifiScanner** in the list and toggle it **ON**

### Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

---

## Architecture

```
Browser
  |
  |-- GPS ← navigator.geolocation (browser-native)
  |
  |-- Saved Data ← scan-data.json (pre-captured APs + RTT)
  |
  |-- WebSocket ← Real-time scan data (local server only)
  |       |
  |       v
  Node.js Server (macOS, optional)
    |-- Wi-Fi Scanner ← CoreWLAN via compiled Swift binary
    |-- RTT Measurement ← TCP SYN timing + ICMP ping
    |-- ARP Table ← Network device discovery
```

### Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Triangulation UI — canvas, RSSI/RTT processing, trilateration, Kalman filter, GPS anchor |
| `public/map.html` | Live map — Leaflet + OpenStreetMap with GPS tracking and Wi-Fi overlay |
| `public/scan-data.json` | Pre-captured Wi-Fi scan data for static deployment |
| `server.js` | Express + WebSocket server, runs scanner, measures RTT (local dev only) |
| `scanner.swift` | macOS Wi-Fi scanner using CoreWLAN + CoreLocation |

### Signal Processing Pipeline

```
Raw RSSI (dBm) → Frequency-aware path loss model → Distance estimate (meters)
                                                          |
                                                    ± Uncertainty
                                                          |
3+ AP distances → WNLS Trilateration (gradient descent) → (x, y) position
                         |                                      |
                    SNR weighting                         Kalman filter
                                                              |
                                                   GPS anchor + offset
                                                              |
                                                    Lat/Lng coordinates
                                                    (64-bit, 10 decimal places)
```

---

## Accuracy Expectations

| Condition | Expected Accuracy |
|-----------|------------------|
| Outdoors, clear sky (GPS only) | 3-10m |
| Indoors, 5+ visible APs | 5-15m (Wi-Fi trilateration) |
| Dense urban, 10+ APs | 3-8m (Wi-Fi + GPS combined) |
| Rural, 1-2 APs | 20-50m (falls back to GPS) |

Accuracy depends heavily on:
- **Number of visible APs** — More is better. 3 is minimum, 6+ is ideal.
- **AP distribution** — APs surrounding you give better geometry than all being on one side.
- **Environment** — Walls, metal, and water absorb/reflect signals, distorting distance estimates.
- **GPS quality** — The anchor point accuracy directly affects the final coordinates.

---

## Technologies

- **Frontend:** Vanilla HTML/CSS/JS, Canvas API, Leaflet.js, OpenStreetMap
- **Backend:** Node.js, Express, WebSocket (ws)
- **Scanner:** Swift, CoreWLAN, CoreLocation (macOS)
- **Math:** Log-distance path loss model, WNLS trilateration, Kalman filtering, geodetic coordinate conversion
- **Deployment:** Vercel (static), GitHub

---

## License

MIT
