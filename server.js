// server.js — Replicate SDK ile proxy
// Text→Video: google/veo-3-fast
// Image→Video: pixverse/pixverse-v5  (gerekirse v4.5'e geçersin)
// Not: Replicate SDK ile model "slug" veriyoruz; version ID vermek şart değil.

import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// -------- ENV
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error("FATAL: REPLICATE_API_TOKEN missing");
}
const TEXT_MODEL  = process.env.TEXT_MODEL_SLUG  || "google/veo-3-fast";
const IMAGE_MODEL = process.env.IMAGE_MODEL_SLUG || "pixverse/pixverse-v5";

// İstersen versiyona kilitlemek için (opsiyonel): bu ikisini doldurursan 'model' yerine 'version' alanını kullanacağız
const TEXT_VERSION_ID  = process.env.TEXT_VERSION_ID  || null;
const IMAGE_VERSION_ID = process.env.IMAGE_VERSION_ID || null;

// -------- Replicate client (SDK)
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// -------- Helpers
function mapStatus(s) {
  // Replicate prediction.status: "starting" | "processing" | "succeeded" | "failed" | "canceled"
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

function extractVideoUrl(output) {
  // SDK ile output bazen dizi, bazen File-like olabilir. Esnek davranalım.
  if (!output) return null;

  // 1) replicate File-like objesinde url() metodu olabilir
  try {
    if (typeof output.url === "function") {
      return output.url(); // string
    }
  } catch (_) {}

  // 2) Dizi ise son eleman genelde URL string
  if (Array.isArray(output) && output.length) {
    const last = output[output.length - 1];
    if (typeof last === "string") return last;
    // dizide obje varsa url alanını dene
    if (last && typeof last === "object") {
      if (typeof last.url === "string") return last.url;
      if (Array.isArray(last.output) && last.output.length && typeof last.output[0] === "string") return last.output[0];
    }
  }

  // 3) Düz string ise
  if (typeof output === "string") return output;

  // 4) Obje ise muhtemel alanlar
  if (typeof output === "object") {
    for (const k of ["video", "url", "mp4", "output", "result"]) {
      const v = output[k];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length && typeof v[0] === "string") return v[0];
    }
  }

  return null;
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  // Daha anlaşılır hata mesajları
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate. Lütfen Replicate hesabınıza kart/limit ekleyin." });
  }
  if (msg.includes("permission") || msg.includes("Permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate. Bu modele erişim izniniz yok (veo-3 yerine veo-3-fast deneyin)." });
  }
  if (msg.includes("version") && msg.includes("Invalid") || msg.includes("422")) {
    return res.status(422).json({ error: "Invalid version or input. Version ID/slug veya input alanları hatalı olabilir." });
  }
  return res.status(502).json({ error: msg });
}

// Basit in-memory store (production için Redis önerilir)
const JOBS = new Map();

// -------- Health
app.get("/", (req, res) => {
  res.json({ ok: true, text_model: TEXT_VERSION_ID || TEXT_MODEL, image_model: IMAGE_VERSION_ID || IMAGE_MODEL });
});

// -------- Text → Video
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });

    // Replicate SDK ile "prediction" oluştur (queue)
    const createBody = TEXT_VERSION_ID
      ? { version: TEXT_VERSION_ID, input: { prompt } }
      : { model: TEXT_MODEL,       input: { prompt } };

    const pred = await replicate.predictions.create(createBody);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// -------- Image → Video
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    // Bazı modeller "image", bazıları "input_image" bekleyebilir; iki deneme yapalım.
    const tryInputs = [
      { prompt, image: dataUrl },
      { prompt, input_image: dataUrl }
    ];

    let pred = null, errLast = null;
    for (const input of tryInputs) {
      try {
        const createBody = IMAGE_VERSION_ID
          ? { version: IMAGE_VERSION_ID, input }
          : { model: IMAGE_MODEL,        input };
        pred = await replicate.predictions.create(createBody);
        break;
      } catch (ee) {
        errLast = ee;
      }
    }
    if (!pred) throw errLast || new Error("model input format not accepted");

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// -------- Result (ID ile)
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicate.predictions.get(job.pred_id);
    const body = { status: mapStatus(pred.status), request_id: req.params.id };

    const url = extractVideoUrl(pred.output);
    if (url) body.video_url = url;

    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// -------- Result (status_url ile)
app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({ error: "status_url required" });
  const id = statusUrl.toString().split("/").pop();
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
