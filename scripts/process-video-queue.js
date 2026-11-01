const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ffmpeg = require('ffmpeg-static');
const execFileAsync = promisify(execFile);

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required GitHub Actions secret: ${key}`);
if (!ffmpeg) throw new Error('ffmpeg-static binary tidak tersedia pada runner.');
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_BUCKET || 'video-jobs';
const functionName = process.env.VIDEO_AI_FUNCTION || 'video-ai-worker';

async function request(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}${pathname}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      ...(options.body && !(options.body instanceof require('node:stream').Readable) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body?.message || body?.error || `Supabase HTTP ${response.status}: ${String(text).slice(0, 500)}`);
  return body;
}
function encodedPath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }
async function downloadStorage(storagePath, destination) {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath(storagePath)}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
  });
  if (!response.ok) throw new Error(`Gagal mengunduh ${storagePath}: HTTP ${response.status}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
async function uploadStorage(storagePath, filePath, contentType) {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath(storagePath)}`, {
    method: 'POST',
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: fs.createReadStream(filePath),
    duplex: 'half'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gagal mengunggah ${storagePath}: HTTP ${response.status} ${text.slice(0, 400)}`);
}
async function patchJob(id, values, filters = '') {
  return request(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(id)}${filters}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() })
  });
}
async function updateStatus(id, status) { await patchJob(id, { status }); }
function videoTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), z = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(z).padStart(3, '0')}`;
}
function srtFromSegments(segments) {
  return segments.map((segment, index) => `${index + 1}\n${videoTime(segment.start)} --> ${videoTime(Math.max(Number(segment.end || 0), Number(segment.start || 0) + 1))}\n${String(segment.translation || segment.text || '').trim()}\n`).join('\n');
}
const formats = {
  short: [1080, 1920], square: [1080, 1080], feed: [1080, 1350], landscape: [1920, 1080]
};
const styles = {
  clean: 'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=28',
  bold: 'FontName=Arial,FontSize=24,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=1,MarginV=34',
  neon: 'FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H00FFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=1,MarginV=32',
  cinema: 'FontName=Georgia,FontSize=21,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=30',
  pink: 'FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H00FFAAFF,OutlineColour=&H001B0617,BorderStyle=1,Outline=2,Shadow=1,MarginV=31',
  green: 'FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H0000FFAA,OutlineColour=&H000B1A14,BorderStyle=1,Outline=2,Shadow=1,MarginV=31'
};

async function processJob(job) {
  if (!job.user_id || !job.input_path) throw new Error('Job harus memiliki user_id dan input_path.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `video-job-${job.id}-`));
  const input = path.join(work, 'input.mp4');
  const audio = path.join(work, 'audio.mp3');
  const subtitle = path.join(work, 'subtitle.srt');
  const output = path.join(work, 'output.mp4');
  const root = `${job.user_id}/${job.id}`;
  const audioStoragePath = `${root}/audio.mp3`;
  const outputStoragePath = `${root}/output.mp4`;
  const subtitleStoragePath = `${root}/subtitle.srt`;
  try {
    console.log(`Job ${job.id}: mengunduh video.`);
    await downloadStorage(job.input_path, input);
    await updateStatus(job.id, 'extracting');
    await execFileAsync(ffmpeg, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio], { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
    await uploadStorage(audioStoragePath, audio, 'audio/mpeg');
    await updateStatus(job.id, 'transcribing');
    console.log(`Job ${job.id}: meminta transkripsi dan terjemahan ke Supabase Edge Function.`);
    const analysis = await request(`/functions/v1/${encodeURIComponent(functionName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_path: audioStoragePath, target_language: job.target_language || 'id' })
    });
    if (!Array.isArray(analysis?.segments) || analysis.segments.length === 0) throw new Error('AI tidak mengembalikan segmen subtitle.');
    await updateStatus(job.id, 'rendering');
    fs.writeFileSync(subtitle, srtFromSegments(analysis.segments), 'utf8');
    const [width, height] = formats[job.format] || formats.short;
    const style = styles[job.template] || styles.clean;
    const subtitleFilterPath = subtitle.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,subtitles='${subtitleFilterPath}':force_style='${style}'`;
    if ((job.output_mode || 'burned') === 'burned') {
      await execFileAsync(ffmpeg, ['-y', '-i', input, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output], { timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
    } else {
      fs.copyFileSync(input, output);
    }
    await uploadStorage(outputStoragePath, output, 'video/mp4');
    await uploadStorage(subtitleStoragePath, subtitle, 'application/x-subrip');
    await request(`/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: [audioStoragePath] })
    }).catch((error) => console.warn(`Audio sementara tidak terhapus: ${error.message}`));
    await patchJob(job.id, {
      status: 'completed', output_path: outputStoragePath, subtitle_path: subtitleStoragePath,
      segments: analysis.segments.length, title: analysis.title || 'Video terbaru',
      description: analysis.description || '', hashtags: Array.isArray(analysis.hashtags) ? analysis.hashtags : [],
      youtube_status: 'ready', error: null
    });
    console.log(`Job ${job.id}: selesai; hasil tersimpan privat di Supabase.`);
  } catch (error) {
    const message = String(error?.message || error).slice(-1800);
    await patchJob(job.id, { status: 'failed', error: message }).catch((updateError) => console.error(`Gagal menyimpan status error: ${updateError.message}`));
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const jobs = await request('/rest/v1/video_jobs?status=eq.queued&user_id=not.is.null&input_path=not.is.null&order=created_at.asc&limit=1&select=*');
  if (!jobs?.length) { console.log('Tidak ada job video dalam antrean.'); return; }
  const job = jobs[0];
  const claimed = await request(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.queued`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'extracting', updated_at: new Date().toISOString() })
  });
  if (!claimed?.length) { console.log(`Job ${job.id} sudah diambil worker lain.`); return; }
  await processJob({ ...job, status: 'extracting' });
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
