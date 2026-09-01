import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";


/* =========================================================
   PATH
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");


/* =========================================================
   EXPRESS
========================================================= */

const app = express();

const PORT =
  Number(process.env.PORT) ||
  10000;


/* =========================================================
   CORS
========================================================= */

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "apikey",
      "x-client-info"
    ]
  })
);

app.options(
  "*",
  cors()
);


/* =========================================================
   BODY
========================================================= */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);


/* =========================================================
   UPLOAD
========================================================= */

const upload =
  multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize:
        50 * 1024 * 1024
    }
  });


/* =========================================================
   STATIC
========================================================= */

if (
  fs.existsSync(publicDir)
) {
  app.use(
    express.static(
      publicDir
    )
  );
}


/* =========================================================
   ENV
========================================================= */

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL ||
    ""
  ).trim();

const SUPABASE_KEY =
  String(
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    ""
  ).trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

const BUCKET =
  String(
    process.env.SUPABASE_STORAGE_BUCKET ||
    process.env.BUCKET ||
    "minegram"
  ).trim();

const CONFIG_OK =
  Boolean(
    SUPABASE_URL &&
    SUPABASE_KEY
  );


/* =========================================================
   SUPABASE CLIENT
========================================================= */

function client() {
  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY
  ) {
    throw new Error(
      "Supabase yapılandırması eksik."
    );
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}


function adminClient() {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY eksik."
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


/* =========================================================
   HELPERS
========================================================= */

function normalizeEmail(value) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}


function normalizeUsername(value) {
  return String(
    value || ""
  )
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}


function normalizeRecoveryPhone(value) {
  let phone =
    String(
      value || ""
    ).trim();

  if (!phone) {
    return "";
  }

  phone =
    phone.replace(
      /[\s().-]/g,
      ""
    );

  if (
    phone.startsWith("00")
  ) {
    phone =
      "+" +
      phone.slice(2);
  }

  if (
    phone.startsWith("+")
  ) {
    return "+" +
      phone
        .slice(1)
        .replace(/\D/g, "");
  }

  phone =
    phone.replace(
      /\D/g,
      ""
    );

  if (
    phone.startsWith("0") &&
    phone.length === 11
  ) {
    return (
      "+90" +
      phone.slice(1)
    );
  }

  if (
    phone.startsWith("90") &&
    phone.length === 12
  ) {
    return "+" + phone;
  }

  return phone;
}


function maskEmail(email) {
  const value =
    normalizeEmail(email);

  if (
    !value.includes("@")
  ) {
    return value;
  }

  const [
    name,
    domain
  ] =
    value.split("@");

  if (
    name.length <= 2
  ) {
    return (
      name[0] +
      "*".repeat(
        Math.max(
          1,
          name.length - 1
        )
      ) +
      "@" +
      domain
    );
  }

  return (
    name[0] +
    "*".repeat(
      Math.max(
        2,
        name.length - 2
      )
    ) +
    name[name.length - 1] +
    "@" +
    domain
  );
}


function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id:
      user.id ||
      user.auth_user_id ||
      null,

    auth_user_id:
      user.auth_user_id ||
      null,

    username:
      user.username ||
      "",

    email:
      user.email ||
      "",

    displayName:
      user.display_name ||
      user.displayName ||
      "",

    display_name:
      user.display_name ||
      user.displayName ||
      "",

    bio:
      user.bio ||
      "",

    avatar:
      user.avatar_url ||
      user.avatar ||
      null,

    avatar_url:
      user.avatar_url ||
      user.avatar ||
      null,

    verified:
      Boolean(
        user.verified
      ),

    settings:
      user.settings ||
      {}
  };
}


function publicOrigin(req) {
  const envOrigin =
    String(
      process.env.PUBLIC_ORIGIN ||
      process.env.APP_URL ||
      ""
    ).trim();

  if (envOrigin) {
    return envOrigin.replace(
      /\/+$/,
      ""
    );
  }

  const forwarded =
    req.headers[
      "x-forwarded-proto"
    ];

  const protocol =
    forwarded ||
    req.protocol ||
    "http";

  const host =
    req.get("host");

  return `${protocol}://${host}`;
}


/* =========================================================
   FIND PROFILE
========================================================= */

async function findProfile(
  sb,
  identifier
) {
  const value =
    String(
      identifier || ""
    ).trim();

  if (!value) {
    return null;
  }

  const username =
    normalizeUsername(value);

  const email =
    normalizeEmail(value);

  try {
    let result =
      await sb
        .from("profiles")
        .select("*")
        .eq(
          "username",
          username
        )
        .maybeSingle();

    if (
      !result.error &&
      result.data
    ) {
      return result.data;
    }
  } catch {}

  try {
    let result =
      await sb
        .from("profiles")
        .select("*")
        .eq(
          "email",
          email
        )
        .maybeSingle();

    if (
      !result.error &&
      result.data
    ) {
      return result.data;
    }
  } catch {}

  try {
    let result =
      await sb
        .from("profiles")
        .select("*")
        .ilike(
          "username",
          username
        )
        .limit(1);

    if (
      !result.error &&
      result.data?.length
    ) {
      return result.data[0];
    }
  } catch {}

  return null;
}


