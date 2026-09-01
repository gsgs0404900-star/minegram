import "dotenv/config";

import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";

/* =========================================================
   PATH / APP
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* =========================================================
   PORT
========================================================= */

const PORT =
  Number(process.env.PORT || 3000);

/* =========================================================
   PUBLIC DIRECTORY
========================================================= */

const publicDir =
  path.join(__dirname, "public");

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, {
    recursive: true
  });
}

/* =========================================================
   SUPABASE CONFIG
========================================================= */

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL || ""
  ).trim();

const SUPABASE_KEY =
  String(
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

const CONFIG_OK =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY;

/* =========================================================
   STORAGE BUCKET
========================================================= */

const BUCKET =
  String(
    process.env.SUPABASE_STORAGE_BUCKET ||
    "minegram"
  ).trim();

/* =========================================================
   EXPRESS MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb"
  })
);

/* =========================================================
   STATIC
========================================================= */

app.use(
  express.static(
    publicDir
  )
);

/* =========================================================
   MULTER
========================================================= */

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        100 * 1024 * 1024
    }
  });

/* =========================================================
   SUPABASE CLIENT
========================================================= */

function client(
  accessToken = null
) {
  if (!CONFIG_OK) {
    throw new Error(
      "Supabase yapılandırması eksik."
    );
  }

  const options = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  };

  if (accessToken) {
    options.global = {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    };
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    options
  );
}

/* =========================================================
   ADMIN CLIENT
========================================================= */

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
   PUBLIC ORIGIN
========================================================= */

function publicOrigin(req) {
  const configured =
    String(
      process.env.PUBLIC_URL || ""
    ).trim();

  if (configured) {
    return configured.replace(
      /\/+$/,
      ""
    );
  }

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "http";

  const host =
    req.get("host");

  return `${protocol}://${host}`;
}

/* =========================================================
   VERIFICATION CODE
========================================================= */

function createVerificationCode() {
  return String(
    Math.floor(
      100000 +
      Math.random() * 900000
    )
  );
}

/* =========================================================
   PHONE NORMALIZE
========================================================= */

function normalizeRecoveryPhone(
  phone
) {
  let value =
    String(
      phone || ""
    ).trim();

  value =
    value.replace(
      /[^0-9+]/g,
      ""
    );

  if (
    value.startsWith("+90")
  ) {
    value =
      "0" +
      value.slice(3);
  }

  if (
    value.startsWith("90") &&
    value.length === 12
  ) {
    value =
      "0" +
      value.slice(2);
  }

  return value;
}

/* =========================================================
   MASK EMAIL
========================================================= */

function maskEmail(email) {
  const value =
    String(
      email || ""
    ).trim();

  const parts =
    value.split("@");

  if (
    parts.length !== 2
  ) {
    return value;
  }

  const name =
    parts[0];

  const domain =
    parts[1];

  if (
    name.length <= 2
  ) {
    return (
      name.charAt(0) +
      "***@" +
      domain
    );
  }

  return (
    name.charAt(0) +
    "***" +
    name.charAt(
      name.length - 1
    ) +
    "@" +
    domain
  );
}

/* =========================================================
   SAFE USER
========================================================= */

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id:
      user.id ||
      null,

    username:
      user.username ||
      "",

    displayName:
      user.display_name ||
      user.displayName ||
      user.username ||
      "",

    email:
      user.email ||
      "",

    bio:
      user.bio ||
      "",

    avatar:
      user.avatar_url ||
      user.avatar ||
      null,

    verified:
      !!user.verified,

    settings:
      user.settings ||
      {}
  };
}

/* =========================================================
   FIND PROFILE
========================================================= */

async function findProfile(
  sb,
  username
) {
  const value =
    String(
      username || ""
    ).trim();

  if (!value) {
    return null;
  }

  const {
    data,
    error
  } =
    await sb
      .from("profiles")
      .select("*")
      .or(
        `username.eq.${value},email.eq.${value}`
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    console.error(
      "FIND PROFILE ERROR:",
      error
    );

    return null;
  }

  return data || null;
}

