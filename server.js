import "dotenv/config";
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1);

const PORT = Number(process.env.PORT) || 3000;

function env(name) {
  const value = process.env[name];

  if (value == null) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/^(["'])|(["'])$/g, "");
}

const SUPABASE_URL = env("SUPABASE_URL");

const SUPABASE_KEY =
  env("SUPABASE_PUBLISHABLE_KEY") ||
  env("SUPABASE_ANON_KEY");

const SUPABASE_SERVICE_ROLE_KEY =
  env("SUPABASE_SERVICE_ROLE_KEY");

const BUCKET = "media";

const CONFIG_OK = Boolean(
  SUPABASE_URL && SUPABASE_KEY
);

if (!CONFIG_OK) {
  console.error(
    "Supabase ortam değişkenleri eksik: SUPABASE_URL ve SUPABASE_PUBLISHABLE_KEY veya SUPABASE_ANON_KEY gerekli."
  );
}

app.use(
  express.json({
    limit: "2mb"
  })
);

const publicDir = path.join(__dirname, "public");
const rootIndex = path.join(__dirname, "giris.html");

app.use((req, res, next) => {
  if (
    req.path.endsWith(".html") ||
    req.path === "/"
  ) {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }

  next();
});

app.use(express.static(publicDir));
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

function client(token = null) {
  if (!CONFIG_OK) {
    throw new Error(
      "Supabase yapılandırması eksik. Render Environment Variables bölümünde SUPABASE_URL ve SUPABASE_PUBLISHABLE_KEY değerlerini kontrol et."
    );
  }

  const options = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  };

  if (token) {
    options.global = {
      headers: {
        Authorization: `Bearer ${token}`
      }
    };
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    options
  );
}

function adminClient() {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
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
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}

function bearer(req) {
  const h =
    req.headers.authorization || "";

  return h.startsWith("Bearer ")
    ? h.slice(7)
    : null;
}

async function isUserBlockedBy(blockerId, blockedId) {
  if (!blockerId || !blockedId || String(blockerId) === String(blockedId)) return false;
  const admin = adminClient();
  const { data, error } = await admin
    .from("blocks")
    .select("blocker_id,blocked_id")
    .eq("blocker_id", blockerId)
    .eq("blocked_id", blockedId)
    .limit(1);
  if (error) {
    // Tablo henüz oluşturulmadıysa mevcut sunucunun diğer özellikleri çalışmaya devam etsin.
    if (String(error.code || "") === "42P01") return false;
    throw error;
  }
  return Array.isArray(data) && data.length > 0;
}

async function isBlockedEitherWay(userA, userB) {
  if (!userA || !userB || String(userA) === String(userB)) return false;
  const admin = adminClient();
  const { data, error } = await admin
    .from("blocks")
    .select("blocker_id,blocked_id")
    .or(`and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`)
    .limit(1);
  if (error) {
    if (String(error.code || "") === "42P01") return false;
    throw error;
  }
  return Array.isArray(data) && data.length > 0;
}

async function blockedUserIdsFor(viewerId) {
  if (!viewerId) return new Set();
  const admin = adminClient();
  const { data, error } = await admin
    .from("blocks")
    .select("blocker_id,blocked_id")
    .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`);
  if (error) {
    if (String(error.code || "") === "42P01") return new Set();
    throw error;
  }
  const ids = new Set();
  for (const row of data || []) {
    if (String(row.blocker_id) === String(viewerId)) ids.add(String(row.blocked_id));
    if (String(row.blocked_id) === String(viewerId)) ids.add(String(row.blocker_id));
  }
  return ids;
}

async function auth(req, res, next) {
  try {
    const token = bearer(req);

    if (!token) {
      throw new Error("Oturum gerekli");
    }

    const sb = client(token);

    const {
      data: {
        user
      },
      error
    } = await sb.auth.getUser(token);

    if (error || !user) {
      throw error || new Error("Oturum gerekli");
    }

    let {
      data: profile,
      error: pError
    } = await sb
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) {
      const fallback =
        await sb
          .from("profiles")
          .select("*")
          .eq("auth_user_id", user.id)
          .maybeSingle();

      profile =
        fallback.data || null;

      pError =
        fallback.error || null;
    }

    if (pError || !profile) {
      throw (
        pError ||
        new Error("Profil bulunamadı")
      );
    }

    req.token = token;
    req.sb = sb;
    req.authUser = user;
    req.user = profile;

    next();
  } catch (e) {
    console.error(
      "AUTH ERROR:",
      e?.message || e
    );

    res.status(401).json({
      error: "Oturum gerekli"
    });
  }
}

function safeUser(u) {
  if (!u) {
    return {
      id: null,
      username: "user",
      displayName: "user",
      bio: "",
      avatar: null,
      verified: false,
      settings: {}
    };
  }

  return {
    id: u.id,
    username: u.username,
    displayName:
      u.display_name ??
      u.displayName ??
      u.username,
    bio: u.bio || "",
    avatar:
      u.avatar_url ??
      u.avatar ??
      null,
    verified: !!u.verified,
    settings: u.settings || {}
  };
}

function safeProfile(u) {
  return safeUser(u);
}

function normalizeUsername(x) {
  return String(x || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

const activeAuthUserCache = new Map();
const ACTIVE_AUTH_CACHE_MS = 30000;

async function isAuthUserActive(userId) {
  const key = String(userId || "").trim();
  if (!key || !SUPABASE_SERVICE_ROLE_KEY) return false;

  try {
    const admin = adminClient();
    const { data, error } = await admin.auth.admin.getUserById(key);
    return !error && !!data?.user?.id;
  } catch (e) {
    console.error("ACTIVE USER CHECK ERROR:", e?.message || e);
    return false;
  }
}

async function isAuthUserActiveCached(userId) {
  const key = String(userId || "").trim();
  if (!key) return false;

  const cached = activeAuthUserCache.get(key);
  if (cached && (Date.now() - cached.at) < ACTIVE_AUTH_CACHE_MS) {
    return cached.active;
  }

  const active = await isAuthUserActive(key);
  activeAuthUserCache.set(key, { active, at: Date.now() });
  return active;
}

/*
 * Legacy Minegram kayıtlarında posts/stories/profiles.user_id bazen
 * profiles.id, bazen Auth user id olabiliyor. Önce iki kimliği eşleştir,
 * sonra gerçek Auth hesabının hâlâ var olduğunu kontrol et.
 */
async function buildProfileAuthMap(ownerIds) {
  const ids = [...new Set(
    (ownerIds || []).map(v => String(v || "").trim()).filter(Boolean)
  )];
  if (!ids.length) return new Map();

  const admin = adminClient();
  const safeIds = ids.filter(v => /^[0-9a-fA-F-]{8,}$/.test(v));
  if (!safeIds.length) return new Map();

  const { data, error } = await admin
    .from("profiles")
    .select("id,auth_user_id")
    .or(`id.in.(${safeIds.join(",")}),auth_user_id.in.(${safeIds.join(",")})`);

  if (error) {
    console.warn("PROFILE/AUTH MAP ERROR:", error.message || error);
    return new Map();
  }

  const map = new Map();
  for (const profile of data || []) {
    const profileId = String(profile?.id || "").trim();
    const authId = String(profile?.auth_user_id || "").trim();
    if (profileId) map.set(profileId, authId || profileId);
    if (authId) map.set(authId, authId);
  }
  return map;
}

async function filterActivePosts(posts) {
  if (!Array.isArray(posts) || !posts.length) return [];

  const ownerIds = [...new Set(
    posts.map(p => String(p?.user_id || "").trim()).filter(Boolean)
  )];
  const ownerToAuth = await buildProfileAuthMap(ownerIds);

  const authIds = [...new Set(
    ownerIds.map(id => ownerToAuth.get(id) || id).filter(Boolean)
  )];
  const activeAuthIds = new Set();

  await Promise.all(authIds.map(async authId => {
    if (await isAuthUserActiveCached(authId)) activeAuthIds.add(authId);
  }));

  return posts.filter(post => {
    const ownerId = String(post?.user_id || "").trim();
    const authId = ownerToAuth.get(ownerId) || ownerId;
    return activeAuthIds.has(authId);
  });
}

async function filterActiveStories(stories) {
  if (!Array.isArray(stories) || !stories.length) return [];

  const ownerIds = [...new Set(
    stories.map(s => String(s?.user_id || "").trim()).filter(Boolean)
  )];
  const ownerToAuth = await buildProfileAuthMap(ownerIds);
  const authIds = [...new Set(
    ownerIds.map(id => ownerToAuth.get(id) || id).filter(Boolean)
  )];
  const activeAuthIds = new Set();

  await Promise.all(authIds.map(async authId => {
    if (await isAuthUserActiveCached(authId)) activeAuthIds.add(authId);
  }));

  return stories.filter(story => {
    const ownerId = String(story?.user_id || "").trim();
    const authId = ownerToAuth.get(ownerId) || ownerId;
    return activeAuthIds.has(authId);
  });
}

async function filterActiveProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) return [];

  const ownerIds = profiles.flatMap(profile => [
    profile?.id,
    profile?.auth_user_id
  ]).map(v => String(v || "").trim()).filter(Boolean);

  const ownerToAuth = await buildProfileAuthMap(ownerIds);
  const active = [];

  await Promise.all((profiles || []).map(async profile => {
    const profileId = String(profile?.id || "").trim();
    const authId = String(profile?.auth_user_id || "").trim()
      || ownerToAuth.get(profileId)
      || profileId;

    if (authId && await isAuthUserActiveCached(authId)) {
      active.push(profile);
    }
  }));

  return active;
}

async function findProfile(
  sb,
  username
) {
  const q =
    normalizeUsername(username);

  const {
    data,
    error
  } = await sb
    .from("profiles")
    .select("*")
    .eq("username", q)
    .maybeSingle();

  if (error) {
    throw error;
  }

  // profiles tablosunda eski hesap kaydı kalmış olsa bile,
  // Supabase Auth hesabı silinmişse bu profil artık sitede görünmemeli.
  if (!data) return null;

  const authId = data.auth_user_id || data.id;
  if (!authId || !(await isAuthUserActive(authId))) {
    return null;
  }

  return data;
}

async function addNotification({
  userId,
  type,
  fromUserId,
  postId = null,
  text
}) {
  if (userId === fromUserId) {
    return;
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }

  const admin =
    adminClient();

  await admin
    .from("notifications")
    .insert({
      user_id: userId,
      type,
      from_user_id: fromUserId,
      post_id: postId,
      text
    });
}


// Aktif canlı yayınlar sunucu belleğinde tutulur. Böylece aynı anda bağlı diğer
// cihazlar canlı yayını keşfedebilir. Sunucu yeniden başlarsa aktif yayınlar sıfırlanır.
const activeMinegramLives = new Map();

async function hydratePosts(
  sb,
  posts,
  userId
) {
  if (!posts.length) {
    return [];
  }

  const userIds = [
    ...new Set(
      posts.map(
        p => p.user_id
      )
    )
  ];

  const postIds =
    posts.map(p => p.id);

  const [
    profilesResult,
    likesResult,
    commentsResult,
    savesResult
  ] = await Promise.all([
    sb
      .from("profiles")
      .select(
        "id,username,display_name,bio,avatar_url,verified"
      )
      .in("id", userIds),

    sb
      .from("post_likes")
      .select(
        "post_id,user_id"
      )
      .in("post_id", postIds),

    sb
      .from("comments")
      .select(
        "id,post_id,user_id,text,created_at,profiles(username,display_name)"
      )
      .in("post_id", postIds)
      .order(
        "created_at",
        {
          ascending: true
        }
      ),

    sb
      .from("saves")
      .select(
        "post_id,user_id"
      )
      .eq(
        "user_id",
        userId
      )
      .in(
        "post_id",
        postIds
      )
  ]);

  const profiles =
    profilesResult.data || [];

  const likes =
    likesResult.data || [];

  const comments =
    commentsResult.data || [];

  const saves =
    savesResult.data || [];

  const pmap =
    new Map(
      profiles.map(
        p => [p.id, p]
      )
    );

  const likeMap =
    new Map();

  for (const l of likes) {
    likeMap.set(
      l.post_id,
      (likeMap.get(l.post_id) || 0) + 1
    );
  }

  const liked =
    new Set(
      likes
        .filter(
          x => x.user_id === userId
        )
        .map(
          x => x.post_id
        )
    );

  const saved =
    new Set(
      saves.map(
        x => x.post_id
      )
    );

  const commentsMap =
    new Map();

  for (const c of comments) {
    if (
      !commentsMap.has(
        c.post_id
      )
    ) {
      commentsMap.set(
        c.post_id,
        []
      );
    }

    commentsMap
      .get(c.post_id)
      .push({
        id: c.id,
        userId: c.user_id,
        text: c.text,
        createdAt:
          c.created_at,
        username:
          c.profiles?.username ||
          ""
      });
  }

  return posts.map(p => ({
    id: p.id,
    userId: p.user_id,
    caption: p.caption,
    media: p.media_url,
    mediaName:
      p.media_name,
    mediaType:
      p.media_type,
    createdAt:
      p.created_at,

    likes: Array(
      likeMap.get(p.id) || 0
    ).fill(null),

    comments:
      commentsMap.get(p.id) || [],

    likedByMe:
      liked.has(p.id),

    savedByMe:
      saved.has(p.id),

    user: safeUser(
      pmap.get(p.user_id) || {
        id: p.user_id,
        username: "user"
      }
    )
  }));
}

/* =========================================================
   USERNAME CHECK
========================================================= */

app.get(
  "/api/check-username",
  async (req, res) => {
    try {
      const username =
        normalizeUsername(
          req.query?.username
        );

      if (!username) {
        return res.json({
          ok: true,
          available: false,
          error: "Kullanıcı adı gerekli."
        });
      }

      if (
        !/^[a-z0-9._]{3,30}$/.test(
          username
        )
      ) {
        return res.json({
          ok: true,
          available: false,
          error:
            "3-30 karakter kullan. Harf, sayı, _ veya . kullanabilirsin."
        });
      }

      if (!SUPABASE_URL) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_URL eksik."
        });
      }

      if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY eksik."
        });
      }

      const admin =
        adminClient();

      const {
        data,
        error
      } =
        await admin
          .from("profiles")
          .select("id")
          .eq(
            "username",
            username
          )
          .limit(1);

      if (error) {
        console.error(
          "CHECK USERNAME ERROR:",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            "Kullanıcı adı kontrol edilemedi."
        });
      }

      const taken =
        Array.isArray(data) &&
        data.length > 0;

      return res.json({
        ok: true,

        available:
          !taken,

        username
      });

    } catch (e) {
      console.error(
        "CHECK USERNAME EXCEPTION:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Kullanıcı adı kontrol edilemedi."
      });
    }
  }
);

/* =========================================================
   REGISTER + 6 HANELİ E-POSTA DOĞRULAMA + GMAIL BAŞINA 20 HESAP
   ========================================================= */

const mailGatewayRuntime = {
  codeLength: 6,
  expiryMinutes: 10,
  cooldownSeconds: 60
};

const registrationCodes = new Map();
const registrationRate = new Map();
const MAX_ACCOUNTS_PER_EMAIL = 20;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createVerificationCode() {
  // Kayıt doğrulaması her zaman 6 hanelidir.
  return crypto.randomInt(100000, 1000000).toString();
}

function registrationKey(registrationId) {
  return String(registrationId || "").trim();
}

function registrationAllowed(email) {
  const key = normalizeEmail(email);
  const now = Date.now();
  const last = registrationRate.get(key) || 0;
  return now - last >= (Number(mailGatewayRuntime?.cooldownSeconds) || 60) * 1000;
}

function maskEmail(email) {
  const [u, d] = String(email || "").split("@");
  if (!u || !d) return String(email || "");
  const shown = u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.max(1, u.length - 2));
  return `${shown}@${d}`;
}

async function listAllAuthUsersForRegistration() {
  const admin = adminClient();
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const result = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (result?.error) throw result.error;
    const users = result?.data?.users || [];
    all.push(...users);
    if (users.length < 1000) break;
  }
  return all;
}

async function countMinegramAccountsForEmail(email) {
  const wanted = normalizeEmail(email);
  if (!wanted) return 0;

  const users = await listAllAuthUsersForRegistration();
  let count = 0;

  for (const user of users) {
    const meta = user?.user_metadata || {};
    const contact = normalizeEmail(
      meta.minegram_contact_email ||
      meta.contact_email ||
      meta.registration_email ||
      ""
    );

    // Yeni sistem: gerçek Gmail metadata'da tutulur.
    if (contact === wanted) {
      count++;
      continue;
    }

    // Eski Minegram hesapları: Auth e-postası gerçek Gmail ise onları da say.
    const authEmail = normalizeEmail(user?.email || "");
    if (authEmail === wanted) count++;
  }

  return count;
}

async function sendRegistrationCode(email, code) {
  await sendMailGatewayEmail({
    to: email,
    subject: "Minegram e-posta doğrulama kodun",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;color:#111">
        <h2 style="margin:0 0 16px">Minegram</h2>
        <p style="font-size:16px">Minegram hesabını oluşturmak için 6 haneli doğrulama kodun:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:10px;margin:24px 0">${code}</div>
        <p style="color:#666">Bu kod ${(Number(mailGatewayRuntime?.expiryMinutes) || 10)} dakika geçerlidir.</p>
        <p style="color:#666">Bu kodu kimseyle paylaşma.</p>
      </div>
    `,
    text: `Minegram e-posta doğrulama kodun: ${code}\nBu kod ${Number(mailGatewayRuntime?.expiryMinutes) || 10} dakika geçerlidir.`
  });
}

