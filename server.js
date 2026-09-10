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

async function isAuthUserActive(userId) {
  if (!userId || !SUPABASE_SERVICE_ROLE_KEY) return false;

  try {
    const admin = adminClient();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    return !error && !!data?.user?.id;
  } catch (e) {
    console.error("ACTIVE USER CHECK ERROR:", e?.message || e);
    return false;
  }
}

async function filterActiveContent(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];

  // Eski Minegram kayıtlarında user_id bazen profiles.id, bazen
  // Supabase Auth user.id olarak tutulabiliyor. Sadece Auth id ile
  // kontrol etmek eski cihazlarda oluşturulmuş içerikleri yanlışlıkla
  // gizliyordu. Önce profiles tablosundaki iki kimliği eşleştiriyoruz.
  const ids = [...new Set(rows.map(x => String(x?.user_id || "").trim()).filter(Boolean))];
  if (!ids.length) return [];

  const admin = adminClient();
  const { data: profiles, error } = await admin
    .from("profiles")
    .select("id,auth_user_id")
    .or(`id.in.(${ids.join(",")}),auth_user_id.in.(${ids.join(",")})`);

  if (error) {
    console.warn("CONTENT PROFILE FILTER ERROR:", error.message);
    // Profil sorgusu geçici olarak başarısızsa ortak feed'i boşaltma.
    return rows;
  }

  const validIds = new Set();
  for (const p of profiles || []) {
    if (p?.id) validIds.add(String(p.id));
    if (p?.auth_user_id) validIds.add(String(p.auth_user_id));
  }

  // Profil eşleşmesi varsa Auth hesabının gerçekten mevcut olduğunu da
  // doğrula. Eşleşme yoksa içeriği sırf eski id formatı nedeniyle silme.
  const authIds = [...new Set((profiles || []).map(p => p?.auth_user_id || p?.id).filter(Boolean).map(String))];
  const activeIds = new Set();
  await Promise.all(authIds.map(async id => {
    if (await isAuthUserActive(id)) activeIds.add(id);
  }));

  if (!activeIds.size) return rows;

  const activeContentIds = new Set();
  for (const p of profiles || []) {
    const authId = String(p?.auth_user_id || p?.id || "");
    if (activeIds.has(authId)) {
      if (p?.id) activeContentIds.add(String(p.id));
      if (p?.auth_user_id) activeContentIds.add(String(p.auth_user_id));
    }
  }

  return rows.filter(x => {
    const id = String(x?.user_id || "");
    return activeContentIds.has(id) || (!validIds.has(id) && id.length > 0);
  });
}

async function filterActivePosts(posts) {
  return filterActiveContent(posts);
}

async function filterActiveStories(stories) {
  return filterActiveContent(stories);
}

