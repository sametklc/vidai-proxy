import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));
const upload = multer();

// Basit in-memory job map (üretimde Redis düşünebilirsin)
const JOBS = new Map();

// Env
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) {
  console.warn("WARN: REPLICATE_API_TOKEN env yok! Render tarafında eklemeyi unutma.");
}

// Model version/tag (gerekirse güncelle)
const PIKA_VERSION = process.env.PIKA_VERSION || "pika-labs/pika-1:latest";
const SVD_VERSION  = process.env.SVD_VERSION  || "stability-ai/stable-video-diffusion:latest";

// Yardımcılar
async function replicatePost(model, input) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ version: model, input })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Replicate ${r.status}: ${text}`);
  }
  return r.json();
}

async function replicateGet(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { "Authorization": `Token ${REPLICATE_TOKEN}` }
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Replicate ${r.status}: ${text}`);
  }
  return r.json();
}

function mapStatus(s) {
  // starting, processing, succeeded, failed, canceled
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing") return "IN_PROGRESS";
  return "IN_QUEUE";
}

function extractUrl(output) {
  if (!output) return null;
  if (Array.isArray(output) && output.length) return output[output.length - 1];
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    for (const k of ["video", "url", "output"]) {
      if (typeof output[k] === "string") return output[k];
    }
  }
  return null;
}

// ---- Text -> Video ----
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt required" });
    }
    const pred = await replicatePost(PIKA_VERSION, { prompt });
    const id = randomUUID();
    JOBS.set(id, { pred_id: pred.id, type: "text", created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: id,
      status_url: `/video/result/${id}`,
      response_url: `/video/result/${id}`
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ---- Image -> Video ----
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart form field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    // Pek çok Replicate modeli data URL kabul eder.
    // Eğer kullandığın sürüm URL isterse, burada bir dosya upload servisi kullanıp (örn tmpfiles.org)
    // linki inputa koyabilirsin. İlk deneme için data URL:
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    const pred = await replicatePost(SVD_VERSION, {
      input_image: dataUrl,
      prompt
    });

    const id = randomUUID();
    JOBS.set(id, { pred_id: pred.id, type: "image", created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: id,
      status_url: `/video/result/${id}`,
      response_url: `/video/result/${id}`
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ---- Result by id ----
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicateGet(job.pred_id);
    const body = { status: mapStatus(pred.status), request_id: req.params.id };
    const url = extractUrl(pred.output);
    if (url) body.video_url = url;
    return res.json(body);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ---- Result by status_url (query) ----
app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({ error: "status_url required" });
  const id = statusUrl.toString().split("/").pop();
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

// (Opsiyonel) Health check
app.get("/", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
