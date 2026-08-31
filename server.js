import "dotenv/config";
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;

// Render Environment Variables are injected directly into process.env.
// Support both the new Supabase publishable key and the legacy anon key.
function env(name) {
  const value = process.env[name];
  if (value == null) return "";
  return String(value).trim().replace(/^([\"\'])|([\"\'])$/g, "");
}

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_KEY = env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const BUCKET = "media";

const CONFIG_OK = Boolean(SUPABASE_URL && SUPABASE_KEY);
if (!CONFIG_OK) {
  console.error("Supabase ortam değişkenleri eksik: SUPABASE_URL ve SUPABASE_PUBLISHABLE_KEY (veya SUPABASE_ANON_KEY) gerekli.");
}

app.use(express.json({ limit: "2mb" }));

// HTML dosyalarini tarayicinin eski surumden acmasini engelle.
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

// Support both layouts: public/index.html and a root index.html.
const publicDir = path.join(__dirname, "public");
const rootIndex = path.join(__dirname, "index.html");
app.use(express.static(publicDir));
app.use(express.static(__dirname));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function client(token = null) {
  if (!CONFIG_OK) throw new Error("Supabase yapılandırması eksik. Render Environment Variables bölümünde SUPABASE_URL ve SUPABASE_PUBLISHABLE_KEY değerlerini kontrol et.");
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  if (token) options.global = { headers: { Authorization: `Bearer ${token}` } };
  return createClient(SUPABASE_URL, SUPABASE_KEY, options);
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function auth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) throw new Error("Oturum gerekli");
    const sb = client(token);
    const { data: { user }, error } = await sb.auth.getUser(token);
    console.log("TOKEN:", token);
    console.log("GET USER:", user?.id);
    console.log("ERROR:", error);
    if (error || !user) throw error || new Error("Oturum gerekli");
    // Eski Minegram profillerinde profil.id ile Supabase auth user.id
    // farkli olabilir. Login bunu zaten destekliyor; auth middleware de
    // ayni sekilde hem auth_user_id hem id ile bulmali.
    let { data: profile, error: pError } = await sb
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) {
      const fallback = await sb
        .from("profiles")
        .select("*")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      profile = fallback.data || null;
      pError = fallback.error || null;
    }

    if (pError || !profile) throw pError || new Error("Profil bulunamadı");
    req.token = token;
    req.sb = sb;
    req.authUser = user;
    req.user = profile;
    next();
  } catch (e) {
    res.status(401).json({ error: "Oturum gerekli" });
  }
}

function safeUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name ?? u.displayName ?? u.username,
    bio: u.bio || "",
    avatar: u.avatar_url ?? u.avatar ?? null,
    verified: !!u.verified,
    settings: u.settings || {}
  };
}

function normalizeUsername(x) {
  return String(x || "").trim().replace(/^@/, "").toLowerCase();
}

async function findProfile(sb, username) {
  const q = normalizeUsername(username);
  const { data, error } = await sb.from("profiles").select("*").eq("username", q).maybeSingle();
  if (error) throw error;
  return data;
}

async function addNotification({ userId, type, fromUserId, postId = null, text }) {
  if (userId === fromUserId) return;
  if (!SUPABASE_SERVICE_ROLE_KEY) return;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await admin.from("notifications").insert({ user_id: userId, type, from_user_id: fromUserId, post_id: postId, text });
}

