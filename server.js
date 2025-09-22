// server.js — vidai-proxy (Node 20+, ESM)
// Model: bytedance/seedance-1-pro (hem Text→Video hem Image→Video)
// Özellikler:
//  - Ucuz varsayılanlar: duration=3s, resolution=480p, fps=16 (override edilebilir)
//  - Image upload: data URL yerine RAW Buffer (SDK kendi upload eder) -> 422 azalır
//  - status_url ABSOLUTE üretimi (BASE_PUBLIC_URL varsa)
//  - video URL çıkarma için derin tarayıcı (findUrlDeep)
//  - Android sözleşmesiyle uyumlu JSON: {status, request_id, status_url, response_url, job_id, video_url?}

import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ===== ENV =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const SEEDANCE_MODEL_SLUG = process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-pro";
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;

// ABSOLUTE status_url için (örn: https://vidai-proxy.onrender.com)
const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// ===== “UCUZ MOD” VARSAYILANLAR =====
const CHEAP_DEFAULTS = {
  duration: 3,          // 3–12 arası (düşük tut daha ucuz)
  resolution: "480p",   // 480p veya 1080p
  fps: 16,              // varsayılan 24, düşürmek maliyeti azaltır
  aspect_ratio: undefined, // T2V için geçerli; I2V'de yok sayılır
  watermark: false
};

// ===== Replicate SDK =====
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ===== Helpers =====
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

// Derin recursive URL arayıcı: obj/arr/string içinde ilk http(.mp4) benzeri linki döndürür
function findUrlDeep(x) {
  try {
    if (x && typeof x.url === "function") {
      const u = x.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch {}

  if (!x) return null;

  if (typeof x === "string") {
    return x.startsWith("http") ? x : null;
  }

  if (Array.isArray(x)) {
    for (const it of x) {
      const u = findUrlDeep(it);
      if (u) return u;
    }
    return null;
  }

  if (typeof x === "object") {
    // yaygın anahtarlar
    for (const k of ["video", "url", "file", "mp4"]) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
      const u = findUrlDeep(v);
      if (u) return u;
    }
    // { urls: { get: "http..." } }
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;

    // tüm alanlar
    for (const k of Object.keys(x)) {
      const u = findUrlDeep(x[k]);
      if (u) return u;
    }
  }
  return null;
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate. Lütfen Replicate hesabınıza kart/limit ekleyin." });
  }
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate. Bu modele erişim izniniz yok." });
  }
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: "Invalid version or input. Input/slug/version kontrol edin." });
  }
  return res.status(502).json({ error: msg });
}

const JOBS = new Map();

function makeStatusUrl(requestId) {
  const path = `/video/result/${requestId}`;
  if (BASE_PUBLIC_URL) return `${BASE_PUBLIC_URL}${path}`;
  return path;
}

// ===== Health =====
app.get("/", (req, res) => {
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

    const input = {
      prompt,
      duration: Number.isFinite(+b.duration) ? +b.duration : CHEAP_DEFAULTS.duration,
      resolution: b.resolution || CHEAP_DEFAULTS.resolution,
      fps: Number.isFinite(+b.fps) ? +b.fps : CHEAP_DEFAULTS.fps,
      aspect_ratio: b.aspect_ratio || CHEAP_DEFAULTS.aspect_ratio,
      watermark: typeof b.watermark === "boolean" ? b.watermark : CHEAP_DEFAULTS.watermark
    };

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(createBody);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    const statusUrl = makeStatusUrl(requestId);
    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
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

    // Ucuz varsayılanlar + form override
    const duration   = Number.isFinite(+req.body?.duration) ? +req.body.duration : CHEAP_DEFAULTS.duration;
    const resolution = req.body?.resolution || CHEAP_DEFAULTS.resolution;
    const fps        = Number.isFinite(+req.body?.fps) ? +req.body.fps : CHEAP_DEFAULTS.fps;
    const watermark  = typeof req.body?.watermark === "string"
      ? req.body.watermark === "true"
      : CHEAP_DEFAULTS.watermark;

    // ÖNEMLİ: data URL yerine RAW BUFFER veriyoruz (SDK kendi upload eder)
    const input = {
      prompt,
      image: req.file.buffer,   // <-- Buffer (100MB'a kadar güvenli)
      duration,
      resolution,
      fps,
      watermark
    };

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(createBody);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });

    const statusUrl = makeStatusUrl(requestId);
    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// ===== Result (ID ile) =====
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicate.predictions.get(job.pred_id);
    const url = findUrlDeep(pred.output);

    const body = {
      status: mapStatus(pred.status),
      request_id: req.params.id,
      job_id: job.pred_id
    };
    if (url) body.video_url = url;

    if (pred.status === "succeeded" && !url) {
      console.warn("[result] succeeded but no url found → pred.id:", pred.id, " output:", JSON.stringify(pred.output));
    }
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// ===== Result (status_url ile) =====
app.get("/video/result", async (req, res) => {
  try {
    const q = req.query.status_url;
    if (!q) return res.status(400).json({ error: "status_url required" });
    const raw = decodeURIComponent(q.toString());
    const parts = raw.split("/").filter(Boolean);
    const id = parts[parts.length - 1];
    if (!id) return res.status(400).json({ error: "invalid status_url" });
    req.params.id = id;
    return app._router.handle(req, res, () => {});
  } catch (e) {
    return httpError(res, e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
