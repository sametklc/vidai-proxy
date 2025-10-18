// server.js — SeeDance (bytedance/seedance) proxy — fps=24 fix
// - Text→Video ve Image→Video
// - Ucuz varsayılanlar: duration=3, resolution=480p, fps=24 (API bunu istiyor)
// - Stateless: request_id = prediction.id
// - Android sözleşmesi: { status, request_id, status_url, response_url, job_id, video_url? }

import express from "express";
import multer from "multer";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ===== ENV =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error("FATAL: REPLICATE_API_TOKEN missing");
}

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// Model seçimi: lite (ucuz) veya pro (pahalı)
const SEEDANCE_MODEL_SLUG =
  process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-lite";
// İstersen spesifik version id ver:
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;

// “Ucuz” defaultlar — fps MUTLAKA 24!
const CHEAP_DEFAULTS = {
  duration: 3,          // maliyet düşürmek için kısa tut
  resolution: "480p",   // lite: 480p/720p, pro: 480p/1080p
  fps: 24,              // SeeDance API 24 istiyor
  aspect_ratio: "16:9",
  watermark: false
};

// Replicate SDK
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// Helpers
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

function findUrlDeep(x) {
  try {
    if (x && typeof x.url === "function") {
      const u = x.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch {}
  if (!x) return null;
  if (typeof x === "string") return x.startsWith("http") ? x : null;
  if (Array.isArray(x)) {
    for (const it of x) {
      const u = findUrlDeep(it);
      if (u) return u;
    }
    return null;
  }
  if (typeof x === "object") {
    for (const k of ["video", "url", "file", "mp4"]) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
      const u = findUrlDeep(v);
      if (u) return u;
    }
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;
    for (const k of Object.keys(x)) {
      const u = findUrlDeep(x[k]);
      if (u) return u;
    }
  }
  return null;
}

function makeStatusUrl(requestId) {
  const path = `/video/result/${requestId}`;
  return BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}${path}` : path;
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

// ===== Health =====
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    model: SEEDANCE_VERSION_ID || SEEDANCE_MODEL_SLUG,
    base_public_url: BASE_PUBLIC_URL || null
  });
});

// ===== Text → Video =====
app.post("/video/generate_text", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = (b.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // Gelen fps ne olursa olsun 24'e zorluyoruz (API uyumu)
    const fps = 24;

    const input = {
      prompt,
      duration: Number.isFinite(+b.duration) ? +b.duration : CHEAP_DEFAULTS.duration,
      resolution: b.resolution || CHEAP_DEFAULTS.resolution,
      fps, // ZORLA 24
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

// ===== Image → Video =====
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    // fps 24'e sabit
    const fps = 24;

    const duration   = Number.isFinite(+req.body?.duration) ? +req.body.duration : CHEAP_DEFAULTS.duration;
    const resolution = req.body?.resolution || CHEAP_DEFAULTS.resolution;
    const watermark  = typeof req.body?.watermark === "string"
      ? req.body.watermark === "true"
      : CHEAP_DEFAULTS.watermark;

    const input = {
      prompt,
      image: req.file.buffer, // Buffer veriyoruz
      duration,
      resolution,
      fps,        // ZORLA 24
      watermark
      // aspect_ratio → I2V'de genelde yok sayılıyor; göndermiyoruz
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

// ===== Result (stateless) =====
app.get("/video/result/:id", async (req, res) => {
  try {
    const predId = req.params.id;
    const pred = await replicate.predictions.get(predId);
    const status = mapStatus(pred.status);
    const url = findUrlDeep(pred.output);

    const body = { status, request_id: predId, job_id: predId };
    if (pred.status === "succeeded" && url) {
      body.video_url = url;
    }
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// ===== status_url query formu =====
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
