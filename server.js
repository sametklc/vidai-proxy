// server.js — vidai-proxy (Node 20+, ESM)
// Replicate SDK kullanır: model slug ile çalışır (version ID şart değil).
// Text→Video: google/veo-3-fast (gated olmayan hızlı sürüm)
// Image→Video: pixverse/pixverse-v5 (gerekirse v4.5'e geçebilirsin)

import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ----- ENV
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const TEXT_MODEL  = process.env.TEXT_MODEL_SLUG  || "google/veo-3-fast";
const IMAGE_MODEL = process.env.IMAGE_MODEL_SLUG || "pixverse/pixverse-v5";
// (opsiyonel) Sürümü sabitlemek istersen:
const TEXT_VERSION_ID  = process.env.TEXT_VERSION_ID  || null;
const IMAGE_VERSION_ID = process.env.IMAGE_VERSION_ID || null;

// ----- Replicate SDK client
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ----- Utils
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

// Replicate farklı output formatları verebiliyor. Hepsini tarayalım.
function extractVideoUrl(output) {
  if (!output) return null;

  // 1) SDK run() ile File-like gelebilir: .url()
  try {
    if (typeof output.url === "function") {
      const u = output.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch (_) {}

  // 2) Dizi ise: string / object[url|file|video|output[0]]
  if (Array.isArray(output) && output.length) {
    const last = output[output.length - 1];
    if (typeof last === "string" && last.startsWith("http")) return last;
    if (last && typeof last === "object") {
      if (typeof last.url === "string") return last.url;
      if (typeof last.file === "string") return last.file;
      if (typeof last.video === "string") return last.video;
      if (Array.isArray(last.output) && last.output.length && typeof last.output[0] === "string") return last.output[0];
    }
    // tüm elemanları dolaş:
    for (const it of output) {
      if (typeof it === "string" && it.startsWith("http")) return it;
      if (it && typeof it === "object") {
        for (const k of ["url", "file", "video", "mp4"]) {
          if (typeof it[k] === "string" && it[k].startsWith("http")) return it[k];
        }
      }
    }
  }

  // 3) Düz string
  if (typeof output === "string" && output.startsWith("http")) return output;

  // 4) Obje: muhtemel alanlar
  if (typeof output === "object") {
    for (const k of ["video", "url", "file", "mp4"]) {
      if (typeof output[k] === "string" && output[k].startsWith("http")) return output[k];
    }
    if (Array.isArray(output.output) && output.output.length && typeof output.output[0] === "string") {
      if (output.output[0].startsWith("http")) return output.output[0];
    }
    // bazen { urls: { get: "http..." } } gibi olur
    if (output.urls && typeof output.urls.get === "string") return output.urls.get;
  }

  return null;
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate. Lütfen Replicate hesabınıza kart/limit ekleyin." });
  }
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate. Bu modele erişim izniniz yok (veo-3 yerine veo-3-fast deneyin)." });
  }
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: "Invalid version or input. Version ID/slug veya input alanları hatalı olabilir." });
  }
  return res.status(502).json({ error: msg });
}

// basit in-memory store
const JOBS = new Map();

// ----- Health
app.get("/", (req, res) => {
  res.json({
    ok: true,
    text_model: TEXT_VERSION_ID || TEXT_MODEL,
    image_model: IMAGE_VERSION_ID || IMAGE_MODEL
  });
});

// ----- Text → Video
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });

    const createBody = TEXT_VERSION_ID
      ? { version: TEXT_VERSION_ID, input: { prompt } }
      : { model: TEXT_MODEL,        input: { prompt } };

    const pred = await replicate.predictions.create(createBody);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// ----- Image → Video
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    // Farklı input anahtarlarını sırayla dene
    const candidates = [
      { prompt, image: dataUrl },
      { prompt, input_image: dataUrl },
      { prompt, image_url: dataUrl } // bazı modeller sadece URL ister; data URL de kabul edebilir
    ];

    let pred = null;
    let lastErr = null;
    for (const input of candidates) {
      try {
        const createBody = IMAGE_VERSION_ID
          ? { version: IMAGE_VERSION_ID, input }
          : { model: IMAGE_MODEL,        input };
        pred = await replicate.predictions.create(createBody);
        break;
      } catch (ee) {
        lastErr = ee;
      }
    }
    if (!pred) throw lastErr || new Error("model did not accept any image field");

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// ----- Result (ID ile)
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicate.predictions.get(job.pred_id);
    const url = extractVideoUrl(pred.output);

    const body = {
      status: mapStatus(pred.status),
      request_id: req.params.id,
      job_id: job.pred_id
    };
    if (url) body.video_url = url;

    // debug log
    if (pred.status === "succeeded" && !url) {
      console.warn("[result] succeeded but no url found → pred.id:", pred.id, " output:", JSON.stringify(pred.output));
    }
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// ----- Result (status_url ile)
app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({ error: "status_url required" });
  const id = statusUrl.toString().split("/").pop();
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