/* =========================================================
   FIND USER BY PHONE
========================================================= */

async function findUserByPhone(
  phone
) {
  if (
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const normalized =
    normalizeRecoveryPhone(
      phone
    );

  if (!normalized) {
    return null;
  }

  try {
    const admin =
      adminClient();

    /*
      Supabase Auth kullanıcılarını
      admin API ile sayfalı şekilde arıyoruz.
    */

    let page = 1;

    const perPage = 1000;

    while (true) {
      const {
        data,
        error
      } =
        await admin.auth.admin.listUsers({
          page,
          perPage
        });

      if (error) {
        console.error(
          "AUTH PHONE SEARCH ERROR:",
          error
        );

        return null;
      }

      const users =
        data?.users || [];

      for (
        const user of users
      ) {
        const userPhone =
          normalizeRecoveryPhone(
            user.phone
          );

        if (
          userPhone &&
          userPhone === normalized
        ) {
          return user;
        }
      }

      if (
        users.length <
        perPage
      ) {
        break;
      }

      page++;
    }

    return null;

  } catch (error) {
    console.error(
      "FIND USER BY PHONE ERROR:",
      error
    );

    return null;
  }
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

  if (!raw) {
    return null;
  }

  let email =
    raw;

  let profile =
    null;

  let authUser =
    null;

  /* -------------------------------------------------------
     PHONE
  ------------------------------------------------------- */

  if (
    mode === "phone" ||
    mode === "tel" ||
    mode === "telefon"
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
          "id,auth_user_id,username,email,display_name,avatar_url,bio,verified,settings"
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

  /* -------------------------------------------------------
     USERNAME
  ------------------------------------------------------- */

  if (
    mode === "username" ||
    (
      !email.includes("@") &&
      mode !== "email"
    )
  ) {
    profile =
      await findProfile(
        anon,
        raw
      );

    if (!profile) {
      return null;
    }

    email =
      profile.email ||
      "";

    /*
      Profile tablosunda email yoksa
      Auth üzerinden al.
    */

    if (
      !email &&
      SUPABASE_SERVICE_ROLE_KEY
    ) {
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
        !error &&
        data?.user?.email
      ) {
        authUser =
          data.user;

        email =
          data.user.email;
      }
    }

    if (!email) {
      return null;
    }

    return {
      email,
      profile,
      authUser
    };
  }

  /* -------------------------------------------------------
     EMAIL
  ------------------------------------------------------- */

  email =
    raw.toLowerCase();

  const {
    data
  } =
    await anon
      .from("profiles")
      .select(
        "id,auth_user_id,username,email,display_name,avatar_url,bio,verified,settings"
      )
      .eq(
        "email",
        email
      )
      .limit(1)
      .maybeSingle();

  profile =
    data || null;

  /*
    Profile email alanı yoksa
    Auth üzerinden kullanıcıyı bul.
  */

  if (
    !profile &&
    SUPABASE_SERVICE_ROLE_KEY
  ) {
    try {
      const admin =
        adminClient();

      let page = 1;

      const perPage = 1000;

      while (true) {
        const {
          data,
          error
        } =
          await admin.auth.admin.listUsers({
            page,
            perPage
          });

        if (error) {
          break;
        }

        const users =
          data?.users || [];

        authUser =
          users.find(
            u =>
              String(
                u.email || ""
              )
                .toLowerCase() ===
              email
          );

        if (authUser) {
          break;
        }

        if (
          users.length <
          perPage
        ) {
          break;
        }

        page++;
      }

      if (
        authUser?.id
      ) {
        const {
          data: profileData
        } =
          await admin
            .from("profiles")
            .select(
              "id,auth_user_id,username,email,display_name,avatar_url,bio,verified,settings"
            )
            .or(
              `id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`
            )
            .limit(1)
            .maybeSingle();

        profile =
          profileData ||
          null;
      }

    } catch (e) {
      console.error(
        "AUTH EMAIL LOOKUP ERROR:",
        e
      );
    }
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
    if (!CONFIG_OK) {
      return res.status(500).json({
        error:
          "Supabase yapılandırması eksik."
      });
    }

    const header =
      String(
        req.headers.authorization ||
        ""
      );

    if (
      !header.toLowerCase()
        .startsWith("bearer ")
    ) {
      return res.status(401).json({
        error:
          "Oturum gerekli."
      });
    }

    const token =
      header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Oturum tokenı bulunamadı."
      });
    }

    const sb =
      client(token);

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

    const authUser =
      data.user;

    const {
      data: profile
    } =
      await sb
        .from("profiles")
        .select("*")
        .or(
          `id.eq.${authUser.id},auth_user_id.eq.${authUser.id}`
        )
        .limit(1)
        .maybeSingle();

    req.authUser =
      authUser;

    req.user =
      profile || {
        id:
          authUser.id,

        auth_user_id:
          authUser.id,

        email:
          authUser.email ||
          "",

        username:
          authUser.user_metadata
            ?.username ||
          "",

        display_name:
          authUser.user_metadata
            ?.display_name ||
          "",

        settings:
          {}
      };

    req.sb =
      sb;

    next();

  } catch (e) {
    console.error(
      "AUTH ERROR:",
      e
    );

    return res.status(401).json({
      error:
        "Kimlik doğrulama başarısız."
    });
  }
}

