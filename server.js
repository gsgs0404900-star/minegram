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


/* =========================================================
   MINEGRAM CROSS-PLATFORM FIREBASE MIRROR
   Web/Supabase writes are mirrored to the same Firestore
   collections consumed by the Android application.
========================================================= */
const FIREBASE_PROJECT_ID = "mim-ea133";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function fsString(value) {
  return { stringValue: String(value ?? "") };
}
function fsInt(value) {
  return { integerValue: String(Math.trunc(Number(value) || 0)) };
}
function fsBool(value) {
  return { booleanValue: Boolean(value) };
}

function firebaseValue(v) {
  if (!v) return null;
  if (Object.prototype.hasOwnProperty.call(v, "stringValue")) return v.stringValue;
  if (Object.prototype.hasOwnProperty.call(v, "integerValue")) return Number(v.integerValue);
  if (Object.prototype.hasOwnProperty.call(v, "doubleValue")) return Number(v.doubleValue);
  if (Object.prototype.hasOwnProperty.call(v, "booleanValue")) return Boolean(v.booleanValue);
  if (Object.prototype.hasOwnProperty.call(v, "timestampValue")) return v.timestampValue;
  if (Object.prototype.hasOwnProperty.call(v, "nullValue")) return null;
  if (v.referenceValue) return v.referenceValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(firebaseValue);
  if (v.mapValue) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = firebaseValue(val);
    return out;
  }
  return null;
}


async function firebaseRest(path, options = {}) {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    throw new Error(body?.error?.message || `Firebase REST ${response.status}`);
  }
  return body;
}


async function readFirebaseCollection(collection, limit = 1000) {
  const out = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ pageSize: String(Math.min(limit - out.length, 1000)) });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await firebaseRest(`${collection}?${qs.toString()}`);
    for (const doc of (data?.documents || [])) out.push(doc);
    pageToken = data?.nextPageToken || "";
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

async function getFirebasePublicPosts() {
  let docs = [];
  try {
    docs = await readFirebaseCollection("minegramPublicPosts", 1000);
  } catch (e) {
    console.warn("MINEGRAM FIREBASE POSTS READ SKIPPED:", e?.message || e);
    return [];
  }
  return docs.map(doc => {
    const x = {};
    for (const [k, v] of Object.entries(doc.fields || {})) x[k] = firebaseValue(v);
    return {
      id: String(x.postId ?? x.id ?? doc.name.split("/").pop()),
      user_id: x.ownerUid || null,
      username: x.username || "",
      caption: x.caption || x.text || "",
      text: x.text || x.caption || "",
      media_url: x.mediaUrl || x.mediaUri || x.media || "",
      media_type: x.mediaType || "",
      likes: Number(x.likes || 0),
      comment_count: Number(x.commentCount || 0),
      created_at: new Date(Number(x.createdAt) || Date.parse(x.createdAt || "") || Date.now()).toISOString(),
      _firebase: true
    };
  });
}

async function getFirebasePublicStories() {
  let docs = [];
  try {
    docs = await readFirebaseCollection("users", 1000);
  } catch (e) {
    console.warn("MINEGRAM FIREBASE STORIES READ SKIPPED:", e?.message || e);
    return [];
  }
  return docs.map(doc => {
    const x = {};
    for (const [k, v] of Object.entries(doc.fields || {})) x[k] = firebaseValue(v);
    return {
      id: String(x.storyId || x.id || doc.name.split("/").pop()),
      username: x.username || "",
      media_url: x.mediaUrl || x.mediaUri || x.media || (x.base64 ? `data:${x.mediaType || "image/jpeg"};base64,${x.base64}` : ""),
      media_type: x.mediaType || "image/jpeg",
      created_at: new Date(Number(x.createdAt) || Date.parse(x.createdAt || "") || Date.now()).toISOString(),
      type: "public_story",
      _firebase: true
    };
  }).filter(x => x.media_url && String(x.type) === "public_story");
}

async function mirrorPostToFirebase(post, profile) {
  try {
    const username = String(profile?.username || "").trim();
    if (!username || !post?.id) return;
    const documentId = `minegram_public_post_${username.toLowerCase()}_${post.id}`;
    const fields = {
      postId: fsInt(post.id),
      username: fsString(username),
      usernameLower: fsString(username.toLowerCase()),
      ownerUid: fsString(profile?.id || post.user_id || ""),
      text: fsString(post.caption || ""),
      caption: fsString(post.caption || ""),
      likes: fsInt(post.likes || 0),
      mediaUri: fsString(post.media_url || ""),
      media: fsString(post.media_url || ""),
      mediaType: fsString(post.media_type || ""),
      mediaUrl: fsString(post.media_url || ""),
      music: fsString(""),
      commentCount: fsInt(post.comment_count || 0),
      createdAt: fsInt(Date.parse(post.created_at || "") || Date.now()),
      type: fsString("public_post"),
      sender: fsString(username),
      recipient: fsString("__minegram_public_posts__"),
      conversationKey: fsString("__minegram_public_posts__")
    };
    await firebaseRest(`minegramPublicPosts/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ fields })
    });
    console.log("MINEGRAM FIREBASE POST MIRROR OK:", documentId);
  } catch (e) {
    // Supabase remains authoritative; a mirror failure must not fail the web request.
    console.error("MINEGRAM FIREBASE POST MIRROR ERROR:", e?.message || e);
  }
}

async function mirrorStoryToFirebase(story, profile) {
  try {
    const username = String(profile?.username || "").trim();
    if (!username || !story?.id) return;
    const documentId = `story_${username.toLowerCase()}_${story.id}`;
    const createdAt = Date.parse(story.created_at || "") || Date.now();
    const fields = {
      id: fsString(documentId),
      storyId: fsString(String(story.id)),
      username: fsString(username),
      usernameLower: fsString(username.toLowerCase()),
      mediaUri: fsString(story.media_url || ""),
      mediaUrl: fsString(story.media_url || ""),
      media: fsString(story.media_url || ""),
      base64: fsString(""),
      mediaType: fsString(story.media_type || "image/jpeg"),
      createdAt: fsInt(createdAt),
      type: fsString("public_story"),
      sender: fsString(username),
      recipient: fsString("__minegram_public_stories__")
    };
    await firebaseRest(`users/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ fields })
    });
    console.log("MINEGRAM FIREBASE STORY MIRROR OK:", documentId);
  } catch (e) {
    console.error("MINEGRAM FIREBASE STORY MIRROR ERROR:", e?.message || e);
  }
}

