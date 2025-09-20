// server.js (Node 20+, ESM) — vidai-proxy
// Text->Video: google/veo-3 (gerekirse fallback: google/veo-3-fast)
// Image->Video: pixverse/pixverse-v5 (gerekirse fallback: pixverse/pixverse-v4.5)

import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// -------- ENV --------
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const TEXT_SLUG_PRIMARY   = process.env.TEXT_SLUG  || "google/veo-3";
const TEXT_SLUG_FALLBACK  = "google/veo-3-fast"; // çoğu hesapta açık :contentReference[oaicite:3]{index=3}
const IMAGE_SLUG_PRIMARY  = process.env.IMAGE_SLUG || "pixverse/pixverse-v5";
const IMAGE_SLUG_FALLBACK = "pixverse/pixverse-v4.5"; // yaygın açık sürüm :contentReference[oaicite:4]{index=4}

let TEXT_VERSION_ID  = process.env.TEXT_VERSION_ID  || null; // ENV öncelikli
let IMAGE_VERSION_ID = process.env.IMAGE_VERSION_ID || null;

// -------- Utils --------
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}
function extractUrl(output) {
  if (!output) return null;
  if (Array.isArray(output) && output.length) return output[output.length - 1];
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    for (const k of ["video", "url", "output", "mp4", "result"]) {
      if (typeof output[k] === "string") return output[k];
      if (Array.isArray(output[k]) && output[k].length && typeof output[k][0] === "string") return output[k][0];
    }
  }
  return null;
}
async function httpJson(method, url, bodyObj, headers = {}) {
  const r = await fetch(url, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`[UPSTREAM ${r.status}] ${method} ${url} :: ${text?.slice(0,400)}`);
    throw new Error(`upstream ${r.status}: ${text}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}
async function listVersions(slug) {
  const url = `https://api.replicate.com/v1/models/${slug}/versions`;
  console.log(`[VERSIONS] listing ${slug}`);
  return httpJson("GET", url, null, { Authorization: `Token ${REPLICATE_TOKEN}` });
}
async function resolveVersionIdWithFallback(primarySlug, fallbackSlug) {
  try {
    const j = await listVersions(primarySlug);
    if (j?.results?.length) return { id: j.results[0].id, slug: primarySlug };
    throw new Error(`no results for ${primarySlug}`);
  } catch (e) {
    console.warn(`[VERSIONS] primary failed for ${primarySlug}: ${String(e)}`);
    const j2 = await listVersions(fallbackSlug);
    if (j2?.results?.length) {
      console.log(`[VERSIONS] using fallback ${fallbackSlug}`);
      return { id: j2.results[0].id, slug: fallbackSlug };
    }
    throw new Error(`both primary & fallback failed for ${primarySlug} / ${fallbackSlug}`);
  }
}
async function ensureVersionIds() {
  if (!TEXT_VERSION_ID) {
    const { id, slug } = await resolveVersionIdWithFallback(TEXT_SLUG_PRIMARY, TEXT_SLUG_FALLBACK);
    TEXT_VERSION_ID = id;
    console.log(`[TEXT] using ${slug} -> ${TEXT_VERSION_ID}`);
  }
  if (!IMAGE_VERSION_ID) {
    const { id, slug } = await resolveVersionIdWithFallback(IMAGE_SLUG_PRIMARY, IMAGE_SLUG_FALLBACK);
    IMAGE_VERSION_ID = id;
    console.log(`[IMAGE] using ${slug} -> ${IMAGE_VERSION_ID}`);
  }
}
async function createPrediction(versionId, input) {
  const body = { version: versionId, input };
  return httpJson(
    "POST",
    "https://api.replicate.com/v1/predictions",
    body,
    {
      Authorization: `Token ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
    }
  );
}
async function getPrediction(predId) {
  return httpJson(
    "GET",
    `https://api.replicate.com/v1/predictions/${predId}`,
    null,
    { Authorization: `Token ${REPLICATE_TOKEN}` }
  );
}

// -------- In-memory jobs --------
const JOBS = new Map();

// -------- Health --------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    text_version_set: Boolean(TEXT_VERSION_ID),
    image_version_set: Boolean(IMAGE_VERSION_ID),
    text_slug_preferred: TEXT_SLUG_PRIMARY,
    image_slug_preferred: IMAGE_SLUG_PRIMARY
  });
});

// -------- Text → Video --------
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });

    await ensureVersionIds();
    const pred = await createPrediction(TEXT_VERSION_ID, { prompt });

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
    });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// -------- Image → Video --------
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    await ensureVersionIds();

    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    try {
      const pred = await createPrediction(IMAGE_VERSION_ID, { input_image: dataUrl, prompt });
      const requestId = randomUUID();
      JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });
      res.json({ status: "IN_QUEUE", request_id: requestId, status_url: `/video/result/${requestId}`, response_url: `/video/result/${requestId}` });
    } catch (e1) {
      try {
        const pred2 = await createPrediction(IMAGE_VERSION_ID, { image: dataUrl, prompt });
        const requestId = randomUUID();
        JOBS.set(requestId, { type: "image", pred_id: pred2.id, created: Date.now() });
        res.json({ status: "IN_QUEUE", request_id: requestId, status_url: `/video/result/${requestId}`, response_url: `/video/result/${requestId}` });
      } catch (e2) {
        throw new Error(String(e2) + " | Hint: This model may require a public URL. Upload and pass image_url.");
      }
    }
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// -------- Result --------
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await getPrediction(job.pred_id);
    const body = { status: mapStatus(pred.status), request_id: req.params.id };
    const url = extractUrl(pred.output);
    if (url) body.video_url = url;
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: String(e) });
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