/* =========================================================
   FIND AUTH USER BY PHONE
========================================================= */

async function findUserByPhone(
  phone
) {
  if (
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const wanted =
    normalizeRecoveryPhone(
      phone
    );

  if (!wanted) {
    return null;
  }

  const admin =
    adminClient();


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

      for (
        const user of users
      ) {
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

        if (!profilePhone) {
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
   RESOLVE RECOVERY EMAIL
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

  let email =
    raw;

  let profile =
    null;

  let authUser =
    null;


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

    try {
      const {
        data
      } =
        await anon
          .from("profiles")
          .select(
            "id,auth_user_id,username,email,display_name,bio,avatar_url,verified,settings"
          )
          .or(
            `id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`
          )
          .limit(1)
          .maybeSingle();

      profile =
        data ||
        null;
    } catch {}

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
          "id,auth_user_id,username,email,display_name,bio,avatar_url,verified,settings"
        )
        .eq(
          "email",
          email
        )
        .maybeSingle();

    profile =
      data ||
      null;
  }


  return {
    email,
    profile,
    authUser
  };
}


/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function auth(
  req,
  res,
  next
) {
  try {
    const header =
      req.headers.authorization ||
      "";

    if (
      !header.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        error:
          "Oturum bulunamadı."
      });
    }

    const token =
      header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Token bulunamadı."
      });
    }

    const sb =
      client();

    const {
      data,
      error
    } =
      await sb.auth.getUser(
        token
      );

    if (
      error ||
      !data?.user
    ) {
      return res.status(401).json({
        error:
          "Oturum geçersiz veya süresi dolmuş."
      });
    }

    req.sb =
      sb;

    req.user =
      data.user;

    let profile =
      null;

    try {
      const result =
        await sb
          .from("profiles")
          .select("*")
          .eq(
            "id",
            data.user.id
          )
          .maybeSingle();

      profile =
        result.data ||
        null;
    } catch {}

    if (!profile) {
      try {
        const result =
          await sb
            .from("profiles")
            .select("*")
            .eq(
              "auth_user_id",
              data.user.id
            )
            .maybeSingle();

        profile =
          result.data ||
          null;
      } catch {}
    }

    req.profile =
      profile;

    req.userProfile =
      profile;

    if (
      profile
    ) {
      req.user = {
        ...data.user,
        ...profile,
        id:
          data.user.id
      };
    }

    next();
  } catch (e) {
    console.error(
      "AUTH ERROR:",
      e
    );

    return res.status(401).json({
      error:
        "Yetkilendirme başarısız."
    });
  }
}


/* =========================================================
   NOTIFICATIONS
========================================================= */

async function addNotification({
  userId,
  fromUserId,
  type,
  postId = null,
  text
}) {
  if (
    !userId ||
    !fromUserId ||
    userId === fromUserId
  ) {
    return;
  }

  try {
    const sb =
      client();

    await sb
      .from("notifications")
      .insert({
        user_id:
          userId,

        from_user_id:
          fromUserId,

        type,

        post_id:
          postId,

        text,

        read:
          false
      });
  } catch (e) {
    console.error(
      "NOTIFICATION ERROR:",
      e?.message ||
      e
    );
  }
}


/* =========================================================
   HYDRATE POSTS
========================================================= */

