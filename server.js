import express from "express";
import multer from "multer";
import fetch from "node-fetch";

const app = express();
app.use(express.json({limit: "10mb"}));
const upload = multer();

const JOBS = new Map();
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const PIKA_VERSION = "pika-labs/pika-1:latest";
const SVD_VERSION  = "stability-ai/stable-video-diffusion:latest";

async function replicatePost(model, input) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({version: model, input})
  });
  if (!r.ok) throw new Error(`Replicate ${r.status}: ${await r.text()}`);
  return r.json();
}
async function replicateGet(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: {"Authorization": `Token ${REPLICATE_TOKEN}`}
  });
  if (!r.ok) throw new Error(`Replicate ${r.status}: ${await r.text()}`);
  return r.json();
}
function mapStatus(s) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "canceled") return "FAILED";
  if (s === "starting" || s === "processing") return "IN_PROGRESS";
  return "IN_QUEUE";
}
function extractUrl(output){
  if (!output) return null;
  if (Array.isArray(output) && output.length) return output[output.length-1];
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    for (const k of ["video","url","output"]) if (typeof output[k]==="string") return output[k];
  }
  return null;
}

app.post("/video/generate_text", async (req, res) => {
  try {
    const {prompt} = req.body;
    const pred = await replicatePost(PIKA_VERSION, {prompt});
    const id = crypto.randomUUID();
    JOBS.set(id, {pred_id: pred.id, type: "text"});
    res.json({status:"IN_QUEUE", request_id:id, status_url:`/video/result/${id}`, response_url:`/video/result/${id}`});
  } catch (e) { res.status(502).json({error: String(e)}) }
});

app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    const prompt = req.body.prompt || "";
    const dataUrl = "data:image/jpeg;base64," + req.file.buffer.toString("base64");
    const pred = await replicatePost(SVD_VERSION, {input_image: dataUrl, prompt});
    const id = crypto.randomUUID();
    JOBS.set(id, {pred_id: pred.id, type: "image"});
    res.json({status:"IN_QUEUE", request_id:id, status_url:`/video/result/${id}`, response_url:`/video/result/${id}`});
  } catch (e) { res.status(502).json({error: String(e)}) }
});

app.get("/video/result/:id", async (req, res) => {
  try {
    const job = JOBS.get(req.params.id);
    if (!job) return res.status(404).json({error:"Unknown request id"});
    const pred = await replicateGet(job.pred_id);
    const body = {status: mapStatus(pred.status), request_id: req.params.id};
    const url = extractUrl(pred.output);
    if (url) body.video_url = url;
    res.json(body);
  } catch (e) { res.status(502).json({error: String(e)}) }
});

app.get("/video/result", async (req, res) => {
  const statusUrl = req.query.status_url;
  if (!statusUrl) return res.status(400).json({error:"status_url required"});
  const id = statusUrl.toString().split("/").pop();
  req.params = {id};
  return app._router.handle(req, res, () => {});
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("listening", port));
