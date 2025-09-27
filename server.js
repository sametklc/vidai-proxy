// server.js — Stateless + Signed URL (Cloudflare R2 private bucket)
import express from "express";
import multer from "multer";
import Replicate from "replicate";
import fetch from "node-fetch";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ===== ENV =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const SEEDANCE_MODEL_SLUG = process.env.SEEDANCE_MODEL_SLUG || "bytedance/seedance-1-pro";
const SEEDANCE_VERSION_ID = process.env.SEEDANCE_VERSION_ID || null;
const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// R2/S3 private
const PERSIST_TO_S3 = String(process.env.PERSIST_TO_S3 || "false").toLowerCase() === "true";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_REGION = process.env.S3_REGION || "auto";
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";   // e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "";
const S3_PUBLIC_BASE_URL = (process.env.S3_PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // boş bırakıyoruz

const s3 = (PERSIST_TO_S3)
  ? new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT || undefined,
      forcePathStyle: !!S3_ENDPOINT, // R2 için güvenli
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY }
    })
  : null;

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ===== utils =====
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
  const detail = e?.response?.error || e?.response?.data || e?.stack;
  console.error("[UPSTREAM ERROR]", msg, detail ? "\nDETAIL:" : "", detail || "");
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: `Invalid version or input. ${msg}`, detail: detail || null });
  }
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate.", detail: detail || null });
  }
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate.", detail: detail || null });
  }
  return res.status(502).json({ error: msg, detail: detail || null });
}

async function s3Exists(Key) {
  if (!s3) return false;
  try { await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key })); return true; } catch { return false; }
}

async function signedGetUrl(key, expiresSeconds = 3600) {
  if (!s3) return null;
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return await getSignedUrl(s3, cmd, { expiresIn: expiresSeconds }); // 1 saat
}

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

  // Public domain yok: imzalı URL dön
  return await signedGetUrl(key, 3600); // 1 saatlik signed GET
}

// ===== health
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    model: SEEDANCE_VERSION_ID || SEEDANCE_MODEL_SLUG,
    s3_bucket: PERSIST_TO_S3 ? S3_BUCKET : null,
    public_base: S3_PUBLIC_BASE_URL || null
  });
});

// ===== Text → Video
app.post("/video/generate_text", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = (b.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const input = { prompt }; // sade profil
    const body  = SEEDANCE_VERSION_ID ? { version: SEEDANCE_VERSION_ID, input }
                                      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(body);

    const statusUrl = makeStatusUrl(pred.id);
    res.json({
      status: "IN_QUEUE",
      request_id: pred.id,     // = replicate id (stateless)
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) { return httpError(res, e); }
});

// ===== Image → Video
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    const input = { prompt, image: req.file.buffer };
    const body  = SEEDANCE_VERSION_ID ? { version: SEEDANCE_VERSION_ID, input }
                                      : { model: SEEDANCE_MODEL_SLUG,  input };

    const pred = await replicate.predictions.create(body);

    const statusUrl = makeStatusUrl(pred.id);
    res.json({
      status: "IN_QUEUE",
      request_id: pred.id,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) { return httpError(res, e); }
});

// ===== Result (stateless)
app.get("/video/result/:id", async (req, res) => {
  try {
    const predId = req.params.id;
    const pred = await replicate.predictions.get(predId);
    const status = mapStatus(pred.status);

    const tmpUrl = findUrlDeep(pred.output);

    if (pred.status === "succeeded" && tmpUrl) {
      try {
        const finalUrl = await persistToS3FromUrl(predId, tmpUrl); // signed URL (1h)
        if (finalUrl) {
          return res.json({ status: "COMPLETED", request_id: predId, job_id: predId, video_url: finalUrl });
        }
      } catch (err) {
        console.warn("S3 persist failed:", err.message);
        return res.json({ status: "COMPLETED", request_id: predId, job_id: predId, video_url: tmpUrl });
      }
    }

    const body = { status, request_id: predId, job_id: predId };
    if (tmpUrl && pred.status === "succeeded") body.video_url = tmpUrl; // nadiren fallback
    return res.json(body);

  } catch (e) { return httpError(res, e); }
});

// status_url query
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
