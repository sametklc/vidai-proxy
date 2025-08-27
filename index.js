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

// Modeller (ENV varsa onu kullanır)
const MODEL_IMAGE2VIDEO =
  process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO =
  process.env.FAL_MODEL_TEXT2VIDEO || "fal-ai/wan/v2.2-a14b/text-to-video";

// Kuyruk önerilir (1). 0 verirsen sync dener.
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
  const p = (modelId || "").split("/");
  return p.length >= 2 ? `${p[0]}/${p[1]}` : modelId;
}

function toDataUrl(buf, mime = "application/octet-stream") {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function falPostJSON(modelId, body) {
  const res = await fetch(falUrl(modelId), {
    method: "POST",
    headers: { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Fal HTTP ${res.status} ${txt}`);
  try { return JSON.parse(txt); } catch { return { response: txt }; }
}

function pickVideoUrl(any) {
  const r = any?.response || any;
  const cands = [
    r?.video_url, r?.video?.url, r?.videos?.[0]?.url, r?.output?.[0]?.url,
    r?.data?.video_url, r?.media?.[0]?.url,
  ].filter(Boolean);
  return cands[0] || null;
}

// Health
app.get("/healthz", (_, res) => res.json({ ok: true, i2v: MODEL_IMAGE2VIDEO, t2v: MODEL_TEXT2VIDEO }));

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = req.body.prompt || "";
    if (!req.file) return res.status(400).json({ error: "image file required" });

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);
    const payload = { input: { prompt, image_url } };

    console.log("[I2V] payload.input keys:", Object.keys(payload.input));
    const data = await falPostJSON(MODEL_IMAGE2VIDEO, payload);
    console.log("[I2V] fal response keys:", Object.keys(data || {}));

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
    console.error("[I2V] ERROR:", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 2) TEXT -> VIDEO ===
app.post("/video/generate_text", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const payload = { input: { prompt } };

    console.log("[T2V] payload.input keys:", Object.keys(payload.input));
    const data = await falPostJSON(MODEL_TEXT2VIDEO, payload);
    console.log("[T2V] fal response keys:", Object.keys(data || {}));

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
    console.error("[T2V] ERROR:", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 3) RESULT (polling) ===
// Tercih: /video/result?status_url=<FAL_STATUS_URL>
// Alternatif: /video/result/:id?type=image|text
app.get("/video/result/:id?", async (req, res) => {
  try {
    const statusUrl = req.query.status_url;
    let r;

    if (statusUrl) {
      console.log("[RESULT] using status_url:", statusUrl);
      r = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL_API_KEY}` } });
    } else {
      const id   = req.params.id;
      const type = (req.query.type === "text") ? "text" : "image";
      const modelId = (type === "text") ? MODEL_TEXT2VIDEO : MODEL_IMAGE2VIDEO;
      const baseId  = baseModelId(modelId);
      const url     = `https://queue.fal.run/${baseId}/requests/${id}`;
      console.log("[RESULT] using id:", id, " type:", type, " url:", url);
      r = await fetch(url, { headers: { Authorization: `Key ${FAL_API_KEY}` } });
    }

    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      console.error("[RESULT] Fal error:", r.status, txt?.slice?.(0, 200));
      return res.status(r.status).send(txt || "error");
    }

    let data; try { data = JSON.parse(txt); } catch { data = { response: txt }; }
    const status = data?.status || data?.response?.status;
    const video_url = pickVideoUrl(data);
    return res.json({ status, video_url, raw: data });
  } catch (e) {
    console.error("[RESULT] ERROR:", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// (opsiyonel) webhook
app.post("/fal/webhook", express.raw({ type: "*/*" }), (req, res) => {
  try {
    console.log("FAL WEBHOOK:", req.body?.toString?.() || "");
    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("hook-failed");
  }
});

app.listen(PORT, () => {
  console.log("server on :" + PORT, { USE_QUEUE, MODEL_IMAGE2VIDEO, MODEL_TEXT2VIDEO, WEBHOOK_URL });
});
