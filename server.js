const express = require('express');
const { WebSocketServer } = require('ws');
const { execFile, exec } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const os = require('os');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

const app = express();
const server = http.createServer(app);

// HTTPS server for mobile GPS (browsers require secure context for geolocation)
let httpsServer;
try {
    const sslOpts = {
        key: fs.readFileSync(path.join(__dirname, 'key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
    };
    httpsServer = https.createServer(sslOpts, app);
} catch (e) {
    console.warn('  SSL certs not found — HTTPS disabled (mobile GPS won\'t work)');
}

// WebSocket on both HTTP and HTTPS
const wss = new WebSocketServer({ server });
let wssSecure;
if (httpsServer) {
    wssSecure = new WebSocketServer({ server: httpsServer });
}

// Use the app bundle binary (has Location Services entitlement via Info.plist)
const SCANNER_PATH = path.join(__dirname, 'WifiScanner.app', 'Contents', 'MacOS', 'wifi-scanner');
const SCAN_INTERVAL = 3000;

app.use(express.static(__dirname + '/public'));

// ── Wi-Fi Scanner ──
function runScan() {
    return new Promise((resolve, reject) => {
        execFile(SCANNER_PATH, { timeout: 10000 }, (error, stdout) => {
            if (error) return reject(new Error(`Scanner failed: ${error.message}`));
            try { resolve(JSON.parse(stdout)); }
            catch (e) { reject(new Error(`Invalid scanner output`)); }
        });
    });
}

// ── RTT Measurement ──
// Measures network-layer round-trip time using TCP SYN timing.
// This includes processing overhead (~0.1-2ms) beyond pure signal flight time.
// True 802.11mc measures at the physical layer with nanosecond precision.
function measureRTT(host, port = 80, samples = 5) {
    return new Promise((resolve) => {
        const results = [];
        let completed = 0;

        function doOnePing() {
            const start = process.hrtime.bigint();
            const sock = new net.Socket();
            sock.setTimeout(2000);

            sock.connect(port, host, () => {
                const end = process.hrtime.bigint();
                const rttNs = Number(end - start);
                results.push(rttNs);
                sock.destroy();
                finish();
            });

            sock.on('error', () => { sock.destroy(); finish(); });
            sock.on('timeout', () => { sock.destroy(); finish(); });
        }

        function finish() {
            completed++;
            if (completed >= samples) {
                if (results.length === 0) return resolve(null);
                // Remove outliers: drop highest and lowest if we have enough samples
                const sorted = [...results].sort((a, b) => a - b);
                const trimmed = sorted.length >= 4
                    ? sorted.slice(1, -1)
                    : sorted;
                const avgNs = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
                const minNs = sorted[0];
                const maxNs = sorted[sorted.length - 1];
                resolve({
                    avgMs: avgNs / 1e6,
                    minMs: minNs / 1e6,
                    maxMs: maxNs / 1e6,
                    samples: results.length,
                    allMs: sorted.map(n => n / 1e6),
                });
            }
        }

        // Stagger pings slightly to avoid burst
        for (let i = 0; i < samples; i++) {
            setTimeout(() => doOnePing(i), i * 50);
        }
    });
}

// Also measure ICMP-like RTT via the ping command (more accurate for routers)
function measurePingRTT(host, count = 10) {
    return new Promise((resolve) => {
        // -c count, -i 0.1 (100ms between pings), -W 2000 (2s timeout)
        exec(`ping -c ${count} -i 0.1 -W 2000 ${host}`, { timeout: 15000 }, (error, stdout) => {
            if (error || !stdout) return resolve(null);
            // Parse individual ping times
            const times = [];
            const lines = stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/time[=<](\d+\.?\d*)\s*ms/);
                if (match) times.push(parseFloat(match[1]));
            }
            if (times.length === 0) return resolve(null);

            const sorted = [...times].sort((a, b) => a - b);
            const trimmed = sorted.length >= 4 ? sorted.slice(1, -1) : sorted;
            const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

            // Parse summary stats if available
            const summaryMatch = stdout.match(/(\d+\.?\d*)\/(\d+\.?\d*)\/(\d+\.?\d*)\/(\d+\.?\d*)\s*ms/);
            const jitter = summaryMatch ? parseFloat(summaryMatch[4]) : 0;

            resolve({
                avgMs: avg,
                minMs: sorted[0],
                maxMs: sorted[sorted.length - 1],
                jitterMs: jitter,
                samples: times.length,
                allMs: sorted,
            });
        });
    });
}

// Get ARP table entries to find other network devices
function getARPTable() {
    return new Promise((resolve) => {
        exec('arp -a', { timeout: 5000 }, (error, stdout) => {
            if (error) return resolve([]);
            const entries = [];
            for (const line of stdout.split('\n')) {
                const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
                if (match && match[2] !== 'ff:ff:ff:ff:ff:ff') {
                    entries.push({ ip: match[1], mac: match[2] });
                }
            }
            resolve(entries);
        });
    });
}

// REST endpoints
app.get('/api/scan', async (req, res) => {
    try { res.json(await runScan()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rtt/:host', async (req, res) => {
    const host = req.params.host;
    // Basic IP validation
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    const [tcp, icmp] = await Promise.all([
        measureRTT(host, 80, 5),
        measurePingRTT(host, 10),
    ]);
    res.json({ host, tcp, icmp });
});

app.get('/api/arp', async (req, res) => {
    res.json(await getARPTable());
});

// ── WebSocket ──
let scanTimer = null;
let clients = new Set();

async function fullScan() {
    const [scanData, arpTable] = await Promise.all([
        runScan(),
        getARPTable(),
    ]);

    // Measure RTT to gateway
    let gatewayRTT = null;
    if (scanData.gatewayIP) {
        const [tcp, icmp] = await Promise.all([
            measureRTT(scanData.gatewayIP, 80, 5),
            measurePingRTT(scanData.gatewayIP, 10),
        ]);
        gatewayRTT = { host: scanData.gatewayIP, tcp, icmp };
    }

    return {
        ...scanData,
        arpTable,
        gatewayRTT,
    };
}

function handleWSConnection(ws) {
    clients.add(ws);
    console.log(`Client connected (${clients.size} total)`);

    // Immediate scan
    fullScan()
        .then(data => ws.readyState === 1 && ws.send(JSON.stringify(data)))
        .catch(err => ws.readyState === 1 && ws.send(JSON.stringify({ error: err.message })));

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`Client disconnected (${clients.size} total)`);
        if (clients.size === 0 && scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
    });

    if (!scanTimer) {
        scanTimer = setInterval(async () => {
            if (clients.size === 0) return;
            try {
                const data = await fullScan();
                const msg = JSON.stringify(data);
                for (const c of clients) {
                    if (c.readyState === 1) c.send(msg);
                }
            } catch (err) {
                console.error('Scan error:', err.message);
            }
        }, SCAN_INTERVAL);
    }
}

wss.on('connection', handleWSConnection);
if (wssSecure) wssSecure.on('connection', handleWSConnection);

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;

server.listen(PORT, () => {
    console.log(`\n  Wi-Fi RTT Triangulation Server`);
    console.log(`  ──────────────────────────────`);
    console.log(`  HTTP:    http://localhost:${PORT}`);
    console.log(`  Scanner: ${SCANNER_PATH}`);
    console.log(`  Mode:    RSSI + RTT Hybrid`);
    console.log(`  Interval: ${SCAN_INTERVAL / 1000}s`);
});

if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
        console.log(`  HTTPS:   https://${getLocalIP()}:${HTTPS_PORT}  (use this on your phone for GPS)`);
        console.log();
    });
}