async function hydratePosts(
  sb,
  posts,
  currentUserId
) {
  const list =
    Array.isArray(posts)
      ? posts
      : [];

  if (!list.length) {
    return [];
  }

  const ids =
    list.map(
      p => p.id
    );

  let likes = [];
  let comments = [];
  let saves = [];

  try {
    const result =
      await sb
        .from("post_likes")
        .select(
          "post_id,user_id"
        )
        .in(
          "post_id",
          ids
        );

    likes =
      result.data ||
      [];
  } catch {}

  try {
    const result =
      await sb
        .from("comments")
        .select(
          "id,post_id,user_id,text,created_at"
        )
        .in(
          "post_id",
          ids
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        );

    comments =
      result.data ||
      [];
  } catch {}

  try {
    const result =
      await sb
        .from("saves")
        .select(
          "post_id,user_id"
        )
        .in(
          "post_id",
          ids
        );

    saves =
      result.data ||
      [];
  } catch {}


  const userIds =
    [
      ...new Set(
        [
          ...likes.map(
            x =>
              x.user_id
          ),
          ...comments.map(
            x =>
              x.user_id
          ),
          ...list.map(
            x =>
              x.user_id
          )
        ].filter(Boolean)
      )
    ];


  let profiles =
    [];

  if (
    userIds.length
  ) {
    try {
      const result =
        await sb
          .from("profiles")
          .select(
            "id,username,display_name,avatar_url,verified"
          )
          .in(
            "id",
            userIds
          );

      profiles =
        result.data ||
        [];
    } catch {}
  }


  const profileMap =
    new Map(
      profiles.map(
        p => [
          p.id,
          p
        ]
      )
    );


  return list.map(
    post => {
      const postLikes =
        likes.filter(
          x =>
            x.post_id ===
            post.id
        );

      const postComments =
        comments.filter(
          x =>
            x.post_id ===
            post.id
        );

      const postSaves =
        saves.filter(
          x =>
            x.post_id ===
            post.id
        );

      const owner =
        profileMap.get(
          post.user_id
        );


      return {
        ...post,

        id:
          post.id,

        userId:
          post.user_id,

        username:
          owner?.username ||
          post.username ||
          "",

        displayName:
          owner?.display_name ||
          "",

        avatar:
          owner?.avatar_url ||
          null,

        verified:
          Boolean(
            owner?.verified
          ),

        caption:
          post.caption ||
          "",

        media:
          post.media_url ||
          null,

        mediaUrl:
          post.media_url ||
          null,

        mediaName:
          post.media_name ||
          null,

        mediaType:
          post.media_type ||
          null,

        createdAt:
          post.created_at,

        likes:
          postLikes.length,

        likeCount:
          postLikes.length,

        liked:
          postLikes.some(
            x =>
              x.user_id ===
              currentUserId
          ),

        saved:
          postSaves.some(
            x =>
              x.user_id ===
              currentUserId
          ),

        comments:
          postComments.map(
            c => {
              const cp =
                profileMap.get(
                  c.user_id
                );

              return {
                id:
                  c.id,

                userId:
                  c.user_id,

                username:
                  cp?.username ||
                  "",

                displayName:
                  cp?.display_name ||
                  "",

                avatar:
                  cp?.avatar_url ||
                  null,

                text:
                  c.text,

                createdAt:
                  c.created_at
              };
            }
          ),

        commentCount:
          postComments.length
      };
    }
  );
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "Minegram",
      time:
        new Date().toISOString(),
      supabase:
        CONFIG_OK,
      resend:
        Boolean(
          process.env.RESEND_API_KEY ||
          process.env.RESEND_KEY
        )
    });
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

function resendEnv(
  name,
  fallback = ""
) {
  return String(
    process.env[name] ??
    fallback
  )
    .trim()
    .replace(
      /^("|')|("|')$/g,
      ""
    );
}


async function sendResendEmail(
  to,
  subject,
  html,
  text = ""
) {
  const recipient =
    String(
      to || ""
    )
      .trim()
      .toLowerCase();

  const apiKey =
    resendEnv(
      "RESEND_API_KEY"
    ) ||
    resendEnv(
      "RESEND_KEY"
    );

  const fromEmail =
    resendEnv(
      "RESEND_FROM_EMAIL"
    ) ||
    resendEnv(
      "RESEND_FROM"
    ) ||
    "onboarding@resend.dev";

  const fromName =
    resendEnv(
      "RESEND_FROM_NAME",
      "Minegram"
    );


  if (!recipient) {
    throw new Error(
      "E-posta alıcısı boş."
    );
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      recipient
    )
  ) {
    throw new Error(
      "Geçersiz e-posta alıcısı."
    );
  }

  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY eksik. .env içine Resend API anahtarını ekle ve sunucuyu yeniden başlat."
    );
  }

  if (
    !fromEmail.includes("@")
  ) {
    throw new Error(
      "RESEND_FROM_EMAIL geçersiz."
    );
  }


  const payload = {
    from:
      `${fromName} <${fromEmail}>`,

    to: [
      recipient
    ],

    subject:
      String(
        subject ||
        "Minegram"
      ),

    html:
      String(
        html ||
        ""
      ),

    text:
      String(
        text ||
        ""
      )
  };


  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        15000
      );


    try {
      const response =
        await fetch(
          "https://api.resend.com/emails",
          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json",

              Accept:
                "application/json",

              "User-Agent":
                "Minegram/1.0"
            },

            body:
              JSON.stringify(
                payload
              ),

            signal:
              controller.signal
          }
        );


      const raw =
        await response.text();

      let body =
        {};

      try {
        body =
          raw
            ? JSON.parse(raw)
            : {};
      } catch {
        body = {
          message:
            raw
        };
      }


      if (
        response.ok
      ) {
        console.log(
          `[RESEND] OK -> ${recipient} (${body.id || "id-yok"})`
        );

        return body;
      }


      const message =
        body?.message ||
        body?.error ||
        `Resend HTTP ${response.status}`;


      lastError =
        new Error(
          `Resend HTTP ${response.status}: ${message}`
        );


      if (
        [
          400,
          401,
          403,
          422
        ].includes(
          response.status
        )
      ) {
        break;
      }

    } catch (e) {
      lastError =
        e?.name ===
        "AbortError"
          ? new Error(
              "Resend bağlantısı zaman aşımına uğradı."
            )
          : e;
    } finally {
      clearTimeout(
        timer
      );
    }


    if (
      attempt < 2
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            700
          )
      );
    }
  }


  console.error(
    "[RESEND] GÖNDERME HATASI:",
    lastError?.message ||
    lastError
  );

  throw (
    lastError ||
    new Error(
      "E-posta gönderilemedi."
    )
  );
}


