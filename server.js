import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 10000);

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).trim();

const SUPABASE_KEY = String(
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ""
).trim();

const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

const RESEND_API_KEY = String(
  process.env.RESEND_API_KEY || ""
).trim();

const RESEND_FROM_EMAIL = String(
  process.env.RESEND_FROM_EMAIL ||
  "onboarding@resend.dev"
).trim();

const PUBLIC_URL = String(
  process.env.PUBLIC_URL || ""
).trim();

const BUCKET = String(
  process.env.SUPABASE_STORAGE_BUCKET ||
  "uploads"
).trim();

const CONFIG_OK =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY;


/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");

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
   PATHS
========================================================= */

const publicDir =
  path.join(
    __dirname,
    "public"
  );

if (
  fs.existsSync(
    publicDir
  )
) {
  app.use(
    express.static(
      publicDir
    )
  );
}

app.use(
  express.static(
    __dirname
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
        50 * 1024 * 1024
    }
  });


/* =========================================================
   SUPABASE
========================================================= */

function client() {
  if (!CONFIG_OK) {
    throw new Error(
      "Supabase yapılandırması eksik."
    );
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      auth: {
        persistSession:
          false,
        autoRefreshToken:
          false,
        detectSessionInUrl:
          false
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
        persistSession:
          false,
        autoRefreshToken:
          false,
        detectSessionInUrl:
          false
      }
    }
  );
}


/* =========================================================
   PUBLIC ORIGIN
========================================================= */

function publicOrigin(req) {
  if (PUBLIC_URL) {
    return PUBLIC_URL.replace(
      /\/+$/,
      ""
    );
  }

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "https";

  const host =
    req.headers["x-forwarded-host"] ||
    req.get("host");

  return `${protocol}://${host}`;
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
        "minegram-server",
      time:
        new Date().toISOString(),
      supabase:
        CONFIG_OK,
      resend:
        !!RESEND_API_KEY
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
        ok: false,
        error:
          "Supabase yapılandırması eksik."
      });
    }

    res.json({
      ok: true,
      url:
        SUPABASE_URL,
      key:
        SUPABASE_KEY
    });
  }
);


/* =========================================================
   RESEND EMAIL
========================================================= */

async function sendResendEmail(
  to,
  subject,
  html,
  text
) {
  if (!RESEND_API_KEY) {
    throw new Error(
      "RESEND_API_KEY eksik."
    );
  }

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            from:
              RESEND_FROM_EMAIL,

            to: [
              to
            ],

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
   OTP HELPERS
========================================================= */

function createVerificationCode() {
  return String(
    crypto.randomInt(
      100000,
      1000000
    )
  );
}


function maskEmail(email) {
  const value =
    String(
      email || ""
    )
      .trim()
      .toLowerCase();

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
      name[0] +
      "*" +
      "@" +
      domain
    );
  }

  return (
    name.slice(0, 2) +
    "*".repeat(
      Math.max(
        1,
        name.length - 2
      )
    ) +
    "@" +
    domain
  );
}


/* =========================================================
   REGISTER OTP
========================================================= */

