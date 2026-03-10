import { spawn } from "child_process";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ws = createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body), ws);
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] ${args.join(" ").substring(0, 200)}...`);
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

export async function renderVideo(manifest, workDir) {
  const jobId = randomUUID();
  const jobDir = path.join(workDir, jobId);
  const outputDir = path.join(workDir, "output");
  await fs.mkdir(jobDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const { scenes, subtitles, music_track, music_volume = 0.15, output_quality = "1080p", platform = "16:9" } = manifest;
  const resolution = platform === "9:16" ? "720:1280" : platform === "1:1" ? "1080:1080" : "1920:1080";
  const [w, h] = resolution.split(":").map(Number);

  console.log(`[job:${jobId}] Downloading ${scenes.length} scenes...`);
  const downloads = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const vidPath = path.join(jobDir, `scene_${i}.mp4`);
    const audPath = path.join(jobDir, `scene_${i}.mp3`);
    if (s.video_url) downloads.push(downloadFile(s.video_url, vidPath).then(() => ({ i, type: "video", path: vidPath })));
    if (s.audio_url) downloads.push(downloadFile(s.audio_url, audPath).then(() => ({ i, type: "audio", path: audPath })));
  }

  const results = await Promise.allSettled(downloads);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(`[job:${jobId}] ${failed.length} downloads failed:`, failed.map((f) => f.reason?.message));
  }

  const scenePaths = scenes.map((_, i) => ({
    video: path.join(jobDir, `scene_${i}.mp4`),
    audio: path.join(jobDir, `scene_${i}.mp3`),
  }));

  const validScenes = [];
  for (let i = 0; i < scenePaths.length; i++) {
    try {
      await fs.access(scenePaths[i].video);
      await fs.access(scenePaths[i].audio);
      validScenes.push(i);
    } catch {
      console.warn(`[job:${jobId}] Scene ${i} missing assets, skipping`);
    }
  }

  if (validScenes.length === 0) {
    throw new Error("No scenes have both video and audio assets");
  }

  console.log(`[job:${jobId}] Normalizing ${validScenes.length} scenes...`);
  const normalizedPaths = [];
  for (const i of validScenes) {
    const outPath = path.join(jobDir, `norm_${i}.mp4`);
    await runFFmpeg([
      "-i", scenePaths[i].video,
      "-i", scenePaths[i].audio,
      "-filter_complex",
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]`,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "fast", "-crf", output_quality === "4k" ? "18" : "23",
      "-c:a", "aac", "-b:a", "192k",
      "-shortest", "-y", outPath,
    ]);
    normalizedPaths.push(outPath);
  }

  console.log(`[job:${jobId}] Concatenating ${normalizedPaths.length} scenes...`);
  const concatFile = path.join(jobDir, "concat.txt");
  await fs.writeFile(concatFile, normalizedPaths.map((p) => `file '${p}'`).join("\n"));
  const concatPath = path.join(jobDir, "concat.mp4");
  await runFFmpeg(["-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-y", concatPath]);

  let currentPath = concatPath;

  if (music_track) {
    console.log(`[job:${jobId}] Mixing background music...`);
    const musicPath = path.join(jobDir, "music.mp3");
    try {
      await downloadFile(music_track, musicPath);
      const musicMixPath = path.join(jobDir, "with_music.mp4");
      await runFFmpeg([
        "-i", currentPath, "-i", musicPath,
        "-filter_complex",
        `[1:a]volume=${music_volume}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-y", musicMixPath,
      ]);
      currentPath = musicMixPath;
    } catch (err) {
      console.warn(`[job:${jobId}] Music mix failed, continuing without:`, err.message);
    }
  }

  if (subtitles && subtitles.trim().length > 0) {
    console.log(`[job:${jobId}] Burning subtitles...`);
    const srtPath = path.join(jobDir, "subs.srt");
    await fs.writeFile(srtPath, subtitles);
    const subPath = path.join(jobDir, "with_subs.mp4");
    const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    await runFFmpeg([
      "-i", currentPath,
      "-vf", `subtitles='${escapedSrt}'`,
      "-c:v", "libx264", "-preset", "fast", "-crf", output_quality === "4k" ? "18" : "23",
      "-c:a", "copy", "-y", subPath,
    ]);
    currentPath = subPath;
  }

  const outputName = `render_${jobId}.mp4`;
  const outputPath = path.join(outputDir, outputName);
  await fs.copyFile(currentPath, outputPath);
  await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});

  const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const videoUrl = `${baseUrl}/output/${outputName}`;

  return {
    video_url: videoUrl,
    job_id: jobId,
    scenes_rendered: validScenes.length,
    quality: output_quality,
    format: platform,
  };
}
