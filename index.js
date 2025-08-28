// index.js  (v7-status-first)
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

// Her request’i ingress olarak logla (debug için çok yararlı)
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

// Kuyruk önerilir (queue=true varsayılan)
const USE_QUEUE  = process.env.FAL_USE_QUEUE === "0" ? false : true;

// Fal endpoints
const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

// Submit URL (queue ise /requests ile biter)
function submitUrl(modelId) {
  return USE_QUEUE ? `${FAL_QUEUE}/${modelId}/requests` : `${FAL_DIRECT}/${modelId}`;
}

function toDataUrl(buf, mime = "application/octet-stream") {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

// Tek bir yerde tüm olası şemaları tarıyoruz.
// Hem kök hem de response altını dene; çok farklı model çıktılarıyla uyumlu.
function pickVideoUrl(any) {
  // Fal Queue status cevabı sıklıkla { status, response, response_url } döndürür.
  // Biz hem kökü hem response’ı düzleştirip bakacağız.
  const layers = [];
  if (any) layers.push(any);
  if (any?.response) layers.push(any.response);

  // Bazı modeller array döndürüyor (outputs, output), hepsini flatten et
  const flattened = [];
  for (const layer of layers) {
    if (!layer) continue;
    flattened.push(layer);
    if (Array.isArray(layer)) {
      flattened.push(...layer);
    }
    if (Array.isArray(layer?.output)) {
      flattened.push(...layer.output);
    }
    if (Array.isArray(layer?.outputs)) {
      flattened.push(...layer.outputs);
    }
    if (Array.isArray(layer?.data)) {
      flattened.push(...layer.data);
    }
  }

  const candidates = [];

  const pushIf = (v) => { if (typeof v === "string" && /^https?:\/\//.test(v)) candidates.push(v); };

  // Katmanları sırayla tara
  const scanObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    // Yaygın patternler
    pushIf(obj.video_url);
    pushIf(obj.url); // bazen tek başına url geliyor
    if (obj.video && typeof obj.video === "object") {
      pushIf(obj.video.url);
    }
    if (Array.isArray(obj.videos)) {
      obj.videos.forEach(v => { if (v) pushIf(v.url || v.video_url); });
    }
    if (obj.assets && typeof obj.assets === "object") {
      pushIf(obj.assets.video);
      pushIf(obj.assets.mp4);
      pushIf(obj.assets.url);
    }
    if (obj.media && Array.isArray(obj.media)) {
      obj.media.forEach(m => { if (m) pushIf(m.url || m.video_url); });
    }
    if (Array.isArray(obj.output)) {
      obj.output.forEach(o => scanObj(o));
    }
    if (Array.isArray(obj.outputs)) {
      obj.outputs.forEach(o => scanObj(o));
    }
    if (Array.isArray(obj.data)) {
      obj.data.forEach(o => scanObj(o));
    }
    // Bazı durumlarda {result:{video_url}} gibi iç içe
    if (obj.result) scanObj(obj.result);
    if (obj.results) scanObj(obj.results);
  };

  flattened.forEach(scanObj);

  // Son çare: kök ve response’ı string alanlarda kaba bir tarama
  const asText = JSON.stringify(any || {}).slice(0, 4000);
  const urlRegex = /(https?:\/\/[^\s"']+\.(?:mp4|webm|mov|m4v))(?![^<]*>)/ig;
  let m;
  while ((m = urlRegex.exec(asText)) !== null) {
    pushIf(m[1]);
  }

  return candidates[0] || null;
}

async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };

  // Sansürlü log
  const clone = JSON.parse(JSON.stringify(body));
  if (clone?.input?.image_url) clone.input.image_url = "[[base64-data-url]]";
  console.log("[FAL SUBMIT]", { url, modelId, use_queue: USE_QUEUE, body: clone });

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[FAL SUBMIT ERR]", res.status, txt?.slice?.(0, 200));
    throw new Error(`Fal HTTP ${res.status} ${txt}`);
  }
  try { return JSON.parse(txt); } catch { return { response: txt }; }
}

// Health + version
const VERSION = "v7-status-first";
app.get("/healthz", (_req, res) => res.json({
  ok: true, version: VERSION, use_queue: USE_QUEUE,
  i2v: MODEL_IMAGE2VIDEO, t2v: MODEL_TEXT2VIDEO
}));

app.get("/", (_req, res) => res.send(`OK ${VERSION}`));

// --- Test formları (manuel doğrulama için) ---
app.get("/test-i2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Image → Video (Fal queue)</h3>
    <form method="POST" action="/video/generate_image" enctype="multipart/form-data">
      <div>Prompt: <input name="prompt" style="width:400px" value="cinematic zoom out"/></div>
      <div>Image: <input type="file" name="image" accept="image/*"/></div>
      <button type="submit">Submit</button>
    </form>
    <p>Sonuç JSON döner; request_id / status_url görünmeli.</p>
  `);
});

app.get("/test-t2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Text → Video (Fal queue)</h3>
    <form method="POST" action="/video/generate_text">
      <div>Prompt: <input name="prompt" style="width:400px" value="a cat dancing on the street, cinematic"/></div>
      <button type="submit">Submit</button>
    </form>
    <p>Sonuç JSON döner; request_id / status_url görünmeli.</p>
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
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,    // Fal sağlıyorsa döndürüyoruz (ileride lazım olabilir)
        status_url:   data.status_url
      });
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

    const payload = { input: { prompt } };

    const data = await falPostJSONSubmit(MODEL_TEXT2VIDEO, payload);

    if (USE_QUEUE) {
      return res.json({
        request_id: data.request_id,
        response_url: data.response_url,
        status_url:   data.status_url
      });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[T2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === 3) RESULT (polling) — yalın, sadece verilen status_url ve response_url ===
app.get("/video/result/:id?", async (req, res) => {
  try {
    const statusUrl = req.query.status_url;
    if (!statusUrl) {
      return res.status(400).json({ error: "status_url required" });
    }

    const headers = { Authorization: `Key ${FAL_API_KEY}` };

    // 1) STATUS çek
    console.log("[RESULT] status via status_url:", statusUrl);
    const statusResp = await fetch(statusUrl, { headers });
    const statusTxt  = await statusResp.text().catch(() => "");
    if (!statusResp.ok) {
      console.error("[RESULT] status failed:", statusResp.status, statusTxt?.slice?.(0, 200));
      return res.status(statusResp.status).send(statusTxt || "error");
    }

    let statusData; try { statusData = JSON.parse(statusTxt); } catch { statusData = { response: statusTxt }; }
    const status = statusData?.status || statusData?.response?.status || "";
    let video_url = pickVideoUrl(statusData);

    const done = (s) => ["COMPLETED","SUCCEEDED","SUCCESS","succeeded","completed"].includes(String(s || "").toUpperCase());
    const inprog = (s) => ["IN_PROGRESS","IN_QUEUE","PENDING","RUNNING","QUEUED"].includes(String(s || "").toUpperCase());

    if (done(status)) {
      if (!video_url) {
        // Önce status body içinden çıkarmayı denedik; bulunamadı → sadece response_url’i dene
        const respUrl =
          statusData?.response_url ||
          statusData?.response?.response_url ||
          (typeof statusUrl === "string" ? statusUrl.replace(/\/status$/, "") : null);

        if (respUrl) {
          console.log("[RESULT] fetch response_url:", respUrl);
          const r2 = await fetch(respUrl, { headers, method: "GET" });
          const txt2 = await r2.text().catch(() => "");
          if (!r2.ok) {
            console.error("[RESULT] response_url failed:", r2.status, txt2?.slice?.(0, 200));
            // Yine de statusData’yı dönderelim; client “still processing” demesin
            return res.json({ status, video_url: null, raw: { statusData_head: statusTxt.slice(0, 1200) } });
          }
          let respData; try { respData = JSON.parse(txt2); } catch { respData = { response: txt2 }; }
          const resolvedUrl = pickVideoUrl(respData);
          if (resolvedUrl) {
            return res.json({ status, video_url: resolvedUrl, raw: respData });
          } else {
            // Debug için gövdenin başını logla
            const short = txt2.slice(0, 1200);
            console.log("[RESULT] response has no video_url — body head:", short);
            return res.json({ status, video_url: null, raw: { response_head: short } });
          }
        } else {
          // response_url yoksa eldeki status gövdesini raporla
          const short = statusTxt.slice(0, 1200);
          console.log("[RESULT] completed but no video url could be parsed. body head:", short);
          return res.json({ status, video_url: null, raw: { status_head: short } });
        }
      } else {
        // URL status body’den bulundu
        return res.json({ status, video_url, raw: statusData });
      }
    } else if (inprog(status) || !status) {
      // Hâlâ sürüyor
      return res.json({ status: status || "IN_PROGRESS", video_url: null, raw: statusData });
    } else {
      // FAILED vb.
      const short = statusTxt.slice(0, 1200);
      console.log("[RESULT] job not successful. status:", status, " body head:", short);
      return res.json({ status, video_url: null, raw: { status_head: short } });
    }
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
