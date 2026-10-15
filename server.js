require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
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
  gemini: { key:()=>process.env.GEMINI_API_KEY || (process.env.AI_PROVIDER==="gemini"?process.env.AI_API_KEY:""), model:()=>process.env.GEMINI_MODEL || "gemini-2.0-flash" },
  compatible: { key:()=>process.env.COMPAT_API_KEY || (process.env.AI_PROVIDER==="openai-compatible"?process.env.AI_API_KEY:""), model:()=>process.env.COMPAT_MODEL || process.env.AI_MODEL || "default", base:()=>process.env.COMPAT_BASE_URL || process.env.AI_BASE_URL },
  manus: { key:()=>process.env.MANUS_API_KEY || (process.env.AI_PROVIDER==="manus"?process.env.AI_API_KEY:""), model:()=>process.env.MANUS_MODEL || process.env.AI_MODEL || "manus-1.6-lite", base:()=>process.env.MANUS_BASE_URL || "https://api.manus.ai/v1/responses" }
};
function configuredOrder(){
  const primary=(process.env.AI_PROVIDER||"openai").toLowerCase();
  const raw=(process.env.AI_FALLBACK_ORDER||"openai,anthropic,gemini").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  const normalized=raw.map(x=>x==="openai-compatible"?"compatible":x);
  const normalizedPrimary=primary==="openai-compatible"?"compatible":primary;
  return [normalizedPrimary,...normalized].filter((x,i,a)=>providers[x]&&a.indexOf(x)===i&&providers[x].key());
}
async function callProvider(name, messages){
  const p=providers[name]; const key=p.key();
  if(!key) throw Object.assign(new Error("API key "+name+" belum diatur"),{status:401,provider:name});
  const system="Kamu adalah DevOps AI yang membantu mengelola GitHub, Render, dan Firebase. Jawab dalam bahasa Indonesia. Jangan mengaku telah melakukan tindakan eksternal jika belum dilakukan melalui tool resmi. Jangan meminta pengguna membagikan secret/API key di chat. Jelaskan bahwa tindakan berisiko memerlukan konfirmasi.";
  if(name==="manus"){
    const input=messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"assistant":"user",content:[{type:"input_text",text:m.content}]}));
    const r=await fetch(p.base(),{method:"POST",headers:{"content-type":"application/json","API_KEY":key},body:JSON.stringify({model:p.model(),instructions:system,input})});
    const data=await r.json(); if(!r.ok) throw Object.assign(new Error(data.error?.message||data.message||"Manus API error"),{status:r.status,provider:name});
    const text=data.output_text || (data.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||x.value||"").join("\n");
    return {text:text||"Manus tidak mengembalikan jawaban.",provider:name,model:p.model()};
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
app.listen(PORT,()=>console.log(`DevOps AI berjalan di port ${PORT}`));