app.post("/api/problem-reports", auth, async (req, res) => {
  try {
    const description = String(req.body?.description || "").trim().slice(0, 2000);
    if (!description) return res.status(400).json({ ok: false, error: "Sorun açıklaması gerekli." });

    const username = String(req.user?.username || req.authUser?.user_metadata?.username || "").trim();
    const email = String(req.user?.email || req.authUser?.email || "").trim();
    const subject = `Minegram Sorun Bildirimi${username ? ` - @${username}` : ""}`;
    const safe = (v) => String(v || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;padding:24px;color:#111">
        <h2>Minegram Sorun Bildirimi</h2>
        <p><b>Kullanıcı:</b> ${safe(username || "Bilinmiyor")}</p>
        <p><b>E-posta:</b> ${safe(email || "Bilinmiyor")}</p>
        <p><b>Tarih:</b> ${new Date().toLocaleString("tr-TR")}</p>
        <hr>
        <p style="white-space:pre-wrap">${safe(description)}</p>
      </div>`;
    const text = `Minegram Sorun Bildirimi\nKullanıcı: ${username || "Bilinmiyor"}\nE-posta: ${email || "Bilinmiyor"}\n\n${description}`;

    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments
      .filter(a => a && typeof a.data === "string" && a.data.length <= 8 * 1024 * 1024)
      .slice(0, 2)
      .map(a => ({ filename: String(a.filename || "foto.jpg").slice(0, 120), contentType: String(a.contentType || "image/jpeg").slice(0, 100), data: String(a.data).replace(/^data:[^;]+;base64,/, "") })) : [];

    await sendGmailApiEmail({
      to: "minegramdestek@gmail.com",
      subject,
      html,
      text,
      attachments,
      replyTo: email
    });

    return res.json({ ok: true, message: "Sorun bildirimi gönderildi." });
  } catch (e) {
    console.error("PROBLEM REPORT ERROR:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Sorun bildirimi gönderilemedi." });
  }
});

app.post("/api/register", async (req, res) => {
  let createdAuthUserId = null;

  try {
    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || username).trim().slice(0, 80);

    if (!username) return res.status(400).json({ ok:false, code:"USERNAME_REQUIRED", error:"Kullanıcı adı gerekli." });
    if (!email || !email.includes("@")) return res.status(400).json({ ok:false, code:"EMAIL_REQUIRED", error:"Kayıt için geçerli bir e-posta adresi gerekli." });
    if (password.length < 6) return res.status(400).json({ ok:false, code:"PASSWORD_TOO_SHORT", error:"Şifre en az 6 karakter olmalı." });
    if (!/^[a-z0-9._]{3,30}$/.test(username)) return res.status(400).json({ ok:false, code:"INVALID_USERNAME", error:"Kullanıcı adı 3-30 karakter olmalı; sadece harf, sayı, nokta ve alt çizgi kullan." });
    if (!CONFIG_OK) return res.status(500).json({ ok:false, code:"SUPABASE_CONFIG_ERROR", error:"Supabase yapılandırması eksik." });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ ok:false, code:"SERVICE_ROLE_MISSING", error:"SUPABASE_SERVICE_ROLE_KEY eksik." });

    const admin = adminClient();

    const { data: existingProfile, error: usernameCheckError } = await admin
      .from("profiles")
      .select("id,username,auth_user_id")
      .eq("username", username)
      .limit(1)
      .maybeSingle();

    if (usernameCheckError) return res.status(500).json({ ok:false, code:"USERNAME_CHECK_ERROR", error:"Kullanıcı adı kontrol edilirken hata oluştu." });
    if (existingProfile) return res.status(409).json({ ok:false, code:"USERNAME_TAKEN", error:"Bu kullanıcı adı zaten alınmış." });

    // Aynı Gmail ile en fazla 20 Minegram hesabı.
    const accountCount = await countMinegramAccountsForEmail(email);
    if (accountCount >= MAX_ACCOUNTS_PER_EMAIL) {
      return res.status(409).json({
        ok:false,
        code:"EMAIL_ACCOUNT_LIMIT",
        limit:MAX_ACCOUNTS_PER_EMAIL,
        accountCount,
        error:"Bu e-posta adresiyle en fazla 20 Minegram hesabı oluşturabilirsin."
      });
    }

    // Supabase Auth e-posta alanı benzersiz olduğu için gerçek Gmail'i Auth'a koymuyoruz.
    // Kullanıcının gerçek Gmail'i metadata'da tutulur ve doğrulama kodu oraya gönderilir.
    const authEmail = `${crypto.randomUUID()}@users.minegram.invalid`;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        display_name: displayName,
        minegram_contact_email: email,
        registration_email: email
      }
    });

    if (createError) {
      console.error("AUTH CREATE ERROR:", createError);
      return res.status(400).json({ ok:false, code:"SIGNUP_ERROR", error:String(createError.message || "Kayıt başarısız.") });
    }

    const authUser = created?.user;
    if (!authUser?.id) return res.status(400).json({ ok:false, code:"USER_CREATE_FAILED", error:"Kullanıcı oluşturulamadı." });
    createdAuthUserId = authUser.id;

    let profile = null;
    let profileError = null;

    const existingProfileResult = await admin
      .from("profiles")
      .select("*")
      .eq("id", authUser.id)
      .maybeSingle();

    if (existingProfileResult.data) {
      const updatePayload = { username, display_name: displayName };
      const updateResult = await admin.from("profiles").update(updatePayload).eq("id", authUser.id).select("*").single();
      profile = updateResult.data;
      profileError = updateResult.error;
    } else {
      const insertResult = await admin.from("profiles").insert({
        id: authUser.id,
        auth_user_id: authUser.id,
        username,
        display_name: displayName,
        email,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      }).select("*").single();

      profile = insertResult.data;
      profileError = insertResult.error;

      if (profileError?.code === "23505") {
        const retryProfile = await admin.from("profiles").select("*").eq("id", authUser.id).maybeSingle();
        if (retryProfile.data) { profile = retryProfile.data; profileError = null; }
      }

      // Eski şemalarda email kolonu olmayabilir. Profil oluşturma zaten başarılıysa devam et.
      if (profileError && /email/i.test(String(profileError.message || ""))) {
        const fallback = await admin.from("profiles").insert({
          id: authUser.id,
          auth_user_id: authUser.id,
          username,
          display_name: displayName,
          bio: "",
          avatar_url: null,
          verified: false,
          settings: {}
        }).select("*").single();
        profile = fallback.data;
        profileError = fallback.error;
      }
    }

    if (profileError) {
      console.error("PROFILE CREATE ERROR:", profileError);
      try { await admin.auth.admin.deleteUser(authUser.id); } catch (cleanupError) { console.error("AUTH CLEANUP ERROR:", cleanupError); }
      createdAuthUserId = null;
      return res.status(500).json({ ok:false, code:"PROFILE_CREATE_ERROR", error:"Profil oluşturulamadı." });
    }

    const registrationId = crypto.randomBytes(24).toString("hex");
    const code = createVerificationCode();
    const expires = Date.now() + 10 * 60 * 1000;

    registrationCodes.set(registrationId, {
      registrationId,
      userId: authUser.id,
      username,
      displayName,
      email,
      authEmail,
      password,
      code,
      expires,
      attempts: 0
    });
    registrationRate.set(email, Date.now());

    try {
      await sendRegistrationCode(email, code);
    } catch (mailError) {
      registrationCodes.delete(registrationId);
      try { await admin.auth.admin.deleteUser(authUser.id); } catch (cleanupError) { console.error("AUTH MAIL CLEANUP ERROR:", cleanupError); }
      createdAuthUserId = null;
      console.error("REGISTER MAIL ERROR:", mailError);
      return res.status(502).json({ ok:false, code:"EMAIL_SEND_FAILED", error:"Doğrulama kodu e-posta adresine gönderilemedi. Admin Panelindeki e-posta servisini kontrol et." });
    }

    createdAuthUserId = null;
    return res.json({
      ok:true,
      needsEmailVerification:true,
      registrationId,
      email,
      maskedEmail:maskEmail(email),
      accountNumber:accountCount + 1,
      accountLimit:MAX_ACCOUNTS_PER_EMAIL,
      message:"Doğrulama kodu e-posta adresine gönderildi."
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    if (createdAuthUserId) {
      try { await adminClient().auth.admin.deleteUser(createdAuthUserId); } catch (cleanupError) { console.error("FINAL AUTH CLEANUP ERROR:", cleanupError); }
    }
    return res.status(500).json({ ok:false, code:"REGISTER_ERROR", error:e?.message || "Kayıt başarısız." });
  }
});

/* =========================================================
   REGISTER VERIFY
   ========================================================= */

app.post("/api/register/verify", async (req, res) => {
  try {
    const registrationId = registrationKey(req.body?.registrationId || req.body?.registration_id);
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").replace(/\D/g, "").slice(0, 6);

    if (!registrationId) return res.status(400).json({ ok:false, error:"Kayıt doğrulama oturumu bulunamadı. Lütfen yeniden kayıt ol." });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok:false, error:"6 haneli doğrulama kodunu gir." });

    const entry = registrationCodes.get(registrationId);
    if (!entry) return res.status(400).json({ ok:false, error:"Doğrulama kodu bulunamadı. Yeni kayıt başlat." });

    if (email && email !== normalizeEmail(entry.email)) return res.status(400).json({ ok:false, error:"E-posta adresi kayıtla eşleşmiyor." });
    if (!entry.expires || entry.expires < Date.now()) {
      registrationCodes.delete(registrationId);
      return res.status(400).json({ ok:false, code:"CODE_EXPIRED", error:"Kodun süresi dolmuş. Yeni kod iste." });
    }
    if (entry.attempts >= 5) {
      registrationCodes.delete(registrationId);
      return res.status(429).json({ ok:false, code:"TOO_MANY_ATTEMPTS", error:"Çok fazla yanlış kod girildi. Yeniden kayıt başlat." });
    }
    if (entry.code !== code) {
      entry.attempts = Number(entry.attempts || 0) + 1;
      if (entry.attempts >= 5) registrationCodes.delete(registrationId);
      return res.status(400).json({ ok:false, code:"INVALID_CODE", error:"Kod yanlış. Lütfen tekrar kontrol et." });
    }

    const admin = adminClient();
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(entry.userId);
    if (userError || !userData?.user) {
      registrationCodes.delete(registrationId);
      return res.status(404).json({ ok:false, code:"USER_NOT_FOUND", error:"Kayıt bulunamadı. Lütfen yeniden kayıt ol." });
    }

    // Özel Minegram kodu doğru: Auth hesabı zaten kullanılabilir durumda.
    // Gerçek Gmail metadata'da tutulmaya devam eder.
    await admin.auth.admin.updateUserById(entry.userId, {
      email_confirm: true,
      user_metadata: {
        ...(userData.user.user_metadata || {}),
        minegram_contact_email: entry.email,
        registration_email: entry.email,
        username: entry.username,
        display_name: entry.displayName
      }
    });

    registrationCodes.delete(registrationId);

    // Kullanıcı adı + şifre ile doğrudan giriş için gerçek Auth e-postasını kullan.
    let loginData = null;
    let loginError = null;
    try {
      const result = await client().auth.signInWithPassword({ email: entry.authEmail, password: entry.password });
      loginData = result?.data || null;
      loginError = result?.error || null;
    } catch (e) { loginError = e; }

    if (!loginData?.session) {
      return res.json({
        ok:true,
        verified:true,
        needsLogin:true,
        message:"E-posta başarıyla doğrulandı. Şimdi giriş yapabilirsin.",
        user:{ id:entry.userId, email:entry.email, username:entry.username, displayName:entry.displayName },
        authEmail:entry.authEmail
      });
    }

    return res.json({
      ok:true,
      verified:true,
      token:loginData.session.access_token,
      user:{ id:entry.userId, email:entry.email, username:entry.username, displayName:entry.displayName },
      authEmail:entry.authEmail
    });
  } catch (e) {
    console.error("REGISTER VERIFY ERROR:", e);
    return res.status(500).json({ ok:false, error:e?.message || "Doğrulama başarısız." });
  }
});

/* =========================================================
   REGISTER RESEND
   ========================================================= */

app.post("/api/register/resend", async (req, res) => {
  try {
    const registrationId = registrationKey(req.body?.registrationId || req.body?.registration_id);
    if (!registrationId) return res.status(400).json({ ok:false, error:"Kayıt doğrulama oturumu bulunamadı." });

    const entry = registrationCodes.get(registrationId);
    if (!entry) return res.status(404).json({ ok:false, error:"Bekleyen bir kayıt bulunamadı." });

    if (!registrationAllowed(entry.email)) {
      return res.status(429).json({ ok:false, error:`Yeni kod göndermek için ${Number(mailGatewayRuntime?.cooldownSeconds) || 60} saniye bekle.` });
    }

    const code = createVerificationCode();
    entry.code = code;
    entry.expires = Date.now() + 10 * 60 * 1000;
    entry.attempts = 0;
    registrationCodes.set(registrationId, entry);
    registrationRate.set(entry.email, Date.now());

    await sendRegistrationCode(entry.email, code);
    return res.json({ ok:true, message:"Yeni 6 haneli doğrulama kodu gönderildi.", email:entry.email, maskedEmail:maskEmail(entry.email) });
  } catch (e) {
    console.error("REGISTER RESEND ERROR:", e);
    return res.status(500).json({ ok:false, error:e?.message || "Yeni kod gönderilemedi." });
  }
});

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {
    try {
      const identifier =
        String(
          req.body?.username ??
          req.body?.email ??
          ""
        ).trim();

      const password =
        String(
          req.body?.password ??
          ""
        );

      if (
        !identifier ||
        !password
      ) {
        return res.status(400).json({
          error:
            "Kullanıcı adı/e-posta ve şifre gerekli."
        });
      }

      if (!CONFIG_OK) {
        return res.status(500).json({
          error:
            "Supabase ortam değişkenleri eksik."
        });
      }

      if (
        !SUPABASE_SERVICE_ROLE_KEY
      ) {
        return res.status(500).json({
          error:
            "Giriş için SUPABASE_SERVICE_ROLE_KEY gerekli."
        });
      }

      const admin =
        adminClient();

      let email =
        identifier.toLowerCase();

      if (
        !identifier.includes("@")
      ) {
        const username =
          normalizeUsername(
            identifier
          );

        const {
          data: profile,
          error: pe
        } = await admin
          .from("profiles")
          .select("*")
          .ilike(
            "username",
            username
          )
          .maybeSingle();

        if (pe) {
          return res.status(500).json({
            error: pe.message
          });
        }

        if (!profile) {
          return res.status(401).json({
            error:
              "Kullanıcı adı veya şifre hatalı."
          });
        }

        let authUser = null;
        const authId =
          profile.auth_user_id ||
          profile.id;

        if (authId) {
          const {
            data: au,
            error: ae
          } =
            await admin.auth.admin.getUserById(
              authId
            );
          if (!ae && au?.user?.email) {
            authUser = au.user;
          }
        }

        // Eski/uyumsuz profillerde auth_user_id farklı olabilir.
        // Profilde kayıtlı e-posta varsa Auth kullanıcısını onunla bul.
        if (!authUser && profile.email && String(profile.email).includes("@")) {
          const { data: listed } = await admin.auth.admin.listUsers({
            page: 1,
            perPage: 1000
          });
          const wantedEmail = String(profile.email).trim().toLowerCase();
          authUser = (listed?.users || []).find(
            u => String(u?.email || "").trim().toLowerCase() === wantedEmail
          ) || null;
        }

        if (!authUser?.email) {
          return res.status(401).json({
            error:
              "Kullanıcı hesabının giriş bilgisi bulunamadı. Şifre sıfırlama ile hesabı yeniden etkinleştirin."
          });
        }

        email =
          String(authUser.email).trim().toLowerCase();
      }

      const anon =
        client();

      const {
        data: sd,
        error: le
      } =
        await anon.auth.signInWithPassword({
          email,
          password
        });

      if (
        le ||
        !sd?.session ||
        !sd?.user
      ) {
        return res.status(401).json({
          error:
            /invalid login credentials/i.test(
              le?.message || ""
            )
              ? "Kullanıcı adı/e-posta veya şifre hatalı."
              : (
                  le?.message ||
                  "Giriş başarısız."
                )
        });
      }

      const authId =
        sd.user.id;

      const {
        data: profiles,
        error: pe2
      } = await admin
        .from("profiles")
        .select("*")
        .eq(
          "auth_user_id",
          authId
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        );

      if (pe2) {
        return res.status(500).json({
          error: pe2.message
        });
      }

      let list =
        profiles || [];

      if (!list.length) {
        const {
          data: legacy
        } = await admin
          .from("profiles")
          .select("*")
          .eq(
            "id",
            authId
          )
          .maybeSingle();

        if (legacy) {
          list = [legacy];
        }
      }

      if (!list.length) {
        return res.status(404).json({
          error:
            "Bu hesap için Minegram profili bulunamadı."
        });
      }

      const safe =
        list.map(
          safeProfile
        );

      const selected =
        identifier.includes("@")
          ? safe[0]
          : (
              safe.find(
                x =>
                  x.username ===
                  normalizeUsername(
                    identifier
                  )
              ) ||
              safe[0]
            );

      return res.json({
        ok: true,
        multipleProfiles:
          safe.length > 1,
        profiles: safe,
        profile: selected,
        token:
          sd.session
            .access_token,
        user: selected
      });

    } catch (e) {
      console.error(
        "LOGIN ERROR:",
        e
      );

      return res.status(500).json({
        error:
          e?.message ||
          "Giriş başarısız."
      });
    }
  }
);


/* =========================================================
   RECOVERY HELPERS
========================================================= */

function publicOrigin(req) {
  const proto =
    req.headers[
      "x-forwarded-proto"
    ] ||
    req.protocol ||
    "http";

  return `${String(proto).split(",")[0].trim()}://${req.get("host")}`;
}

function normalizeRecoveryPhone(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  const digits =
    String(value)
      .replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length >= 10) {
    return digits.slice(-10);
  }

  return digits;
}


/* =========================================================
   FORGOT PASSWORD - FIND ACCOUNT
========================================================= */

app.post(
  "/api/forgot-password/find-account",
  async (req, res) => {
    try {
      const identifier =
        String(
          req.body?.identifier ??
          req.body?.email ??
          req.body?.username ??
          req.body?.phone ??
          ""
        ).trim();

      const mode =
        String(
          req.body?.mode ??
          ""
        )
          .trim()
          .toLowerCase();

      if (!identifier) {
        return res.status(400).json({
          ok: false,
          error: "E-posta, kullanıcı adı veya telefon numarası gerekli."
        });
      }

      /*
       * Frontend mode gönderiyorsa onu kullanıyoruz.
       * Göndermiyorsa identifier'a göre otomatik belirliyoruz.
       */
      let recoveryMode = mode;

      if (!recoveryMode) {
        if (identifier.includes("@")) {
          recoveryMode = "email";
        } else if (
          /[\d\s()+\-]/.test(identifier) &&
          normalizeRecoveryPhone(identifier).length >= 10
        ) {
          recoveryMode = "phone";
        } else {
          recoveryMode = "username";
        }
      }

      let found = null;

      /*
       * -----------------------------------------------------
       * 1) TELEFON
       * -----------------------------------------------------
       */

      if (
        recoveryMode === "phone" ||
        recoveryMode === "tel" ||
        recoveryMode === "telefon"
      ) {
        const authUser =
          await findUserByPhone(
            identifier
          );

        if (authUser?.email) {
          const admin =
            adminClient();

          let profile = null;

          const {
            data: profileById
          } =
            await admin
              .from("profiles")
              .select(
                "id,auth_user_id,username,email,display_name,avatar_url"
              )
              .or(
                `id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`
              )
              .limit(1)
              .maybeSingle();

          profile =
            profileById || null;

          found = {
            email:
              authUser.email,
            profile,
            authUser
          };
        }
      }

      /*
       * -----------------------------------------------------
       * 2) E-POSTA / KULLANICI ADI
       * -----------------------------------------------------
       */

      if (!found) {
        found =
          await resolveRecoveryEmail(
            identifier,
            recoveryMode === "username"
              ? "email"
              : recoveryMode
          );
      }

      /*
       * -----------------------------------------------------
       * HESAP YOK
       * -----------------------------------------------------
       */

      if (!found?.email) {
        return res.status(404).json({
          ok: false,
          error: "Bu bilgilerle eşleşen bir hesap bulunamadı."
        });
      }

      const profile =
        found.profile || {};

      /*
       * -----------------------------------------------------
       * FRONTEND'E GÖNDERİLECEK HESAP BİLGİSİ
       * -----------------------------------------------------
       */

      return res.json({
        ok: true,

        account: {
          id:
            profile.id ||
            found.authUser?.id ||
            null,

          username:
            profile.username ||
            "",

          displayName:
            profile.display_name ||
            profile.displayName ||
            profile.username ||
            "",

          email:
            found.email,

          maskedEmail:
            maskEmail(
              found.email
            ),

          avatar:
            profile.avatar_url ||
            null
        },

        /*
         * Frontend'in sonraki adımda kullanabilmesi
         * için normalize edilmiş değerler.
         */
        identifier,
        mode: recoveryMode
      });

    } catch (e) {
      console.error(
        "FIND ACCOUNT ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Hesap aranırken bir hata oluştu."
      });
    }
  }
);

/* =========================================================
   TEK VE TEMİZ findUserByPhone
========================================================= */

async function findUserByPhone(
  phone
) {
  if (!SUPABASE_URL) {
    console.error(
      "SUPABASE_URL EKSİK"
    );

    return null;
  }

  if (
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "SUPABASE_SERVICE_ROLE_KEY EKSİK"
    );

    return null;
  }

  const admin =
    adminClient();

  const wanted =
    normalizeRecoveryPhone(
      phone
    );

  console.log(
    "======================================"
  );

  console.log(
    "MINEGRAM TELEFON HESAP ARAMA"
  );

  console.log(
    "Gelen telefon:",
    phone
  );

  console.log(
    "Normalize telefon:",
    wanted
  );

  console.log(
    "======================================"
  );

  if (
    !wanted ||
    wanted.length !== 10
  ) {
    console.log(
      "GEÇERSİZ TELEFON:",
      wanted
    );

    return null;
  }


  /* -------------------------------------------------------
     1) SUPABASE AUTH TELEFON
  ------------------------------------------------------- */

  try {
    for (
      let page = 1;
      page <= 20;
      page++
    ) {
      const result =
        await admin.auth.admin.listUsers({
          page,
          perPage: 1000
        });

      const users =
        result?.data?.users ||
        [];

      const error =
        result?.error;

      if (error) {
        console.error(
          "AUTH KULLANICILARI ALINAMADI:",
          error
        );

        break;
      }

      console.log(
        `AUTH SAYFA ${page}: ${users.length} kullanıcı`
      );

      for (const user of users) {
        if (!user?.phone) {
          continue;
        }

        const normalizedUserPhone =
          normalizeRecoveryPhone(
            user.phone
          );

        console.log(
          "AUTH TELEFON KONTROL:",
          user.phone,
          "=>",
          normalizedUserPhone
        );

        if (
          normalizedUserPhone ===
          wanted
        ) {
          console.log(
            "TELEFON AUTH'TA BULUNDU!",
            user.id,
            user.email
          );

          return user;
        }
      }

      if (
        users.length < 1000
      ) {
        break;
      }
    }
  } catch (error) {
    console.error(
      "AUTH TELEFON ARAMA HATASI:",
      error?.message ||
        error
    );
  }


  /* -------------------------------------------------------
     2) PROFILES TELEFON
  ------------------------------------------------------- */

  const possibleColumns = [
    "phone",
    "phone_number",
    "phoneNumber",
    "telefon",
    "telefon_numarasi",
    "telefon_numarası",
    "mobile",
    "mobile_phone",
    "gsm",
    "gsm_number"
  ];

  for (
    const column of
    possibleColumns
  ) {
    try {
      const {
        data,
        error
      } =
        await admin
          .from("profiles")
          .select("*")
          .not(
            column,
            "is",
            null
          );

      if (error) {
        console.log(
          `PROFILES KOLONU KULLANILAMIYOR: ${column}`
        );

        continue;
      }

      for (
        const profile of
        data || []
      ) {
        const profilePhone =
          normalizeRecoveryPhone(
            profile?.[column]
          );

        if (
          !profilePhone
        ) {
          continue;
        }

        if (
          profilePhone !==
          wanted
        ) {
          continue;
        }

        console.log(
          "TELEFON PROFILES'TA BULUNDU:",
          profile.id,
          profile.username,
          column
        );

        const possibleAuthIds = [
          profile.auth_user_id,
          profile.id
        ].filter(Boolean);

        for (
          const authId of
          possibleAuthIds
        ) {
          try {
            const {
              data: authData,
              error: authError
            } =
              await admin.auth.admin.getUserById(
                authId
              );

            if (
              !authError &&
              authData?.user
            ) {
              console.log(
                "AUTH KULLANICISI BULUNDU:",
                authData.user.id
              );

              return authData.user;
            }
          } catch (error) {
            console.log(
              "AUTH ID KONTROL HATASI:",
              authId,
              error?.message ||
                error
            );
          }
        }
      }
    } catch (error) {
      console.log(
        `PROFILE TELEFON ARAMA HATASI [${column}]:`,
        error?.message ||
          error
      );
    }
  }

  console.log(
    "TELEFONLA HESAP BULUNAMADI:",
    wanted
  );

  return null;
}


