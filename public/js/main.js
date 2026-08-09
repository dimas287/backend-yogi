// ======================================================
// GLOBAL STATE
// ======================================================
let devices = {};
let selectedDeviceId = null;
let chart = null;
let pm25History = [];
let pm10History = [];
let aqiHistory = [];
let pm25Values = [];
let pm10Values = [];
let measureCount = 0;
let maxAqi = 0;
let maxAqiTime = '—';
let sumAqi = 0;
let lastPm25 = 0;
let lastPm10 = 0;
let windSpeedHistory = [];
let windDirectionHistory = [];
let windSamples24 = [];
let lastWindSampleTimestamp = null;
let lastWindSpeed = 0;
let lastWindDirection = 0;
let currentChartMode = 'both';
let isUpdating = false;
let chartHistoryLoadedDeviceId = null;
let lastCountedDataKey = null;
const DEBUG_LOGS = false;

let authToken = null;
let serverAuthProfile = null;
let authInitialized = false;
let currentRole = 'guest';
let currentMemberSection = 'dashboard';
let locationMap = null;
let locationMarkersLayer = null;

const UNHEALTHY_AQI_THRESHOLD = 101;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const alertStateByDevice = {};
let currentAlertSignature = null;
let dismissedAlertSignature = null;
let lastBrowserNotificationSignature = null;
let lastTelegramAlertSignature = null;

function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(url, { ...options, headers });
}

function debugLog(...args) {
  if (DEBUG_LOGS) console.log(...args);
}

function getDisplayDeviceName(deviceId) {
  return deviceId ? 'Alat Aktif' : '';
}

async function trackAndDisplayVisitorStats() {
  const statElements = {
    today: document.getElementById('visitorToday'),
    week: document.getElementById('visitorWeek'),
    month: document.getElementById('visitorMonth'),
    total: document.getElementById('visitorTotal')
  };
  if (Object.values(statElements).some(element => !element)) return;

  try {
    const response = await fetch('/api/visitors/track', { method: 'POST' });
    if (!response.ok) throw new Error(`Visitor stats failed: ${response.status}`);
    const stats = await response.json();
    const numberFormatter = new Intl.NumberFormat('id-ID');
    for (const [period, element] of Object.entries(statElements)) {
      element.textContent = numberFormatter.format(Number(stats[period] || 0));
    }
  } catch (error) {
    console.error('Error loading visitor stats:', error);
  }
}

// ======================================================
// CLOCK
// ======================================================
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('id-ID', { hour12: false });
  document.getElementById('dateLabel').textContent = new Date().toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ======================================================
// GAUGE
// ======================================================
function updateGauge(aqi) {
  const pct = Math.min(aqi / 500, 1);
  const totalLength = 251.2;
  const filled = pct * totalLength;
  document.getElementById('gaugeArc').style.strokeDashoffset = totalLength - filled;
  const angle = -90 + pct * 180;
  document.getElementById('gaugeNeedle').setAttribute('transform', `rotate(${angle}, 100, 100)`);
}

// ======================================================
// DEVICE SELECTOR & OVERVIEW
// ======================================================
function updateDeviceSelector() {
  const selector = document.getElementById('deviceSelector');
  if (!selector) return;
  selector.innerHTML = '';
  Object.keys(devices).forEach(deviceId => {
    const option = document.createElement('option');
    option.value = deviceId;
    option.textContent = getDisplayDeviceName(deviceId);
    if (deviceId === selectedDeviceId) option.selected = true;
    selector.appendChild(option);
  });
}

async function onDeviceChange(deviceId) {
  selectedDeviceId = deviceId;
  chartHistoryLoadedDeviceId = null;
  pm25History = []; pm10History = []; aqiHistory = [];
  pm25Values = []; pm10Values = [];
  measureCount = 0; maxAqi = 0; maxAqiTime = '—'; sumAqi = 0;
  lastCountedDataKey = null;
  lastPm25 = 0; lastPm10 = 0;
  windSamples24 = []; lastWindSampleTimestamp = null;
  windSpeedHistory = []; windDirectionHistory = [];

  chartWindowStart = getChartWindowStart();
  chartBuckets25 = Array(24).fill(null);
  chartBuckets10 = Array(24).fill(null);
  if (chart) {
    chart.data.labels = getChartLabels();
    chart.data.datasets[0].data = [...chartBuckets25];
    chart.data.datasets[1].data = [...chartBuckets10];
    chart.update();
  }
  await initializeHistory();
  await update();
}

