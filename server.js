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
    if (error || !user) throw error || new Error("Oturum gerekli");
    const { data: profile, error: pError } = await sb.from("profiles").select("*").eq("id", user.id).single();
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
    const displayName = String(req.body?.displayName || username)
      .trim()
      .slice(0, 80);

    if (!username || !email || password.length < 6) {
      return res.status(400).json({
        error: "Kullanıcı adı, e-posta ve en az 6 karakterlik şifre gerekli."
      });
    }

    if (!/^[a-z0-9._]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: "Kullanıcı adı 3-30 karakter olmalı; harf, sayı, nokta ve alt çizgi kullan."
      });
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "SUPABASE_SERVICE_ROLE_KEY eksik."
      });
    }

    const anon = client();

    // Kullanıcı adı daha önce alınmış mı?
    const { data: existing } = await anon
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: "Bu kullanıcı adı zaten alınmış."
      });
    }

    // Service Role ile Auth kullanıcısını oluştur.
    const admin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data: authData, error: authError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
        user_metadata: {
          username,
          display_name: displayName
        }
      });

    if (authError) {
      return res.status(400).json({
        error: authError.message
      });
    }

    const user = authData?.user;

    if (!user?.id) {
      return res.status(400).json({
        error: "Kullanıcı oluşturulamadı."
      });
    }

    // profiles.id kesinlikle auth.users.id ile aynı olacak.
    const { error: profileError } = await admin
      .from("profiles")
      .insert({
        id: user.id,
        username,
        display_name: displayName,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      });

    if (profileError) {
      // Profil oluşturulamazsa oluşturduğumuz Auth kullanıcısını da temizle.
      await admin.auth.admin.deleteUser(user.id);

      return res.status(500).json({
        error: `Profil oluşturulamadı: ${profileError.message}`
      });
    }

    return res.json({
      needsConfirmation: true,
      message:
        "Kayıt tamamlandı. E-posta adresine gönderilen doğrulama bağlantısını aç.",
      user: {
        id: user.id,
        email: user.email,
        username
      }
    });

  } catch (e) {
    console.error("REGISTER ERROR:", e);

    return res.status(500).json({
      error: e.message || "Kayıt başarısız."
    });
  }
});\n\napp.listen(PORT, "0.0.0.0", () => {\n  console.log(`Minegram server running on port ${PORT}`);\n});\n