/* =========================================================
   OTP STORES
========================================================= */

const recoveryCodes =
  new Map();

const registrationCodes =
  new Map();

const emailOtpStore =
  new Map();

const emailOtpRate =
  new Map();

const passwordResetTokens =
  new Map();


/* =========================================================
   CLEANUP
========================================================= */

function cleanupRecoveryCodes() {
  const now =
    Date.now();

  for (
    const [
      key,
      entry
    ] of recoveryCodes.entries()
  ) {
    if (
      !entry ||
      entry.expires < now
    ) {
      recoveryCodes.delete(
        key
      );
    }
  }
}


function cleanupRegistrationCodes() {
  const now =
    Date.now();

  for (
    const [
      key,
      entry
    ] of registrationCodes.entries()
  ) {
    if (
      !entry ||
      entry.expires < now
    ) {
      registrationCodes.delete(
        key
      );
    }
  }
}


function cleanupPasswordResetTokens() {
  const now =
    Date.now();

  for (
    const [
      token,
      entry
    ] of passwordResetTokens.entries()
  ) {
    if (
      !entry ||
      entry.expires < now
    ) {
      passwordResetTokens.delete(
        token
      );
    }
  }
}


function cleanupEmailOtp() {
  const now =
    Date.now();

  for (
    const [
      key,
      entry
    ] of emailOtpStore.entries()
  ) {
    if (
      !entry ||
      entry.expires < now
    ) {
      emailOtpStore.delete(
        key
      );
    }
  }
}


setInterval(
  cleanupRecoveryCodes,
  60 * 1000
).unref();

setInterval(
  cleanupRegistrationCodes,
  60 * 1000
).unref();

setInterval(
  cleanupPasswordResetTokens,
  60 * 1000
).unref();

setInterval(
  cleanupEmailOtp,
  60 * 1000
).unref();


/* =========================================================
   OTP HELPERS
========================================================= */

function createEmailOtp() {
  return crypto
    .randomInt(
      100000,
      1000000
    )
    .toString();
}


function normalizeOtpCode(
  value
) {
  return String(
    value ?? ""
  )
    .replace(
      /\D/g,
      ""
    )
    .slice(0, 6);
}


function isValidOtpCode(
  value
) {
  return /^\d{6}$/.test(
    normalizeOtpCode(
      value
    )
  );
}


function otpKey(email) {
  return normalizeEmail(
    email
  );
}


/* =========================================================
   REGISTER SEND CODE
========================================================= */

app.post(
  "/api/register/send-code",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const username =
        normalizeUsername(
          req.body?.username
        );

      if (!email) {
        return res.status(400).json({
          ok: false,
          error:
            "E-posta gerekli."
        });
      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Geçerli bir e-posta adresi gir."
        });
      }


      const last =
        registrationCodes.get(
          email
        );

      if (
        last?.sentAt &&
        Date.now() -
          last.sentAt <
          60 * 1000
      ) {
        const remaining =
          Math.ceil(
            (
              60 * 1000 -
              (
                Date.now() -
                last.sentAt
              )
            ) / 1000
          );

        return res.status(429).json({
          ok: false,
          error:
            `${remaining} saniye sonra tekrar deneyin.`
        });
      }


      const code =
        createEmailOtp();


      const html = `
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Minegram doğrulama</title>
</head>

<body style="margin:0;padding:0;background:#000;font-family:Arial,Helvetica,sans-serif">

<div style="max-width:520px;margin:40px auto;padding:35px 25px;background:#111;border-radius:14px;text-align:center;color:#fff">

<h1 style="margin:0 0 20px;font-size:28px">
Minegram
</h1>

<p style="font-size:16px;color:#ddd">
Hesabını doğrulamak için aşağıdaki 6 haneli kodu kullan:
</p>

<div style="margin:30px 0;padding:20px;background:#222;border-radius:12px;font-size:38px;font-weight:bold;letter-spacing:10px;color:#fff">
${code}
</div>

<p style="color:#999;font-size:13px">
Bu kod 10 dakika geçerlidir.
</p>

<p style="color:#999;font-size:13px">
Bu kodu kimseyle paylaşma.
</p>

</div>

</body>
</html>`;


      const text =
        `Minegram e-posta doğrulama kodun

Kodun: ${code}

Bu kod 10 dakika geçerlidir.
Bu kodu kimseyle paylaşma.`;


      await sendResendEmail(
        email,
        "Minegram doğrulama kodun",
        html,
        text
      );


      registrationCodes.set(
        email,
        {
          code,
          email,
          username,
          sentAt:
            Date.now(),
          expires:
            Date.now() +
            10 * 60 * 1000,
          attempts: 0
        }
      );


      return res.json({
        ok: true,
        message:
          "Doğrulama kodu gönderildi.",
        email
      });

    } catch (e) {
      console.error(
        "REGISTER SEND CODE ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Kod gönderilemedi."
      });
    }
  }
);


