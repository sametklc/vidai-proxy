// index.js  (v10-response-url-deep-parse)
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Ingress log
app.use((req, _res, next) => {
  console.log("[INGRESS]", req.method, req.path, "ct=", req.headers["content-type"]);
  next();
});

const upload = multer();

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;

// Modeller (seninkiler)
const MODEL_IMAGE2VIDEO = process.env.FAL_MODEL_IMAGE2VIDEO || "fal-ai/veo2/image-to-video";
const MODEL_TEXT2VIDEO  = process.env.FAL_MODEL_TEXT2VIDEO  || "fal-ai/wan/v2.2-a14b/text-to-video/lora";

// Kuyruk önerilir
const USE_QUEUE = process.env.FAL_USE_QUEUE === "0" ? false : true;

const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

// --- helpers ---
function isWan(modelId) {
  return (modelId || "").startsWith("fal-ai/wan/");
}
function submitUrl(modelId) {
  return USE_QUEUE ? `${FAL_QUEUE}/${modelId}/requests` : `${FAL_DIRECT}/${modelId}`;
}
function baseModelId(modelId) {
  const p = (modelId || "").split("/");
  return p.length >= 2 ? `${p[0]}/${p[1]}` : modelId;
}
function toDataUrl(buf, mime = "application/octet-stream") {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/**
 * Fal çıktılarında video URL'i çok farklı alanlarda gelebiliyor.
 * Burayı acımasızca geniş tuttum.
 */
function pickVideoUrl(any) {
  // Bazı endpoint’ler "response" sargısı ile dönüyor, bazıları direkt.
  const r = any?.response ?? any;

  const candidates = [];

  // 1) Düz alanlar (string veya objede .url)
  candidates.push(r?.video_url);
  candidates.push(r?.video?.url);
  candidates.push(r?.video);                   // string olabiliyor
  candidates.push(r?.result?.url);
  candidates.push(r?.result?.video_url);
  candidates.push(r?.result?.video);
  candidates.push(r?.output?.[0]?.url);
  candidates.push(r?.outputs?.[0]?.url);
  candidates.push(r?.videos?.[0]?.url);
  candidates.push(r?.media?.[0]?.url);

  // 2) data altında
  candidates.push(r?.data?.video_url);
  candidates.push(r?.data?.video);
  candidates.push(r?.data?.result_url);
  candidates.push(r?.data?.output_url);
  candidates.push(r?.data?.url);

  // 3) kök seviyede (response sargısı yoksa)
  candidates.push(any?.video_url);
  candidates.push(any?.video?.url);
  candidates.push(any?.video);
  candidates.push(any?.result?.url);
  candidates.push(any?.result?.video_url);
  candidates.push(any?.output?.[0]?.url);
  candidates.push(any?.outputs?.[0]?.url);
  candidates.push(any?.videos?.[0]?.url);
  candidates.push(any?.media?.[0]?.url);
  candidates.push(any?.data?.video_url);
  candidates.push(any?.data?.video);
  candidates.push(any?.url);

  // İlk doğrulanabilir http(s) linki al
  const first = candidates.find(u => typeof u === "string" && /^https?:\/\//.test(u));
  return first || null;
}

/**
 * Bazı response gövdeleri "response_url", "result_url", "output_url" gibi
 * takip edilmesi gereken yeni URL’ler içerebilir. Onları çıkar.
 */
function pickFollowUpResponseUrls(body) {
  const r = body?.response ?? body;
  const urls = [];

  const tryPush = (u) => { if (typeof u === "string" && /^https?:\/\//.test(u)) urls.push(u); };

  tryPush(r?.response_url);
  tryPush(r?.result_url);
  tryPush(r?.output_url);
  tryPush(r?.url);

  tryPush(body?.response_url);
  tryPush(body?.result_url);
  tryPush(body?.output_url);
  tryPush(body?.url);

  // Tekil olmayan yerler
  (r?.links || []).forEach(tryPush);
  (body?.links || []).forEach(tryPush);

  return Array.from(new Set(urls));
}

async function safeJson(res) {
  const txt = await res.text().catch(() => "");
  try { return { ok: res.ok, status: res.status, body: JSON.parse(txt), raw: txt }; }
  catch { return { ok: res.ok, status: res.status, body: { response: txt }, raw: txt }; }
}

async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };
  const clone = JSON.parse(JSON.stringify(body));
  if (clone?.input?.image_url) clone.input.image_url = "[[base64]]";
  if (clone?.image_url) clone.image_url = "[[base64]]";
  console.log("[FAL SUBMIT]", { url, modelId, use_queue: USE_QUEUE, body: clone });

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const { ok, status, body: j, raw } = await safeJson(res);
  if (!ok) {
    console.error("[FAL SUBMIT ERR]", status, raw?.slice?.(0, 500));
    throw new Error(`Fal HTTP ${status} ${raw}`);
  }
  return j;
}

const VERSION = "v10-response-url-deep-parse";
app.get("/healthz", (_req, res) => res.json({
  ok: true, version: VERSION, use_queue: USE_QUEUE,
  i2v: MODEL_IMAGE2VIDEO, t2v: MODEL_TEXT2VIDEO
}));
app.get("/", (_req, res) => res.send(`OK ${VERSION}`));

// Test formları
app.get("/test-i2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Image → Video</h3>
    <form method="POST" action="/video/generate_image" enctype="multipart/form-data">
      <div>Prompt: <input name="prompt" value="cinematic zoom out" style="width:420px"/></div>
      <div>Image: <input type="file" name="image" accept="image/*"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});
app.get("/test-t2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Text → Video</h3>
    <form method="POST" action="/video/generate_text">
      <div>Prompt: <input name="prompt" value="a cat dancing on the street" style="width:420px"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});

