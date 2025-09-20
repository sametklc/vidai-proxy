// server.js — vidai-proxy (Node 20+)
// Özellikler:
// - Text→Video: google/veo-3 (slug'dan latest version ID'yi otomatik çeker)
// - Image→Video: pixverse/pixverse-v5 (slug'dan latest version ID'yi otomatik çeker)
// - İstersen doğrudan VERSION_ID'leri ENV'den verebilirsin (override eder)
// - input alanı farklarını tolere etmek için image flow'da input_image → image → image_url sırasıyla dener
// - Hataları "upstream <code>: <body>" formatında net döndürür
// - İsteğe bağlı webhook altyapısı hazır (BASE_PUBLIC_URL verilir ve alttaki yorumlar açılırsa)

import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

// ----------------- ENV -----------------
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) {
  console.error("FATAL: REPLICATE_API_TOKEN is missing");
}

// Slug’lar (senin istediğin modeller)
const TEXT_SLUG_DEFAULT  = "google/veo-3";         // Text→Video
const IMAGE_SLUG_DEFAULT = "pixverse/pixverse-v5"; // Image→Video

const TEXT_SLUG  = process.env.TEXT_SLUG  || TEXT_SLUG_DEFAULT;
const IMAGE_SLUG = process.env.IMAGE_SLUG || IMAGE_SLUG_DEFAULT;

// Dilersen Version ID'yi doğrudan ENV'den verebilirsin (slug çözümünü bypass eder)
let TEXT_VERSION_ID  = process.env.TEXT_VERSION_ID  || null;
let IMAGE_VERSION_ID = process.env.IMAGE_VERSION_ID || null;

// Webhook kullanmak istersen Render env'de BASE_PUBLIC_URL ayarla ve aşağıdaki alanı body'ye ekle
const BASE_PUBLIC_URL = process.env.BASE_PUBLIC_URL || null;

// ----------------- Yardımcılar -----------------
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
  if (!r.ok) throw new Error(`upstream ${r.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function listVersions(slug) {
  return httpJson(
    "GET",
    `https://api.replicate.com/v1/models/${slug}/versions`,
    null,
    { Authorization: `Token ${REPLICATE_TOKEN}` }
  );
}

async function ensureVersionIds() {
  // TEXT
  if (!TEXT_VERSION_ID) {
    const j = await listVersions(TEXT_SLUG);
    if (!j?.results?.length) throw new Error(`No versions for slug ${TEXT_SLUG}`);
    TEXT_VERSION_ID = j.results[0].id; // latest
  }
  // IMAGE
  if (!IMAGE_VERSION_ID) {
    const j = await listVersions(IMAGE_SLUG);
    if (!j?.results?.length) throw new Error(`No versions for slug ${IMAGE_SLUG}`);
    IMAGE_VERSION_ID = j.results[0].id; // latest
  }
}

// Replicate POST /predictions
async function createPrediction(versionId, input) {
  const body = {
    version: versionId,
    input,
    // webhook: BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}/webhook/replicate` : undefined, // istersen aç
  };
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

// Replicate GET /predictions/{id}
async function getPrediction(predId) {
  return httpJson(
    "GET",
    `https://api.replicate.com/v1/predictions/${predId}`,
    null,
    { Authorization: `Token ${REPLICATE_TOKEN}` }
  );
}

// Basit in-memory job store (üretimde Redis önerilir)
const JOBS = new Map();

// ----------------- Health -----------------
app.get("/", (req, res) => res.json({ ok: true, text_model: TEXT_SLUG, image_model: IMAGE_SLUG }));

// ----------------- Text → Video -----------------
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });

    await ensureVersionIds();

    // Çoğu text→video modelinde "prompt" anahtarı yeterli; gerekiyorsa burada ek parametreler verilebilir.
    const pred = await createPrediction(TEXT_VERSION_ID, { prompt });

    const requestId = randomUUID();
    JOBS.set(requestId, { type: "text", pred_id: pred.id, created: Date.now() });

    return res.json({
      status: "IN_QUEUE",
      request_id: requestId,
      status_url: `/video/result/${requestId}`,
      response_url: `/video/result/${requestId}`,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ----------------- Image → Video -----------------
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });
    const prompt = (req.body?.prompt || "").toString();

    await ensureVersionIds();

    // Data URL dene; bazı modeller yalnız URL kabul eder (o durumda hata verir → aşağıda mesaj var)
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");

    // 1. deneme: input_image
    try {
      const pred = await createPrediction(IMAGE_VERSION_ID, { input_image: dataUrl, prompt });
      const requestId = randomUUID();
      JOBS.set(requestId, { type: "image", pred_id: pred.id, created: Date.now() });
      return res.json({
        status: "IN_QUEUE",
        request_id: requestId,
        status_url: `/video/result/${requestId}`,
        response_url: `/video/result/${requestId}`,
      });
    } catch (e1) {
      // 2. deneme: image
      try {
        const pred2 = await createPrediction(IMAGE_VERSION_ID, { image: dataUrl, prompt });
        const requestId = randomUUID();
        JOBS.set(requestId, { type: "image", pred_id: pred2.id, created: Date.now() });
        return res.json({
          status: "IN_QUEUE",
          request_id: requestId,
          status_url: `/video/result/${requestId}`,
          response_url: `/video/result/${requestId}`,
        });
      } catch (e2) {
        // 3. deneme: image_url (public URL gerekiyorsa burada kullan)
        // Buraya otomatik upload ekleyebilirsin (S3/R2). Şimdilik sadece kullanıcıya ipucu veriyoruz.
        throw new Error(String(e2) + " | Hint: This model may require a public URL. Upload the file and pass image_url.");
      }
    }
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ----------------- Result (ID ile) -----------------
app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown request id" });

    const pred = await getPrediction(job.pred_id);
    const body = { status: mapStatus(pred.status), request_id: req.params.id };
    const url = extractUrl(pred.output);
    if (url) body.video_url = url;
    return res.json(body);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
});

// ----------------- Result (status_url ile) -----------------
app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({ error: "status_url required" });
  const id = statusUrl.toString().split("/").pop();
  req.params.id = id;
  return app._router.handle(req, res, () => {});
});

// ----------------- Webhook (opsiyonel) -----------------
// app.post("/webhook/replicate", express.json({ limit: "2mb" }), (req, res) => {
//   const payload = req.body || {};
//   const predId = payload.id;
//   for (const [rid, job] of JOBS.entries()) {
//     if (job.pred_id === predId) {
//       job.last_payload = payload;
//       job.webhook_status = payload.status;
//       break;
//     }
//   }
//   res.json({ ok: true });
// });

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
