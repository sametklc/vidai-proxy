// index.js
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer(); // memoryStorage

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;

// Modeller (ENV’de varsa onu kullanır; yoksa bu fallback'ler kullanılır)
const MODEL_IMAGE2VIDEO =
  process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO =
  process.env.FAL_MODEL_TEXT2VIDEO || "fal-ai/wan/v2.2-a14b/text-to-video";

// Kuyruk mu sync mi
const USE_QUEUE = process.env.FAL_USE_QUEUE === "0" ? false : true;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const FAL_BASE = USE_QUEUE ? "https://queue.fal.run" : "https://fal.run";

// ---- Helpers ----
function falUrl(modelId) {
  if (USE_QUEUE && WEBHOOK_URL) {
    const u = new URL(`${FAL_BASE}/${modelId}`);
    u.searchParams.set("fal_webhook", `${WEBHOOK_URL}/fal/webhook`);
    return u.toString();
  }
  return `${FAL_BASE}/${modelId}`;
}

// "fal-ai/veo2/image-to-video" -> "fal-ai/veo2"
function baseModelId(modelId) {
  const parts = (modelId || "").split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : modelId;
}

function toDataUrl(buffer, mime = "application/octet-stream") {
  const b64 = buffer.toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function falPostJSON(modelId, body) {
  const res = await fetch(falUrl(modelId), {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`Fal HTTP ${res.status} ${errTxt}`);
  }
  return res.json();
}

// response normalizasyonu
function pickVideoUrl(any) {
  const r = any?.response || any;
  const candidates = [
    r?.video_url,
    r?.video?.url,
    r?.videos?.[0]?.url,
    r?.output?.[0]?.url,
    r?.data?.video_url,
    r?.media?.[0]?.url,
  ].filter(Boolean);
  return candidates[0] || null;
}

// Health
app.get("/healthz", (_, res) => res.json({ ok: true, model_i2v: MODEL_IMAGE2VIDEO, model_t2v: MODEL_TEXT2VIDEO }));

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = req.body.prompt || "";
    if (!req.file) {
      return res.status(400).json({ error: "image file required" });
    }
    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);

    // Fal (veo2) beklenen format
    const payload = { input: { prompt, image_url } };

    const data = await falPostJSON(MODEL_IMAGE2VIDEO, payload);

    if (USE_QUEUE) {
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url: data.status_url,
      });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 2) TEXT -> VIDEO ===
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // Fal (wan) beklenen format
    const payload = { input: { prompt } };

    const data = await falPostJSON(MODEL_TEXT2VIDEO, payload);

    if (USE_QUEUE) {
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url: data.status_url,
      });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 3) Queue Sonucu (Android polling) ===
// /video/result/:id?type=image|text  --> type yoksa image kabul eder
app.get("/video/result/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const type = (req.query.type === "text") ? "text" : "image";

    const modelId = (type === "text") ? MODEL_TEXT2VIDEO : MODEL_IMAGE2VIDEO;
    const baseId  = baseModelId(modelId); // SUBPATH YOK!

    const url = `https://queue.fal.run/${baseId}/requests/${id}`;
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Key ${FAL_API_KEY}` },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Fal Result HTTP ${r.status} ${txt}`.trim());
    }

    const data = await r.json();
    const video_url = pickVideoUrl(data);

    res.json({
      status: data.status,
      video_url,
      request_id: id,
      raw: data
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 4) Fal Webhook (opsiyonel) ===
app.post("/fal/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const raw = req.body?.toString?.() || "";
    console.log("FAL WEBHOOK:", raw);
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("hook-failed");
  }
});

app.listen(PORT, () => {
  console.log("server on :" + PORT, {
    USE_QUEUE,
    MODEL_IMAGE2VIDEO,
    MODEL_TEXT2VIDEO,
    WEBHOOK_URL,
  });
});
