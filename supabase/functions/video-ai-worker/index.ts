import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

function extractText(messages: any[]): string {
  for (const event of [...messages].reverse()) {
    if (event?.type !== "assistant_message") continue;
    const content = event.assistant_message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (typeof content?.text === "string" && content.text.trim()) return content.text.trim();
    if (Array.isArray(content)) {
      const text = content.map((part: any) => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "";
}

async function manus(path: string, apiKey: string, init: RequestInit = {}) {
  const authHeader = apiKey.startsWith("Bearer ") ? { Authorization: apiKey } : { "x-manus-api-key": apiKey };
  const response = await fetch(`https://api.manus.ai/v2${path}`, {
    ...init,
    headers: { ...authHeader, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || data?.message || `Manus API HTTP ${response.status}`);
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method tidak didukung." }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = req.headers.get("Authorization") || "";
  if (!serviceKey || auth !== `Bearer ${serviceKey}`) return json({ error: "Worker tidak terautentikasi." }, 401);
  try {
    const body = await req.json();
    const audioPath = typeof body?.audio_path === "string" ? body.audio_path : "";
    const target = ["id", "en", "auto"].includes(body?.target_language) ? body.target_language : "id";
    if (!audioPath || audioPath.split("/").length < 3 || audioPath.includes("..")) return json({ error: "Path audio tidak valid." }, 400);
    const apiKey = Deno.env.get("MANUS_API_KEY");
    if (!apiKey) return json({ error: "MANUS_API_KEY belum dipasang pada Supabase Edge Function Secrets." }, 503);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabase = createClient(supabaseUrl, serviceKey);
    const { data: audio, error: downloadError } = await supabase.storage.from("video-jobs").download(audioPath);
    if (downloadError || !audio) throw new Error(downloadError?.message || "Audio tidak ditemukan di Storage.");
    const bytes = new Uint8Array(await audio.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const language = target === "en" ? "English" : target === "auto" ? "bahasa yang paling sesuai setelah mendeteksi bahasa narasi" : "Bahasa Indonesia";
    const prompt = `Dengarkan seluruh narasi audio. Transkripsikan teks asli, terjemahkan subtitle ke ${language}, lalu buat judul singkat, deskripsi media sosial natural, dan 5 hashtag relevan. Pertahankan start/end dalam detik. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0,"end":3,"text":"teks asli","translation":"hasil terjemahan"}],"title":"judul","description":"deskripsi","hashtags":["#satu"]}. Jangan menambahkan markdown atau penjelasan.`;
    const created = await manus("/task.create", apiKey, {
      method: "POST",
      body: JSON.stringify({
        message: { content: [
          { type: "text", text: prompt },
          { type: "voice", file_data: `data:audio/mpeg;base64,${base64}`, filename: "audio.mp3", mime_type: "audio/mpeg" },
        ] },
        agent_profile: "lite",
        locale: "id",
        title: "Video Translate AI",
        hide_in_task_list: true,
      }),
    });
    const taskId = created.task_id || created.taskId || created.task?.id;
    if (!taskId) throw new Error("Manus tidak mengembalikan task_id.");
    let resultText = extractText(created.messages || []);
    const deadline = Date.now() + 115_000;
    while (!resultText && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await manus(`/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=30`, apiKey, { headers: { Accept: "application/json" } });
      resultText = extractText(result.messages || result.data || []);
    }
    if (!resultText) throw new Error("Manus belum mengembalikan transkripsi/terjemahan sebelum batas waktu.");
    const clean = resultText.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const analysis = JSON.parse(clean);
    if (!Array.isArray(analysis.segments) || analysis.segments.length === 0) throw new Error("Segmen subtitle kosong.");
    return json({
      segments: analysis.segments,
      title: String(analysis.title || "Video terbaru").slice(0, 100),
      description: String(analysis.description || "").slice(0, 5000),
      hashtags: Array.isArray(analysis.hashtags) ? analysis.hashtags.map(String).slice(0, 10) : [],
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Gagal memproses audio." }, 500);
  }
});
