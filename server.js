require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
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
const videoUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:200*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^video\//i.test(file.mimetype))});

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
  gemini: { key:()=>process.env.GEMINI_API_KEY || (process.env.AI_PROVIDER==="gemini"?process.env.AI_API_KEY:""), model:()=>process.env.GEMINI_MODEL || "gemini-3.8-flash" },
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
async function callProvider(name, messages){
  const p=providers[name]; const key=p.key();
  if(!key) throw Object.assign(new Error("API key "+name+" belum diatur"),{status:401,provider:name});
  const system="Kamu adalah DevOps AI yang membantu mengelola GitHub, Render, dan Firebase. Jawab dalam bahasa Indonesia. Jangan mengaku telah melakukan tindakan eksternal jika belum dilakukan melalui tool resmi. Jangan meminta pengguna membagikan secret/API key di chat. Jelaskan bahwa tindakan berisiko memerlukan konfirmasi.";
  if(name==="manus"){
    const prompt=[system,...messages.filter(m=>m.role!=="system").map(m=>`${m.role}: ${m.content}`)].join("\n\n");
    const profile=p.model().includes("max")?"max":p.model().includes("lite")?"lite":"standard";
    const r=await fetch(p.base().replace(/\/$/,"")+"/task.create",{method:"POST",headers:{"content-type":"application/json","x-manus-api-key":key},body:JSON.stringify({message:{content:[{type:"text",text:prompt}]},agent_profile:profile})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||data.error?.code||data.message||`Manus API HTTP ${r.status}`),{status:r.status,provider:name});
    let result=data; let text=manusText(result); const taskId=data.task_id||data.taskId||data.task?.id;
    if(!text && taskId){
      const taskUrl=p.base().replace(/\/$/,"")+"/task.listMessages?task_id="+encodeURIComponent(taskId)+"&order=desc&limit=20";
      const deadline=Date.now()+55000;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,1500));
        const poll=await fetch(taskUrl,{headers:{"Accept":"application/json","x-manus-api-key":key}}); result=await poll.json();
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
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:p.model(),max_tokens:1200,system,messages:messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:m.content}))})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||"Anthropic API error"),{status:r.status,provider:name});
    return {text:(data.content||[]).map(x=>x.text||"").join("\n"),provider:name,model:p.model()};
  }
  if(name==="gemini"){
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model())}:generateContent?key=${encodeURIComponent(key)}`;
    const contents=messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]}));
    const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents,generationConfig:{maxOutputTokens:1200}})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||"Gemini API error"),{status:r.status,provider:name});
    return {text:(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("\n"),provider:name,model:p.model()};
  }
  const base=name==="openai"?p.base():p.base();
  if(!base) throw Object.assign(new Error("AI_BASE_URL/COMPAT_BASE_URL belum diatur"),{status:400,provider:name});
  const url=base.endsWith("/chat/completions")?base:base.replace(/\/$/,"")+"/chat/completions";
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:JSON.stringify({model:p.model(),messages:[{role:"system",content:system},...messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:m.content}))],temperature:0.3})});
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
async function geminiVideoSegments(audioPath){const key=process.env.GEMINI_API_KEY;if(!key)throw Error("GEMINI_API_KEY belum dikonfigurasi untuk transkripsi video.");const audio=fs.readFileSync(audioPath).toString("base64"),model=process.env.GEMINI_MODEL||"gemini-3.8-flash",url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,prompt=`Dengarkan audio video ini. Buat transkripsi narasi dan terjemahkan ke Bahasa Indonesia. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0,"end":3,"text":"bahasa asli","translation":"Bahasa Indonesia"}]}. Gunakan detik untuk start dan end, pecah menjadi segmen pendek yang mengikuti waktu ucapan, jangan menambahkan penjelasan lain.`;const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:"audio/mpeg",data:audio}}]}],generationConfig:{responseMimeType:"application/json",temperature:0.1}})});const d=await r.json();if(!r.ok)throw Error(d.error?.message||`Gemini video HTTP ${r.status}`);const text=(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").replace(/^```json\s*|\s*```$/g,"").trim();const parsed=JSON.parse(text);if(!Array.isArray(parsed.segments)||!parsed.segments.length)throw Error("Narasi tidak terdeteksi di video.");return parsed.segments;}
const subtitleStyles={clean:"FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=28",bold:"FontName=Arial,FontSize=24,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=1,MarginV=34",neon:"FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H00FFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=1,MarginV=32",cinema:"FontName=Georgia,FontSize=21,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=30",pink:"FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H00FFAAFF,OutlineColour=&H001B0617,BorderStyle=1,Outline=2,Shadow=1,MarginV=31",green:"FontName=Arial,FontSize=21,Bold=1,PrimaryColour=&H0000FFAA,OutlineColour=&H000B1A14,BorderStyle=1,Outline=2,Shadow=1,MarginV=31"};
async function processVideoJob(jobId,inputPath,template="clean"){const work=path.join(os.tmpdir(),`devops-video-${jobId}`);fs.mkdirSync(work,{recursive:true});const audioPath=path.join(work,"audio.mp3"),srtPath=path.join(work,"translated-id.srt"),outputPath=path.join(videoOutputDir,`${jobId}-id-subtitle.mp4`);try{videoJobs.get(jobId).status="extracting";await execFileAsync(ffmpegPath,["-y","-i",inputPath,"-vn","-ac","1","-ar","16000","-b:a","64k",audioPath],{timeout:300000});videoJobs.get(jobId).status="translating";const segments=await geminiVideoSegments(audioPath);fs.writeFileSync(srtPath,srtFromSegments(segments));videoJobs.get(jobId).status="rendering";const style=subtitleStyles[template]||subtitleStyles.clean;await execFileAsync(ffmpegPath,["-y","-i",inputPath,"-vf",`subtitles=${srtPath}:force_style='${style}'`,"-c:a","copy","-c:v","libx264","-preset","veryfast","-crf","23",outputPath],{timeout:900000});videoJobs.get(jobId).status="completed";videoJobs.get(jobId).result={video:`/api/video/jobs/${jobId}/download`,srt:`/api/video/jobs/${jobId}/srt`,segments:segments.length,template};}catch(e){videoJobs.get(jobId).status="failed";videoJobs.get(jobId).error=(e.stderr||e.message||"Pemrosesan video gagal").slice(-2000);}finally{try{fs.rmSync(inputPath,{force:true});fs.rmSync(work,{recursive:true,force:true});}catch{}}}
app.post("/api/video/jobs",auth,(req,res)=>videoUpload.single("video")(req,res,async err=>{if(err)return res.status(400).json({error:err.message});if(!req.file)return res.status(400).json({error:"Unggah file video terlebih dahulu."});const id=crypto.randomBytes(8).toString("hex"),inputPath=path.join(os.tmpdir(),`devops-upload-${id}-${path.extname(req.file.originalname)||".mp4"}`),template=String(req.body?.template||"clean");fs.writeFileSync(inputPath,req.file.buffer);videoJobs.set(id,{status:"queued",createdAt:Date.now(),name:req.file.originalname,template});res.status(202).json({jobId:id,status:"queued",message:"Video diterima dan sedang diproses."});processVideoJob(id,inputPath,template); }));
app.get("/api/video/jobs/:id",auth,(req,res)=>{const job=videoJobs.get(req.params.id);if(!job)return res.status(404).json({error:"Job video tidak ditemukan atau sudah kedaluwarsa."});res.json({jobId:req.params.id,...job});});
app.get("/api/video/jobs/:id/download",auth,(req,res)=>{const file=path.join(videoOutputDir,`${req.params.id}-id-subtitle.mp4`);if(!fs.existsSync(file))return res.status(404).json({error:"Video belum selesai."});res.download(file,"video-terjemahan-indonesia.mp4");});
app.get("/api/video/jobs/:id/srt",auth,(req,res)=>{const file=path.join(os.tmpdir(),`devops-video-${req.params.id}`,"translated-id.srt");if(!fs.existsSync(file))return res.status(404).json({error:"Subtitle belum tersedia."});res.download(file,"subtitle-indonesia.srt");});
app.listen(PORT,()=>console.log(`DevOps AI berjalan di port ${PORT}`));
