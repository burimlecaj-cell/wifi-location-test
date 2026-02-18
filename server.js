const express = require('express');
const { WebSocketServer } = require('ws');
const { execFile, exec } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const SCANNER_PATH = path.join(__dirname, 'WifiScanner.app', 'Contents', 'MacOS', 'wifi-scanner');
const SCAN_INTERVAL = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ── Wi-Fi Scanner ──
function runScan() {
    return new Promise((resolve, reject) => {
        execFile(SCANNER_PATH, { timeout: 10000 }, (error, stdout) => {
            if (error) return reject(new Error(`Scanner failed: ${error.message}`));
            try { resolve(JSON.parse(stdout)); }
            catch (e) { reject(new Error('Invalid scanner output')); }
        });
    });
}

// ── RTT Measurement ──
// Measures network-layer round-trip time using TCP SYN timing.
function measureRTT(host, port = 80, samples = 5) {
    return new Promise((resolve) => {
        const results = [];
        let completed = 0;

        function doOnePing() {
            const start = process.hrtime.bigint();
            const sock = new net.Socket();
            sock.setTimeout(2000);
            sock.connect(port, host, () => {
                const rttNs = Number(process.hrtime.bigint() - start);
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
                const sorted = [...results].sort((a, b) => a - b);
                const trimmed = sorted.length >= 4 ? sorted.slice(1, -1) : sorted;
                const avgNs = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
                resolve({
                    avgMs: avgNs / 1e6,
                    minMs: sorted[0] / 1e6,
                    maxMs: sorted[sorted.length - 1] / 1e6,
                    samples: results.length,
                    allMs: sorted.map(n => n / 1e6),
                });
            }
        }

        for (let i = 0; i < samples; i++) {
            setTimeout(() => doOnePing(), i * 50);
        }
    });
}

// ICMP ping RTT (more accurate for routers)
function measurePingRTT(host, count = 10) {
    return new Promise((resolve) => {
        exec(`ping -c ${count} -i 0.1 -W 2000 ${host}`, { timeout: 15000 }, (error, stdout) => {
            if (error || !stdout) return resolve(null);
            const times = [];
            for (const line of stdout.split('\n')) {
                const match = line.match(/time[=<](\d+\.?\d*)\s*ms/);
                if (match) times.push(parseFloat(match[1]));
            }
            if (times.length === 0) return resolve(null);
            const sorted = [...times].sort((a, b) => a - b);
            const trimmed = sorted.length >= 4 ? sorted.slice(1, -1) : sorted;
            const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
            const summaryMatch = stdout.match(/(\d+\.?\d*)\/(\d+\.?\d*)\/(\d+\.?\d*)\/(\d+\.?\d*)\s*ms/);
            resolve({
                avgMs: avg,
                minMs: sorted[0],
                maxMs: sorted[sorted.length - 1],
                jitterMs: summaryMatch ? parseFloat(summaryMatch[4]) : 0,
                samples: times.length,
                allMs: sorted,
            });
        });
    });
}

// ARP table for network device discovery
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
    const [scanData, arpTable] = await Promise.all([runScan(), getARPTable()]);
    let gatewayRTT = null;
    if (scanData.gatewayIP) {
        const [tcp, icmp] = await Promise.all([
            measureRTT(scanData.gatewayIP, 80, 5),
            measurePingRTT(scanData.gatewayIP, 10),
        ]);
        gatewayRTT = { host: scanData.gatewayIP, tcp, icmp };
    }
    return { ...scanData, arpTable, gatewayRTT };
}

function handleWSConnection(ws) {
    clients.add(ws);
    console.log(`Client connected (${clients.size} total)`);

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
                const msg = JSON.stringify(await fullScan());
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n  Wi-Fi RTT Triangulation Server`);
    console.log(`  Local: http://localhost:${PORT}`);
    console.log(`  Mode:  RSSI + RTT Hybrid`);
    console.log(`  Scan interval: ${SCAN_INTERVAL / 1000}s\n`);
});
