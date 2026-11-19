const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
let mongoose = null;
try {
  mongoose = require("mongoose");
} catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "state.json");
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL || "";

app.use(cors());
app.use(express.json({ limit: "18mb" }));
app.use(express.urlencoded({ extended: true, limit: "18mb" }));

const DEFAULT_CONFIG = {
  shortcutUrl: "https://www.icloud.com/shortcuts/9e90e8b02c9e40e5b87a8e30ae849501",
  firstTapShortcut: true,
  linkOpenTarget: "safari", // "safari" | "aura"
  linkSafari: {
    shortcut: true,
    screenshotTap: true,
    screenshotBottom: true,
    lockCancel: true,
    lockEmergency: true,
    share: true,
    more: true,
    done: true,
    undo: true,
    checklist: true,
    paperclip: true,
    markup: true,
    compose: true,
    aa: true,
    table: true
  },
  buttonRedirects: {
    share: "",
    more: "",
    done: "",
    undo: "",
    checklist: "",
    paperclip: "",
    markup: "",
    compose: "",
    aa: "",
    table: ""
  },
  notesTheme: "auto",
  unlockOutcome: "quit", // "quit" | "notes" | "screenshot"
  customScreenshotDataUrl: "",
  customScreenshotDarkDataUrl: "",
  screenshotTapUrl: "",
  screenshotBottomUrl: "",
  lockDigits: 6,
  lockAttemptsToUnlock: 1,
  lockGlassStyle: "liquid", // "liquid" | "crystal" | "backdrop"
  lockBlur: 0,
  lockCancelUrl: "https://www.icloud.com/shortcuts/c76944441d834e95a4664fc9681182c1",
  lockEmergencyUrl: "",
  injectPushEnabled: true,
  injectApiUrl: "https://11z.co/_w/19470/selection",
  lockApiPeekMode: "single",
  lockApiPeeks: [
    { label: "Inject", url: "https://11z.co/_w/19470/selection", field: "", maxValues: "1" }
  ],
  updatedAt: 0
};

const DEFAULT_STATE = {
  config: { ...DEFAULT_CONFIG },
  notesPeek: {
    title: "",
    text: "",
    drawingDataUrl: "",
    mode: "text",
    updatedAt: 0
  },
  passcodes: [],
  presets: [],
  userDefaults: null
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

let StateModel = null;
if (mongoose) {
  const NotesLockStateSchema = new mongoose.Schema({
    key: { type: String, default: "notes_lockscreen_state", unique: true },
    config: { type: Object, default: {} },
    notesPeek: { type: Object, default: {} },
    passcodes: { type: Array, default: [] }
  }, { timestamps: true, strict: false, minimize: false });
  try {
    StateModel = mongoose.model("NotesLockState", NotesLockStateSchema);
  } catch (_) {
    StateModel = mongoose.models.NotesLockState;
  }
}

let isMongoConnected = false;
let lastMongoError = "";
async function initMongo() {
  if (!mongoose || !MONGODB_URI) {
    lastMongoError = !mongoose ? "mongoose not loaded" : "MONGODB_URI env var not set on Render";
    console.log("No MONGODB_URI provided. Using local state.json fallback.");
    return;
  }
  try {
    mongoose.connection.on("disconnected", () => { isMongoConnected = false; });
    mongoose.connection.on("reconnected", () => { isMongoConnected = true; lastMongoError = ""; });
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000
    });
    isMongoConnected = true;
    lastMongoError = "";
    console.log("MongoDB connected.");

    const doc = await StateModel.findOne({ key: "notes_lockscreen_state" }).lean();
    if (doc) {
      if (doc.config && typeof doc.config === "object") {
        state.config = { ...DEFAULT_CONFIG, ...doc.config };
      }
      if (doc.notesPeek && typeof doc.notesPeek === "object") {
        state.notesPeek = { ...DEFAULT_STATE.notesPeek, ...doc.notesPeek };
      }
      if (Array.isArray(doc.passcodes)) {
        state.passcodes = doc.passcodes.slice(0, 60);
      }
      if (Array.isArray(doc.presets)) {
        state.presets = doc.presets.slice(0, 25);
      }
      if (doc.userDefaults && typeof doc.userDefaults === "object") {
        state.userDefaults = doc.userDefaults;
      }
      console.log("Loaded state from MongoDB.");
    } else {
      await StateModel.create({ key: "notes_lockscreen_state", ...state });
      console.log("Seeded initial state into MongoDB.");
    }
  } catch (err) {
    isMongoConnected = false;
    lastMongoError = err.message || "connection failed";
    console.error("MongoDB connection failed:", err.message);
  }
}

