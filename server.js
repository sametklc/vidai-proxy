// server.js — vidai-proxy (Node 20+, ESM)
// SADECE ByteDance Seedance-1-Pro kullanır (hem T2V hem I2V).
// Android tarafı ile sözleşme:
//   POST /video/generate_text   {prompt}
//   POST /video/generate_image  multipart: image, prompt
//   GET  /video/result/:id      -> {status, video_url?}
// Replicate SDK ile "slug" kullanıyoruz; version ID zorunlu DEĞİL.

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

// Tek model: bytedance/seedance-1-pro
const SEEDANCE_MODEL_SLUG = process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-pro";
// (Opsiyonel) Versiyona kilitlemek istersen (gerekli değil):
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;

// ----- Replicate SDK client
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ----- Helpers
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

// Seedance çıkışı farklı formatlarda gelebilir; sağlam URL çıkarıcı:
function extractVideoUrl(output) {
  if (!output) return null;

  // 1) SDK File-like: .url()
  try {
    if (typeof output.url === "function") {
      const u = output.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch (_) {}

  // 2) Array
  if (Array.isArray(output) && output.length) {
    // en sonda string URL olabiliyor
    const last = output[output.length - 1];
    if (typeof last === "string" && last.startsWith("http")) return last;
    // objeler içinde url/file/video/mp4 alanlarına bak
    for (const it of output) {
      if (typeof it === "string" && it.startsWith("http")) return it;
      if (it && typeof it === "object") {
        for (const k of ["url", "file", "video", "mp4"]) {
          if (typeof it[k] === "string" && it[k].startsWith("http")) return it[k];
        }
        if (Array.isArray(it.output) && it.output.length && typeof it.output[0] === "string" && it.output[0].startsWith("http")) {
          return it.output[0];
        }
      }
    }
  }

  // 3) Düz string
  if (typeof output === "string" && output.startsWith("http")) return output;

  // 4) Obje: muhtemel alanlar
  if (typeof output === "object") {
    for (const k of ["video", "url", "file", "mp4"]) {
      const v = output[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
    }
    if (Array.isArray(output.output) && output.output.length && typeof output.output[0] === "string") {
      if (output.output[0].startsWith("http")) return output.output[0];
    }
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
    return res.status(403).json({ error: "Permission denied on Replicate. Bu modele erişim izniniz yok." });
  }
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: "Invalid version or input. Input/slug/version kontrol edin." });
  }
  return res.status(502).json({ error: msg });
}

// basit in-memory store (prod için Redis önerilir)
const JOBS = new Map();

// ----- Health
app.get("/", (req, res) => {
  res.json({
    ok: true,
    model: SEEDANCE_VERSION_ID || SEEDANCE_MODEL_SLUG
  });
});

// ----- Text → Video (Seedance: prompt)
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });

    // Seedance opsiyonelleri istersen body’den ileride alabiliriz:
    // const { duration=5, resolution="1080p", aspect_ratio="16:9", fps=24 } = req.body || {};
    const input = { prompt }; // şimdilik varsayılanları kullanıyoruz (duration 5s, 1080p, vs.)

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

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

// ----- Image → Video (Seedance: image + prompt)
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    // Seedance 'image' alanını kabul ediyor; data URL iş görüyor.
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");
    const input = { prompt, image: dataUrl };

    const createBody = SEEDANCE_VERSION_ID
      ? { version: SEEDANCE_VERSION_ID, input }
      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(createBody);

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