/* =========================================================
   NOTIFICATIONS HELPER
========================================================= */

async function addNotification({
  userId,
  fromUserId,
  type,
  postId = null,
  text
}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      "Notification için service role key yok."
    );

    return;
  }

  try {
    const admin =
      adminClient();

    const payload = {
      user_id:
        userId,

      from_user_id:
        fromUserId,

      type:
        type,

      post_id:
        postId,

      text:
        text,

      read:
        false
    };

    const {
      error
    } =
      await admin
        .from("notifications")
        .insert(payload);

    if (error) {
      console.error(
        "NOTIFICATION ERROR:",
        error
      );
    }

  } catch (e) {
    console.error(
      "ADD NOTIFICATION ERROR:",
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
  if (!posts?.length) {
    return [];
  }

  const postIds =
    posts.map(
      p => p.id
    );

  const userIds =
    [
      ...new Set(
        posts
          .map(
            p => p.user_id
          )
          .filter(Boolean)
      )
    ];

  const [
    profilesResult,
    likesResult,
    savesResult,
    commentsResult
  ] =
    await Promise.all([
      sb
        .from("profiles")
        .select(
          "id,username,display_name,avatar_url,verified"
        )
        .in(
          "id",
          userIds
        ),

      sb
        .from("post_likes")
        .select(
          "post_id,user_id"
        )
        .in(
          "post_id",
          postIds
        ),

      sb
        .from("saves")
        .select(
          "post_id,user_id"
        )
        .in(
          "post_id",
          postIds
        ),

      sb
        .from("comments")
        .select(
          "id,post_id,user_id,text,created_at"
        )
        .in(
          "post_id",
          postIds
        )
        .order(
          "created_at",
          {
            ascending:
              true
          }
        )
    ]);

  const profiles =
    profilesResult.data ||
    [];

  const likes =
    likesResult.data ||
    [];

  const saves =
    savesResult.data ||
    [];

  const comments =
    commentsResult.data ||
    [];

  return posts.map(
    post => {
      const profile =
        profiles.find(
          p =>
            p.id ===
            post.user_id
        );

      const postLikes =
        likes.filter(
          l =>
            l.post_id ===
            post.id
        );

      const postSaves =
        saves.filter(
          s =>
            s.post_id ===
            post.id
        );

      const postComments =
        comments.filter(
          c =>
            c.post_id ===
            post.id
        );

      return {
        ...post,

        id:
          post.id,

        userId:
          post.user_id,

        username:
          profile?.username ||
          "",

        displayName:
          profile?.display_name ||
          profile?.username ||
          "",

        avatar:
          profile?.avatar_url ||
          null,

        verified:
          !!profile?.verified,

        caption:
          post.caption ||
          "",

        media:
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

        likeCount:
          postLikes.length,

        likes:
          postLikes.length,

        liked:
          postLikes.some(
            l =>
              l.user_id ===
              currentUserId
          ),

        saved:
          postSaves.some(
            s =>
              s.user_id ===
              currentUserId
          ),

        saveCount:
          postSaves.length,

        commentCount:
          postComments.length,

        comments:
          postComments.map(
            c => ({
              id:
                c.id,

              userId:
                c.user_id,

              text:
                c.text,

              createdAt:
                c.created_at
            })
          )
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
      app:
        "Minegram",
      time:
        new Date().toISOString()
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
   RECOVERY / REGISTER MAPS
========================================================= */

const registerVerificationCodes =
  new Map();

const recoveryCodes =
  new Map();

/* =========================================================
   RESEND EMAIL
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

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${key}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            from,
            to: [to],
            subject,
            html,
            text
          })
      }
    );

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  if (!response.ok) {
    console.error(
      "[RESEND ERROR]",
      response.status,
      data
    );

    throw new Error(
      data?.message ||
      data?.error ||
      `Resend hata verdi (${response.status}).`
    );
  }

  return data;
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

      if (!identifier) {
        return res.json({
          ok: true
        });
      }

      const found =
        await resolveRecoveryEmail(
          identifier,
          identifier.includes("@")
            ? "email"
            : "username"
        );

      if (!found?.email) {
        return res.json({
          ok: true
        });
      }

      const anon =
        client();

      const {
        error
      } =
        await anon.auth
          .resetPasswordForEmail(
            found.email,
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
      console.error(
        "FORGOT ERROR:",
        e
      );

      res.json({
        ok: true
      });
    }
  }
);

/* =========================================================
   REGISTER OTP SEND
========================================================= */

app.post(
  "/api/register/send-code",
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email ||
          ""
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res.status(400).json({
          error:
            "E-posta gerekli."
        });
      }

      const code =
        createVerificationCode();

      registerVerificationCodes.set(
        email,
        {
          code,

          expires:
            Date.now() +
            10 * 60 * 1000
        }
      );

      await sendResendEmail(
        email,

        "Minegram hesap doğrulama kodun",

        `
        <div style="
          font-family:Arial,sans-serif;
          background:#fff;
          padding:30px;
          max-width:500px;
          margin:auto;
        ">

          <h2>Minegram</h2>

          <p>
            Hesabını doğrulamak için
            aşağıdaki 6 haneli kodu kullan:
          </p>

          <div style="
            font-size:36px;
            font-weight:700;
            letter-spacing:10px;
            margin:25px 0;
          ">
            ${code}
          </div>

          <p>
            Bu kod 10 dakika geçerlidir.
          </p>

          <p style="color:#777">
            Bu kodu sen istemediysen
            bu e-postayı dikkate alma.
          </p>

        </div>
        `,

        `Minegram hesap doğrulama kodun: ${code}
Bu kod 10 dakika geçerlidir.`
      );

      console.log(
        "REGISTER OTP GÖNDERİLDİ:",
        email
      );

      res.json({
        ok: true
      });

    } catch (e) {
      console.error(
        "REGISTER OTP SEND ERROR:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Doğrulama kodu gönderilemedi."
      });
    }
  }
);

/* =========================================================
   REGISTER OTP VERIFY
========================================================= */

app.post(
  "/api/register/verify-code",
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email ||
          ""
        )
          .trim()
          .toLowerCase();

      const code =
        String(
          req.body?.code ||
          ""
        ).trim();

      if (!email || !code) {
        return res.status(400).json({
          error:
            "E-posta ve doğrulama kodu gerekli."
        });
      }

      const entry =
        registerVerificationCodes.get(
          email
        );

      if (!entry) {
        return res.status(400).json({
          error:
            "Doğrulama kodu bulunamadı. Yeni kod gönder."
        });
      }

      if (
        entry.expires <
        Date.now()
      ) {
        registerVerificationCodes.delete(
          email
        );

        return res.status(400).json({
          error:
            "Doğrulama kodunun süresi dolmuş."
        });
      }

      if (
        entry.code !==
        code
      ) {
        return res.status(400).json({
          error:
            "Doğrulama kodu yanlış."
        });
      }

      registerVerificationCodes.delete(
        email
      );

      res.json({
        ok: true,
        verified: true
      });

    } catch (e) {
      console.error(
        "REGISTER OTP VERIFY ERROR:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Kod doğrulanamadı."
      });
    }
  }
);

