require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const sessions = new Map();
const videoJobs = new Map();
const videoOutputDir = path.join(os.tmpdir(), "devops-video-output");
fs.mkdirSync(videoOutputDir, {recursive:true});
function jobStatePath(id){return path.join(videoOutputDir, `${id}.json`);}
function persistJob(id){const job=videoJobs.get(id);if(job){fs.writeFileSync(jobStatePath(id),JSON.stringify(job));syncRemoteJob(id).catch(e=>console.error(`[video-job:${id}] supabase sync failed`,e.message));}}
function restoreJob(id){if(videoJobs.has(id))return videoJobs.get(id);try{const job=JSON.parse(fs.readFileSync(jobStatePath(id),"utf8"));videoJobs.set(id,job);return job;}catch{return null;}}
function setJobStatus(id,status){const job=videoJobs.get(id);if(job){job.status=status;persistJob(id);}}
for(const file of fs.readdirSync(videoOutputDir)){if(file.endsWith(".json")){try{const id=file.slice(0,-5);videoJobs.set(id,JSON.parse(fs.readFileSync(path.join(videoOutputDir,file),"utf8")));}catch{}}}
const SUPABASE_URL=(process.env.SUPABASE_URL||"https://cnjssbqdmgfnvdtsudwx.supabase.co").replace(/\/$/,"");
const SUPABASE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_ANON_KEY||"";
const supabaseEnabled=!!SUPABASE_KEY;
function rowToJob(row){return {status:row.status,createdAt:new Date(row.created_at).getTime(),updatedAt:new Date(row.updated_at||row.created_at).getTime(),name:row.original_filename,template:row.template,targetLanguage:row.target_language,format:row.format,outputMode:row.output_mode,inputPath:row.input_path,outputPath:row.output_path,subtitlePath:row.subtitle_path,segments:row.segments,title:row.title,description:row.description,hashtags:row.hashtags||[],error:row.error};}
async function supabaseFetch(pathname,options={}){if(!supabaseEnabled)throw Error("Supabase belum dikonfigurasi");const r=await fetch(`${SUPABASE_URL}${pathname}`,{...options,headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,"Content-Type":"application/json",...(options.headers||{})}});const text=await r.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}if(!r.ok)throw Error(data?.message||data?.hint||data?.error_description||`Supabase HTTP ${r.status}`);return data;}
async function createRemoteJob(id,job){if(!supabaseEnabled)return;await supabaseFetch(`/rest/v1/video_jobs`,{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({id,status:job.status,original_filename:job.name,template:job.template,target_language:job.targetLanguage,format:job.format,output_mode:job.outputMode})});}
async function syncRemoteJob(id){if(!supabaseEnabled)return;const job=videoJobs.get(id);if(!job)return;await supabaseFetch(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(id)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({status:job.status,input_path:job.inputPath||null,output_path:job.outputPath||null,subtitle_path:job.subtitlePath||null,segments:job.segments||null,title:job.title||null,description:job.description||null,hashtags:job.hashtags||[],error:job.error||null})});}
async function restoreJobRemote(id){if(!supabaseEnabled)return null;try{const rows=await supabaseFetch(`/rest/v1/video_jobs?id=eq.${encodeURIComponent(id)}&select=*`);if(!rows?.length)return null;const job=rowToJob(rows[0]);videoJobs.set(id,job);persistJob(id);return job;}catch(e){console.error(`[video-job:${id}] supabase restore failed`,e.message);return null;}}
async function uploadToSupabase(localPath,remotePath,contentType){if(!supabaseEnabled)return;const body=fs.readFileSync(localPath);await supabaseFetch(`/storage/v1/object/video-jobs/${remotePath}`,{method:"POST",headers:{"Content-Type":contentType,"x-upsert":"true"},body});}
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `devops-upload-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname || ".mp4") || ".mp4"}`)
  }),
  limits: {fileSize: 100 * 1024 * 1024},
  fileFilter: (req, file, cb) => cb(null, /^video\//i.test(file.mimetype))
});

