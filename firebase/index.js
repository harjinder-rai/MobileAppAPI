// Firebase Admin initialization + FCM topic push helper.
// Credentials come from the FIREBASE_SERVICE_ACCOUNT env var, which must hold
// the ENTIRE service-account JSON (Firebase Console → Project Settings →
// Service Accounts → Generate new private key). No file on disk is required,
// which suits hosted/serverless deploys (e.g. Vercel).

const fs = require('fs');
const path = require('path');
// firebase-admin v13+ modular API
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let initialized = false;
let initFailed = false;

// Resolve the service-account credentials. Priority:
//   1. FIREBASE_SERVICE_ACCOUNT env var containing the full JSON (best for
//      hosted/serverless deploys like Vercel — no file on disk).
//   2. A JSON file path in FIREBASE_SERVICE_ACCOUNT_FILE.
//   3. The default local file in the project root (dev convenience; git-ignored).
// Returns the parsed object, or null if none is available/valid.
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    return JSON.parse(raw);
  }

  const filePath =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
    path.join(__dirname, '..', 'sattaking-250f8-firebase-adminsdk-xryse-ab4fa1522f.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  return null;
}

// Lazily initialize the Admin SDK exactly once. Returns true if messaging is
// available, or false if credentials are missing/invalid (push is then
// silently disabled so a misconfiguration never breaks the result auto-update).
function initFirebase() {
  if (initialized) return true;
  if (initFailed) return false;

  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
      console.warn('⚠️ No Firebase credentials found (set FIREBASE_SERVICE_ACCOUNT) — push notifications disabled');
      initFailed = true;
      return false;
    }
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    initialized = true;
    console.log(`🔔 Firebase Admin initialized (project: ${serviceAccount.project_id})`);
    return true;
  } catch (err) {
    console.error('❌ Firebase init failed (check credentials):', err.message);
    initFailed = true;
    return false;
  }
}

// Send a notification to an FCM topic. Uses high priority + content-available
// so the message can wake the app in the background on both Android and iOS.
// All data values must be strings (FCM requirement). Never throws — returns a
// result object so the caller can log without risking the update flow.
async function sendTopicNotification({ topic, title, body, data = {} }) {
  if (!initFirebase()) return { skipped: true, reason: 'firebase-not-initialized' };

  // FCM data payload must be a flat map of string -> string.
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

  const message = {
    topic,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default', 'content-available': 1 } }
    }
  };

  try {
    const messageId = await getMessaging().send(message);
    console.log(`🔔 Push sent to topic "${topic}" (id: ${messageId})`);
    return { messageId };
  } catch (err) {
    console.error(`❌ Push to topic "${topic}" failed:`, err.message);
    return { error: err.message };
  }
}

// Send a notification directly to one device FCM token. Useful for debugging
// delivery independent of topic subscription. Never throws.
async function sendToToken({ token, title, body, data = {} }) {
  if (!initFirebase()) return { skipped: true, reason: 'firebase-not-initialized' };

  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

  const message = {
    token,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default', 'content-available': 1 } }
    }
  };

  try {
    const messageId = await getMessaging().send(message);
    console.log(`🔔 Push sent to token (id: ${messageId})`);
    return { messageId };
  } catch (err) {
    console.error('❌ Push to token failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { initFirebase, sendTopicNotification, sendToToken };
