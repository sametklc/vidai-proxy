// server.js — vidai-proxy (Node 20+, ESM) — Cloudflare R2 / S3 compatible
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";
import fetch from "node-fetch";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ===== ENV =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const SEEDANCE_MODEL_SLUG = process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-lite";
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// S3-compatible (R2/S3)
const PERSIST_TO_S3 = String(process.env.PERSIST_TO_S3 || "false").toLowerCase() === "true";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_REGION = process.env.S3_REGION || "auto";
const S3_ENDPOINT = process.env.S3_ENDPOINT || ""; // R2: https://<account>.r2.cloudflarestorage.com
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "";
const S3_PUBLIC_BASE_URL = (process.env.S3_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const s3 = (PERSIST_TO_S3)
  ? new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT || undefined,
      forcePathStyle: !!S3_ENDPOINT, // R2 çoğu zaman path-style ister
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY
      }
    })
  : null;

// ===== Ucuz varsayılanlar =====
const CHEAP_DEFAULTS = {
  duration: 3,
  resolution: "480p",
  fps: 16,
  aspect_ratio: undefined,
  watermark: false
};

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ===== Utils =====
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

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

function makeStatusUrl(id) {
  const path = `/video/result/${id}`;
  return BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}${path}` : path;
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  if (msg.includes("Payment") || msg.includes("402")) return res.status(402).json({ error: "Payment required on Replicate." });
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) return res.status(403).json({ error: "Permission denied on Replicate." });
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) return res.status(422).json({ error: "Invalid version or input." });
  return res.status(502).json({ error: msg });
}

// S3'te obje var mı (retry'lerde gereksiz upload'ı engellemek için)?
async function s3Exists(Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key }));
    return true;
  } catch {
    return false;
  }
}

// Replicate URL → S3 (R2) upload → kalıcı public URL
async function persistToS3FromUrl(predId, fileUrl) {
  if (!PERSIST_TO_S3 || !s3) return null;
  if (!fileUrl || !fileUrl.startsWith("http")) return null;

  const key = `replicate/${predId}/${Date.now()}.mp4`;

  const exists = await s3Exists(key);
  if (!exists) {
    const r = await fetch(fileUrl);
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: "video/mp4"
    }));
  }

  // Public URL (public bucket + CDN base varsa)
  if (S3_PUBLIC_BASE_URL) {
    return `${S3_PUBLIC_BASE_URL}/${key}`;
  }
  // public base yoksa doğrudan S3 endpoint URL'i (çoğu zaman public değil)
  if (S3_ENDPOINT) {
    return `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  }
  // klasik S3 format (AWS S3 kullanıyorsan)
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// In-memory job store
const JOBS = new Map(); // id -> { type, pred_id, created, persisted_url?, prompt?, userId? }

// ===== Health =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    model: SEEDANCE_VERSION_ID || SEEDANCE_MODEL_SLUG,
    base_public_url: BASE_PUBLIC_URL || null,
    s3_bucket: PERSIST_TO_S3 ? S3_BUCKET : null
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

    const body = SEEDANCE_VERSION_ID ? { version: SEEDANCE_VERSION_ID, input }
                                     : { model: SEEDANCE_MODEL_SLUG,  input };
    const pred = await replicate.predictions.create(body);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now(), prompt });

    const statusUrl = makeStatusUrl(requestId);
    res.json({ status: "IN_QUEUE", request_id: requestId, status_url: statusUrl, response_url: statusUrl, job_id: pred.id });
  } catch (e) { return httpError(res, e); }
});

// ===== Image → Video =====
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    const duration   = Number.isFinite(+req.body?.duration) ? +req.body.duration : CHEAP_DEFAULTS.duration;
    const resolution = req.body?.resolution || CHEAP_DEFAULTS.resolution;
    const fps        = Number.isFinite(+req.body?.fps) ? +req.body.fps : CHEAP_DEFAULTS.fps;
    const watermark  = typeof req.body?.watermark === "string" ? req.body.watermark === "true" : CHEAP_DEFAULTS.watermark;

    const input = { prompt, image: req.file.buffer, duration, resolution, fps, watermark };

    const body = SEEDANCE_VERSION_ID ? { version: SEEDANCE_VERSION_ID, input }
                                     : { model: SEEDANCE_MODEL_SLUG,  input };
    const pred = await replicate.predictions.create(body);

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now(), prompt });

    const statusUrl = makeStatusUrl(requestId);
    res.json({ status: "IN_QUEUE", request_id: requestId, status_url: statusUrl, response_url: statusUrl, job_id: pred.id });
  } catch (e) { return httpError(res, e); }
});

// ===== Result =====
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await replicate.predictions.get(job.pred_id);
    const status = mapStatus(pred.status);

    if (job.persisted_url) {
      return res.json({ status, request_id: req.params.id, job_id: job.pred_id, video_url: job.persisted_url });
    }

    const tmpUrl = findUrlDeep(pred.output);

    if (pred.status === "succeeded" && tmpUrl) {
      try {
        const finalUrl = await persistToS3FromUrl(pred.id, tmpUrl);
        if (finalUrl) {
          job.persisted_url = finalUrl;
          return res.json({ status: "COMPLETED", request_id: req.params.id, job_id: job.pred_id, video_url: finalUrl });
        }
      } catch (e) {
        console.warn("S3 persist failed:", e.message);
      }
    }

    const body = { status, request_id: req.params.id, job_id: job.pred_id };
    if (tmpUrl && pred.status === "succeeded") body.video_url = tmpUrl; // fallback (1 saatlik)
    return res.json(body);
  } catch (e) { return httpError(res, e); }
});

// status_url ile
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
