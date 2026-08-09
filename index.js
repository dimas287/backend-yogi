const mqtt = require("mqtt");
require('dotenv').config();
console.log('Env loaded, TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID);
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ================= FIREBASE =================
let serviceAccount;
let firebaseAvailable = false;
let db = null;

// Try to use environment variables first, fallback to file
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
  serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "1e0d8d6e1d56a4b124b375207451cf4072040d71",
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL || "firebase-adminsdk-fbsvc@air-quality-357a1.iam.gserviceaccount.com",
    client_id: process.env.FIREBASE_CLIENT_ID || "107361987441400167534",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40air-quality-357a1.iam.gserviceaccount.com",
    universe_domain: "googleapis.com"
  };
} else {
  // Fallback to file if available
  try {
    serviceAccount = require("./serviceAccountKey.json");
  } catch (e) {
    console.warn("Firebase credentials not found in environment variables or serviceAccountKey.json");
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://air-quality-357a1-default-rtdb.asia-southeast1.firebasedatabase.app/"
  });
  db = admin.database();
  firebaseAvailable = true;
}

const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_ALERT_THRESHOLD = Number(process.env.TELEGRAM_ALERT_THRESHOLD || 100);
const TELEGRAM_ENABLE_POLLING = process.env.TELEGRAM_ENABLE_POLLING !== "false";
const INACTIVE_DEVICE_IDS = new Set(
  (process.env.INACTIVE_DEVICE_IDS || "SECTOR_A1")
    .split(",")
    .map((id) => normalizeDeviceId(id))
    .filter(Boolean)
);
const ACTIVE_LOCATION_NAME = "Wilayah Tambang Batu Bara (PT SEMBADA COAL)";
const ACTIVE_LOCATION_LAT = -6.1306042;
const ACTIVE_LOCATION_LNG = 106.2601798;
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;
const lastActivityWriteCache = new Map();
const VISITOR_COOKIE_NAME = "airwatch_visitor_id";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2;

function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const cookie of cookieHeader.split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) continue;
    const cookieName = cookie.slice(0, separatorIndex).trim();
    if (cookieName !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separatorIndex + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function getJakartaDayStart(timestamp = Date.now()) {
  const jakartaOffsetMs = 7 * 60 * 60 * 1000;
  const jakartaDate = new Date(timestamp + jakartaOffsetMs);
  return Date.UTC(
    jakartaDate.getUTCFullYear(),
    jakartaDate.getUTCMonth(),
    jakartaDate.getUTCDate()
  ) - jakartaOffsetMs;
}

function getJakartaDateKey(timestamp = Date.now()) {
  const jakartaOffsetMs = 7 * 60 * 60 * 1000;
  return new Date(timestamp + jakartaOffsetMs).toISOString().slice(0, 10);
}

async function getWebVisitorStats() {
  const todayStart = getJakartaDayStart();
  const weekStart = todayStart - (6 * 24 * 60 * 60 * 1000);
  const monthStart = todayStart - (29 * 24 * 60 * 60 * 1000);
  const todayKey = getJakartaDateKey(todayStart);
  const weekStartKey = getJakartaDateKey(weekStart);
  const monthStartKey = getJakartaDateKey(monthStart);

  const [dailySnapshot, totalSnapshot] = await Promise.all([
    db.ref("webVisitorStats/dailyLastSeen").once("value"),
    db.ref("webVisitorStats/uniqueTotal").once("value")
  ]);

  const dailyCounts = dailySnapshot.val() || {};
  let today = 0;
  let week = 0;
  let month = 0;

  for (const [dateKey, rawCount] of Object.entries(dailyCounts)) {
    const count = Math.max(0, Number(rawCount || 0));
    if (dateKey >= monthStartKey && dateKey <= todayKey) month += count;
    if (dateKey >= weekStartKey && dateKey <= todayKey) week += count;
    if (dateKey === todayKey) today += count;
  }

  return {
    today,
    week,
    month,
    total: Number(totalSnapshot.val() || 0)
  };
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "unknown";
}

function normalizeRole(role) {
  if (role === "admin") return "admin";
  if (role === "guest") return "guest";
  return "user";
}

function buildGuestUser() {
  return {
    uid: "guest",
    email: null,
    role: "guest",
    enabled: true,
    devices: ["*"]
  };
}

async function buildRequestUser(decodedToken) {
  const uid = decodedToken.uid;
  const profileSnap = await db.ref(`users/${uid}`).once("value");
  const profile = profileSnap.val() || {};

  return {
    uid,
    email: decodedToken.email || profile.email || null,
    role: normalizeRole(profile.role || decodedToken.role),
    enabled: profile.enabled !== false,
    devices: Array.isArray(profile.devices) ? profile.devices : [],
    name: profile.name || "",
    phone: profile.phone || "",
    department: profile.department || "",
    approvalStatus: profile.approvalStatus || (profile.enabled === false ? "pending" : "approved"),
    createdAt: profile.createdAt || null,
    lastLoginAt: profile.lastLoginAt || null,
    lastLoginIp: profile.lastLoginIp || null,
    lastActivityAt: profile.lastActivityAt || null,
    lastActivityIp: profile.lastActivityIp || null
  };
}

async function touchUserActivity(uid, req, options = {}) {
  if (!uid || uid === "guest") return;

  const markLogin = options.markLogin === true;
  const nowMs = Date.now();
  const lastWriteAt = lastActivityWriteCache.get(uid) || 0;
  if (!markLogin && nowMs - lastWriteAt < ACTIVITY_WRITE_INTERVAL_MS) {
    return;
  }

  const nowIso = new Date(nowMs).toISOString();
  const updatePayload = {
    lastActivityAt: nowIso,
    lastActivityIp: getClientIp(req),
    lastActivityPath: req.originalUrl || req.path || ""
  };

  if (markLogin) {
    updatePayload.lastLoginAt = nowIso;
    updatePayload.lastLoginIp = getClientIp(req);
  }

  await db.ref(`users/${uid}`).update(updatePayload);
  lastActivityWriteCache.set(uid, nowMs);
}

async function optionalAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        const user = await buildRequestUser(decoded);
        req.user = user.enabled ? user : buildGuestUser();
        return next();
      } catch (tokenError) {
        // invalid token — fall through to guest/dev
      }
    }

    if (!AUTH_REQUIRED) {
      req.user = buildGuestUser();
      return next();
    }

    req.user = buildGuestUser();
    next();
  } catch (error) {
    req.user = buildGuestUser();
    next();
  }
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const user = await buildRequestUser(decoded);

    if (!user.enabled) {
      return res.status(403).json({ error: "User account is disabled" });
    }

    req.user = user;
    await touchUserActivity(user.uid, req).catch((error) => {
      console.error("Failed to update user activity:", error.message || error);
    });
    next();
  } catch (error) {
    console.error("Auth error:", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin role required" });
  }
  next();
}

