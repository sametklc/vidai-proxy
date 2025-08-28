// index.js  (webhook-first, no path guessing)
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const upload = multer(); // memory storage

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;             // zorunlu
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;     // ör: https://sizin-app.onrender.com
const FAL_WEBHOOK_SECRET = process.env.FAL_WEBHOOK_SECRET || "change-me";

// MODEL seçimi (VEO kullanmak istemezsen WAN ile gidin)
const MODEL_TEXT2VIDEO = process.env.FAL_MODEL_TEXT2VIDEO || "fal-ai/wan/v2.2-a14b/text-to-video/lora";
// Alternatif bir image-to-video gerekiyorsa buraya başka model koyun (veya text2video ile başlayın)
const MODEL_IMAGE2VIDEO = process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";

// Sadece queue endpoint kullanıyoruz
const FAL_QUEUE = "https://queue.fal.run";
const submitUrl = (modelId) => `${FAL_QUEUE}/${modelId}/requests`;

// Basit hafıza deposu (production’da Redis önerilir)
const jobStore = new Map(); // request_id -> { status, video_url, raw, updatedAt }

// Yardımcılar
const toDataUrl = (buf, mime = "application/octet-stream") =>
  `data:${mime};base64,${buf.toString("base64")}`;

function pickVideoUrl(any) {
  // Fal payload’larından video linklerini toplayan geniş arayıcı
  const urls = new Set();
  const scan = (x) => {
    if (!x) return;
    if (typeof x === "string") {
      const m = x.match(/https?:\/\/[^\s"']+\.(mp4|webm|mov|m4v)/i);
      if (m) urls.add(m[0]);
      return;
    }
    if (Array.isArray(x)) { x.forEach(scan); return; }
    if (typeof x === "object") {
      // yaygın alanlar
      if (x.video_url && /^https?:\/\//.test(x.video_url)) urls.add(x.video_url);
      if (x.url && /^https?:\/\//.test(x.url)) urls.add(x.url);
      if (x.video?.url && /^https?:\/\//.test(x.video.url)) urls.add(x.video.url);
      if (x.assets) {
        ["video","mp4","url"].forEach(k => { const v = x.assets[k]; if (typeof v === "string" && /^https?:\/\//.test(v)) urls.add(v); });
      }
      ["output","outputs","data","media","videos","results","result"].forEach(k => scan(x[k]));
      // kök objeyi string olarak tara (son çare)
      scan(JSON.stringify(x).slice(0, 8000));
    }
  };
  scan(any);
  return Array.from(urls)[0] || null;
}

// Fal’e queue submit (webhook ile)
async function falQueueSubmit(modelId, payload) {
  const res = await fetch(submitUrl(modelId), {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Fal HTTP ${res.status} ${txt}`);
  return JSON.parse(txt);
}

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, mode: "webhook-first", t2v: MODEL_TEXT2VIDEO, i2v: MODEL_IMAGE2VIDEO }));

// ---- İŞ OLUŞTURMA (TEXT->VIDEO)  ----
app.post("/video/generate_text", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const webhook_url = `${PUBLIC_BASE_URL}/fal/webhook`;
    const payload = {
      webhook_url,
      webhook_secret: FAL_WEBHOOK_SECRET,
      input: { prompt }
    };

    const data = await falQueueSubmit(MODEL_TEXT2VIDEO, payload);
    // request_id ve status_url gelir; biz request_id’yi store’a yazarız
    jobStore.set(data.request_id, { status: "QUEUED", video_url: null, raw: null, updatedAt: Date.now() });

    res.json({
      request_id: data.request_id,
      status_url: data.status_url   // sadece debug için döndürüyoruz
    });
  } catch (e) {
    console.error("t2v submit err:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- İŞ OLUŞTURMA (IMAGE->VIDEO)  ----
// VEO’yu istemezseniz bu endpoint’i devre dışı bırakın ya da farklı bir i2v modeline çevirin.
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);
    const webhook_url = `${PUBLIC_BASE_URL}/fal/webhook`;
    const payload = {
      webhook_url,
      webhook_secret: FAL_WEBHOOK_SECRET,
      input: { prompt, image_url }
    };

    const data = await falQueueSubmit(MODEL_IMAGE2VIDEO, payload);
    jobStore.set(data.request_id, { status: "QUEUED", video_url: null, raw: null, updatedAt: Date.now() });

    res.json({
      request_id: data.request_id,
      status_url: data.status_url
    });
  } catch (e) {
    console.error("i2v submit err:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- FAL WEBHOOK (Fal buraya POST atar) ----
app.post("/fal/webhook", async (req, res) => {
  try {
    // Basit secret kontrolü (prod’da imza doğrulaması ekleyebilirsiniz)
    const secret = req.body?.webhook_secret || req.headers["x-fal-webhook-secret"];
    if (secret !== FAL_WEBHOOK_SECRET) return res.status(401).json({ error: "invalid webhook secret" });

    const request_id = req.body?.request_id || req.body?.id;
    const status = req.body?.status || req.body?.response?.status || "COMPLETED";
    const video_url = pickVideoUrl(req.body);

    // Kaydet
    jobStore.set(request_id, {
      status,
      video_url: video_url || null,
      raw: req.body,
      updatedAt: Date.now()
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("webhook err:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- SONUCU İSTEMCİYE VER ----
app.get("/video/result", (req, res) => {
  const id = String(req.query.request_id || "");
  if (!id) return res.status(400).json({ error: "request_id required" });

  const rec = jobStore.get(id);
  if (!rec) return res.json({ status: "PENDING", video_url: null });
  return res.json(rec);
});

app.listen(PORT, () => console.log("listening on", PORT));
