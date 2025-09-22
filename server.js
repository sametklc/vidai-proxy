// server.js — SAFE MODE (Node 20+, ESM)
// Hedef: 422'yi izole etmek için EN BASİT inputlarla çalıştırmak.
// Model default: bytedance/seedance-1-pro (ENV ile değiştirilebilir)
// Text→Video: { prompt }
// Image→Video: { image: Buffer }  (prompt opsiyonel)
//
// Ekstra: Replicate hatasını TAM gövdesiyle loglar ve HTTP'e geçirir.

import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error("FATAL: REPLICATE_API_TOKEN missing");
}

const MODEL_SLUG = process.env.MODEL_SLUG || "bytedance/seedance-1-pro"; 
// hızlı sanity check için: MODEL_SLUG=google/veo-3-fast (Render env'de geçici değiştirebilirsin)

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

function makeStatusUrl(id) {
  const path = `/video/result/${id}`;
  return BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}${path}` : path;
}

function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

// olabilecek her köşeden URL çek (çok agresif)
function findUrlDeep(x) {
  try { if (x && typeof x.url === "function") { const u = x.url(); if (typeof u === "string" && u.startsWith("http")) return u; } } catch {}
  if (!x) return null;
  if (typeof x === "string") return x.startsWith("http") ? x : null;
  if (Array.isArray(x)) { for (const it of x) { const u = findUrlDeep(it); if (u) return u; } return null; }
  if (typeof x === "object") {
    for (const k of ["video","url","file","mp4"]) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
      const u = findUrlDeep(v); if (u) return u;
    }
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;
    for (const k of Object.keys(x)) { const u = findUrlDeep(x[k]); if (u) return u; }
  }
  return null;
}

function sendUpstreamError(res, err) {
  // Replicate SDK error gövdesini olabildiğince aç
  const status = err?.status || err?.response?.status || 502;
  const body   = err?.response?.data || err?.data || err?.message || String(err);
  console.error("[upstream error]", status, body);
  // müşteriye geçir
  try {
    if (typeof body === "object") return res.status(status).json({ error: body });
    return res.status(status).json({ error: String(body) });
  } catch {
    return res.status(502).json({ error: String(err?.message || err) });
  }
}

const JOBS = new Map();

app.get("/", (req, res) => {
  res.json({ ok: true, model: MODEL_SLUG, base_public_url: BASE_PUBLIC_URL || null });
});

// -------- Text → Video (minimal) --------
app.post("/video/generate_text", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // SADECE zorunlu alan
    const pred = await replicate.predictions.create({
      model: MODEL_SLUG,
      input: { prompt }
    });

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    const statusUrl = makeStatusUrl(requestId);
    res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (err) {
    return sendUpstreamError(res, err);
  }
});

// -------- Image → Video (minimal) --------
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });

    const prompt = (req.body?.prompt || "").toString(); // opsiyonel
    // SADECE zorunlu alan: image (Buffer)
    const pred = await replicate.predictions.create({
      model: MODEL_SLUG,
      input: { image: req.file.buffer, ...(prompt ? { prompt } : {}) }
    });

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });

    const statusUrl = makeStatusUrl(requestId);
    res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (err) {
    return sendUpstreamError(res, err);
  }
});

// -------- Polling --------
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicate.predictions.get(job.pred_id);
    const url  = findUrlDeep(pred.output);

    const body = { status: mapStatus(pred.status), request_id: req.params.id, job_id: job.pred_id };
    if (url) body.video_url = url;

    if (pred.status === "succeeded" && !url) {
      console.warn("[result] succeeded but no url found → pred.id:", pred.id, " output:", JSON.stringify(pred.output));
    }
    res.json(body);
  } catch (err) {
    return sendUpstreamError(res, err);
  }
});

// status_url ile
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
  } catch (err) {
    return sendUpstreamError(res, err);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