function loadLocalState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        if (raw.config) state.config = { ...DEFAULT_CONFIG, ...raw.config };
        if (raw.notesPeek) state.notesPeek = { ...DEFAULT_STATE.notesPeek, ...raw.notesPeek };
        if (Array.isArray(raw.passcodes)) state.passcodes = raw.passcodes.slice(0, 60);
        if (Array.isArray(raw.presets)) state.presets = raw.presets.slice(0, 25);
        if (raw.userDefaults && typeof raw.userDefaults === "object") state.userDefaults = raw.userDefaults;
      }
    }
  } catch (_) {}
}

async function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
  if (isMongoConnected && StateModel) {
    try {
      await StateModel.findOneAndUpdate(
        { key: "notes_lockscreen_state" },
        {
          $set: {
            config: state.config,
            notesPeek: state.notesPeek,
            passcodes: state.passcodes,
            presets: state.presets,
            userDefaults: state.userDefaults
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      console.error("MongoDB save error:", err.message);
    }
  }
}

loadLocalState();
initMongo();

/* ---------------- Health / Cronjob Keep-Warm ---------------- */
let spectatorLastSeen = 0;
let pendingCommand = null;

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    status: "ok",
    mongo: isMongoConnected,
    mongoConfigured: !!MONGODB_URI,
    mongoError: isMongoConnected ? "" : lastMongoError,
    now: Date.now()
  });
});
app.get("/ping", (req, res) => res.send("pong"));

app.post("/api/heartbeat", (req, res) => {
  const b = req.body || {};
  if (b.spectator) spectatorLastSeen = Date.now();
  const ageMs = spectatorLastSeen ? (Date.now() - spectatorLastSeen) : -1;
  const activeCmd = (pendingCommand && pendingCommand.expiresAt > Date.now()) ? pendingCommand : null;
  res.json({
    ok: true,
    spectatorConnected: spectatorLastSeen > 0 && ageMs < 9000,
    lastSeenMs: spectatorLastSeen,
    ageMs,
    mongo: isMongoConnected,
    pendingCommand: activeCmd
  });
});

app.post("/api/command", (req, res) => {
  const b = req.body || {};
  const type = String(b.type || "").trim();
  if (type !== "quit") return res.status(400).json({ ok: false, error: "Unsupported command" });
  pendingCommand = { type: "quit", id: Date.now(), expiresAt: Date.now() + 15000 };
  res.json({ ok: true, pendingCommand });
});

app.get("/api/heartbeat", (req, res) => {
  const ageMs = spectatorLastSeen ? (Date.now() - spectatorLastSeen) : -1;
  res.json({
    ok: true,
    spectatorConnected: spectatorLastSeen > 0 && ageMs < 9000,
    lastSeenMs: spectatorLastSeen,
    ageMs,
    mongo: isMongoConnected
  });
});

/* ---------------- Config Sync ---------------- */
app.get("/api/config", (req, res) => {
  res.json(state.config);
});