async function deletePostFromFirebase(postId, profile) {
  try {
    const username = String(profile?.username || "").trim().toLowerCase();
    if (!username || !postId) return;
    const documentId = `minegram_public_post_${username}_${postId}`;
    await firebaseRest(`minegramPublicPosts/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: {
        type: fsString("deleted_post"),
        postId: fsInt(postId),
        username: fsString(profile?.username || ""),
        usernameLower: fsString(username),
        ownerUid: fsString(profile?.id || ""),
        deletedAt: fsInt(Date.now())
      }})
    });
  } catch (e) {
    console.error("MINEGRAM FIREBASE POST DELETE ERROR:", e?.message || e);
  }
}

async function getFirebaseHighlightsForUser(username) {
  const wanted = String(username || "").trim().toLowerCase();
  let docs = [];
  try {
    docs = await readFirebaseCollection("minegramPublicHighlights", 1000);
  } catch (e) {
    console.warn("MINEGRAM FIREBASE HIGHLIGHTS READ SKIPPED:", e?.message || e);
    return [];
  }
  const out = [];
  for (const doc of docs) {
    const x = {};
    for (const [k, v] of Object.entries(doc.fields || {})) x[k] = await firebaseValue(v);
    if (String(x.usernameLower || x.username || "").toLowerCase() !== wanted) continue;
    let media = x.mediaUrl || x.image || x.media || x.uri || x.base64 || x.mediaBase64 || "";
    if (media && !/^https?:\/\//i.test(String(media)) && !/^data:/i.test(String(media)) && String(media).length > 100) {
      media = `data:${x.mediaType || x.type || "image/jpeg"};base64,${media}`;
    }
    if (!media) continue;
    out.push({
      id: `firebase:${doc.name.split("/").pop()}`,
      user_id: null,
      media, media_url: media, mediaUrl: media,
      media_type: x.mediaType || x.type || "image",
      title: x.title || "Öne çıkan",
      sort_order: Number(x.sortOrder || 0),
      created_at: x.createdAt || new Date().toISOString(),
      _firebase: true
    });
  }
  return out;
}

async function mirrorHighlightToFirebase(highlight, profile) {
  try {
    const username = String(profile?.username || "").trim();
    if (!username || !highlight?.id) return;
    const documentId = `highlight_${username.toLowerCase()}_${String(highlight.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const fields = {
      id: fsString(documentId),
      highlightId: fsString(String(highlight.id)),
      username: fsString(username), usernameLower: fsString(username.toLowerCase()),
      title: fsString(highlight.title || "Öne çıkan"),
      image: fsString(highlight.media_url || ""), uri: fsString(highlight.media_url || ""),
      media: fsString(highlight.media_url || ""), mediaUrl: fsString(highlight.media_url || ""),
      type: fsString(highlight.media_type || "image"), mediaType: fsString(highlight.media_type || "image"),
      createdAt: fsString(highlight.created_at || new Date().toISOString()),
      sortOrder: fsInt(highlight.sort_order || 0)
    };
    await firebaseRest(`minegramPublicHighlights/${encodeURIComponent(documentId)}`, {
      method: "PATCH", body: JSON.stringify({ fields })
    });
  } catch (e) { console.error("MINEGRAM FIREBASE HIGHLIGHT MIRROR ERROR:", e?.message || e); }
}

async function updateFirebaseHighlightDocument(syntheticId, patch = {}) {
  const id = String(syntheticId || "").replace(/^firebase:/, "");
  if (!id) return false;
  const fields = {};
  if (patch.title !== undefined) fields.title = fsString(String(patch.title).trim().slice(0,80) || "Öne çıkan");
  if (!Object.keys(fields).length) return false;
  await firebaseRest(`minegramPublicHighlights/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ fields })
  });
  return true;
}

async function deleteHighlightFromFirebase(highlightId, profile) {
  try {
    const id = String(highlightId || "");
    if (id.startsWith("firebase:")) {
      await firebaseRest(`minegramPublicHighlights/${encodeURIComponent(id.replace(/^firebase:/, ""))}`, { method: "DELETE" });
      return;
    }
    const username = String(profile?.username || "").trim().toLowerCase();
    let docs = [];
  try {
    docs = await readFirebaseCollection("minegramPublicHighlights", 1000);
  } catch (e) {
    console.warn("MINEGRAM FIREBASE HIGHLIGHTS READ SKIPPED:", e?.message || e);
    return [];
  }
    for (const doc of docs) {
      const f = doc.fields || {};
      const u = f.usernameLower?.stringValue?.toLowerCase() || f.username?.stringValue?.toLowerCase();
      const hid = f.highlightId?.stringValue;
      if (u === username && hid === id) await firebaseRest(`minegramPublicHighlights/${encodeURIComponent(doc.name.split("/").pop())}`, { method: "DELETE" });
    }
  } catch (e) { console.error("MINEGRAM FIREBASE HIGHLIGHT DELETE ERROR:", e?.message || e); }
}

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
   REGISTER + 6 HANELİ E-POSTA DOĞRULAMA
   ========================================================= */

const registrationCodes = new Map();
const registrationRate = new Map();

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function registrationKey(email) {
  return normalizeEmail(email);
}

function registrationAllowed(email) {
  const key = registrationKey(email);
  const now = Date.now();
  const last = registrationRate.get(key) || 0;

  // Aynı adrese 60 saniyede birden fazla kod gönderilmesini engelle.
  return now - last >= 60 * 1000;
}

async function sendRegistrationCode(email, code) {
  await sendResendEmail(
    email,
    "Minegram e-posta doğrulama kodun",
    `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;color:#111">
        <h2 style="margin:0 0 16px">Minegram</h2>
        <p style="font-size:16px">Hesabını doğrulamak için 6 haneli kodun:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:10px;margin:24px 0">
          ${code}
        </div>
        <p style="color:#666">Bu kod 10 dakika geçerlidir.</p>
        <p style="color:#666">Bu kodu kimseyle paylaşma.</p>
      </div>
    `,
    `Minegram e-posta doğrulama kodun: ${code}\nBu kod 10 dakika geçerlidir.`
  );
}

app.post(
  "/api/register",
  async (req, res) => {
    let createdAuthUserId = null;

    try {
      const username =
        normalizeUsername(req.body?.username);

      const email =
        normalizeEmail(req.body?.email);

      const password =
        String(req.body?.password || "");

      const displayName =
        String(
          req.body?.displayName || username
        )
          .trim()
          .slice(0, 80);

      if (!username) {
        return res.status(400).json({
          ok: false,
          code: "USERNAME_REQUIRED",
          error: "Kullanıcı adı gerekli."
        });
      }

      if (!email) {
        return res.status(400).json({
          ok: false,
          code: "EMAIL_REQUIRED",
          error: "E-posta gerekli."
        });
      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return res.status(400).json({
          ok: false,
          code: "INVALID_EMAIL",
          error: "Geçerli bir e-posta adresi gir."
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          ok: false,
          code: "PASSWORD_TOO_SHORT",
          error: "Şifre en az 6 karakter olmalı."
        });
      }

      if (
        !/^[a-z0-9._]{3,30}$/.test(username)
      ) {
        return res.status(400).json({
          ok: false,
          code: "INVALID_USERNAME",
          error:
            "Kullanıcı adı 3-30 karakter olmalı; sadece harf, sayı, nokta ve alt çizgi kullan."
        });
      }

      if (!CONFIG_OK) {
        return res.status(500).json({
          ok: false,
          code: "SUPABASE_CONFIG_ERROR",
          error: "Supabase yapılandırması eksik."
        });
      }

      if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({
          ok: false,
          code: "SERVICE_ROLE_MISSING",
          error: "SUPABASE_SERVICE_ROLE_KEY eksik."
        });
      }

      if (!registrationAllowed(email)) {
        return res.status(429).json({
          ok: false,
          code: "CODE_RATE_LIMIT",
          error:
            "Bu e-posta adresine yeni kod göndermek için 60 saniye bekle."
        });
      }

      const admin = adminClient();

      /* Kullanıcı adı kontrolü */
      const {
        data: existingProfile,
        error: usernameCheckError
      } = await admin
        .from("profiles")
        .select("id,username,auth_user_id")
        .eq("username", username)
        .limit(1)
        .maybeSingle();

      if (usernameCheckError) {
        console.error(
          "USERNAME CHECK ERROR:",
          usernameCheckError
        );

        return res.status(500).json({
          ok: false,
          code: "USERNAME_CHECK_ERROR",
          error:
            "Kullanıcı adı kontrol edilirken hata oluştu."
        });
      }

      if (existingProfile) {
        return res.status(409).json({
          ok: false,
          code: "USERNAME_TAKEN",
          error: "Bu kullanıcı adı zaten alınmış."
        });
      }

      /* E-posta kontrolü */
      try {
        let emailAlreadyExists = false;

        for (let page = 1; page <= 20; page++) {
          const result =
            await admin.auth.admin.listUsers({
              page,
              perPage: 1000
            });

          const users =
            result?.data?.users || [];

          if (result?.error) {
            console.error(
              "EMAIL CHECK ERROR:",
              result.error
            );
            break;
          }

          if (
            users.some(
              u =>
                normalizeEmail(u?.email) === email
            )
          ) {
            emailAlreadyExists = true;
            break;
          }

          if (users.length < 1000) {
            break;
          }
        }

        if (emailAlreadyExists) {
          return res.status(409).json({
            ok: false,
            code: "EMAIL_TAKEN",
            error:
              "Bu e-posta adresi zaten kullanılıyor."
          });
        }
      } catch (emailCheckError) {
        console.error(
          "EMAIL PRECHECK ERROR:",
          emailCheckError?.message ||
            emailCheckError
        );
      }

      /*
       * ÖNEMLİ:
       * Supabase'in kendi confirmation mailini kullanmıyoruz.
       * Hesabı email_confirm:false olarak oluşturuyoruz.
       * 6 haneli kodu Resend ile biz gönderiyoruz.
       */
      const {
        data: created,
        error: createError
      } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: false,
          user_metadata: {
            username,
            display_name: displayName
          }
        });

      if (createError) {
        console.error(
          "AUTH CREATE ERROR:",
          createError
        );

        const message =
          String(createError.message || "");

        if (
          /already registered/i.test(message) ||
          /already exists/i.test(message) ||
          /user already registered/i.test(message)
        ) {
          return res.status(409).json({
            ok: false,
            code: "EMAIL_TAKEN",
            error:
              "Bu e-posta adresi zaten kullanılıyor."
          });
        }

        return res.status(400).json({
          ok: false,
          code: "SIGNUP_ERROR",
          error:
            message || "Kayıt başarısız."
        });
      }

      const authUser = created?.user;

      if (!authUser?.id) {
        return res.status(400).json({
          ok: false,
          code: "USER_CREATE_FAILED",
          error: "Kullanıcı oluşturulamadı."
        });
      }

      createdAuthUserId = authUser.id;

      /* Profil oluştur */
      const {
        data: profile,
        error: profileError
      } =
        await admin
          .from("profiles")
          .insert({
            id: authUser.id,
            auth_user_id: authUser.id,
            username,
            display_name: displayName,
            bio: "",
            avatar_url: null,
            verified: false,
            settings: {}
          })
          .select("*")
          .single();

      if (profileError) {
        console.error(
          "PROFILE CREATE ERROR:",
          profileError
        );

        try {
          await admin.auth.admin.deleteUser(
            authUser.id
          );
        } catch (cleanupError) {
          console.error(
            "AUTH CLEANUP ERROR:",
            cleanupError
          );
        }

        createdAuthUserId = null;

        return res.status(500).json({
          ok: false,
          code: "PROFILE_CREATE_ERROR",
          error: "Profil oluşturulamadı."
        });
      }

      /*
       * 6 HANELİ KOD ÜRET VE E-POSTAYA GÖNDER
       */
      const code = createVerificationCode();

      registrationCodes.set(
        registrationKey(email),
        {
          code,
          userId: authUser.id,
          email,
          expires: Date.now() + 10 * 60 * 1000,
          attempts: 0,
          username,
          displayName
        }
      );

      registrationRate.set(
        registrationKey(email),
        Date.now()
      );

      try {
        await sendRegistrationCode(
          email,
          code
        );
      } catch (mailError) {
        console.error(
          "REGISTRATION EMAIL ERROR:",
          mailError
        );

        registrationCodes.delete(
          registrationKey(email)
        );

        try {
          await admin.auth.admin.deleteUser(
            authUser.id
          );
        } catch (cleanupError) {
          console.error(
            "AUTH CLEANUP AFTER MAIL ERROR:",
            cleanupError
          );
        }

        return res.status(500).json({
          ok: false,
          code: "EMAIL_SEND_ERROR",
          error:
            mailError?.message ||
            "Doğrulama e-postası gönderilemedi."
        });
      }

      createdAuthUserId = null;

      return res.json({
        ok: true,
        needsEmailVerification: true,
        message:
          "Devam ettiğinizde, e-posta adresinize 6 haneli bir doğrulama kodu gönderilecektir.",
        maskedEmail: maskEmail(email),
        email,
        user: {
          id: authUser.id,
          email: authUser.email,
          username,
          displayName
        }
      });

    } catch (e) {
      console.error(
        "REGISTER ERROR:",
        e
      );

      if (createdAuthUserId) {
        try {
          await adminClient()
            .auth.admin.deleteUser(
              createdAuthUserId
            );
        } catch (cleanupError) {
          console.error(
            "FINAL AUTH CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      return res.status(500).json({
        ok: false,
        code: "REGISTER_ERROR",
        error:
          e?.message ||
          "Kayıt başarısız."
      });
    }
  }
);

/* =========================================================
   REGISTER VERIFY
   ========================================================= */

app.post(
  "/api/register/verify",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(req.body?.email);

      const code =
        String(req.body?.code || "")
          .replace(/\D/g, "")
          .slice(0, 6);

      if (!email) {
        return res.status(400).json({
          ok: false,
          error: "E-posta gerekli."
        });
      }

      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({
          ok: false,
          error:
            "6 haneli doğrulama kodunu gir."
        });
      }

      const key =
        registrationKey(email);

      const entry =
        registrationCodes.get(key);

      if (!entry) {
        return res.status(400).json({
          ok: false,
          error:
            "Doğrulama kodu bulunamadı. Yeni kod iste."
        });
      }

      if (entry.expires < Date.now()) {
        registrationCodes.delete(key);

        return res.status(400).json({
          ok: false,
          code: "CODE_EXPIRED",
          error:
            "Kodun süresi dolmuş. Yeni kod iste."
        });
      }

      if (entry.attempts >= 5) {
        registrationCodes.delete(key);

        return res.status(429).json({
          ok: false,
          code: "TOO_MANY_ATTEMPTS",
          error:
            "Çok fazla yanlış kod girildi. Yeni kod iste."
        });
      }

      if (entry.code !== code) {
        entry.attempts += 1;

        return res.status(400).json({
          ok: false,
          code: "INVALID_CODE",
          error:
            "Kod yanlış. Lütfen tekrar kontrol et."
        });
      }

      const admin = adminClient();

      /*
       * Kod doğru:
       * Supabase Auth kullanıcısının e-postasını doğrula.
       */
      const {
        data: updated,
        error: updateError
      } =
        await admin.auth.admin.updateUserById(
          entry.userId,
          {
            email_confirm: true
          }
        );

      if (updateError) {
        console.error(
          "EMAIL CONFIRM ERROR:",
          updateError
        );

        return res.status(500).json({
          ok: false,
          error:
            "E-posta doğrulanamadı. Lütfen tekrar deneyin."
        });
      }

      registrationCodes.delete(key);

      /*
       * Doğrulama tamamlandıktan sonra otomatik giriş.
       */
      const anon = client();

      const {
        data: loginData,
        error: loginError
      } =
        await anon.auth.signInWithPassword({
          email: entry.email,
          password: String(
            req.body?.password || ""
          )
        });

      /*
       * Şifre frontend tarafından gönderilmiyorsa
       * doğrulama yine başarılı sayılır; frontend normal
       * giriş ekranından devam edebilir.
       */
      if (
        loginError ||
        !loginData?.session
      ) {
        return res.json({
          ok: true,
          verified: true,
          needsLogin: true,
          message:
            "E-posta başarıyla doğrulandı. Şimdi giriş yapabilirsin.",
          user: {
            id: updated?.user?.id || entry.userId,
            email: entry.email,
            username: entry.username,
            displayName: entry.displayName
          }
        });
      }

      return res.json({
        ok: true,
        verified: true,
        token:
          loginData.session.access_token,
        user: {
          id: updated?.user?.id || entry.userId,
          email: entry.email,
          username: entry.username,
          displayName: entry.displayName
        }
      });

    } catch (e) {
      console.error(
        "REGISTER VERIFY ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Doğrulama başarısız."
      });
    }
  }
);

/* =========================================================
   REGISTER RESEND
   ========================================================= */

app.post(
  "/api/register/resend",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(req.body?.email);

      if (!email) {
        return res.status(400).json({
          ok: false,
          error: "E-posta gerekli."
        });
      }

      const key =
        registrationKey(email);

      const entry =
        registrationCodes.get(key);

      if (!entry) {
        return res.status(404).json({
          ok: false,
          error:
            "Bekleyen bir kayıt bulunamadı."
        });
      }

      if (!registrationAllowed(email)) {
        return res.status(429).json({
          ok: false,
          error:
            "Yeni kod göndermek için 60 saniye bekle."
        });
      }

      const admin = adminClient();

      const {
        data: authData,
        error: authError
      } =
        await admin.auth.admin.getUserById(
          entry.userId
        );

      if (
        authError ||
        !authData?.user
      ) {
        registrationCodes.delete(key);

        return res.status(404).json({
          ok: false,
          error:
            "Kayıt bulunamadı. Lütfen yeniden kayıt ol."
        });
      }

      if (
        authData.user.email_confirmed_at
      ) {
        registrationCodes.delete(key);

        return res.json({
          ok: true,
          verified: true,
          message:
            "E-posta zaten doğrulanmış."
        });
      }

      const code =
        createVerificationCode();

      entry.code = code;
      entry.expires =
        Date.now() + 10 * 60 * 1000;
      entry.attempts = 0;

      registrationRate.set(
        key,
        Date.now()
      );

      await sendRegistrationCode(
        email,
        code
      );

      return res.json({
        ok: true,
        message:
          "Yeni 6 haneli doğrulama kodu gönderildi.",
        maskedEmail:
          maskEmail(email)
      });

    } catch (e) {
      console.error(
        "REGISTER RESEND ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Yeni kod gönderilemedi."
      });
    }
  }
);

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
          .eq(
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

        const authId =
          profile.auth_user_id ||
          profile.id;

        const {
          data: au,
          error: ae
        } =
          await admin.auth.admin.getUserById(
            authId
          );

        if (
          ae ||
          !au?.user?.email
        ) {
          return res.status(401).json({
            error:
              "Kullanıcı adı veya şifre hatalı."
          });
        }

        email =
          au.user.email.toLowerCase();
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

function maskEmail(email) {
  const [
    u,
    d
  ] =
    String(email).split("@");

  if (!u || !d) {
    return email;
  }

  const shown =
    u.length <= 2
      ? u[0] + "*"
      : u.slice(0, 2) +
        "*".repeat(
          Math.max(
            1,
            u.length - 2
          )
        );

  return `${shown}@${d}`;
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

async function resolveRecoveryEmail(
  identifier,
  mode = "email"
) {
  const anon =
    client();

  const raw =
    String(
      identifier || ""
    ).trim();

  let email = raw;
  let profile = null;
  let authUser = null;

  if (
    mode === "phone"
  ) {
    authUser =
      await findUserByPhone(
        raw
      );

    if (
      !authUser?.email
    ) {
      return null;
    }

    email =
      authUser.email;

    const {
      data
    } =
      await anon
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name"
        )
        .or(
          `id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`
        )
        .limit(1)
        .maybeSingle();

    profile =
      data || null;

    return {
      email,
      profile,
      authUser
    };
  }

  if (
    !email.includes("@")
  ) {
    profile =
      await findProfile(
        anon,
        email
      );

    if (!profile) {
      return null;
    }

    if (
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return null;
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
      return null;
    }

    email =
      data.user.email;

    authUser =
      data.user;
  }

  if (!profile) {
    const {
      data
    } =
      await anon
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name"
        )
        .eq(
          "email",
          email
        )
        .maybeSingle();

    profile =
      data || null;
  }

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
   RESEND
========================================================= */

async function sendResendEmail(
  to,
  subject,
  html,
  text
) {
  const key =
    String(
      process.env.RESEND_API_KEY ||
      ""
    ).trim();

  if (!key) {
    throw new Error(
      "RESEND_API_KEY eksik."
    );
  }

  const from =
    String(
      process.env.RESEND_FROM_EMAIL ||
      "onboarding@resend.dev"
    ).trim();

  const r =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${key}`,
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          text
        })
      }
    );

  const j =
    await r
      .json()
      .catch(
        () => ({})
      );

  if (!r.ok) {
    throw new Error(
      j.message ||
      "E-posta gönderilemedi."
    );
  }

  return j;
}