/* =========================================================
   REGISTER VERIFY CODE
========================================================= */

app.post(
  "/api/register/verify-code",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const code =
        normalizeOtpCode(
          req.body?.code
        );

      if (
        !email ||
        !isValidOtpCode(code)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Geçerli 6 haneli kod gerekli."
        });
      }


      const entry =
        registrationCodes.get(
          email
        );


      if (
        !entry ||
        entry.expires <
          Date.now()
      ) {
        registrationCodes.delete(
          email
        );

        return res.status(400).json({
          ok: false,
          error:
            "Kod yanlış veya süresi dolmuş."
        });
      }


      if (
        (entry.attempts || 0) >=
        5
      ) {
        registrationCodes.delete(
          email
        );

        return res.status(429).json({
          ok: false,
          error:
            "Çok fazla yanlış kod girildi."
        });
      }


      if (
        entry.code !==
        code
      ) {
        entry.attempts =
          (entry.attempts || 0) +
          1;

        return res.status(400).json({
          ok: false,
          error:
            "Kod yanlış."
        });
      }


      registrationCodes.delete(
        email
      );


      return res.json({
        ok: true,
        verified: true,
        email,
        username:
          entry.username ||
          ""
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
          "Kod doğrulanamadı."
      });
    }
  }
);


/* =========================================================
   EMAIL OTP
========================================================= */

app.post(
  "/api/send-email-otp",
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email ||
          ""
        )
          .trim()
          .toLowerCase();

      const username =
        String(
          req.body?.username ||
          ""
        )
          .trim()
          .replace(/^@/, "")
          .toLowerCase();


      if (!email) {
        return res.status(400).json({
          ok: false,
          code:
            "EMAIL_REQUIRED",
          error:
            "E-posta adresi gerekli."
        });
      }


      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res.status(400).json({
          ok: false,
          code:
            "INVALID_EMAIL",
          error:
            "Geçerli bir e-posta adresi gir."
        });
      }


      const lastSent =
        emailOtpRate.get(
          email
        ) ||
        0;


      if (
        Date.now() -
          lastSent <
          60 * 1000
      ) {
        const remaining =
          Math.ceil(
            (
              60 * 1000 -
              (
                Date.now() -
                lastSent
              )
            ) / 1000
          );

        return res.status(429).json({
          ok: false,
          code:
            "RATE_LIMIT",
          error:
            `${remaining} saniye sonra tekrar deneyin.`
        });
      }


      const suppliedCode =
        normalizeOtpCode(
          req.body?.code
        );


      const code =
        isValidOtpCode(
          suppliedCode
        )
          ? suppliedCode
          : createEmailOtp();


      const html = `
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Minegram doğrulama kodu</title>
</head>

<body style="margin:0;padding:0;background:#000;font-family:Arial,Helvetica,sans-serif">

<div style="max-width:520px;margin:40px auto;padding:35px 25px;background:#111;border-radius:14px;text-align:center;color:#fff">

<h1 style="margin:0 0 20px;font-size:28px">
Minegram
</h1>

<p style="font-size:16px;color:#ddd">
Hesabını doğrulamak için aşağıdaki 6 haneli kodu kullan:
</p>

<div style="margin:30px 0;padding:20px;background:#222;border-radius:12px;font-size:38px;font-weight:bold;letter-spacing:10px;color:#fff">
${code}
</div>

<p style="color:#999;font-size:13px">
Bu kod 10 dakika geçerlidir.
</p>

<p style="color:#999;font-size:13px">
Bu kodu kimseyle paylaşma.
</p>

</div>

</body>
</html>`;


      const text =
        `Minegram e-posta doğrulama kodun

Kodun: ${code}

Bu kod 10 dakika geçerlidir.
Bu kodu kimseyle paylaşma.`;


      await sendResendEmail(
        email,
        "Minegram doğrulama kodun",
        html,
        text
      );


      emailOtpStore.set(
        otpKey(email),
        {
          code,
          username,
          email,
          sentAt:
            Date.now(),
          expires:
            Date.now() +
            10 * 60 * 1000,
          attempts: 0
        }
      );


      emailOtpRate.set(
        otpKey(email),
        Date.now()
      );


      return res.json({
        ok: true,
        message:
          "Doğrulama kodu gönderildi.",
        email
      });

    } catch (e) {
      console.error(
        "[OTP] RESEND HATASI:",
        e
      );

      return res.status(500).json({
        ok: false,
        code:
          "EMAIL_SEND_FAILED",
        error:
          e?.message ||
          "Sunucu e-posta gönderirken hata verdi."
      });
    }
  }
);