async function filterActiveProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) return [];

  const active = [];
  await Promise.all(profiles.map(async profile => {
    const userId = profile?.auth_user_id || profile?.id;
    if (await isAuthUserActive(userId)) active.push(profile);
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
        "id,auth_user_id,username,display_name,bio,avatar_url,verified"
      )
      .or(`id.in.(${userIds.join(",")}),auth_user_id.in.(${userIds.join(",")})`),

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

  const pmap = new Map();
  for (const p of profiles) {
    if (p?.id) pmap.set(String(p.id), p);
    if (p?.auth_user_id) pmap.set(String(p.auth_user_id), p);
  }

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
        data: existingProfiles,
        error: usernameCheckError
      } = await admin
        .from("profiles")
        .select("id,username,auth_user_id,email")
        .ilike("username", username)
        .limit(50);

      const existingProfile = (existingProfiles || [])
        .find(p => normalizeUsername(p?.username) === username) || null;

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

      // profiles satırı silinmiş/bozulmuş olsa bile Auth metadata'sındaki
      // kullanıcı adını tekrar kullanıma açık bırakma.
      try {
        let authUsernameTaken = false;
        for (let page = 1; page <= 20 && !authUsernameTaken; page++) {
          const result = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (result?.error) break;
          const users = result?.data?.users || [];
          authUsernameTaken = users.some(u => {
            const m = u?.user_metadata || {};
            return [m.username, m.user_name, m.preferred_username, u?.app_metadata?.username]
              .some(v => normalizeUsername(v || "") === username);
          });
          if (users.length < 1000) break;
        }
        if (authUsernameTaken) {
          return res.status(409).json({
            ok: false,
            code: "USERNAME_TAKEN",
            error: "Bu kullanıcı adı zaten alınmış."
          });
        }
      } catch (e) {
        console.error("AUTH USERNAME CHECK ERROR:", e?.message || e);
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

      /* Profil oluştur / mevcut trigger profilini kullan */
      let profile = null;
      let profileError = null;

      // Bazı Minegram Supabase projelerinde Auth kullanıcısı oluşunca
      // profiles satırı trigger ile otomatik oluşturuluyor. Böyle bir satır
      // varsa ikinci kez INSERT yapıp 23505 almamak için önce buluyoruz.
      const existingProfileResult = await admin
        .from("profiles")
        .select("*")
        .eq("id", authUser.id)
        .maybeSingle();

      if (existingProfileResult.error) {
        console.error("PROFILE LOOKUP ERROR:", existingProfileResult.error);
      }

      if (existingProfileResult.data) {
        const updateResult = await admin
          .from("profiles")
          .update({
            username,
            display_name: displayName
          })
          .eq("id", authUser.id)
          .select("*")
          .single();

        profile = updateResult.data;
        profileError = updateResult.error;
      } else {
        const insertResult = await admin
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

        profile = insertResult.data;
        profileError = insertResult.error;

        // Aynı anda bir DB trigger satırı oluşturduysa tekrar okuyup devam et.
        if (profileError?.code === "23505") {
          const retryProfile = await admin
            .from("profiles")
            .select("*")
            .eq("id", authUser.id)
            .maybeSingle();

          if (retryProfile.data) {
            profile = retryProfile.data;
            profileError = null;
          }
        }
      }

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
   LEGACY LOCAL ACCOUNT MIGRATION
========================================================= */
app.post("/api/account/migrate-local", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!username || !email || !password) {
      return res.status(400).json({ ok: false, error: "Eski hesabı taşımak için kullanıcı adı, e-posta ve şifre gerekli." });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "Şifre en az 6 karakter olmalı." });
    }
    if (!CONFIG_OK || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: "Supabase yapılandırması eksik." });
    }

    const admin = adminClient();
    const { data: profiles, error: profileError } = await admin
      .from("profiles")
      .select("*")
      .ilike("username", username)
      .limit(20);

    if (profileError) return res.status(500).json({ ok: false, error: profileError.message });
    let profile = (profiles || []).find(p => normalizeUsername(p?.username) === username) || null;

    // Eski Android hesabı yalnızca MineStorage'da kalmışsa profiles satırı
    // henüz olmayabilir. Bu durumda Auth kullanıcısı da yoksa aşağıda oluşturulur;
    // Auth kullanıcısı varsa mevcut hesabı kullanıp profile satırını tamamlarız.

    let authUser = null;
    if (profile?.auth_user_id || profile?.id) {
      const id = profile?.auth_user_id || profile?.id;
      const { data } = await admin.auth.admin.getUserById(id);
      if (data?.user) authUser = data.user;
    }

    if (!authUser) {
      const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      authUser = (listed?.users || []).find(u => normalizeEmail(u?.email) === email) || null;
    }

    if (!authUser) {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, display_name: profile?.display_name || username }
      });
      if (createError) return res.status(400).json({ ok: false, error: createError.message });
      authUser = created?.user;
    } else {
      const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(authUser.id, {
        password,
        email,
        email_confirm: true,
        user_metadata: { ...(authUser.user_metadata || {}), username }
      });
      if (updateError) return res.status(400).json({ ok: false, error: updateError.message });
      authUser = updated?.user || authUser;
    }

    let updatedProfile = null;
    let upError = null;

    if (profile?.id) {
      const result = await admin
        .from("profiles")
        .update({ auth_user_id: authUser.id, email, username })
        .eq("id", profile.id)
        .select("*")
        .maybeSingle();
      updatedProfile = result.data;
      upError = result.error;
    } else {
      // Tamamen yerel kalmış eski hesap: Supabase Auth kullanıcısına profile oluştur.
      const result = await admin
        .from("profiles")
        .insert({
          id: authUser.id,
          auth_user_id: authUser.id,
          username,
          display_name: username,
          email,
          bio: "",
          avatar_url: null,
          verified: false,
          settings: {}
        })
        .select("*")
        .single();
      updatedProfile = result.data;
      upError = result.error;

      // Trigger aynı anda profile oluşturmuş olabilir; tekrar okuyup devam et.
      if (upError?.code === "23505") {
        const retry = await admin
          .from("profiles")
          .select("*")
          .eq("id", authUser.id)
          .maybeSingle();
        updatedProfile = retry.data;
        upError = retry.error;
        if (updatedProfile) {
          const fix = await admin
            .from("profiles")
            .update({ auth_user_id: authUser.id, email, username })
            .eq("id", updatedProfile.id)
            .select("*")
            .maybeSingle();
          updatedProfile = fix.data || updatedProfile;
          upError = fix.error;
        }
      }
    }

    if (upError) return res.status(500).json({ ok: false, error: upError.message });

    const anon = client();
    const { data: loginData, error: loginError } = await anon.auth.signInWithPassword({ email, password });
    if (loginError || !loginData?.session) return res.status(401).json({ ok: false, error: loginError?.message || "Hesap taşındı ancak giriş oluşturulamadı." });

    return res.json({
      ok: true,
      migrated: true,
      token: loginData.session.access_token,
      profile: safeProfile(updatedProfile || profile),
      user: safeProfile(updatedProfile || profile)
    });
  } catch (e) {
    console.error("MIGRATE LOCAL ACCOUNT ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Eski hesap sunucuya taşınamadı." });
  }
});

