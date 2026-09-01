/**
 * =========================================================
 * MINEGRAM
 * Firebase Cloud Functions
 * Resend + OTP + Supabase
 * =========================================================
 */

import "dotenv/config";

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { createClient } from "@supabase/supabase-js";

/*
 * Firebase Functions
 */
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";

/*
 * =========================================================
 * PATH
 * =========================================================
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
 * =========================================================
 * EXPRESS
 * =========================================================
 */

const app = express();

/*
 * =========================================================
 * FIREBASE
 * =========================================================
 */

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 10
});

/*
 * =========================================================
 * MIDDLEWARE
 * =========================================================
 */

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

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

/*
 * =========================================================
 * MULTER
 * =========================================================
 */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/*
 * =========================================================
 * ENV
 * =========================================================
 */

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL || ""
  ).trim();

const SUPABASE_KEY =
  String(
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    ""
  ).trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

const RESEND_API_KEY =
  String(
    process.env.RESEND_API_KEY || ""
  ).trim();

const RESEND_FROM_EMAIL =
  String(
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev"
  ).trim();

const PORT =
  Number(
    process.env.PORT || 5000
  );

const BUCKET =
  String(
    process.env.SUPABASE_BUCKET ||
    "media"
  ).trim();

const CONFIG_OK =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY;

/*
 * =========================================================
 * CLIENTS
 * =========================================================
 */

function client(accessToken = "") {
  return createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      global: accessToken
        ? {
            headers: {
              Authorization:
                `Bearer ${accessToken}`
            }
          }
        : {}
    }
  );
}

function adminClient() {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY eksik."
    );
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );
}

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

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
  return String(
    value || ""
  )
    .replace(/[^\d+]/g, "")
    .trim();
}

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
    normalizeEmail(email);

  const parts =
    value.split("@");

  if (
    parts.length !== 2
  ) {
    return "***";
  }

  const name =
    parts[0];

  const domain =
    parts[1];

  let maskedName;

  if (name.length <= 2) {
    maskedName =
      name[0] + "*";
  } else {
    maskedName =
      name[0] +
      "*".repeat(
        Math.min(
          5,
          name.length - 2
        )
      ) +
      name[name.length - 1];
  }

  return (
    maskedName +
    "@" +
    domain
  );
}

function publicOrigin(req) {
  const configured =
    String(
      process.env.PUBLIC_ORIGIN || ""
    ).trim();

  if (configured) {
    return configured.replace(
      /\/$/,
      ""
    );
  }

  const forwardedProto =
    req.headers[
      "x-forwarded-proto"
    ];

  const proto =
    forwardedProto ||
    req.protocol ||
    "https";

  const host =
    req.headers.host ||
    "";

  return `${proto}://${host}`;
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
      !!user.verified
  };
}

/*
 * =========================================================
 * SUPABASE PROFILE SEARCH
 * =========================================================
 */

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

  /*
   * Username
   */

  const usernameResult =
    await sb
      .from("profiles")
      .select(
        "id,auth_user_id,username,email,display_name,bio,avatar_url,verified,phone"
      )
      .eq(
        "username",
        username
      )
      .maybeSingle();

  if (
    usernameResult.data
  ) {
    return usernameResult.data;
  }

  /*
   * Email
   */

  if (
    email.includes("@")
  ) {
    const emailResult =
      await sb
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name,bio,avatar_url,verified,phone"
        )
        .eq(
          "email",
          email
        )
        .maybeSingle();

    if (
      emailResult.data
    ) {
      return emailResult.data;
    }
  }

  return null;
}

/*
 * =========================================================
 * FIND USER BY PHONE
 * =========================================================
 */