/* =========================================================
   VERIFY EMAIL OTP
========================================================= */

app.post(
  "/api/verify-email-otp",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const code =
        normalizeOtpCode(
          req.body?.code
        );


      if (!email) {
        return res.status(400).json({
          ok: false,
          code:
            "EMAIL_REQUIRED",
          error:
            "E-posta gerekli."
        });
      }


      if (
        !isValidOtpCode(code)
      ) {
        return res.status(400).json({
          ok: false,
          code:
            "INVALID_CODE",
          error:
            "6 haneli doğrulama kodunu gir."
        });
      }


      const key =
        otpKey(email);

      const entry =
        emailOtpStore.get(
          key
        );


      if (
        !entry ||
        entry.expires <
          Date.now()
      ) {
        emailOtpStore.delete(
          key
        );

        return res.status(400).json({
          ok: false,
          code:
            "CODE_EXPIRED",
          error:
            "Kod yanlış veya süresi dolmuş. Yeni kod iste."
        });
      }


      if (
        (entry.attempts || 0) >=
        5
      ) {
        emailOtpStore.delete(
          key
        );

        return res.status(429).json({
          ok: false,
          code:
            "TOO_MANY_ATTEMPTS",
          error:
            "Çok fazla yanlış kod girildi. Yeni kod iste."
        });
      }


      if (
        entry.code !==
        code
      ) {
        entry.attempts += 1;

        return res.status(400).json({
          ok: false,
          code:
            "INVALID_CODE",
          error:
            "Kod yanlış. Lütfen tekrar kontrol et."
        });
      }


      emailOtpStore.delete(
        key
      );


      return res.json({
        ok: true,
        verified: true,
        email,
        username:
          entry.username ||
          ""
      });

    } catch (e) {
      console.error(
        "VERIFY EMAIL OTP ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        code:
          "OTP_VERIFY_ERROR",
        error:
          e?.message ||
          "Kod doğrulanamadı."
      });
    }
  }
);


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
   FORGOT START
========================================================= */

