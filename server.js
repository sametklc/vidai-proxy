import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "12mb" }));
const upload = multer();

const JOBS = new Map();
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;

if (!REPLICATE_TOKEN) {
  console.error("FATAL: REPLICATE_API_TOKEN missing");
}

// Slug ver (owner/name); kod latest version ID'yi çekecek
const PIKA_SLUG = process.env.PIKA_SLUG || "pika-labs/pika-1";
const SVD_SLUG  = process.env.SVD_SLUG  || "stability-ai/stable-video-diffusion";

// İsteğe bağlı: version id'yi direkt ENV ile override et
let PIKA_VERSION = process.env.PIKA_VERSION_ID || null;
let SVD_VERSION  = process.env.SVD_VERSION_ID  || null;

async function getLatestVersionId(slug) {
  const r = await fetch(`https://api.replicate.com/v1/models/${slug}/versions`, {
    headers: { Authorization: `Token ${REPLICATE_TOKEN}` }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`list versions ${slug} -> ${r.status}: ${txt}`);
  const j = JSON.parse(txt);
  if (!j?.results?.length) throw new Error(`no versions for ${slug}`);
  // results genelde yeni→eski sıralı gelir; ilkini al
  return j.results[0].id;
}

// Boot aşamasında version ID'yi çöz
async function ensureVersionIds() {
  if (!PIKA_VERSION) PIKA_VERSION = await getLatestVersionId(PIKA_SLUG);
  if (!SVD_VERSION)  SVD_VERSION  = await getLatestVersionId(SVD_SLUG);
  console.log("Using versions:", { PIKA_VERSION, SVD_VERSION });
}

function mapStatus(s) {
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

async function replicatePost(versionId, input) {
  const body = { version: versionId, input };
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`upstream ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function replicateGet(predId) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
    headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`upstream ${r.status}: ${text}`);
  return JSON.parse(text);
}

// --- Health ---
app.get("/", (req, res) => res.json({ ok: true }));

// --- Text -> Video ---
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
    await ensureVersionIds();
    const pred = await replicatePost(PIKA_VERSION, { prompt });
    const id = randomUUID();
    JOBS.set(id, { pred_id: pred.id, type: "text", created: Date.now() });
    return res.json({
      status: "IN_QUEUE",
      request_id: id,
      status_url: `/video/result/${id}`,
      response_url: `/video/result/${id}`,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// --- Image -> Video ---
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();
    await ensureVersionIds();

    // Bazı modeller data URL kabul etmezse burada public URL'e yükleme stratejisine geçebilirsin
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    // Önce input_image dene, olmazsa image dene
    try {
      const pred = await replicatePost(SVD_VERSION, { input_image: dataUrl, prompt });
      const id = randomUUID();
      JOBS.set(id, { pred_id: pred.id, type: "image", created: Date.now() });
      return res.json({ status: "IN_QUEUE", request_id: id, status_url: `/video/result/${id}`, response_url: `/video/result/${id}` });
    } catch (e) {
      const pred2 = await replicatePost(SVD_VERSION, { image: dataUrl, prompt });
      const id = randomUUID();
      JOBS.set(id, { pred_id: pred2.id, type: "image", created: Date.now() });
      return res.json({ status: "IN_QUEUE", request_id: id, status_url: `/video/result/${id}`, response_url: `/video/result/${id}` });
    }
  } catch (e) {
    return res.status(502).json({ error: String(e), hint: "If the model rejects data URLs, upload the file to a public URL and pass that URL instead." });
  }
});

// --- Result ---
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

app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({ error: "status_url required" });
  const id = statusUrl.toString().split("/").pop();
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