async function findUserByPhone(
  phone
) {
  const normalized =
    normalizeRecoveryPhone(
      phone
    );

  if (!normalized) {
    return null;
  }

  /*
   * Önce service role ile profiles
   */

  if (
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const admin =
    adminClient();

  const candidates = [
    normalized,
    normalized.replace(
      /^\+/,
      ""
    )
  ];

  for (
    const candidate of candidates
  ) {
    const {
      data,
      error
    } =
      await admin
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name,bio,avatar_url,verified,phone"
        )
        .eq(
          "phone",
          candidate
        )
        .maybeSingle();

    if (
      !error &&
      data
    ) {
      let authId =
        data.auth_user_id ||
        data.id;

      try {
        const authResult =
          await admin.auth.admin.getUserById(
            authId
          );

        if (
          authResult.data?.user
        ) {
          return authResult.data.user;
        }
      } catch {
        return {
          id:
            authId,

          email:
            data.email || "",

          phone:
            data.phone || ""
        };
      }
    }
  }

  return null;
}

/*
 * =========================================================
 * RECOVERY EMAIL RESOLVE
 * =========================================================
 */

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
    normalizeEmail(raw);

  let profile =
    null;

  let authUser =
    null;

  /*
   * PHONE
   */

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
      normalizeEmail(
        authUser.email
      );

    const {
      data
    } =
      await anon
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name,bio,avatar_url,verified"
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

  /*
   * USERNAME
   */

  if (
    mode === "username" ||
    !email.includes("@")
  ) {
    profile =
      await findProfile(
        anon,
        raw
      );

    if (!profile) {
      return null;
    }

    if (
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      /*
       * Profile'da email varsa
       * onu kullan.
       */

      if (
        profile.email
      ) {
        email =
          normalizeEmail(
            profile.email
          );
      } else {
        return null;
      }
    } else {
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
        normalizeEmail(
          data.user.email
        );

      authUser =
        data.user;
    }
  }

  /*
   * EMAIL -> PROFILE
   */

  if (!profile) {
    const {
      data
    } =
      await anon
        .from("profiles")
        .select(
          "id,auth_user_id,username,email,display_name,bio,avatar_url,verified"
        )
        .eq(
          "email",
          email
        )
        .maybeSingle();

    profile =
      data || null;
  }

  /*
   * Eğer profile bulunamadıysa
   * service role ile Auth kullanıcısını bul.
   */

  if (
    !authUser &&
    SUPABASE_SERVICE_ROLE_KEY
  ) {
    const admin =
      adminClient();

    try {
      const {
        data
      } =
        await admin.auth.admin.listUsers({
          page: 1,
          perPage: 1000
        });

      authUser =
        data?.users?.find(
          user =>
            normalizeEmail(
              user.email
            ) === email
        ) || null;
    } catch {
      authUser =
        null;
    }
  }

  return {
    email,
    profile,
    authUser
  };
}

/*
 * =========================================================
 * RESEND EMAIL
 * =========================================================
 */

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

  if (!to) {
    throw new Error(
      "E-posta adresi eksik."
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

        body: JSON.stringify({
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

  if (
    !response.ok
  ) {
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

/*
 * =========================================================
 * OTP MAPS
 * =========================================================
 */

const registerVerificationCodes =
  new Map();

const recoveryCodes =
  new Map();

/*
 * =========================================================
 * OTP CLEANUP
 * =========================================================
 */

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        email,
        entry
      ]
      of registerVerificationCodes
    ) {
      if (
        entry.expires < now
      ) {
        registerVerificationCodes.delete(
          email
        );
      }
    }

    for (
      const [
        email,
        entry
      ]
      of recoveryCodes
    ) {
      if (
        entry.expires < now
      ) {
        recoveryCodes.delete(
          email
        );
      }
    }
  },
  60 * 1000
);

/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      app: "Minegram",
      server: "Firebase Cloud Functions",
      email: !!RESEND_API_KEY,
      supabase: CONFIG_OK
    });
  }
);

/*
 * =========================================================
 * AUTH CONFIG
 * =========================================================
 */

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

    return res.json({
      ok: true,

      url:
        SUPABASE_URL,

      key:
        SUPABASE_KEY
    });
  }
);