app.post(
  "/api/forgot/start",
  async (req, res) => {
    try {
      cleanupRecoveryCodes();
      cleanupPasswordResetTokens();
      cleanupEmailOtp();


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
        crypto.randomInt(
          100000,
          1000000
        ).toString();


      const recoveryKey =
        found.email.toLowerCase();


      const recoveryEntry = {
        code,

        expires:
          Date.now() +
          10 * 60 * 1000,

        sentAt:
          Date.now(),

        attempts: 0,

        profile:
          found.profile,

        authUserId:
          found.authUser?.id ||
          null
      };


      await sendResendEmail(
        found.email,
        "Minegram doğrulama kodun",

        `<div style="font-family:Arial,sans-serif">
          <h2>Minegram</h2>

          <p>
          Şifre sıfırlama işlemin için doğrulama kodun:
          </p>

          <div style="font-size:32px;font-weight:700;letter-spacing:8px">
          ${code}
          </div>

          <p>
          Bu kod 10 dakika geçerlidir.
          </p>
        </div>`,

        `Minegram doğrulama kodun: ${code}
Bu kod 10 dakika geçerlidir.`
      );


      recoveryCodes.set(
        recoveryKey,
        recoveryEntry
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
          e?.message ||
          "Kod gönderilemedi."
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
      cleanupRecoveryCodes();
      cleanupPasswordResetTokens();


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
          Date.now()
      ) {
        recoveryCodes.delete(
          key
        );

        return res.status(400).json({
          error:
            "Kod yanlış veya süresi dolmuş."
        });
      }


      if (
        (entry.attempts || 0) >=
        5
      ) {
        recoveryCodes.delete(
          key
        );

        return res.status(429).json({
          error:
            "Çok fazla yanlış kod girildi. Yeni kod iste."
        });
      }


      const enteredCode =
        String(
          req.body?.code ||
          ""
        )
          .replace(
            /\D/g,
            ""
          )
          .slice(0, 6);


      if (
        entry.code !==
        enteredCode
      ) {
        entry.attempts =
          (entry.attempts || 0) +
          1;

        return res.status(400).json({
          error:
            "Kod yanlış veya süresi dolmuş."
        });
      }


      recoveryCodes.delete(
        key
      );


      const resetToken =
        crypto
          .randomBytes(32)
          .toString("hex");


      passwordResetTokens.set(
        resetToken,
        {
          userId:
            found.authUser?.id ||
            entry.authUserId ||
            null,

          email:
            found.email,

          expires:
            Date.now() +
            10 * 60 * 1000
        }
      );


      const p =
        entry.profile ||
        found.profile ||
        {};


      res.json({
        ok: true,

        verified: true,

        resetToken,

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
          e?.message ||
          "Kod doğrulanamadı."
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
      const resetToken =
        String(
          req.body?.resetToken ||
          ""
        ).trim();


      const password =
        String(
          req.body?.password ||
          ""
        );


      if (!resetToken) {
        return res.status(400).json({
          ok: false,
          error:
            "Şifre sıfırlama anahtarı gerekli."
        });
      }


      if (
        password.length <
        6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yeni şifre en az 6 karakter olmalı."
        });
      }


      cleanupPasswordResetTokens();


      const entry =
        passwordResetTokens.get(
          resetToken
        );


      if (
        !entry ||
        entry.expires <
          Date.now()
      ) {
        passwordResetTokens.delete(
          resetToken
        );

        return res.status(400).json({
          ok: false,
          error:
            "Şifre sıfırlama oturumu geçersiz veya süresi dolmuş."
        });
      }


      if (!entry.userId) {
        passwordResetTokens.delete(
          resetToken
        );

        return res.status(400).json({
          ok: false,
          error:
            "Hesap bilgisi bulunamadı."
        });
      }


      const admin =
        adminClient();


      const {
        error
      } =
        await admin.auth.admin.updateUserById(
          entry.userId,
          {
            password
          }
        );


      if (error) {
        throw error;
      }


      passwordResetTokens.delete(
        resetToken
      );


      return res.json({
        ok: true,

        message:
          "Şifren başarıyla değiştirildi. Şimdi giriş yapabilirsin.",

        email:
          entry.email
      });

    } catch (e) {
      console.error(
        "RESET PASSWORD ERROR:",
        e
      );

      return res.status(400).json({
        ok: false,
        error:
          e?.message ||
          "Şifre değiştirilemedi."
      });
    }
  }
);


/* =========================================================
   FORGOT RESEND
========================================================= */