// === 1) IMAGE -> VIDEO ===
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    console.log("[I2V IN] file?", !!req.file, req.file ? { size: req.file.size, mime: req.file.mimetype } : null);
    const prompt = (req.body.prompt || "").trim();
    console.log("[I2V IN] prompt len:", prompt.length);

    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });
    if (req.file.size > 3_900_000) return res.status(413).json({ error: "Image too large (<3.9MB)." });

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);
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
    const prompt = (req.body.prompt || "").trim();
    console.log("[T2V IN] prompt len:", prompt.length);
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // WAN genellikle top-level prompt bekliyor
    const payload = isWan(MODEL_TEXT2VIDEO) ? { prompt } : { input: { prompt } };

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

// === 3) RESULT — yalın zincir: STATUS_URL -> (COMPLETED?) -> RESPONSE_URL(+followups) ===
app.get("/video/result/:id?", async (req, res) => {
  try {
    const headers = { Authorization: `Key ${FAL_API_KEY}`, "Accept": "application/json" };
    const statusUrl = req.query.status_url;

    // 1) STATUS çek
    let statusResp;
    if (statusUrl) {
      console.log("[RESULT] status via status_url:", statusUrl);
      statusResp = await fetch(statusUrl, { headers });
    } else {
      // id + model base ile (eski fallback, ama resmi yol değil)
      const id   = req.params.id;
      const type = (req.query.type === "text") ? "text" : "image";
      const modelId = (type === "text") ? MODEL_TEXT2VIDEO : MODEL_IMAGE2VIDEO;
      const baseId  = baseModelId(modelId);
      const url     = `${FAL_QUEUE}/${baseId}/requests/${id}`;
      console.log("[RESULT] status via id (fallback):", { id, type, url });
      statusResp = await fetch(url, { headers });
    }

    const statusJson = await safeJson(statusResp);
    if (!statusJson.ok) {
      console.error("[RESULT ERR status]", statusJson.status, statusJson.raw?.slice?.(0, 500));
      return res.status(statusJson.status).send(statusJson.raw || "error");
    }

    const statusData = statusJson.body;
    const status     = statusData?.status || statusData?.response?.status || "";
    let video_url    = pickVideoUrl(statusData);

    const isDone = (s) => ["COMPLETED","SUCCEEDED","SUCCESS","DONE","FINISHED"].includes((s || "").toUpperCase());
    if (!isDone(status)) {
      return res.json({ status, video_url: null, raw: statusData });
    }
    if (video_url) {
      return res.json({ status, video_url, raw: statusData });
    }

    // 2) DONE ama URL yoksa -> response_url(ler) zincirini takip et
    const directRespUrl =
      statusData?.response_url ||
      statusData?.response?.response_url ||
      (statusUrl ? statusUrl.replace(/\/status$/, "") : null);

    const queue = [];
    if (directRespUrl) queue.push(directRespUrl);

    // statü dönen body’nin içinde olası ek takip linkleri
    pickFollowUpResponseUrls(statusData).forEach((u) => {
      if (!queue.includes(u)) queue.push(u);
    });

    // Zinciri takip et
    for (const url of queue) {
      console.log("[RESULT] fetch response_url:", url);
      const r = await fetch(url, { headers });
      const j = await safeJson(r);
      if (!j.ok) {
        console.warn("[RESULT] response_url failed:", j.status, j.raw?.slice?.(0, 400));
        continue;
      }
      const v = pickVideoUrl(j.body);
      if (v) {
        return res.json({ status: j.body?.status || status, video_url: v, raw: j.body });
      }

      // Bu response gövdesi de başka follow-up URL veriyorsa sıraya ekle
      pickFollowUpResponseUrls(j.body).forEach((u) => {
        if (!queue.includes(u)) queue.push(u);
      });

      // Hâlâ yoksa kısa özet logla
      try {
        const short = JSON.stringify(j.body).slice(0, 500);
        console.log("[RESULT] response has no video_url — body head:", short);
      } catch {}
    }

    // 3) Son çare — yine yoksa status ile dön
    console.warn("[RESULT] completed but no video url could be parsed.");
    return res.json({ status, video_url: null, raw: statusData });
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
