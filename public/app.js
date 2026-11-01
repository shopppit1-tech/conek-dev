const $ = (selector) => document.querySelector(selector);
const cfg = window.SUPABASE_CONFIG;
const supabaseClient = window.supabase?.createClient(cfg?.url || "", cfg?.key || "");
let currentUser = null;
let selectedFile = null;
let activeJobId = null;
let pollTimer = null;
let elapsedTimer = null;
let startedAt = 0;
let signupMode = false;

function show(selector, visible = true) { $(selector)?.classList.toggle("hidden", !visible); }
function setAuthMessage(message = "", error = false) {
  const el = $("#authMessage");
  el.textContent = message;
  el.classList.toggle("is-error", error);
}
function setStatus(title, text) {
  $("#statusTitle").textContent = title;
  $("#statusText").textContent = text;
}
function setAuthMode(signup) {
  signupMode = signup;
  $("#authTitle").textContent = signup ? "Buat akun" : "Masuk dengan email";
  $("#authIntro").textContent = signup ? "Daftar menggunakan email dan kata sandi." : "Masuk untuk melanjutkan ke aplikasi.";
  $("#authSubmit").textContent = signup ? "Daftar" : "Masuk";
  $("#authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("#authPassword").minLength = signup ? 8 : 1;
  $("#authToggle").textContent = signup ? "Sudah punya akun? Masuk" : "Belum punya akun? Buat akun";
  setAuthMessage("");
}
function showApp() { show("#authScreen", false); show("#appContent", true); }
function showLogin(message = "") { show("#appContent", false); show("#authScreen", true); setAuthMessage(message); }

if (!supabaseClient) {
  showLogin("Konfigurasi Supabase belum dimuat. Muat ulang halaman atau hubungi pengelola.");
} else {
  setAuthMode(false);
  supabaseClient.auth.getSession().then(({ data, error }) => {
    if (error) return showLogin(error.message);
    currentUser = data.session?.user || null;
    currentUser ? showApp() : showLogin();
  });
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    currentUser ? showApp() : showLogin();
  });
}

$("#authToggle").addEventListener("click", () => setAuthMode(!signupMode));
$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) return;
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const submit = $("#authSubmit");
  submit.disabled = true;
  setAuthMessage(signupMode ? "Membuat akun…" : "Memeriksa login…");
  try {
    if (signupMode) {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: new URL("./", location.href).href }
      });
      if (error) throw error;
      if (data.session) {
        currentUser = data.session.user;
        showApp();
      } else {
        setAuthMode(false);
        $("#authEmail").value = email;
        setAuthMessage("Pendaftaran diterima. Periksa email untuk konfirmasi, lalu masuk.");
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentUser = data.user;
      showApp();
    }
  } catch (error) {
    setAuthMessage(error.message || "Login gagal. Coba lagi.", true);
  } finally {
    submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  showLogin("Anda sudah keluar.");
});