const recoveryCodes =
  new Map();


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

      recoveryCodes.set(
        found.email.toLowerCase(),
        {
          code,
          expires:
            Date.now() +
            10 * 60 * 1000,
          profile:
            found.profile
        }
      );

      await sendResendEmail(
        found.email,
        "Minegram doğrulama kodun",

        `<div style="font-family:Arial,sans-serif">
          <h2>Minegram</h2>
          <p>Şifre sıfırlama işlemin için doğrulama kodun:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px">
            ${code}
          </div>
          <p>Bu kod 10 dakika geçerlidir.</p>
        </div>`,

        `Minegram doğrulama kodun: ${code}\nBu kod 10 dakika geçerlidir.`
      );

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
   FORGOT VERIFY
========================================================= */

app.post(
  "/api/forgot/verify",
  async (req, res) => {
    try {
      const found =
        await resolveRecoveryEmail(
          req.body?.identifier,
          req.body?.mode ||
            "email"
        );

      if (!found) {
        return res.status(400).json({
          error:
            "Hesap bulunamadı."
        });
      }

      const key =
        found.email.toLowerCase();

      const entry =
        recoveryCodes.get(
          key
        );

      if (
        !entry ||
        entry.expires <
          Date.now() ||
        entry.code !==
          String(
            req.body?.code ||
            ""
          ).trim()
      ) {
        return res.status(400).json({
          error:
            "Kod yanlış veya süresi dolmuş."
        });
      }

      recoveryCodes.delete(
        key
      );

      const p =
        entry.profile ||
        found.profile ||
        {};

      res.json({
        ok: true,
        email:
          found.email,

        account: {
          username:
            p.username ||
            "minegram",

          email:
            found.email,

          displayName:
            p.display_name ||
            p.displayName ||
            ""
        }
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
   FEED
========================================================= */

app.get(
  "/api/feed",
  auth,
  async (req, res) => {
    try {
      const {
        data,
        error
      } =
        await req.sb
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

      let firebasePosts = [];
      try {
        firebasePosts = await getFirebasePublicPosts();
      } catch (firebaseError) {
        console.warn("MINEGRAM FIREBASE FEED READ SKIPPED:", firebaseError?.message || firebaseError);
      }
      const merged = [...(data || []), ...firebasePosts];
      const seen = new Set();
      const unique = merged.filter(p => {
        const key = `${String(p.username || p.user_id || "").toLowerCase()}_${String(p.id)}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).sort((a,b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, 100);
      const supa = unique.filter(p => !p._firebase);
      const fb = unique.filter(p => p._firebase).map(p => ({
        id: p.id, user_id: p.user_id, caption: p.caption, text: p.text,
        media_url: p.media_url, media_type: p.media_type, likes: p.likes,
        comment_count: p.comment_count, created_at: p.created_at,
        username: p.username
      }));
      res.json([...(await hydratePosts(req.sb, supa, req.user.id)), ...fb]);
    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   HIGHLIGHTS
   Android + Web ortak Öne Çıkanlar sistemi
========================================================= */

app.get(
  "/api/users/:username/highlights",
  auth,
  async (req, res) => {
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

      const { data, error } = await req.sb
        .from("highlights")
        .select("*")
        .eq("user_id", target.id)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      const supaItems = (data || []).map(h => ({
        id: h.id, userId: h.user_id, media: h.media_url, mediaUrl: h.media_url,
        mediaType: h.media_type || "", title: h.title || "Öne çıkan",
        sortOrder: h.sort_order ?? 0, createdAt: h.created_at
      }));
      const firebaseItems = await getFirebaseHighlightsForUser(target.username);
      const all = [...supaItems, ...firebaseItems];
      const seen = new Set();
      res.json(all.filter(x => { const k = String(x.mediaUrl || x.media_url || x.media || ""); if (k && seen.has(k)) return false; if (k) seen.add(k); return true; }));
    } catch (e) {
      console.error("HIGHLIGHTS GET ERROR:", e);
      res.status(500).json({
        error: e.message
      });
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

      if (error) {
        throw error;
      }

      const firebaseItems = await getFirebaseHighlightsForUser(req.user.username || req.user.email?.split("@")[0] || "");
      const supaItems = data || [];
      const merged = [...supaItems, ...firebaseItems];
      const seen = new Set();
      res.json(merged.filter(x => { const k = String(x.mediaUrl || x.media_url || x.media || ""); if (k && seen.has(k)) return false; if (k) seen.add(k); return true; }));
    } catch (e) {
      console.error("MY HIGHLIGHTS ERROR:", e);
      res.status(500).json({
        error: e.message
      });
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
        return res.status(400).json({
          error: "Öne çıkan için medya dosyası seçilmedi"
        });
      }

      const admin = adminClient();

      const ext =
        path.extname(req.file.originalname).toLowerCase() || ".bin";

      const objectPath =
        `highlights/${req.user.id}/${crypto.randomUUID()}${ext}`;

      const { error: uploadError } =
        await admin.storage
          .from(BUCKET)
          .upload(
            objectPath,
            req.file.buffer,
            {
              contentType: req.file.mimetype,
              upsert: false
            }
          );

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicData } =
        admin.storage
          .from(BUCKET)
          .getPublicUrl(objectPath);

      const title =
        String(req.body?.title || "Öne çıkan").trim().slice(0, 80) ||
        "Öne çıkan";

      const requestedSort = Number(req.body?.sortOrder);
      const sortOrder = Number.isFinite(requestedSort)
        ? requestedSort
        : 0;

      const { data, error } =
        await admin
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

      if (error) {
        throw error;
      }

      await mirrorHighlightToFirebase(data, req.user);

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
      res.status(400).json({
        error: e.message
      });
    }
  }
);

app.patch(
  "/api/highlights/:id",
  auth,
  async (req, res) => {
    try {
      if (String(req.params.id || "").startsWith("firebase:")) {
        const ok = await updateFirebaseHighlightDocument(req.params.id, { title: req.body?.title });
        if (!ok) return res.status(404).json({ error: "Öne çıkan bulunamadı" });
        return res.json({ ok: true, id: req.params.id });
      }
      const patch = {};

      if (req.body?.title !== undefined) {
        patch.title =
          String(req.body.title).trim().slice(0, 80) || "Öne çıkan";
      }

      if (req.body?.sortOrder !== undefined) {
        const sortOrder = Number(req.body.sortOrder);
        if (Number.isFinite(sortOrder)) {
          patch.sort_order = sortOrder;
        }
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({
          error: "Güncellenecek bilgi yok"
        });
      }

      const { data, error } =
        await req.sb
          .from("highlights")
          .update(patch)
          .eq("id", req.params.id)
          .eq("user_id", req.user.id)
          .select("*")
          .single();

      if (error) {
        throw error;
      }

      await mirrorHighlightToFirebase(data, req.user);

      res.json({
        ok: true,
        ...data
      });
    } catch (e) {
      console.error("HIGHLIGHT UPDATE ERROR:", e);
      res.status(400).json({
        error: e.message
      });
    }
  }
);

app.delete(
  "/api/highlights/:id",
  auth,
  async (req, res) => {
    try {
      if (String(req.params.id || "").startsWith("firebase:")) {
        const ok = await (await deleteHighlightFromFirebase(req.params.id, req.user), true);
        if (!ok) return res.status(404).json({ error: "Öne çıkan bulunamadı" });
        return res.json({ ok: true, id: req.params.id });
      }
      const { data: existing, error: findError } =
        await req.sb
          .from("highlights")
          .select("id,media_url")
          .eq("id", req.params.id)
          .eq("user_id", req.user.id)
          .maybeSingle();

      if (findError) {
        throw findError;
      }

      if (!existing) {
        return res.status(404).json({
          error: "Öne çıkan bulunamadı"
        });
      }

      const { error } =
        await req.sb
          .from("highlights")
          .delete()
          .eq("id", req.params.id)
          .eq("user_id", req.user.id);

      if (error) {
        throw error;
      }

      await deleteHighlightFromFirebase(req.params.id, req.user);

      res.json({
        ok: true,
        id: req.params.id
      });
    } catch (e) {
      console.error("HIGHLIGHT DELETE ERROR:", e);
      res.status(400).json({
        error: e.message
      });
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

        mediaUrl =
          publicData.publicUrl;

        mediaName =
          req.file.originalname;

        mediaType =
          req.file.mimetype;
      }

      const {
        data,
        error
      } =
        await req.sb
          .from("posts")
          .insert({
            user_id:
              req.user.id,

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

      console.log(
        "MINEGRAM POST CREATE OK:",
        {
          postId: data.id,
          userId: data.user_id,
          mediaUrl: data.media_url
        }
      );

      await mirrorPostToFirebase(data, req.user);

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
   STORIES CREATE
========================================================= */

app.post(
  "/api/stories",
  auth,
  upload.fields([{ name: "story", maxCount: 1 }, { name: "media", maxCount: 1 }]),
  async (req, res) => {
    try {
      const reqFiles = req.files || {};
      const reqFile = reqFiles?.story?.[0] || reqFiles?.media?.[0] || null;
      if (!reqFile) {
        return res.status(400).json({
          error:
            "Dosya seçilmedi"
        });
      }

      const ext =
        path.extname(
          reqFile.originalname
        ) || ".bin";

      const objectPath =
        `stories/${req.user.id}/${crypto.randomUUID()}${ext}`;

      const {
        error: uploadError
      } =
        await admin.storage
          .from(BUCKET)
          .upload(
            objectPath,
            reqFile.buffer,
            {
              contentType:
                reqFile.mimetype,
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

      const result =
        await admin
          .from("stories")
          .insert({
            user_id:
              req.user.id,

            media_url:
              publicData.publicUrl,

            media_type:
              reqFile.mimetype
          })
          .select()
          .single();

      if (result.error) {
        throw result.error;
      }

      await mirrorStoryToFirebase(result.data, req.user);

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

      let firebaseStories = [];
      try {
        firebaseStories = await getFirebasePublicStories();
      } catch (firebaseError) {
        console.warn("MINEGRAM FIREBASE STORY READ SKIPPED:", firebaseError?.message || firebaseError);
      }
      const merged = [...(data || []), ...firebaseStories];
      const seen = new Set();
      res.json(merged.filter(x => {
        const k = `${String(x.username || x.user_id || "").toLowerCase()}_${String(x.id)}`;
        if (seen.has(k)) return false; seen.add(k); return true;
      }).sort((a,b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)));
    } catch (e) {
      res.status(500).json({
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   POST DELETE
   Profil + Ana Sayfa + Gönderi detay ortak silme sistemi
========================================================= */

app.delete(
  "/api/posts/:id",
  auth,
  async (req, res) => {
    const postId = String(req.params.id || "").trim();

    if (!postId) {
      return res.status(400).json({
        error: "Gönderi ID gerekli"
      });
    }

    try {
      /*
       * Önce gönderinin gerçekten mevcut olduğunu ve
       * silmek isteyen kullanıcının sahibi olduğunu kontrol et.
       */
      const {
        data: post,
        error: postFindError
      } = await req.sb
        .from("posts")
        .select("id,user_id,media_url")
        .eq("id", postId)
        .maybeSingle();

      if (postFindError) {
        throw postFindError;
      }

      if (!post) {
        return res.status(404).json({
          error: "Gönderi bulunamadı"
        });
      }

      if (String(post.user_id) !== String(req.user.id)) {
        return res.status(403).json({
          error: "Bu gönderiyi silme yetkiniz yok"
        });
      }

      /*
       * Service-role ile temizlik yapıyoruz. Böylece RLS
       * nedeniyle ilişkili kayıtların silinememesi önlenir.
       */
      const admin = adminClient();

      /* Beğeniler */
      const { error: likesError } = await admin
        .from("post_likes")
        .delete()
        .eq("post_id", postId);

      if (likesError) {
        throw likesError;
      }

      /* Yorumlar */
      const { error: commentsError } = await admin
        .from("comments")
        .delete()
        .eq("post_id", postId);

      if (commentsError) {
        throw commentsError;
      }

      /* Kaydedilenler */
      const { error: savesError } = await admin
        .from("saves")
        .delete()
        .eq("post_id", postId);

      if (savesError) {
        throw savesError;
      }

      /* Bu gönderiye ait bildirimleri de temizle. */
      const { error: notificationsError } = await admin
        .from("notifications")
        .delete()
        .eq("post_id", postId);

      if (notificationsError) {
        throw notificationsError;
      }

      /* En son ana gönderiyi sil. */
      const {
        data: deletedPost,
        error: deletePostError
      } = await admin
        .from("posts")
        .delete()
        .eq("id", postId)
        .eq("user_id", req.user.id)
        .select("id")
        .maybeSingle();

      if (deletePostError) {
        throw deletePostError;
      }

      if (!deletedPost) {
        return res.status(404).json({
          error: "Gönderi silinemedi veya zaten silinmiş"
        });
      }

      console.log(
        `[POST DELETE] ${postId} -> user ${req.user.id}`
      );

      await deletePostFromFirebase(postId, req.user);

      return res.json({
        ok: true,
        deleted: true,
        id: postId
      });
    } catch (e) {
      console.error(
        "POST DELETE ERROR:",
        e
      );

      return res.status(500).json({
        error:
          e?.message ||
          "Gönderi silinemedi"
      });
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

      res.json({
        id:
          data.id,

        userId:
          data.user_id,

        text:
          data.text,

        createdAt:
          data.created_at,

        username:
          req.user.username
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
        await req.sb
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

      if (
        target.id ===
        req.user.id
      ) {
        return res.status(400).json({
          error:
            "Kendini takip edemezsin"
        });
      }

      const {
        data: existing
      } =
        await req.sb
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
            target.id
          )
          .maybeSingle();

      if (existing) {
        await req.sb
          .from("follows")
          .delete()
          .eq(
            "follower_id",
            req.user.id
          )
          .eq(
            "following_id",
            target.id
          );

        return res.json({
          following:
            false
        });
      }

      const {
        error
      } =
        await req.sb
          .from("follows")
          .insert({
            follower_id:
              req.user.id,

            following_id:
              target.id
          });

      if (error) {
        throw error;
      }

      await addNotification({
        userId:
          target.id,

        fromUserId:
          req.user.id,

        type:
          "follow",

        text:
          `@${req.user.username} seni takip etti`
      });

      res.json({
        following:
          true
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

      const {
        data,
        error
      } =
        await req.sb
          .from("posts")
          .select("*")
          .eq(
            "user_id",
            target.id
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

      const username = req.params.username;
      let firebasePosts = [];
      try {
        firebasePosts = (await getFirebasePublicPosts()).filter(p => String(p.username || "").toLowerCase() === String(username).toLowerCase());
      } catch (firebaseError) {
        console.warn("MINEGRAM FIREBASE POST READ SKIPPED:", firebaseError?.message || firebaseError);
      }
      const supaPosts = await hydratePosts(req.sb, data || [], req.user.id);
      const merged = [...supaPosts, ...firebasePosts.map(p => ({
        id:p.id, user_id:p.user_id, username:p.username, caption:p.caption, text:p.text,
        media_url:p.media_url, media_type:p.media_type, likes:p.likes,
        comment_count:p.comment_count, created_at:p.created_at
      }))];
      const seen = new Set();
      res.json(merged.filter(p => { const k=String(p.username||username).toLowerCase()+"_"+String(p.id); if(seen.has(k)) return false; seen.add(k); return true; }));

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

      const admin = adminClient();

      const [
        postCountResult,
        followersResult,
        followingResult,
        followingByMeResult
      ] =
        await Promise.all([
          admin
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
      const q =
        String(
          req.query.q || ""
        )
          .trim()
          .toLowerCase();

      if (!q) {
        return res.json([]);
      }

      const {
        data,
        error
      } =
        await req.sb
          .from("profiles")
          .select(
            "id,username,display_name,bio,avatar_url,verified"
          )
          .or(
            `username.ilike.%${q}%,display_name.ilike.%${q}%`
          )
          .limit(20);

      if (error) {
        throw error;
      }

      res.json(
        (data || []).map(
          safeUser
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

      res.json(
        (data || []).map(
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