/* =========================================================
   FIND ACCOUNT
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
          error:
            "E-posta, kullanıcı adı veya telefon numarası gerekli."
        });
      }

      let recoveryMode =
        mode;

      if (!recoveryMode) {
        if (
          identifier.includes("@")
        ) {
          recoveryMode =
            "email";

        } else if (
          /[\d\s()+\-]/.test(
            identifier
          ) &&
          normalizeRecoveryPhone(
            identifier
          ).length >= 10
        ) {
          recoveryMode =
            "phone";

        } else {
          recoveryMode =
            "username";
        }
      }

      const found =
        await resolveRecoveryEmail(
          identifier,
          recoveryMode
        );

      if (!found?.email) {
        return res.status(404).json({
          ok: false,
          error:
            "Bu bilgilerle eşleşen bir hesap bulunamadı."
        });
      }

      const email =
        String(
          found.email
        )
          .trim()
          .toLowerCase();

      const profile =
        found.profile ||
        {};

      const code =
        createVerificationCode();

      recoveryCodes.set(
        email,
        {
          code,

          expires:
            Date.now() +
            10 * 60 * 1000,

          profile
        }
      );

      await sendResendEmail(
        email,

        "Minegram doğrulama kodun",

        `
        <div style="
          font-family:Arial,sans-serif;
          max-width:500px;
          margin:auto;
          padding:30px;
          background:#fff;
          color:#111;
          border-radius:12px;
        ">

          <h2>Minegram</h2>

          <p>
            Şifre sıfırlama işlemin için
            doğrulama kodun:
          </p>

          <div style="
            font-size:32px;
            font-weight:700;
            letter-spacing:8px;
            margin:25px 0;
          ">
            ${code}
          </div>

          <p>
            Bu kod 10 dakika geçerlidir.
          </p>

          <p style="
            color:#777;
            font-size:12px;
          ">
            Bu işlemi sen yapmadıysan
            bu e-postayı dikkate alma.
          </p>

        </div>
        `,

        `Minegram doğrulama kodun: ${code}

Bu kod 10 dakika geçerlidir.`
      );

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
            profile.username ||
            "",

          email,

          maskedEmail:
            maskEmail(email),

          avatar:
            profile.avatar_url ||
            null
        },

        identifier,

        mode:
          recoveryMode
      });

    } catch (e) {
      console.error(
        "FIND ACCOUNT ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e.message ||
          "Hesap aranırken bir hata oluştu."
      });
    }
  }
);

/* =========================================================
   FORGOT PASSWORD VERIFY
========================================================= */