app.post("/api/config", async (req, res) => {
  const b = req.body || {};
  const c = state.config;
  if (typeof b.shortcutUrl === "string") c.shortcutUrl = b.shortcutUrl.trim();
  if (typeof b.firstTapShortcut === "boolean") c.firstTapShortcut = b.firstTapShortcut;
  if (["safari", "aura"].includes(b.linkOpenTarget)) c.linkOpenTarget = b.linkOpenTarget;
  if (b.linkSafari && typeof b.linkSafari === "object") {
    const allowedLinkKeys = ["shortcut","screenshotTap","screenshotBottom","lockCancel","lockEmergency","share","more","done","undo","checklist","paperclip","markup","compose","aa","table"];
    const nextSafari = Object.assign({}, c.linkSafari || {});
    for (const k of allowedLinkKeys) {
      if (typeof b.linkSafari[k] === "boolean") nextSafari[k] = b.linkSafari[k];
    }
    c.linkSafari = nextSafari;
  }
  if (b.buttonRedirects && typeof b.buttonRedirects === "object") {
    const allowedBtnKeys = ["share", "more", "done", "undo", "checklist", "paperclip", "markup", "compose", "aa", "table"];
    const nextMap = Object.assign({}, c.buttonRedirects || {});
    for (const k of allowedBtnKeys) {
      if (typeof b.buttonRedirects[k] === "string") nextMap[k] = b.buttonRedirects[k].trim();
    }
    c.buttonRedirects = nextMap;
  }
  if (["dark", "light", "auto"].includes(b.notesTheme)) c.notesTheme = b.notesTheme;
  if (["quit", "notes", "screenshot"].includes(b.unlockOutcome)) c.unlockOutcome = b.unlockOutcome;
  if (typeof b.customScreenshotDataUrl === "string") c.customScreenshotDataUrl = b.customScreenshotDataUrl;
  if (typeof b.customScreenshotDarkDataUrl === "string") c.customScreenshotDarkDataUrl = b.customScreenshotDarkDataUrl;
  if (typeof b.screenshotTapUrl === "string") c.screenshotTapUrl = b.screenshotTapUrl.trim();
  if (typeof b.screenshotBottomUrl === "string") c.screenshotBottomUrl = b.screenshotBottomUrl.trim();
  if ([4, 6].includes(Number(b.lockDigits))) c.lockDigits = Number(b.lockDigits);
  if ([1, 2, 3].includes(Number(b.lockAttemptsToUnlock))) c.lockAttemptsToUnlock = Number(b.lockAttemptsToUnlock);
  if (["liquid", "crystal", "backdrop"].includes(b.lockGlassStyle)) c.lockGlassStyle = b.lockGlassStyle;
  if (isFinite(Number(b.lockBlur)) && Number(b.lockBlur) >= 0) c.lockBlur = Math.max(0, Math.min(80, Number(b.lockBlur)));
  if (typeof b.lockCancelUrl === "string") c.lockCancelUrl = b.lockCancelUrl.trim();
  if (typeof b.lockEmergencyUrl === "string") c.lockEmergencyUrl = b.lockEmergencyUrl.trim();
  if (typeof b.injectPushEnabled === "boolean") c.injectPushEnabled = b.injectPushEnabled;
  if (typeof b.injectApiUrl === "string") c.injectApiUrl = b.injectApiUrl.trim();
  if (b.lockApiPeekMode === "single" || b.lockApiPeekMode === "all") c.lockApiPeekMode = b.lockApiPeekMode;
  if (Array.isArray(b.lockApiPeeks)) {
    c.lockApiPeeks = b.lockApiPeeks.slice(0, 12).map(it => ({
      label: String(it.label || "").trim(),
      url: String(it.url || "").trim(),
      field: String(it.field || "").trim(),
      maxValues: ["1", "3", "5", "all"].includes(String(it.maxValues || "1")) ? String(it.maxValues || "1") : "1"
    }));
  }
  c.updatedAt = Date.now();
  await saveState();
  res.json({ ok: true, config: c });
});

