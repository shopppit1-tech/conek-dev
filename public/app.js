const $ = (s) => document.querySelector(s);
let file = null, job = null, timer = null;
const rawFetch = window.fetch.bind(window);
const SESSION_KEY = "conek_supabase_session";
let authConfig = { emailEnabled: false, appPasswordEnabled: false };
let signupMode = false;

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(session) {
  if (session?.access_token) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }
function show(id, on = true) { $(id).classList.toggle("hidden", !on); }
function setStatus(title, text) { $("#statusTitle").textContent = title; $("#statusText").textContent = text; }
function setAuthMessage(message, error = false) {
  const node = $("#authMessage");
  node.textContent = message || "";
  node.classList.toggle("is-error", error);
}
function showApp() { show("#authScreen", false); show("#appContent", true); }
function showLogin(message = "") { show("#appContent", false); show("#authScreen", true); setAuthMessage(message); }
function setAuthMode(signup) {
  signupMode = signup;
  $("#authTitle").textContent = signup ? "Buat akun" : "Masuk dengan email";
  $("#authIntro").textContent = signup ? "Daftar menggunakan email dan kata sandi." : "Masuk untuk melanjutkan ke aplikasi.";
  $("#authSubmit").textContent = signup ? "Daftar" : "Masuk";
  $("#authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("#authPassword").minLength = authConfig.emailEnabled && signup ? 8 : 1;
  $("#authToggle").textContent = signup ? "Sudah punya akun? Masuk" : "Belum punya akun? Buat akun";
  setAuthMessage("");
}

async function apiFetch(input, init = {}, retried = false) {
  const url = input instanceof Request ? input.url : String(input);
  const path = new URL(url, location.href).pathname;
  if (!path.startsWith("/api/") || /^\/api\/(login|logout|health|auth\/(config|signup|refresh|me))$/.test(path)) {
    return rawFetch(input, init);
  }
  const session = readSession();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  const response = await rawFetch(input, { ...init, headers });
  if (response.status !== 401 || retried || !session?.refresh_token || !authConfig.emailEnabled) return response;
  try {
    const refreshed = await rawFetch("/api/auth/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!refreshed.ok) throw new Error("refresh failed");
    const data = await refreshed.json();
    saveSession(data.session);
    return apiFetch(input, init, true);
  } catch {
    clearSession();
    showLogin("Sesi berakhir. Silakan masuk kembali.");
    return response;
  }
}
window.fetch = (input, init) => apiFetch(input, init || {});

function takeConfirmationSessionFromUrl() {
  if (!location.hash || !location.hash.includes("access_token=")) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get("access_token");
  if (!accessToken) return;
  saveSession({
    access_token: accessToken,
    refresh_token: params.get("refresh_token"),
    expires_at: params.get("expires_at") || null,
    token_type: params.get("token_type") || "bearer"
  });
  history.replaceState(null, "", location.pathname + location.search);
}

async function initAuth() {
  takeConfirmationSessionFromUrl();
  try {
    const configResponse = await rawFetch("/api/auth/config");
    authConfig = configResponse.ok ? await configResponse.json() : authConfig;
  } catch {}
  if (authConfig.emailEnabled) {
    $("#authEmailWrap").classList.remove("hidden");
    $("#authToggle").classList.remove("hidden");
    setAuthMode(false);
    const session = readSession();
    if (session?.access_token) {
      try {
        const response = await rawFetch("/api/auth/me", { headers: { Authorization: `Bearer ${session.access_token}` } });
        if (response.ok) return showApp();
      } catch {}
      clearSession();
    }
    showLogin();
    return;
  }
  if (authConfig.appPasswordEnabled) {
    $("#authEmailWrap").classList.add("hidden");
    $("#authToggle").classList.add("hidden");
    $("#authTitle").textContent = "Masuk";
    $("#authIntro").textContent = "Masukkan kata sandi aplikasi.";
    $("#authPassword").minLength = 1;
    showLogin();
    return;
  }
  $("#authEmailWrap").classList.add("hidden");
  $("#authToggle").classList.add("hidden");
  showLogin("Login belum dikonfigurasi di server. API aplikasi tetap terkunci sampai autentikasi diaktifkan.");
}

$("#authToggle").addEventListener("click", () => setAuthMode(!signupMode));
$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const endpoint = authConfig.emailEnabled ? (signupMode ? "/api/auth/signup" : "/api/login") : "/api/login";
  const body = authConfig.emailEnabled ? { email, password } : { password };
  $("#authSubmit").disabled = true;
  setAuthMessage(signupMode ? "Membuat akun…" : "Memeriksa login…");
  try {
    const response = await rawFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Permintaan login gagal.");
    if (data.requiresEmailConfirmation) {
      setAuthMode(false);
      $("#authEmail").value = email;
      setAuthMessage(data.message || "Periksa email untuk mengonfirmasi akun.");
      return;
    }
    if (data.session?.access_token) saveSession(data.session);
    showApp();
  } catch (error) {
    setAuthMessage(error.message || "Login gagal. Coba lagi.", true);
  } finally {
    $("#authSubmit").disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  const session = readSession();
  try {
    await rawFetch("/api/logout", {
      method: "POST", headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({})
    });
  } catch {}
  clearSession();
  showLogin("Anda sudah keluar.");
});

$("#video").addEventListener("change", (e) => selectFile(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((eventName) => drop.addEventListener(eventName, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((eventName) => drop.addEventListener(eventName, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));
function selectFile(f) {
  if (!f) return;
  if (!f.type.startsWith("video/")) return fail("File harus berupa video.");
  if (f.size > 200 * 1024 * 1024) return fail("Ukuran video maksimal 200 MB.");
  file = f;
  $("#fileTitle").textContent = f.name;
  $("#fileMeta").textContent = `${(f.size / 1024 / 1024).toFixed(1)} MB · siap diproses`;
  $("#start").disabled = false;
  show("#templates");
  show("#error", false);
  show("#result", false);
}
function fail(message) { $("#error").textContent = message; show("#error"); $("#start").disabled = true; }

$("#start").addEventListener("click", async () => {
  if (!file) return;
  $("#start").disabled = true;
  show("#result", false);
  show("#error", false);
  show("#status");
  setStatus("Mengunggah video", "Video sedang dikirim ke server…");
  const started = Date.now();
  timer = setInterval(() => $("#elapsed").textContent = `${Math.floor((Date.now() - started) / 1000)} detik`, 1000);
  try {
    const form = new FormData();
    form.append("video", file);
    form.append("template", document.querySelector('input[name="template"]:checked')?.value || "clean");
    form.append("language", $("#language").value);
    form.append("format", $("#format").value);
    const response = await fetch("/api/video/jobs", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gagal mengunggah video.");
    job = data.jobId;
    poll();
  } catch (error) { doneError(error.message); }
});

document.querySelectorAll(".template input").forEach((input) => input.addEventListener("change", () => {
  document.querySelectorAll(".template").forEach((item) => item.classList.remove("selected"));
  input.closest(".template").classList.add("selected");
}));

async function poll() {
  try {
    const response = await fetch(`/api/video/jobs/${job}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Status tidak tersedia.");
    const labels = {
      queued: ["Dalam antrean", "Video menunggu diproses…"],
      extracting: ["Membaca audio", "Memisahkan narasi dari video…"],
      translating: ["Menerjemahkan narasi", "AI membuat subtitle dan metadata…"],
      rendering: ["Menyusun video", "Subtitle sedang ditempelkan langsung ke video…"]
    };
    if (labels[data.status]) setStatus(...labels[data.status]);
    if (data.status === "completed") {
      clearInterval(timer);
      show("#status", false);
      show("#result");
      $("#download").href = data.result.video;
      $("#resultMeta").textContent = `${data.result.segments} segmen · subtitle tertanam · ${data.result.targetLanguage}`;
      $("#socialTitle").value = data.result.title || "";
      $("#socialDescription").value = data.result.description || "";
      $("#socialHashtags").value = (data.result.hashtags || []).join(" ");
      return;
    }
    if (data.status === "failed") return doneError(data.error || "Pemrosesan video gagal.");
    setTimeout(poll, 1500);
  } catch (error) { doneError(error.message); }
}
function doneError(message) {
  clearInterval(timer);
  show("#status", false);
  show("#error");
  $("#error").textContent = message;
  $("#start").disabled = false;
}
$("#reset").addEventListener("click", () => location.reload());
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const element = document.getElementById(button.dataset.copy);
  await navigator.clipboard.writeText(element.value);
  const oldText = button.textContent;
  button.textContent = "Tersalin";
  setTimeout(() => button.textContent = oldText, 1200);
}));

initAuth();