app.post(
  "/api/forgot-password/verify",
  async (req, res) => {
    try {
      const identifier =
        String(
          req.body?.identifier ||
          req.body?.email ||
          ""
        )
          .trim()
          .toLowerCase();

      const code =
        String(
          req.body?.code ||
          ""
        ).trim();

      if (!identifier || !code) {
        return res.status(400).json({
          ok: false,
          error:
            "E-posta ve doğrulama kodu gerekli."
        });
      }

      let email =
        identifier;

      if (
        !identifier.includes("@")
      ) {
        const found =
          await resolveRecoveryEmail(
            identifier,
            "username"
          );

        if (!found?.email) {
          return res.status(404).json({
            ok: false,
            error:
              "Hesap bulunamadı."
          });
        }

        email =
          String(
            found.email
          )
            .trim()
            .toLowerCase();
      }

      const entry =
        recoveryCodes.get(
          email
        );

      if (!entry) {
        return res.status(400).json({
          ok: false,
          error:
            "Doğrulama kodu bulunamadı veya süresi dolmuş."
        });
      }

      if (
        entry.expires <
        Date.now()
      ) {
        recoveryCodes.delete(
          email
        );

        return res.status(400).json({
          ok: false,
          error:
            "Doğrulama kodunun süresi dolmuş."
        });
      }

      if (
        entry.code !==
        code
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Doğrulama kodu yanlış."
        });
      }

      const profile =
        entry.profile ||
        {};

      recoveryCodes.delete(
        email
      );

      return res.json({
        ok: true,

        verified: true,

        account: {
          id:
            profile.id ||
            null,

          username:
            profile.username ||
            "",

          displayName:
            profile.display_name ||
            profile.username ||
            "",

          email,

          avatar:
            profile.avatar_url ||
            null
        }
      });

    } catch (e) {
      console.error(
        "VERIFY CODE ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e.message ||
          "Kod doğrulanırken hata oluştu."
      });
    }
  }
);

