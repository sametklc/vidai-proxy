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
const MODEL_IMAGE2VIDEO = process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO  = process.env.FAL_MODEL_TEXT2VIDEO  || "fal-ai/wan/v2.2-a14b/text-to-video";
const USE_QUEUE  = process.env.FAL_USE_QUEUE === "0" ? false : true;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// ---- Fal endpoints ----
const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

// Queue modunda SUBMIT endpoint **/requests** ile biter:
function submitUrl(modelId) {
  if (USE_QUEUE) {
    // e.g. https://queue.fal.run/fal-ai/veo2/image-to-video/requests
    return `${FAL_QUEUE}/${modelId}/requests`;
  } else {
    // e.g. https://fal.run/fal-ai/veo2/image-to-video
    return `${FAL_DIRECT}/${modelId}`;
  }
}

// Queue’de status_url zaten Fal’dan döner. id polling için base model:
function baseModelId(modelId) {
  const p = (modelId || "").split("/");
  return p.length >= 2 ? `${p[0]}/${p[1]}` : modelId;
}

function toDataUrl(buf, mime = "application/octet-stream") {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };

  // Log: payload’ı sansürleyerek göster (image base64’i gizle)
  const logBody = JSON.parse(JSON.stringify(body));
  if (logBody?.input?.image_url && typeof logBody.input.image_url === "string") {
    logBody.input.image_url = "[[base64-data-url]]";
  }
  console.log("[FAL SUBMIT]", { url, use_queue: USE_QUEUE, modelId, body: logBody });

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[FAL SUBMIT ERR]", res.status, txt?.slice?.(0, 200));
    throw new Error(`Fal HTTP ${res.status} ${txt}`);
  }
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

// Health + version
const VERSION = "v3-queue-requests-path";
app.get("/healthz", (_, res) => res.json({
  ok: true,
  version: VERSION,
  use_queue: USE_QUEUE,
  i2v: MODEL_IMAGE2VIDEO,
  t2v: MODEL_TEXT2VIDEO
}));

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });

    // 3.9MB üstünü engelle (Fal 4MB limitine takılmamak için)
    if (req.file.size > 3_900_000) {
      return res.status(413).json({ error: "Image too large. Please use a smaller image (<3.9MB)." });
    }

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);

    // 🔑 Fal Queue protokolü: body.input altında
    const payload = { input: { prompt, image_url } };

    console.log("[I2V SUBMIT]", { promptLen: prompt.length });

    const data = await falPostJSONSubmit(MODEL_IMAGE2VIDEO, payload);

    if (USE_QUEUE) {
      console.log("[I2V QUEUED]", { request_id: data.request_id, status_url: data.status_url });
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url: data.status_url,
      });
    } else {
      const video_url = pickVideoUrl(data);
      console.log("[I2V SYNC DONE]", { video_url });
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[I2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 2) TEXT -> VIDEO ===
app.post("/video/generate_text", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // 🔑 Fal Queue protokolü: body.input altında
    const payload = { input: { prompt } };

    console.log("[T2V SUBMIT]", { promptLen: prompt.length });

    const data = await falPostJSONSubmit(MODEL_TEXT2VIDEO, payload);

    if (USE_QUEUE) {
      console.log("[T2V QUEUED]", { request_id: data.request_id, status_url: data.status_url });
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url: data.status_url,
      });
    } else {
      const video_url = pickVideoUrl(data);
      console.log("[T2V SYNC DONE]", { video_url });
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[T2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 3) RESULT (polling) ===
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
      const url     = `${FAL_QUEUE}/${baseId}/requests/${id}`;
      console.log("[RESULT] using id:", id, " type:", type, " url:", url);
      r = await fetch(url, { headers: { Authorization: `Key ${FAL_API_KEY}` } });
    }

    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      console.error("[RESULT ERR]", r.status, txt?.slice?.(0, 200));
      return res.status(r.status).send(txt || "error");
    }

    let data; try { data = JSON.parse(txt); } catch { data = { response: txt }; }
    const status = data?.status || data?.response?.status;
    const video_url = pickVideoUrl(data);
    return res.json({ status, video_url, raw: data });
  } catch (e) {
    console.error("[RESULT ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// webhook (opsiyonel)
app.post("/fal/webhook", express.raw({ type: "*/*" }), (req, res) => {
  try {
    console.log("FAL WEBHOOK:", req.body?.toString?.() || "");
    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("hook-failed");
  }
});

app.listen(PORT, () => {
  console.log("server on :", PORT, { version: VERSION, USE_QUEUE, MODEL_IMAGE2VIDEO, MODEL_TEXT2VIDEO, WEBHOOK_URL });
});
