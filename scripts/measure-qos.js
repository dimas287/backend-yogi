const fs = require("fs");

const logPath = process.env.AIRWATCH_LOG_PATH || "/home/aurora/.pm2/logs/airwatch-out.log";
const outputPath = process.argv[2] || "/tmp/airwatch-qos-results.json";
const targetMessages = 6;
const websitePollIntervalMs = 5000;
const timeoutMs = 10 * 60 * 1000;

let logOffset = fs.statSync(logPath).size;
let logRemainder = "";
let lastWebsiteTimestamp = null;
let finished = false;
const metrics = [];
const websiteDetections = new Map();

function readNewLogData() {
  const currentSize = fs.statSync(logPath).size;
  if (currentSize <= logOffset) return;

  const length = currentSize - logOffset;
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(logPath, "r");
  fs.readSync(descriptor, buffer, 0, length, logOffset);
  fs.closeSync(descriptor);
  logOffset = currentSize;

  const lines = (logRemainder + buffer.toString("utf8")).split("\n");
  logRemainder = lines.pop() || "";
  for (const line of lines) {
    const markerIndex = line.indexOf("QOS_METRIC ");
    if (markerIndex < 0) continue;
    try {
      const metric = JSON.parse(line.slice(markerIndex + "QOS_METRIC ".length));
      if (metric.device !== "SECTOR_A2") continue;
      metrics.push(metric);
      console.log(`Pesan ${metrics.length}/${targetMessages}: ${metric.sensorTimestamp}, ${metric.payloadBytes} byte`);
      maybeFinish();
    } catch (error) {
      console.error("Baris QOS tidak dapat dibaca:", error.message);
    }
  }
}

async function pollWebsite() {
  try {
    const response = await fetch(`http://localhost:3001/api/current?t=${Date.now()}`, {
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const timestamp = payload?.SECTOR_A2?.current?.timestamp;
    if (timestamp && timestamp !== lastWebsiteTimestamp) {
      lastWebsiteTimestamp = timestamp;
      websiteDetections.set(timestamp, new Date().toISOString());
      maybeFinish();
    }
  } catch (error) {
    console.error("Polling website gagal:", error.message);
  }
}

function maybeFinish() {
  if (finished || metrics.length < targetMessages) return;
  const selected = metrics.slice(0, targetMessages);
  if (selected.some(metric => !websiteDetections.has(metric.sensorTimestamp))) return;

  finished = true;
  const result = {
    measuredAt: new Date().toISOString(),
    timezone: "Asia/Jakarta",
    websitePollIntervalMs,
    samples: selected.map(metric => ({
      ...metric,
      websiteReceivedAt: websiteDetections.get(metric.sensorTimestamp)
    }))
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Pengukuran selesai: ${outputPath}`);
  process.exit(0);
}

setInterval(readNewLogData, 250);
setInterval(pollWebsite, websitePollIntervalMs);
pollWebsite();

setTimeout(() => {
  if (finished) return;
  console.error(`Pengukuran timeout. Pesan terkumpul: ${metrics.length}/${targetMessages}`);
  process.exit(1);
}, timeoutMs);
