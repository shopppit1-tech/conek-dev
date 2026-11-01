const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_BUCKET || 'video-jobs';
const maxPerRun = Math.max(1, Number(process.env.VIDEOS_PER_RUN || 1));

async function supabase(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}${pathname}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body?.message || body?.error || `Supabase HTTP ${response.status}`);
  return body;
}

async function downloadJob(job) {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${job.output_path}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
  });
  if (!response.ok) throw new Error(`Cannot download ${job.output_path}: HTTP ${response.status}`);
  const file = path.join(os.tmpdir(), `${job.id}.mp4`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function main() {
  const jobs = await supabase(`/rest/v1/video_jobs?status=eq.completed&youtube_status=eq.ready&output_path=not.is.null&order=created_at.asc&limit=${maxPerRun}&select=*`);
  if (!jobs.length) {
    console.log('No ready video jobs found.');
    return;
  }

  const auth = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth });

  for (const job of jobs) {
    let file;
    try {
      await supabase(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ youtube_status: 'uploading' })
      });
      file = await downloadJob(job);
      const title = job.youtube_title || job.title || job.original_filename || 'Video terbaru';
      const description = job.youtube_description || job.description || 'Video diproses otomatis.';
      const privacy = ['private', 'unlisted', 'public'].includes(job.youtube_privacy) ? job.youtube_privacy : 'private';
      const result = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), tags: Array.isArray(job.hashtags) ? job.hashtags.map(String).slice(0, 30) : [] },
          status: { privacyStatus: privacy }
        },
        media: { body: fs.createReadStream(file) }
      });
      const videoId = result.data.id;
      await supabase(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ youtube_status: 'uploaded', youtube_video_id: videoId, error: null })
      });
      console.log(`Uploaded job ${job.id} to https://youtu.be/${videoId}`);
    } catch (error) {
      await supabase(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ youtube_status: 'failed', error: `YouTube upload: ${error.message}` })
      }).catch(updateError => console.error(`Could not save failure: ${updateError.message}`));
      console.error(`Job ${job.id} failed: ${error.stack || error.message}`);
      process.exitCode = 1;
    } finally {
      if (file) fs.rmSync(file, { force: true });
    }
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
