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

// Modeller
const MODEL_IMAGE2VIDEO =
  process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO =
  process.env.FAL_MODEL_TEXT2VIDEO || "fal-ai/wan/v2.2-a14b/text-to-video";

// Kuyruk önerilir
const USE_QUEUE = process.env.FAL_USE_QUEUE === "0" ? false : true;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const FAL_BASE = USE_QUEUE ? "https://queue.fal.run" : "https://fal.run";

// ---- Helpers ----
function falUrl(modelId) {
  const u = new URL(`${FAL_BASE}/${modelId}`);
  if (USE_QUEUE && WEBHOOK_URL) {
    // Fal webhook’larını kullanmak istersen
    u.searchParams.set("fal_webhook", `${WEBHOOK_URL}/fal/webhook`);
  }
  return u.toString();
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
app.get("/healthz", (_, res) => res.json({ ok: true, use_queue: USE_QUEUE, i2v: MODEL_IMAGE2VIDEO, t2v: MODEL_TEXT2VIDEO }));

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });

    // 3.9MB üstünü engelle (base64 şişmesi nedeniyle Fal 4MB sınırına takmamak için)
    if (req.file.size > 3_900_000) {
      return res.status(413).json({ error: "Image too large. Please use a smaller image (<3.9MB)." });
    }

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);

    // 🔑 Fal queue protokolü: body.input altında
    const payload = {
      input: {
        prompt,
        image_url,
        // opsiyonel: aspect_ratio: "auto", duration: "5s" ...
      }
    };

    console.log("[I2V] use_queue=", USE_QUEUE, " promptLen=", prompt.length);

    const data = await falPostJSON(MODEL_IMAGE2VIDEO, payload);

    if (USE_QUEUE) {
      // queue submit: request_id/status_url döner
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url: data.status_url,
      });
    } else {
      // (Nadiren) sync/subscribe kullanıyorsan
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
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // 🔑 Fal queue protokolü: body.input altında
    const payload = {
      input: {
        prompt,
        // opsiyonel: duration, fps, size ...
      }
    };

    console.log("[T2V] use_queue=", USE_QUEUE, " promptLen=", prompt.length);

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
    console.error("[T2V] ERROR:", e.message);
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