function updateDevicesOverview() {
  const overviewContainer = document.getElementById('devicesOverview');
  if (!overviewContainer) return;
  overviewContainer.innerHTML = '';

  Object.keys(devices).forEach(deviceId => {
    const deviceData = devices[deviceId];
    if (!deviceData || !deviceData.current) return;
    const current = deviceData.current;
    const pm25 = parseFloat(current.pm25) || 0;
    const pm10 = parseFloat(current.pm10) || 0;
    const suhu = parseFloat(current.suhu) || 0;
    const kelembaban = parseFloat(current.kelembaban) || 0;
    const r25 = calcAQI(pm25, PM25_BREAKPOINTS);
    const r10 = calcAQI(pm10, PM10_BREAKPOINTS);
    const aqiFinal = Math.max(r25.aqi, r10.aqi);
    const dominant = aqiFinal === r25.aqi ? r25 : r10;
    const status = dominant.bp.cat;
    const statusColor = dominant.bp.color;

    const card = document.createElement('div');
    card.className = `device-overview-card ${deviceId === selectedDeviceId ? 'selected' : ''}`;
    card.onclick = () => onDeviceChange(deviceId);
    card.innerHTML = `
      <div class="device-overview-header">
        <div class="device-overview-name">${getDisplayDeviceName(deviceId)}</div>
        <div class="device-overview-status" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor};">${status}</div>
      </div>
      <div class="device-overview-metrics">
        <div class="device-overview-metric">
          <div class="device-overview-metric-value" style="color:#f97316">${pm25.toFixed(1)}</div>
          <div class="device-overview-metric-label">PM2.5</div>
        </div>
        <div class="device-overview-metric">
          <div class="device-overview-metric-value" style="color:#eab308">${pm10.toFixed(1)}</div>
          <div class="device-overview-metric-label">PM10</div>
        </div>
        <div class="device-overview-metric">
          <div class="device-overview-metric-value">${suhu.toFixed(1)}°</div>
          <div class="device-overview-metric-label">Suhu</div>
        </div>
        <div class="device-overview-metric">
          <div class="device-overview-metric-value">${kelembaban.toFixed(0)}%</div>
          <div class="device-overview-metric-label">Kelembaban</div>
        </div>
      </div>
      <div class="device-overview-aqi">
        <div class="device-overview-aqi-value" style="color:${dominant.bp.color}">${aqiFinal}</div>
        <div class="device-overview-aqi-label">AQI - ${dominant.bp.cat}</div>
      </div>
    `;
    overviewContainer.appendChild(card);
  });
}

