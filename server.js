// server.js — Multi-model proxy (vidai/veo3/wan/sora2)
import express from "express";
import multer from "multer";
import Replicate from "replicate";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// Model ENV (slug + optional version)
const MODEL_VIDAI_SLUG   = process.env.MODEL_VIDAI_SLUG   || "bytedance/seedance-1-lite";
const MODEL_VIDAI_VER    = process.env.MODEL_VIDAI_VER    || null;

const MODEL_VEO3_SLUG    = process.env.MODEL_VEO3_SLUG    || "google/veo-3-fast";
const MODEL_VEO3_VER     = process.env.MODEL_VEO3_VER     || null;

// --- DÜZELTME: WAN ve Sora2 için varsayılan model ataması ---
const MODEL_WAN_SLUG     = process.env.MODEL_WAN_SLUG     || "wan-video/wan-2.2-i2v-fast"; // ÖRNEK: Kendi modelinle değiştir
const MODEL_WAN_VER      = process.env.MODEL_WAN_VER      || null;

const MODEL_SORA2_SLUG   = process.env.MODEL_SORA2_SLUG   || "lucataco/animate-diff-v3-bonsai"; // ÖRNEK: Kendi modelinle değiştir
const MODEL_SORA2_VER    = process.env.MODEL_SORA2_VER    || null;
// --- DÜZELTME SONU ---

const CHEAP_DEFAULTS = {
  duration: 3,
  resolution: "480p",
  aspect_ratio: "16:9",
  watermark: false
};

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

function urlFromAny(x) {
  if (!x) return null;
  if (typeof x === "string") return x.startsWith("http") ? x : null;

  try {
    if (typeof x.url === "function") {
      const u = x.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch {}

  if (Array.isArray(x)) {
    for (const it of x) {
      const u = urlFromAny(it);
      if (u) return u;
    }
    return null;
  }

  if (typeof x === "object") {
    const direct = ["video_url", "video", "url", "mp4", "file", "output_url", "result_url", "media_url"];
    for (const k of direct) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
    }
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;
    if (typeof x.output === "string" && x.output.startsWith("http")) return x.output;

    const u1 = urlFromAny(x.output);
    if (u1) return u1;

    for (const k of Object.keys(x)) {
      const u = urlFromAny(x[k]);
      if (u) return u;
    }
  }
  return null;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function makeStatusUrl(id) {
  const path = `/video/result/${id}`;
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

function resolveModel(modelKey) {
  const key = (modelKey || "vidai").toLowerCase();
  switch (key) {
    case "vidai":
      return { slug: MODEL_VIDAI_SLUG, version: MODEL_VIDAI_VER, needsFps24: true, supportsImage: true };
    case "veo3":
      return { slug: MODEL_VEO3_SLUG, version: MODEL_VEO3_VER, needsFps24: false, supportsImage: true };
    case "wan":
      if (!MODEL_WAN_SLUG) throw new Error("WAN model not configured on server.");
      return { slug: MODEL_WAN_SLUG, version: MODEL_WAN_VER, needsFps24: false, supportsImage: true };
    case "sora2":
      if (!MODEL_SORA2_SLUG) throw new Error("Sora-2 model not configured on server.");
      return { slug: MODEL_SORA2_SLUG, version: MODEL_SORA2_VER, needsFps24: false, supportsImage: true };
    default:
      return { slug: MODEL_VIDAI_SLUG, version: MODEL_VIDAI_VER, needsFps24: true, supportsImage: true };
  }
}

async function buildResultResponse(predId) {
  let pred = await replicate.predictions.get(predId);
  let url = urlFromAny(pred.output);
  if (pred.status === "succeeded" && !url) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      pred = await replicate.predictions.get(predId);
      url = urlFromAny(pred.output);
      if (url) break;
    }
  }
  const body = { status: mapStatus(pred.status), request_id: predId, job_id: predId };
  if (pred.status === "succeeded" && url) body.video_url = url;
  return body;
}

// Health
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    base_public_url: BASE_PUBLIC_URL || null,
    defaults: {
      vidai: MODEL_VIDAI_SLUG,
      veo3: MODEL_VEO3_SLUG,
      wan: MODEL_WAN_SLUG || "(not set)",
      sora2: MODEL_SORA2_SLUG || "(not set)"
    }
  });
});

// Text → Video
app.post("/video/generate_text", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = (b.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const modelKey = (b.model || "vidai").toString();
    const model = resolveModel(modelKey);

    const input = {
      prompt,
      duration: Number.isFinite(+b.duration) ? +b.duration : CHEAP_DEFAULTS.duration,
      resolution: b.resolution || CHEAP_DEFAULTS.resolution,
      aspect_ratio: b.aspect_ratio || CHEAP_DEFAULTS.aspect_ratio,
      watermark: typeof b.watermark === "boolean" ? b.watermark : CHEAP_DEFAULTS.watermark
    };
    if (model.needsFps24) input.fps = 24; // SeeDance gibi

    const createBody = model.version
      ? { version: model.version, input }
      : { model: model.slug, input };

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

// Image → Video
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();
    const modelKey = (req.body?.model || "vidai").toString();
    const model = resolveModel(modelKey);

    const duration   = Number.isFinite(+req.body?.duration) ? +req.body.duration : CHEAP_DEFAULTS.duration;
    const resolution = req.body?.resolution || CHEAP_DEFAULTS.resolution;
    const watermark  = typeof req.body?.watermark === "string"
      ? req.body.watermark === "true"
      : CHEAP_DEFAULTS.watermark;

    const input = {
      prompt,
      image: req.file.buffer,
      duration,
      resolution,
      watermark
    };
    if (model.needsFps24) input.fps = 24;

    const createBody = model.version
      ? { version: model.version, input }
      : { model: model.slug,  input };

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

// Result by id
app.get("/video/result/:id", async (req, res) => {
  try {
    const body = await buildResultResponse(req.params.id);
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// Result by status_url
app.get("/video/result", async (req, res) => {
  try {
    const q = req.query.status_url;
    if (!q) return res.status(400).json({ error: "status_url required" });
    const raw = decodeURIComponent(q.toString());
    const parts = raw.split("/").filter(Boolean);
    const id = parts[parts.length - 1];
    if (!id) return res.status(400).json({ error: "invalid status_url" });
    const body = await buildResultResponse(id);
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
