// server.js — Multi-model proxy (vidai/veo3/wan/sora2/kling/cogx/animatediff)

import express from "express";
import multer from "multer";
import Replicate from "replicate";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) console.error("FATAL: REPLICATE_API_TOKEN missing");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY missing - content moderation is REQUIRED");
  // Don't allow server to start without moderation
  process.exit(1);
}

const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");

// Model ENV (slug + optional version)
const MODEL_VIDAI_SLUG   = process.env.MODEL_VIDAI_SLUG   || "bytedance/seedance-1-lite";
const MODEL_VIDAI_VER    = process.env.MODEL_VIDAI_VER    || null;

const MODEL_VEO3_SLUG    = process.env.MODEL_VEO3_SLUG    || "google/veo-3-fast";
const MODEL_VEO3_VER     = process.env.MODEL_VEO3_VER     || null;

const MODEL_WAN_SLUG     = process.env.MODEL_WAN_SLUG     || "wan-video/wan-2.2-i2v-fast";
const MODEL_WAN_VER      = process.env.MODEL_WAN_VER      || null;

const MODEL_SORA2_SLUG   = process.env.MODEL_SORA2_SLUG   || "lucataco/animate-diff-v3-bonsai";
const MODEL_SORA2_VER    = process.env.MODEL_SORA2_VER    || null;

// New models
const MODEL_SVD_SLUG      = process.env.MODEL_SVD_SLUG      || "kwaivgi/kling-v2.1"; // Kling model
const MODEL_SVD_VER       = process.env.MODEL_SVD_VER       || null;

const MODEL_COGX_SLUG     = process.env.MODEL_COGX_SLUG     || "THUDM/cogvideox"; // Try alternative slug
const MODEL_COGX_VER      = process.env.MODEL_COGX_VER      || null;

const MODEL_ANIMATEDIFF_SLUG = process.env.MODEL_ANIMATEDIFF_SLUG || "guoyww/animatediff-motion-lora-zoom-out"; // Try alternative slug
const MODEL_ANIMATEDIFF_VER  = process.env.MODEL_ANIMATEDIFF_VER  || null;

const MODEL_LUMA_SLUG     = process.env.MODEL_LUMA_SLUG     || "lumaai/luma-dream-machine";
const MODEL_LUMA_VER      = process.env.MODEL_LUMA_VER      || null;

const MODEL_MATINEE_SLUG  = process.env.MODEL_MATINEE_SLUG  || "pixtral/magicanimate";
const MODEL_MATINEE_VER   = process.env.MODEL_MATINEE_VER   || null;

const MODEL_RUNWAY_SLUG   = process.env.MODEL_RUNWAY_SLUG   || "byterat/cinematic-video";
const MODEL_RUNWAY_VER    = process.env.MODEL_RUNWAY_VER    || null;