const registerVerificationCodes =
  new Map();


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
          ok: false,
          error:
            "E-posta gerekli."
        });
      }

      if (!RESEND_API_KEY) {
        return res.status(500).json({
          ok: false,
          error:
            "E-posta sistemi yapılandırılmamış. RESEND_API_KEY eksik."
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
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
</head>

<body style="
  margin:0;
  padding:30px;
  background:#f5f5f5;
  font-family:Arial,sans-serif;
">

<div style="
  max-width:500px;
  margin:auto;
  background:#ffffff;
  padding:30px;
  border-radius:16px;
">

<h2 style="
  margin:0 0 20px;
">
Minegram
</h2>

<p>
Hesabını doğrulamak için
aşağıdaki 6 haneli kodu kullan:
</p>

<div style="
  font-size:36px;
  font-weight:700;
  letter-spacing:10px;
  margin:30px 0;
">
${code}
</div>

<p>
Bu kod <b>10 dakika</b> geçerlidir.
</p>

<p style="
  color:#777;
  font-size:13px;
">
Bu kodu sen istemediysen
bu e-postayı dikkate alma.
</p>

</div>

</body>
</html>
`,

        `Minegram hesap doğrulama kodun: ${code}

Bu kod 10 dakika geçerlidir.`
      );

      console.log(
        "REGISTER OTP GÖNDERİLDİ:",
        email
      );

      return res.json({
        ok: true,
        message:
          "Doğrulama kodu gönderildi."
      });

    } catch (e) {
      console.error(
        "REGISTER OTP SEND ERROR:",
        e
      );

      return res.status(500).json({
        ok: false,
        error:
          e?.message ||
          "Doğrulama kodu gönderilemedi."
      });
    }
  }
);


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

      if (
        !email ||
        !code
      ) {
        return res.status(400).json({
          ok: false,
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
          ok: false,
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

      registerVerificationCodes.delete(
        email
      );

      return res.json({
        ok: true,
        verified: true
      });

    } catch (e) {
      console.error(
        "REGISTER OTP VERIFY ERROR:",
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
   PROFILE HELPERS
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
    value
      .replace(/^@/, "")
      .toLowerCase();

  const { data } =
    await sb
      .from("profiles")
      .select(
        "id,auth_user_id,username,email,display_name,avatar_url,bio,verified,settings"
      )
      .ilike(
        "username",
        username
      )
      .maybeSingle();

  return data || null;
}


async function findUserByPhone(
  phone
) {
  if (
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const admin =
    adminClient();

  const normalized =
    String(
      phone || ""
    )
      .replace(
        /[^\d+]/g,
        ""
      );

  const {
    data,
    error
  } =
    await admin
      .from("profiles")
      .select(
        "id,auth_user_id,username,email,phone"
      )
      .or(
        `phone.eq.${normalized}`
      )
      .limit(1)
      .maybeSingle();

  if (
    error ||
    !data
  ) {
    return null;
  }

  return {
    id:
      data.auth_user_id ||
      data.id,

    email:
      data.email,

    username:
      data.username
  };
}


/* =========================================================
   RECOVERY EMAIL
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

    const {
      data
    } =
      await anon
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

  } else {

    const {
      data
    } =
      await anon
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name,avatar_url"
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
   RECOVERY OTP
========================================================= */

const recoveryCodes =
  new Map();


/* =========================================================
   FIND ACCOUNT + SEND OTP
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
          req.body?.mode ||
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
          /^[\d\s()+\-]+$/.test(
            identifier
          )
        ) {
          recoveryMode =
            "phone";

        } else {
          recoveryMode =
            "username";
        }
      }

      let found =
        null;

      if (
        recoveryMode ===
          "phone" ||
        recoveryMode ===
          "tel" ||
        recoveryMode ===
          "telefon"
      ) {
        const authUser =
          await findUserByPhone(
            identifier
          );

        if (
          authUser?.email
        ) {
          const admin =
            adminClient();

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

          found = {
            email:
              authUser.email,

            profile:
              profileById ||
              null,

            authUser
          };
        }
      }

      if (!found) {
        found =
          await resolveRecoveryEmail(
            identifier,
            recoveryMode ===
              "username"
              ? "email"
              : recoveryMode
          );
      }

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

      console.log(
        "RECOVERY OTP GÖNDERİLDİ:",
        email
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
          e?.message ||
          "Hesap aranırken bir hata oluştu."
      });
    }
  }
);


/* =========================================================
   VERIFY RECOVERY OTP
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

      if (
        !identifier ||
        !code
      ) {
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
            "email"
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
          e?.message ||
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
          ok: false,
          error:
            "Hesap bulunamadı."
        });
      }

      const key =
        found.email
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
          ok: false,
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

      return res.json({
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
      return res.status(400).json({
        ok: false,
        error:
          e.message
      });
    }
  }
);


/* =========================================================
   RESET PASSWORD EMAIL
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
          ok: false,
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
          ok: false,
          error:
            error.message
        });
      }

      return res.json({
        ok: true
      });

    } catch (e) {
      return res.status(500).json({
        ok: false,
        error:
          e.message
      });
    }
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
      "MINEGRAM SERVER BAŞLADI"
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
        RESEND_API_KEY
          ? "OK"
          : "EKSİK"
      }`
    );

    console.log(
      `FROM EMAIL: ${RESEND_FROM_EMAIL}`
    );

    console.log(
      "======================================"
    );
  }
);