/* =========================================================
   FORGOT VERIFY LEGACY
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
        String(
          found.email
        )
          .toLowerCase();

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
            p.username ||
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
        )
          .trim()
          .toLowerCase();

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
        await anon.auth
          .resetPasswordForEmail(
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
      console.error(
        "CREATE POST ERROR:",
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

      if (
        post &&
        post.user_id !==
          req.user.id
      ) {
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
        liked:
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

      if (
        post &&
        post.user_id !==
          req.user.id
      ) {
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
            x =>
              x.post_id
          );

      if (!ids.length) {
        return res.json([]);
      }

      const {
        data: posts,
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

/* =========================================================
   NOTIFICATIONS READ
========================================================= */

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
        (data || [])
          .map(
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

/* =========================================================
   SEND MESSAGE
========================================================= */

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
          ...(req.user.settings || {}),
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
   GIRIS PAGE
========================================================= */

app.get(
  "/giris",
  (req, res) => {
    const file =
      path.join(
        publicDir,
        "giris.html"
      );

    if (
      fs.existsSync(file)
    ) {
      return res.sendFile(
        file
      );
    }

    res.status(404).send(
      "giris.html bulunamadı."
    );
  }
);

/* =========================================================
   INDEX PAGE
========================================================= */

app.get(
  "/",
  (req, res) => {
    const indexFile =
      path.join(
        publicDir,
        "index.html"
      );

    if (
      fs.existsSync(
        indexFile
      )
    ) {
      return res.sendFile(
        indexFile
      );
    }

    const girisFile =
      path.join(
        publicDir,
        "giris.html"
      );

    if (
      fs.existsSync(
        girisFile
      )
    ) {
      return res.sendFile(
        girisFile
      );
    }

    res.status(404).send(
      "Minegram sayfası bulunamadı."
    );
  }
);

/* =========================================================
   FALLBACK
========================================================= */

app.use(
  (req, res) => {
    /*
      API adresi bulunamadıysa JSON dön.
    */

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        error:
          "API endpoint bulunamadı."
      });
    }

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
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "SERVER ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(
      err.status || 500
    ).json({
      error:
        err.message ||
        "Sunucu hatası."
    });
  }
);

/* =========================================================
   START SCRIPT
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "        MINEGRAM SERVER"
    );

    console.log(
      "======================================"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `PUBLIC DIR: ${publicDir}`
    );

    console.log(
      `SUPABASE: ${
        CONFIG_OK
          ? "OK"
          : "EKSİK"
      }`
    );

    console.log(
      `RESEND: ${
        process.env.RESEND_API_KEY
          ? "OK"
          : "EKSİK"
      }`
    );

    console.log(
      `STORAGE BUCKET: ${BUCKET}`
    );

    console.log(
      "======================================"
    );

    console.log(
      `Minegram server çalışıyor: http://localhost:${PORT}`
    );

    console.log(
      `Mesaj: http://localhost:${PORT}/mesaj`
    );

    console.log(
      "======================================"
    );
  }
);