// Model-specific defaults
const MODEL_DEFAULTS = {
  vidai: {
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  wan: {
    duration: 5,
    resolution: "480p", // Changed to 480p for bundle videos
    aspect_ratio: "16:9",
    watermark: false
  },
  veo3: {
    duration: 4,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  sora2: {
    duration: 3,
    resolution: "480p",
    aspect_ratio: "16:9",
    watermark: false
  },
  svd: {
    duration: 5, // Kling only supports 5 or 10 seconds - using 5 for lower cost
    resolution: "480p", // Reduced resolution to lower cost
    aspect_ratio: "16:9",
    watermark: false
  },
  cogx: {
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  animatediff: {
    duration: 4,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  luma: {
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  matinee: {
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  },
  runway: {
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    watermark: false
  }
};

const CHEAP_DEFAULTS = {
  duration: 3,
  resolution: "480p",
  aspect_ratio: "16:9",
  watermark: false
};

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing" || s === "queued") return "IN_PROGRESS";
  return "IN_QUEUE";
}

function urlFromAny(x) {
  if (!x) return null;
  if (typeof x === "string") return x.startsWith("http") ? x : null;

  try {
    if (typeof x.url === "function") {
      const u = x.url();
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  } catch {}

  if (Array.isArray(x)) {
    for (const it of x) {
      const u = urlFromAny(it);
      if (u) return u;
    }
    return null;
  }

  if (typeof x === "object") {
    const direct = ["video_url", "video", "url", "mp4", "file", "output_url", "result_url", "media_url"];
    for (const k of direct) {
      const v = x[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
    }
    if (x.urls && typeof x.urls.get === "string" && x.urls.get.startsWith("http")) return x.urls.get;
    if (typeof x.output === "string" && x.output.startsWith("http")) return x.output;

    const u1 = urlFromAny(x.output);
    if (u1) return u1;

    for (const k of Object.keys(x)) {
      const u = urlFromAny(x[k]);
      if (u) return u;
    }
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeStatusUrl(id) {
  const path = `/video/result/${id}`;
  return BASE_PUBLIC_URL ? `${BASE_PUBLIC_URL}${path}` : path;
}

// Content Moderation using OpenAI Moderation API with retry mechanism
async function moderateContent(text, retries = 3) {
  console.log(`[MODERATION] Starting moderation check for text: "${text.substring(0, 100)}..."`);
  
  if (!OPENAI_API_KEY) {
    console.error("[MODERATION] FATAL: OpenAI API key not set!");
    throw new Error("Moderation API key not configured");
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    console.log("[MODERATION] Empty text, skipping moderation");
    return { flagged: false, categories: {} };
  }

  let lastError = null;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[MODERATION] Attempt ${attempt}/${retries} - Calling OpenAI Moderation API...`);
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({ input: text }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      console.log(`[MODERATION] API Response Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[MODERATION] API error: ${response.status} - ${errorText}`);
        
        // If it's a 401 (unauthorized) or 429 (rate limit), don't retry
        if (response.status === 401 || response.status === 429) {
          throw new Error(`Moderation API error: ${response.status} - ${errorText}`);
        }
        
        // For other errors, retry
        lastError = new Error(`Moderation API failed: ${response.status} - ${errorText}`);
        if (attempt < retries) {
          const delay = Math.min(1000 * attempt, 3000); // Exponential backoff, max 3 seconds
          console.log(`[MODERATION] Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      const data = await response.json();
      console.log(`[MODERATION] API Response Data:`, JSON.stringify(data, null, 2));
      const result = data.results?.[0];

      if (!result) {
        console.warn("[MODERATION] No result in API response");
        return { flagged: false, categories: {} };
      }
      
      console.log(`[MODERATION] Result - Flagged: ${result.flagged}, Categories:`, result.categories);

      // Check for critical categories: sexual, sexual/minors, violence, violence/graphic, self-harm
      const criticalCategories = [
        "sexual",
        "sexual/minors",
        "violence",
        "violence/graphic",
        "self-harm"
      ];

      const flaggedCategories = {};
      let hasCriticalCategory = false;

      // Check if any critical category is flagged (even if overall flagged is false)
      if (result.categories) {
        for (const category of criticalCategories) {
          if (result.categories[category] === true) {
            flaggedCategories[category] = true;
            hasCriticalCategory = true;
          }
        }
      }

      // Also check category scores - if score is above threshold, flag it
      // Lower threshold for more sensitive detection
      if (result.category_scores) {
        const scoreThreshold = 0.3; // Lower threshold for stricter moderation
        for (const category of criticalCategories) {
          const score = result.category_scores[category];
          if (score && score > scoreThreshold && !flaggedCategories[category]) {
            flaggedCategories[category] = true;
            hasCriticalCategory = true;
            console.log(`[MODERATION] Category ${category} flagged by score: ${score} (threshold: ${scoreThreshold})`);
          }
        }
      }

      // Consider flagged if overall flagged OR has critical category
      const isFlagged = result.flagged || hasCriticalCategory;

      console.log(`[MODERATION] Text: "${text.substring(0, 50)}..." - Flagged: ${isFlagged}, Overall Flagged: ${result.flagged}, Critical Categories:`, Object.keys(flaggedCategories));
      console.log(`[MODERATION] Category Scores:`, result.category_scores);

      return {
        flagged: isFlagged,
        categories: result.categories || {},
        flaggedCategories: flaggedCategories,
        categoryScores: result.category_scores || {}
      };
    } catch (error) {
      lastError = error;
      console.error(`[MODERATION] Attempt ${attempt}/${retries} failed:`, error.message);
      
      // If it's an abort (timeout), retry
      if (error.name === 'AbortError') {
        console.log(`[MODERATION] Request timeout, will retry...`);
        if (attempt < retries) {
          const delay = Math.min(1000 * attempt, 3000);
          console.log(`[MODERATION] Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
      }
      
      // If it's a network error, retry
      if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
        if (attempt < retries) {
          const delay = Math.min(1000 * attempt, 3000);
          console.log(`[MODERATION] Network error, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
      }
      
      // If all retries failed, throw the error
      if (attempt === retries) {
        console.error("[MODERATION] All retry attempts failed");
        console.error("[MODERATION] Last error:", error.message);
        console.error("[MODERATION] Stack:", error.stack);
        throw new Error(`Moderation check failed after ${retries} attempts: ${error.message}`);
      }
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error("Moderation check failed: Unknown error");
}

function httpError(res, e) {
  const msg = String(e?.message || e);
  const detail = e?.response?.error || e?.response?.data || e?.stack;
  console.error("[UPSTREAM ERROR]", msg, detail ? "\nDETAIL:" : "", detail || "");
  if ((msg.includes("Invalid") && msg.includes("version")) || msg.includes("422")) {
    return res.status(422).json({ error: `Invalid version or input. ${msg}` });
  }
  if (msg.includes("Payment") || msg.includes("402")) {
    return res.status(402).json({ error: "Payment required on Replicate." });
  }
  if (msg.toLowerCase().includes("permission") || msg.includes("403")) {
    return res.status(403).json({ error: "Permission denied on Replicate." });
  }
  return res.status(502).json({ error: msg });
}

function resolveModel(modelKey) {
  const key = (modelKey || "vidai").toLowerCase();
  switch (key) {
    case "vidai":
      return { slug: MODEL_VIDAI_SLUG, version: MODEL_VIDAI_VER, needsFps24: true, supportsImage: true };
    case "veo3":
      return { slug: MODEL_VEO3_SLUG, version: MODEL_VEO3_VER, needsFps24: false, supportsImage: true };
    case "wan":
      if (!MODEL_WAN_SLUG) throw new Error("WAN model not configured on server.");
      return { slug: MODEL_WAN_SLUG, version: MODEL_WAN_VER, needsFps24: false, supportsImage: true };
    case "sora2":
      if (!MODEL_SORA2_SLUG) throw new Error("Sora-2 model not configured on server.");
      return { slug: MODEL_SORA2_SLUG, version: MODEL_SORA2_VER, needsFps24: false, supportsImage: true };
    case "svd":
      if (!MODEL_SVD_SLUG) throw new Error("Kling model not configured on server.");
      return { slug: MODEL_SVD_SLUG, version: MODEL_SVD_VER, needsFps24: false, supportsImage: true };
    case "cogx":
      if (!MODEL_COGX_SLUG) throw new Error("CogVideoX model not configured on server.");
      return { slug: MODEL_COGX_SLUG, version: MODEL_COGX_VER, needsFps24: false, supportsImage: true };
    case "animatediff":
      if (!MODEL_ANIMATEDIFF_SLUG) throw new Error("AnimateDiff model not configured on server.");
      return { slug: MODEL_ANIMATEDIFF_SLUG, version: MODEL_ANIMATEDIFF_VER, needsFps24: false, supportsImage: true };
    case "luma":
      if (!MODEL_LUMA_SLUG) throw new Error("Luma model not configured on server.");
      return { slug: MODEL_LUMA_SLUG, version: MODEL_LUMA_VER, needsFps24: false, supportsImage: false };
    case "matinee":
      if (!MODEL_MATINEE_SLUG) throw new Error("Matinee model not configured on server.");
      return { slug: MODEL_MATINEE_SLUG, version: MODEL_MATINEE_VER, needsFps24: false, supportsImage: true };
    case "runway":
      if (!MODEL_RUNWAY_SLUG) throw new Error("Runway model not configured on server.");
      return { slug: MODEL_RUNWAY_SLUG, version: MODEL_RUNWAY_VER, needsFps24: false, supportsImage: true };
    default:
      return { slug: MODEL_VIDAI_SLUG, version: MODEL_VIDAI_VER, needsFps24: true, supportsImage: true };
  }
}

function getDefaultsForModel(modelKey) {
  const key = (modelKey || "vidai").toLowerCase();
  return MODEL_DEFAULTS[key] || CHEAP_DEFAULTS;
}

async function buildResultResponse(predId) {
  let pred = await replicate.predictions.get(predId);
  let url = urlFromAny(pred.output);
  if (pred.status === "succeeded" && !url) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      pred = await replicate.predictions.get(predId);
      url = urlFromAny(pred.output);
      if (url) break;
    }
  }
  const body = { status: mapStatus(pred.status), request_id: predId, job_id: predId };
  if (pred.status === "succeeded" && url) body.video_url = url;
  return body;
}

// Test Moderation Endpoint
app.post("/test/moderation", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.status(400).json({ error: "text required" });
    
    console.log(`[TEST] Testing moderation for: "${text}"`);
    const result = await moderateContent(text);
    
    return res.json({
      text: text,
      moderation: result,
      openaiApiKeySet: !!OPENAI_API_KEY
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Health
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    base_public_url: BASE_PUBLIC_URL || null,
    moderation_enabled: !!OPENAI_API_KEY,
    defaults: {
      vidai: MODEL_VIDAI_SLUG,
      veo3: MODEL_VEO3_SLUG,
      wan: MODEL_WAN_SLUG || "(not set)",
      sora2: MODEL_SORA2_SLUG || "(not set)",
      svd: MODEL_SVD_SLUG || "(not set)",
      cogx: MODEL_COGX_SLUG || "(not set)",
      animatediff: MODEL_ANIMATEDIFF_SLUG || "(not set)",
      luma: MODEL_LUMA_SLUG || "(not set)",
      matinee: MODEL_MATINEE_SLUG || "(not set)",
      runway: MODEL_RUNWAY_SLUG || "(not set)"
    }
  });
});

// Text → Video
app.post("/video/generate_text", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = (b.prompt || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // Content moderation check
    console.log(`[TEXT-TO-VIDEO] Checking moderation for prompt: "${prompt.substring(0, 50)}..."`);
    let moderationResult;
    try {
      moderationResult = await moderateContent(prompt);
      console.log(`[TEXT-TO-VIDEO] Moderation result:`, JSON.stringify(moderationResult, null, 2));
    } catch (modError) {
      console.error(`[TEXT-TO-VIDEO] Moderation check failed after retries:`, modError.message);
      console.error(`[TEXT-TO-VIDEO] Error details:`, modError);
      
      // Provide more specific error messages
      let errorMessage = "Yasak içerik kontrolü yapılamadı. Lütfen daha sonra tekrar deneyin.";
      if (modError.message.includes("401") || modError.message.includes("unauthorized")) {
        errorMessage = "Moderation servisi yapılandırma hatası. Lütfen daha sonra tekrar deneyin.";
      } else if (modError.message.includes("429") || modError.message.includes("rate limit")) {
        errorMessage = "Moderation servisi yoğun. Lütfen birkaç dakika sonra tekrar deneyin.";
      } else if (modError.message.includes("timeout") || modError.message.includes("AbortError")) {
        errorMessage = "Moderation servisi yanıt vermiyor. Lütfen internet bağlantınızı kontrol edip tekrar deneyin.";
      }
      
      return res.status(500).json({ 
        error: "Content moderation service unavailable",
        message: errorMessage,
        retryable: true
      });
    }
    
    if (moderationResult.flagged) {
      const flaggedCategories = Object.keys(moderationResult.flaggedCategories || {});
      const categoryNames = flaggedCategories.length > 0 
        ? flaggedCategories.join(", ")
        : "inappropriate content";
      console.log(`[MODERATION] Blocked text-to-video request - Categories: ${categoryNames}`);
      return res.status(403).json({ 
        error: "Content policy violation",
        message: "Yasak içerikler üretmeye çalışıyorsunuz. Bu tür içeriklerin tekrarlanması durumunda hesabınız banlanacaktır.",
        flaggedCategories: flaggedCategories
      });
    }

    const modelKey = (b.model || "vidai").toString();
    const model = resolveModel(modelKey);
    const defaults = getDefaultsForModel(modelKey);

    // Use provided values or fall back to model-specific defaults
    const duration = Number.isFinite(+b.duration) ? +b.duration : defaults.duration;
    const resolution = b.resolution || defaults.resolution;
    const aspect_ratio = b.aspect_ratio || defaults.aspect_ratio;
    const watermark = typeof b.watermark === "boolean" ? b.watermark : defaults.watermark;

    const input = {
      prompt,
      duration,
      resolution,
      aspect_ratio,
      watermark
    };
    if (model.needsFps24) input.fps = 24; // SeeDance gibi

    const createBody = model.version
      ? { version: model.version, input }
      : { model: model.slug, input };

    const pred = await replicate.predictions.create(createBody);
    const statusUrl = makeStatusUrl(pred.id);

    return res.json({
      status: "IN_QUEUE",
      request_id: pred.id,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) {
    return httpError(res, e);
  }
});

// Image → Video
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file required (multipart field: image)" });

    const prompt = (req.body?.prompt || "").toString();
    
    // Content moderation check
    console.log(`[IMAGE-TO-VIDEO] Checking moderation for prompt: "${prompt.substring(0, 50)}..."`);
    let moderationResult;
    try {
      moderationResult = await moderateContent(prompt);
      console.log(`[IMAGE-TO-VIDEO] Moderation result:`, JSON.stringify(moderationResult, null, 2));
    } catch (modError) {
      console.error(`[IMAGE-TO-VIDEO] Moderation check failed after retries:`, modError.message);
      console.error(`[IMAGE-TO-VIDEO] Error details:`, modError);
      
      // Provide more specific error messages
      let errorMessage = "Yasak içerik kontrolü yapılamadı. Lütfen daha sonra tekrar deneyin.";
      if (modError.message.includes("401") || modError.message.includes("unauthorized")) {
        errorMessage = "Moderation servisi yapılandırma hatası. Lütfen daha sonra tekrar deneyin.";
      } else if (modError.message.includes("429") || modError.message.includes("rate limit")) {
        errorMessage = "Moderation servisi yoğun. Lütfen birkaç dakika sonra tekrar deneyin.";
      } else if (modError.message.includes("timeout") || modError.message.includes("AbortError")) {
        errorMessage = "Moderation servisi yanıt vermiyor. Lütfen internet bağlantınızı kontrol edip tekrar deneyin.";
      }
      
      return res.status(500).json({ 
        error: "Content moderation service unavailable",
        message: errorMessage,
        retryable: true
      });
    }
    
    if (moderationResult.flagged) {
      const flaggedCategories = Object.keys(moderationResult.flaggedCategories || {});
      const categoryNames = flaggedCategories.length > 0 
        ? flaggedCategories.join(", ")
        : "inappropriate content";
      console.log(`[MODERATION] Blocked image-to-video request - Categories: ${categoryNames}`);
      return res.status(403).json({ 
        error: "Content policy violation",
        message: "Yasak içerikler üretmeye çalışıyorsunuz. Bu tür içeriklerin tekrarlanması durumunda hesabınız banlanacaktır.",
        flaggedCategories: flaggedCategories
      });
    }
    
    const modelKey = (req.body?.model || "vidai").toString();
    const model = resolveModel(modelKey);
    
    // Check if model supports image-to-video
    if (!model.supportsImage) {
      return res.status(400).json({ error: `Model ${modelKey} does not support image-to-video. Please use text-to-video endpoint.` });
    }
    
    const defaults = getDefaultsForModel(modelKey);

    // Use provided values or fall back to model-specific defaults
    const duration = Number.isFinite(+req.body?.duration) ? +req.body.duration : defaults.duration;
    const resolution = req.body?.resolution || defaults.resolution;
    const aspect_ratio = req.body?.aspect_ratio || defaults.aspect_ratio;
    const watermark = typeof req.body?.watermark === "string"
      ? req.body.watermark === "true"
      : (typeof req.body?.watermark === "boolean" ? req.body.watermark : defaults.watermark);

    // Model-specific input formatting
    let input = {};
    const modelKeyLower = modelKey.toLowerCase();
    
    if (modelKeyLower === "runway") {
      // Runway Gen4 Turbo
      input = {
        image: req.file.buffer,
        prompt: prompt || ""
      };
      if (duration) input.duration = duration;
      if (resolution) input.resolution = resolution;
    } else if (modelKeyLower === "svd") {
      // Kling model uses start_image instead of image
      input = {
        start_image: req.file.buffer,
        prompt: prompt || ""
      };
      // Kling parameters - adjust based on API documentation
      if (duration) input.duration = duration;
      if (resolution) input.resolution = resolution;
      if (aspect_ratio) input.aspect_ratio = aspect_ratio;
    } else {
      // Default format for other models
      input = {
        prompt,
        image: req.file.buffer,
        duration,
        resolution,
        aspect_ratio,
        watermark
      };
      if (model.needsFps24) input.fps = 24;
    }

    const createBody = model.version
      ? { version: model.version, input }
      : { model: model.slug, input };

    console.log(`[IMAGE-TO-VIDEO] Model: ${modelKey}, Input keys:`, Object.keys(input));
    
    const pred = await replicate.predictions.create(createBody);
    const statusUrl = makeStatusUrl(pred.id);

    console.log(`[IMAGE-TO-VIDEO] Prediction created: ${pred.id}, Status: ${pred.status}`);

    return res.json({
      status: "IN_QUEUE",
      request_id: pred.id,
      status_url: statusUrl,
      response_url: statusUrl,
      job_id: pred.id
    });
  } catch (e) {
    console.error(`[IMAGE-TO-VIDEO ERROR] Model: ${req.body?.model || "unknown"}, Error:`, e);
    return httpError(res, e);
  }
});

// Result by id
app.get("/video/result/:id", async (req, res) => {
  try {
    const body = await buildResultResponse(req.params.id);
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// Result by status_url
app.get("/video/result", async (req, res) => {
  try {
    const q = req.query.status_url;
    if (!q) return res.status(400).json({ error: "status_url required" });

    const raw = decodeURIComponent(q.toString());
    const parts = raw.split("/").filter(Boolean);
    const id = parts[parts.length - 1];
    if (!id) return res.status(400).json({ error: "invalid status_url" });

    const body = await buildResultResponse(id);
    return res.json(body);
  } catch (e) {
    return httpError(res, e);
  }
});

// Trends endpoint - GET /trends
app.get("/trends", async (req, res) => {
  try {
    const trendsPath = path.join(__dirname, 'trends_data.json');
    console.log(`[TRENDS] Looking for trends_data.json at: ${trendsPath}`);
    
    if (fs.existsSync(trendsPath)) {
      const fileContent = fs.readFileSync(trendsPath, 'utf8');
      console.log(`[TRENDS] File found, size: ${fileContent.length} bytes`);
      const trendsData = JSON.parse(fileContent);
      console.log(`[TRENDS] Parsed successfully: ${trendsData.categories?.length || 0} categories`);
      return res.json(trendsData);
    }
    
    console.error("[TRENDS] trends_data.json file not found at:", trendsPath);
    return res.status(404).json({ error: "Trends file not found" });
  } catch (e) {
    console.error("[TRENDS] Error loading trends:", e);
    return res.status(500).json({ error: "Failed to load trends: " + e.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening on", port));
