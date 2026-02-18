# Wi-Fi RTT Triangulation Engine

A real-time indoor/urban positioning system that estimates location using Wi-Fi signal strength (RSSI), network round-trip time (RTT), and browser GPS. Built to demonstrate how Wi-Fi triangulation can supplement GPS in environments where satellite signals are weak or unreliable — dense urban areas, indoors, parking garages, tunnels, etc.

**Live demo:** [wifi-location-test.vercel.app](https://wifi-location-test.vercel.app)

---

## What This Does

### The Problem

GPS relies on line-of-sight to satellites. In urban canyons (tall buildings), indoors, or underground, GPS accuracy degrades from ~3m to 50-100m+ or fails entirely. Phones often fall back to Wi-Fi-based positioning (using known AP databases), but that's a black box controlled by Google/Apple.

### Our Approach

This project takes a different approach — it scans nearby Wi-Fi access points directly and uses signal physics to estimate position:

1. **RSSI-to-Distance Conversion** — Each Wi-Fi AP broadcasts at a known power level. Signal strength decays with distance following the log-distance path loss model: `d = 10^((TxPower - RSSI) / (10 * n))`. We use frequency-aware path loss exponents (2.4GHz: n=2.8, 5GHz: n=3.2, 6GHz: n=3.5) since higher frequencies attenuate faster.

2. **Trilateration** — With 3+ distance estimates from different APs, we solve for position using Weighted Nonlinear Least Squares (WNLS) with momentum-based gradient descent. Each AP is weighted by its signal-to-noise ratio (SNR) — stronger, cleaner signals get more influence.

3. **RTT Measurement** — We measure round-trip time to the gateway router using TCP SYN timing (nanosecond precision) and ICMP ping. While network-layer RTT includes processing overhead that makes pure distance calculation impractical (~3ms = ~450km at light speed), the relative timing and jitter provide useful signal quality metrics.

4. **Kalman Filtering** — Position estimates are smoothed over time using a 1D Kalman filter per axis, reducing jitter from noisy RSSI readings.

5. **GPS Anchor** — The browser's Geolocation API provides a GPS fix as a reference point. Wi-Fi trilateration gives meter-level offsets from this anchor, which are converted to real GPS coordinates using geodetic math.

### Pages

| Page | URL | Description |
|------|-----|-------------|
| **Triangulation Engine** | `/` | Interactive canvas showing AP positions, distance circles, trilateration math, RSSI/RTT data, Kalman-filtered position estimate, and GPS coordinates |
| **Live Map** | `/map.html` | Real-time OpenStreetMap with GPS tracking, accuracy circles, movement trail, speed/altitude, and optional Wi-Fi position overlay |

---

## Will This Work at Different Locations?

**Short answer: Yes**, with some caveats depending on which mode you're using.

### Vercel-Hosted Version (GPS Only Mode)

Works **anywhere in the world** on any device with a browser and GPS/location services. The live demo at [wifi-location-test.vercel.app](https://wifi-location-test.vercel.app) runs entirely in the browser using the Geolocation API. No server needed. Both the triangulation page and the live map page will show your GPS position. The Wi-Fi scanning features are disabled in this mode (the page shows "Standalone Mode").

### Local Server Version (Full Wi-Fi Scanning)

Works **on any macOS machine** at any location. The Wi-Fi scanner uses Apple's CoreWLAN framework to detect nearby access points. What changes by location:

- **Different APs** — Every location has different Wi-Fi networks. The scanner discovers whatever APs are nearby and builds the trilateration from those. No pre-configured AP database needed.
- **Accuracy varies** — More visible APs = better triangulation. A coffee shop with 15 visible networks will give better results than a rural house with 2.
- **Path loss model is universal** — The frequency-aware RSSI-to-distance conversion works everywhere, though walls, furniture, and building materials affect the path loss exponent. The defaults are tuned for typical indoor/urban environments.
- **GPS anchor is location-independent** — It uses whatever GPS fix the browser provides at your current location.

### Platform Limitations

| Platform | Wi-Fi Scanning | GPS | Live Map |
|----------|---------------|-----|----------|
| macOS (local server) | Full | Yes | Yes |
| Windows/Linux (local server) | No (CoreWLAN is macOS-only) | Yes | Yes |
| Any browser via Vercel | No (requires local server) | Yes | Yes |
| Mobile phone (same network) | No (server-side) | Yes (better than desktop) | Yes |

> **Note:** macOS requires Location Services permission for the scanner app to read SSID/BSSID data. Additionally, full SSID visibility requires an Apple Developer certificate ($99/year). Without it, SSIDs appear redacted but the scanner still detects APs by channel and band.

---

## Setup

### Prerequisites

- **macOS** (required for Wi-Fi scanning; GPS-only mode works on any OS)
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
# Create the app bundle structure
mkdir -p WifiScanner.app/Contents/MacOS

# Compile
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

# Code sign
codesign --force --sign - WifiScanner.app
```

### Enable Location Services

1. Open **System Settings > Privacy & Security > Location Services**
2. Enable Location Services (if not already)
3. Find **WifiScanner** in the list and toggle it **ON**

### Generate SSL Certificates (optional, for mobile GPS)

Mobile browsers require HTTPS for the Geolocation API. Generate a self-signed cert for local development:

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj '/CN=localhost'
```

### Run

```bash
npm start
```

Access:
- **Desktop:** http://localhost:3000
- **Phone (same Wi-Fi):** https://\<your-local-ip\>:3443 (accept the certificate warning)

The server auto-detects your local IP and prints it on startup.

---

## Architecture

```
Browser (any device)
  |
  |-- GPS ← navigator.geolocation (browser-native)
  |
  |-- WebSocket ← Real-time scan data from server
  |       |
  |       v
  Node.js Server (macOS)
    |-- Wi-Fi Scanner ← CoreWLAN via compiled Swift binary
    |-- RTT Measurement ← TCP SYN timing + ICMP ping to gateway
    |-- ARP Table ← Network device discovery
```

### Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Triangulation UI — canvas visualization, RSSI/RTT processing, trilateration math, Kalman filter, GPS anchor system |
| `public/map.html` | Live map — Leaflet + OpenStreetMap with GPS tracking and Wi-Fi overlay |
| `server.js` | Express + WebSocket server, runs scanner, measures RTT, reads ARP table |
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