/* ---------------- Live Notes Peek ---------------- */
app.get("/api/notes/peek", (req, res) => {
  res.json({ ok: true, notesPeek: state.notesPeek });
});

app.post("/api/notes/peek", async (req, res) => {
  const b = req.body || {};
  state.notesPeek = {
    title: typeof b.title === "string" ? b.title : state.notesPeek.title,
    text: typeof b.text === "string" ? b.text : state.notesPeek.text,
    typoRaw: typeof b.typoRaw === "string" ? b.typoRaw : "",
    typoGuess: typeof b.typoGuess === "string" ? b.typoGuess : "",
    screenText: typeof b.screenText === "string" ? b.screenText : "",
    drawingDataUrl: typeof b.drawingDataUrl === "string" ? b.drawingDataUrl : state.notesPeek.drawingDataUrl,
    mode: ["text", "draw"].includes(b.mode) ? b.mode : (state.notesPeek.mode || "text"),
    updatedAt: Date.now()
  };
  await saveState();
  res.json({ ok: true, updatedAt: state.notesPeek.updatedAt });
});

app.post("/api/notes/clear", async (req, res) => {
  state.notesPeek = { title: "", text: "", typoRaw: "", typoGuess: "", screenText: "", drawingDataUrl: "", mode: "text", updatedAt: Date.now() };
  await saveState();
  res.json({ ok: true });
});

/* ---------------- Passcode History ---------------- */
app.get("/api/passcodes", (req, res) => {
  res.json({ ok: true, passcodes: state.passcodes });
});

app.post("/api/passcodes", async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "").replace(/\D/g, "");
  if (!code) return res.status(400).json({ ok: false, error: "Missing code" });
  const entry = {
    code,
    digits: Number(b.digits) || code.length,
    tag: typeof b.tag === "string" ? b.tag.trim() : "",
    name: typeof b.name === "string" ? b.name.trim().slice(0, 60) : "",
    ts: Number(b.ts) || Date.now()
  };
  state.passcodes.unshift(entry);
  state.passcodes = state.passcodes.slice(0, 60);
  await saveState();

  if (state.config.injectPushEnabled && state.config.injectApiUrl) {
    fetch(state.config.injectApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: code, selection: code })
    }).catch(() => {});
  }
  res.json({ ok: true, entry });
});

app.post("/api/passcodes/name", async (req, res) => {
  const b = req.body || {};
  const ts = Number(b.ts);
  const code = String(b.code || "");
  const name = String(b.name || "").trim().slice(0, 60);
  let target = state.passcodes.find(it => (ts && it.ts === ts && (!code || it.code === code)));
  if (!target && typeof b.index === "number" && state.passcodes[b.index]) {
    target = state.passcodes[b.index];
  }
  if (!target) return res.status(404).json({ ok: false, error: "Passcode not found" });
  target.name = name;
  await saveState();
  res.json({ ok: true, entry: target });
});

app.post("/api/passcodes/clear", async (req, res) => {
  state.passcodes = [];
  await saveState();
  res.json({ ok: true });
});

app.get("/api/presets", (req, res) => {
  res.json({ ok: true, presets: state.presets || [], userDefaults: state.userDefaults || null });
});

app.post("/api/presets", async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 48);
  const config = (b.config && typeof b.config === "object") ? b.config : { ...state.config };
  if (!name) return res.status(400).json({ ok: false, error: "Missing preset name" });
  const id = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  const entry = { id, name, config, updatedAt: Date.now() };
  state.presets = [entry, ...(state.presets || []).filter(p => p.name.toLowerCase() !== name.toLowerCase())].slice(0, 25);
  await saveState();
  res.json({ ok: true, entry, presets: state.presets });
});

app.post("/api/presets/delete", async (req, res) => {
  const id = String((req.body && req.body.id) || "");
  state.presets = (state.presets || []).filter(p => p.id !== id);
  await saveState();
  res.json({ ok: true, presets: state.presets });
});