/* =========================================================
   RECOVERY EMAIL RESOLVE
========================================================= */

function normalizeRecoveryMode(mode) {
  const m = String(mode || "email").trim().toLowerCase();
  if (["phone", "tel", "telefon"].includes(m)) return "phone";
  if (["username", "user", "kullanici", "kullanıcı"].includes(m)) return "username";
  return "email";
}

async function findAuthUserByEmailExact(email) {
  const wanted = String(email || "").trim().toLowerCase();
  if (!wanted || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  /* Supabase Admin REST: SDK sürümünden bağımsız kesin arama. */
  for (let page = 1; page <= 20; page++) {
    const url = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?page=${page}&per_page=1000`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Supabase Auth kullanıcıları alınamadı (${response.status}): ${data?.msg || data?.message || data?.error_description || "Bilinmeyen hata"}`
      );
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    const match = users.find(
      user => String(user?.email || "").trim().toLowerCase() === wanted
    );

    if (match?.id) return match;
    if (users.length < 1000) break;
  }

  return null;
}


async function resolveRecoveryEmail(
  identifier,
  mode = "email"
) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;

  const cleanMode = normalizeRecoveryMode(mode);
  const admin = adminClient();

  let email = raw;
  let profile = null;
  let authUser = null;

  /* -------------------------------------------------------
     1) TELEFON
  ------------------------------------------------------- */
  if (cleanMode === "phone") {
    authUser = await findUserByPhone(raw);

    if (!authUser?.id || !authUser?.email) {
      return null;
    }

    email = String(authUser.email).trim().toLowerCase();

    try {
      const { data } = await admin
        .from("profiles")
        .select("*")
        .or(`id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`)
        .limit(1)
        .maybeSingle();
      profile = data || null;
    } catch (e) {
      console.log("RECOVERY PROFILE TELEFON HATASI:", e?.message || e);
    }

    return { email, profile, authUser };
  }

  /* -------------------------------------------------------
     2) E-POSTA
     Supabase Auth doğrudan e-posta ile aranır.
     Böylece profiles RLS yüzünden boş dönse bile hesap bulunur.
  ------------------------------------------------------- */
  if (email.includes("@")) {
    email = email.toLowerCase();

    try {
      const { data, error } =
        await admin.auth.admin.getUserByEmail(email);

      if (!error && data?.user?.id) {
        authUser = data.user;
        email = String(data.user.email || email)
          .trim()
          .toLowerCase();
      }
    } catch (e) {
      console.log("RECOVERY AUTH E-POSTA HATASI:", e?.message || e);
    }

    /* SDK başarısız olsa bile doğrudan Supabase Auth REST ile ara. */
    if (!authUser) {
      try {
        authUser = await findAuthUserByEmailExact(email);
      } catch (e) {
        console.log("RECOVERY AUTH REST E-POSTA HATASI:", e?.message || e);
      }
    }

    /* Auth'ta bulunamazsa profiles'tan da kontrol et. */
    if (!authUser) {
      try {
        const { data } = await admin
          .from("profiles")
          .select("*")
          .eq("email", email)
          .limit(1)
          .maybeSingle();

        profile = data || null;
      } catch (e) {
        console.log("RECOVERY PROFILE E-POSTA HATASI:", e?.message || e);
      }
    }
  }

  /* -------------------------------------------------------
     3) KULLANICI ADI
     Service-role ile profiles aranır; RLS engeline takılmaz.
  ------------------------------------------------------- */
  if (!authUser && !email.includes("@")) {
    const username = normalizeUsername(raw);

    try {
      const { data, error } = await admin
        .from("profiles")
        .select("*")
        .eq("username", username)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.log("RECOVERY USERNAME PROFILE HATASI:", error.message || error);
      } else {
        profile = data || null;
      }
    } catch (e) {
      console.log("RECOVERY USERNAME ARAMA HATASI:", e?.message || e);
    }

    if (!profile) return null;

    const authId = profile.auth_user_id || profile.id || null;

    if (authId) {
      try {
        const { data, error } =
          await admin.auth.admin.getUserById(authId);

        if (!error && data?.user?.id) {
          authUser = data.user;
          email = String(
            data.user.user_metadata?.minegram_contact_email ||
            profile.email ||
            data.user.email ||
            ""
          ).trim().toLowerCase();
        }
      } catch (e) {
        console.log("RECOVERY USERNAME AUTH HATASI:", e?.message || e);
      }
    }

    /* auth_user_id/id çalışmadıysa profile e-postasıyla Auth'u bul. */
    if (!authUser && profile.email) {
      try {
        const { data, error } =
          await admin.auth.admin.getUserByEmail(
            String(profile.email).trim().toLowerCase()
          );

        if (!error && data?.user?.id) {
          authUser = data.user;
          email = String(
            data.user.user_metadata?.minegram_contact_email ||
            profile.email ||
            data.user.email ||
            ""
          ).trim().toLowerCase();
        }
      } catch (e) {
        console.log("RECOVERY PROFILE EMAIL AUTH HATASI:", e?.message || e);
      }
    }
  }

  /* -------------------------------------------------------
     4) E-posta ile bulunduysa profile'i service-role ile getir.
  ------------------------------------------------------- */
  if (!profile && email.includes("@")) {
    try {
      const { data } = await admin
        .from("profiles")
        .select("*")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      profile = data || null;
    } catch (e) {
      console.log("RECOVERY PROFILE SON ARAMA HATASI:", e?.message || e);
    }
  }

  /* Profile'dan Auth kullanıcısını son kez doğrula. */
  if (!authUser && profile) {
    authUser = await resolveAuthUserForProfile(profile, admin);
    if (authUser?.email) {
      email = String(authUser.email).trim().toLowerCase();
    }
  }

  if (!email.includes("@")) return null;

  return {
    email,
    profile,
    authUser
  };
}

/* =========================================================
   FORGOT LEGACY
========================================================= */

app.post(
  "/api/forgot",
  async (req, res) => {
    try {
      const identifier =
        String(
          req.body?.identifier ||
          ""
        ).trim();

      const anon =
        client();

      let email =
        identifier;

      if (
        !identifier.includes("@")
      ) {
        if (
          !SUPABASE_SERVICE_ROLE_KEY
        ) {
          return res.json({
            ok: true
          });
        }

        const profile =
          await findProfile(
            anon,
            identifier
          );

        if (!profile) {
          return res.json({
            ok: true
          });
        }

        const admin =
          adminClient();

        const authId =
          profile.auth_user_id ||
          profile.id;

        const {
          data,
          error
        } =
          await admin.auth.admin.getUserById(
            authId
          );

        if (
          error ||
          !data?.user?.email
        ) {
          return res.json({
            ok: true
          });
        }

        email =
          data.user.email;
      }

      const {
        error
      } =
        await anon.auth.resetPasswordForEmail(
          email,
          {
            redirectTo:
              `${publicOrigin(req)}/`
          }
        );

      if (error) {
        return res.status(400).json({
          error:
            error.message
        });
      }

      res.json({
        ok: true
      });
    } catch {
      res.json({
        ok: true
      });
    }
  }
);


/* =========================================================
   AUTH CONFIG
========================================================= */

app.get(
  "/api/auth-config",
  (req, res) => {
    if (!CONFIG_OK) {
      return res.status(500).json({
        error:
          "Supabase yapılandırması eksik."
      });
    }

    res.json({
      url:
        SUPABASE_URL,
      key:
        SUPABASE_KEY
    });
  }
);


/* =========================================================
   GMAIL API — DOMAIN GEREKTİRMEYEN HTTP E-POSTA
   Gmail API, SMTP portları yerine HTTPS üzerinden çalışır.
   OAuth2 refresh token ile yetkilendirilir.
========================================================= */

function gmailConfig() {
  return {
    clientId: String(process.env.GMAIL_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.GMAIL_CLIENT_SECRET || "").trim(),
    refreshToken: String(process.env.GMAIL_REFRESH_TOKEN || "").trim(),
    userEmail: String(process.env.GMAIL_USER_EMAIL || process.env.MAIL_FROM_EMAIL || "").trim(),
    fromName: String(process.env.MAIL_FROM_NAME || "Minegram").trim(),
  };
}

function gmailConfigured() {
  const c = gmailConfig();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken && c.userEmail);
}

async function gmailAccessToken() {
  const c = gmailConfig();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error("Gmail API OAuth ayarları eksik. GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET ve GMAIL_REFRESH_TOKEN gerekli.");
  }

  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: "refresh_token"
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Gmail OAuth erişim anahtarı alınamadı.");
  }
  return data.access_token;
}

function base64UrlUtf8(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function mimeHeader(value) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

function buildGmailRawMessage({ to, subject, html, text: textBody, attachments = [], replyTo = "" }) {
  const c = gmailConfig();
  const fromName = mimeHeader(c.fromName || "Minegram");
  const fromEmail = mimeHeader(c.userEmail);
  const recipient = mimeHeader(emailAddress(to, "Alıcı e-posta adresi"));
  const safeReplyTo = String(replyTo || "").trim() ? mimeHeader(emailAddress(replyTo, "Yanıt e-posta adresi")) : "";
  const safeSubject = mimeHeader(subject || "Minegram");
  const plain = String(textBody || "").replace(/\r?\n/g, "\r\n");
  const markup = String(html || "").replace(/\r?\n/g, "\r\n");

  const cleanAttachments = Array.isArray(attachments) ? attachments.filter(a => a && a.data).slice(0, 2) : [];
  const mixedBoundary = `minegram_mixed_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const altBoundary = `minegram_alt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${recipient}`,
    `Subject: ${safeSubject}`,
    ...(safeReplyTo ? [`Reply-To: ${safeReplyTo}`] : []),
    "MIME-Version: 1.0",
    cleanAttachments.length ? `Content-Type: multipart/mixed; boundary=${mixedBoundary}` : `Content-Type: multipart/alternative; boundary=${altBoundary}`
  ].join("\r\n");

  const alternative = [
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
    "",
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    markup || `<div>${plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
    "",
    `--${altBoundary}--`
  ].join("\r\n");

  const parts = cleanAttachments.length ? [
    headers,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary=${altBoundary}`,
    "",
    alternative
  ] : [headers, "", alternative];

  if (cleanAttachments.length) {
    for (const a of cleanAttachments) {
      const filename = mimeHeader(a.filename || "foto.jpg").replace(/[\\/]/g, "_");
      const contentType = mimeHeader(a.contentType || "image/jpeg");
      const data = String(a.data || "").replace(/[^A-Za-z0-9+/=]/g, "");
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${contentType}; name="${filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${filename}"`,
        "",
        data.match(/.{1,76}/g)?.join("\r\n") || ""
      );
    }
    parts.push(`--${mixedBoundary}--`, "");
  } else {
    parts.push("");
  }

  return base64UrlUtf8(parts.join("\r\n"));
}

async function sendGmailApiEmail({ to, subject, html, text: textBody, attachments = [], replyTo = "" }) {
  const c = gmailConfig();
  if (!c.userEmail) throw new Error("GMAIL_USER_EMAIL veya MAIL_FROM_EMAIL gerekli.");

  const accessToken = await gmailAccessToken();
  const raw = buildGmailRawMessage({ to, subject, html, text: textBody, attachments, replyTo });

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ raw })
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = data?.error?.message || data?.error_description || "Gmail API e-posta gönderimi başarısız.";
    throw new Error(reason);
  }

  return data;
}

/* Eski isim korunuyor. Resend artık kullanılmıyor; domain gerektirmeyen Gmail API kullanılıyor. */
async function sendResendEmail(to, subject, html, text) {
  return sendGmailApiEmail({ to, subject, html, text });
}

const recoveryCodes =
  new Map();

/* =========================================================
   RECOVERY CODE PERSISTENCE
   Kodlar artık sadece RAM'de tutulmaz. Node yeniden başlasa bile
   10 dakikalık aktif doğrulama kodu kaybolmaz.
========================================================= */
const recoveryCodesFile = path.join(__dirname, "minegram-recovery-codes.json");

function loadRecoveryCodes() {
  try {
    if (!fs.existsSync(recoveryCodesFile)) return;

    const raw = fs.readFileSync(recoveryCodesFile, "utf8");
    const data = JSON.parse(raw);

    recoveryCodes.clear();

    if (data && typeof data === "object") {
      for (const [email, entry] of Object.entries(data)) {
        if (entry && entry.expires > Date.now()) {
          recoveryCodes.set(email, entry);
        }
      }
    }

    saveRecoveryCodes();
  } catch (e) {
    console.error("RECOVERY CODE LOAD ERROR:", e?.message || e);
  }
}