app.post(
  "/api/forgot/resend",
  async (req, res) => {
    try {
      const found =
        await resolveRecoveryEmail(
          req.body?.identifier,
          req.body?.mode ||
            "email"
        );


      if (!found?.email) {
        return res.status(404).json({
          ok: false,
          error:
            "Hesap bulunamadı."
        });
      }


      const key =
        found.email.toLowerCase();


      const previous =
        recoveryCodes.get(
          key
        );


      if (
        previous?.sentAt &&
        Date.now() -
          previous.sentAt <
          60 * 1000
      ) {
        return res.status(429).json({
          ok: false,
          error:
            "Yeni kod göndermek için 60 saniye bekle."
        });
      }


      const code =
        crypto.randomInt(
          100000,
          1000000
        ).toString();


      const resendEntry = {
        code,

        expires:
          Date.now() +
          10 * 60 * 1000,

        sentAt:
          Date.now(),

        attempts: 0,

        profile:
          found.profile,

        authUserId:
          found.authUser?.id ||
          null
      };


      await sendResendEmail(
        found.email,
        "Minegram doğrulama kodun",

        `<div style="font-family:Arial,sans-serif">
          <h2>Minegram</h2>

          <p>
          Şifre sıfırlama doğrulama kodun:
          </p>

          <div style="font-size:32px;font-weight:700;letter-spacing:8px">
          ${code}
          </div>

          <p>
          Bu kod 10 dakika geçerlidir.
          </p>
        </div>`,

        `Minegram doğrulama kodun: ${code}
Bu kod 10 dakika geçerlidir.`
      );


      recoveryCodes.set(
        key,
        resendEntry
      );


      return res.json({
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
        "FORGOT RESEND ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Kod gönderilemedi."
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
        normalizeEmail(
          req.body?.email
        );


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
          e?.message ||
          "İşlem başarısız."
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
  async (req, res) => {
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
              ascending:
                false
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
          e?.message ||
          "Gönderiler alınamadı."
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
          data:
            publicData
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

        mediaType:
          data.media_type,

        createdAt:
          data.created_at
      });

    } catch (e) {
      console.error(
        "CREATE POST ERROR:",
        e
      );

      res.status(400).json({
        error:
          e?.message ||
          "Gönderi oluşturulamadı."
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
        ).toLowerCase() ||
        ".bin";


      const objectPath =
        `stories/${req.user.id}/${crypto.randomUUID()}${ext}`;


      const {
        error:
          uploadError
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
        data:
          publicData
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
          e?.message ||
          "Story oluşturulamadı."
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
              ascending:
                true
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
          e?.message
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
        data:
          existing
      } =
        await req.sb
          .from("post_likes")
          .select(
            "post_id"
          )
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
        const {
          error
        } =
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


        if (error) {
          throw error;
        }


        return res.json({
          liked:
            false
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
        data:
          post
      } =
        await req.sb
          .from("posts")
          .select(
            "user_id"
          )
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
            `@${req.user.username || "Kullanıcı"} beğendi`
        });
      }


      res.json({
        liked:
          true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e?.message ||
          "Beğeni işlemi başarısız."
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
        data:
          post
      } =
        await req.sb
          .from("posts")
          .select(
            "user_id"
          )
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
            `@${req.user.username || "Kullanıcı"} yorum yaptı`
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
          req.user.username ||
          ""
      });

    } catch (e) {
      res.status(400).json({
        error:
          e?.message ||
          "Yorum gönderilemedi."
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
        data:
          existing
      } =
        await req.sb
          .from("saves")
          .select(
            "post_id"
          )
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
        const {
          error
        } =
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


        if (error) {
          throw error;
        }


        return res.json({
          saved:
            false
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
        saved:
          true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e?.message ||
          "Kaydetme işlemi başarısız."
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
        data:
          saves,
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
        (
          saves || []
        ).map(
          x =>
            x.post_id
        );


      if (!ids.length) {
        return res.json([]);
      }


      const {
        data:
          posts,
        error:
          pError
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
          e?.message
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
        (
          data || []
        ).map(
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
          e?.message
      });
    }
  }
);


app.post(
  "/api/notifications/read",
  auth,
  async (req, res) => {
    try {
      const {
        error
      } =
        await req.sb
          .from("notifications")
          .update({
            read:
              true
          })
          .eq(
            "user_id",
            req.user.id
          );


      if (error) {
        throw error;
      }


      res.json({
        ok:
          true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e?.message
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
        data:
          existing,
        error:
          existingError
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


      if (existingError) {
        throw existingError;
      }


      if (existing) {
        const {
          error
        } =
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


        if (error) {
          throw error;
        }


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
          `@${req.user.username || "Kullanıcı"} seni takip etti`
      });


      res.json({
        following:
          true
      });

    } catch (e) {
      res.status(400).json({
        error:
          e?.message ||
          "Takip işlemi başarısız."
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
          e?.message
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
        ...safeUser(
          target
        ),

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
          e?.message
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
          req.query.q ||
          ""
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
        (
          data || []
        ).map(
          safeUser
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e?.message
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
            "*,profiles:sender_id(username,display_name,avatar_url)"
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
        (
          data || []
        ).map(
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
              "",

            displayName:
              m.profiles?.display_name ||
              "",

            avatar:
              m.profiles?.avatar_url ||
              null
          })
        )
      );

    } catch (e) {
      res.status(500).json({
        error:
          e?.message
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
          e?.message ||
          "Mesaj gönderilemedi."
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
          ).slice(
            0,
            80
          );
      }


      if (
        req.body?.bio !==
        undefined
      ) {
        patch.bio =
          String(
            req.body.bio
          ).slice(
            0,
            300
          );
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
            .update(
              patch
            )
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
        safeUser(
          data
        )
      );

    } catch (e) {
      res.status(400).json({
        error:
          e?.message
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
      const next = {
        ...(req.user.settings ||
          {}),
        ...(req.body ||
          {})
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
          e?.message
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
   GİRİŞ PAGE
========================================================= */

app.get(
  "/giris",
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
      "giris.html bulunamadı."
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


    res.status(404).json({
      error:
        "Minegram sayfası bulunamadı."
    });
  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL SERVER ERROR:",
      err
    );


    if (
      res.headersSent
    ) {
      return next(err);
    }


    res.status(
      err?.status ||
      500
    ).json({
      ok: false,

      error:
        err?.message ||
        "Sunucu hatası."
    });
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
      "======================================"
    );

    console.log(
      `Minegram server çalışıyor. PORT=${PORT}`
    );

    console.log(
      `Supabase: ${CONFIG_OK ? "OK" : "EKSİK"}`
    );

    console.log(
      `Resend: ${
        process.env.RESEND_API_KEY ||
        process.env.RESEND_KEY
          ? "OK"
          : "EKSİK"
      }`
    );

    console.log(
      `Bucket: ${BUCKET}`
    );

    console.log(
      "======================================"
    );
  }
);
