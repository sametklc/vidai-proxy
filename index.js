// index.js  (v7-robust-result+model-diff)
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" })); // form için

// Her isteği logla (debug için süper yararlı)
app.use((req, _res, next) => {
  console.log("[INGRESS]", req.method, req.path, "ct=", req.headers["content-type"]);
  next();
});

const upload = multer(); // memoryStorage

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;

// Modeller (senin kullandıkların)
const MODEL_IMAGE2VIDEO = process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO  = process.env.FAL_MODEL_TEXT2VIDEO  || "fal-ai/wan/v2.2-a14b/text-to-video/lora";

// Kuyruk önerilir
const USE_QUEUE  = process.env.FAL_USE_QUEUE === "0" ? false : true;

// Fal endpoints
const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

// ---- Helpers ----
function isWan(modelId) {
  // WAN ailesi prompt'u top-level ister (Fal docs & önceki 422 deneyimine göre)
  return (modelId || "").startsWith("fal-ai/wan/");
}
function submitUrl(modelId) {
  // Queue ise /requests'a POST
  return USE_QUEUE ? `${FAL_QUEUE}/${modelId}/requests` : `${FAL_DIRECT}/${modelId}`;
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

// En yaygın alanları tarayıp video URL bulur
function pickVideoUrl(any) {
  const r = any?.response || any;
  const cands = [
    r?.video_url,
    r?.video?.url,
    r?.videos?.[0]?.url,
    r?.output?.[0]?.url,
    r?.data?.video_url,
    r?.media?.[0]?.url,
    r?.result?.video_url,
    r?.result?.url
  ].filter(Boolean);
  return cands[0] || null;
}

async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };

  // Sansürlü log
  const clone = JSON.parse(JSON.stringify(body));
  if (clone?.input?.image_url) clone.input.image_url = "[[base64-data-url]]";
  if (clone?.image_url) clone.image_url = "[[base64-data-url]]";
  console.log("[FAL SUBMIT]", { url, modelId, use_queue: USE_QUEUE, body: clone });

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[FAL SUBMIT ERR]", res.status, txt?.slice?.(0, 400));
    throw new Error(`Fal HTTP ${res.status} ${txt}`);
  }
  try { return JSON.parse(txt); } catch { return { response: txt }; }
}

// Health + version
const VERSION = "v7-robust-result+model-diff";
app.get("/healthz", (_req, res) => res.json({
  ok: true, version: VERSION, use_queue: USE_QUEUE,
  i2v: MODEL_IMAGE2VIDEO, t2v: MODEL_TEXT2VIDEO
}));
app.get("/", (_req, res) => res.send(`OK ${VERSION}`));

// --- Basit test formları ---
app.get("/test-i2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Image → Video (queue)</h3>
    <form method="POST" action="/video/generate_image" enctype="multipart/form-data">
      <div>Prompt: <input name="prompt" style="width:420px" value="cinematic zoom out of a mountain lake"/></div>
      <div>Image: <input type="file" name="image" accept="image/*"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});