/* =========================================================
   LOGIN - TÜM TELEFONLAR İÇİN
========================================================= */

app.post("/api/login", async (req, res) => {
  try {
    const rawIdentifier = String(
      req.body?.username ?? req.body?.identifier ?? req.body?.email ?? ""
    ).trim();

    const password = String(req.body?.password ?? "");

    if (!rawIdentifier || !password) {
      return res.status(400).json({
        ok: false,
        code: "MISSING_CREDENTIALS",
        error: "Kullanıcı adı/e-posta ve şifre gerekli."
      });
    }

    if (!CONFIG_OK || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        ok: false,
        code: "SERVER_CONFIG_ERROR",
        error: "Sunucu yapılandırması eksik."
      });
    }

    const admin = adminClient();
    const normalizedUsername = normalizeUsername(rawIdentifier);
    let email = "";
    let profile = null;

    // 1) E-posta ile doğrudan giriş
    if (rawIdentifier.includes("@")) {
      email = normalizeEmail(rawIdentifier);
    } else {
      // 2) Kullanıcı adını profiles tablosunda bul
      const { data: profiles, error: profileError } = await admin
        .from("profiles")
        .select("*")
        .limit(100);

      if (profileError) {
        console.error("LOGIN PROFILE SEARCH ERROR:", profileError);
      } else {
        profile = (profiles || []).find(
          p => normalizeUsername(p?.username || "") === normalizedUsername
        ) || null;
      }

      if (profile) {
        email = normalizeEmail(profile.email || "");
        const authUserId = profile.auth_user_id || profile.id;

        if (!email && authUserId) {
          const { data } = await admin.auth.admin.getUserById(authUserId);
          email = normalizeEmail(data?.user?.email || "");
        }
      }

      // 3) profiles bozuk/eksik olsa bile Auth metadata'dan bul
      if (!email) {
        for (let page = 1; page <= 50 && !email; page++) {
          const { data, error } = await admin.auth.admin.listUsers({
            page,
            perPage: 1000
          });

          if (error) {
            console.error("LOGIN AUTH LIST ERROR:", error);
            break;
          }

          const users = data?.users || [];
          const found = users.find(u => {
            const m = u?.user_metadata || {};
            return normalizeUsername(
              m.username ||
              m.user_name ||
              m.preferred_username ||
              ""
            ) === normalizedUsername;
          });

          if (found?.email) {
            email = normalizeEmail(found.email);
            break;
          }

          if (users.length < 1000) break;
        }
      }
    }

    if (!email) {
      return res.status(401).json({
        ok: false,
        code: "USER_NOT_FOUND",
        error: "Bu kullanıcı adı/e-posta ile sunucuda hesap bulunamadı."
      });
    }

    // Gerçek, cihazdan bağımsız Supabase girişi.
    // Profildeki email eski/yanlış kalmışsa girişin bozulmaması için
    // aynı kullanıcı adına bağlı olabilecek Auth e-postalarını da sırayla dene.
    // ŞİFRE DEĞİŞTİRİLMEZ; yalnızca mevcut şifre doğrulanır.
    const candidateEmails = [];
    const addCandidateEmail = (value) => {
      const normalized = normalizeEmail(value || "");
      if (normalized && !candidateEmails.includes(normalized)) {
        candidateEmails.push(normalized);
      }
    };

    addCandidateEmail(email);

    if (!rawIdentifier.includes("@")) {
      // Profiles kaydındaki auth_user_id/id üzerinden Auth e-postasını doğrula.
      const linkedAuthIds = [];
      if (profile?.auth_user_id) linkedAuthIds.push(String(profile.auth_user_id));
      if (profile?.id) linkedAuthIds.push(String(profile.id));

      for (const authId of linkedAuthIds) {
        try {
          const result = await admin.auth.admin.getUserById(authId);
          addCandidateEmail(result?.data?.user?.email || "");
        } catch (e) {
          console.error("LOGIN AUTH USER LOOKUP ERROR:", e?.message || e);
        }
      }

      // Son olarak Auth metadata'sındaki kullanıcı adına bağlı hesabı bul.
      try {
        for (let page = 1; page <= 50; page++) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) break;
          const users = data?.users || [];
          for (const u of users) {
            const m = u?.user_metadata || {};
            const metaUsername = normalizeUsername(
              m.username || m.user_name || m.preferred_username || ""
            );
            if (metaUsername === normalizedUsername) addCandidateEmail(u?.email || "");
          }
          if (users.length < 1000) break;
        }
      } catch (e) {
        console.error("LOGIN AUTH METADATA SEARCH ERROR:", e?.message || e);
      }
    }

    let loginData = null;
    let loginError = null;

    for (const candidateEmail of candidateEmails) {
      const attempt = await client().auth.signInWithPassword({
        email: candidateEmail,
        password
      });
      if (attempt.data?.session && attempt.data?.user) {
        loginData = attempt.data;
        loginError = null;
        email = candidateEmail;
        break;
      }
      loginError = attempt.error;
    }

    if (!loginData?.session || !loginData?.user) {
      console.error("LOGIN AUTH ERROR:", {
        identifier: rawIdentifier,
        candidateEmails,
        message: loginError?.message
      });

      if (/email not confirmed/i.test(loginError?.message || "")) {
        return res.status(403).json({
          ok: false,
          code: "EMAIL_NOT_CONFIRMED",
          error: "E-posta adresin henüz doğrulanmamış."
        });
      }

      // Bu hata cihaz problemi değildir. Supabase'deki parola ile
      // gönderilen parola aynı değildir.
      return res.status(401).json({
        ok: false,
        code: "INVALID_SUPABASE_PASSWORD",
        error: "Sunucudaki şifre ile girdiğin şifre eşleşmiyor. Şifre sıfırlama kullan."
      });
    }

    const authUser = loginData.user;

    // Profilin güncel halini bul
    if (!profile) {
      const byAuth = await admin
        .from("profiles")
        .select("*")
        .eq("auth_user_id", authUser.id)
        .maybeSingle();

      profile = byAuth.data || null;

      if (!profile) {
        const byId = await admin
          .from("profiles")
          .select("*")
          .eq("id", authUser.id)
          .maybeSingle();

        profile = byId.data || null;
      }
    }

    // Profil yoksa oluştur
    if (!profile) {
      const meta = authUser.user_metadata || {};
      const username = normalizeUsername(
        meta.username || authUser.email.split("@")[0]
      );

      const created = await admin
        .from("profiles")
        .insert({
          id: authUser.id,
          auth_user_id: authUser.id,
          username,
          display_name: meta.display_name || username,
          email: authUser.email,
          bio: "",
          avatar_url: null,
          verified: false,
          settings: {}
        })
        .select("*")
        .single();

      if (created.error) {
        console.error("LOGIN PROFILE CREATE ERROR:", created.error);
      }
      profile = created.data || null;
    }

    return res.json({
      ok: true,
      token: loginData.session.access_token,
      access_token: loginData.session.access_token,
      refreshToken: loginData.session.refresh_token,
      refresh_token: loginData.session.refresh_token,
      user: safeProfile(profile),
      profile: safeProfile(profile)
    });

  } catch (error) {
    console.error("LOGIN SERVER ERROR:", error);
    return res.status(500).json({
      ok: false,
      code: "LOGIN_SERVER_ERROR",
      error: error?.message || "Giriş sırasında sunucu hatası oluştu."
    });
  }
});

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
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ ok:false, error:"Oturum bulunamadı." });

    try {
      const admin = adminClient();

      const { data: userPosts, error: postsReadError } = await admin
        .from("posts")
        .select("id,media_url")
        .eq("user_id", userId);
      if (postsReadError) throw postsReadError;

      const postIds = (userPosts || []).map(p => p.id).filter(Boolean);

      // Gönderiye bağlı kayıtları temizle.
      if (postIds.length) {
        for (const table of ["comments", "post_likes", "saves", "notifications"]) {
          const { error } = await admin.from(table).delete().in("post_id", postIds);
          if (error) console.warn(`ACCOUNT DELETE ${table}:`, error.message);
        }
      }

      // Kullanıcıya ait sosyal ilişkiler ve içerikler.
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
        ["highlights", "user_id"]
      ];

      for (const [table, column] of cleanup) {
        try {
          const { error } = await admin.from(table).delete().eq(column, userId);
          if (error) console.warn(`ACCOUNT DELETE ${table}.${column}:`, error.message);
        } catch (e) {
          console.warn(`ACCOUNT DELETE ${table}.${column} EXCEPTION:`, e?.message || e);
        }
      }

      if (postIds.length) {
        const { error } = await admin.from("posts").delete().eq("user_id", userId);
        if (error) throw error;
      }

      // Storage: kullanıcıya ait eski medya klasörlerini de temizle.
      for (const prefix of ["stories/", "highlights/", ""]) {
        try {
          const pathPrefix = prefix === "" ? userId : `${prefix}${userId}`;
          const { data: objects, error: listError } = await admin.storage
            .from(BUCKET)
            .list(pathPrefix, { limit: 1000 });
          if (listError) {
            console.warn("ACCOUNT STORAGE LIST:", listError.message);
            continue;
          }
          const names = (objects || []).map(o => `${pathPrefix}/${o.name}`);
          if (names.length) {
            const { error: removeError } = await admin.storage.from(BUCKET).remove(names);
            if (removeError) console.warn("ACCOUNT STORAGE REMOVE:", removeError.message);
          }
        } catch (e) {
          console.warn("ACCOUNT STORAGE EXCEPTION:", e?.message || e);
        }
      }

      const { error: profileError } = await admin
        .from("profiles")
        .delete()
        .eq("id", userId);
      if (profileError) throw profileError;

      const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
      if (authDeleteError) throw authDeleteError;

      return res.json({ ok:true, deleted:true, id:userId });
    } catch (e) {
      console.error("ACCOUNT DELETE ERROR:", e);
      return res.status(500).json({ ok:false, error:e?.message || "Hesap silinemedi." });
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

      // Feed ortak akış olduğu için hydrate işlemlerinde JWT/RLS client
      // kullanılmamalı. Aksi halde başka kullanıcının gönderisinin profili,
      // beğenileri veya yorumları RLS tarafından boş dönebilir ve Android
      // tarafında gönderi görünmüyor gibi davranabilir.
      const feedHydrateSb = adminClient();
      res.json(
        await hydratePosts(
          feedHydrateSb,
          activePosts,
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

      // Ortak profil verisi: kullanıcı JWT'sinin RLS'i başka kullanıcıların
      // öne çıkanlarını gizlemesin. Okuma service-role ile yapılır.
      const highlightsSb = adminClient();
      const { data, error } = await highlightsSb
        .from("highlights")
        .select("*")
        .eq("user_id", target.id)
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
      // Kendi öne çıkanlarını da service-role ile oku; RLS kaynaklı boş listeyi önle.
      const highlightsSb = adminClient();
      const { data, error } = await highlightsSb
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

      // Hikayeler ortak akıştır. req.sb üzerindeki RLS başka kullanıcıların
      // hikayelerini boş döndürebilir; bu yüzden okuma service-role ile yapılır.
      const storiesSb = adminClient();
      const {
        data,
        error
      } =
        await storiesSb
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

      const activeStories = await filterActiveStories(data || []);

      res.json(
        activeStories
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

      if (!(await isAuthUserActive(target.auth_user_id || target.id))) {
        return res.status(404).json({
          error: "Kullanıcı bulunamadı"
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

      if (!(await isAuthUserActive(target.auth_user_id || target.id))) {
        return res.status(404).json({
          error: "Kullanıcı bulunamadı"
        });
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

      const activeProfiles = await filterActiveProfiles(data || []);

      res.json(
        activeProfiles.map(
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
