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

    let reusedOrphanProfile = false;
    let reusedProfileId = null;
    let oldAuthUserId = null;
    let newProfileCreated = false;

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

      /* =========================
         TEMEL KONTROLLER
      ========================= */

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
          error:
            "Supabase yapılandırması eksik."
        });
      }

      if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({
          ok: false,
          code: "SERVICE_ROLE_MISSING",
          error:
            "SUPABASE_SERVICE_ROLE_KEY eksik."
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

      /* =========================
         KULLANICI ADI KONTROLÜ
         
         ÖNEMLİ:
         Profil varsa ama auth.users içinde
         karşılığı yoksa bu bir YETİM PROFİLDİR.
         
         Böyle bir profili silmiyoruz.
         Yeni Auth hesabına bağlıyoruz.
      ========================= */

      const {
        data: existingProfile,
        error: usernameCheckError
      } = await admin
        .from("profiles")
        .select("*")
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

        const existingAuthId =
          existingProfile.auth_user_id ||
          existingProfile.id ||
          null;

        let authExists = false;

        if (existingAuthId) {
          try {
            const {
              data: authLookup,
              error: authLookupError
            } =
              await admin.auth.admin.getUserById(
                existingAuthId
              );

            if (
              !authLookupError &&
              authLookup?.user
            ) {
              authExists = true;
            }
          } catch (authLookupException) {
            console.error(
              "EXISTING AUTH LOOKUP ERROR:",
              authLookupException
            );
          }
        }

        /*
         * Auth hesabı gerçekten varsa:
         * kullanıcı adı kullanılıyor.
         */
        if (authExists) {
          return res.status(409).json({
            ok: false,
            code: "USERNAME_TAKEN",
            error:
              "Bu kullanıcı adı zaten alınmış."
          });
        }

        /*
         * Buraya geldiysek:
         *
         * profiles kaydı VAR
         * fakat auth.users kaydı YOK.
         *
         * Yani ORPHAN / YETİM PROFİL.
         */

        reusedOrphanProfile = true;
        reusedProfileId = existingProfile.id;
        oldAuthUserId =
          existingProfile.auth_user_id || null;

        console.log(
          "ORPHAN PROFILE REUSE:",
          {
            profileId: reusedProfileId,
            oldAuthUserId,
            username
          }
        );
      }

      /* =========================
         E-POSTA KONTROLÜ
      ========================= */

      try {
        let emailAlreadyExists = false;

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
                normalizeEmail(u?.email) ===
                email
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

      /* =========================
         SUPABASE AUTH KULLANICISI
      ========================= */

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
          String(
            createError.message || ""
          );

        if (
          /already registered/i.test(
            message
          ) ||
          /already exists/i.test(
            message
          ) ||
          /user already registered/i.test(
            message
          )
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
            message ||
            "Kayıt başarısız."
        });
      }

      const authUser =
        created?.user;

      if (!authUser?.id) {
        return res.status(400).json({
          ok: false,
          code: "USER_CREATE_FAILED",
          error:
            "Kullanıcı oluşturulamadı."
        });
      }

      createdAuthUserId =
        authUser.id;

      /* =========================
         PROFİL İŞLEMİ
      ========================= */

      let profile = null;
      let profileError = null;

      /*
       * 1) YETİM PROFİL VARSA
       *
       * profiles.id DEĞİŞMEZ.
       *
       * Sadece auth_user_id yeni Auth
       * kullanıcısına bağlanır.
       */

      if (
        reusedOrphanProfile &&
        reusedProfileId
      ) {

        const updatePayload = {
          auth_user_id: authUser.id,
          username,
          display_name: displayName
        };

        /*
         * Mevcut profil bilgilerini
         * kesinlikle silmiyoruz.
         */

        const updated =
          await admin
            .from("profiles")
            .update(updatePayload)
            .eq(
              "id",
              reusedProfileId
            )
            .select("*")
            .single();

        profile =
          updated.data;

        profileError =
          updated.error;

        if (profileError) {
          console.error(
            "ORPHAN PROFILE REPAIR ERROR:",
            profileError
          );
        }

      } else {

        /*
         * 2) NORMAL YENİ PROFİL
         *
         * Önce trigger tarafından
         * oluşturulmuş olabilir mi diye bak.
         */

        const {
          data: existingById,
          error: existingByIdError
        } = await admin
          .from("profiles")
          .select("*")
          .eq(
            "id",
            authUser.id
          )
          .maybeSingle();

        if (existingByIdError) {
          console.error(
            "PROFILE LOOKUP ERROR:",
            existingByIdError
          );
        }

        if (existingById) {

          const updatePayload = {
            username,
            display_name:
              displayName,
            bio:
              existingById.bio ??
              "",
            avatar_url:
              existingById.avatar_url ??
              null,
            verified:
              existingById.verified ??
              false,
            settings:
              existingById.settings ??
              {}
          };

          if (
            Object.prototype.hasOwnProperty.call(
              existingById,
              "auth_user_id"
            )
          ) {
            updatePayload.auth_user_id =
              authUser.id;
          }

          const updated =
            await admin
              .from("profiles")
              .update(
                updatePayload
              )
              .eq(
                "id",
                authUser.id
              )
              .select("*")
              .single();

          profile =
            updated.data;

          profileError =
            updated.error;

        } else {

          /*
           * Yepyeni profil oluştur.
           */

          const insertPayload = {
            id: authUser.id,
            username,
            display_name:
              displayName,
            bio: "",
            avatar_url: null,
            verified: false,
            settings: {}
          };

          /*
           * auth_user_id kolonu varsa
           * mutlaka doldur.
           */

          const schemaProbe =
            await admin
              .from("profiles")
              .select(
                "auth_user_id"
              )
              .limit(1);

          if (!schemaProbe.error) {
            insertPayload.auth_user_id =
              authUser.id;
          }

          let inserted =
            await admin
              .from("profiles")
              .insert(
                insertPayload
              )
              .select("*")
              .single();

          /*
           * Eğer auth_user_id kolonu
           * problemi olduysa fallback.
           */

          if (
            inserted.error &&
            /auth_user_id|column/i.test(
              String(
                inserted.error.message ||
                  ""
              )
            ) &&
            Object.prototype.hasOwnProperty.call(
              insertPayload,
              "auth_user_id"
            )
          ) {
            const fallbackPayload =
              {
                ...insertPayload
              };

            delete fallbackPayload.auth_user_id;

            inserted =
              await admin
                .from("profiles")
                .insert(
                  fallbackPayload
                )
                .select("*")
                .single();
          }

          if (inserted.error) {
            console.error(
              "PROFILE INSERT ERROR:",
              inserted.error
            );

            /*
             * Trigger aynı anda oluşturmuş
             * olabilir.
             */

            const retry =
              await admin
                .from("profiles")
                .select("*")
                .eq(
                  "id",
                  authUser.id
                )
                .maybeSingle();

            if (retry.data) {
              profile =
                retry.data;
              profileError =
                null;
            } else {
              profile = null;
              profileError =
                inserted.error;
            }

          } else {
            profile =
              inserted.data;

            profileError =
              null;

            newProfileCreated =
              true;
          }
        }
      }

      /* =========================
         PROFİL KONTROLÜ
      ========================= */

      if (
        profileError ||
        !profile
      ) {
        console.error(
          "PROFILE CREATE/REPAIR ERROR:",
          profileError ||
            "Profil bulunamadı."
        );

        /*
         * Yeni Auth hesabını temizle.
         */

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

        createdAuthUserId =
          null;

        return res.status(500).json({
          ok: false,
          code: "PROFILE_CREATE_ERROR",
          error:
            "Profil oluşturulamadı.",
          details:
            profileError?.message ||
            null
        });
      }

      /* =========================
         6 HANELİ DOĞRULAMA KODU
      ========================= */

      const code =
        createVerificationCode();

      registrationCodes.set(
        registrationKey(email),
        {
          code,
          userId: authUser.id,
          email,
          expires:
            Date.now() +
            10 * 60 * 1000,
          attempts: 0,
          username,
          displayName,

          /*
           * Doğrulama sırasında
           * hangi profile bağlandığını
           * bilmek için.
           */
          profileId:
            profile.id
        }
      );

      registrationRate.set(
        registrationKey(email),
        Date.now()
      );

      /* =========================
         E-POSTA GÖNDER
      ========================= */

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

        /*
         * Auth hesabını sil.
         */

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

        /*
         * Eğer yetim profili
         * yeniden kullandıysak eski
         * auth_user_id değerini geri koy.
         *
         * profiles.id kesinlikle değişmez.
         */

        if (
          reusedOrphanProfile &&
          reusedProfileId
        ) {

          try {
            await admin
              .from("profiles")
              .update({
              auth_user_id: oldAuthUserId
              })
              .eq(
                "id",
                reusedProfileId
              );

          } catch (restoreError) {
            console.error(
              "ORPHAN PROFILE RESTORE ERROR:",
              restoreError
            );
          }
        }

        /*
         * Yeni profil oluşturulduysa
         * profil de temizlenebilir.
         */

        if (
          newProfileCreated
        ) {
          try {
            await admin
              .from("profiles")
              .delete()
              .eq(
                "id",
                authUser.id
              );
          } catch (profileCleanupError) {
            console.error(
              "PROFILE CLEANUP ERROR:",
              profileCleanupError
            );
          }
        }

        return res.status(500).json({
          ok: false,
          code: "EMAIL_SEND_ERROR",
          error:
            mailError?.message ||
            "Doğrulama e-postası gönderilemedi."
        });
      }

      /*
       * Başarılı.
       */

      createdAuthUserId =
        null;

      return res.json({
        ok: true,
        needsEmailVerification:
          true,
        message:
          "Devam ettiğinizde, e-posta adresinize 6 haneli bir doğrulama kodu gönderilecektir.",
        maskedEmail:
          maskEmail(email),
        email,

        user: {
          id: profile.id,
          auth_user_id:
            authUser.id,
          email:
            authUser.email,
          username,
          displayName
        }
      });

    } catch (e) {

      console.error(
        "REGISTER ERROR:",
        e
      );

      /*
       * Beklenmeyen hata:
       * yeni Auth hesabını temizle.
       */

      if (
        createdAuthUserId
      ) {
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

      /*
       * Yetim profil yeni Auth hesabına
       * bağlandıysa eski bağlantıyı geri al.
       */

      if (
        reusedOrphanProfile &&
        reusedProfileId &&
        oldAuthUserId
      ) {
        try {
          await adminClient()
            .from("profiles")
            .update({
              auth_user_id:
                oldAuthUserId
            })
            .eq(
              "id",
              reusedProfileId
            );
        } catch (restoreError) {
          console.error(
            "FINAL PROFILE RESTORE ERROR:",
            restoreError
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

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(
      req.body?.username ??
      req.body?.email ??
      ""
    ).trim();

    const password = String(
      req.body?.password ??
      ""
    );

    console.log("=================================");
    console.log("MINEGRAM LOGIN");
    console.log("IDENTIFIER:", identifier);
    console.log("PASSWORD:", password ? "VAR" : "YOK");

    if (!identifier || !password) {
      return res.status(400).json({
        ok: false,
        error: "Kullanıcı adı/e-posta ve şifre gerekli."
      });
    }

    if (!CONFIG_OK) {
      return res.status(500).json({
        ok: false,
        error: "Supabase ortam değişkenleri eksik."
      });
    }

    /*
     * Service Role ile profil/Auth bilgilerini buluyoruz.
     */
    const admin = adminClient();

    let email = "";
    let profile = null;
    let authUser = null;

    /*
     * =====================================================
     * 1 — E-POSTA İLE GİRİŞ
     * =====================================================
     */
    if (identifier.includes("@")) {
      email = identifier.toLowerCase();

      console.log("GİRİŞ TÜRÜ: E-POSTA");
      console.log("EMAIL:", email);

      const {
        data: authList,
        error: authListError
      } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      });

      if (authListError) {
        console.error(
          "AUTH USER LIST ERROR:",
          authListError
        );

        return res.status(500).json({
          ok: false,
          error: "Auth kullanıcıları alınamadı."
        });
      }

      authUser =
        (authList?.users || []).find(
          u =>
            normalizeEmail(u?.email) ===
            normalizeEmail(email)
        );

      if (!authUser) {
        return res.status(401).json({
          ok: false,
          error: "Kullanıcı adı veya şifre yanlış."
        });
      }

      console.log(
        "AUTH USER BULUNDU:",
        authUser.id
      );

      /*
       * Önce auth_user_id
       */
      const byAuth =
        await admin
          .from("profiles")
          .select("*")
          .eq(
            "auth_user_id",
            authUser.id
          )
          .maybeSingle();

      if (byAuth.error) {
        console.error(
          "PROFILE AUTH QUERY ERROR:",
          byAuth.error
        );
      }

      profile =
        byAuth.data || null;

      /*
       * Eski yapı için id
       */
      if (!profile) {
        const byId =
          await admin
            .from("profiles")
            .select("*")
            .eq(
              "id",
              authUser.id
            )
            .maybeSingle();

        if (byId.error) {
          console.error(
            "PROFILE ID QUERY ERROR:",
            byId.error
          );
        }

        profile =
          byId.data || null;
      }

    } else {

      /*
       * =====================================================
       * 2 — KULLANICI ADI İLE GİRİŞ
       * =====================================================
       */

      const username =
        normalizeUsername(identifier);

      console.log(
        "GİRİŞ TÜRÜ: KULLANICI ADI"
      );

      console.log(
        "USERNAME:",
        username
      );

      const {
        data: foundProfile,
        error: profileError
      } = await admin
        .from("profiles")
        .select("*")
        .eq(
          "username",
          username
        )
        .maybeSingle();

      if (profileError) {
        console.error(
          "PROFILE SEARCH ERROR:",
          profileError
        );

        return res.status(500).json({
          ok: false,
          error: "Profil aranırken hata oluştu."
        });
      }

      profile =
        foundProfile || null;

      if (!profile) {
        console.log(
          "PROFILE BULUNAMADI"
        );

        return res.status(401).json({
          ok: false,
          error: "Kullanıcı adı veya şifre yanlış."
        });
      }

      console.log(
        "PROFILE BULUNDU:"
      );

      console.log(
        "PROFILE ID:",
        profile.id
      );

      console.log(
        "USERNAME:",
        profile.username
      );

      console.log(
        "AUTH USER ID:",
        profile.auth_user_id
      );

      /*
       * Auth ID kesin olarak alınır.
       */
      const authUserId =
        profile.auth_user_id ||
        profile.id;

      if (!authUserId) {
        console.error(
          "AUTH USER ID YOK"
        );

        return res.status(500).json({
          ok: false,
          error: "Hesabın Auth bağlantısı bulunamadı."
        });
      }

      const {
        data: authResult,
        error: authGetError
      } =
        await admin.auth.admin.getUserById(
          authUserId
        );

      if (authGetError) {
        console.error(
          "AUTH USER GET ERROR:",
          authGetError
        );

        return res.status(500).json({
          ok: false,
          error: "Auth hesabı alınamadı."
        });
      }

      authUser =
        authResult?.user || null;

      if (!authUser) {
        console.error(
          "AUTH USER BULUNAMADI:",
          authUserId
        );

        return res.status(401).json({
          ok: false,
          error: "Kullanıcı adı veya şifre yanlış."
        });
      }

      email =
        authUser.email || "";

      console.log(
        "AUTH EMAIL:",
        email
      );
    }

    /*
     * =====================================================
     * 3 — AUTH E-POSTA KONTROLÜ
     * =====================================================
     */

    if (!email) {
      return res.status(401).json({
        ok: false,
        error: "Kullanıcı hesabında e-posta bulunamadı."
      });
    }

    console.log(
      "SUPABASE SIGN IN EMAIL:",
      email
    );

    /*
     * =====================================================
     * 4 — ASIL ŞİFRE DOĞRULAMA
     * =====================================================
     *
     * Burada Service Role kullanılmaz.
     * Normal Supabase Auth login yapılır.
     */

    const anon = client();

    const {
      data: signInData,
      error: signInError
    } =
      await anon.auth.signInWithPassword({
        email,
        password
      });

    if (signInError) {

      console.error(
        "SUPABASE LOGIN ERROR"
      );

      console.error(
        "MESSAGE:",
        signInError.message
      );

      console.error(
        "STATUS:",
        signInError.status
      );

      console.error(
        "CODE:",
        signInError.code
      );

      return res.status(401).json({
        ok: false,
        error: "Kullanıcı adı veya şifre yanlış."
      });
    }

    const loggedUser =
      signInData?.user;

    const session =
      signInData?.session;

    if (!loggedUser || !session) {
      console.error(
        "SUPABASE LOGIN SESSION YOK"
      );

      return res.status(401).json({
        ok: false,
        error: "Giriş oturumu oluşturulamadı."
      });
    }

    /*
     * =====================================================
     * 5 — PROFİL YOKSA AUTH ID ÜZERİNDEN TEKRAR BUL
     * =====================================================
     */

    if (!profile) {

      const {
        data: profileByAuth,
        error: profileByAuthError
      } = await admin
        .from("profiles")
        .select("*")
        .eq(
          "auth_user_id",
          loggedUser.id
        )
        .maybeSingle();

      if (
        profileByAuthError
      ) {
        console.error(
          "PROFILE BY AUTH ERROR:",
          profileByAuthError
        );
      }

      profile =
        profileByAuth || null;
    }

    if (!profile) {

      const {
        data: profileById,
        error: profileByIdError
      } = await admin
        .from("profiles")
        .select("*")
        .eq(
          "id",
          loggedUser.id
        )
        .maybeSingle();

      if (profileByIdError) {
        console.error(
          "PROFILE BY ID ERROR:",
          profileByIdError
        );
      }

      profile =
        profileById || null;
    }

    /*
     * Profil yoksa Auth girişi yine başarılıdır,
     * fakat uygulamanın çalışması için güvenli
     * temel profil oluşturulmaz; hata döndürülür.
     */

    if (!profile) {
      console.error(
        "LOGIN BAŞARILI FAKAT PROFİL YOK:",
        loggedUser.id
      );

      return res.status(500).json({
        ok: false,
        error: "Giriş başarılı fakat profil bulunamadı."
      });
    }

    /*
     * =====================================================
     * 6 — BAŞARILI GİRİŞ
     * =====================================================
     */

    console.log(
      "SUPABASE LOGIN SUCCESS"
    );

    console.log(
      "USER ID:",
      loggedUser.id
    );

    console.log(
      "USERNAME:",
      profile.username
    );

    return res.json({
      ok: true,

      message: "Giriş başarılı.",

      token:
        session.access_token,

      access_token:
        session.access_token,

      refresh_token:
        session.refresh_token,

      user: safeUser(profile),

      profile: safeProfile(profile)
    });

  } catch (error) {

    console.error(
      "MINEGRAM LOGIN FATAL:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Giriş sırasında sunucu hatası oluştu."
    });
  }
});

      email = identifier.toLowerCase();

      console.log("GİRİŞ TÜRÜ: E-POSTA");
      console.log("EMAIL:", email);

      /*
       * E-posta ile girişte Auth kullanıcısını bul.
       */
      try {

        for (let page = 1; page <= 20; page++) {

          const result =
            await admin.auth.admin.listUsers({
              page,
              perPage: 1000
            });

          if (result?.error) {
            console.error(
              "AUTH USER LIST ERROR:",
              result.error
            );

            break;
          }

          const users =
            result?.data?.users || [];

          const foundUser =
            users.find(
              u =>
                normalizeEmail(u?.email) ===
                normalizeEmail(email)
            );

          if (foundUser) {

            console.log(
              "AUTH E-POSTA BULUNDU:",
              foundUser.id
            );

            /*
             * Profil önce auth_user_id ile aranır.
             */
            const byAuth =
              await admin
                .from("profiles")
                .select("*")
                .eq(
                  "auth_user_id",
                  foundUser.id
                )
                .maybeSingle();

            if (byAuth.data) {
              profile = byAuth.data;
            }

            /*
             * Eski yapı için id ile de kontrol.
             */
            if (!profile) {

              const byId =
                await admin
                  .from("profiles")
                  .select("*")
                  .eq(
                    "id",
                    foundUser.id
                  )
                  .maybeSingle();

              if (byId.data) {
                profile = byId.data;
              }
            }

            break;
          }

          if (users.length < 1000) {
            break;
          }
        }

      } catch (e) {

        console.error(
          "AUTH EMAIL SEARCH ERROR:",
          e
        );
      }

    } else {

// ======================================================
// MINEGRAM - MINEGRAM111 ŞİFRE SIFIRLAMA
// ======================================================

app.post("/api/admin/reset-minegram111-password", async (req, res) => {
  try {

    const secret = String(
      req.headers["x-reset-secret"] || ""
    ).trim();

    const expectedSecret = env(
      "MINEGRAM_RESET_SECRET"
    );

    if (!expectedSecret) {
      return res.status(500).json({
        ok: false,
        error: "MINEGRAM_RESET_SECRET Render'da tanımlı değil."
      });
    }

    if (secret !== expectedSecret) {
      return res.status(403).json({
        ok: false,
        error: "Yetkisiz işlem."
      });
    }

    const newPassword = String(
      req.body?.newPassword || ""
    );

    if (!newPassword) {
      return res.status(400).json({
        ok: false,
        error: "Yeni şifre gerekli."
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Yeni şifre en az 6 karakter olmalı."
      });
    }

    // MINEGRAM111 GERÇEK SUPABASE AUTH ID
    const authUserId =
      "de0ae602-6778-4e9c-a848-6a97d23b3f72";

    const admin = adminClient();

    // AUTH KULLANICISINI KONTROL ET
    const {
      data: authData,
      error: getUserError
    } = await admin.auth.admin.getUserById(
      authUserId
    );

    if (getUserError) {
      console.error(
        "AUTH USER BULMA HATASI:",
        getUserError
      );

      return res.status(404).json({
        ok: false,
        error: getUserError.message
      });
    }

    if (!authData?.user) {
      return res.status(404).json({
        ok: false,
        error: "Supabase Auth hesabı bulunamadı."
      });
    }

    console.log(
      "MINEGRAM111 AUTH HESABI BULUNDU:",
      authData.user.id
    );

    console.log(
      "AUTH EMAIL:",
      authData.user.email
    );

    // SADECE ŞİFREYİ DEĞİŞTİR
    const {
      data: updatedUser,
      error: updateError
    } = await admin.auth.admin.updateUserById(
      authUserId,
      {
        password: newPassword
      }
    );

    if (updateError) {
      console.error(
        "ŞİFRE DEĞİŞTİRME HATASI:",
        updateError
      );

      return res.status(400).json({
        ok: false,
        error: updateError.message
      });
    }

    console.log(
      "================================="
    );

    console.log(
      "MINEGRAM111 ŞİFRE DEĞİŞTİRİLDİ"
    );

    console.log(
      "AUTH ID:",
      updatedUser?.user?.id
    );

    console.log(
      "================================="
    );

    return res.json({
      ok: true,
      message:
        "minegram111 şifresi başarıyla değiştirildi.",
      username: "minegram111",
      auth_user_id: authUserId
    });

  } catch (error) {

    console.error(
      "MINEGRAM111 RESET FATAL:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Şifre sıfırlanamadı."
    });
  }
});
      
      /* ===================================================
         2 — KULLANICI ADI İLE GİRİŞ
      =================================================== */

      const username =
        normalizeUsername(identifier);

      console.log(
        "GİRİŞ TÜRÜ: KULLANICI ADI"
      );

      console.log(
        "USERNAME:",
        username
      );

      const {
        data: usernameProfile,
        error: profileError
      } =
        await admin
          .from("profiles")
          .select("*")
          .eq(
            "username",
            username
          )
          .maybeSingle();

      if (profileError) {

        console.error(
          "PROFILE SEARCH ERROR:",
          profileError
        );

        return res.status(500).json({
          ok: false,
          error:
            "Kullanıcı aranırken hata oluştu."
        });
      }

      if (!usernameProfile) {

        console.log(
          "PROFILE BULUNAMADI:",
          username
        );

        return res.status(401).json({
          ok: false,
          error:
            "Kullanıcı adı veya şifre yanlış."
        });
      }

      profile =
        usernameProfile;

      console.log(
        "PROFILE BULUNDU:"
      );

      console.log(
        "PROFILE ID:",
        profile.id
      );

      console.log(
        "USERNAME:",
        profile.username
      );

      console.log(
        "AUTH USER ID:",
        profile.auth_user_id
      );

      if (!profile.auth_user_id) {

        console.error(
          "PROFILE AUTH USER ID YOK"
        );

        return res.status(401).json({
          ok: false,
          error:
            "Bu hesabın Auth bağlantısı bulunamadı."
        });
      }

      /*
       * Auth kullanıcısını bul.
       */
      const {
        data: authData,
        error: authError
      } =
        await admin.auth.admin.getUserById(
          profile.auth_user_id
        );

      if (authError) {

        console.error(
          "AUTH USER ERROR:",
          authError
        );

        return res.status(401).json({
          ok: false,
          error:
            "Kullanıcı adı veya şifre yanlış."
        });
      }

      const authUser =
        authData?.user;

      if (!authUser) {

        console.error(
          "AUTH USER YOK"
        );

        return res.status(401).json({
          ok: false,
          error:
            "Kullanıcı adı veya şifre yanlış."
        });
      }

      if (!authUser.email) {

        console.error(
          "AUTH EMAIL YOK"
        );

        return res.status(401).json({
          ok: false,
          error:
            "Bu hesabın e-posta adresi bulunamadı."
        });
      }

      email =
        authUser.email.toLowerCase();

      console.log(
        "AUTH EMAIL:",
        email
      );
    }

    /* =====================================================
       3 — EMAIL KONTROL
    ===================================================== */

    if (!email) {

      return res.status(401).json({
        ok: false,
        error:
          "Bu hesap için e-posta adresi bulunamadı."
      });
    }

    console.log(
      "SUPABASE SIGN IN EMAIL:",
      email
    );

    /* =====================================================
       4 — SUPABASE AUTH PASSWORD LOGIN
    ===================================================== */

    const anon =
      client();

    const {
      data: sessionData,
      error: loginError
    } =
      await anon.auth.signInWithPassword({
        email,
        password
      });

    /* =====================================================
       5 — SUPABASE HATASI
    ===================================================== */

    if (loginError) {

      console.error(
        "================================="
      );

      console.error(
        "SUPABASE LOGIN ERROR"
      );

      console.error(
        "MESSAGE:",
        loginError.message
      );

      console.error(
        "STATUS:",
        loginError.status
      );

      console.error(
        "CODE:",
        loginError.code
      );

      console.error(
        "NAME:",
        loginError.name
      );

      console.error(
        "================================="
      );

      let message =
        "Kullanıcı adı veya şifre yanlış.";

      if (
        /email not confirmed/i.test(
          loginError.message || ""
        )
      ) {

        message =
          "E-posta adresiniz doğrulanmamış.";
      }

      if (
        /invalid login credentials/i.test(
          loginError.message || ""
        )
      ) {

        message =
          "Kullanıcı adı veya şifre yanlış.";
      }

      if (
        /too many requests/i.test(
          loginError.message || ""
        )
      ) {

        message =
          "Çok fazla giriş denemesi yapıldı. Lütfen biraz bekleyin.";
      }

      return res.status(401).json({
        ok: false,
        error: message
      });
    }

    /* =====================================================
       6 — SESSION KONTROL
    ===================================================== */

    if (!sessionData?.session) {

      console.error(
        "SESSION OLUŞMADI"
      );

      return res.status(401).json({
        ok: false,
        error:
          "Giriş başarılı ancak oturum oluşturulamadı."
      });
    }

    if (!sessionData?.user) {

      console.error(
        "AUTH USER SESSION YOK"
      );

      return res.status(401).json({
        ok: false,
        error:
          "Giriş başarılı ancak kullanıcı bilgisi alınamadı."
      });
    }

    const authId =
      sessionData.user.id;

    console.log(
      "AUTH LOGIN BAŞARILI"
    );

    console.log(
      "AUTH ID:",
      authId
    );

    /* =====================================================
       7 — PROFİLİ TEKRAR BUL
    ===================================================== */

    if (!profile) {

      const {
        data: profileByAuth,
        error: profileAuthError
      } =
        await admin
          .from("profiles")
          .select("*")
          .eq(
            "auth_user_id",
            authId
          )
          .maybeSingle();

      if (profileAuthError) {

        console.error(
          "PROFILE AUTH SEARCH ERROR:",
          profileAuthError
        );
      }

      if (profileByAuth) {
        profile =
          profileByAuth;
      }
    }

    if (!profile) {

      const {
        data: profileById,
        error: profileIdError
      } =
        await admin
          .from("profiles")
          .select("*")
          .eq(
            "id",
            authId
          )
          .maybeSingle();

      if (profileIdError) {

        console.error(
          "PROFILE ID SEARCH ERROR:",
          profileIdError
        );
      }

      if (profileById) {
        profile =
          profileById;
      }
    }

    /* =====================================================
       8 — PROFILE YOKSA OLUŞTUR
    ===================================================== */

    if (!profile) {

      console.log(
        "PROFILE YOK — OLUŞTURULUYOR"
      );

      const metadata =
        sessionData.user.user_metadata || {};

      const username =
        normalizeUsername(
          metadata.username ||
          metadata.user_name ||
          email.split("@")[0]
        );

      const displayName =
        String(
          metadata.display_name ||
          metadata.full_name ||
          username
        )
          .trim()
          .slice(0, 80);

      const insertPayload = {
        id: authId,
        auth_user_id: authId,
        username,
        display_name: displayName,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      };

      const {
        data: createdProfile,
        error: createProfileError
      } =
        await admin
          .from("profiles")
          .insert(
            insertPayload
          )
          .select("*")
          .single();

      if (createProfileError) {

        console.error(
          "PROFILE CREATE ERROR:",
          createProfileError
        );

        /*
         * Aynı anda oluşturulmuş olabilir.
         */
        const {
          data: retryProfile
        } =
          await admin
            .from("profiles")
            .select("*")
            .eq(
              "auth_user_id",
              authId
            )
            .maybeSingle();

        if (retryProfile) {

          profile =
            retryProfile;

        } else {

          return res.status(500).json({
            ok: false,
            error:
              "Auth hesabı bulundu fakat Minegram profili oluşturulamadı."
          });
        }

      } else {

        profile =
          createdProfile;
      }
    }

    /* =====================================================
       9 — SON KONTROL
    ===================================================== */

    if (!profile) {

      return res.status(404).json({
        ok: false,
        error:
          "Bu hesap için Minegram profili bulunamadı."
      });
    }

    const safe =
      safeProfile(profile);

    /* =====================================================
       10 — BAŞARILI LOGIN
    ===================================================== */

    console.log(
      "================================="
    );

    console.log(
      "MINEGRAM LOGIN BAŞARILI"
    );

    console.log(
      "USERNAME:",
      safe.username
    );

    console.log(
      "PROFILE ID:",
      safe.id
    );

    console.log(
      "AUTH ID:",
      authId
    );

    console.log(
      "================================="
    );

    return res.json({
      ok: true,

      token:
        sessionData.session.access_token,

      supabaseAccessToken:
        sessionData.session.access_token,

      profile:
        safe,

      profiles: [
        safe
      ],

      user:
        safe,

      multipleProfiles:
        false
    });

  } catch (error) {

    console.error(
      "================================="
    );

    console.error(
      "MINEGRAM LOGIN FATAL ERROR"
    );

    console.error(
      error
    );

    console.error(
      "================================="
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Giriş sırasında sunucu hatası oluştu."
    });
  }
});


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