app.get("/test-t2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Text → Video (queue)</h3>
    <form method="POST" action="/video/generate_text">
      <div>Prompt: <input name="prompt" style="width:420px" value="a cat dancing on the street, cinematic"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    console.log("[I2V IN] ct=", req.headers["content-type"], "keys:", Object.keys(req.body || {}));
    console.log("[I2V IN] file?", !!req.file, req.file ? { size: req.file.size, mime: req.file.mimetype } : null);

    const prompt = (req.body.prompt || "").trim();
    console.log("[I2V IN] prompt len:", prompt.length);

    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });
    if (req.file.size > 3_900_000) return res.status(413).json({ error: "Image too large (<3.9MB)." });

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);

    // Veo2 (queue) -> input:{ prompt, image_url }
    const payload = { input: { prompt, image_url } };

    const data = await falPostJSONSubmit(MODEL_IMAGE2VIDEO, payload);

    if (USE_QUEUE) {
      console.log("[I2V QUEUED]", { request_id: data.request_id, status_url: data.status_url, response_url: data.response_url });
      return res.json({ request_id: data.request_id, response_url: data.response_url, status_url: data.status_url });
    } else {
      const video_url = pickVideoUrl(data);
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
    console.log("[T2V IN] ct=", req.headers["content-type"], "keys:", Object.keys(req.body || {}));
    const prompt = (req.body.prompt || "").trim();
    console.log("[T2V IN] prompt len:", prompt.length);
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    let payload;
    if (isWan(MODEL_TEXT2VIDEO)) {
      // WAN → top-level prompt
      payload = { prompt };
    } else {
      // (örn: veo2 text-to-video kullanılsaydı) input:{ prompt }
      payload = { input: { prompt } };
    }

    const data = await falPostJSONSubmit(MODEL_TEXT2VIDEO, payload);

    if (USE_QUEUE) {
      console.log("[T2V QUEUED]", { request_id: data.request_id, status_url: data.status_url, response_url: data.response_url });
      return res.json({ request_id: data.request_id, response_url: data.response_url, status_url: data.status_url });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[T2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 3) RESULT (polling): her zaman response_url'i de çek ===
app.get("/video/result/:id?", async (req, res) => {
  try {
    const headers = { Authorization: `Key ${FAL_API_KEY}` };
    const qStatusUrl = req.query.status_url;

    // 1) STATUS
    let statusResp;
    if (qStatusUrl) {
      console.log("[RESULT] status via status_url");
      statusResp = await fetch(qStatusUrl, { headers });
    } else {
      // id + type yolu (status_url yoksa)
      const id   = req.params.id;
      const type = (req.query.type === "text") ? "text" : "image";
      const modelId = (type === "text") ? MODEL_TEXT2VIDEO : MODEL_IMAGE2VIDEO;
      const baseId  = baseModelId(modelId);
      const url     = `${FAL_QUEUE}/${baseId}/requests/${id}`;
      console.log("[RESULT] status via id:", { id, type, url });
      statusResp = await fetch(url, { headers });
    }

    const statusTxt = await statusResp.text().catch(() => "");
    if (!statusResp.ok) {
      console.error("[RESULT ERR status]", statusResp.status, statusTxt?.slice?.(0, 400));
      return res.status(statusResp.status).send(statusTxt || "error");
    }

    let statusData; try { statusData = JSON.parse(statusTxt); } catch { statusData = { response: statusTxt }; }
    const status = statusData?.status || statusData?.response?.status || "";
    let video_url = pickVideoUrl(statusData);

    const isDone = (s) => ["COMPLETED","SUCCEEDED","SUCCESS","DONE"].includes((s || "").toUpperCase());

    // 2) DONE & hâlâ URL yoksa → response_url'i çek
    if (isDone(status) && !video_url) {
      const respUrl =
        statusData?.response_url ||
        statusData?.response?.response_url ||
        (qStatusUrl ? qStatusUrl.replace(/\/status$/, "") : null);

      if (respUrl) {
        console.log("[RESULT] fetching response_url:", respUrl);
        const r2 = await fetch(respUrl, { headers });
        const txt2 = await r2.text().catch(() => "");
        if (!r2.ok) {
          console.error("[RESULT ERR resp]", r2.status, txt2?.slice?.(0, 400));
          return res.status(r2.status).send(txt2 || "error");
        }
        let respData; try { respData = JSON.parse(txt2); } catch { respData = { response: txt2 }; }
        video_url = pickVideoUrl(respData);
        const finalStatus = respData?.status || status;
        console.log("[RESULT] done; url?", !!video_url, "status:", finalStatus);
        return res.json({ status: finalStatus, video_url, raw: respData });
      } else {
        console.log("[RESULT] no response_url present.");
      }
    }

    // 3) Status verisini döndür
    console.log("[RESULT] status only; url?", !!video_url, "status:", status);
    return res.json({ status, video_url, raw: statusData });
  } catch (e) {
    console.error("[RESULT ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("server on :", PORT, {
    version: VERSION,
    USE_QUEUE,
    MODEL_IMAGE2VIDEO,
    MODEL_TEXT2VIDEO
  });
});