async function hydratePosts(sb, posts, userId) {
  if (!posts.length) return [];
  const userIds = [...new Set(posts.map(p => p.user_id))];
  const postIds = posts.map(p => p.id);
  const [{ data: profiles }, { data: likes }, { data: comments }, { data: saves }] = await Promise.all([
    sb.from("profiles").select("id,username,display_name,bio,avatar_url,verified").in("id", userIds),
    sb.from("post_likes").select("post_id,user_id").in("post_id", postIds),
    sb.from("comments").select("id,post_id,user_id,text,created_at,profiles(username,display_name)").in("post_id", postIds).order("created_at", { ascending: true }),
    sb.from("saves").select("post_id,user_id").eq("user_id", userId).in("post_id", postIds)
  ]);
  const pmap = new Map((profiles || []).map(p => [p.id, p]));
  const likeMap = new Map();
  for (const l of likes || []) likeMap.set(l.post_id, (likeMap.get(l.post_id) || 0) + 1);
  const liked = new Set((likes || []).filter(x => x.user_id === userId).map(x => x.post_id));
  const saved = new Set((saves || []).map(x => x.post_id));
  const commentsMap = new Map();
  for (const c of comments || []) {
    if (!commentsMap.has(c.post_id)) commentsMap.set(c.post_id, []);
    commentsMap.get(c.post_id).push({ id: c.id, userId: c.user_id, text: c.text, createdAt: c.created_at, username: c.profiles?.username || "" });
  }
  return posts.map(p => ({
    id: p.id, userId: p.user_id, caption: p.caption, media: p.media_url, mediaName: p.media_name, mediaType: p.media_type,
    createdAt: p.created_at, likes: Array(likeMap.get(p.id) || 0).fill(null), comments: commentsMap.get(p.id) || [],
    likedByMe: liked.has(p.id), savedByMe: saved.has(p.id), user: safeUser(pmap.get(p.user_id) || { id: p.user_id, username: "user" })
  }));
}

app.post("/api/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || username).trim().slice(0, 80);
    if (!username || !email || password.length < 6) return res.status(400).json({ error: "Kullanıcı adı, e-posta ve en az 6 karakterlik şifre gerekli." });
    if (!/^[a-z0-9._]{3,30}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-30 karakter olmalı; harf, sayı, nokta ve alt çizgi kullan." });
    const anon = client();
    const { data: existing } = await anon.from("profiles").select("id").eq("username", username).maybeSingle();
    if (existing) return res.status(409).json({ error: "Bu kullanıcı adı zaten alınmış." });
    const { data, error } = await anon.auth.signUp({ email, password, options: { data: { username, display_name: displayName } } });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.user) return res.status(400).json({ error: "Kullanıcı oluşturulamadı." });

    // Profil oluşturmayı SQL trigger'ına bırakma; Service Role ile sunucu tarafında garanti et.
    if (SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { error: profileError } = await admin.from("profiles").upsert({
        id: data.user.id,
        username,
        display_name: displayName,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      }, { onConflict: "id" });
      if (profileError) return res.status(500).json({ error: `Profil oluşturulamadı: ${profileError.message}` });
    }

    // E-posta doğrulaması açıksa Supabase session döndürmeyebilir.
    if (!data.session) {
      return res.json({
        needsConfirmation: true,
        message: "Kayıt tamamlandı. E-posta adresini doğrula, ardından giriş yap.",
        user: { id: data.user.id, email: data.user.email, username }
      });
    }

    const sb = client(data.session.access_token);
    let { data: profile, error: pError } = await sb.from("profiles").select("*").eq("id", data.user.id).single();

    if ((pError || !profile) && SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const result = await admin.from("profiles").select("*").eq("id", data.user.id).single();
      profile = result.data;
      pError = result.error;
    }
    if (pError || !profile) return res.status(500).json({ error: "Profil oluşturulamadı." });
    res.json({ token: data.session.access_token, user: safeUser(profile) });
  } catch (e) { res.status(500).json({ error: e.message || "Kayıt başarısız" }); }
});

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik."
    );
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(req.body?.username ?? req.body?.email ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!identifier || !password) return res.status(400).json({ error: "Kullanıcı adı/e-posta ve şifre gerekli." });
    if (!CONFIG_OK) return res.status(500).json({ error: "Supabase ortam değişkenleri eksik." });
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "Giriş için SUPABASE_SERVICE_ROLE_KEY gerekli."
      });
    }

    const admin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    );

    let email = identifier.toLowerCase();
    if (!identifier.includes("@")) {
      const username = normalizeUsername(identifier);
      const { data: profile, error: pe } = await admin.from("profiles").select("*").eq("username", username).maybeSingle();
      if (pe) return res.status(500).json({ error: pe.message });
      if (!profile) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
      const authId = profile.auth_user_id || profile.id;
      const { data: au, error: ae } = await admin.auth.admin.getUserById(authId);
      if (ae || !au?.user?.email) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
      email = au.user.email.toLowerCase();
    }
    const anon = client();
    const { data: sd, error: le } = await anon.auth.signInWithPassword({ email, password });
    if (le || !sd?.session || !sd?.user) return res.status(401).json({ error: /invalid login credentials/i.test(le?.message || "") ? "Kullanıcı adı/e-posta veya şifre hatalı." : (le?.message || "Giriş başarısız.") });
    const authId = sd.user.id;
    const { data: profiles, error: pe2 } = await admin.from("profiles").select("*").eq("auth_user_id", authId).order("created_at", { ascending: true });
    if (pe2) return res.status(500).json({ error: pe2.message });
    let list = profiles || [];
    if (!list.length) { const { data: legacy } = await admin.from("profiles").select("*").eq("id", authId).maybeSingle(); if (legacy) list=[legacy]; }
    if (!list.length) return res.status(404).json({ error: "Bu hesap için Minegram profili bulunamadı." });
    const fn = typeof safeProfile === "function" ? safeProfile : safeUser;
    const safe = list.map(fn);
    const selected = identifier.includes("@") ? safe[0] : (safe.find(x => x.username === normalizeUsername(identifier)) || safe[0]);
    return res.json({ ok:true, multipleProfiles:safe.length>1, profiles:safe, profile:selected, token:sd.session.access_token, user:selected });
  } catch (e) { console.error("LOGIN ERROR:",e); return res.status(500).json({ error:e?.message || "Giriş başarısız." }); }
});