async function sendResendEmail(to, subject, html, text = "") {
  const apiKey = String(
    process.env.RESEND_API_KEY ||
    process.env.RESEND_KEY ||
    ""
  ).trim().replace(/^(\"|\')|\"|\'$/g, "");

  const fromEmail = String(
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_FROM ||
    ""
  ).trim().replace(/^(\"|\')|(\"|\')$/g, "");

  const recipient = String(to || "").trim().toLowerCase();

  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY eksik. Render > Environment Variables içine RESEND_API_KEY ekle."
    );
  }

  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error("Geçersiz e-posta alıcısı: " + recipient);
  }

  if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
    throw new Error(
      "RESEND_FROM_EMAIL eksik veya geçersiz. Doğrulanmış alan adından bir adres kullan. Örn: dogrulama@minegram.com"
    );
  }

  const fromName = String(
    process.env.RESEND_FROM_NAME ||
    "Minegram"
  ).trim();

  const from = fromName
    ? `${fromName} <${fromEmail}>`
    : fromEmail;

  const payload = {
    from,
    to: [recipient],
    subject: String(subject || "Minegram"),
    html: String(html || ""),
    text: String(text || "")
  };

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "Minegram/1.0"
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      const raw = await response.text();
      let body = {};

      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { message: raw };
      }

      if (response.ok) {
        console.log(
          `[RESEND] OK -> ${recipient} (${body?.id || "id-yok"})`
        );
        return body;
      }

      const message =
        body?.message ||
        body?.error ||
        `Resend HTTP ${response.status}`;

      lastError = new Error(
        `Resend HTTP ${response.status}: ${message}`
      );

      console.error("[RESEND] API HATASI:", {
        status: response.status,
        message,
        from,
        to: recipient
      });

      if ([400, 401, 403, 422].includes(response.status)) {
        break;
      }
    } catch (e) {
      lastError =
        e?.name === "AbortError"
          ? new Error("Resend bağlantısı zaman aşımına uğradı.")
          : e;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }

  throw lastError || new Error("E-posta gönderilemedi.");
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

      res.json(
        await hydratePosts(
          req.sb,
          data || [],
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

      const result =
        await req.sb
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

      res.json(
        data || []
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

      res.json(
        await hydratePosts(
          req.sb,
          data || [],
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
