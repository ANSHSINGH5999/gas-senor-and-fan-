'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();

const CONFIG = {
  MAX_HISTORY      : 500,
  MAX_ALERTS       : 100,
  ESP32_TIMEOUT_MS : 10_000,
  GAS_DANGER_PPM   : 300,
  TEMP_DANGER_C    : 50,
};

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

let sensorData = {
  temp: 0, humidity: 0, gas: 0, fan: false,
  alarm: false, mode: 'auto', updatedAt: null,
  buzzerRemaining: 0, fanRemaining: 0,
  buzzerActive: false, fanTimerActive: false
};

// ── Control state — includes new OFF commands ──
let controlState = {
  mode         : 'auto',
  fan          : false,
  mute         : false,
  forceStopFan : false,   // NEW: force fan OFF from frontend
  forceStopBuzz: false,   // NEW: force buzzer OFF from frontend
  emergencyStop: false,   // NEW: kill everything
  updatedAt    : null
};

const history = [];
const alerts  = [];
const serverStartTime = Date.now();
let totalUpdates = 0;

const toBool   = v => v === true || v === 'true' || v === 1 || v === '1';
const isOnline = () => sensorData.updatedAt !== null &&
  (Date.now() - new Date(sensorData.updatedAt).getTime()) < CONFIG.ESP32_TIMEOUT_MS;
const dataAge  = () => sensorData.updatedAt
  ? Math.floor((Date.now() - new Date(sensorData.updatedAt).getTime()) / 1000) : null;

function pushToBuffer(buf, entry, max) { buf.push(entry); if (buf.length > max) buf.shift(); }
function checkAndLogAlert(data) {
  const reasons = [];
  if (data.alarm)                         reasons.push('ALARM_TRIGGERED');
  if (data.gas  >= CONFIG.GAS_DANGER_PPM) reasons.push(`GAS_HIGH(${data.gas}ppm)`);
  if (data.temp >= CONFIG.TEMP_DANGER_C)  reasons.push(`TEMP_HIGH(${data.temp}°C)`);
  if (reasons.length > 0)
    pushToBuffer(alerts, { ts: new Date().toISOString(), reasons, temp: data.temp, gas: data.gas }, CONFIG.MAX_ALERTS);
}
function formatUptime(s) {
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${Math.floor(s%60)}s`;
}

// ── Root ──
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) res.json({ service: 'AEGIS Sentinel Backend', version: '5.1.0', esp32: isOnline() ? 'ONLINE' : 'OFFLINE' });
  });
});

// ── Health ──
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    uptimeHuman: formatUptime(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    esp32Online: isOnline(),
    dataAge: dataAge(),
    historySize: history.length,
    alertCount: alerts.length,
    totalUpdates,
  });
});

// ── ESP32 → Push data ──
app.post('/update', (req, res) => {
  try {
    const { temp, gas, fan, alarm, humidity } = req.body || {};
    if (temp === undefined || gas === undefined)
      return res.status(400).json({ ok: false, error: 'Missing: temp, gas' });

    const tempVal = parseFloat(Number(temp).toFixed(2));
    const gasVal  = Math.max(0, parseInt(gas, 10));
    if (isNaN(tempVal) || isNaN(gasVal))
      return res.status(400).json({ ok: false, error: 'Invalid numbers' });

    const parsed = {
      temp: tempVal, gas: gasVal,
      humidity: parseFloat(humidity || 0),
      fan: toBool(fan), alarm: toBool(alarm),
      mode: controlState.mode,
      updatedAt: new Date().toISOString()
    };

    sensorData = { ...sensorData, ...parsed };
    totalUpdates++;
    pushToBuffer(history, { ...parsed, ts: Date.now() }, CONFIG.MAX_HISTORY);
    checkAndLogAlert(parsed);

    console.log(`📡 #${totalUpdates} temp=${parsed.temp}°C gas=${parsed.gas} fan=${parsed.fan} alarm=${parsed.alarm}`);
    res.json({ ok: true, receivedAt: parsed.updatedAt, seq: totalUpdates });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Frontend → Get sensor data ──
app.get('/data', (_req, res) => {
  res.json({ ...sensorData, esp32Online: isOnline(), dataAgeSeconds: dataAge(), control: controlState, totalUpdates });
});

// ── Frontend → Send control command ──
app.post('/control', (req, res) => {
  try {
    const { mode, fan, mute, forceStopFan, forceStopBuzz, emergencyStop } = req.body || {};

    if (mode !== undefined) {
      if (!['auto', 'manual'].includes(mode))
        return res.status(400).json({ ok: false, error: 'mode must be auto or manual' });
      controlState.mode = mode;
    }
    if (fan           !== undefined) controlState.fan          = toBool(fan);
    if (mute          !== undefined) controlState.mute         = toBool(mute);
    if (forceStopFan  !== undefined) controlState.forceStopFan = toBool(forceStopFan);
    if (forceStopBuzz !== undefined) controlState.forceStopBuzz= toBool(forceStopBuzz);
    if (emergencyStop !== undefined) controlState.emergencyStop= toBool(emergencyStop);

    controlState.updatedAt = new Date().toISOString();

    // ── Auto-reset forceStop flags after 5 seconds ──
    // (ESP32 only needs one pulse to detect rising edge)
    if (toBool(forceStopFan) || toBool(forceStopBuzz) || toBool(emergencyStop)) {
      setTimeout(() => {
        if (toBool(forceStopFan))  controlState.forceStopFan  = false;
        if (toBool(forceStopBuzz)) controlState.forceStopBuzz = false;
        if (toBool(emergencyStop)) controlState.emergencyStop = false;
        console.log('🔄 forceStop flags auto-reset');
      }, 5000);
    }

    console.log(`🎮 Control → mode=${controlState.mode} fan=${controlState.fan} mute=${controlState.mute} stopFan=${controlState.forceStopFan} stopBuzz=${controlState.forceStopBuzz} emergency=${controlState.emergencyStop}`);
    res.json({ ok: true, control: controlState });

  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── ESP32 → Fetch control ──
app.get('/control', (_req, res) => res.json(controlState));

// ── History ──
app.get('/history', (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), CONFIG.MAX_HISTORY);
  res.json({ count: history.slice(-limit).length, limit, data: history.slice(-limit) });
});

// ── Stats ──
app.get('/stats', (_req, res) => {
  if (history.length === 0) return res.json({ count: 0, message: 'No data yet' });
  const temps = history.map(h => h.temp).filter(v => !isNaN(v));
  const gases = history.map(h => h.gas).filter(v => !isNaN(v));
  const stat  = arr => ({ min: Math.min(...arr), max: Math.max(...arr), avg: parseFloat((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2)), latest: arr[arr.length-1] });
  res.json({ count: history.length, temperature: stat(temps), gas: stat(gases), totalAlerts: alerts.length });
});

// ── Alerts ──
app.get('/alerts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, CONFIG.MAX_ALERTS);
  res.json({ count: alerts.length, data: alerts.slice(-limit).reverse() });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ ok: false, error: 'Unexpected error' });
});

process.on('uncaughtException',  err => console.error('❌ UncaughtException:', err.message));
process.on('unhandledRejection', err => console.error('❌ UnhandledRejection:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  AEGIS BACKEND v5.1.0                 ║`);
  console.log(`║  Port: ${String(PORT).padEnd(29)}║`);
  console.log(`╚══════════════════════════════════════╝`);
});
