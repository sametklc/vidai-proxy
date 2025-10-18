// server.js — SeeDance (bytedance/seedance) proxy
// - Text→Video & Image→Video
// - fps = 24 (SeeDance zorunlu)
// - /video/result/:id içinde: URL çıkarma süper-agresif + succeeded anında kısa retry
// - Android’e {status, request_id, status_url, response_url, job_id, video_url?} sözleşmesi

import express from "express";
import multer from "multer";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ===== ENV =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// Varsayılan model: lite (daha ucuz). Pro istiyorsan env ile değiştir.
const SEEDANCE_MODEL_SLUG =
  process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-lite";
// Özel version id kullanacaksan:
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;

const CHEAP_DEFAULTS = {
  duration: 3,
  resolution: "480p",
  fps: 24,        // SeeDance API sadece 24 kabul ediyor
  aspect_ratio: "16:9",
  watermark: false
};

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ---------- helpers ----------
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}
function makeStatusUrl(requestId) {
  const path = `/video/result/${requestId}`;
  return BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}${path}` : path;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// OBJ / ARRAY / STRING içinde URL bul
function urlFromAny(x) {
  if (!x) return null;

  // string ise doğrudan
  if (typeof x === "string") return x.startsWith("http") ? x : null;

  // File-like .url()
  try {
    if (typeof x.url === "function") {
      const u = x.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch {}

  // array ise sırayla tara
  if (Array.isArray(x)) {
    for (const it of x) {
      const u = urlFromAny(it);
      if (u) return u;
    }
    return null;
  }

  // object
  if (typeof x === "object") {
    // sık anahtarlar
    const direct = ["video_url", "video", "url", "mp4", "file", "output_url", "result_url", "media_url"];
    for (const k of direct) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
    }

    // {urls:{get:"http..."}}
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;

    // output string olabilir
    if (typeof x.output === "string" && x.output.startsWith("http")) return x.output;

    // output içini tara
    const u1 = urlFromAny(x.output);
    if (u1) return u1;

    // tüm alanları dolaş
    for (const k of Object.keys(x)) {
      const u = urlFromAny(x[k]);
      if (u) return u;
    }
  }
  return null;
}

// Son çare: JSON string içinde regex ile http...mp4 ara
function urlFromJsonString(obj) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    const m = s.match(/https?:\/\/[^"'\s]+\.mp4/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  const detail = e?.response?.error || e?.response?.data || e?.stack;
  console.error("[UPSTREAM ERROR]", msg, detail ? "\nDETAIL:" : "", detail || "");

  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: `Invalid version or input. ${msg}` });
  }
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate." });
  }
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate." });
  }
  return res.status(502).json({ error: msg });
}

// ---------- health ----------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    model: SEEDANCE_VERSION_ID || SEEDANCE_MODEL_SLUG,
    base_public_url: BASE_PUBLIC_URL || null
  });
});

// ---------- Text→Video ----------
app.post("/video/generate_text", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = (b.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const input = {
      prompt,
      duration: Number.isFinite(+b.duration) ? +b.duration : CHEAP_DEFAULTS.duration,
      resolution: b.resolution || CHEAP_DEFAULTS.resolution,
      fps: 24,
      aspect_ratio: b.aspect_ratio || CHEAP_DEFAULTS.aspect_ratio,
      watermark: typeof b.watermark === "boolean" ? b.watermark : CHEAP_DEFAULTS.watermark
    };

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(createBody);
    const statusUrl = makeStatusUrl(pred.id);

    return res.json({
      status: "IN_QUEUE",
      request_id: pred.id,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// ---------- Image→Video ----------
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    const duration   = Number.isFinite(+req.body?.duration) ? +req.body.duration : CHEAP_DEFAULTS.duration;
    const resolution = req.body?.resolution || CHEAP_DEFAULTS.resolution;
    const watermark  = typeof req.body?.watermark === "string"
      ? req.body.watermark === "true"
      : CHEAP_DEFAULTS.watermark;

    const input = {
      prompt,
      image: req.file.buffer,
      duration,
      resolution,
      fps: 24,
      watermark
    };

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(createBody);
    const statusUrl = makeStatusUrl(pred.id);

    return res.json({
      status: "IN_QUEUE",
      request_id: pred.id,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// ---------- Result (stateless) ----------
app.get("/video/result/:id", async (req, res) => {
  try {
    const predId = req.params.id;

    // 1) mevcut durumu al
    let pred = await replicate.predictions.get(predId);
    let status = mapStatus(pred.status);
    let url = urlFromAny(pred.output) || urlFromJsonString(pred.output);

    // 2) succeeded ama url yoksa: KISA BEKLE & TEKRAR DENE (toplam ~6 sn)
    if (pred.status === "succeeded" && !url) {
      for (let i = 0; i < 12; i++) { // 12 * 500ms = 6s
        await sleep(500);
        pred = await replicate.predictions.get(predId);
        url = urlFromAny(pred.output) || urlFromJsonString(pred.output);
        if (url) break;
      }
      status = mapStatus(pred.status);
      if (!url) {
        console.warn("[result] succeeded but no URL yet — pred.id:", predId, " output:", JSON.stringify(pred.output));
      }
    }

    const body = { status, request_id: predId, job_id: predId };
    if (pred.status === "succeeded" && url) {
      body.video_url = url;
    }
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// status_url query formu
app.get("/video/result", async (req, res) => {
  const q = req.query.status_url;
  if (!q) return res.status(400).json({ error: "status_url required" });
  const raw = decodeURIComponent(q.toString());
  const parts = raw.split("/").filter(Boolean);
  const id = parts[parts.length - 1];
  if (!id) return res.status(400).json({ error: "invalid status_url" });
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