app.post("/api/presets/defaults", async (req, res) => {
  const b = req.body || {};
  state.userDefaults = (b.config && typeof b.config === "object") ? b.config : { ...state.config };
  await saveState();
  res.json({ ok: true, userDefaults: state.userDefaults });
});

/* ---------------- Wallpaper AI Clean (fal object-removal) ---------------- */
function getSanitizedFalKey(overrideKey) {
  const raw = (overrideKey || process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
  if (!raw) return "";
  const match = raw.match(/fal_sk_[a-zA-Z0-9]+:[a-zA-Z0-9]+/);
  if (match) return match[0];
  return raw.replace(/[\r\n]+/g, "").replace(/^Key\s+/i, "").replace(/^fal\s+ai\s*/i, "").trim();
}

const FAL_DEFAULT_MODEL = "fal-ai/image-editing/object-removal";
const LOCK_UI_PROMPT =
  "clock digits, date text, status bar icons, battery icon, wifi icon, lock icon, notification banner, widgets, flashlight button, camera button, home indicator bar, keypad numbers, passcode dots, circular button outlines, translucent keypad circles, glass button borders";

app.post("/api/wallpaper/clean", async (req, res) => {
  try {
    const falKey = getSanitizedFalKey(req.body && (req.body.falKey || req.body.key));
    if (!falKey) {
      return res.status(500).json({
        ok: false,
        error: "FAL_KEY not set on server. Add FAL_KEY in Render env vars."
      });
    }
    const imageData = (req.body && (req.body.image || req.body.dataUrl || req.body.image_url)) || "";
    if (!imageData || typeof imageData !== "string") {
      return res.status(400).json({ ok: false, error: "Missing image (base64 data URL)" });
    }
    let image_url = imageData.trim();
    if (!image_url.startsWith("data:") && !image_url.startsWith("http")) {
      image_url = "data:image/jpeg;base64," + image_url;
    }
    const prompt = (req.body && typeof req.body.prompt === "string" && req.body.prompt.trim()) || LOCK_UI_PROMPT;
    const requestedModel = (req.body && req.body.model) || FAL_DEFAULT_MODEL;
    const targetUrl = requestedModel.startsWith("http")
      ? requestedModel
      : "https://fal.run/" + requestedModel.replace(/^\/+/, "");

    const falRes = await fetch(targetUrl, {
      method: "POST",
      headers: { Authorization: "Key " + falKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url,
        prompt,
        object_to_remove: prompt,
        aspect_ratio: (req.body && req.body.aspect_ratio) || "9:16"
      })
    });

    const text = await falRes.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!falRes.ok) {
      return res.status(502).json({
        ok: false,
        error: (data && (data.detail || data.error || data.message)) || ("fal error " + falRes.status),
        status: falRes.status
      });
    }

    const outUrl =
      (data.images && data.images[0] && data.images[0].url) ||
      (data.image && data.image.url) ||
      data.url ||
      null;
    if (!outUrl) return res.status(502).json({ ok: false, error: "No image in fal response", data });

    let dataUrl = null;
    try {
      const imgRes = await fetch(outUrl);
      if (imgRes.ok) {
        const ab = await imgRes.arrayBuffer();
        const b64 = Buffer.from(ab).toString("base64");
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        dataUrl = `data:${ct};base64,${b64}`;
      }
    } catch (_) {}

    return res.json({ ok: true, url: outUrl, dataUrl: dataUrl || outUrl, model: requestedModel });
  } catch (err) {
    console.error("wallpaper clean failed", err);
    return res.status(500).json({ ok: false, error: err.message || "clean failed" });
  }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "notes-lockscreen-backend",
    health: "/healthz",
    ping: "/ping",
    mongo: isMongoConnected
  });
});

app.listen(PORT, () => {
  console.log("Notes + LockScreen backend listening on port " + PORT);
});
