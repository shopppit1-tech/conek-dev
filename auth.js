const SUPABASE_URL = (process.env.SUPABASE_URL || "https://cnjssbqdmgfnvdtsudwx.supabase.co").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_URL = (process.env.APP_URL || "https://conek-dev.onrender.com").replace(/\/$/, "");
const passwordSessions = new Map();
const validatedTokens = new Map();

function authSettings() {
  return { emailEnabled: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), appPasswordEnabled: Boolean(APP_PASSWORD) };
}

function bearerToken(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function sessionResult(data) {
  return {
    ok: true,
    session: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : null),
      token_type: data.token_type || "bearer"
    },
    user: data.user ? { id: data.user.id, email: data.user.email } : null
  };
}

async function supabaseAuth(path, { method = "GET", body, token } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function authError(data, fallback) {
  return String(data?.msg || data?.message || data?.error_description || data?.error || fallback).slice(0, 240);
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (authSettings().emailEnabled && email) {
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || password.length < 1) {
      return res.status(400).json({ error: "Email dan kata sandi wajib diisi." });
    }
    try {
      const { response, data } = await supabaseAuth("token?grant_type=password", {
        method: "POST", body: { email: email.trim(), password }
      });
      if (!response.ok || !data.access_token) return res.status(response.status === 429 ? 429 : 401).json({ error: authError(data, "Email atau kata sandi tidak cocok.") });
      return res.json(sessionResult(data));
    } catch (error) {
      return res.status(502).json({ error: "Tidak dapat menghubungi layanan login Supabase." });
    }
  }
  if (APP_PASSWORD && typeof password === "string" && password === APP_PASSWORD) {
    const token = require("crypto").randomBytes(32).toString("hex");
    passwordSessions.set(token, Date.now());
    return res.json({ ok: true, legacy: true, session: { access_token: token }, user: { email: null } });
  }
  if (!authSettings().emailEnabled && !APP_PASSWORD) return res.status(503).json({ error: "Login belum dikonfigurasi. Hubungi administrator aplikasi." });
  return res.status(401).json({ error: "Email atau kata sandi tidak cocok." });
}

async function signup(req, res) {
  if (!authSettings().emailEnabled) return res.status(503).json({ error: "Login email belum dikonfigurasi pada server." });
  const { email, password } = req.body || {};
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: "Masukkan alamat email yang valid." });
  if (typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "Kata sandi minimal 8 karakter." });
  try {
    const redirectTo = encodeURIComponent(`${APP_URL}/`);
    const { response, data } = await supabaseAuth(`signup?redirect_to=${redirectTo}`, {
      method: "POST", body: { email: email.trim(), password }
    });
    if (!response.ok) return res.status(response.status === 429 ? 429 : 400).json({ error: authError(data, "Pendaftaran email gagal.") });
    if (data.access_token) return res.json(sessionResult(data));
    return res.json({ ok: true, requiresEmailConfirmation: true, message: "Akun dibuat. Buka email untuk mengonfirmasi alamat sebelum masuk." });
  } catch (error) {
    return res.status(502).json({ error: "Tidak dapat menghubungi layanan pendaftaran Supabase." });
  }
}

async function refresh(req, res) {
  if (!authSettings().emailEnabled) return res.status(503).json({ error: "Login email belum dikonfigurasi." });
  const refreshToken = req.body?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) return res.status(400).json({ error: "Sesi perlu login ulang." });
  try {
    const { response, data } = await supabaseAuth("token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refreshToken } });
    if (!response.ok || !data.access_token) return res.status(401).json({ error: "Sesi berakhir. Silakan masuk kembali." });
    return res.json(sessionResult(data));
  } catch (error) {
    return res.status(502).json({ error: "Tidak dapat memperbarui sesi Supabase." });
  }
}

async function logout(req, res) {
  const token = bearerToken(req) || String(req.body?.access_token || "");
  if (authSettings().emailEnabled && token) {
    try { await supabaseAuth("logout?scope=local", { method: "POST", token }); } catch {}
  }
  if (token) passwordSessions.delete(token);
  return res.json({ ok: true });
}

async function userForToken(token) {
  const cached = validatedTokens.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;
  try {
    const { response, data } = await supabaseAuth("user", { token });
    if (!response.ok || !data?.id) return null;
    validatedTokens.set(token, { user: { id: data.id, email: data.email }, expires: Date.now() + 20000 });
    return { id: data.id, email: data.email };
  } catch {
    return null;
  }
}

async function currentUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  if (authSettings().emailEnabled) return userForToken(token);
  if (APP_PASSWORD && passwordSessions.has(token)) return { email: null };
  return null;
}

async function auth(req, res, next) {
  const token = bearerToken(req);
  if (!authSettings().emailEnabled && !APP_PASSWORD) return res.status(503).json({ error: "Autentikasi belum dikonfigurasi; akses API ditolak." });
  if (!token) return res.status(401).json({ error: "Silakan masuk dengan email terlebih dahulu." });
  if (authSettings().emailEnabled) {
    const user = await userForToken(token);
    if (!user) return res.status(401).json({ error: "Sesi tidak valid atau sudah berakhir. Silakan masuk kembali." });
    req.authUser = user;
    return next();
  }
  if (!passwordSessions.has(token)) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
  return next();
}

module.exports = { auth, login, signup, refresh, logout, currentUser, authSettings };