app.post("/api/forgot", async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim();
    const anon = client();
    let email = identifier;
    if (!identifier.includes("@")) {
      if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(200).json({ ok: true });
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const profile = await findProfile(anon, identifier);
      if (!profile) return res.status(200).json({ ok: true });
      const { data, error } = await admin.auth.admin.getUserById(profile.id);
      if (error || !data?.user?.email) return res.status(200).json({ ok: true });
      email = data.user.email;
    }
    const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo: `${req.protocol}://${req.get("host")}/` });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});


// Public auth configuration for the browser-side Supabase recovery flow.
app.get("/api/auth-config", (req, res) => {
  if (!CONFIG_OK) return res.status(500).json({ error: "Supabase yapılandırması eksik." });
  res.json({ url: SUPABASE_URL, key: SUPABASE_KEY });
});

const recoveryCodes = new Map();
function publicOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${String(proto).split(",")[0].trim()}://${req.get("host")}`;
}
function maskEmail(email) {
  const [u, d] = String(email).split("@");
  if (!u || !d) return email;
  const shown = u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.max(1, u.length - 2));
  return `${shown}@${d}`;
}
function normalizeRecoveryPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function findUserByPhone(phone) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const wanted = normalizeRecoveryPhone(phone);
  if (!wanted || wanted.length < 10) return null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find(u => normalizeRecoveryPhone(u.phone) === wanted);
    if (found) return found;
    if (users.length < 1000) break;
  }
  return null;
}

async function resolveRecoveryEmail(identifier, mode = "email") {
  const anon = client();
  const raw = String(identifier || "").trim();
  let email = raw;
  let profile = null;

  if (mode === "phone") {
    const authUser = await findUserByPhone(raw);
    if (!authUser?.email) return null;
    email = authUser.email;
    const { data } = await anon.from("profiles").select("id,username,email,display_name").eq("id", authUser.id).maybeSingle();
    profile = data || null;
    return { email, profile, authUser };
  }

  if (!email.includes("@")) {
    profile = await findProfile(anon, email);
    if (!profile) return null;
    if (!SUPABASE_SERVICE_ROLE_KEY) return null;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.getUserById(profile.id);
    if (error || !data?.user?.email) return null;
    email = data.user.email;
  }
  if (!profile) {
    const { data } = await anon.from("profiles").select("id,username,email,display_name").eq("email", email).maybeSingle();
    profile = data || null;
  }
  return { email, profile };
}
async function sendResendEmail(to, subject, html, text) {
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new Error("RESEND_API_KEY eksik.");
  const from = String(process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev").trim();
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "E-posta gönderilemedi.");
  return j;
}