function normalizeDeviceId(deviceId) {
  return String(deviceId || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function canAccessDevice(user, deviceId) {
  if (!user) return false;
  if (!isActiveDeviceId(deviceId)) return false;
  if (user.role === "admin" || user.role === "guest") return true;

  if (!Array.isArray(user.devices)) return false;
  if (user.devices.includes("*")) return true;
  if (user.role === "user" && user.devices.length === 0) return true;

  const requested = normalizeDeviceId(deviceId);
  return user.devices.some((id) => normalizeDeviceId(id) === requested);
}

function isActiveDeviceId(deviceId) {
  return !INACTIVE_DEVICE_IDS.has(normalizeDeviceId(deviceId));
}

function filterDevicesByAccess(devicesObj, user) {
  const allowed = {};
  for (const deviceId of Object.keys(devicesObj || {})) {
    if (isActiveDeviceId(deviceId) && (user.role === "admin" || user.role === "guest" || canAccessDevice(user, deviceId))) {
      allowed[deviceId] = devicesObj[deviceId];
    }
  }
  return allowed;
}

function pickCurrentDevices(devicesObj) {
  const currentDevices = {};
  for (const [deviceId, value] of Object.entries(devicesObj || {})) {
    if (value && value.current) {
      currentDevices[deviceId] = { current: value.current };
    }
  }
  return currentDevices;
}

async function getHistoryByDate(device, date) {
  const snapshot = await db.ref(`devices/${device}/history`)
    .limitToLast(5000)
    .once("value");

  const allHistory = snapshot.val() || {};
  const filtered = {};

  Object.entries(allHistory).forEach(([key, value]) => {
    const ts = value?.timestamp;
    if (typeof ts === "string" && ts.startsWith(date)) {
      filtered[key] = value;
    }
  });

  return filtered;
}

const PM25_BREAKPOINTS = [
  { concLo: 0.0, concHi: 12.0, aqiLo: 0, aqiHi: 50, cat: "BAIK", color: "🟢" },
  { concLo: 12.1, concHi: 35.4, aqiLo: 51, aqiHi: 100, cat: "SEDANG", color: "🟡" },
  { concLo: 35.5, concHi: 55.4, aqiLo: 101, aqiHi: 150, cat: "TIDAK SEHAT*", color: "🟠" },
  { concLo: 55.5, concHi: 150.4, aqiLo: 151, aqiHi: 200, cat: "TIDAK SEHAT", color: "🔴" },
  { concLo: 150.5, concHi: 250.4, aqiLo: 201, aqiHi: 300, cat: "SANGAT TIDAK SEHAT", color: "🟣" },
  { concLo: 250.5, concHi: 500.4, aqiLo: 301, aqiHi: 500, cat: "BERBAHAYA", color: "🔴" }
];

const PM10_BREAKPOINTS = [
  { concLo: 0, concHi: 54, aqiLo: 0, aqiHi: 50, cat: "BAIK", color: "🟢" },
  { concLo: 55, concHi: 154, aqiLo: 51, aqiHi: 100, cat: "SEDANG", color: "🟡" },
  { concLo: 155, concHi: 254, aqiLo: 101, aqiHi: 150, cat: "TIDAK SEHAT*", color: "🟠" },
  { concLo: 255, concHi: 354, aqiLo: 151, aqiHi: 200, cat: "TIDAK SEHAT", color: "🔴" },
  { concLo: 355, concHi: 424, aqiLo: 201, aqiHi: 300, cat: "SANGAT TIDAK SEHAT", color: "🟣" },
  { concLo: 425, concHi: 604, aqiLo: 301, aqiHi: 500, cat: "BERBAHAYA", color: "🔴" }
];

function calcAQI(conc, breakpoints) {
  const safeConc = Math.max(0, Number(conc) || 0);
  let bp = breakpoints[breakpoints.length - 1];
  for (const item of breakpoints) {
    if (safeConc >= item.concLo && safeConc <= item.concHi) {
      bp = item;
      break;
    }
  }

  const rawAqi = ((bp.aqiHi - bp.aqiLo) / (bp.concHi - bp.concLo)) * (safeConc - bp.concLo) + bp.aqiLo;
  return { aqi: Math.min(Math.max(Math.round(rawAqi), 0), 500), bp };
}

function getAirQualitySummary(pm25, pm10) {
  const pm25Result = calcAQI(pm25, PM25_BREAKPOINTS);
  const pm10Result = calcAQI(pm10, PM10_BREAKPOINTS);
  const dominant = pm25Result.aqi >= pm10Result.aqi ? pm25Result : pm10Result;
  const dominantParam = pm25Result.aqi >= pm10Result.aqi ? "PM2.5" : "PM10";

  return {
    pm25Aqi: pm25Result.aqi,
    pm10Aqi: pm10Result.aqi,
    finalAqi: dominant.aqi,
    category: dominant.bp.cat,
    color: dominant.bp.color,
    dominantParam
  };
}

function getStatus(pm25, pm10 = 0) {
  return getAirQualitySummary(pm25, pm10).category;
}

function sanitizeRow(row) {
  const pm25 = Number(row.pm25) || 0;
  const pm10 = Number(row.pm10) || 0;
  const summary = getAirQualitySummary(pm25, pm10);
  
  // Validate and correct timestamp
  const validatedTimestamp = validateAndCorrectTimestamp(row.timestamp || new Date().toISOString());

  return {
    timestamp: validatedTimestamp,
    pm25,
    pm10,
    suhu: Number(row.suhu) || 0,
    kelembaban: Number(row.kelembaban) || 0,
    kecepatan_angin: Number(row.kecepatan_angin) || 0,
    arah_angin: row.arah_angin || 0,
    status: summary.category,
    aqi: summary.finalAqi,
    pm25_aqi: summary.pm25Aqi,
    pm10_aqi: summary.pm10Aqi,
    dominant_parameter: summary.dominantParam
  };
}
// Convert wind direction degrees to compass direction
function getCompassDirection(degrees) {
  const directions = ['⬆️ U', '↗️ TL', '➡️ T', '↘️ TG', '⬇️ S', '↙️ BD', '⬅️ B', '↖️ BL'];
  const index = Math.round(((degrees % 360) / 45)) % 8;
  const names = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut'];
  return names[index];
}

// Validate and correct RTC timestamp - if before 2023, use current time (WIB)
function validateAndCorrectTimestamp(timestamp) {
  try {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    
    // If year is before 2023, RTC probably wasn't set correctly
    if (year < 2023) {
      // Get current time in WIB (UTC+7)
      const now = new Date();
      const wibTime = new Date(now.getTime() + (7 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60 * 1000));
      return wibTime.toISOString();
    }
    
    return timestamp;
  } catch (e) {
    // If parsing fails, use current time
    return new Date().toISOString();
  }
}

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function getDateOnlyFromTimestamp(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isRowWithinDateRange(timestamp, startDate, endDate) {
  const dateOnly = getDateOnlyFromTimestamp(timestamp);
  if (!dateOnly) return false;
  if (startDate && dateOnly < startDate) return false;
  if (endDate && dateOnly > endDate) return false;
  return true;
}

function parseMemberTableQuery(req) {
  const limitRaw = parseInt(req.query.limit || "500", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 5000)
    : 500;

  const requestedDevice = typeof req.query.device === "string"
    ? req.query.device.trim()
    : "";

  const startDate = typeof req.query.startDate === "string"
    ? req.query.startDate.trim()
    : "";

  const endDate = typeof req.query.endDate === "string"
    ? req.query.endDate.trim()
    : "";

  if (startDate && !isValidDateOnly(startDate)) {
    throw new Error("startDate must use format YYYY-MM-DD");
  }

  if (endDate && !isValidDateOnly(endDate)) {
    throw new Error("endDate must use format YYYY-MM-DD");
  }

  if (startDate && endDate && startDate > endDate) {
    throw new Error("startDate cannot be greater than endDate");
  }

  return { limit, requestedDevice, startDate, endDate };
}

async function getMemberTableRows(user, options) {
  const { requestedDevice, startDate, endDate, limit } = options;

  const deviceIds = requestedDevice
    ? [requestedDevice]
    : await getAccessibleDeviceIds(user);

  const rows = [];
  const readLimit = (startDate || endDate)
    ? Math.min(Math.max(limit, 5000), 10000)
    : limit;

  for (const deviceId of deviceIds) {
    const snap = await db.ref(`devices/${deviceId}/history`).limitToLast(readLimit).once("value");
    const history = snap.val() || {};

    Object.entries(history).forEach(([entryKey, value]) => {
      const row = {
        device: deviceId,
        entryKey,
        ...sanitizeRow(value)
      };

      if (!isRowWithinDateRange(row.timestamp, startDate, endDate)) return;
      rows.push(row);
    });
  }

  rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return rows.slice(0, limit);
}

async function getAccessibleDeviceIds(user) {
  const deviceSnapshot = await db.ref("devices").once("value");
  const allIds = Object.keys(deviceSnapshot.val() || {}).filter(isActiveDeviceId);

  if (user.role === "admin" || user.role === "guest") return allIds;
  if (Array.isArray(user.devices) && user.devices.includes("*")) return allIds;
  if (user.role === "user" && (!Array.isArray(user.devices) || user.devices.length === 0)) return allIds;

  return allIds.filter((id) => canAccessDevice(user, id));
}

// ================= MQTT =================
const options = {
  host: "3f45b22d5630410eae9db48c42d47df2.s1.eu.hivemq.cloud",
  port: 8883,
  protocol: "mqtts",
  username: "naufalyogi",
  password: "Naufalyogi123"
};

if (firebaseAvailable) {
  const client = mqtt.connect(options);

  client.on("connect", () => {
    console.log("MQTT Connected");
    client.subscribe("air/#");
  });

  client.on("message", async (topic, message) => {
    try {
      const backendReceivedAt = new Date();
      const payloadBytes = Buffer.byteLength(message);
      const data = JSON.parse(message.toString());
      const deviceID = data.device;
      if (!isActiveDeviceId(deviceID)) {
        console.log("Ignoring inactive device:", deviceID);
        return;
      }
      
      // Validate and correct timestamp
      const validatedTimestamp = validateAndCorrectTimestamp(data.timestamp || new Date().toISOString());
      
      const summary = getAirQualitySummary(data.pm25, data.pm10);

      const finalData = {
        ...data,
        status: summary.category,
        aqi: summary.finalAqi,
        pm25_aqi: summary.pm25Aqi,
        pm10_aqi: summary.pm10Aqi,
        dominant_parameter: summary.dominantParam,
        timestamp: validatedTimestamp
      };

      console.log("Final data to save:", finalData);
      
      // Log if timestamp was corrected
      if (data.timestamp && validatedTimestamp !== data.timestamp) {
        console.warn("Timestamp corrected from", data.timestamp, "to", validatedTimestamp);
      }

      await db.ref(`devices/${deviceID}/current`).set(finalData);
      await db.ref(`devices/${deviceID}/history`).push(finalData);

      const cloudSavedAt = new Date();
      console.log("QOS_METRIC", JSON.stringify({
        device: deviceID,
        sensorTimestamp: finalData.timestamp,
        backendReceivedAt: backendReceivedAt.toISOString(),
        cloudSavedAt: cloudSavedAt.toISOString(),
        payloadBytes
      }));
      console.log("Saved to Firebase:", deviceID, "with timestamp:", finalData.timestamp);
    } catch (err) {
      console.log("Error:", err);
    }
  });
} else {
  console.warn("MQTT disabled because Firebase is not configured");
}

async function notifyAdminNewSignup(payload) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const message = [
    "🔔 PENDAFTARAN AKUN BARU (MENUNGGU APPROVAL)",
    "",
    `Nama: ${payload.name || "-"}`,
    `Email: ${payload.email || "-"}`,
    `No HP: ${payload.phone || "-"}`,
    `Departemen: ${payload.department || "-"}`,
    `IP: ${payload.createdIp || "-"}`,
    `Waktu: ${payload.createdAt || "-"}`,
    "",
    "Silakan buka panel Admin untuk Approve/Reject user ini."
  ].join("\n");

  await sendTelegramMessage(message, TELEGRAM_CHAT_ID);
}

app.use("/api", (req, res, next) => {
  if (firebaseAvailable) return next();
  res.status(503).json({
    error: "Firebase is not configured",
    detail: "Add serviceAccountKey.json or FIREBASE_* environment variables, then restart airwatch."
  });
});

app.post("/api/visitors/track", async (req, res) => {
  try {
    let visitorId = getCookieValue(req, VISITOR_COOKIE_NAME);
    if (!/^[a-f0-9-]{36}$/i.test(visitorId)) {
      visitorId = crypto.randomUUID();
    }

    const nowIso = new Date().toISOString();
    const todayKey = getJakartaDateKey();
    let createdVisitor = false;
    let previousVisitDay = "";
    await db.ref(`webVisitors/${visitorId}`).transaction((current) => {
      createdVisitor = !current;
      previousVisitDay = current?.lastSeenDay || "";
      return {
        firstSeenAt: current?.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
        lastSeenDay: todayKey
      };
    });

    const counterUpdates = {};
    if (createdVisitor) {
      counterUpdates["webVisitorStats/uniqueTotal"] = admin.database.ServerValue.increment(1);
    }
    if (previousVisitDay !== todayKey) {
      counterUpdates[`webVisitorStats/dailyLastSeen/${todayKey}`] = admin.database.ServerValue.increment(1);
      if (previousVisitDay) {
        counterUpdates[`webVisitorStats/dailyLastSeen/${previousVisitDay}`] = admin.database.ServerValue.increment(-1);
      }
    }
    if (Object.keys(counterUpdates).length > 0) {
      await db.ref().update(counterUpdates);
    }

    const isSecureRequest = req.secure || req.headers["x-forwarded-proto"] === "https";
    const cookieParts = [
      `${VISITOR_COOKIE_NAME}=${encodeURIComponent(visitorId)}`,
      "Path=/",
      `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
      "HttpOnly",
      "SameSite=Lax"
    ];
    if (isSecureRequest) cookieParts.push("Secure");
    res.set("Set-Cookie", cookieParts.join("; "));
    res.set("Cache-Control", "no-store");
    res.json(await getWebVisitorStats());
  } catch (error) {
    console.error("Failed to track web visitor:", error.message || error);
    res.status(500).json({ error: "Gagal memuat statistik pengunjung" });
  }
});

app.get("/api/current", optionalAuth, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const snapshot = await db.ref("devices").once("value");
  const allDevices = snapshot.val() || {};
  res.json(pickCurrentDevices(filterDevicesByAccess(allDevices, req.user)));
});

app.get("/api/history/:device", optionalAuth, async (req, res) => {
  const device = req.params.device;
  if (!canAccessDevice(req.user, device)) {
    return res.status(403).json({ error: "Access denied for this device" });
  }

  const snapshot = await db.ref(`devices/${device}/history`)
    .limitToLast(2000)
    .once("value");
  res.json(snapshot.val() || {});
});

app.get("/api/history/:device/:date", optionalAuth, async (req, res) => {
  const { device, date } = req.params;
  if (!canAccessDevice(req.user, device)) {
    return res.status(403).json({ error: "Access denied for this device" });
  }

  const data = await getHistoryByDate(device, date);
  res.json(data);
});

app.get("/api/download/:device/:date", requireAuth, async (req, res) => {
  const { device, date } = req.params;
  if (!canAccessDevice(req.user, device)) {
    return res.status(403).json({ error: "Access denied for this device" });
  }

  const data = await getHistoryByDate(device, date);

  if (!data || Object.keys(data).length === 0) return res.send("No Data");

  let csv = "timestamp,pm25,pm10,suhu,kelembaban,kecepatan_angin,arah_angin,status\n";

  Object.values(data).forEach((d) => {
    csv += `${d.timestamp},${d.pm25},${d.pm10},${d.suhu},${d.kelembaban},${d.kecepatan_angin},${d.arah_angin},${d.status}\n`;
  });

  res.header("Content-Type", "text/csv");
  res.attachment(`${device}_${date}.csv`);
  res.send(csv);
});

app.post("/api/alerts/telegram", requireAuth, async (req, res) => {
  try {
    const { title, message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(503).json({ error: "Telegram is not configured" });
    }

    const header = title ? `<b>${String(title)}</b>\n` : "";
    const payload = `${header}${String(message)}`;

    await sendTelegramMessage(payload, TELEGRAM_CHAT_ID, "HTML");
    res.json({ ok: true });
  } catch (error) {
    console.error("Telegram alert error:", error.message || error);
    res.status(500).json({ error: "Failed to send Telegram alert" });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, name, phone, department } = req.body || {};

    if (!email || !password || !name || !phone) {
      return res.status(400).json({ error: "email, password, name, and phone are required" });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }

    const userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: String(password),
      displayName: String(name).trim(),
      disabled: true
    });

    await admin.auth().setCustomUserClaims(userRecord.uid, { role: "user" });

    const createdAt = new Date().toISOString();
    const createdIp = getClientIp(req);

    await db.ref(`users/${userRecord.uid}`).set({
      name: String(name).trim(),
      phone: String(phone).trim(),
      department: department ? String(department).trim() : "",
      email: String(email).trim(),
      role: "user",
      enabled: false,
      approvalStatus: "pending",
      devices: ["*"],
      createdAt,
      createdIp,
      createdBy: "self-signup"
    });

    await notifyAdminNewSignup({
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      department: department ? String(department).trim() : "",
      createdIp,
      createdAt
    }).catch((error) => {
      console.warn("Failed to notify admin about signup:", error.message || error);
    });

    res.status(201).json({
      ok: true,
      message: "Pendaftaran berhasil. Akun menunggu persetujuan admin sebelum bisa login."
    });
  } catch (error) {
    console.error("Signup error:", error);
    if (error && error.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Email sudah terdaftar" });
    }
    res.status(500).json({ error: "Failed to process signup" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const { uid } = req.user;
  await touchUserActivity(uid, req, { markLogin: true }).catch((error) => {
    console.error("Failed to update login activity:", error.message || error);
  });

  const profileSnap = await db.ref(`users/${uid}`).once("value");
  const profile = profileSnap.val() || {};

  res.json({
    uid,
    email: req.user.email || profile.email || null,
    role: req.user.role,
    devices: Array.isArray(profile.devices) ? profile.devices : req.user.devices,
    name: profile.name || "",
    phone: profile.phone || "",
    department: profile.department || "",
    approvalStatus: profile.approvalStatus || (profile.enabled === false ? "pending" : "approved"),
    createdAt: profile.createdAt || null,
    lastLoginAt: profile.lastLoginAt || null,
    lastLoginIp: profile.lastLoginIp || null,
    lastActivityAt: profile.lastActivityAt || null,
    lastActivityIp: profile.lastActivityIp || null,
    authRequired: AUTH_REQUIRED
  });
});

app.patch("/api/me/profile", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { name, phone, department } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: "name and phone are required" });
    }

    const payload = {
      name: String(name).trim(),
      phone: String(phone).trim(),
      department: department ? String(department).trim() : "",
      updatedAt: new Date().toISOString(),
      updatedBy: uid
    };

    await db.ref(`users/${uid}`).update(payload);
    await admin.auth().updateUser(uid, { displayName: payload.name });

    const profileSnap = await db.ref(`users/${uid}`).once("value");
    const profile = profileSnap.val() || {};

    res.json({
      ok: true,
      profile: {
        uid,
        email: req.user.email || profile.email || null,
        role: req.user.role,
        devices: Array.isArray(profile.devices) ? profile.devices : req.user.devices,
        name: profile.name || "",
        phone: profile.phone || "",
        department: profile.department || "",
        approvalStatus: profile.approvalStatus || (profile.enabled === false ? "pending" : "approved"),
        createdAt: profile.createdAt || null,
        lastLoginAt: profile.lastLoginAt || null,
        lastLoginIp: profile.lastLoginIp || null,
        lastActivityAt: profile.lastActivityAt || null,
        lastActivityIp: profile.lastActivityIp || null,
        authRequired: AUTH_REQUIRED
      }
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

app.get("/api/member/table", requireAuth, async (req, res) => {
  try {
    const query = parseMemberTableQuery(req);
    const { requestedDevice } = query;

    if (requestedDevice && !canAccessDevice(req.user, requestedDevice)) {
      return res.status(403).json({ error: "Access denied for this device" });
    }

    const rows = await getMemberTableRows(req.user, query);
    res.json({ rows });
  } catch (error) {
    if (/startDate|endDate/.test(String(error.message || ""))) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Member table error:", error);
    res.status(500).json({ error: "Failed to load member table" });
  }
});

app.get("/api/member/table/download", requireAuth, async (req, res) => {
  try {
    const query = parseMemberTableQuery(req);
    const { requestedDevice, startDate, endDate } = query;

    if (requestedDevice && !canAccessDevice(req.user, requestedDevice)) {
      return res.status(403).json({ error: "Access denied for this device" });
    }

    const rows = await getMemberTableRows(req.user, query);

    let csv = "timestamp,device,pm25,pm10,suhu,kelembaban,kecepatan_angin,arah_angin,status\n";
    rows.forEach((row) => {
      csv += `${row.timestamp},${row.device},${row.pm25},${row.pm10},${row.suhu},${row.kelembaban},${row.kecepatan_angin},${row.arah_angin},${row.status}\n`;
    });

    const safeDevice = (requestedDevice || "all")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .toLowerCase();
    const dateStart = startDate || "awal";
    const dateEnd = endDate || "akhir";
    const filename = `member_${safeDevice}_${dateStart}_${dateEnd}.csv`;

    res.header("Content-Type", "text/csv");
    res.attachment(filename);
    res.send(csv);
  } catch (error) {
    if (/startDate|endDate/.test(String(error.message || ""))) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Member table download error:", error);
    res.status(500).json({ error: "Failed to download member table CSV" });
  }
});

app.get("/api/member/locations", requireAuth, async (req, res) => {
  try {
    const deviceIds = await getAccessibleDeviceIds(req.user);
    const locationSnap = await db.ref("deviceLocations").once("value");
    const allLocations = locationSnap.val() || {};

    const rows = deviceIds.map((device) => {
      const loc = allLocations[device] || {};
      return {
        device,
        name: loc.name || ACTIVE_LOCATION_NAME,
        lat: Number(loc.lat) || ACTIVE_LOCATION_LAT,
        lng: Number(loc.lng) || ACTIVE_LOCATION_LNG,
        updatedAt: loc.updatedAt || null,
        updatedBy: loc.updatedBy || null
      };
    });

    res.json({ locations: rows });
  } catch (error) {
    console.error("Member locations error:", error);
    res.status(500).json({ error: "Failed to load locations" });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const list = await admin.auth().listUsers(1000);

    const users = await Promise.all(list.users.map(async (u) => {
      const profileSnap = await db.ref(`users/${u.uid}`).once("value");
      const profile = profileSnap.val() || {};

      return {
        uid: u.uid,
        email: u.email || null,
        displayName: u.displayName || profile.name || "",
        phone: profile.phone || "",
        department: profile.department || "",
        disabled: !!u.disabled,
        role: normalizeRole(profile.role || (u.customClaims && u.customClaims.role)),
        enabled: profile.enabled !== false,
        approvalStatus: profile.approvalStatus || (profile.enabled === false ? "pending" : "approved"),
        createdAt: profile.createdAt || (u.metadata?.creationTime ? new Date(u.metadata.creationTime).toISOString() : null),
        lastLoginAt: profile.lastLoginAt || null,
        lastLoginIp: profile.lastLoginIp || null,
        lastActivityAt: profile.lastActivityAt || null,
        lastActivityIp: profile.lastActivityIp || null,
        devices: Array.isArray(profile.devices) ? profile.devices : []
      };
    }));

    res.json({ users });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ error: "Failed to list users" });
  }
});

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name, role, devices, phone, department } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const safeRole = normalizeRole(role);
    const inputDevices = Array.isArray(devices) ? devices : [];
    const safeDevices = safeRole === "user" && inputDevices.length === 0
      ? ["*"]
      : inputDevices;

    const userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: String(password),
      displayName: name || ""
    });

    await admin.auth().setCustomUserClaims(userRecord.uid, { role: safeRole });

    await db.ref(`users/${userRecord.uid}`).set({
      name: name || "",
      phone: phone || "",
      department: department || "",
      email,
      role: safeRole,
      enabled: true,
      approvalStatus: "approved",
      devices: safeDevices,
      createdAt: new Date().toISOString(),
      createdIp: getClientIp(req),
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.uid,
      createdBy: req.user.uid
    });

    res.status(201).json({ uid: userRecord.uid, email, role: safeRole, devices: safeDevices });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.patch("/api/admin/users/:uid/role", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const safeRole = normalizeRole(req.body.role);

    await admin.auth().setCustomUserClaims(uid, { role: safeRole });
    await db.ref(`users/${uid}`).update({ role: safeRole, updatedAt: new Date().toISOString(), updatedBy: req.user.uid });

    res.json({ uid, role: safeRole });
  } catch (error) {
    console.error("Update role error:", error);
    res.status(500).json({ error: "Failed to update role" });
  }
});

app.patch("/api/admin/users/:uid/approval", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const action = String(req.body?.action || "").toLowerCase();

    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: "action must be approve or reject" });
    }
    const nowIso = new Date().toISOString();
    if (action === "approve") {
      await admin.auth().updateUser(uid, { disabled: false });
      await db.ref(`users/${uid}`).update({
        enabled: true,
        approvalStatus: "approved",
        approvedAt: nowIso,
        approvedBy: req.user.uid,
        updatedAt: nowIso,
        updatedBy: req.user.uid
      });
      return res.json({ uid, action, enabled: true, approvalStatus: "approved" });
    }
    await admin.auth().updateUser(uid, { disabled: true });
    await db.ref(`users/${uid}`).update({
      enabled: false,
      approvalStatus: "rejected",
      rejectedAt: nowIso,
      rejectedBy: req.user.uid,
      updatedAt: nowIso,
      updatedBy: req.user.uid
    });
    res.json({ uid, action, enabled: false, approvalStatus: "rejected" });
  } catch (error) {
    console.error("Update approval error:", error);
    res.status(500).json({ error: "Failed to update approval" });
  }
});

app.patch("/api/admin/users/:uid/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const enabled = req.body.enabled !== false;
    const profileSnap = await db.ref(`users/${uid}`).once("value");
    const profile = profileSnap.val() || {};

    await admin.auth().updateUser(uid, { disabled: !enabled });

    const updatePayload = {
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid
    };

    if (enabled) {
      updatePayload.approvalStatus = "approved";
      if (!profile.approvedAt) {
        updatePayload.approvedAt = new Date().toISOString();
      }
      if (!profile.approvedBy) {
        updatePayload.approvedBy = req.user.uid;
      }
    } else if ((profile.approvalStatus || "") !== "pending") {
      updatePayload.approvalStatus = "disabled";
    }

    await db.ref(`users/${uid}`).update(updatePayload);

    res.json({ uid, enabled });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ error: "Failed to update status" });
  }
});

app.patch("/api/admin/users/:uid/devices", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const devices = Array.isArray(req.body.devices) ? req.body.devices : [];

    await db.ref(`users/${uid}`).update({ devices, updatedAt: new Date().toISOString() });
    res.json({ uid, devices });
  } catch (error) {
    console.error("Update devices error:", error);
    res.status(500).json({ error: "Failed to update devices" });
  }
});

app.patch("/api/admin/locations/:device", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { device } = req.params;
    const { lat, lng, name } = req.body;

    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      return res.status(400).json({ error: "lat and lng must be valid numbers" });
    }

    await db.ref(`deviceLocations/${device}`).set({
      name: name || device,
      lat: Number(lat),
      lng: Number(lng),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid
    });
    res.json({ device, name: name || device, lat: Number(lat), lng: Number(lng) });
  } catch (error) {
    console.error("Update location error:", error);
    res.status(500).json({ error: "Failed to update location" });
  }
});

app.patch("/api/admin/data/:device/:entryKey", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { device, entryKey } = req.params;
    const existingSnap = await db.ref(`devices/${device}/history/${entryKey}`).once("value");
    const existingRow = existingSnap.val() || {};
    const row = sanitizeRow({ ...existingRow, ...(req.body || {}) });

    await db.ref(`devices/${device}/history/${entryKey}`).update(row);
    res.json({ device, entryKey, row });
  } catch (error) {
    console.error("Update data row error:", error);
    res.status(500).json({ error: "Failed to update data row" });
  }
});

app.delete("/api/admin/data/:device/:entryKey", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { device, entryKey } = req.params;
    await db.ref(`devices/${device}/history/${entryKey}`).remove();
    res.json({ device, entryKey, deleted: true });
  } catch (error) {
    console.error("Delete data row error:", error);
    res.status(500).json({ error: "Failed to delete data row" });
  }
});

let lastAlertState = new Map(); // device -> { signature, lastSentAt }

function getAlertSignature(device, summary) {
  return `${device}:${summary.category}:${summary.dominantParam}`;
}

async function shouldSendAlert(device, summary) {
  if (summary.finalAqi <= TELEGRAM_ALERT_THRESHOLD) {
    return false;
  }

  const signature = getAlertSignature(device, summary);
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  if (firebaseAvailable && db) {
    const stateRef = db.ref(`telegramAlertState/${normalizeDeviceId(device)}`);
    const snapshot = await stateRef.once("value");
    const previous = snapshot.val();

    if (previous && previous.signature === signature && now - Number(previous.lastSentAt || 0) < oneHourMs) {
      return false;
    }

    await stateRef.set({
      signature,
      lastSentAt: now,
      lastSentAtIso: new Date(now).toISOString(),
      category: summary.category,
      finalAqi: summary.finalAqi,
      dominantParam: summary.dominantParam
    });
    return true;
  }

  const previous = lastAlertState.get(device);
  if (previous && previous.signature === signature && now - previous.lastSentAt < oneHourMs) {
    return false;
  }

  lastAlertState.set(device, { signature, lastSentAt: now });
  return true;
}

async function sendAutoTelegramAlert(device, data) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured, skipping auto alert');
    return;
  }
  
  const summary = getAirQualitySummary(data.pm25, data.pm10);
  if (!(await shouldSendAlert(device, summary))) {
    return;
  }
  
  try {
    const statusEmoji = summary.finalAqi >= 201 ? '🚨' : '⚠️';
    
    // Convert wind direction from degrees to compass direction
    const windDir = Number(data.arah_angin) || 0;
    const compassDir = getCompassDirection(windDir);
    
    const message = `${statusEmoji} *PERINGATAN KUALITAS UDARA* ${statusEmoji}\n\n` +
      `📍 *Lokasi*: ${getTelegramLocationLabel()}\n` +
      `🏷️ *Alat*: ${getTelegramDeviceLabel(device)}\n` +
      `🌫️ *PM2.5*: ${data.pm25} µg/m³\n` +
      `💨 *PM10*: ${data.pm10 || 0} µg/m³\n` +
      `📊 *AQI Final*: ${summary.finalAqi} (${summary.dominantParam})\n` +
      `${summary.color} *Kondisi*: ${summary.category}\n` +
      `🌡️ *Suhu*: ${data.suhu || 'N/A'}°C\n` +
      `💧 *Kelembaban*: ${data.kelembaban || 'N/A'}%\n` +
      `💨 *Kecepatan Angin*: ${data.kecepatan_angin || 'N/A'} m/s\n` +
      `🧭 *Arah Angin*: ${compassDir} (${windDir}°)\n` +
      `🕐 *Waktu*: ${new Date(data.timestamp).toLocaleString('id-ID')}\n\n` +
      `AQI PM2.5: ${summary.pm25Aqi}\n` +
      `AQI PM10: ${summary.pm10Aqi}\n\n` +
      `_Alert kondisi sama akan dikirim ulang maksimal 1 jam sekali._`;
    
    await sendTelegramMessage(message, TELEGRAM_CHAT_ID);
    console.log(`Auto Telegram alert sent for ${device}: AQI=${summary.finalAqi}, Status=${summary.category}`);
  } catch (error) {
    console.error('Failed to send auto Telegram alert:', error.message);
  }
}

// Listen for device data changes
if (firebaseAvailable) {
  db.ref('devices').on('child_changed', (snapshot) => {
    const deviceKey = snapshot.key;
    const deviceData = snapshot.val();
    
    if (deviceData && deviceData.current) {
      const current = deviceData.current;
      console.log(`Device ${deviceKey} updated: PM2.5=${current.pm25}`);
      sendAutoTelegramAlert(deviceKey, current);
    }
  });

  console.log('Server-side Telegram alerts enabled');
} else {
  console.warn('Server-side Telegram alerts disabled because Firebase is not configured');
}

// ================= TELEGRAM BOT POLLING =================

let lastTelegramUpdateId = 0;
let isPolling = false;
const processedUpdates = new Set();
const processedCommands = new Set(); // Track command hashes

async function clearTelegramWebhookForPolling() {
  if (!TELEGRAM_BOT_TOKEN) return;

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      console.error('Delete Telegram webhook failed:', response.status, await response.text());
      return;
    }

    const data = await response.json();
    console.log('Telegram webhook cleared for polling:', data.ok ? 'OK' : JSON.stringify(data));
  } catch (error) {
    console.error('Delete Telegram webhook error:', error.message || error);
  }
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || isPolling) return;

  isPolling = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000);
  try {
    const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=30`;
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) {
      console.error('Telegram API error:', response.status, await response.text());
      return;
    }

    const data = await response.json();
    if (data.ok && data.result?.length) {
      console.log('Received', data.result.length, 'updates from Telegram');
    }
    if (data.ok && data.result) {
      for (const update of data.result) {
        // Skip if already processed
        if (processedUpdates.has(update.update_id)) {
          continue;
        }
        console.log('Processing update ID:', update.update_id);
        await processTelegramUpdate(update);
        lastTelegramUpdateId = Math.max(lastTelegramUpdateId, update.update_id);
        processedUpdates.add(update.update_id);
        
        // Clean old processed updates (keep last 100)
        if (processedUpdates.size > 100) {
          const oldestId = Math.min(...processedUpdates);
          processedUpdates.delete(oldestId);
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Poll Telegram error:', error.message || error);
    }
  } finally {
    clearTimeout(timeoutId);
    isPolling = false;
  }
}

async function processTelegramUpdate(update) {
  if (update.message) {
    const message = update.message;
    const chatId = message.chat.id;

    // For security, only respond to configured chat
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;

    const text = message.text?.trim();
    if (!text) return;

    // Create command hash for deduplication
    const commandHash = `${text}:${Math.floor(update.message.date / 60)}`; // Hash by text and minute
    if (processedCommands.has(commandHash)) {
      console.log('Skipping duplicate command:', commandHash);
      return;
    }

    await handleTelegramCommand(text, chatId);
    processedCommands.add(commandHash);
    
    // Clean old command hashes (keep last 50)
    if (processedCommands.size > 50) {
      const oldestHash = processedCommands.values().next().value;
      processedCommands.delete(oldestHash);
    }
  } else if (update.callback_query) {
    // Handle button clicks
    const callbackQuery = update.callback_query;
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    // For security, only respond to configured chat
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;

    console.log('Processing callback query:', data);
    
    // Route to handler based on callback data
    await handleTelegramCallback(data, chatId, callbackQuery.message.message_id, callbackQuery.id);
  }
}

function normalizeTelegramDeviceArg(value) {
  return String(value || "").replace(/\\/g, "").trim().toUpperCase();
}

function getTelegramDeviceLabel(deviceId) {
  return deviceId ? "Alat Aktif" : "Alat";
}

function getTelegramLocationLabel() {
  return ACTIVE_LOCATION_NAME;
}

async function getPrimaryTelegramDevice() {
  const current = await getCurrentAsGuest();
  const [device] = Object.keys(current);
  return { device, current };
}

async function answerCallbackQuery(callbackQueryId, notification = null) {
  if (!TELEGRAM_BOT_TOKEN) return;
  
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  const body = { callback_query_id: callbackQueryId };
  if (notification) body.text = notification;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      console.error('Answer callback query failed:', response.status, await response.text());
    }
  } catch (error) {
    console.error('Answer callback query error:', error.message);
  }
}

async function handleTelegramCallback(data, chatId, messageId, callbackQueryId) {
  const [cmd, ...args] = data.split(':');
  
  if (cmd === 'aqi') {
    const device = args[0];
    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Alat tidak valid');
      return;
    }
    
    try {
      const current = await getCurrentAsGuest();
      const deviceData = current[device];
      if (!deviceData) {
        await answerCallbackQuery(callbackQueryId, '❌ Alat tidak ditemukan');
        return;
      }

      const summary = getAirQualitySummary(deviceData.pm25, deviceData.pm10);
      const statusEmoji = summary.finalAqi > TELEGRAM_ALERT_THRESHOLD ? '⚠️' : '✅';
      
      const windDir = Number(deviceData.arah_angin) || 0;
      const compassDir = getCompassDirection(windDir);

      const msg = `${statusEmoji} *INDEKS KUALITAS UDARA* ${statusEmoji}\n\n` +
        `📍 Lokasi: ${getTelegramLocationLabel()}\n` +
        `🏷️ Alat: ${getTelegramDeviceLabel(device)}\n` +
        `🌫️ PM2.5: ${deviceData.pm25} µg/m³\n` +
        `💨 PM10: ${deviceData.pm10 || 'N/A'} µg/m³\n` +
        `📊 AQI PM2.5: ${summary.pm25Aqi}\n` +
        `📊 AQI PM10: ${summary.pm10Aqi}\n` +
        `🏁 AQI Final: ${summary.finalAqi} (${summary.dominantParam})\n` +
        `🌡️ Suhu: ${deviceData.suhu || 'N/A'}°C\n` +
        `💧 Kelembaban: ${deviceData.kelembaban || 'N/A'}%\n` +
        `💨 Kecepatan Angin: ${deviceData.kecepatan_angin || 'N/A'} m/s\n` +
        `🧭 Arah Angin: ${compassDir} (${windDir}°)\n` +
        `${summary.color} Kondisi: ${summary.category}\n` +
        `🕐 Update: ${new Date(deviceData.timestamp).toLocaleString('id-ID')}\n\n` +
        `Kategori mengikuti AQI final tertinggi dari PM2.5 dan PM10.`;
      
      await sendTelegramMessage(msg, chatId);
      await answerCallbackQuery(callbackQueryId, '✅ Data dimuat');
    } catch (error) {
      console.error('Callback AQI error:', error);
      await answerCallbackQuery(callbackQueryId, '❌ Error loading data');
    }
  } else if (cmd === 'history') {
    const device = args[0];
    const limit = Math.min(parseInt(args[1]) || 10, 50);
    
    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Alat tidak valid');
      return;
    }
    
    try {
      const history = await getHistoryAsGuest(device, limit);
      const entries = Object.values(history).slice(-limit);

      if (entries.length === 0) {
        await answerCallbackQuery(callbackQueryId, '❌ Tidak ada data');
        return;
      }

      let msg = `📊 *RIWAYAT PENGUKURAN* 📊\n\n` +
        `📍 Lokasi: ${getTelegramLocationLabel()}\n` +
        `🏷️ Alat: ${getTelegramDeviceLabel(device)}\n` +
        `📈 Menampilkan ${entries.length} data terakhir\n\n`;

      entries.reverse().forEach((entry, index) => {
        const summary = getAirQualitySummary(entry.pm25, entry.pm10);
        const time = new Date(entry.timestamp).toLocaleString('id-ID', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        msg += `${index + 1}. ${time}\n`;
        msg += `   ${summary.color} AQI ${summary.finalAqi} - ${summary.category}\n`;
        msg += `   PM2.5: ${entry.pm25} µg/m³ | PM10: ${entry.pm10 || 0} µg/m³\n\n`;
      });

      msg += `_💡 Ketik /start untuk menu utama_`;
      
      await sendTelegramMessage(msg, chatId);
      await answerCallbackQuery(callbackQueryId, '✅ Riwayat dimuat');
    } catch (error) {
      console.error('Callback history error:', error);
      await answerCallbackQuery(callbackQueryId, '❌ Error loading history');
    }
  } else if (cmd === 'location') {
    const device = args[0];

    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Alat tidak valid');
      return;
    }

    try {
      const locationSnap = await db.ref(`deviceLocations/${device}`).once('value');
      const location = locationSnap.val();

      if (!location) {
        const msg = `❌ *Lokasi Tidak Ditemukan*\n\n` +
          `${getTelegramDeviceLabel(device)} belum memiliki data lokasi.\n\n` +
          `📍 *Koordinat Default:*\n` +
          `• Latitude: ${ACTIVE_LOCATION_LAT}\n` +
          `• Longitude: ${ACTIVE_LOCATION_LNG}`;
        await sendTelegramMessage(msg, chatId);
        await answerCallbackQuery(callbackQueryId, '❌ Lokasi belum ada');
        return;
      }

      const msg = `📍 *INFORMASI LOKASI* 📍\n\n` +
        `🏷️ *Alat*: ${getTelegramDeviceLabel(device)}\n` +
        `📝 *Nama*: ${getTelegramLocationLabel()}\n` +
        `🌍 *Latitude*: ${location.lat}\n` +
        `🌍 *Longitude*: ${location.lng}\n` +
        `🕐 *Update*: ${location.updatedAt ? new Date(location.updatedAt).toLocaleString('id-ID') : 'N/A'}\n` +
        `👤 *Updated By*: ${location.updatedBy || 'N/A'}\n\n` +
        `🗺️ Google Maps: https://www.google.com/maps?q=${location.lat},${location.lng}`;

      await sendTelegramMessage(msg, chatId);
      await answerCallbackQuery(callbackQueryId, '✅ Lokasi dimuat');
    } catch (error) {
      console.error('Callback location error:', error);
      await answerCallbackQuery(callbackQueryId, '❌ Error loading location');
    }
  } else if (cmd === 'devices') {
    await answerCallbackQuery(callbackQueryId);
    await handleTelegramCommand('/devices', chatId);
  } else if (cmd === 'devices_for_aqi') {
    const { device } = await getPrimaryTelegramDevice();
    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Tidak ada alat aktif');
      return;
    }
    await handleTelegramCallback(`aqi:${device}`, chatId, messageId, callbackQueryId);
  } else if (cmd === 'devices_for_history') {
    const { device } = await getPrimaryTelegramDevice();
    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Tidak ada alat aktif');
      return;
    }
    await handleTelegramCallback(`history:${device}:10`, chatId, messageId, callbackQueryId);
  } else if (cmd === 'devices_for_location') {
    const { device } = await getPrimaryTelegramDevice();
    if (!device) {
      await answerCallbackQuery(callbackQueryId, '❌ Tidak ada alat aktif');
      return;
    }
    await handleTelegramCallback(`location:${device}`, chatId, messageId, callbackQueryId);
  } else if (cmd === 'help_detail') {
    const msg = `❓ *BANTUAN AIR WATCH* ❓\n\n` +
      `Silakan pilih menu melalui tombol di bawah ini.`;
    await sendTelegramMessage(msg, chatId, null, buildMainTelegramKeyboard());
    await answerCallbackQuery(callbackQueryId, 'Bantuan dimuat');
  } else {
    await answerCallbackQuery(callbackQueryId, '❌ Menu tidak dikenal');
  }
}

function buildMainTelegramKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📱 Alat Aktif', callback_data: 'devices' }],
      [{ text: '🌡️ Kondisi Terkini', callback_data: 'devices_for_aqi' }],
      [{ text: '📊 Riwayat Data', callback_data: 'devices_for_history' }],
      [{ text: '📍 Informasi Lokasi', callback_data: 'devices_for_location' }],
      [{ text: '❓ Bantuan', callback_data: 'help_detail' }]
    ]
  };
}

async function sendDeviceSelector(chatId, action, title) {
  const current = await getCurrentAsGuest();
  const devices = Object.keys(current);

  if (devices.length === 0) {
    await sendTelegramMessage(`❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`, chatId);
    return;
  }

  const callbackPrefix = action === 'history' ? 'history' : action === 'location' ? 'location' : 'aqi';
  const keyboard = {
    inline_keyboard: devices.map((device) => [{
      text: getTelegramDeviceLabel(device),
      callback_data: callbackPrefix === 'history' ? `${callbackPrefix}:${device}:10` : `${callbackPrefix}:${device}`
    }])
  };

  await sendTelegramMessage(`${title}\n\nSilakan pilih alat:`, chatId, null, keyboard);
}

async function handleTelegramCommand(command, chatId) {
  console.log('Processing Telegram command:', command, 'from chat:', chatId);
  const parts = command.split(/\s+/);
  const cmd = parts[0].toLowerCase().split('@')[0];

  if (cmd === '/help' || cmd === '/start') {
    const help = `🤖 *MENU MONITORING KUALITAS UDARA* 🤖\n\n` +
      `Silakan pilih perintah di bawah ini:`;
    
    try {
      const current = await getCurrentAsGuest();
      const devices = Object.keys(current);
      
      console.log('Sending help with buttons:', help);
      await sendTelegramMessage(help, chatId, null, buildMainTelegramKeyboard());
    } catch (error) {
      console.error('Help command error:', error);
      const fallbackMsg = `🤖 *MENU MONITORING KUALITAS UDARA* 🤖\n\n` +
        `Perintah Tersedia:\n` +
        `/devices - Alat aktif\n` +
        `/aqi - Cek AQI\n` +
        `/history - Riwayat\n` +
        `/location - Lokasi\n` +
        `/status - Status`;
      await sendTelegramMessage(fallbackMsg, chatId);
    }
  } else if (cmd === '/devices' || cmd === '/get_devices') {
    try {
      const current = await getCurrentAsGuest();
      const devices = Object.keys(current);

      if (devices.length === 0) {
        const msg = `❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`;
        await sendTelegramMessage(msg, chatId);
        return;
      }

      let msg = `📱 *ALAT MONITORING AKTIF* 📱\n\n`;
      msg += `📊 Total alat aktif: ${devices.length}\n\n`;

      const primaryDevice = devices[0];
      const primaryData = current[primaryDevice];
      const primarySummary = getAirQualitySummary(primaryData.pm25, primaryData.pm10);
      const keyboard = {
        inline_keyboard: [
          [{ text: `${primarySummary.color} Lihat Kondisi Terkini`, callback_data: `aqi:${primaryDevice}` }],
          [{ text: '📊 Lihat Riwayat Data', callback_data: `history:${primaryDevice}:10` }],
          [{ text: '📍 Lihat Informasi Lokasi', callback_data: `location:${primaryDevice}` }]
        ]
      };

      devices.forEach((device, index) => {
        const data = current[device];
        const summary = getAirQualitySummary(data.pm25, data.pm10);
        msg += `${index + 1}. ${getTelegramDeviceLabel(device)}\n`;
        msg += `   📍 Lokasi: ${getTelegramLocationLabel()}\n`;
        msg += `   ${summary.color} AQI: ${summary.finalAqi} (${summary.category})\n`;
        msg += `   PM2.5: ${data.pm25} µg/m³ | PM10: ${data.pm10 || 0} µg/m³\n`;
        msg += `   🕐 Update: ${new Date(data.timestamp).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit' })}\n\n`;
      });

      msg += `_💡 Klik tombol di bawah untuk detail lengkap_`;
      console.log('Sending devices:', msg);
      await sendTelegramMessage(msg, chatId, null, keyboard);
    } catch (error) {
      const msg = `❌ ERROR\n\nGagal mengambil data alat. Silakan coba lagi.`;
      console.log('Sending error:', msg);
      await sendTelegramMessage(msg, chatId);
    }
  } else if (cmd === '/aqi' || cmd === '/get_aqi') {
    let device = normalizeTelegramDeviceArg(parts[1]);
    if (!device) {
      const primary = await getPrimaryTelegramDevice();
      device = primary.device;
    }
    if (!device) {
      const msg = `❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`;
      console.log('Sending usage:', msg);
      await sendTelegramMessage(msg, chatId);
      return;
    }

    try {
      const current = await getCurrentAsGuest();
      const data = current[device];
      if (!data) {
        const msg = `❌ *Alat Tidak Ditemukan*\n\n` +
          `Alat aktif tidak ditemukan dalam sistem.\n\n` +
          `💡 Ketik /devices untuk melihat alat aktif`;
        console.log('Sending not found:', msg);
        await sendTelegramMessage(msg, chatId);
        return;
      }

      console.log('Data for', device, ':', JSON.stringify(data));
      const summary = getAirQualitySummary(data.pm25, data.pm10);
      const statusEmoji = summary.finalAqi > TELEGRAM_ALERT_THRESHOLD ? '⚠️' : '✅';
      
      // Convert wind direction from degrees to compass direction
      const windDir = Number(data.arah_angin) || 0;
      const compassDir = getCompassDirection(windDir);

      const msg = `${statusEmoji} *INDEKS KUALITAS UDARA* ${statusEmoji}\n\n` +
        `📍 Lokasi: ${getTelegramLocationLabel()}\n` +
        `🏷️ Alat: ${getTelegramDeviceLabel(device)}\n` +
        `🌫️ PM2.5: ${data.pm25} µg/m³\n` +
        `💨 PM10: ${data.pm10 || 'N/A'} µg/m³\n` +
        `📊 AQI PM2.5: ${summary.pm25Aqi}\n` +
        `📊 AQI PM10: ${summary.pm10Aqi}\n` +
        `🏁 AQI Final: ${summary.finalAqi} (${summary.dominantParam})\n` +
        `🌡️ Suhu: ${data.suhu || 'N/A'}°C\n` +
        `💧 Kelembaban: ${data.kelembaban || 'N/A'}%\n` +
        `💨 Kecepatan Angin: ${data.kecepatan_angin || 'N/A'} m/s\n` +
        `🧭 Arah Angin: ${compassDir} (${windDir}°)\n` +
        `${summary.color} Kondisi: ${summary.category}\n` +
        `🕐 Update: ${new Date(data.timestamp).toLocaleString('id-ID')}\n\n` +
        `Kategori mengikuti AQI final tertinggi dari PM2.5 dan PM10.`;
      console.log('Sending AQI:', msg);
      await sendTelegramMessage(msg, chatId);
    } catch (error) {
      const msg = `❌ *Error*\n\nGagal mengambil data AQI. Silakan coba lagi.`;
      console.log('Sending error:', msg);
      await sendTelegramMessage(msg, chatId);
    }
  } else if (cmd === '/history' || cmd === '/get_history') {
    let device = normalizeTelegramDeviceArg(parts[1]);
    if (!device) {
      const primary = await getPrimaryTelegramDevice();
      device = primary.device;
    }
    const limit = Math.min(parseInt(parts[2]) || 10, 50); // max 50
    if (!device) {
      const msg = `❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`;
      console.log('Sending usage:', msg);
      await sendTelegramMessage(msg, chatId);
      return;
    }
    try {
      const history = await getHistoryAsGuest(device, limit);
      const entries = Object.values(history).slice(-limit);

      if (entries.length === 0) {
        const msg = `❌ *Data Tidak Ada*\n\n` +
          `Tidak ada riwayat data untuk ${getTelegramDeviceLabel(device)}.`;
        console.log('Sending no history:', msg);
        await sendTelegramMessage(msg, chatId);
        return;
      }

      let msg = `📊 *RIWAYAT PENGUKURAN* 📊\n\n` +
        `📍 Lokasi: ${getTelegramLocationLabel()}\n` +
        `🏷️ Alat: ${getTelegramDeviceLabel(device)}\n` +
        `📈 Menampilkan ${entries.length} data terakhir\n\n`;

      entries.reverse().forEach((entry, index) => {
        const summary = getAirQualitySummary(entry.pm25, entry.pm10);
        const time = new Date(entry.timestamp).toLocaleString('id-ID', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        msg += `${index + 1}. ${time}\n`;
        msg += `   ${summary.color} AQI ${summary.finalAqi} - ${summary.category}\n`;
        msg += `   PM2.5: ${entry.pm25} µg/m³ | PM10: ${entry.pm10 || 0} µg/m³\n\n`;
      });

      msg += `_💡 Klik tombol menu untuk data saat ini_`;
      console.log('Sending history:', msg.substring(0, 100) + '...');
      await sendTelegramMessage(msg, chatId);
    } catch (error) {
      const msg = `❌ *Error*\n\nGagal mengambil riwayat data. Silakan coba lagi.`;
      console.log('Sending error:', msg);
      await sendTelegramMessage(msg, chatId);
    }
  } else if (cmd === '/location') {
    let device = normalizeTelegramDeviceArg(parts[1]);
    if (!device) {
      const primary = await getPrimaryTelegramDevice();
      device = primary.device;
    }
    if (!device) {
      const msg = `❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`;
      console.log('Sending location usage:', msg);
      await sendTelegramMessage(msg, chatId);
      return;
    }

    try {
      const locationSnap = await db.ref(`deviceLocations/${device}`).once('value');
      const location = locationSnap.val();
      
      if (!location) {
        const msg = `❌ *Lokasi Tidak Ditemukan*\n\n` +
          `${getTelegramDeviceLabel(device)} belum memiliki data lokasi.\n\n` +
          `📍 *Koordinat Default:*\n` +
          `• Latitude: ${ACTIVE_LOCATION_LAT}\n` +
          `• Longitude: ${ACTIVE_LOCATION_LNG}`;
        console.log('Sending location not found:', msg);
        await sendTelegramMessage(msg, chatId);
        return;
      }

      const msg = `📍 *INFORMASI LOKASI* 📍\n\n` +
        `🏷️ *Alat*: ${getTelegramDeviceLabel(device)}\n` +
        `📝 *Nama*: ${getTelegramLocationLabel()}\n` +
        `🌍 *Latitude*: ${location.lat}\n` +
        `🌍 *Longitude*: ${location.lng}\n` +
        `🕐 *Update*: ${location.updatedAt ? new Date(location.updatedAt).toLocaleString('id-ID') : 'N/A'}\n` +
        `👤 *Updated By*: ${location.updatedBy || 'N/A'}\n\n` +
        `🗺️ [Buka di Google Maps](https://www.google.com/maps?q=${location.lat},${location.lng})`;
      
      console.log('Sending location:', msg);
      await sendTelegramMessage(msg, chatId);
    } catch (error) {
      const msg = `❌ *Error*\n\nGagal mengambil data lokasi. Silakan coba lagi.`;
      console.log('Sending location error:', msg);
      await sendTelegramMessage(msg, chatId);
    }
  } else if (cmd === '/status') {
    let device = normalizeTelegramDeviceArg(parts[1]);
    if (!device) {
      const primary = await getPrimaryTelegramDevice();
      device = primary.device;
    }
    if (!device) {
      const msg = `❌ *Tidak Ada Alat Aktif*\n\nBelum ada alat aktif dalam sistem.`;
      console.log('Sending status usage:', msg);
      await sendTelegramMessage(msg, chatId);
      return;
    }

    try {
      const current = await getCurrentAsGuest();
      const data = current[device];
      if (!data) {
        const msg = `❌ *Alat Tidak Ditemukan*\n\n` +
          `Alat aktif tidak ditemukan dalam sistem.`;
        console.log('Sending status not found:', msg);
        await sendTelegramMessage(msg, chatId);
        return;
      }

      const summary = getAirQualitySummary(data.pm25, data.pm10);
      const statusEmoji = summary.finalAqi > TELEGRAM_ALERT_THRESHOLD ? '⚠️' : '✅';
      
      // Convert wind direction from degrees to compass direction
      const windDir = Number(data.arah_angin) || 0;
      const compassDir = getCompassDirection(windDir);
      
      const msg = `${statusEmoji} *STATUS KUALITAS UDARA* ${statusEmoji}\n\n` +
        `📍 *Lokasi*: ${getTelegramLocationLabel()}\n` +
        `🏷️ *Alat*: ${getTelegramDeviceLabel(device)}\n` +
        `${summary.color} *Kondisi*: ${summary.category}\n` +
        `🏁 *AQI Final*: ${summary.finalAqi} (${summary.dominantParam})\n` +
        `📊 *AQI PM2.5*: ${summary.pm25Aqi}\n` +
        `📊 *AQI PM10*: ${summary.pm10Aqi}\n` +
        `🌫️ *PM2.5*: ${data.pm25} µg/m³\n` +
        `💨 *PM10*: ${data.pm10 || 0} µg/m³\n` +
        `🌡️ *Suhu*: ${data.suhu || 'N/A'}°C\n` +
        `💧 *Kelembaban*: ${data.kelembaban || 'N/A'}%\n` +
        `💨 *Kecepatan Angin*: ${data.kecepatan_angin || 'N/A'} m/s\n` +
        `🧭 *Arah Angin*: ${compassDir} (${windDir}°)\n` +
        `🕐 *Update*: ${new Date(data.timestamp).toLocaleString('id-ID')}\n\n` +
        `📊 *Keterangan Status*:\n` +
        `🟢 0-50 BAIK\n` +
        `🟡 51-100 SEDANG\n` +
        `🟠 101-150 TIDAK SEHAT*\n` +
        `🔴 151-200 TIDAK SEHAT\n` +
        `🟣 201-300 SANGAT TIDAK SEHAT\n` +
        `🔴 301-500 BERBAHAYA`;
      
      console.log('Sending status:', msg);
      await sendTelegramMessage(msg, chatId);
    } catch (error) {
      console.error('Status command error details:', error.message, error.stack);
      const msg = `❌ *Error*\n\nGagal mengambil data status. Silakan coba lagi.`;
      console.log('Sending status error:', msg);
      await sendTelegramMessage(msg, chatId);
    }
  } else {
    const msg = `❌ *Perintah Tidak Dikenal*\n\nKetik /help untuk melihat daftar perintah yang tersedia.`;
    console.log('Sending unknown:', msg);
    await sendTelegramMessage(msg, chatId);
  }
}

async function getCurrentAsGuest() {
  const snapshot = await db.ref("devices").once("value");
  const all = snapshot.val() || {};
  const current = {};
  for (const device in all) {
    if (isActiveDeviceId(device) && all[device].current) {
      current[device] = all[device].current;
    }
  }
  console.log('Fetched current devices:', Object.keys(current));
  return current;
}

async function getHistoryAsGuest(device, limit) {
  const snapshot = await db.ref(`devices/${device}/history`).once("value");
  const data = snapshot.val() || {};
  console.log('Fetched history for device:', device, 'with', Object.keys(data).length, 'entries');
  return Object.values(data).slice(-limit);
}

async function sendTelegramMessage(text, chatId, parseMode = null, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    return { ok: false, reason: "Telegram is not configured" };
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    console.error('Send Telegram message failed:', response.status, payload);
    throw new Error(`Telegram API error: ${response.status} ${payload}`);
  }
  return { ok: true };
}

if (TELEGRAM_ENABLE_POLLING) {
  clearTelegramWebhookForPolling().finally(() => {
    pollTelegramUpdates();
    setInterval(pollTelegramUpdates, 5000);
  });
  console.log('Telegram polling enabled');
} else {
  console.log('Telegram polling disabled by TELEGRAM_ENABLE_POLLING=false');
}

// ================= START SERVER =================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Web server running at http://localhost:${PORT}`);
});