function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: "Login diperlukan." });
}
app.post("/api/login", (req,res) => {
  if (!APP_PASSWORD) return res.json({ ok:true, token:"local-no-auth" });
  if (!req.body || req.body.password !== APP_PASSWORD) return res.status(401).json({error:"Kata sandi salah."});
  const token=crypto.randomBytes(32).toString("hex"); sessions.set(token, Date.now());
  res.json({ok:true,token});
});
app.get("/api/health",(req,res)=>res.json({ok:true,app:"DevOps AI",time:new Date().toISOString(),authEnabled:!!APP_PASSWORD}));
app.use("/api", (req,res,next)=>{ if(req.path==="/login"||req.path==="/health") return next(); auth(req,res,next); });

const providers = {
  openai: { key:()=>process.env.OPENAI_API_KEY || (process.env.AI_PROVIDER==="openai"?process.env.AI_API_KEY:""), model:()=>process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-4o-mini", base:()=>"https://api.openai.com/v1/chat/completions" },
  anthropic: { key:()=>process.env.ANTHROPIC_API_KEY || (process.env.AI_PROVIDER==="anthropic"?process.env.AI_API_KEY:""), model:()=>process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest" },
  gemini: { key:()=>process.env.GEMINI_API_KEY || (process.env.AI_PROVIDER==="gemini"?process.env.AI_API_KEY:""), model:()=>"gemini-3.8-flash" },
  compatible: { key:()=>process.env.COMPAT_API_KEY || (process.env.AI_PROVIDER==="openai-compatible"?process.env.AI_API_KEY:""), model:()=>process.env.COMPAT_MODEL || process.env.AI_MODEL || "default", base:()=>process.env.COMPAT_BASE_URL || process.env.AI_BASE_URL },
  manus: { key:()=>process.env.MANUS_API_KEY || (process.env.AI_PROVIDER==="manus"?process.env.AI_API_KEY:""), model:()=>process.env.MANUS_MODEL || process.env.AI_MODEL || "manus-1.6-lite", base:()=>process.env.MANUS_BASE_URL || "https://api.manus.ai/v2" }
};
function configuredOrder(){
  const primary=(process.env.AI_PROVIDER||"openai").toLowerCase();
  const raw=(process.env.AI_FALLBACK_ORDER||"openai,anthropic,gemini").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  const normalized=raw.map(x=>x==="openai-compatible"?"compatible":x);
  const normalizedPrimary=primary==="openai-compatible"?"compatible":primary;
  return [normalizedPrimary,...normalized].filter((x,i,a)=>providers[x]&&a.indexOf(x)===i&&providers[x].key());
}
function manusText(data){
  if(data?.output_text) return data.output_text;
  const items=data?.output||data?.messages||[];
  return (Array.isArray(items)?items:[]).flatMap(item=>{
    if(typeof item==="string") return [item];
    if(data?.messages&&item?.role!=="assistant") return [];
    if(typeof item?.content==="string") return [item.content];
    if(Array.isArray(item?.content)) return item.content.map(x=>x?.text||x?.value||"");
    if(typeof item?.text==="string") return [item.text];
    return [];
  }).filter(Boolean).join("\n");
}
async function fetchWithTimeout(url, options={}, timeoutMs=90000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, {...options, signal: controller.signal}); }
  catch (e) { if (e.name === "AbortError") throw Object.assign(new Error("AI timeout setelah " + Math.round(timeoutMs / 1000) + " detik"), {status: 504}); throw e; }
  finally { clearTimeout(timer); }
}
function parseJsonAI(text){
  const cleaned = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw Error("AI tidak mengembalikan JSON valid.");
}
async function callProvider(name, messages){
  const p=providers[name]; const key=p.key();
  if(!key) throw Object.assign(new Error("API key "+name+" belum diatur"),{status:401,provider:name});
  const system="Kamu adalah DevOps AI yang membantu mengelola GitHub, Render, dan Firebase. Jawab dalam bahasa Indonesia. Jangan mengaku telah melakukan tindakan eksternal jika belum dilakukan melalui tool resmi. Jangan meminta pengguna membagikan secret/API key di chat. Jelaskan bahwa tindakan berisiko memerlukan konfirmasi.";
  if(name==="manus"){
    const prompt=[system,...messages.filter(m=>m.role!=="system").map(m=>`${m.role}: ${m.content}`)].join("\n\n");
    const profile=p.model().includes("max")?"max":p.model().includes("lite")?"lite":"standard";
    const r=await fetchWithTimeout(p.base().replace(/\/$/,"")+"/task.create",{method:"POST",headers:{"content-type":"application/json","x-manus-api-key":key},body:JSON.stringify({message:{content:[{type:"text",text:prompt}]},agent_profile:profile})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||data.error?.code||data.message||`Manus API HTTP ${r.status}`),{status:r.status,provider:name});
    let result=data; let text=manusText(result); const taskId=data.task_id||data.taskId||data.task?.id;
    if(!text && taskId){
      const taskUrl=p.base().replace(/\/$/,"")+"/task.listMessages?task_id="+encodeURIComponent(taskId)+"&order=desc&limit=20";
      const deadline=Date.now()+55000;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,1500));
        const poll=await fetchWithTimeout(taskUrl,{headers:{"Accept":"application/json","x-manus-api-key":key}}); result=await poll.json();
        if(!poll.ok) throw Object.assign(new Error(result.error?.message||result.error?.code||result.message||`Manus task retrieval HTTP ${poll.status}`),{status:poll.status,provider:name});
        const assistantMessages=(result.messages||[]).filter(x=>x?.type==="assistant_message"&&x.assistant_message?.content).map(x=>x.assistant_message.content);
        text=assistantMessages.join("\n"); const statusUpdates=(result.messages||[]).filter(x=>x?.type==="status_update").map(x=>x.status_update?.agent_status); const status=String(statusUpdates[0]||"").toLowerCase();
        if(text || ["completed","failed","error"].includes(status)) break;
      }
    }
    if(result.ok===false) throw Object.assign(new Error(result.error?.message||"Manus task gagal"),{status:502,provider:name});
    if(!text) throw Object.assign(new Error("Manus task belum selesai atau tidak mengembalikan output"),{status:504,provider:name});
    return {text,provider:name,model:p.model()};
  }
  if(name==="anthropic"){
    const r=await fetchWithTimeout("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:p.model(),max_tokens:1200,system,messages:messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:m.content}))})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||"Anthropic API error"),{status:r.status,provider:name});
    return {text:(data.content||[]).map(x=>x.text||"").join("\n"),provider:name,model:p.model()};
  }
  if(name==="gemini"){
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model())}:generateContent?key=${encodeURIComponent(key)}`;
    const contents=messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]}));
    const r=await fetchWithTimeout(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents,generationConfig:{maxOutputTokens:1200}})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||"Gemini API error"),{status:r.status,provider:name});
    return {text:(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("\n"),provider:name,model:p.model()};
  }
  const base=name==="openai"?p.base():p.base();
  if(!base) throw Object.assign(new Error("AI_BASE_URL/COMPAT_BASE_URL belum diatur"),{status:400,provider:name});
  const url=base.endsWith("/chat/completions")?base:base.replace(/\/$/,"")+"/chat/completions";
  const r=await fetchWithTimeout(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:JSON.stringify({model:p.model(),messages:[{role:"system",content:system},...messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:m.content}))],temperature:0.3})});
  const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||"AI API error"),{status:r.status,provider:name});
  return {text:data.choices?.[0]?.message?.content||"Provider tidak mengembalikan jawaban.",provider:name,model:p.model()};
}
app.get("/api/providers",auth,(req,res)=>{
 const order=configuredOrder();
 res.json({primary:process.env.AI_PROVIDER||"openai",providers:Object.keys(providers).map(name=>({id:name,label:({openai:"OpenAI",anthropic:"Anthropic Claude",gemini:"Google Gemini",compatible:"API kompatibel",manus:"Manus AI"}[name]),configured:!!providers[name].key(),model:providers[name].model(),active:order[0]===name,quota:"Tidak tersedia dari API"})),fallbackOrder:order});
});
app.post("/api/chat",auth,async(req,res)=>{
 const messages=Array.isArray(req.body?.messages)?req.body.messages.slice(-16):[];
 if(!messages.length || !messages.every(m=>["user","assistant"].includes(m.role)&&typeof m.content==="string")) return res.status(400).json({error:"Format pesan tidak valid."});
 const order=configuredOrder();
 if(!order.length) return res.status(503).json({error:"Belum ada API AI yang dikonfigurasi. Isi .env dan restart server."});
 const failures=[];
 for(const name of order){
  try { const out=await callProvider(name,messages); const primary=(process.env.AI_PROVIDER==="openai-compatible"?"compatible":process.env.AI_PROVIDER||"openai"); return res.json({...out,fallbackUsed:name!==primary,attempted:failures.map(x=>x.provider)}); }
  catch(e){ failures.push({provider:name,message:e.message,status:e.status||0}); if(![401,403,404,408,413,429,500,502,503,504,400].includes(e.status)) break; }
 }
 res.status(502).json({error:"Semua provider AI yang dikonfigurasi gagal.",details:failures});
});
app.get("/api/github/status",auth,async(req,res)=>{
 const token=process.env.GITHUB_TOKEN;if(!token)return res.json({connected:false,message:"GITHUB_TOKEN belum diatur"});
 try{const r=await fetch("https://api.github.com/user",{headers:{Authorization:"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"DevOps-AI"}});const d=await r.json();if(!r.ok)throw Error(d.message||"GitHub API error");res.json({connected:true,user:d.login});}catch(e){res.status(502).json({connected:false,message:e.message});}
});
app.get("/api/github/repos",auth,async(req,res)=>{
 const token=process.env.GITHUB_TOKEN;if(!token)return res.status(400).json({error:"GITHUB_TOKEN belum diatur"});
 try{const r=await fetch("https://api.github.com/user/repos?per_page=30&sort=updated",{headers:{Authorization:"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"DevOps-AI"}});const d=await r.json();if(!r.ok)throw Error(d.message||"GitHub API error");res.json(d.map(x=>({name:x.full_name,private:x.private,branch:x.default_branch,url:x.html_url,updated:x.updated_at})));}catch(e){res.status(502).json({error:e.message});}
});
app.post("/api/github/repos",auth,async(req,res)=>{
 const token=process.env.GITHUB_TOKEN;if(!token)return res.status(400).json({error:"GITHUB_TOKEN belum diatur"});
 const name=String(req.body?.name||"").trim(),description=String(req.body?.description||"").trim().slice(0,350),isPrivate=req.body?.private!==false;
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name))return res.status(400).json({error:"Nama repository tidak valid. Gunakan huruf, angka, titik, garis, atau underscore."});
 try{const r=await fetch("https://api.github.com/user/repos",{method:"POST",headers:{Authorization:"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"DevOps-AI","Content-Type":"application/json"},body:JSON.stringify({name,description,private:isPrivate,auto_init:true})});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d.message||"GitHub create repository error"),{status:r.status});res.status(201).json({ok:true,name:d.full_name,private:d.private,branch:d.default_branch,url:d.html_url});}catch(e){res.status(e.status===422?409:502).json({error:e.message,help:e.status===403?"Token GitHub memerlukan Administration: write untuk membuat repository.":undefined});}
});
app.put("/api/github/file",auth,async(req,res)=>{
 const token=process.env.GITHUB_TOKEN;if(!token)return res.status(400).json({error:"GITHUB_TOKEN belum diatur"});
 const owner=String(req.body?.owner||process.env.GITHUB_OWNER||"").trim(),repo=String(req.body?.repo||process.env.GITHUB_REPO||"").trim(),path=String(req.body?.path||"").replace(/^\/+/,""),content=String(req.body?.content??""),message=String(req.body?.message||`Update ${path}`).trim(),branch=String(req.body?.branch||"main").trim();
 if(!owner||!repo||!path||path.includes("..")||!message||content.length>500000)return res.status(400).json({error:"Owner, repo, path, message, dan isi file wajib valid; ukuran file maksimal 500 KB."});
 const headers={Authorization:"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"DevOps-AI","Content-Type":"application/json"},base=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
 try{let sha;const existing=await fetch(`${base}?ref=${encodeURIComponent(branch)}`,{headers});if(existing.ok){const old=await existing.json();sha=old.sha;}const r=await fetch(base,{method:"PUT",headers,body:JSON.stringify({message,content:Buffer.from(content,"utf8").toString("base64"),branch,...(sha?{sha}:{})})});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d.message||"GitHub file update error"),{status:r.status});res.status(201).json({ok:true,action:sha?"updated":"created",file:d.content?.path||path,commit:d.commit?.sha,url:d.content?.html_url||null});}catch(e){res.status(e.status===403?403:502).json({error:e.message,help:e.status===403?"Token GitHub memerlukan Contents: write untuk membuat atau mengubah file.":undefined});}
});
app.get("/api/github/html",auth,async(req,res)=>{
 const token=process.env.GITHUB_TOKEN;if(!token)return res.status(400).json({error:"GITHUB_TOKEN belum diatur"});
 const owner=String(req.query.owner||process.env.GITHUB_OWNER||"").trim(),repo=String(req.query.repo||process.env.GITHUB_REPO||"").trim(),headers={Authorization:"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"DevOps-AI"};
 if(!/^[A-Za-z0-9._-]+$/.test(owner)||!/^[A-Za-z0-9._-]+$/.test(repo))return res.status(400).json({error:"Owner dan nama repository tidak valid."});
 try{const meta=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,{headers});const md=await meta.json();if(!meta.ok)throw Object.assign(new Error(md.message||"Repository tidak ditemukan"),{status:meta.status});const tree=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(md.default_branch)}?recursive=1`,{headers});const td=await tree.json();if(!tree.ok)throw Object.assign(new Error(td.message||"Gagal membaca isi repository"),{status:tree.status});const item=(td.tree||[]).find(x=>x.type==="blob"&&/\.html?$/i.test(x.path)&&!/(node_modules|dist|build|vendor)\//i.test(x.path));if(!item)return res.status(404).json({error:"Tidak menemukan file HTML di repository tersebut."});const file=await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${item.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(md.default_branch)}`,{headers});const fd=await file.json();if(!file.ok)throw Object.assign(new Error(fd.message||"Gagal mengambil file HTML"),{status:file.status});const content=Buffer.from(fd.content||"","base64").toString("utf8").slice(0,500000);res.json({ok:true,owner,repo,branch:md.default_branch,path:item.path,content,url:fd.html_url});}catch(e){res.status(e.status===404?404:502).json({error:e.message});}
});
app.get("/api/render/services",auth,async(req,res)=>{
 const key=process.env.RENDER_API_KEY;if(!key)return res.status(400).json({error:"RENDER_API_KEY belum diatur"});
 try{const r=await fetch("https://api.render.com/v1/services?limit=20",{headers:{Authorization:"Bearer "+key,"Accept":"application/json"}});const d=await r.json();if(!r.ok)throw Error(d.message||"Render API error");res.json(d.map(x=>{const s=x.service||x;return{id:s.id,name:s.name,type:s.type,status:s.serviceDetails?.url?"active":"unknown",url:s.serviceDetails?.url||null};}));}catch(e){res.status(502).json({error:e.message});}
});
app.post("/api/render/deploy/:id",auth,async(req,res)=>{
 const key=process.env.RENDER_API_KEY;if(!key)return res.status(400).json({error:"RENDER_API_KEY belum diatur"});
 try{const r=await fetch(`https://api.render.com/v1/services/${encodeURIComponent(req.params.id)}/deploys`,{method:"POST",headers:{Authorization:"Bearer "+key,"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({clearCache:"do_not_clear"})});const d=await r.json();if(!r.ok)throw Error(d.message||"Render deploy error");res.json({ok:true,result:d});}catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/firebase/status",auth,(req,res)=>res.json({configured:!!process.env.FIREBASE_PROJECT_ID&&!!process.env.FIREBASE_TOKEN,projectId:process.env.FIREBASE_PROJECT_ID||null,message:process.env.FIREBASE_PROJECT_ID?"Project ID terisi; status hosting perlu diperiksa melalui Firebase CLI.":"FIREBASE_PROJECT_ID belum diatur."}));
app.post("/api/firebase/deploy",auth,async(req,res)=>{
 if(!process.env.FIREBASE_PROJECT_ID||!process.env.FIREBASE_TOKEN)return res.status(400).json({error:"Atur FIREBASE_PROJECT_ID dan FIREBASE_TOKEN terlebih dahulu."});
 try{const {stdout,stderr}=await execFileAsync("npx",["--yes","firebase-tools","deploy","--only","hosting","--project",process.env.FIREBASE_PROJECT_ID,"--token",process.env.FIREBASE_TOKEN],{cwd:__dirname,timeout:180000,maxBuffer:1024*1024});res.json({ok:true,stdout,stderr});}
 catch(e){res.status(502).json({error:"Deploy Firebase gagal.",details:(e.stderr||e.message||"").slice(0,3000)});}
});
function videoTime(sec){const ms=Math.max(0,Math.round(Number(sec||0)*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),z=ms%1000;return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(z).padStart(3,"0")}`;}
function srtFromSegments(segments){return segments.map((x,i)=>`${i+1}\n${videoTime(x.start)} --> ${videoTime(Math.max(Number(x.end||0),Number(x.start||0)+1))}\n${String(x.translation||x.text||"").trim()}\n`).join("\n");}
async function transcribeAudio(audioPath){
  const python=process.env.WHISPER_PYTHON||"python3";
  try{const {stdout}=await execFileAsync(python,[path.join(__dirname,"transcribe.py"),audioPath],{timeout:900000,maxBuffer:20*1024*1024});const result=JSON.parse(stdout);if(!Array.isArray(result.segments)||!result.segments.length)throw Error("Narasi tidak terdeteksi di video.");return result;}
  catch(e){throw Error(`Whisper gagal membaca suara: ${(e.stderr||e.message||"").slice(-1200)}`);}
}
async function transcribeWithManus(audioPath){const p=providers.manus,key=p.key();if(!key)throw Error("MANUS_API_KEY belum dikonfigurasi untuk transkripsi audio.");const data=fs.readFileSync(audioPath).toString("base64"),prompt=`Transkripsikan seluruh narasi dari audio ini dengan timestamp. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0,"end":3,"text":"teks asli"}]}. Jangan menerjemahkan dan jangan menambahkan penjelasan.`,base=p.base().replace(/\/$/,"");const r=await fetch(base+"/task.create",{method:"POST",headers:{"content-type":"application/json","x-manus-api-key":key},body:JSON.stringify({message:{content:[{type:"text",text:prompt},{type:"voice",file_data:`data:audio/mpeg;base64,${data}`,filename:"video-audio.mp3",mime_type:"audio/mpeg",visibility:"visible"}]},agent_profile:"lite",locale:"id"})}),created=await r.json();if(!r.ok)throw Error(created.error?.message||created.message||`Manus audio HTTP ${r.status}`);let result=created,text=manusText(result),taskId=created.task_id||created.taskId||created.task?.id;if(!text&&taskId){const deadline=Date.now()+90000;while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,2000));const poll=await fetch(base+"/task.listMessages?task_id="+encodeURIComponent(taskId)+"&order=desc&limit=30",{headers:{Accept:"application/json","x-manus-api-key":key}});result=await poll.json();const messages=result.messages||[];const assistant=messages.filter(x=>x?.type==="assistant_message"&&x.assistant_message?.content).flatMap(x=>{const c=x.assistant_message.content;if(typeof c==="string")return [c];if(Array.isArray(c))return c.map(y=>y?.text||y?.value||"");return [c?.text||c?.value||""];}).filter(Boolean);text=assistant.join("\n");if(text)break;}}if(!text)throw Error("Manus belum mengembalikan transkripsi audio.");const parsed=JSON.parse(text.replace(/^```json\s*|\s*```$/g,"").trim());if(!Array.isArray(parsed.segments)||!parsed.segments.length)throw Error("Manus tidak menemukan narasi.");return parsed;}
async function transcribeWithGemini(audioPath){const key=process.env.GEMINI_API_KEY;if(!key)throw Error("GEMINI_API_KEY belum dikonfigurasi untuk transkripsi cadangan.");const audio=fs.readFileSync(audioPath).toString("base64"),prompt=`Dengarkan audio ini dan buat transkripsi narasi ber-timestamp. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0,"end":3,"text":"teks asli"}]}. Jangan menambahkan penjelasan.`,models=[process.env.GEMINI_AUDIO_MODEL,"gemini-3.8-flash",process.env.GEMINI_MODEL].filter((x,i,a)=>x&&a.indexOf(x)===i);let lastError;for(const model of models){try{const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:"audio/mpeg",data:audio}}]}],generationConfig:{responseMimeType:"application/json",temperature:0.1}})}),d=await r.json();if(!r.ok)throw Error(d.error?.message||`Gemini audio HTTP ${r.status}`);const text=(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").replace(/^```json\s*|\s*```$/g,"").trim(),parsed=JSON.parse(text);if(Array.isArray(parsed.segments)&&parsed.segments.length)return parsed;}catch(e){lastError=e;}}throw lastError||Error("Transkripsi audio gagal.");}
async function translateTranscript(transcript,targetLanguage="id"){
  const language=targetLanguage==="en"?"English":targetLanguage==="auto"?"bahasa yang paling sesuai setelah mendeteksi bahasa narasi":"Bahasa Indonesia";
  const prompt=`Terjemahkan subtitle berikut ke ${language}. Buat juga judul singkat, deskripsi media sosial natural, dan 5 hashtag relevan. Pertahankan start dan end persis. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0,"end":3,"text":"teks asli","translation":"hasil terjemahan"}],"title":"judul","description":"deskripsi","hashtags":["#satu"]}. SUBTITLE ASLI: ${JSON.stringify(transcript.segments)}`;
  const order=configuredOrder(); let lastError;
  for(const name of order){
    try{const result=await callProvider(name,[{role:"user",content:prompt+"\nKembalikan JSON valid saja tanpa markdown."}]);const parsed=parseJsonAI(result.text);if(Array.isArray(parsed.segments)&&parsed.segments.length)return parsed;throw Error("Terjemahan subtitle kosong.");}
    catch(e){lastError=e;}
  }
  throw lastError||Error("Tidak ada provider AI yang tersedia untuk terjemahan subtitle.");
}
const subtitleStyles={clean:"FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=28",bold:"FontName=Arial,FontSize=24,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=1,MarginV=34",neon:"FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H00FFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=1,MarginV=32",cinema:"FontName=Georgia,FontSize=21,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=30",pink:"FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H00FFAAFF,OutlineColour=&H001B0617,BorderStyle=1,Outline=2,Shadow=1,MarginV=31",green:"FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H0000FFAA,OutlineColour=&H000B1A14,BorderStyle=1,Outline=2,Shadow=1,MarginV=31"};
const videoFormats={short:{label:"Short / Reels · 9:16",width:1080,height:1920},square:{label:"Square · 1:1",width:1080,height:1080},feed:{label:"Feed · 4:5",width:1080,height:1350},landscape:{label:"Landscape · 16:9",width:1920,height:1080}};
async function processVideoJob(jobId,inputPath,template="clean",targetLanguage="id",format="short",outputMode="original"){console.log(`[video-job:${jobId}] mulai format=${format} bahasa=${targetLanguage}`);const work=path.join(os.tmpdir(),`devops-video-${jobId}`);fs.mkdirSync(work,{recursive:true});const audioPath=path.join(work,"audio.mp3"),srtPath=path.join(videoOutputDir,`${jobId}.srt`),outputPath=path.join(videoOutputDir,`${jobId}-${format}-video.mp4`);try{setJobStatus(jobId,"extracting");console.log(`[video-job:${jobId}] extracting`);await execFileAsync(ffmpegPath,["-y","-i",inputPath,"-vn","-ac","1","-ar","16000","-b:a","64k",audioPath],{timeout:300000});setJobStatus(jobId,"translating");console.log(`[video-job:${jobId}] transcribing`);let transcript,lastError;
  const transcriptionSteps=[];
  if(process.env.MANUS_API_KEY) transcriptionSteps.push(()=>transcribeWithManus(audioPath));
  if(process.env.GEMINI_API_KEY) transcriptionSteps.push(()=>transcribeWithGemini(audioPath));
  if(process.env.ENABLE_LOCAL_WHISPER==="true") transcriptionSteps.push(()=>transcribeAudio(audioPath));
  for(const step of transcriptionSteps){try{transcript=await step();break;}catch(e){lastError=e;}}
  if(!transcript) throw Error(lastError?.message||"Transkripsi gagal. Atur MANUS_API_KEY atau GEMINI_API_KEY.");console.log(`[video-job:${jobId}] transcription ok`);setJobStatus(jobId,"translating");const analysis=await translateTranscript(transcript,targetLanguage),segments=analysis.segments;console.log(`[video-job:${jobId}] translation ok segments=${segments.length}`);fs.writeFileSync(srtPath,srtFromSegments(segments));videoJobs.get(jobId).subtitlePath=`${jobId}.srt`;if(outputMode==="burned"){setJobStatus(jobId,"rendering");const style=subtitleStyles[template]||subtitleStyles.clean,size=videoFormats[format]||videoFormats.short,filter=`scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1,subtitles=${srtPath}:force_style='${style}'`;await execFileAsync(ffmpegPath,["-y","-i",inputPath,"-vf",filter,"-c:a","copy","-c:v","libx264","-preset","veryfast","-crf","23",outputPath],{timeout:900000});}else{fs.copyFileSync(inputPath,outputPath);}videoJobs.get(jobId).outputPath=`${jobId}-${format}-video.mp4`;await uploadToSupabase(outputPath,videoJobs.get(jobId).outputPath,"video/mp4");await uploadToSupabase(srtPath,videoJobs.get(jobId).subtitlePath,"application/x-subrip");setJobStatus(jobId,"completed");console.log(`[video-job:${jobId}] completed output=${outputPath}`);videoJobs.get(jobId).result={video:`/api/video/jobs/${jobId}/download`,srt:`/api/video/jobs/${jobId}/srt`,segments:segments.length,template,targetLanguage,format,outputMode,title:analysis.title||"Video terbaru",description:analysis.description||"",hashtags:Array.isArray(analysis.hashtags)?analysis.hashtags:[]};persistJob(jobId);}catch(e){console.error(`[video-job:${jobId}] failed`,e.stack||e);setJobStatus(jobId,"failed");videoJobs.get(jobId).error=(e.stderr||e.message||"Pemrosesan video gagal").slice(-2000);persistJob(jobId);}finally{try{fs.rmSync(inputPath,{force:true});fs.rmSync(work,{recursive:true,force:true});}catch{}}}
app.post("/api/video/jobs",auth,(req,res)=>videoUpload.single("video")(req,res,async err=>{if(err)return res.status(400).json({error:err.message});if(!req.file)return res.status(400).json({error:"Unggah file video terlebih dahulu."});const id=crypto.randomBytes(8).toString("hex"),inputPath=req.file.path,template=String(req.body?.template||"clean"),targetLanguage=["id","en","auto"].includes(req.body?.language)?req.body.language:"id",format=Object.hasOwn(videoFormats,req.body?.format)?req.body.format:"short",outputMode="burned";videoJobs.set(id,{status:"queued",createdAt:Date.now(),name:req.file.originalname,template,targetLanguage,format,outputMode});persistJob(id);try{await createRemoteJob(id,videoJobs.get(id));}catch(e){console.error(`[video-job:${id}] supabase create failed`,e.message);}res.status(202).json({jobId:id,status:"queued",message:"Video diterima dan subtitle akan ditempelkan langsung."});processVideoJob(id,inputPath,template,targetLanguage,format,outputMode); }));
app.get("/api/video/jobs/:id",auth,async(req,res)=>{const job=restoreJob(req.params.id)||await restoreJobRemote(req.params.id);if(!job)return res.status(404).json({error:"Job video tidak ditemukan atau sudah kedaluwarsa."});res.json({jobId:req.params.id,...job});});
app.get("/api/video/jobs/:id/download",auth,async(req,res)=>{const job=restoreJob(req.params.id)||await restoreJobRemote(req.params.id);const format=job?.format||"short";const file=path.join(videoOutputDir,`${req.params.id}-${format}-video.mp4`);if(fs.existsSync(file))return res.download(file,"video-terjemahan-indonesia.mp4");if(!job?.outputPath||!supabaseEnabled)return res.status(404).json({error:"Video belum selesai."});try{const r=await fetch(`${SUPABASE_URL}/storage/v1/object/video-jobs/${job.outputPath}`,{headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}});if(!r.ok)return res.status(404).json({error:"Video hasil tidak tersedia."});res.setHeader("Content-Type",r.headers.get("content-type")||"video/mp4");res.setHeader("Content-Disposition","attachment; filename=video-terjemahan-indonesia.mp4");res.send(Buffer.from(await r.arrayBuffer()));}catch(e){res.status(502).json({error:"Gagal mengambil video hasil dari Supabase."});}});
app.get("/api/video/jobs/:id/srt",auth,async(req,res)=>{const job=restoreJob(req.params.id)||await restoreJobRemote(req.params.id);const file=path.join(videoOutputDir,`${req.params.id}.srt`);if(fs.existsSync(file))return res.download(file,"subtitle-indonesia.srt");if(!job?.subtitlePath||!supabaseEnabled)return res.status(404).json({error:"Subtitle belum tersedia."});try{const r=await fetch(`${SUPABASE_URL}/storage/v1/object/video-jobs/${job.subtitlePath}`,{headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}});if(!r.ok)return res.status(404).json({error:"Subtitle tidak tersedia."});res.setHeader("Content-Type","application/x-subrip");res.setHeader("Content-Disposition","attachment; filename=subtitle-indonesia.srt");res.send(Buffer.from(await r.arrayBuffer()));}catch(e){res.status(502).json({error:"Gagal mengambil subtitle dari Supabase."});}});
app.listen(PORT,()=>console.log(`DevOps AI berjalan di port ${PORT}`));