app.post("/api/forgot/start", async (req, res) => {
  try {
    const found = await resolveRecoveryEmail(req.body?.identifier, req.body?.mode || "email");
    if (!found) return res.status(404).json({ error: "Hesap bulunamadı." });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    recoveryCodes.set(found.email.toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000, profile: found.profile });
    await sendResendEmail(
      found.email,
      "Minegram doğrulama kodun",
      `<div style="font-family:Arial,sans-serif"><h2>Minegram</h2><p>Şifre sıfırlama işlemin için doğrulama kodun:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</div><p>Bu kod 10 dakika geçerlidir.</p></div>`,
      `Minegram doğrulama kodun: ${code}\nBu kod 10 dakika geçerlidir.`
    );
    res.json({ ok: true, email: found.email, maskedEmail: maskEmail(found.email) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/forgot/verify", async (req, res) => {
  try {
    const found = await resolveRecoveryEmail(req.body?.identifier, req.body?.mode || "email");
    const entry = found && recoveryCodes.get(found.email.toLowerCase());
    if (!entry || entry.expires < Date.now() || entry.code !== String(req.body?.code || "").trim()) {
      return res.status(400).json({ error: "Kod yanlış veya süresi dolmuş." });
    }
    recoveryCodes.delete(found.email.toLowerCase());
    const p = entry.profile || found.profile || {};
    res.json({ ok: true, email: found.email, account: { username: p.username || "minegram", email: found.email, displayName: p.display_name || p.displayName || "" } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/forgot/send-reset", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!email) return res.status(400).json({ error: "E-posta gerekli." });
    const anon = client();
    const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo: `${publicOrigin(req)}/` });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, (req, res) => res.json(safeUser(req.user)));

app.get("/api/feed", auth, async (req, res) => {
  try {
    const { data, error } = await req.sb.from("posts").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json(await hydratePosts(req.sb, data || [], req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/posts", auth, upload.single("media"), async (req, res) => {
  try {
    let mediaUrl = null;
    let mediaName = null;
    let mediaType = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
      const objectPath = `${req.user.id}/${crypto.randomUUID()}${ext}`;
      const { error: uploadError } = await req.sb.storage.from(BUCKET).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) throw uploadError;
      const { data: publicData } = req.sb.storage.from(BUCKET).getPublicUrl(objectPath);
      mediaUrl = publicData.publicUrl;
      mediaName = req.file.originalname;
      mediaType = req.file.mimetype;
    }
    const { data, error } = await req.sb.from("posts").insert({ user_id: req.user.id, caption: req.body?.caption || "", media_url: mediaUrl, media_name: mediaName, media_type: mediaType }).select("*").single();
    if (error) throw error;
    res.json({ ...data, id: data.id, userId: data.user_id, media: data.media_url, mediaName: data.media_name, createdAt: data.created_at });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/stories", auth, upload.single("story"), async (req, res) => {
    try {

        console.log("=================================");
        console.log("REQ TOKEN:", req.token);
        console.log("REQ AUTH USER:", req.authUser.id);
        console.log("REQ PROFILE:", req.user.id);

        const authNow = await req.sb.auth.getUser();

        console.log("AUTH NOW:", authNow.data.user?.id);
        console.log("AUTH NOW ERROR:", authNow.error);
        console.log("=================================");

        if (!req.file)
            return res.status(400).json({ error: "Dosya seçilmedi" });

        const ext = path.extname(req.file.originalname);
        const objectPath = `stories/${req.user.id}/${crypto.randomUUID()}${ext}`;

        const { error: uploadError } =
            await req.sb.storage
                .from(BUCKET)
                .upload(objectPath, req.file.buffer, {
                    contentType: req.file.mimetype
                });

        if (uploadError) throw uploadError;

        const { data } =
            req.sb.storage
                .from(BUCKET)
                .getPublicUrl(objectPath);

        const result = await req.sb
            .from("stories")
            .insert({
                user_id: req.user.id,
                media_url: data.publicUrl,
                media_type: req.file.mimetype
            })
            .select()
            .single();

        console.log("RESULT:", JSON.stringify(result, null, 2));

        if (result.error)
            return res.status(400).json(result.error);

        res.json(result.data);

    } catch (e) {
        console.error("STORY ERROR:", e);
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/posts/:id/like", auth, async (req, res) => {
  try {
    const { data: existing } = await req.sb.from("post_likes").select("post_id").eq("post_id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (existing) {
      await req.sb.from("post_likes").delete().eq("post_id", req.params.id).eq("user_id", req.user.id);
      return res.json({ liked: false });
    }
    const { error } = await req.sb.from("post_likes").insert({ post_id: req.params.id, user_id: req.user.id });
    if (error) throw error;
    const { data: post } = await req.sb.from("posts").select("user_id").eq("id", req.params.id).single();
    if (post) await addNotification({ userId: post.user_id, fromUserId: req.user.id, type: "like", postId: req.params.id, text: `@${req.user.username} beğendi` });
    res.json({ liked: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/stories", auth, async (req, res) => {

    const yesterday =
        new Date(Date.now() - 86400000).toISOString();

    const { data, error } =
        await req.sb
            .from("stories")
            .select(`
                *,
                profiles(
                    username,
                    display_name,
                    avatar_url
                )
            `)
            .gte("created_at", yesterday)
            .order("created_at");

    if (error)
        return res.status(400).json(error);

    res.json(data);

});

app.post("/api/posts/:id/comments", auth, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Yorum boş olamaz" });
    const { data, error } = await req.sb.from("comments").insert({ post_id: req.params.id, user_id: req.user.id, text }).select("*").single();
    if (error) throw error;
    const { data: post } = await req.sb.from("posts").select("user_id").eq("id", req.params.id).single();
    if (post) await addNotification({ userId: post.user_id, fromUserId: req.user.id, type: "comment", postId: req.params.id, text: `@${req.user.username} yorum yaptı` });
    res.json({ id: data.id, userId: data.user_id, text: data.text, createdAt: data.created_at, username: req.user.username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/posts/:id/save", auth, async (req, res) => {
  try {
    const { data: existing } = await req.sb.from("saves").select("post_id").eq("post_id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (existing) { await req.sb.from("saves").delete().eq("post_id", req.params.id).eq("user_id", req.user.id); return res.json({ saved: false }); }
    const { error } = await req.sb.from("saves").insert({ post_id: req.params.id, user_id: req.user.id });
    if (error) throw error;
    res.json({ saved: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/saved", auth, async (req, res) => {
  try {
    const { data: saves, error } = await req.sb.from("saves").select("post_id,created_at").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    const ids = (saves || []).map(x => x.post_id);
    if (!ids.length) return res.json([]);
    const { data: posts, error: pError } = await req.sb.from("posts").select("*").in("id", ids);
    if (pError) throw pError;
    const hydrated = await hydratePosts(req.sb, posts || [], req.user.id);
    res.json(hydrated.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/notifications", auth, async (req, res) => {
  try {
    const { data, error } = await req.sb.from("notifications").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data || []).map(n => ({ id:n.id, type:n.type, text:n.text, read:n.read, createdAt:n.created_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/notifications/read", auth, async (req, res) => {
  try { await req.sb.from("notifications").update({ read:true }).eq("user_id", req.user.id); res.json({ok:true}); }
  catch(e){ res.status(400).json({error:e.message}); }
});

app.post("/api/users/:username/follow", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    if (target.id === req.user.id) return res.status(400).json({ error: "Kendini takip edemezsin" });
    const { data: existing } = await req.sb.from("follows").select("follower_id,following_id").eq("follower_id", req.user.id).eq("following_id", target.id).maybeSingle();
    if (existing) { await req.sb.from("follows").delete().eq("follower_id", req.user.id).eq("following_id", target.id); return res.json({ following:false }); }
    const { error } = await req.sb.from("follows").insert({ follower_id:req.user.id, following_id:target.id });
    if (error) throw error;
    await addNotification({ userId:target.id, fromUserId:req.user.id, type:"follow", text:`@${req.user.username} seni takip etti` });
    res.json({ following:true });
  } catch(e){ res.status(400).json({error:e.message}); }
});

app.get("/api/users/:username/posts", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({error:"Kullanıcı bulunamadı"});
    const { data, error } = await req.sb.from("posts").select("*").eq("user_id", target.id).order("created_at", { ascending:false });
    if(error) throw error;
    res.json(await hydratePosts(req.sb, data || [], req.user.id));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/users/:username", auth, async (req,res)=>{
  try{
    const target = await findProfile(req.sb, req.params.username);
    if(!target) return res.status(404).json({error:"Kullanıcı bulunamadı"});
    const [{ count:postCount }, { count:followers }, { count:following }, { data:followingByMe }] = await Promise.all([
      req.sb.from("posts").select("id", {count:"exact", head:true}).eq("user_id", target.id),
      req.sb.from("follows").select("follower_id", {count:"exact", head:true}).eq("following_id", target.id),
      req.sb.from("follows").select("following_id", {count:"exact", head:true}).eq("follower_id", target.id),
      req.sb.from("follows").select("follower_id").eq("follower_id", req.user.id).eq("following_id", target.id).maybeSingle()
    ]);
    res.json({...safeUser(target), postCount:postCount||0, followers:followers||0, following:following||0, followingByMe:!!followingByMe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/search", auth, async (req,res)=>{
  try{
    const q=String(req.query.q||"").trim().toLowerCase();
    if(!q) return res.json([]);
    const {data,error}=await req.sb.from("profiles").select("id,username,display_name,bio,avatar_url,verified").or(`username.ilike.%${q}%,display_name.ilike.%${q}%`).limit(20);
    if(error) throw error; res.json((data||[]).map(safeUser));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/messages", auth, async (req,res)=>{
  try{
    const {data,error}=await req.sb.from("messages").select("*,profiles:sender_id(username,display_name)").or(`sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`).order("created_at",{ascending:true});
    if(error) throw error;
    res.json((data||[]).map(m=>({id:m.id,from:m.sender_id,to:m.recipient_id,text:m.text,createdAt:m.created_at,username:m.profiles?.username||""})));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/messages", auth, async (req,res)=>{
  try{
    const target=await findProfile(req.sb,req.body?.to);
    const text=String(req.body?.text||"").trim();
    if(!target)return res.status(404).json({error:"Kullanıcı bulunamadı"});
    if(!text)return res.status(400).json({error:"Mesaj boş olamaz"});
    const {data,error}=await req.sb.from("messages").insert({sender_id:req.user.id,recipient_id:target.id,text}).select("*").single();
    if(error) throw error;
    res.json({id:data.id,from:data.sender_id,to:data.recipient_id,text:data.text,createdAt:data.created_at});
  }catch(e){res.status(400).json({error:e.message});}
});

app.patch("/api/me", auth, async (req,res)=>{
  try{
    const patch={};
    if(req.body?.displayName!==undefined) patch.display_name=String(req.body.displayName).slice(0,80);
    if(req.body?.bio!==undefined) patch.bio=String(req.body.bio).slice(0,300);
    if(Object.keys(patch).length){ const {error}=await req.sb.from("profiles").update(patch).eq("id",req.user.id); if(error) throw error; }
    const {data,error}=await req.sb.from("profiles").select("*").eq("id",req.user.id).single(); if(error) throw error;
    res.json(safeUser(data));
  }catch(e){res.status(400).json({error:e.message});}
});

app.patch("/api/settings", auth, async (req,res)=>{
  try{
    const next={...(req.user.settings||{}),...(req.body||{})};
    const {error}=await req.sb.from("profiles").update({settings:next}).eq("id",req.user.id); if(error) throw error;
    res.json(next);
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/mesaj", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "mesaj.html"));
});

app.use((req, res) => {
  // Prefer public/index.html when it exists; otherwise serve root index.html.
  const indexPath = fs.existsSync(path.join(publicDir, "index.html"))
    ? path.join(publicDir, "giris.html")
    : rootIndex;
  res.sendFile(indexPath);
});
app.listen(PORT,()=>console.log(`Minegram: http://localhost:${PORT}`));
