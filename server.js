import express from "express";
import { renderVideo } from "./render.js";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const WORK_DIR = process.env.WORK_DIR || "/tmp/renders";

app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ffmpeg: true, timestamp: new Date().toISOString() });
});

app.post("/render", async (req, res) => {
  const manifest = req.body;
  if (!manifest?.scenes?.length) {
    return res.status(400).json({ error: "Invalid manifest: scenes array required" });
  }
  try {
    console.log(`[render] Starting: ${manifest.scenes.length} scenes, quality=${manifest.output_quality || "1080p"}`);
    const result = await renderVideo(manifest, WORK_DIR);
    console.log(`[render] Complete: ${result.video_url}`);
    res.json(result);
  } catch (err) {
    console.error("[render] Failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use("/output", express.static(path.join(WORK_DIR, "output")));

app.post("/cleanup", async (_req, res) => {
  try {
    const entries = await fs.readdir(WORK_DIR, { withFileTypes: true });
    let cleaned = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "output") {
        await fs.rm(path.join(WORK_DIR, entry.name), { recursive: true, force: true });
        cleaned++;
      }
    }
    res.json({ cleaned });
  } catch {
    res.json({ cleaned: 0 });
  }
});

app.listen(PORT, () => {
  console.log(`Render worker listening on port ${PORT}`);
  fs.mkdir(path.join(WORK_DIR, "output"), { recursive: true }).catch(() => {});
});