function saveRecoveryCodes() {
  try {
    const data = Object.fromEntries(recoveryCodes.entries());
    fs.writeFileSync(
      recoveryCodesFile,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("RECOVERY CODE SAVE ERROR:", e?.message || e);
  }
}

function setRecoveryCode(email, entry) {
  recoveryCodes.set(String(email).trim().toLowerCase(), entry);
  saveRecoveryCodes();
}

function deleteRecoveryCode(email) {
  recoveryCodes.delete(String(email).trim().toLowerCase());
  saveRecoveryCodes();
}

function cleanupRecoveryCodes() {
  const now = Date.now();
  let changed = false;

  for (const [email, entry] of recoveryCodes.entries()) {
    if (!entry?.expires || entry.expires <= now) {
      recoveryCodes.delete(email);
      changed = true;
    }
  }

  if (changed) saveRecoveryCodes();
}

loadRecoveryCodes();


/* =========================================================
   FORGOT START
========================================================= */

app.post(
  "/api/forgot/start",
  async (req, res) => {
    try {
      const found =
        await resolveRecoveryEmail(
          req.body?.identifier,
          req.body?.mode ||
            "email"
        );

      if (!found) {
        return res.status(404).json({
          error:
            "Hesap bulunamadı."
        });
      }

      const code =
        String(
          Math.floor(
            100000 +
            Math.random() *
              900000
          )
        );

      setRecoveryCode(
        found.email.toLowerCase(),
        {
          code,
          expires:
            Date.now() +
            10 * 60 * 1000,
          profile:
            found.profile,
          authUserId:
            found.authUser?.id ||
            found.profile?.auth_user_id ||
            found.profile?.id ||
            null
        }
      );

      await sendMailGatewayEmail({
        to: found.email,
        subject: "Minegram doğrulama kodun",
        html: `<div style="font-family:Arial,sans-serif">
          <h2>Minegram</h2>
          <p>Şifre sıfırlama işlemin için doğrulama kodun:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px">
            ${code}
          </div>
          <p>Bu kod ${(Number(mailGatewayRuntime?.expiryMinutes) || 10)} dakika geçerlidir.</p>
        </div>`,
        text: `Minegram doğrulama kodun: ${code}\nBu kod ${(Number(mailGatewayRuntime?.expiryMinutes) || 10)} dakika geçerlidir.`
      });

      res.json({
        ok: true,
        email:
          found.email,
        maskedEmail:
          maskEmail(
            found.email
          )
      });
    } catch (e) {
      console.error(
        "FORGOT START ERROR:",
        e
      );

      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   PASSWORD RESET TOKEN STORAGE
========================================================= */
const passwordResetTokens = new Map();

function createPasswordResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function cleanupPasswordResetTokens() {
  const now = Date.now();
  for (const [token, entry] of passwordResetTokens.entries()) {
    if (!entry?.expires || entry.expires <= now) {
      passwordResetTokens.delete(token);
    }
  }
}

/* =========================================================
   FORGOT VERIFY
========================================================= */

app.post(
  "/api/forgot/verify",
  async (req, res) => {
    try {
      cleanupPasswordResetTokens();

      const identifier = String(
        req.body?.identifier ||
        req.body?.email ||
        req.body?.username ||
        ""
      ).trim();

      const mode = String(
        req.body?.mode || "email"
      ).trim().toLowerCase();

      const code = String(
        req.body?.code || ""
      ).replace(/\D/g, "").slice(0, 6);

      if (!identifier) {
        return res.status(400).json({
          ok: false,
          error: "Hesap bilgisi gerekli."
        });
      }

      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({
          ok: false,
          error: "6 haneli doğrulama kodunu gir."
        });
      }

      const found = await resolveRecoveryEmail(identifier, mode);

      if (!found?.email) {
        return res.status(400).json({
          ok: false,
          error: "Hesap bulunamadı."
        });
      }

      const email = String(found.email).trim().toLowerCase();
      cleanupRecoveryCodes();
      const entry = recoveryCodes.get(email);

      if (!entry) {
        return res.status(400).json({
          ok: false,
          error: "Aktif doğrulama kodu bulunamadı. Yeni kod iste."
        });
      }

      if (!entry.expires || entry.expires <= Date.now()) {
        deleteRecoveryCode(email);
        return res.status(400).json({
          ok: false,
          code: "CODE_EXPIRED",
          error: "Kodun süresi dolmuş. Yeni kod iste."
        });
      }

      if (entry.code !== code) {
        entry.attempts = Number(entry.attempts || 0) + 1;
        if (entry.attempts >= 5) {
          deleteRecoveryCode(email);
          return res.status(429).json({
            ok: false,
            code: "TOO_MANY_ATTEMPTS",
            error: "Çok fazla yanlış kod girildi. Yeni kod iste."
          });
        }
        setRecoveryCode(email, entry);
        return res.status(400).json({
          ok: false,
          code: "INVALID_CODE",
          error: "Kod yanlış veya süresi dolmuş."
        });
      }

      let authUserId =
        found.authUser?.id ||
        entry.authUserId ||
        found.profile?.auth_user_id ||
        found.profile?.id ||
        null;

      // Son güvenli fallback: Auth kullanıcılarını service-role ile
      // listeleyip doğrulanan e-posta ile eşleştir. Böylece profiles
      // kaydı eksik/uyumsuz olsa bile gerçek Auth hesabı bulunur.
      if (!authUserId && email.includes("@")) {
        try {
          let page = 1;
          const perPage = 1000;
          while (!authUserId && page <= 10) {
            const { data, error } =
              await admin.auth.admin.listUsers({
                page,
                perPage
              });

            if (error) {
              console.log("RECOVERY AUTH LIST HATASI:", error.message || error);
              break;
            }

            const users = Array.isArray(data?.users)
              ? data.users
              : [];

            const match = users.find(
              u => String(u?.email || "").trim().toLowerCase() === email
            );

            if (match?.id) {
              authUserId = match.id;
              break;
            }

            if (users.length < perPage) break;
            page += 1;
          }
        } catch (e) {
          console.log("RECOVERY AUTH LIST EXCEPTION:", e?.message || e);
        }
      }

      if (!authUserId && email.includes("@")) {
        try {
          const restUser = await findAuthUserByEmailExact(email);
          authUserId = restUser?.id || null;
        } catch (e) {
          console.log("RECOVERY VERIFY AUTH REST HATASI:", e?.message || e);
        }
      }

      if (!authUserId) {
        return res.status(400).json({
          ok: false,
          code: "AUTH_USER_NOT_FOUND",
          error: "Supabase hesap bilgisi bulunamadı.",
          detail: "Doğrulanan e-posta için Supabase Auth kullanıcısı bulunamadı."
        });
      }

      // Kullanıcı e-posta üzerinden 6 haneli kurtarma kodunu doğru
      // girdiğine göre e-posta sahipliğini doğrulamış kabul edilir.
      // Eski/yarım kalmış hesaplarda Supabase Auth tarafında
      // email_confirmed_at boş kalmışsa girişte "Email not confirmed"
      // hatası oluşmasını engellemek için burada da hesabı doğrula.
      try {
        const admin = adminClient();
        const { error: confirmError } =
          await admin.auth.admin.updateUserById(authUserId, {
            email_confirm: true
          });

        if (confirmError) {
          console.error(
            "RECOVERY EMAIL CONFIRM ERROR:",
            confirmError?.message || confirmError
          );
          return res.status(500).json({
            ok: false,
            code: "EMAIL_CONFIRM_FAILED",
            error: "E-posta doğrulaması tamamlanamadı. Lütfen tekrar deneyin."
          });
        }
      } catch (confirmException) {
        console.error(
          "RECOVERY EMAIL CONFIRM EXCEPTION:",
          confirmException?.message || confirmException
        );
        return res.status(500).json({
          ok: false,
          code: "EMAIL_CONFIRM_FAILED",
          error: "E-posta doğrulaması tamamlanamadı. Lütfen tekrar deneyin."
        });
      }

      const resetToken = createPasswordResetToken();
      passwordResetTokens.set(resetToken, {
        userId: authUserId,
        email,
        createdAt: Date.now(),
        expires: Date.now() + 10 * 60 * 1000
      });

      deleteRecoveryCode(email);

      const profile = entry.profile || found.profile || {};

      return res.json({
        ok: true,
        verified: true,
        resetToken,
        reset_token: resetToken,
        token: resetToken,
        email,
        account: {
          id: authUserId,
          username: profile.username || "minegram",
          email,
          displayName:
            profile.display_name ||
            profile.displayName ||
            profile.username ||
            ""
        }
      });
    } catch (e) {
      console.error("FORGOT VERIFY ERROR:", e);
      return res.status(400).json({
        ok: false,
        error: e?.message || "Kod doğrulanamadı."
      });
    }
  }
);

/* =========================================================
   RESET PASSWORD
========================================================= */
app.post(
  "/api/forgot/reset-password",
  async (req, res) => {
    try {
      cleanupPasswordResetTokens();

      const resetToken = String(
        req.body?.resetToken ||
        req.body?.reset_token ||
        req.body?.token ||
        ""
      ).trim();

      const password = String(
        req.body?.password ||
        req.body?.newPassword ||
        ""
      );

      const confirmPassword = String(
        req.body?.confirmPassword ||
        req.body?.passwordConfirm ||
        password
      );

      if (!resetToken) {
        return res.status(400).json({
          ok: false,
          error: "Şifre sıfırlama anahtarı gerekli."
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          ok: false,
          error: "Yeni şifre en az 6 karakter olmalı."
        });
      }

      if (password !== confirmPassword) {
        return res.status(400).json({
          ok: false,
          error: "Şifreler eşleşmiyor."
        });
      }

      const entry = passwordResetTokens.get(resetToken);
      if (!entry || !entry.userId || entry.expires <= Date.now()) {
        passwordResetTokens.delete(resetToken);
        return res.status(400).json({
          ok: false,
          error: "Şifre sıfırlama oturumu geçersiz veya süresi dolmuş."
        });
      }

      const admin = adminClient();
      const { data: userData, error: userError } =
        await admin.auth.admin.getUserById(entry.userId);

      if (userError || !userData?.user) {
        passwordResetTokens.delete(resetToken);
        return res.status(400).json({
          ok: false,
          error: "Supabase hesabı bulunamadı."
        });
      }

      const { error: updateError } =
        await admin.auth.admin.updateUserById(entry.userId, {
          password,
          email_confirm: true
        });

      if (updateError) throw updateError;

      passwordResetTokens.delete(resetToken);

      return res.json({
        ok: true,
        message: "Şifren başarıyla değiştirildi."
      });
    } catch (e) {
      console.error("RESET PASSWORD ERROR:", e);
      return res.status(400).json({
        ok: false,
        error: e?.message || "Şifre değiştirilemedi."
      });
    }
  }
);

/* =========================================================
   SEND RESET
========================================================= */

app.post(
  "/api/forgot/send-reset",
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email ||
          ""
        ).trim();

      if (!email) {
        return res.status(400).json({
          error:
            "E-posta gerekli."
        });
      }

      const anon =
        client();

      const {
        error
      } =
        await anon.auth.resetPasswordForEmail(
          email,
          {
            redirectTo:
              `${publicOrigin(req)}/`
          }
        );

      if (error) {
        return res.status(400).json({
          error:
            error.message
        });
      }

      res.json({
        ok: true
      });
    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   ME
========================================================= */

app.get(
  "/api/me",
  auth,
  (req, res) => {
    res.json(
      safeUser(
        req.user
      )
    );
  }
);


/* =========================================================
   ACCOUNT DELETE
   Hesabı Supabase tarafında tamamen temizler. Login/register
   akışına dokunmaz; yalnızca DELETE /api/account kullanır.
========================================================= */
app.delete(
  "/api/account",
  auth,
  async (req, res) => {
    // req.authUser.id = gerçek Supabase Auth kimliği.
    // req.user.id = profiles.id olabilir; legacy hesaplarda ikisi farklıdır.
    const authId = String(req.authUser?.id || "").trim();
    const profileId = String(req.user?.id || "").trim();

    if (!authId) {
      return res.status(401).json({ ok:false, error:"Oturum bulunamadı." });
    }

    try {
      const admin = adminClient();
      const ownerIds = [...new Set([authId, profileId].filter(Boolean))];

      // İki kimliğe de bağlı gönderileri bul. Böylece eski profile.id ile
      // oluşturulmuş gönderiler de hesap silinince kesin olarak gider.
      const { data: userPosts, error: postsReadError } = await admin
        .from("posts")
        .select("id,media_url,user_id")
        .in("user_id", ownerIds);
      if (postsReadError) throw postsReadError;

      const postIds = (userPosts || []).map(p => p.id).filter(Boolean);

      if (postIds.length) {
        for (const table of ["comments", "post_likes", "saves", "notifications"]) {
          const { error } = await admin.from(table).delete().in("post_id", postIds);
          if (error) console.warn(`ACCOUNT DELETE ${table}:`, error.message);
        }
      }

      const cleanup = [
        ["comments", "user_id"],
        ["post_likes", "user_id"],
        ["saves", "user_id"],
        ["notifications", "user_id"],
        ["notifications", "from_user_id"],
        ["follows", "follower_id"],
        ["follows", "following_id"],
        ["messages", "sender_id"],
        ["messages", "recipient_id"],
        ["stories", "user_id"],
        ["highlights", "user_id"],
        ["blocks", "blocker_id"],
        ["blocks", "blocked_id"]
      ];

      for (const [table, column] of cleanup) {
        try {
          const { error } = await admin.from(table).delete().in(column, ownerIds);
          if (error) console.warn(`ACCOUNT DELETE ${table}.${column}:`, error.message);
        } catch (e) {
          console.warn(`ACCOUNT DELETE ${table}.${column} EXCEPTION:`, e?.message || e);
        }
      }

      const { error: postsDeleteError } = await admin
        .from("posts")
        .delete()
        .in("user_id", ownerIds);
      if (postsDeleteError) throw postsDeleteError;

      // Storage'da hem Auth ID hem profile ID ile oluşturulmuş eski klasörleri temizle.
      for (const prefix of ["stories/", "highlights/", ""]) {
        for (const ownerId of ownerIds) {
          try {
            const pathPrefix = prefix === "" ? ownerId : `${prefix}${ownerId}`;
            const { data: objects, error: listError } = await admin.storage
              .from(BUCKET)
              .list(pathPrefix, { limit: 1000 });

            if (listError) {
              console.warn("ACCOUNT STORAGE LIST:", listError.message);
              continue;
            }

            const names = (objects || []).map(o => `${pathPrefix}/${o.name}`);
            if (names.length) {
              const { error: removeError } = await admin.storage
                .from(BUCKET)
                .remove(names);
              if (removeError) console.warn("ACCOUNT STORAGE REMOVE:", removeError.message);
            }
          } catch (e) {
            console.warn("ACCOUNT STORAGE EXCEPTION:", e?.message || e);
          }
        }
      }

      // Profil iki farklı kimlikten biriyle bağlı olabilir.
      const { error: profileError } = await admin
        .from("profiles")
        .delete()
        .or(`id.eq.${authId}${profileId && profileId !== authId ? `,id.eq.${profileId}` : ""},auth_user_id.eq.${authId}`);
      if (profileError) throw profileError;

      // ÖNEMLİ: Auth hesabı gerçek authId ile silinir.
      const { error: authDeleteError } = await admin.auth.admin.deleteUser(authId);
      if (authDeleteError) throw authDeleteError;

      activeAuthUserCache.delete(authId);
      if (profileId) activeAuthUserCache.delete(profileId);

      return res.json({ ok:true, deleted:true, id:authId });
    } catch (e) {
      console.error("ACCOUNT DELETE ERROR:", e);
      return res.status(500).json({
        ok:false,
        error:e?.message || "Hesap silinemedi."
      });
    }
  }
);


/* =========================================================
   FEED
========================================================= */

app.get(
  "/api/feed",
  auth,
  async (req, res) => {
    try {
      // Feed ortak web/Android kaynağıdır. Kullanıcı JWT'sinin RLS'i
      // başka kullanıcıların gönderilerini gizlemesin diye burada service-role
      // client kullanılır; sonuç yine aktif Auth kullanıcılarıyla filtrelenir.
      const feedSb = adminClient();
      const {
        data,
        error
      } =
        await feedSb
          .from("posts")
          .select("*")
          .order(
            "created_at",
            {
              ascending: false
            }
          )
          .limit(100);

      if (error) {
        throw error;
      }

      const activePosts = await filterActivePosts(data || []);
      const blockedIds = await blockedUserIdsFor(req.authUser.id);
      const visiblePosts = activePosts.filter(post => !blockedIds.has(String(post?.user_id)));

      // Feed ortak akış olduğu için hydrate işlemlerinde JWT/RLS client
      // kullanılmamalı. Aksi halde başka kullanıcının gönderisinin profili,
      // beğenileri veya yorumları RLS tarafından boş dönebilir ve Android
      // tarafında gönderi görünmüyor gibi davranabilir.
      const feedHydrateSb = adminClient();
      res.json(
        await hydratePosts(
          feedHydrateSb,
          visiblePosts,
          req.user.id
        )
      );
    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   HIGHLIGHTS — ANDROID + WEB ORTAK SİSTEM
========================================================= */
app.get(
  "/api/users/:username/highlights",
  auth,
  async (req, res) => {
    try {
      const target = await findProfile(req.sb, req.params.username);
      if (!target) {
        return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      }

      const targetId = target.auth_user_id || target.id;
      if (await isUserBlockedBy(targetId, req.authUser.id)) {
        return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      }

      const targetIsPrivate = !!(
        target.settings?.private_account ??
        target.settings?.privateAccount ??
        target.settings?.private
      );
      if (targetIsPrivate && String(target.id) !== String(req.user.id)) {
        const { data: allowedFollow } = await adminClient()
          .from("follows")
          .select("follower_id")
          .eq("follower_id", req.user.id)
          .eq("following_id", target.id)
          .maybeSingle();
        if (!allowedFollow) return res.json([]);
      }

      const highlightUserId = target.auth_user_id || target.id;
      const { data, error } = await adminClient()
        .from("highlights")
        .select("*")
        .eq("user_id", highlightUserId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) throw error;

      res.json((data || []).map(h => ({
        id: h.id,
        userId: h.user_id,
        media: h.media_url,
        mediaUrl: h.media_url,
        mediaType: h.media_type || "",
        title: h.title || "Öne çıkan",
        sortOrder: h.sort_order ?? 0,
        createdAt: h.created_at
      })));
    } catch (e) {
      console.error("HIGHLIGHTS GET ERROR:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.get(
  "/api/highlights",
  auth,
  async (req, res) => {
    try {
      const { data, error } = await req.sb
        .from("highlights")
        .select("*")
        .eq("user_id", req.user.id)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) throw error;
      res.json(data || []);
    } catch (e) {
      console.error("MY HIGHLIGHTS ERROR:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/api/highlights",
  auth,
  upload.single("media"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Öne çıkan için medya dosyası seçilmedi" });
      }

      const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
      const objectPath = `highlights/${req.user.id}/${crypto.randomUUID()}${ext}`;

      // Öne çıkan medya yüklemesi RLS'den etkilenmemesi için
      // yalnızca sunucu tarafındaki service-role client kullanılır.
      const admin = adminClient();

      const { error: uploadError } = await admin.storage
        .from(BUCKET)
        .upload(objectPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { data: publicData } = admin.storage
        .from(BUCKET)
        .getPublicUrl(objectPath);

      const title = String(req.body?.title || "Öne çıkan").trim().slice(0, 80) || "Öne çıkan";
      const requestedSort = Number(req.body?.sortOrder);
      const sortOrder = Number.isFinite(requestedSort) ? requestedSort : 0;

      // highlights INSERT işlemi de service-role client ile yapılır;
      // böylece profiles/highlights RLS politikası nedeniyle 42501 hatası oluşmaz.
      const { data, error } = await admin
        .from("highlights")
        .insert({
          user_id: req.user.id,
          media_url: publicData.publicUrl,
          media_type: req.file.mimetype,
          title,
          sort_order: sortOrder
        })
        .select("*")
        .single();

      if (error) throw error;

      res.json({
        ok: true,
        id: data.id,
        userId: data.user_id,
        media: data.media_url,
        mediaUrl: data.media_url,
        mediaType: data.media_type,
        title: data.title,
        sortOrder: data.sort_order ?? 0,
        createdAt: data.created_at
      });
    } catch (e) {
      console.error("HIGHLIGHT CREATE ERROR:", e);
      res.status(400).json({ error: e.message });
    }
  }
);

/* =========================================================
   HIGHLIGHT DELETE / UPDATE
========================================================= */
app.delete(
  "/api/highlights/:id",
  auth,
  async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const admin = adminClient();
      const { data: item, error: readError } = await admin
        .from("highlights")
        .select("id,user_id,media_url")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw readError;
      if (!item) return res.status(404).json({ ok:false, error:"Öne çıkan bulunamadı." });
      if (String(item.user_id) !== String(req.user.id)) return res.status(403).json({ ok:false, error:"Bu öne çıkanı silemezsin." });

      const { error: deleteError } = await admin.from("highlights").delete().eq("id", id).eq("user_id", req.user.id);
      if (deleteError) throw deleteError;

      try {
        const mediaUrl = String(item.media_url || "");
        const marker = `/storage/v1/object/public/${BUCKET}/`;
        const at = mediaUrl.indexOf(marker);
        if (at >= 0) {
          const objectPath = decodeURIComponent(mediaUrl.slice(at + marker.length));
          if (objectPath) await admin.storage.from(BUCKET).remove([objectPath]);
        }
      } catch (e) { console.warn("HIGHLIGHT MEDIA DELETE:", e?.message || e); }

      return res.json({ ok:true, deleted:true, id });
    } catch (e) {
      console.error("HIGHLIGHT DELETE ERROR:", e);
      return res.status(500).json({ ok:false, error:e?.message || "Öne çıkan silinemedi." });
    }
  }
);

app.patch(
  "/api/highlights/:id",
  auth,
  async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const title = String(req.body?.title || "").trim().slice(0, 80);
      if (!title) return res.status(400).json({ ok:false, error:"Öne çıkan adı gerekli." });
      const admin = adminClient();
      const { data, error } = await admin.from("highlights")
        .update({ title })
        .eq("id", id)
        .eq("user_id", req.user.id)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ ok:false, error:"Öne çıkan bulunamadı." });
      return res.json({ ok:true, id:data.id, title:data.title });
    } catch (e) {
      return res.status(500).json({ ok:false, error:e?.message || "Öne çıkan güncellenemedi." });
    }
  }
);

/* =========================================================
   CREATE POST
========================================================= */

app.post(
  "/api/posts",
  auth,
  upload.single("media"),
  async (req, res) => {
    try {
      let mediaUrl =
        null;

      let mediaName =
        null;

      let mediaType =
        null;

      if (req.file) {
        const ext =
          path.extname(
            req.file.originalname
          ).toLowerCase() ||
          ".bin";

        const objectPath =
          `${req.user.id}/${crypto.randomUUID()}${ext}`;

        const {
          error: uploadError
        } =
          await req.sb.storage
            .from(BUCKET)
            .upload(
              objectPath,
              req.file.buffer,
              {
                contentType:
                  req.file.mimetype,
                upsert:
                  false
              }
            );

        if (uploadError) {
          throw uploadError;
        }

        const {
          data: publicData
        } =
          req.sb.storage
            .from(BUCKET)
            .getPublicUrl(
              objectPath
            );

        mediaUrl =
          publicData.publicUrl;

        mediaName =
          req.file.originalname;

        mediaType =
          req.file.mimetype;
      }

      const postsSb = adminClient();

      const {
        data,
        error
      } =
        await postsSb
          .from("posts")
          .insert({
            user_id:
              req.authUser.id,

            caption:
              req.body?.caption ||
              "",

            media_url:
              mediaUrl,

            media_name:
              mediaName,

            media_type:
              mediaType
          })
          .select("*")
          .single();

      if (error) {
        throw error;
      }

      res.json({
        ...data,

        id:
          data.id,

        userId:
          data.user_id,

        media:
          data.media_url,

        mediaName:
          data.media_name,

        createdAt:
          data.created_at
      });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   DELETE POST
   Kullanıcının kendi gönderisini GERÇEKTEN veritabanından siler.
   Böylece /api/users/:username/posts tekrar çağrıldığında gönderi
   profil gridine geri dönemez.
========================================================= */
app.delete(
  "/api/posts/:id",
  auth,
  async (req, res) => {
    try {
      const postId = String(req.params.id || "").trim();
      if (!postId) {
        return res.status(400).json({
          ok: false,
          error: "Gönderi kimliği gerekli."
        });
      }

      // Önce gönderinin gerçekten giriş yapan kullanıcıya ait olduğunu doğrula.
      const { data: post, error: postError } = await req.sb
        .from("posts")
        .select("id,user_id,media_url")
        .eq("id", postId)
        .maybeSingle();

      if (postError) throw postError;

      if (!post) {
        return res.status(404).json({
          ok: false,
          error: "Gönderi bulunamadı."
        });
      }

      if (String(post.user_id) !== String(req.user.id)) {
        return res.status(403).json({
          ok: false,
          error: "Bu gönderiyi silme yetkin yok."
        });
      }

      // Service-role ile silme: RLS/policy yüzünden silmenin yarım kalmasını önler.
      const admin = adminClient();

      // Gönderiye bağlı verileri önce temizle. Tablolardan biri mevcut değilse
      // ana gönderinin silinmesini engellememesi için best-effort çalışır.
      const cleanupTables = [
        "comments",
        "post_likes",
        "saves",
        "notifications"
      ];

      for (const table of cleanupTables) {
        try {
          const { error } = await admin
            .from(table)
            .delete()
            .eq("post_id", postId);

          if (error) {
            console.warn(
              `POST DELETE ${table} CLEANUP WARNING:`,
              error.message
            );
          }
        } catch (cleanupError) {
          console.warn(
            `POST DELETE ${table} CLEANUP EXCEPTION:`,
            cleanupError?.message || cleanupError
          );
        }
      }

      // Asıl kayıt: gönderi artık Supabase posts tablosundan da kaldırılır.
      const { error: deleteError } = await admin
        .from("posts")
        .delete()
        .eq("id", postId)
        .eq("user_id", req.user.id);

      if (deleteError) throw deleteError;

      // Supabase Storage'daki medya dosyasını da kaldırmayı dene.
      // DB kaydının silinmesi medya silme hatası yüzünden geri alınmaz.
      try {
        const mediaUrl = String(post.media_url || "").trim();
        const marker = `/storage/v1/object/public/${BUCKET}/`;
        const index = mediaUrl.indexOf(marker);

        if (index >= 0) {
          const objectPath = decodeURIComponent(
            mediaUrl.slice(index + marker.length)
          );

          if (objectPath) {
            const { error: storageError } = await admin.storage
              .from(BUCKET)
              .remove([objectPath]);

            if (storageError) {
              console.warn(
                "POST MEDIA DELETE WARNING:",
                storageError.message
              );
            }
          }
        }
      } catch (storageError) {
        console.warn(
          "POST MEDIA DELETE EXCEPTION:",
          storageError?.message || storageError
        );
      }

      return res.json({
        ok: true,
        deleted: true,
        id: postId
      });
    } catch (e) {
      console.error("DELETE POST ERROR:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message || "Gönderi silinemedi."
      });
    }
  }
);


/* =========================================================
   DELETE POST BY MEDIA URL
========================================================= */
app.delete(
  "/api/posts/delete-by-media",
  auth,
  async (req, res) => {
    try {
      const mediaUrl = String(req.query?.media || "").trim();
      if (!mediaUrl) return res.status(400).json({ ok:false, error:"Gönderi medya bağlantısı gerekli." });

      const admin = adminClient();
      // Önce medya URL'siyle bul. user_id kolonunun şeması UUID/int olsa bile
      // burada Supabase'e yanlış tip göndermeyelim; sahipliği JavaScript tarafında
      // güvenli şekilde karşılaştırıyoruz.
      const { data: post, error: findError } = await admin
        .from("posts")
        .select("id,user_id,media_url")
        .eq("media_url", mediaUrl)
        .maybeSingle();

      if (findError) throw findError;
      if (!post) return res.status(404).json({ ok:false, error:"Gönderi bulunamadı." });

      const ownerId = String(post.user_id || "").trim();
      const authId = String(req.authUser?.id || "").trim();
      const profileId = String(req.user?.id || "").trim();
      const profileAuthId = String(req.user?.auth_user_id || "").trim();

      if (!ownerId || (ownerId !== authId && ownerId !== profileId && ownerId !== profileAuthId)) {
        return res.status(403).json({ ok:false, error:"Bu gönderiyi silme yetkin yok." });
      }

      const postId = String(post.id).trim();
      if (!postId) return res.status(400).json({ ok:false, error:"Geçersiz gönderi kimliği." });
      for (const table of ["comments", "post_likes", "saves", "notifications"]) {
        try { await admin.from(table).delete().eq("post_id", postId); } catch (_) {}
      }

      const { error: deleteError } = await admin
        .from("posts")
        .delete()
        .eq("id", postId);
      if (deleteError) throw deleteError;

      try {
        const marker = `/storage/v1/object/public/${BUCKET}/`;
        const index = mediaUrl.indexOf(marker);
        if (index >= 0) {
          const objectPath = decodeURIComponent(mediaUrl.slice(index + marker.length));
          if (objectPath) await admin.storage.from(BUCKET).remove([objectPath]);
        }
      } catch (_) {}

      return res.json({ ok:true, deleted:true, id:postId });
    } catch (e) {
      console.error("DELETE POST BY MEDIA ERROR:", e);
      return res.status(500).json({ ok:false, error:e?.message || "Gönderi silinemedi." });
    }
  }
);


/* =========================================================
   LIVE STREAMS
========================================================= */

app.post(
  "/api/live/start",
  auth,
  async (req, res) => {
    try {
      const username = req.user.username || "Kullanıcı";
      const title = String(req.body?.title || "").trim();
      const live = {
        userId: req.user.id,
        username,
        title,
        startedAt: new Date().toISOString()
      };
      activeMinegramLives.set(String(req.user.id), live);

      const admin = adminClient();
      const { data: followers, error: followerError } = await admin
        .from("follows")
        .select("follower_id")
        .eq("following_id", req.user.id);
      if (followerError) throw followerError;

      // Public hesapta takip edenlere; gizli hesapta ise zaten onaylanmış
      // takipçilere bildirim gider. Takip ilişkisi onaylanmış olmanın kanıtıdır.
      const recipients = [...new Set((followers || []).map(x => x.follower_id).filter(Boolean))];
      for (const followerId of recipients) {
        await addNotification({
          userId: followerId,
          fromUserId: req.user.id,
          type: "live_started",
          text: `🔴 @${username} canlı yayın başlattı`
        });
      }

      return res.json({ ok: true, live });
    } catch (e) {
      return res.status(400).json({ error: e?.message || "Canlı yayın başlatılamadı" });
    }
  }
);

app.post(
  "/api/live/end",
  auth,
  async (req, res) => {
    activeMinegramLives.delete(String(req.user.id));
    return res.json({ ok: true });
  }
);

app.get(
  "/api/live",
  auth,
  async (req, res) => {
    try {
      const admin = adminClient();
      const { data: followingRows, error } = await admin
        .from("follows")
        .select("following_id")
        .eq("follower_id", req.user.id);
      if (error) throw error;

      const allowed = new Set([String(req.user.id), ...(followingRows || []).map(x => String(x.following_id))]);
      const lives = [...activeMinegramLives.values()]
        .filter(live => allowed.has(String(live.userId)))
        .map(live => ({ ...live }));
      return res.json(lives);
    } catch (e) {
      return res.status(400).json({ error: e?.message || "Canlı yayınlar alınamadı" });
    }
  }
);


/* =========================================================
   STORIES CREATE
========================================================= */

app.post(
  "/api/stories",
  auth,
  upload.single("story"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "Dosya seçilmedi"
        });
      }

      const ext =
        path.extname(
          req.file.originalname
        ) || ".bin";

      const objectPath =
        `stories/${req.user.id}/${crypto.randomUUID()}${ext}`;

      // Hikaye dosyasını service-role ile yükle.
      // Böylece Storage RLS politikası kullanıcı tokenından bağımsız çalışır.
      const admin = adminClient();

      const {
        error: uploadError
      } =
        await admin.storage
          .from(BUCKET)
          .upload(
            objectPath,
            req.file.buffer,
            {
              contentType:
                req.file.mimetype,
              upsert:
                false
            }
          );

      if (uploadError) {
        throw uploadError;
      }

      const {
        data: publicData
      } =
        admin.storage
          .from(BUCKET)
          .getPublicUrl(
            objectPath
          );

      // Hikaye DB kaydını da service-role ile oluştur.
      // Böylece stories INSERT RLS politikası nedeniyle 400 oluşmaz.
      const result =
        await admin
          .from("stories")
          .insert({
            user_id:
              req.user.id,

            media_url:
              publicData.publicUrl,

            media_type:
              req.file.mimetype
          })
          .select()
          .single();

      if (result.error) {
        throw result.error;
      }

      res.json(
        result.data
      );

    } catch (e) {
      console.error(
        "STORY ERROR:",
        e
      );

      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   STORIES
========================================================= */

app.get(
  "/api/stories",
  auth,
  async (req, res) => {
    try {
      const yesterday =
        new Date(
          Date.now() -
          86400000
        ).toISOString();

      const {
        data,
        error
      } =
        await adminClient()
          .from("stories")
          .select(`
            *,
            profiles(
              username,
              display_name,
              avatar_url,
              settings
            )
          `)
          .gte(
            "created_at",
            yesterday
          )
          .order(
            "created_at",
            {
              ascending: true
            }
          );

      if (error) {
        return res.status(400).json({
          error:
            error.message
        });
      }

      const activeStories = await filterActiveStories(data || []);
      const storyUserIds = [...new Set(activeStories.map(s => s?.user_id).filter(Boolean))];
      const allowedFollowing = new Set();
      if (storyUserIds.length) {
        const { data: followed } = await adminClient()
          .from("follows")
          .select("following_id")
          .eq("follower_id", req.user.id)
          .in("following_id", storyUserIds);
        (followed || []).forEach(f => allowedFollowing.add(String(f.following_id)));
      }
      const blockedIds = await blockedUserIdsFor(req.authUser.id);
      const visibleStories = activeStories.filter(story => {
        if (blockedIds.has(String(story?.user_id))) return false;
        const profile = Array.isArray(story.profiles) ? story.profiles[0] : story.profiles;
        const settings = profile?.settings || {};
        const isPrivate = !!(settings.private_account ?? settings.privateAccount ?? settings.private);
        if (!isPrivate) return true;
        return String(story.user_id) === String(req.user.id) || allowedFollowing.has(String(story.user_id));
      });

      res.json(visibleStories);
    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   STORY DELETE
========================================================= */
app.delete(
  "/api/stories/:id",
  auth,
  async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const admin = adminClient();
      const { data: story, error: readError } = await admin
        .from("stories")
        .select("id,user_id,media_url")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw readError;
      if (!story) return res.status(404).json({ ok:false, error:"Hikaye bulunamadı." });
      if (String(story.user_id) !== String(req.user.id)) return res.status(403).json({ ok:false, error:"Bu hikayeyi silemezsin." });

      const { error: deleteError } = await admin.from("stories").delete().eq("id", id).eq("user_id", req.user.id);
      if (deleteError) throw deleteError;

      try {
        const mediaUrl = String(story.media_url || "");
        const marker = `/storage/v1/object/public/${BUCKET}/`;
        const at = mediaUrl.indexOf(marker);
        if (at >= 0) {
          const objectPath = decodeURIComponent(mediaUrl.slice(at + marker.length));
          if (objectPath) await admin.storage.from(BUCKET).remove([objectPath]);
        }
      } catch (e) { console.warn("STORY MEDIA DELETE:", e?.message || e); }

      return res.json({ ok:true, deleted:true, id });
    } catch (e) {
      console.error("STORY DELETE ERROR:", e);
      return res.status(500).json({ ok:false, error:e?.message || "Hikaye silinemedi." });
    }
  }
);

/* =========================================================
   LIKE
========================================================= */

app.post(
  "/api/posts/:id/like",
  auth,
  async (req, res) => {
    try {
      const {
        data: existing
      } =
        await req.sb
          .from("post_likes")
          .select("post_id")
          .eq(
            "post_id",
            req.params.id
          )
          .eq(
            "user_id",
            req.user.id
          )
          .maybeSingle();

      if (existing) {
        await req.sb
          .from("post_likes")
          .delete()
          .eq(
            "post_id",
            req.params.id
          )
          .eq(
            "user_id",
            req.user.id
          );

        return res.json({
          liked: false
        });
      }

      const {
        error
      } =
        await req.sb
          .from("post_likes")
          .insert({
            post_id:
              req.params.id,

            user_id:
              req.user.id
          });

      if (error) {
        throw error;
      }

      const {
        data: post
      } =
        await req.sb
          .from("posts")
          .select("user_id")
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (post) {
        await addNotification({
          userId:
            post.user_id,

          fromUserId:
            req.user.id,

          type:
            "like",

          postId:
            req.params.id,

          text:
            `@${req.user.username} beğendi`
        });
      }

      res.json({
        liked: true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   COMMENTS
========================================================= */


app.get(
  "/api/posts/:id/comments",
  auth,
  async (req, res) => {
    try {
      const admin = adminClient();

      // Yorumları doğrudan comments tablosundan oku.
      // Profil JOIN'i eski kayıtlar / foreign-key farkları yüzünden
      // yorum listesinin tamamını bozmasın.
      const { data, error } = await admin
        .from("comments")
        .select("id,post_id,user_id,text,created_at")
        .eq("post_id", req.params.id)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const userIds = [...new Set(
        (data || [])
          .map(x => String(x.user_id || "").trim())
          .filter(Boolean)
      )];

      let profiles = [];
      if (userIds.length) {
        // Önce id üzerinden; auth_user_id kullanılan eski hesapları da destekle.
        const { data: rows } = await admin
          .from("profiles")
          .select("id,auth_user_id,username,display_name,avatar_url")
          .in("id", userIds);
        profiles = rows || [];

        const missing = userIds.filter(id =>
          !profiles.some(p => String(p.id || "") === id || String(p.auth_user_id || "") === id)
        );
        if (missing.length) {
          const { data: authRows } = await admin
            .from("profiles")
            .select("id,auth_user_id,username,display_name,avatar_url")
            .in("auth_user_id", missing);
          profiles.push(...(authRows || []));
        }
      }

      const profileMap = new Map();
      for (const profile of profiles) {
        if (profile?.id != null) profileMap.set(String(profile.id), profile);
        if (profile?.auth_user_id != null) profileMap.set(String(profile.auth_user_id), profile);
      }

      const comments = (data || []).map(item => {
        const profile = profileMap.get(String(item.user_id || "")) || {};
        const createdAtMs = item.created_at
          ? new Date(item.created_at).getTime()
          : Date.now();
        return {
          id: item.id,
          postId: item.post_id,
          userId: item.user_id,
          text: item.text || "",
          createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
          username: profile.username || "",
          displayName: profile.display_name || profile.username || "",
          avatar: profile.avatar_url || ""
        };
      });

      res.json({
        comments,
        commentCount: comments.length
      });
    } catch (e) {
      res.status(400).json({
        error: e.message
      });
    }
  }
);


app.post(
  "/api/posts/:id/comments",
  auth,
  async (req, res) => {
    try {
      const text =
        String(
          req.body?.text ||
          ""
        ).trim();

      if (!text) {
        return res.status(400).json({
          error:
            "Yorum boş olamaz"
        });
      }

      const {
        data,
        error
      } =
        await req.sb
          .from("comments")
          .insert({
            post_id:
              req.params.id,

            user_id:
              req.user.id,

            text
          })
          .select("*")
          .single();

      if (error) {
        throw error;
      }

      const {
        data: post
      } =
        await req.sb
          .from("posts")
          .select("user_id")
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (post) {
        await addNotification({
          userId:
            post.user_id,

          fromUserId:
            req.user.id,

          type:
            "comment",

          postId:
            req.params.id,

          text:
            `@${req.user.username} yorum yaptı`
        });
      }

      const { count: commentCount, error: countError } = await adminClient()
        .from("comments")
        .select("id", { count: "exact", head: true })
        .eq("post_id", req.params.id);

      if (countError) throw countError;

      res.json({
        ok: true,
        id: data.id,
        postId: data.post_id,
        userId: data.user_id,
        text: data.text,
        createdAt: data.created_at,
        username: req.user.username || "",
        displayName: req.user.display_name || req.user.username || "",
        avatar: req.user.avatar_url || "",
        commentCount: Number(commentCount || 0)
      });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   SAVE
========================================================= */

app.post(
  "/api/posts/:id/save",
  auth,
  async (req, res) => {
    try {
      const {
        data: existing
      } =
        await req.sb
          .from("saves")
          .select("post_id")
          .eq(
            "post_id",
            req.params.id
          )
          .eq(
            "user_id",
            req.user.id
          )
          .maybeSingle();

      if (existing) {
        await req.sb
          .from("saves")
          .delete()
          .eq(
            "post_id",
            req.params.id
          )
          .eq(
            "user_id",
            req.user.id
          );

        return res.json({
          saved: false
        });
      }

      const {
        error
      } =
        await req.sb
          .from("saves")
          .insert({
            post_id:
              req.params.id,

            user_id:
              req.user.id
          });

      if (error) {
        throw error;
      }

      res.json({
        saved: true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   SAVED
========================================================= */

app.get(
  "/api/saved",
  auth,
  async (req, res) => {
    try {
      const {
        data: saves,
        error
      } =
        await req.sb
          .from("saves")
          .select(
            "post_id,created_at"
          )
          .eq(
            "user_id",
            req.user.id
          )
          .order(
            "created_at",
            {
              ascending:
                false
            }
          );

      if (error) {
        throw error;
      }

      const ids =
        (saves || [])
          .map(
            x => x.post_id
          );

      if (!ids.length) {
        return res.json([]);
      }

      const {
        data: posts,
        error: pError
      } =
        await req.sb
          .from("posts")
          .select("*")
          .in(
            "id",
            ids
          );

      if (pError) {
        throw pError;
      }

      const hydrated =
        await hydratePosts(
          req.sb,
          posts || [],
          req.user.id
        );

      res.json(
        hydrated.sort(
          (a, b) =>
            ids.indexOf(a.id) -
            ids.indexOf(b.id)
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get(
  "/api/notifications",
  auth,
  async (req, res) => {
    try {
      const {
        data,
        error
      } =
        await adminClient()
          .from("notifications")
          .select("*")
          .eq(
            "user_id",
            req.user.id
          )
          .order(
            "created_at",
            {
              ascending:
                false
            }
          )
          .limit(50);

      if (error) {
        throw error;
      }

      res.json(
        (data || []).map(
          n => ({
            id:
              n.id,

            type:
              n.type,

            text:
              n.text,

            read:
              n.read,

            createdAt:
              n.created_at
          })
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);

app.post(
  "/api/notifications/read",
  auth,
  async (req, res) => {
    try {
      await req.sb
        .from("notifications")
        .update({
          read: true
        })
        .eq(
          "user_id",
          req.user.id
        );

      res.json({
        ok: true
      });
    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   FOLLOW
========================================================= */

app.post(
  "/api/users/:username/follow",
  auth,
  async (req, res) => {
    try {
      const target =
        await findProfile(
          req.sb,
          req.params.username
        );

      if (!target) {
        return res.status(404).json({
          error:
            "Kullanıcı bulunamadı"
        });
      }

      if (!(await isAuthUserActive(target.auth_user_id || target.id))) {
        return res.status(404).json({
          error: "Kullanıcı bulunamadı"
        });
      }

      if (await isBlockedEitherWay(req.authUser.id, target.auth_user_id || target.id)) {
        return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      }

      if (
        (target.auth_user_id || target.id) ===
        req.user.id
      ) {
        return res.status(400).json({
          error:
            "Kendini takip edemezsin"
        });
      }

      const followAdmin = adminClient();
      const targetUserId = target.auth_user_id || target.id;

      const {
        data: existing
      } =
        await followAdmin
          .from("follows")
          .select(
            "follower_id,following_id"
          )
          .eq(
            "follower_id",
            req.user.id
          )
          .eq(
            "following_id",
            targetUserId
          )
          .maybeSingle();

      if (existing) {
        await followAdmin
          .from("follows")
          .delete()
          .eq(
            "follower_id",
            req.user.id
          )
          .eq(
            "following_id",
            targetUserId
          );

        return res.json({
          following:
            false
        });
      }

      const settings = target.settings || {};
      const isPrivate = !!(
        settings.private_account ??
        settings.privateAccount ??
        settings.private
      );

      if (isPrivate) {
        const admin = adminClient();
        const { data: existingRequest } = await admin
          .from("notifications")
          .select("id")
          .eq("user_id", targetUserId)
          .eq("from_user_id", req.user.id)
          .eq("type", "follow_request")
          .eq("read", false)
          .maybeSingle();

        if (existingRequest) return res.json({ following: false, pending: true });

        await addNotification({
          userId: targetUserId,
          fromUserId: req.user.id,
          type: "follow_request",
          text: `@${req.user.username} sana takip isteği gönderdi`
        });
        return res.json({ following: false, pending: true });
      }

      const { error } = await followAdmin
        .from("follows")
        .insert({
          follower_id: req.user.id,
          following_id: targetUserId
        });
      if (error) throw error;

      await addNotification({
        userId: targetUserId,
        fromUserId: req.user.id,
        type: "follow",
        text: `@${req.user.username} seni takip etti`
      });

      res.json({ following: true, pending: false });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   FOLLOWERS / FOLLOWING LIST
   Profil sayısının yanında gerçek kullanıcı listesini de döndürür.
   Mevcut takip sistemini değiştirmez; yalnızca okuma endpoint'leri ekler.
========================================================= */

async function getFollowListForProfile(req, res, type) {
  try {
    const target = await findProfile(
      req.sb,
      req.params.username
    );

    if (!target) {
      return res.status(404).json({
        error: "Kullanıcı bulunamadı"
      });
    }

    const admin = adminClient();

    // Yeni hesaplarda follows.auth tarafında auth_user_id,
    // eski kayıtlarda profiles.id kullanılmış olabilir.
    const targetIds = [
      target.auth_user_id,
      target.id
    ]
      .filter(Boolean)
      .map(String);

    const uniqueTargetIds = [...new Set(targetIds)];

    if (!uniqueTargetIds.length) {
      return res.json([]);
    }

    const column =
      type === "followers"
        ? "following_id"
        : "follower_id";

    const { data: followRows, error: followError } = await admin
      .from("follows")
      .select("follower_id,following_id")
      .in(column, uniqueTargetIds);

    if (followError) {
      throw followError;
    }

    const rows = Array.isArray(followRows)
      ? followRows
      : [];

    const userIds = rows
      .map(row =>
        type === "followers"
          ? row.follower_id
          : row.following_id
      )
      .filter(Boolean)
      .map(String);

    const uniqueUserIds = [...new Set(userIds)];

    if (!uniqueUserIds.length) {
      return res.json([]);
    }

    const byIdResult = await admin
      .from("profiles")
      .select("id,auth_user_id,username,display_name,bio,avatar_url,verified,settings")
      .in("id", uniqueUserIds);

    if (byIdResult.error) {
      throw byIdResult.error;
    }

    const profiles = [
      ...(byIdResult.data || [])
    ];

    try {
      const missingIds = uniqueUserIds.filter(id =>
        !profiles.some(p =>
          String(p.id || "") === id ||
          String(p.auth_user_id || "") === id
        )
      );

      if (missingIds.length) {
        const byAuthResult = await admin
          .from("profiles")
          .select("id,auth_user_id,username,display_name,bio,avatar_url,verified,settings")
          .in("auth_user_id", missingIds);

        if (!byAuthResult.error) {
          profiles.push(...(byAuthResult.data || []));
        }
      }
    } catch (_) {}

    const profileMap = new Map();

    for (const profile of profiles) {
      const id = String(profile.id || "");
      const authId = String(profile.auth_user_id || "");

      if (id) profileMap.set(id, profile);
      if (authId) profileMap.set(authId, profile);
    }

    const orderedProfiles = [];

    for (const id of userIds) {
      const profile = profileMap.get(String(id));

      if (!profile) continue;

      const alreadyAdded = orderedProfiles.some(
        p => String(p.id || "") === String(profile.id || "")
      );

      if (alreadyAdded) continue;

      orderedProfiles.push(profile);
    }

    const activeProfiles =
      await filterActiveProfiles(orderedProfiles);

    const viewerFollowing = new Set();

    if (uniqueUserIds.length && req.user?.id) {
      const { data: viewerRows, error: viewerError } = await admin
        .from("follows")
        .select("following_id")
        .eq("follower_id", req.user.id)
        .in("following_id", uniqueUserIds);

      if (!viewerError) {
        for (const row of viewerRows || []) {
          if (row?.following_id) {
            viewerFollowing.add(
              String(row.following_id)
            );
          }
        }
      }
    }

    return res.json(
      activeProfiles.map(profile => {
        const profileId =
          String(profile.id || "");

        const authId =
          String(profile.auth_user_id || "");

        return {
          ...safeUser(profile),
          followingByMe:
            viewerFollowing.has(profileId) ||
            viewerFollowing.has(authId)
        };
      })
    );

  } catch (e) {
    console.error(
      `FOLLOW ${type.toUpperCase()} LIST ERROR:`,
      e?.message || e
    );

    return res.status(500).json({
      error:
        e?.message ||
        "Takip listesi alınamadı"
    });
  }
}

app.get(
  "/api/users/:username/followers",
  auth,
  async (req, res) => {
    return getFollowListForProfile(
      req,
      res,
      "followers"
    );
  }
);

app.get(
  "/api/users/:username/following",
  auth,
  async (req, res) => {
    return getFollowListForProfile(
      req,
      res,
      "following"
    );
  }
);


/* =========================================================
   FOLLOW REQUESTS
========================================================= */

app.post("/api/follow-requests/accept", auth, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    if (!username) return res.status(400).json({ error: "Kullanıcı gerekli" });
    const requester = await findProfile(req.sb, username);
    if (!requester) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

    const admin = adminClient();
    const { data: request, error: requestError } = await admin
      .from("notifications")
      .select("id,from_user_id,user_id")
      .eq("user_id", req.user.id)
      .eq("from_user_id", requester.id)
      .eq("type", "follow_request")
      .eq("read", false)
      .maybeSingle();
    if (requestError) throw requestError;
    if (!request) return res.status(404).json({ error: "Bekleyen takip isteği bulunamadı" });

    const { data: existingFollow } = await admin.from("follows")
      .select("follower_id,following_id")
      .eq("follower_id", requester.id)
      .eq("following_id", req.user.id)
      .maybeSingle();
    if (!existingFollow) {
      const { error: followError } = await admin.from("follows").insert({
        follower_id: requester.id,
        following_id: req.user.id
      });
      if (followError && !String(followError.message || "").toLowerCase().includes("duplicate")) throw followError;
    }

    await admin.from("notifications").update({ read: true }).eq("id", request.id);
    await addNotification({
      userId: requester.id,
      fromUserId: req.user.id,
      type: "follow_accepted",
      text: `@${req.user.username} takip isteğini kabul etti. Sen de takip et.`
    });
    return res.json({ ok: true, accepted: true, username: req.user.username });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Takip isteği onaylanamadı" });
  }
});

app.post("/api/follow-requests/reject", auth, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    if (!username) return res.status(400).json({ error: "Kullanıcı gerekli" });
    const requester = await findProfile(req.sb, username);
    if (!requester) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

    const admin = adminClient();
    const { data: request, error: requestError } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("from_user_id", requester.id)
      .eq("type", "follow_request")
      .eq("read", false)
      .maybeSingle();
    if (requestError) throw requestError;
    if (!request) return res.status(404).json({ error: "Bekleyen takip isteği bulunamadı" });

    await admin.from("notifications").update({ read: true }).eq("id", request.id);
    return res.json({ ok: true, rejected: true });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Takip isteği reddedilemedi" });
  }
});


/* =========================================================
   USER POSTS
========================================================= */

app.get(
  "/api/users/:username/posts",
  auth,
  async (req, res) => {
    try {
      const target =
        await findProfile(
          req.sb,
          req.params.username
        );

      if (!target) {
        return res.status(404).json({
          error:
            "Kullanıcı bulunamadı"
        });
      }

      if (!(await isAuthUserActive(target.auth_user_id || target.id))) {
        return res.status(404).json({
          error: "Kullanıcı bulunamadı"
        });
      }

      const targetIsPrivate = !!(
        target.settings?.private_account ??
        target.settings?.privateAccount ??
        target.settings?.private
      );
      if (targetIsPrivate && String(target.id) !== String(req.user.id)) {
        const { data: allowedFollow } = await adminClient()
          .from("follows")
          .select("follower_id")
          .eq("follower_id", req.user.id)
          .eq("following_id", target.id)
          .maybeSingle();
        if (!allowedFollow) return res.json([]);
      }

      const postsSb = adminClient();

      // Eski gönderiler profiles.id, yeni gönderiler auth_user_id
      // ile kaydedilmiş olabilir. İki kimliği de kontrol ederek profil
      // ekranında hiçbir gönderinin tekrar giriş/geri dönüşte kaybolmamasını sağla.
      const ownerIds = [
        target.id,
        target.auth_user_id
      ]
        .filter(Boolean)
        .map(String);

      const {
        data,
        error
      } =
        await postsSb
          .from("posts")
          .select("*")
          .in("user_id", ownerIds)
          .order(
            "created_at",
            {
              ascending: false
            }
          );

      if (error) {
        throw error;
      }

      // target profili zaten aktif Auth hesabına sahip. Bu endpoint yalnızca
      // target kullanıcısının iki olası owner ID'sinden gelen gönderileri
      // aldığı için burada tekrar user_id ile filtreleyip eski kayıtları
      // düşürme.
      const profilePosts = Array.isArray(data) ? data : [];

      res.json(
        await hydratePosts(
          postsSb,
          profilePosts,
          req.user.id
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   USER PROFILE
========================================================= */

app.get(
  "/api/users/:username",
  auth,
  async (req, res) => {
    try {
      const target =
        await findProfile(
          req.sb,
          req.params.username
        );

      if (!target) {
        return res.status(404).json({
          error:
            "Kullanıcı bulunamadı"
        });
      }

      const targetId = target.auth_user_id || target.id;
      if (await isUserBlockedBy(targetId, req.authUser.id)) {
        return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      }

      const [
        postCountResult,
        followersResult,
        followingResult,
        followingByMeResult
      ] =
        await Promise.all([
          req.sb
            .from("posts")
            .select(
              "id",
              {
                count:
                  "exact",
                head:
                  true
              }
            )
            .eq(
              "user_id",
              target.id
            ),

          req.sb
            .from("follows")
            .select(
              "follower_id",
              {
                count:
                  "exact",
                head:
                  true
              }
            )
            .eq(
              "following_id",
              target.id
            ),

          req.sb
            .from("follows")
            .select(
              "following_id",
              {
                count:
                  "exact",
                head:
                  true
              }
            )
            .eq(
              "follower_id",
              target.id
            ),

          req.sb
            .from("follows")
            .select(
              "follower_id"
            )
            .eq(
              "follower_id",
              req.user.id
            )
            .eq(
              "following_id",
              target.id
            )
            .maybeSingle()
        ]);

      res.json({
        ...safeUser(target),

        postCount:
          postCountResult.count ||
          0,

        followers:
          followersResult.count ||
          0,

        following:
          followingResult.count ||
          0,

        followingByMe:
          !!followingByMeResult.data
      });

    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   SEARCH
========================================================= */

app.get(
  "/api/search",
  auth,
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      if (!q) return res.json([]);

      // Arama ortak sistemdir. Service-role kullanıldığı için RLS,
      // yeni hesabın eski/aktif kullanıcıları görmesini bozmaz.
      const admin = adminClient();
      const { data, error } = await admin
        .from("profiles")
        .select("id,auth_user_id,username,display_name,bio,avatar_url,verified,settings")
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .limit(50);

      if (error) throw error;

      const activeProfiles = await filterActiveProfiles(data || []);
      res.json(activeProfiles.map(safeUser));
    } catch (e) {
      res.status(500).json({ error: e?.message || "Kullanıcı araması başarısız." });
    }
  }
);


/* =========================================================
   BLOCKS
   Engelleyen kullanıcı hedefi görmeye devam eder.
   Engellenen kullanıcı ise hedefi profil/içerik/mesaj tarafında göremez.
========================================================= */
app.get("/api/blocks", auth, async (req, res) => {
  try {
    const admin = adminClient();
    const { data, error } = await admin
      .from("blocks")
      .select("blocker_id,blocked_id")
      .eq("blocker_id", req.user.id);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Engellenen kullanıcılar alınamadı." });
  }
});

app.post("/api/users/:username/block", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    const targetId = String(target.auth_user_id || target.id || "").trim();
    const viewerId = String(req.authUser?.id || "").trim();
    if (!targetId || !viewerId) {
      return res.status(401).json({ error: "Oturum kimliği alınamadı" });
    }
    if (String(targetId) === viewerId) {
      return res.status(400).json({ error: "Kendini engelleyemezsin" });
    }

    const admin = adminClient();
    const shouldBlock = req.body?.blocked !== false;

    // Aynı endpoint hem ENGELLE hem ENGELİ KALDIR işlemini yapar.
    // Böylece Android tarafındaki profil ve sohbet ekranları aynı server kaydını kullanır.
    if (!shouldBlock) {
      const { error } = await admin
        .from("blocks")
        .delete()
        .eq("blocker_id", viewerId)
        .eq("blocked_id", targetId);
      if (error) throw error;
      return res.json({ ok: true, blocked: false, block: null });
    }

    // Önce mevcut kaydı kontrol et. Böylece blocks tablosunda
    // UNIQUE(blocker_id, blocked_id) constraint'i olmasa bile engelleme çalışır.
    const { data: existing, error: findError } = await admin
      .from("blocks")
      .select("blocker_id,blocked_id")
      .eq("blocker_id", viewerId)
      .eq("blocked_id", targetId)
      .limit(1);
    if (findError) throw findError;

    let data = Array.isArray(existing) ? existing[0] : null;
    if (!data) {
      const { error: insertError } = await admin
        .from("blocks")
        .insert({ blocker_id: viewerId, blocked_id: targetId });
      if (insertError) throw insertError;
      data = { blocker_id: viewerId, blocked_id: targetId };
    }

    // Instagram tarzı: engelleyen taraf ile hedef arasındaki takip ilişkisini kes.
    await admin.from("follows").delete()
      .or(`and(follower_id.eq.${viewerId},following_id.eq.${targetId}),and(follower_id.eq.${targetId},following_id.eq.${viewerId})`);

    res.json({ ok: true, blocked: true, block: data });
  } catch (e) {
    console.error("BLOCK ERROR:", e);
    res.status(400).json({ error: e?.message || "Kullanıcı engelleme işlemi başarısız." });
  }
});

app.delete("/api/users/:username/block", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    const targetId = target.auth_user_id || target.id;
    const { error } = await adminClient().from("blocks")
      .delete().eq("blocker_id", req.authUser.id).eq("blocked_id", targetId);
    if (error) throw error;
    res.json({ ok: true, blocked: false });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Engel kaldırılamadı." });
  }
});

app.get("/api/users/:username/block-status", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    const targetId = target.auth_user_id || target.id;
    const blockedByMe = await isUserBlockedBy(req.authUser.id, targetId);
    const blockedMe = await isUserBlockedBy(targetId, req.authUser.id);
    res.json({ blockedByMe, blockedMe, blocked: blockedByMe || blockedMe });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Engel durumu alınamadı." });
  }
});

/* =========================================================
   MESSAGES
========================================================= */

app.get(
  "/api/messages",
  auth,
  async (req, res) => {
    try {
      const {
        data,
        error
      } =
        await req.sb
          .from("messages")
          .select(
            "*,profiles:sender_id(username,display_name)"
          )
          .or(
            `sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`
          )
          .order(
            "created_at",
            {
              ascending:
                true
            }
          );

      if (error) {
        throw error;
      }

      const blockedIds = await blockedUserIdsFor(req.authUser.id);
      const visibleMessages = (data || []).filter(m =>
        !blockedIds.has(String(m.sender_id)) && !blockedIds.has(String(m.recipient_id))
      );

      res.json(
        visibleMessages.map(
          m => ({
            id:
              m.id,

            from:
              m.sender_id,

            to:
              m.recipient_id,

            text:
              m.text,

            createdAt:
              m.created_at,

            username:
              m.profiles?.username ||
              ""
          })
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);

app.post(
  "/api/messages",
  auth,
  async (req, res) => {
    try {
      const target =
        await findProfile(
          req.sb,
          req.body?.to
        );

      const text =
        String(
          req.body?.text ||
          ""
        ).trim();

      if (!target) {
        return res.status(404).json({
          error:
            "Kullanıcı bulunamadı"
        });
      }

      const targetId = target.auth_user_id || target.id;
      if (await isBlockedEitherWay(req.authUser.id, targetId)) {
        return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      }

      if (!text) {
        return res.status(400).json({
          error:
            "Mesaj boş olamaz"
        });
      }

      const {
        data,
        error
      } =
        await req.sb
          .from("messages")
          .insert({
            sender_id:
              req.user.id,

            recipient_id:
              target.id,

            text
          })
          .select("*")
          .single();

      if (error) {
        throw error;
      }

      res.json({
        id:
          data.id,

        from:
          data.sender_id,

        to:
          data.recipient_id,

        text:
          data.text,

        createdAt:
          data.created_at
      });

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   UPDATE PROFILE
========================================================= */

app.patch(
  "/api/me",
  auth,
  async (req, res) => {
    try {
      const patch =
        {};

      if (
        req.body?.displayName !==
        undefined
      ) {
        patch.display_name =
          String(
            req.body.displayName
          ).slice(0, 80);
      }

      if (
        req.body?.bio !==
        undefined
      ) {
        patch.bio =
          String(
            req.body.bio
          ).slice(0, 300);
      }

      if (
        Object.keys(
          patch
        ).length
      ) {
        const {
          error
        } =
          await req.sb
            .from("profiles")
            .update(patch)
            .eq(
              "id",
              req.user.id
            );

        if (error) {
          throw error;
        }
      }

      const {
        data,
        error
      } =
        await req.sb
          .from("profiles")
          .select("*")
          .eq(
            "id",
            req.user.id
          )
          .single();

      if (error) {
        throw error;
      }

      res.json(
        safeUser(data)
      );

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   SETTINGS
========================================================= */

app.patch(
  "/api/settings",
  auth,
  async (req, res) => {
    try {
      const next =
        {
          ...(req.user.settings ||
            {}),
          ...(req.body || {})
        };

      const {
        error
      } =
        await req.sb
          .from("profiles")
          .update({
            settings:
              next
          })
          .eq(
            "id",
            req.user.id
          );

      if (error) {
        throw error;
      }

      res.json(
        next
      );

    } catch (e) {
      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   MESAJ PAGE
========================================================= */

app.get(
  "/mesaj",
  (req, res) => {
    const file =
      path.join(
        publicDir,
        "mesaj.html"
      );

    if (
      fs.existsSync(file)
    ) {
      return res.sendFile(
        file
      );
    }

    res.status(404).send(
      "mesaj.html bulunamadı."
    );
  }
);




/* =========================================================
   MINEGRAM DOĞRUDAN SMTP E-POSTA SERVİSİ — V3
   - Render / HTTPS Mail Gateway kullanılmaz.
   - Gmail SMTP veya başka SMTP sağlayıcısı doğrudan kullanılır.
   - Admin yetkisi Firebase ID token ile kontrol edilir.
   - SMTP şifresi dosyaya/Firestore'a yazılmaz.
========================================================= */
const MAIL_ADMIN_UID = env("MAIL_ADMIN_UID") || "QJqw9moQk8XgpHcFo89bAVPk3uh1";
const FIREBASE_WEB_API_KEY = env("FIREBASE_WEB_API_KEY") || "AIzaSyCabJgEl6jhE_ucVBhA69LLQSCJ9qUuwXo";
const smtpConfigFile = path.join(__dirname, "minegram-smtp-config.json");

let smtpRuntime = {
  host: env("SMTP_HOST"),
  port: Number(env("SMTP_PORT")) || 587,
  user: env("SMTP_USER"),
  fromName: env("MAIL_FROM_NAME") || "Minegram",
  fromEmail: env("MAIL_FROM_EMAIL") || env("SMTP_USER"),
  codeLength: Number(env("VERIFICATION_CODE_LENGTH")) || 6,
  expiryMinutes: Number(env("VERIFICATION_EXPIRY_MINUTES")) || 10,
  cooldownSeconds: Number(env("VERIFICATION_COOLDOWN_SECONDS")) || 60
};

try {
  if (fs.existsSync(smtpConfigFile)) {
    const saved = JSON.parse(fs.readFileSync(smtpConfigFile, "utf8"));
    smtpRuntime = {
      ...smtpRuntime,
      ...saved,
      host: env("SMTP_HOST") || saved.host || "",
      port: Number(env("SMTP_PORT")) || Number(saved.port) || 587,
      user: env("SMTP_USER") || saved.user || "",
      fromName: env("MAIL_FROM_NAME") || saved.fromName || "Minegram",
      fromEmail: env("MAIL_FROM_EMAIL") || saved.fromEmail || env("SMTP_USER") || saved.user || ""
    };
  }
} catch (e) {
  console.error("SMTP CONFIG LOAD ERROR:", e?.message || e);
}

function emailEscapeHeader(value) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}

function emailAddress(value, fieldName = "E-posta adresi") {
  const v = emailEscapeHeader(value);
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error(`${fieldName} geçersiz.`);
  }
  return v;
}

function saveSmtpPublicConfig() {
  const safe = {
    host: smtpRuntime.host || "",
    port: Number(smtpRuntime.port) || 587,
    user: smtpRuntime.user || "",
    fromName: smtpRuntime.fromName || "Minegram",
    fromEmail: smtpRuntime.fromEmail || "",
    codeLength: Number(smtpRuntime.codeLength) || 6,
    expiryMinutes: Number(smtpRuntime.expiryMinutes) || 10,
    cooldownSeconds: Number(smtpRuntime.cooldownSeconds) || 60
  };
  fs.writeFileSync(smtpConfigFile, JSON.stringify(safe, null, 2), "utf8");
}

function smtpPublicConfig() {
  const passConfigured = Boolean(env("SMTP_PASS"));
  return {
    ok: true,
    configured: Boolean(smtpRuntime.host && smtpRuntime.user && smtpRuntime.fromEmail && passConfigured),
    host: smtpRuntime.host || "",
    port: Number(smtpRuntime.port) || 587,
    user: smtpRuntime.user || "",
    fromName: smtpRuntime.fromName || "Minegram",
    fromEmail: smtpRuntime.fromEmail || "",
    hasSmtpPassword: passConfigured,
    codeLength: Number(smtpRuntime.codeLength) || 6,
    expiryMinutes: Number(smtpRuntime.expiryMinutes) || 10,
    cooldownSeconds: Number(smtpRuntime.cooldownSeconds) || 60
  };
}

async function verifyFirebaseAdminToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const backupToken = String(req.headers["x-firebase-id-token"] || "").trim();
  const token = headerToken || backupToken;
  if (!token) throw new Error("Admin oturumu gerekli. Firebase ID token gönderilmedi.");
  if (!FIREBASE_WEB_API_KEY) throw new Error("FIREBASE_WEB_API_KEY eksik.");

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ idToken: token })
    }
  );
  const data = await response.json().catch(() => ({}));
  const firebaseUser = data?.users?.[0];
  if (!response.ok || !firebaseUser?.localId) {
    throw new Error(`Firebase admin oturumu doğrulanamadı: ${data?.error?.message || `HTTP ${response.status}`}`);
  }

  /*
     Önce mevcut Minegram admin UID'si kontrol edilir.
     Böylece admin panelindeki Firebase hesabı ile aynı hesap çalışır.
  */
  if (firebaseUser.localId !== MAIL_ADMIN_UID) {
    throw new Error("Bu Firebase hesabının Minegram admin yetkisi yok.");
  }
  return firebaseUser;
}

async function smtpAdminAuth(req, res, next) {
  try {
    req.smtpAdmin = await verifyFirebaseAdminToken(req);
    return next();
  } catch (e) {
    const message = e?.message || "Admin oturumu doğrulanamadı.";
    console.error("SMTP ADMIN AUTH ERROR:", message);
    return res.status(401).json({ ok: false, error: message });
  }
}

function smtpBaseConfig() {
  const host = String(smtpRuntime.host || env("SMTP_HOST") || "").trim();
  const configuredPort = Number(smtpRuntime.port || env("SMTP_PORT") || 587);
  const user = String(smtpRuntime.user || env("SMTP_USER") || "").trim();
  const pass = String(env("SMTP_PASS") || "");
  const fromEmail = String(smtpRuntime.fromEmail || env("MAIL_FROM_EMAIL") || user || "").trim();

  if (!host) throw new Error("SMTP_HOST ayarlanmadı.");
  if (![465, 587].includes(configuredPort)) throw new Error("SMTP portu 465 veya 587 olmalı.");
  if (!user) throw new Error("SMTP_USER ayarlanmadı.");
  if (!pass) throw new Error("SMTP_PASS ayarlanmadı.");
  if (!fromEmail) throw new Error("Gönderici e-posta ayarlanmadı. MAIL_FROM_EMAIL veya SMTP_USER ayarlayın.");

  return { host, configuredPort, user, pass, fromEmail };
}

function createSmtpTransport(config, port) {
  return nodemailer.createTransport({
    host: config.host,
    port,
    secure: port === 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    dnsTimeout: 15000,
    tls: {
      servername: config.host,
      minVersion: "TLSv1.2"
    }
  });
}

async function smtpTransport() {
  const config = smtpBaseConfig();
  const ports = [config.configuredPort, config.configuredPort === 587 ? 465 : 587];
  let lastError = null;

  for (const port of ports) {
    const transporter = createSmtpTransport(config, port);
    try {
      await transporter.verify();
      return { transporter, port, config };
    } catch (error) {
      lastError = error;
      try { transporter.close(); } catch {}
      console.error(`SMTP bağlantı testi başarısız (${config.host}:${port}):`, error?.message || error);
    }
  }

  const detail = lastError?.code ? ` [${lastError.code}]` : "";
  throw new Error(`SMTP sunucusuna bağlanılamadı: ${config.host}. 587 ve 465 portları denendi.${detail} ${lastError?.message || ""}`.trim());
}

async function sendSmtpEmail({ to, subject, html, text: textBody }) {
  const recipient = emailAddress(to, "Alıcı e-posta adresi");
  const fromEmail = emailAddress(smtpRuntime.fromEmail || env("MAIL_FROM_EMAIL") || smtpRuntime.user || env("SMTP_USER"), "Gönderici e-posta adresi");
  const fromName = emailEscapeHeader(smtpRuntime.fromName || env("MAIL_FROM_NAME") || "Minegram");

  const connection = await smtpTransport();
  try {
    await connection.transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: recipient,
      subject: emailEscapeHeader(subject),
      html: html || undefined,
      text: textBody || ""
    });
  } finally {
    try { connection.transporter.close(); } catch {}
  }
  return true;
}

/* Eski fonksiyon adını koruyoruz; kayıt ve şifre sıfırlama kodlarının diğer bölümleri değişmeden çalışır. */
async function sendMailGatewayEmail(args) {
  // Admin Panelinde SMTP ayarı yapıldıysa kayıt/doğrulama mailleri
  // doğrudan o SMTP servisi üzerinden gönderilir. Böylece ayrıca
  // MAIL_API_PROVIDER=smtp ayarı yapmak gerekmez.
  const forcedProvider = String(process.env.MAIL_API_PROVIDER || "").trim().toLowerCase();
  const smtpReady = Boolean(
    String(smtpRuntime.host || env("SMTP_HOST") || "").trim() &&
    String(smtpRuntime.user || env("SMTP_USER") || "").trim() &&
    String(env("SMTP_PASS") || "").trim() &&
    String(smtpRuntime.fromEmail || env("MAIL_FROM_EMAIL") || smtpRuntime.user || env("SMTP_USER") || "").trim()
  );

  if (forcedProvider === "smtp" || (!forcedProvider && smtpReady)) {
    return sendSmtpEmail(args);
  }

  if (forcedProvider === "gmail_api" || !smtpReady) {
    return sendGmailApiEmail(args);
  }

  return sendSmtpEmail(args);
}

app.get("/api/admin/email-service/status", smtpAdminAuth, (req, res) => {
  res.json(smtpPublicConfig());
});

app.post("/api/admin/email-service/config", smtpAdminAuth, (req, res) => {
  try {
    const body = req.body || {};
    const host = emailEscapeHeader(body.host || body.smtpHost || smtpRuntime.host || env("SMTP_HOST"));
    const port = Number(body.port || body.smtpPort || smtpRuntime.port || 587);
    const user = emailEscapeHeader(body.user || body.smtpUser || smtpRuntime.user || env("SMTP_USER"));
    const fromName = emailEscapeHeader(body.fromName || smtpRuntime.fromName || "Minegram");
    const suppliedFromEmail = emailEscapeHeader(body.fromEmail || "");
    const fromEmail = suppliedFromEmail
      ? emailAddress(suppliedFromEmail, "Gönderici e-posta adresi")
      : (smtpRuntime.fromEmail || env("MAIL_FROM_EMAIL") || user || "");

    if (!host) throw new Error("SMTP host gerekli.");
    if (![465, 587].includes(port)) throw new Error("SMTP portu 465 veya 587 olmalı.");
    if (!user) throw new Error("SMTP kullanıcı adı gerekli.");
    if (!fromEmail) throw new Error("Gönderici e-posta adresi gerekli.");

    smtpRuntime = { ...smtpRuntime, host, port, user, fromName, fromEmail };
    saveSmtpPublicConfig();

    /* Güvenlik: SMTP şifresi admin panelinden dosyaya kaydedilmez. */
    return res.json({
      ...smtpPublicConfig(),
      ok: true,
      message: env("SMTP_PASS")
        ? "SMTP ayarları kaydedildi. SMTP şifresi sunucu ortam değişkeninden kullanılıyor."
        : "SMTP ayarları kaydedildi ancak SMTP_PASS sunucuda ayarlanmalı."
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "SMTP ayarları kaydedilemedi." });
  }
});

app.post("/api/admin/email-service/test", smtpAdminAuth, async (req, res) => {
  try {
    const to = emailAddress(req.body?.to, "Test alıcı e-posta adresi");
    await sendMailGatewayEmail({
      to,
      subject: "Minegram e-posta test mesajı",
      text: "Minegram HTTP tabanlı e-posta servisi başarıyla çalışıyor.",
      html: "<div style=\"font-family:Arial,sans-serif;padding:24px\"><h2>Minegram</h2><p>HTTP tabanlı e-posta servisi başarıyla çalışıyor.</p></div>"
    });
    res.json({ ok: true, message: "Test e-postası gönderildi." });
  } catch (e) {
    console.error("SMTP TEST ERROR:", e?.message || e);
    res.status(400).json({ ok: false, error: e?.message || "Test e-postası gönderilemedi." });
  }
});

app.post("/api/admin/email-service/verification-config", smtpAdminAuth, (req, res) => {
  try {
    const codeLength = Number(req.body?.codeLength);
    const expiryMinutes = Number(req.body?.expiryMinutes);
    const cooldownSeconds = Number(req.body?.cooldownSeconds);
    if (![6, 8].includes(codeLength)) throw new Error("Kod uzunluğu 6 veya 8 olmalı.");
    if (![5, 10, 15, 30].includes(expiryMinutes)) throw new Error("Geçerlilik süresi geçersiz.");
    if (![60, 120, 300].includes(cooldownSeconds)) throw new Error("Gönderim aralığı geçersiz.");
    smtpRuntime = { ...smtpRuntime, codeLength, expiryMinutes, cooldownSeconds };
    saveSmtpPublicConfig();
    res.json({ ok: true, codeLength, expiryMinutes, cooldownSeconds });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || "Doğrulama ayarları kaydedilemedi." });
  }
});


/* =========================================================
   MINEGRAM MAIL GATEWAY — ADMIN PANEL UYUMLU
   Gateway Token isteğe bağlıdır. MAIL_GATEWAY_TOKEN boşsa
   token olmadan istek kabul edilir.
========================================================= */
const MAIL_GATEWAY_TOKEN = env("MAIL_GATEWAY_TOKEN");

function gatewayAuth(req, res, next) {
  const required = String(MAIL_GATEWAY_TOKEN || "").trim();
  if (!required) return next();

  const authHeader = String(req.headers.authorization || "").trim();
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const gatewayToken = String(req.headers["x-mail-gateway-token"] || "").trim();
  const supplied = bearerToken || gatewayToken;

  if (supplied !== required) {
    return res.status(401).json({
      ok: false,
      success: false,
      error: "Geçersiz Mail Gateway Token."
    });
  }
  next();
}

function gatewayPayload(body = {}) {
  return {
    to: body.to || body.email || body.recipient || body.recipientEmail,
    subject: body.subject || "Minegram",
    html: body.html || body.messageHtml || body.contentHtml || "",
    text: body.text || body.message || body.content || ""
  };
}

app.get("/api/mail-gateway/status", (req, res) => {
  const config = smtpPublicConfig();
  const provider = String(process.env.MAIL_API_PROVIDER || "gmail_api").trim().toLowerCase();
  const gmailOk = gmailConfigured();
  res.json({
    ok: true,
    success: true,
    service: "Minegram Mail Gateway",
    provider,
    configured: provider === "smtp" ? config.configured : gmailOk,
    tokenRequired: Boolean(MAIL_GATEWAY_TOKEN),
    fromName: provider === "smtp" ? config.fromName : gmailConfig().fromName,
    fromEmail: provider === "smtp" ? config.fromEmail : gmailConfig().userEmail
  });
});

app.post("/api/send-mail", gatewayAuth, async (req, res) => {
  try {
    const payload = gatewayPayload(req.body || {});
    if (!payload.to) throw new Error("Alıcı e-posta adresi gerekli.");
    if (!payload.html && !payload.text) throw new Error("E-posta içeriği gerekli.");

    await sendMailGatewayEmail(payload);
    res.json({
      ok: true,
      success: true,
      message: "E-posta başarıyla gönderildi."
    });
  } catch (e) {
    console.error("MAIL GATEWAY ERROR:", e?.message || e);
    res.status(400).json({
      ok: false,
      success: false,
      error: e?.message || "E-posta gönderilemedi."
    });
  }
});

/* Bazı admin panellerinin kullandığı alternatif gateway yolları */
app.post("/api/mail-gateway/send", gatewayAuth, async (req, res) => {
  try {
    const payload = gatewayPayload(req.body || {});
    if (!payload.to) throw new Error("Alıcı e-posta adresi gerekli.");
    if (!payload.html && !payload.text) throw new Error("E-posta içeriği gerekli.");
    await sendMailGatewayEmail(payload);
    res.json({ ok: true, success: true, message: "E-posta başarıyla gönderildi." });
  } catch (e) {
    res.status(400).json({ ok: false, success: false, error: e?.message || "E-posta gönderilemedi." });
  }
});


/* =========================================================
   MINEGRAM INTERNATIONAL SMS OTP — TWILIO VERIFY
   Mevcut giriş/kayıt/şifre sıfırlama sistemine dokunmaz.
   Twilio Verify HTTP API kullanır; ek npm paketi gerekmez.
========================================================= */

const phoneOtpRuntime = {
  enabled: String(env("TWILIO_VERIFY_ENABLED") || "false").toLowerCase() === "true",
  accountSid: env("TWILIO_ACCOUNT_SID"),
  authToken: env("TWILIO_AUTH_TOKEN"),
  serviceSid: env("TWILIO_VERIFY_SERVICE_SID"),
  channel: (env("TWILIO_VERIFY_CHANNEL") || "sms").toLowerCase(),
  locale: env("TWILIO_VERIFY_LOCALE"),
  cooldownSeconds: Math.max(0, Number(env("PHONE_OTP_COOLDOWN_SECONDS")) || 60),
  maxSendsPerHour: Math.max(1, Number(env("PHONE_OTP_MAX_SENDS_PER_HOUR")) || 5)
};

const phoneOtpRate = new Map();

function phoneOtpConfigured() {
  return Boolean(
    phoneOtpRuntime.enabled &&
    /^AC[a-zA-Z0-9]{20,}$/.test(phoneOtpRuntime.accountSid) &&
    phoneOtpRuntime.authToken &&
    /^VA[a-zA-Z0-9]{20,}$/.test(phoneOtpRuntime.serviceSid) &&
    ["sms", "call", "whatsapp"].includes(phoneOtpRuntime.channel)
  );
}

function normalizeInternationalPhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  // Uluslararası E.164: + ülke kodu + numara.
  // Boşluk/parantez/tire kabul edilir ve temizlenir.
  const cleaned = raw.replace(/[\s().-]/g, "");
  if (!/^\+\d{8,15}$/.test(cleaned)) return "";
  return cleaned;
}

function maskPhoneNumber(phone) {
  const p = String(phone || "");
  if (p.length < 8) return "***";
  return `${p.slice(0, 4)}${"*".repeat(Math.max(3, p.length - 7))}${p.slice(-3)}`;
}

function phoneOtpRateKey(phone) {
  return normalizeInternationalPhone(phone);
}

function phoneOtpCheckRate(phone) {
  const key = phoneOtpRateKey(phone);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const entry = phoneOtpRate.get(key) || { sentAt: [] };

  entry.sentAt = entry.sentAt.filter(ts => now - ts < hourMs);
  const last = entry.sentAt.length ? entry.sentAt[entry.sentAt.length - 1] : 0;
  const cooldownLeft = Math.max(
    0,
    phoneOtpRuntime.cooldownSeconds * 1000 - (now - last)
  );

  if (cooldownLeft > 0) {
    return {
      ok: false,
      code: "COOLDOWN",
      retryAfterSeconds: Math.ceil(cooldownLeft / 1000),
      remainingThisHour: Math.max(0, phoneOtpRuntime.maxSendsPerHour - entry.sentAt.length)
    };
  }

  if (entry.sentAt.length >= phoneOtpRuntime.maxSendsPerHour) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((hourMs - (now - entry.sentAt[0])) / 1000)
    );
    return {
      ok: false,
      code: "HOURLY_LIMIT",
      retryAfterSeconds,
      remainingThisHour: 0
    };
  }

  return {
    ok: true,
    entry,
    remainingThisHour: Math.max(0, phoneOtpRuntime.maxSendsPerHour - entry.sentAt.length)
  };
}

function phoneOtpRecordSend(phone, entry) {
  entry.sentAt.push(Date.now());
  phoneOtpRate.set(phoneOtpRateKey(phone), entry);
}

function twilioBasicAuthHeader() {
  return "Basic " + Buffer.from(
    `${phoneOtpRuntime.accountSid}:${phoneOtpRuntime.authToken}`,
    "utf8"
  ).toString("base64");
}

async function twilioVerifyRequest(pathname, params) {
  if (!phoneOtpConfigured()) {
    throw new Error("SMS OTP servisi yapılandırılmamış. Twilio Environment Variables kontrol edilmeli.");
  }

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(phoneOtpRuntime.serviceSid)}${pathname}`,
    {
      method: "POST",
      headers: {
        Authorization: twilioBasicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(params).toString()
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.message ||
      data?.detail ||
      data?.error_message ||
      `Twilio Verify hatası (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.twilioCode = data?.code || null;
    throw error;
  }

  return data;
}

async function sendPhoneOtp(phone) {
  const normalized = normalizeInternationalPhone(phone);
  if (!normalized) {
    const error = new Error("Telefon numarası uluslararası formatta olmalı. Örnek: +905551112233");
    error.code = "INVALID_PHONE";
    throw error;
  }

  if (!phoneOtpConfigured()) {
    const error = new Error("SMS OTP servisi yapılandırılmamış. Render Environment Variables ve deploy edilen server.js kontrol edilmeli.");
    error.code = "SMS_OTP_NOT_CONFIGURED";
    throw error;
  }

  const rate = phoneOtpCheckRate(normalized);
  if (!rate.ok) {
    const error = new Error(
      rate.code === "HOURLY_LIMIT"
        ? `Saatlik SMS gönderim limitine ulaşıldı. ${rate.retryAfterSeconds} saniye sonra tekrar deneyin.`
        : `Yeni kod göndermek için ${rate.retryAfterSeconds} saniye bekleyin.`
    );
    error.code = rate.code;
    error.retryAfterSeconds = rate.retryAfterSeconds;
    throw error;
  }

  const params = {
    To: normalized,
    Channel: phoneOtpRuntime.channel
  };

  if (phoneOtpRuntime.locale) params.Locale = phoneOtpRuntime.locale;

  const data = await twilioVerifyRequest("/Verifications", params);
  phoneOtpRecordSend(normalized, rate.entry);

  return {
    phone: normalized,
    maskedPhone: maskPhoneNumber(normalized),
    status: data?.status || "pending",
    channel: phoneOtpRuntime.channel,
    remainingThisHour: Math.max(
      0,
      phoneOtpRuntime.maxSendsPerHour - rate.entry.sentAt.length
    )
  };
}

async function verifyPhoneOtp(phone, code) {
  const normalized = normalizeInternationalPhone(phone);
  const cleanCode = String(code ?? "").replace(/\D/g, "").slice(0, 10);

  if (!normalized) {
    const error = new Error("Telefon numarası uluslararası formatta olmalı. Örnek: +905551112233");
    error.code = "INVALID_PHONE";
    throw error;
  }

  if (!/^\d{4,10}$/.test(cleanCode)) {
    const error = new Error("Geçerli bir doğrulama kodu girin.");
    error.code = "INVALID_CODE";
    throw error;
  }

  if (!phoneOtpConfigured()) {
    const error = new Error("SMS OTP servisi yapılandırılmamış. Render Environment Variables ve deploy edilen server.js kontrol edilmeli.");
    error.code = "SMS_OTP_NOT_CONFIGURED";
    throw error;
  }

  const data = await twilioVerifyRequest("/VerificationCheck", {
    To: normalized,
    Code: cleanCode
  });

  return {
    phone: normalized,
    maskedPhone: maskPhoneNumber(normalized),
    verified: data?.status === "approved",
    status: data?.status || "pending",
    valid: data?.valid === true || data?.status === "approved"
  };
}

function phoneOtpPublicConfig() {
  return {
    ok: true,
    configured: phoneOtpConfigured(),
    enabled: phoneOtpRuntime.enabled,
    channel: phoneOtpRuntime.channel,
    codeLength: 6,
    phoneFormat: "E.164 (+ülke kodu + numara)",
    cooldownSeconds: phoneOtpRuntime.cooldownSeconds,
    maxSendsPerHour: phoneOtpRuntime.maxSendsPerHour,
    provider: "twilio_verify"
  };
}

// Durum endpointi: gizli Twilio bilgilerini ASLA döndürmez.
app.get("/api/phone-otp/status", (req, res) => {
  return res.json(phoneOtpPublicConfig());
});

// SMS gönder — kayıt/doğrulama ekranı tarafından oturumsuz kullanılabilir.
app.post("/api/phone-otp/send", async (req, res) => {
  try {
    const result = await sendPhoneOtp(req.body?.phone || req.body?.phoneNumber || req.body?.telefon);
    return res.json({
      ok: true,
      success: true,
      message: "Doğrulama kodu SMS ile gönderildi.",
      ...result
    });
  } catch (e) {
    console.error("PHONE OTP SEND ERROR:", e?.message || e);
    const status = e?.code === "SMS_OTP_NOT_CONFIGURED" ? 503
      : e?.code === "INVALID_PHONE" ? 400
      : e?.code === "COOLDOWN" || e?.code === "HOURLY_LIMIT" ? 429
      : 400;

    return res.status(status).json({
      ok: false,
      success: false,
      code: e?.code || "SMS_SEND_ERROR",
      error: e?.message || "SMS doğrulama kodu gönderilemedi.",
      retryAfterSeconds: e?.retryAfterSeconds || undefined
    });
  }
});

// Yeniden gönder — aynı güvenlik limitlerini kullanır.
app.post("/api/phone-otp/resend", async (req, res) => {
  try {
    const result = await sendPhoneOtp(req.body?.phone || req.body?.phoneNumber || req.body?.telefon);
    return res.json({
      ok: true,
      success: true,
      message: "Yeni doğrulama kodu gönderildi.",
      ...result
    });
  } catch (e) {
    console.error("PHONE OTP RESEND ERROR:", e?.message || e);
    const status = e?.code === "SMS_OTP_NOT_CONFIGURED" ? 503
      : e?.code === "INVALID_PHONE" ? 400
      : e?.code === "COOLDOWN" || e?.code === "HOURLY_LIMIT" ? 429
      : 400;

    return res.status(status).json({
      ok: false,
      success: false,
      code: e?.code || "SMS_RESEND_ERROR",
      error: e?.message || "SMS doğrulama kodu yeniden gönderilemedi.",
      retryAfterSeconds: e?.retryAfterSeconds || undefined
    });
  }
});

// SMS kodunu doğrula.
app.post("/api/phone-otp/verify", async (req, res) => {
  try {
    const result = await verifyPhoneOtp(
      req.body?.phone || req.body?.phoneNumber || req.body?.telefon,
      req.body?.code || req.body?.otp || req.body?.verificationCode
    );

    if (!result.verified) {
      return res.status(400).json({
        ok: false,
        verified: false,
        success: false,
        code: "INVALID_CODE",
        error: "Doğrulama kodu geçersiz veya henüz onaylanmadı.",
        status: result.status
      });
    }

    return res.json({
      ok: true,
      verified: true,
      success: true,
      message: "Telefon numarası başarıyla doğrulandı.",
      phone: result.phone,
      maskedPhone: result.maskedPhone,
      status: result.status
    });
  } catch (e) {
    console.error("PHONE OTP VERIFY ERROR:", e?.message || e);
    const status = e?.code === "SMS_OTP_NOT_CONFIGURED" ? 503
      : e?.code === "INVALID_PHONE" || e?.code === "INVALID_CODE" ? 400
      : 400;

    return res.status(status).json({
      ok: false,
      verified: false,
      success: false,
      code: e?.code || "SMS_VERIFY_ERROR",
      error: e?.message || "Telefon doğrulaması başarısız."
    });
  }
});

// Eski/alternatif frontend adlarıyla uyumluluk.
app.post("/api/phone/send-code", async (req, res) => {
  try {
    const result = await sendPhoneOtp(req.body?.phone || req.body?.phoneNumber || req.body?.telefon);
    return res.json({ ok: true, success: true, ...result });
  } catch (e) {
    const status = e?.code === "SMS_OTP_NOT_CONFIGURED" ? 503
      : e?.code === "INVALID_PHONE" ? 400
      : e?.code === "COOLDOWN" || e?.code === "HOURLY_LIMIT" ? 429
      : 400;
    return res.status(status).json({ ok: false, success: false, code: e?.code || "SMS_SEND_ERROR", error: e?.message || "SMS gönderilemedi." });
  }
});

app.post("/api/phone/verify-code", async (req, res) => {
  try {
    const result = await verifyPhoneOtp(
      req.body?.phone || req.body?.phoneNumber || req.body?.telefon,
      req.body?.code || req.body?.otp || req.body?.verificationCode
    );
    if (!result.verified) {
      return res.status(400).json({ ok: false, verified: false, success: false, code: "INVALID_CODE", error: "Doğrulama kodu geçersiz.", status: result.status });
    }
    return res.json({ ok: true, verified: true, success: true, phone: result.phone, maskedPhone: result.maskedPhone, status: result.status });
  } catch (e) {
    const status = e?.code === "SMS_OTP_NOT_CONFIGURED" ? 503
      : e?.code === "INVALID_PHONE" || e?.code === "INVALID_CODE" ? 400
      : 400;
    return res.status(status).json({ ok: false, verified: false, success: false, code: e?.code || "SMS_VERIFY_ERROR", error: e?.message || "Telefon doğrulaması başarısız." });
  }
});

console.log(
  `SMS OTP: ${phoneOtpConfigured() ? "YAPILANDIRILDI" : "YAPILANDIRILMADI"}` +
  ` | provider=twilio_verify | channel=${phoneOtpRuntime.channel}`
);


/* =========================================================
   ADMIN AUTH USERS
========================================================= */

app.get("/api/admin/auth-users", async (req, res) => {
  try {
    await verifyFirebaseAdminToken(req);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik."
      });
    }

    const admin = adminClient();
    const users = [];
    for (let page = 1; page <= 100; page++) {
      const result = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (result?.error) throw result.error;
      const pageUsers = result?.data?.users || [];
      users.push(...pageUsers);
      if (pageUsers.length < 1000) break;
    }

    return res.json({
      ok: true,
      users: users.map(user => ({
        id: user.id,
        email: user.email || "",
        phone: user.phone || "",
        created_at: user.created_at || null,
        last_sign_in_at: user.last_sign_in_at || null,
        email_confirmed_at: user.email_confirmed_at || null,
        banned_until: user.banned_until || null,
        user_metadata: user.user_metadata || {}
      }))
    });
  } catch (e) {
    console.error("ADMIN AUTH USERS ERROR:", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Auth kullanıcıları alınamadı."
    });
  }
});

/* =========================================================
   FALLBACK
========================================================= */

app.use(
  (req, res) => {
    const publicGiris =
      path.join(
        publicDir,
        "giris.html"
      );

    const rootGiris =
      path.join(
        __dirname,
        "giris.html"
      );

    if (
      fs.existsSync(
        publicGiris
      )
    ) {
      return res.sendFile(
        publicGiris
      );
    }

    if (
      fs.existsSync(
        rootGiris
      )
    ) {
      return res.sendFile(
        rootGiris
      );
    }

    res.status(404).send(
      "Minegram sayfası bulunamadı."
    );
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Minegram server çalışıyor. PORT=${PORT}`
    );
  }
);