// ======================================================
// FETCH CURRENT DATA
// ======================================================
async function fetchCurrentData() {
  try {
    const response = await apiFetch(`/api/current?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
    });

    if (response.status === 401) { handleUnauthorizedResponse(); return null; }
    if (response.status === 403) {
      setAuthMessage('Akses data ditolak untuk akun ini', true);
      devices = {};
      selectedDeviceId = null;
      updateDeviceSelector();
      updateDevicesOverview();
      return null;
    }
    if (!response.ok) throw new Error(`Fetch current failed: ${response.status}`);

    const allDevices = await response.json();
    devices = allDevices || {};

    const deviceIds = Object.keys(devices);
    if (deviceIds.length === 0) {
      selectedDeviceId = null;
      updateDeviceSelector();
      return null;
    }

    if (!selectedDeviceId || !devices[selectedDeviceId]) {
      selectedDeviceId = deviceIds[0];
      chartHistoryLoadedDeviceId = null;
    }

    updateDeviceSelector();

    if (selectedDeviceId && devices[selectedDeviceId]) {
      const deviceData = devices[selectedDeviceId].current || devices[selectedDeviceId];
      return {
        pm25: parseFloat(deviceData.pm25) || 0,
        pm10: parseFloat(deviceData.pm10) || 0,
        suhu: parseFloat(deviceData.suhu) || 0,
        kelembaban: parseFloat(deviceData.kelembaban) || 0,
        kecepatan_angin: parseFloat(deviceData.kecepatan_angin) || 0,
        arah_angin: deviceData.arah_angin || 0,
        timestamp: deviceData.timestamp || new Date().toISOString()
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching data:', error);
    return null;
  }
}

// ======================================================
// MAIN UPDATE
// ======================================================
async function update() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const data = await fetchCurrentData();
    if (!data) { updateDevicesOverview(); return; }

    const currentWindowStart = getChartWindowStart();
    if (chartWindowStart !== currentWindowStart) { chartWindowStart = currentWindowStart; chartHistoryLoadedDeviceId = null; }
    if (selectedDeviceId && chartHistoryLoadedDeviceId !== selectedDeviceId) {
      await initializeHistory();
      chartHistoryLoadedDeviceId = selectedDeviceId;
    }

    const { pm25, pm10, suhu, kelembaban, kecepatan_angin, arah_angin } = data;
    const now = new Date();

    const r25 = calcAQI(pm25, PM25_BREAKPOINTS);
    const r10 = calcAQI(pm10, PM10_BREAKPOINTS);
    const aqiFinal = Math.max(r25.aqi, r10.aqi);
    const dominant = aqiFinal === r25.aqi ? r25 : r10;
    const dominantParam = aqiFinal === r25.aqi ? 'PM2.5' : 'PM10';
    const dominantConc = aqiFinal === r25.aqi ? pm25 : pm10;

    const dataTimestamp = data.timestamp ? new Date(data.timestamp) : null;
    const safeDataTimestamp = dataTimestamp && !Number.isNaN(dataTimestamp.getTime()) ? dataTimestamp : null;
    const timeDiff = safeDataTimestamp ? now - safeDataTimestamp : Infinity;
    const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
    const dataKey = `${selectedDeviceId || 'unknown'}:${data.timestamp || ''}:${pm25}:${pm10}`;
    const isFreshMeasurement = !!safeDataTimestamp && daysDiff <= 1 && dataKey !== lastCountedDataKey;

    if (isFreshMeasurement) {
      const timeLabel = safeDataTimestamp.toLocaleTimeString('id-ID', { hour12: false });
      pm25History.push(pm25); if (pm25History.length > 24) pm25History.shift();
      pm10History.push(pm10); if (pm10History.length > 24) pm10History.shift();
      aqiHistory.push(aqiFinal); if (aqiHistory.length > 24) aqiHistory.shift();
      pm25Values.push(pm25); pm10Values.push(pm10);
      if (pm25Values.length > 24) pm25Values.shift();
      if (pm10Values.length > 24) pm10Values.shift();

      measureCount++;
      sumAqi += aqiFinal;
      if (aqiFinal > maxAqi) { maxAqi = aqiFinal; maxAqiTime = timeLabel; }
      lastCountedDataKey = dataKey;
    }

    const pm25Diff = (pm25 - lastPm25).toFixed(1);
    const pm10Diff = (pm10 - lastPm10).toFixed(1);
    lastPm25 = pm25; lastPm10 = pm10;
    const pm25MinValue = pm25Values.length ? Math.min(...pm25Values).toFixed(1) : '0.0';
    const pm25AvgValue = pm25Values.length ? (pm25Values.reduce((a, b) => a + b, 0) / pm25Values.length).toFixed(1) : '0.0';
    const pm25MaxValue = pm25Values.length ? Math.max(...pm25Values).toFixed(1) : '0.0';
    const pm10MinValue = pm10Values.length ? Math.min(...pm10Values).toFixed(1) : '0.0';
    const pm10AvgValue = pm10Values.length ? (pm10Values.reduce((a, b) => a + b, 0) / pm10Values.length).toFixed(1) : '0.0';
    const pm10MaxValue = pm10Values.length ? Math.max(...pm10Values).toFixed(1) : '0.0';

    // AQI
    const aqiEl = document.getElementById('aqiValue');
    aqiEl.textContent = aqiFinal;
    aqiEl.className = 'gauge-number live-val';
    aqiEl.style.color = dominant.bp.color;
    const statusEl = document.getElementById('aqiStatus');
    statusEl.textContent = dominant.bp.cat;
    statusEl.style.color = dominant.bp.color;
    statusEl.style.borderColor = dominant.bp.color;

    processAirQualityAlert(selectedDeviceId, aqiFinal, dominant.bp.cat, data.timestamp, pm25.toFixed(1), pm10.toFixed(1));
    updateGauge(aqiFinal);

    document.getElementById('fDominant').textContent = dominantParam;
    document.getElementById('fParam').textContent = dominantParam;
    document.getElementById('fConc').textContent = dominantConc + ' μg/m³';
    document.getElementById('fBpLo').textContent = dominant.bp.concLo + ' μg/m³';
    document.getElementById('fBpHi').textContent = dominant.bp.concHi + ' μg/m³';
    document.getElementById('fResult').textContent = aqiFinal;

    // PM2.5
    document.getElementById('pm25Value').textContent = pm25;
    document.getElementById('pm25Trend').textContent = (pm25Diff >= 0 ? '↗ +' : '↘ ') + pm25Diff;
    document.getElementById('pm25Trend').style.color = pm25Diff >= 0 ? '#ef4444' : '#22c55e';
    const pm25Pct = (pm25 / 500 * 100).toFixed(1);
    document.getElementById('pm25Bar').style.width = pm25Pct + '%';
    document.getElementById('pm25Indicator').style.left = pm25Pct + '%';
    document.getElementById('pm25BarLabel').textContent = pm25 + ' μg/m³';
    document.getElementById('pm25Min').textContent = pm25MinValue;
    document.getElementById('pm25Avg').textContent = pm25AvgValue;
    document.getElementById('pm25Max').textContent = pm25MaxValue;
    document.getElementById('pm25ConcCalc').textContent = pm25 + ' μg/m³';
    document.getElementById('pm25AqiCat').textContent = r25.bp.cat;
    document.getElementById('pm25AqiVal').textContent = r25.aqi;

    // PM10
    document.getElementById('pm10Value').textContent = pm10;
    document.getElementById('pm10Trend').textContent = (pm10Diff >= 0 ? '↗ +' : '↘ ') + pm10Diff;
    document.getElementById('pm10Trend').style.color = pm10Diff >= 0 ? '#ef4444' : '#22c55e';
    const pm10Pct = (pm10 / 600 * 100).toFixed(1);
    document.getElementById('pm10Bar').style.width = pm10Pct + '%';
    document.getElementById('pm10Indicator').style.left = pm10Pct + '%';
    document.getElementById('pm10BarLabel').textContent = pm10 + ' μg/m³';
    document.getElementById('pm10Min').textContent = pm10MinValue;
    document.getElementById('pm10Avg').textContent = pm10AvgValue;
    document.getElementById('pm10Max').textContent = pm10MaxValue;
    document.getElementById('pm10ConcCalc').textContent = pm10 + ' μg/m³';
    document.getElementById('pm10AqiCat').textContent = r10.bp.cat;
    document.getElementById('pm10AqiVal').textContent = r10.aqi;

    // Calc steps
    document.getElementById('cs25conc').textContent = pm25;
    document.getElementById('cs25bplo').textContent = r25.bp.concLo;
    document.getElementById('cs25bphi').textContent = r25.bp.concHi;
    document.getElementById('cs25aqilo').textContent = r25.bp.aqiLo;
    document.getElementById('cs25aqihi').textContent = r25.bp.aqiHi;
    document.getElementById('cs25result').textContent = r25.aqi;
    document.getElementById('cs10conc').textContent = pm10;
    document.getElementById('cs10bplo').textContent = r10.bp.concLo;
    document.getElementById('cs10bphi').textContent = r10.bp.concHi;
    document.getElementById('cs10aqilo').textContent = r10.bp.aqiLo;
    document.getElementById('cs10aqihi').textContent = r10.bp.aqiHi;
    document.getElementById('cs10result').textContent = r10.aqi;
    document.getElementById('csFinal').textContent = aqiFinal + ' (' + dominantParam + ')';

    ['sc0','sc1','sc2','sc3','sc4','sc5'].forEach(id => document.getElementById(id).classList.remove('active-scale'));
    document.getElementById(dominant.bp.scId).classList.add('active-scale');

    const bucketIndex = data.timestamp ? getChartBucketIndex(data.timestamp) : -1;
    if (bucketIndex >= 0) {
      chartBuckets25[bucketIndex] = pm25;
      chartBuckets10[bucketIndex] = pm10;
      chart.data.datasets[0].data[bucketIndex] = pm25;
      chart.data.datasets[1].data[bucketIndex] = pm10;
    }
    chart.update('quiet');

    document.getElementById('statMaxAqi').textContent = maxAqi;
    document.getElementById('statMaxTime').textContent = maxAqiTime;
    const avgAqi = measureCount > 0 ? Math.round(sumAqi / measureCount) : 0;
    document.getElementById('statAvgAqi').textContent = avgAqi;
    document.getElementById('statAvgCat').textContent = calcAQI(avgAqi, PM25_BREAKPOINTS).bp.cat;
    document.getElementById('statCount').textContent = measureCount;

    const statusElement = document.getElementById('systemStatus');
    const latencyElement = document.getElementById('statLatency');
    if (!safeDataTimestamp || daysDiff > 1) {
      statusElement.textContent = '● OFFLINE'; statusElement.style.color = '#ef4444';
      latencyElement.textContent = !safeDataTimestamp ? 'timestamp invalid' : Math.floor(daysDiff) + ' hari lalu';
    } else {
      statusElement.textContent = '● ONLINE'; statusElement.style.color = '#22c55e';
      latencyElement.textContent = '≤ 5 detik';
    }

    const tempValEl = document.getElementById('tempVal');
    if (tempValEl) tempValEl.textContent = suhu.toFixed(1) + '°C';
    const humidValEl = document.getElementById('humidVal');
    if (humidValEl) humidValEl.textContent = Math.round(kelembaban) + '%';

    const windSpeed = parseFloat(data.kecepatan_angin) || 0;
    const windDirection = parseWindDirectionValue(data.arah_angin);
    updateWindData(windSpeed, windDirection, data.timestamp);

    const formattedLastTime = safeDataTimestamp
      ? safeDataTimestamp.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    const selectedDeviceLabelEl = document.getElementById('selectedDeviceLabel');
    if (selectedDeviceLabelEl) selectedDeviceLabelEl.textContent = formattedLastTime;

    updateDevicesOverview();

    const lastUpdateEl = document.getElementById('lastUpdate');
    if (lastUpdateEl) {
      lastUpdateEl.textContent = 'Last Update: ' + (safeDataTimestamp
        ? safeDataTimestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        : '—');
    }
  } catch (error) {
    console.error('Error in update function:', error);
  } finally {
    isUpdating = false;
  }
}

// ======================================================
// INITIALIZE HISTORY
// ======================================================
async function initializeHistory() {
  if (!selectedDeviceId) return;
  try {
    const response = await apiFetch(`/api/history/${selectedDeviceId}`);
    if (response.status === 401) { handleUnauthorizedResponse(); return; }
    if (response.status === 403) {
      setAuthMessage(`Akses ditolak untuk device ${selectedDeviceId}`, true);
      chartHistoryLoadedDeviceId = null;
      return;
    }
    if (!response.ok) throw new Error(`Initialize history failed: ${response.status}`);

    const historyData = await response.json();
    pm25History = []; pm10History = []; aqiHistory = [];
    pm25Values = []; pm10Values = [];
    measureCount = 0; maxAqi = 0; maxAqiTime = '—'; sumAqi = 0;
    lastCountedDataKey = null;
    lastPm25 = 0; lastPm10 = 0;
    windSamples24 = []; windSpeedHistory = []; windDirectionHistory = [];
    lastWindSampleTimestamp = null;

    if (historyData && Object.keys(historyData).length > 0) {
      const historyValues = Object.values(historyData)
        .filter(d => d && d.timestamp)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      chartWindowStart = getChartWindowStart();
      chartBuckets25 = Array(24).fill(null);
      chartBuckets10 = Array(24).fill(null);

      historyValues.forEach(d => {
        const bucketIndex = getChartBucketIndex(d.timestamp);
        if (bucketIndex >= 0) {
          chartBuckets25[bucketIndex] = parseFloat(d.pm25) || 0;
          chartBuckets10[bucketIndex] = parseFloat(d.pm10) || 0;
        }
      });

      if (chart) {
        chart.data.labels = getChartLabels();
        chart.data.datasets[0].data = [...chartBuckets25];
        chart.data.datasets[1].data = [...chartBuckets10];
      }

      const inWindow = historyValues.filter(d => getChartBucketIndex(d.timestamp) >= 0);
      inWindow.forEach(d => addWindSample(parseFloat(d.kecepatan_angin) || 0, parseWindDirectionValue(d.arah_angin), d.timestamp));

      const last24 = inWindow.slice(-24);
      for (const d of last24) {
        const p25 = parseFloat(d.pm25) || 25;
        const p10 = parseFloat(d.pm10) || 60;
        const r25 = calcAQI(p25, PM25_BREAKPOINTS);
        const r10 = calcAQI(p10, PM10_BREAKPOINTS);
        const aqi = Math.max(r25.aqi, r10.aqi);
        pm25History.push(p25); pm10History.push(p10); aqiHistory.push(aqi);
        pm25Values.push(p25); pm10Values.push(p10);
        sumAqi += aqi; measureCount++;
        if (aqi > maxAqi) { maxAqi = aqi; maxAqiTime = new Date(d.timestamp || new Date()).toLocaleTimeString('id-ID'); }
        lastCountedDataKey = `${selectedDeviceId || 'unknown'}:${d.timestamp || ''}:${p25}:${p10}`;
        lastPm25 = p25; lastPm10 = p10;
      }
    } else {
      chartWindowStart = getChartWindowStart();
      chartBuckets25 = Array(24).fill(null);
      chartBuckets10 = Array(24).fill(null);
      if (chart) {
        chart.data.labels = getChartLabels();
        chart.data.datasets[0].data = [...chartBuckets25];
        chart.data.datasets[1].data = [...chartBuckets10];
      }
    }

    if (chart) chart.update();
  } catch (error) {
    console.error('Error initializing history:', error);
    chartWindowStart = getChartWindowStart();
    chartBuckets25 = Array(24).fill(null);
    chartBuckets10 = Array(24).fill(null);
    chartHistoryLoadedDeviceId = null;
    if (chart) { chart.data.labels = getChartLabels(); chart.data.datasets[0].data = [...chartBuckets25]; chart.data.datasets[1].data = [...chartBuckets10]; chart.update(); }
  }
}

// ======================================================
// MOBILE MENU
// ======================================================
function toggleMobileMenu() {
  document.getElementById('navbarRight').classList.toggle('active');
}

document.addEventListener('click', function (event) {
  const navbar = document.querySelector('.navbar');
  const navbarRight = document.getElementById('navbarRight');
  if (!navbar.contains(event.target) && navbarRight.classList.contains('active')) {
    navbarRight.classList.remove('active');
  }
});

// ======================================================
// DOWNLOAD CSV
// ======================================================
async function downloadCSV() {
  if (!selectedDeviceId) { alert('Please select a device first'); return; }
  const today = new Date().toISOString().split('T')[0];
  try {
    const response = await apiFetch(`/api/download/${selectedDeviceId}/${today}`);
    if (response.status === 401) { handleUnauthorizedResponse(); return; }
    if (response.status === 403) {
      alert(`Akses ditolak untuk device ${selectedDeviceId}`);
      return;
    }
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${selectedDeviceId}_${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (error) {
    console.error('Download CSV error:', error);
    alert('Gagal download CSV. Silakan login ulang dan coba lagi.');
  }
}

// ======================================================
// INIT
// ======================================================
window.addEventListener('load', async () => {
  trackAndDisplayVisitorStats();
  await initAuth();
  initMemberHandlers();
  initChart();
  await initializeHistory();
  await update();
  setInterval(() => update(), 5000);
});