/*
 * =========================================================
 * REGISTER SEND CODE
 * =========================================================
 */

app.post(
  "/api/register/send-code",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      if (!email) {
        return res.status(400).json({
          ok: false,
          error:
            "E-posta gerekli."
        });
      }

      if (
        !email.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Geçerli bir e-posta adresi gir."
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
        <!doctype html>

        <html>
        <body
          style="
            margin:0;
            padding:0;
            background:#f5f5f5;
            font-family:Arial,sans-serif;
          "
        >

          <div
            style="
              max-width:500px;
              margin:40px auto;
              background:#fff;
              border-radius:16px;
              padding:32px;
            "
          >

            <h1
              style="
                margin:0 0 20px;
              "
            >
              Minegram
            </h1>

            <p>
              Hesabını doğrulamak için
              aşağıdaki 6 haneli kodu kullan:
            </p>

            <div
              style="
                margin:30px 0;
                font-size:38px;
                font-weight:700;
                letter-spacing:10px;
              "
            >
              ${code}
            </div>

            <p>
              Bu kod
              <strong>10 dakika</strong>
              geçerlidir.
            </p>

            <p
              style="
                color:#777;
                font-size:13px;
              "
            >
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
        sent: true
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

/*
 * =========================================================
 * REGISTER VERIFY CODE
 * =========================================================
 */

app.post(
  "/api/register/verify-code",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const code =
        String(
          req.body?.code || ""
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
        entry.code !== code
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
        verified: true,
        email
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

/*
 * =========================================================
 * FORGOT LEGACY
 * =========================================================
 */

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
        await anon.auth.resetPasswordForEmail(
          found.email,
          {
            redirectTo:
              `${publicOrigin(req)}/`
          }
        );

      if (error) {
        console.error(
          "FORGOT ERROR:",
          error
        );
      }

      return res.json({
        ok: true
      });

    } catch (e) {
      console.error(
        "FORGOT ERROR:",
        e
      );

      return res.json({
        ok: true
      });
    }
  }
);

/*
 * =========================================================
 * FIND ACCOUNT
 * =========================================================
 */

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
          req.body?.mode ?? ""
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
        normalizeEmail(
          found.email
        );

      const profile =
        found.profile || {};

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
        <!doctype html>

        <html>
        <body
          style="
            margin:0;
            padding:0;
            background:#f5f5f5;
            font-family:Arial,sans-serif;
          "
        >

          <div
            style="
              max-width:500px;
              margin:40px auto;
              background:#fff;
              border-radius:16px;
              padding:32px;
            "
          >

            <h1>
              Minegram
            </h1>

            <p>
              Şifre sıfırlama işlemin için
              doğrulama kodun:
            </p>

            <div
              style="
                font-size:38px;
                font-weight:700;
                letter-spacing:10px;
                margin:30px 0;
              "
            >
              ${code}
            </div>

            <p>
              Bu kod
              <strong>10 dakika</strong>
              geçerlidir.
            </p>

            <p
              style="
                color:#777;
                font-size:13px;
              "
            >
              Bu işlemi sen yapmadıysan
              bu e-postayı dikkate alma.
            </p>

          </div>

        </body>
        </html>
        `,

        `Minegram doğrulama kodun: ${code}

Bu kod 10 dakika geçerlidir.`
      );

      return res.status(200).json({
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

/*
 * =========================================================
 * FORGOT PASSWORD VERIFY
 * =========================================================
 */

app.post(
  "/api/forgot-password/verify",
  async (req, res) => {
    try {
      const identifier =
        String(
          req.body?.identifier ||
          req.body?.email ||
          ""
        ).trim();

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

      const found =
        await resolveRecoveryEmail(
          identifier,
          identifier.includes("@")
            ? "email"
            : "username"
        );

      if (!found?.email) {
        return res.status(404).json({
          ok: false,
          error:
            "Hesap bulunamadı."
        });
      }

      const email =
        normalizeEmail(
          found.email
        );

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
        entry.code !== code
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Doğrulama kodu yanlış."
        });
      }

      const profile =
        entry.profile ||
        found.profile ||
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

/*
 * =========================================================
 * FORGOT VERIFY LEGACY
 * =========================================================
 */

app.post(
  "/api/forgot/verify",
  async (req, res) => {
    try {
      const identifier =
        req.body?.identifier;

      const mode =
        req.body?.mode ||
        "email";

      const found =
        await resolveRecoveryEmail(
          identifier,
          mode
        );

      if (!found?.email) {
        return res.status(400).json({
          ok: false,
          error:
            "Hesap bulunamadı."
        });
      }

      const key =
        normalizeEmail(
          found.email
        );

      const entry =
        recoveryCodes.get(
          key
        );

      const code =
        String(
          req.body?.code ||
          ""
        ).trim();

      if (
        !entry ||
        entry.expires <
          Date.now() ||
        entry.code !== code
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

      const profile =
        entry.profile ||
        found.profile ||
        {};

      return res.json({
        ok: true,

        email:
          found.email,

        account: {
          username:
            profile.username ||
            "minegram",

          email:
            found.email,

          displayName:
            profile.display_name ||
            profile.displayName ||
            ""
        }
      });

    } catch (e) {
      return res.status(400).json({
        ok: false,
        error:
          e?.message ||
          "Doğrulama başarısız."
      });
    }
  }
);

/*
 * =========================================================
 * SEND RESET
 * =========================================================
 */

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
          e?.message ||
          "Şifre sıfırlama e-postası gönderilemedi."
      });
    }
  }
);

/*
 * =========================================================
 * AUTH MIDDLEWARE
 * =========================================================
 */

async function auth(
  req,
  res,
  next
) {
  try {
    const header =
      String(
        req.headers.authorization ||
        ""
      );

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
      header.substring(
        7
      ).trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Geçersiz oturum."
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

    req.sb =
      sb;

    req.authUser =
      data.user;

    const profileResult =
      await sb
        .from("profiles")
        .select("*")
        .or(
          `id.eq.${data.user.id},auth_user_id.eq.${data.user.id}`
        )
        .limit(1)
        .maybeSingle();

    req.user =
      profileResult.data ||
      {
        id:
          data.user.id,

        auth_user_id:
          data.user.id,

        username:
          data.user.user_metadata
            ?.username ||
          "",

        email:
          data.user.email ||
          ""
      };

    next();

  } catch (e) {
    console.error(
      "AUTH ERROR:",
      e
    );

    return res.status(401).json({
      error:
        "Kimlik doğrulaması başarısız."
    });
  }
}

/*
 * =========================================================
 * ME
 * =========================================================
 */

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

/*
 * =========================================================
 * UPDATE PROFILE
 * =========================================================
 */

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

      return res.json(
        safeUser(
          data
        )
      );

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Profil güncellenemedi."
      });
    }
  }
);

/*
 * =========================================================
 * SETTINGS
 * =========================================================
 */

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

      return res.json(
        next
      );

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Ayarlar kaydedilemedi."
      });
    }
  }
);

/*
 * =========================================================
 * FEED
 * =========================================================
 */

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

      return res.json(
        data || []
      );

    } catch (e) {
      return res.status(500).json({
        error:
          e?.message ||
          "Gönderiler alınamadı."
      });
    }
  }
);

/*
 * =========================================================
 * CREATE POST
 * =========================================================
 */

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

      if (
        req.file
      ) {
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
            .from(
              BUCKET
            )
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

        if (
          uploadError
        ) {
          throw uploadError;
        }

        const {
          data:
            publicData
        } =
          req.sb.storage
            .from(
              BUCKET
            )
            .getPublicUrl(
              objectPath
            );

        mediaUrl =
          publicData?.publicUrl ||
          null;

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

      return res.json({
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

      return res.status(400).json({
        error:
          e?.message ||
          "Gönderi oluşturulamadı."
      });
    }
  }
);

/*
 * =========================================================
 * STORIES CREATE
 * =========================================================
 */

app.post(
  "/api/stories",
  auth,
  upload.single("story"),
  async (req, res) => {
    try {
      if (
        !req.file
      ) {
        return res.status(400).json({
          error:
            "Dosya seçilmedi."
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
          .from(
            BUCKET
          )
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

      if (
        uploadError
      ) {
        throw uploadError;
      }

      const {
        data:
          publicData
      } =
        req.sb.storage
          .from(
            BUCKET
          )
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

      if (
        result.error
      ) {
        throw result.error;
      }

      return res.json(
        result.data
      );

    } catch (e) {
      console.error(
        "STORY ERROR:",
        e
      );

      return res.status(400).json({
        error:
          e?.message ||
          "Hikaye oluşturulamadı."
      });
    }
  }
);

/*
 * =========================================================
 * STORIES
 * =========================================================
 */

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
        throw error;
      }

      return res.json(
        data || []
      );

    } catch (e) {
      return res.status(500).json({
        error:
          e?.message ||
          "Hikayeler alınamadı."
      });
    }
  }
);

/*
 * =========================================================
 * LIKE
 * =========================================================
 */

app.post(
  "/api/posts/:id/like",
  auth,
  async (req, res) => {
    try {
      const postId =
        req.params.id;

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
            postId
          )
          .eq(
            "user_id",
            req.user.id
          )
          .maybeSingle();

      if (
        existing
      ) {
        await req.sb
          .from("post_likes")
          .delete()
          .eq(
            "post_id",
            postId
          )
          .eq(
            "user_id",
            req.user.id
          );

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
              postId,

            user_id:
              req.user.id
          });

      if (error) {
        throw error;
      }

      return res.json({
        liked:
          true
      });

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Beğeni işlemi başarısız."
      });
    }
  }
);

/*
 * =========================================================
 * COMMENTS
 * =========================================================
 */

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
            "Yorum boş olamaz."
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

      return res.json({
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
      return res.status(400).json({
        error:
          e?.message ||
          "Yorum gönderilemedi."
      });
    }
  }
);

/*
 * =========================================================
 * SAVE
 * =========================================================
 */

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

      if (
        existing
      ) {
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

      return res.json({
        saved:
          true
      });

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Kaydetme işlemi başarısız."
      });
    }
  }
);

/*
 * =========================================================
 * SAVED
 * =========================================================
 */

app.get(
  "/api/saved",
  auth,
  async (req, res) => {
    try {
      const {
        data,
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
        (data || [])
          .map(
            item =>
              item.post_id
          );

      if (
        !ids.length
      ) {
        return res.json([]);
      }

      const {
        data:
          posts,
        error:
          postError
      } =
        await req.sb
          .from("posts")
          .select("*")
          .in(
            "id",
            ids
          );

      if (
        postError
      ) {
        throw postError;
      }

      const ordered =
        (posts || [])
          .sort(
            (a, b) =>
              ids.indexOf(a.id) -
              ids.indexOf(b.id)
          );

      return res.json(
        ordered
      );

    } catch (e) {
      return res.status(500).json({
        error:
          e?.message ||
          "Kaydedilenler alınamadı."
      });
    }
  }
);

/*
 * =========================================================
 * FOLLOW
 * =========================================================
 */

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
            "Kullanıcı bulunamadı."
        });
      }

      if (
        target.id ===
        req.user.id
      ) {
        return res.status(400).json({
          error:
            "Kendini takip edemezsin."
        });
      }

      const {
        data:
          existing
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

      if (
        existing
      ) {
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

      return res.json({
        following:
          true
      });

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Takip işlemi başarısız."
      });
    }
  }
);

/*
 * =========================================================
 * USER POSTS
 * =========================================================
 */

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
            "Kullanıcı bulunamadı."
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

      return res.json(
        data || []
      );

    } catch (e) {
      return res.status(500).json({
        error:
          e?.message ||
          "Kullanıcı gönderileri alınamadı."
      });
    }
  }
);

/*
 * =========================================================
 * USER PROFILE
 * =========================================================
 */

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
            "Kullanıcı bulunamadı."
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

      return res.json({
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
      return res.status(500).json({
        error:
          e?.message ||
          "Profil alınamadı."
      });
    }
  }
);

/*
 * =========================================================
 * SEARCH
 * =========================================================
 */

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

      return res.json(
        (data || [])
          .map(
            safeUser
          )
      );

    } catch (e) {
      return res.status(500).json({
        error:
          e?.message ||
          "Arama yapılamadı."
      });
    }
  }
);

/*
 * =========================================================
 * MESSAGES
 * =========================================================
 */

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

      return res.json(
        (data || [])
          .map(
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
      return res.status(500).json({
        error:
          e?.message ||
          "Mesajlar alınamadı."
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
            "Kullanıcı bulunamadı."
        });
      }

      if (!text) {
        return res.status(400).json({
          error:
            "Mesaj boş olamaz."
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

      return res.json({
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
      return res.status(400).json({
        error:
          e?.message ||
          "Mesaj gönderilemedi."
      });
    }
  }
);

/*
 * =========================================================
 * NOTIFICATIONS
 * =========================================================
 */

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

      return res.json(
        (data || [])
          .map(
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
      return res.status(500).json({
        error:
          e?.message ||
          "Bildirimler alınamadı."
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

      return res.json({
        ok:
          true
      });

    } catch (e) {
      return res.status(400).json({
        error:
          e?.message ||
          "Bildirimler okunamadı."
      });
    }
  }
);

/*
 * =========================================================
 * MESAJ PAGE
 * =========================================================
 */

const publicDir =
  path.join(
    __dirname,
    "public"
  );

app.get(
  "/mesaj",
  (req, res) => {
    const file =
      path.join(
        publicDir,
        "mesaj.html"
      );

    if (
      fs.existsSync(
        file
      )
    ) {
      return res.sendFile(
        file
      );
    }

    return res.status(404).send(
      "mesaj.html bulunamadı."
    );
  }
);

/*
 * =========================================================
 * STATIC
 * =========================================================
 */

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

/*
 * =========================================================
 * ERROR HANDLER
 * =========================================================
 */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "EXPRESS ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    return res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Sunucu tarafında hata oluştu."
    });
  }
);

/*
 * =========================================================
 * FALLBACK
 * =========================================================
 */

app.use(
  (
    req,
    res
  ) => {
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

    return res.status(404).json({
      ok: false,
      error:
        "Minegram sayfası bulunamadı."
    });
  }
);

/*
 * =========================================================
 * LOCAL START
 * =========================================================
 *
 * Firebase deploy edildiğinde bu bölüm
 * çalıştırılmaz.
 *
 * Local:
 * node index.js
 *
 * =========================================================
 */

if (
  process.env.FUNCTIONS_EMULATOR === "true" ||
  process.env.LOCAL_SERVER === "true"
) {
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
        "======================================"
      );
    }
  );
}

/*
 * =========================================================
 * FIREBASE CLOUD FUNCTION
 * =========================================================
 *
 * EN ÖNEMLİ KISIM
 *
 * Firebase:
 * functions/index.js
 *
 * export edilen endpoint:
 *
 * api
 *
 * =========================================================
 */

export const api =
  onRequest(
    {
      region:
        "europe-west1",

      cors:
        true,

      memory:
        "512MiB",

      timeoutSeconds:
        120
    },
    app
  );