$("#video").addEventListener("change", (event) => selectFile(event.target.files?.[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (event) => selectFile(event.dataTransfer.files?.[0]));
function selectFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) return fail("File harus berupa video.");
  if (file.size > 100 * 1024 * 1024) return fail("Ukuran video maksimal 100 MB pada bucket Supabase saat ini.");
  selectedFile = file;
  $("#fileTitle").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · siap diunggah ke Supabase`;
  $("#start").disabled = false;
  show("#templates");
  show("#error", false);
  show("#result", false);
}

$("#start").addEventListener("click", async () => {
  if (!selectedFile || !currentUser || !supabaseClient) return;
  $("#start").disabled = true;
  show("#result", false);
  show("#error", false);
  show("#status");
  setStatus("Mengunggah video ke Supabase", "Video disimpan di bucket privat akun Anda…");
  startedAt = Date.now();
  elapsedTimer = setInterval(() => { $("#elapsed").textContent = `${Math.floor((Date.now() - startedAt) / 1000)} detik`; }, 1000);
  const jobId = crypto.randomUUID();
  const ext = (selectedFile.name.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4";
  const storagePath = `${currentUser.id}/${jobId}/input.${ext}`;
  try {
    const { error: uploadError } = await supabaseClient.storage.from("video-jobs").upload(storagePath, selectedFile, {
      contentType: selectedFile.type || "video/mp4",
      cacheControl: "3600",
      upsert: false
    });
    if (uploadError) throw uploadError;
    const { error: insertError } = await supabaseClient.from("video_jobs").insert({
      id: jobId,
      user_id: currentUser.id,
      status: "queued",
      original_filename: selectedFile.name,
      template: document.querySelector('input[name="template"]:checked')?.value || "clean",
      target_language: $("#language").value,
      format: $("#format").value,
      output_mode: "burned",
      input_path: storagePath,
      source_provider: "upload"
    });
    if (insertError) {
      await supabaseClient.storage.from("video-jobs").remove([storagePath]);
      throw insertError;
    }
    activeJobId = jobId;
    setStatus("Video masuk antrean Supabase", "Halaman ini akan memantau status job secara otomatis.");
    pollJob();
  } catch (error) {
    doneError(error.message || "Gagal mengunggah video ke Supabase.");
  }
});

document.querySelectorAll(".template input").forEach((input) => input.addEventListener("change", () => {
  document.querySelectorAll(".template").forEach((item) => item.classList.remove("selected"));
  input.closest(".template").classList.add("selected");
}));

async function pollJob() {
  if (!activeJobId || !currentUser || !supabaseClient) return;
  try {
    const { data, error } = await supabaseClient.from("video_jobs")
      .select("id,status,output_path,subtitle_path,segments,title,description,hashtags,error,target_language,format")
      .eq("id", activeJobId).single();
    if (error) throw error;
    const labels = {
      queued: ["Dalam antrean", "Video tersimpan di Supabase dan menunggu worker GitHub Actions…"],
      extracting: ["Membaca audio", "Worker sedang memisahkan narasi dari video…"],
      transcribing: ["Membaca narasi", "Worker sedang membuat transkrip…"],
      translating: ["Menerjemahkan narasi", "AI sedang membuat subtitle dan metadata…"],
      rendering: ["Menyusun video", "Subtitle sedang ditempelkan ke video…"]
    };
    if (labels[data.status]) {
      setStatus(...labels[data.status]);
      pollTimer = setTimeout(pollJob, 5000);
      return;
    }
    if (data.status === "failed") return doneError(data.error || "Pemrosesan video gagal.");
    if (data.status === "completed") {
      clearInterval(elapsedTimer);
      show("#status", false);
      show("#result");
      const { data: signed, error: signedError } = await supabaseClient.storage.from("video-jobs").createSignedUrl(data.output_path, 3600);
      if (signedError) throw signedError;
      $("#download").href = signed.signedUrl;
      $("#resultMeta").textContent = `${data.segments || 0} segmen · subtitle tertanam · ${data.target_language || "id"}`;
      $("#socialTitle").value = data.title || "Video terbaru";
      $("#socialDescription").value = data.description || "";
      $("#socialHashtags").value = Array.isArray(data.hashtags) ? data.hashtags.join(" ") : "";
      return;
    }
    pollTimer = setTimeout(pollJob, 5000);
  } catch (error) {
    doneError(error.message || "Tidak dapat membaca status job.");
  }
}
function fail(message) {
  $("#error").textContent = message;
  show("#error");
  $("#start").disabled = true;
}
function doneError(message) {
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
  show("#status", false);
  $("#error").textContent = message;
  show("#error");
  $("#start").disabled = false;
}
$("#reset").addEventListener("click", () => location.reload());
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const element = document.getElementById(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(element.value);
    const oldText = button.textContent;
    button.textContent = "Tersalin";
    setTimeout(() => { button.textContent = oldText; }, 1500);
  } catch { element.select(); document.execCommand("copy"); }
}));
