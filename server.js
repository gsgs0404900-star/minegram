import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;

function env(name) {
  const value = process.env[name];
  if (value == null) return "";
  return String(value).trim().replace(/^([\"'])|([\"'])$/g, "");
}

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_KEY = env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CONFIG_OK = Boolean(SUPABASE_URL && SUPABASE_KEY && SUPABASE_SERVICE_ROLE_KEY);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
void upload;

function anonClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase yapılandırması eksik.");
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function adminClient() {
  if (!CONFIG_OK) throw new Error("Supabase ortam değişkenleri eksik.");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function safeProfile(profile) {
  return {
    id: profile.id,
    authUserId: profile.auth_user_id,
    username: profile.username,
    displayName: profile.display_name || profile.username,
    bio: profile.bio || "",
    avatar: profile.avatar_url || null,
    verified: Boolean(profile.verified),
    settings: profile.settings || {}
  };
}

async function findAuthUserByEmail(admin, email) {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const user = (data?.users || []).find(
      (candidate) => String(candidate.email || "").toLowerCase() === target
    );

    if (user) return user;
    if (!data?.users || data.users.length < perPage) return null;
    page += 1;
  }
}

async function profileByUsername(admin, username) {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function profileByOwnerAndUsername(admin, authUserId, username) {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/*
 * Multi-profile registration:
 *
 * - A new email creates one Supabase Auth user and its first Minegram profile.
 * - An existing email is NOT rejected. The password is verified against the
 *   existing Auth user, then a new independent profiles row is created.
 * - profiles.id is a new UUID; profiles.auth_user_id points to auth.users.id.
 */
app.post("/api/login", async (req, res) => {
  try {
    if (!CONFIG_OK) return res.status(500).json({ error: "Supabase ortam değişkenleri eksik." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const requestedUsername = normalizeUsername(req.body?.username || req.body?.profileUsername || "");
    if (!email || !password) return res.status(400).json({ error: "E-posta ve şifre gerekli." });
    const auth = anonClient();
    const { data: loginData, error: loginError } = await auth.auth.signInWithPassword({ email, password });
    if (loginError || !loginData?.user || !loginData?.session) return res.status(401).json({ error: loginError?.message || "E-posta veya şifre hatalı." });
    const admin = adminClient();
    const { data: profiles, error: profilesError } = await admin.from("profiles").select("*").eq("auth_user_id", loginData.user.id).order("created_at", { ascending: true });
    if (profilesError) return res.status(500).json({ error: profilesError.message });
    const safeProfiles = (profiles || []).map(safeProfile);
    if (!safeProfiles.length) return res.status(404).json({ error: "Bu kullanıcı için Minegram profili bulunamadı." });
    let selectedProfile = safeProfiles[0];
    if (requestedUsername) {
      const found = safeProfiles.find(profile => profile.username === requestedUsername);
      if (!found) return res.status(404).json({ error: "Bu kullanıcı adına ait Minegram profili bulunamadı." });
      selectedProfile = found;
    }
    return res.json({ ok: true, multipleProfiles: safeProfiles.length > 1, profiles: safeProfiles, profile: selectedProfile, user: { authUserId: loginData.user.id, email: loginData.user.email, accessToken: loginData.session.access_token, refreshToken: loginData.session.refresh_token } });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ error: error?.message || "Giriş başarısız." });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    if (!CONFIG_OK) {
      return res.status(500).json({ error: "Supabase ortam değişkenleri eksik." });
    }

    const username = normalizeUsername(req.body?.username);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || username).trim().slice(0, 80);

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

    const admin = adminClient();

    // Username is globally unique across Minegram profiles.
    const existingProfile = await profileByUsername(admin, username);
    if (existingProfile) {
      return res.status(409).json({ error: "Bu kullanıcı adı zaten alınmış." });
    }

    let authUser = await findAuthUserByEmail(admin, email);
    let createdAuthUser = false;

    if (!authUser) {
      // First profile for this email. The DB trigger may create the first
      // profile automatically; we reuse it instead of creating a duplicate.
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          username,
          display_name: displayName
        }
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      authUser = data?.user || null;
      createdAuthUser = true;
    } else {
      // Existing email: prove that the person knows the Auth password before
      // allowing a new Minegram profile to be attached to the same email.
      const auth = anonClient();
      const { data, error } = await auth.auth.signInWithPassword({
        email,
        password
      });

      if (error || !data?.user) {
        return res.status(401).json({
          error: "Bu e-posta zaten kayıtlı. Yeni profil oluşturmak için mevcut hesabın şifresini doğru gir."
        });
      }

      authUser = data.user;
    }

    if (!authUser?.id) {
      return res.status(500).json({ error: "Auth kullanıcısı oluşturulamadı." });
    }

    // If the trigger already created exactly this requested first profile,
    // reuse it. Otherwise create a new profile for the same Auth user.
    let profile = await profileByOwnerAndUsername(admin, authUser.id, username);

    if (!profile) {
      const { data, error } = await admin
        .from("profiles")
        .insert({
          id: cryptoRandomUuid(),
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

      if (error) {
        // If this was a newly-created Auth user, do not leave a half-created
        // account behind when the requested profile cannot be inserted.
        if (createdAuthUser) {
          await admin.auth.admin.deleteUser(authUser.id).catch(() => {});
        }
        return res.status(500).json({
          error: `Profil oluşturulamadı: ${error.message}`
        });
      }

      profile = data;
    }

    return res.json({
      needsConfirmation: !authUser.email_confirmed_at,
      multipleProfiles: true,
      message: authUser.email_confirmed_at
        ? "Yeni Minegram profilin oluşturuldu."
        : "Profil oluşturuldu. E-posta doğrulaması gerekiyorsa doğrulama bağlantısını aç.",
      user: {
        id: profile.id,
        authUserId: authUser.id,
        email: authUser.email,
        username: profile.username,
        profile: safeProfile(profile)
      }
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({
      error: error?.message || "Kayıt başarısız."
    });
  }
});

function cryptoRandomUuid() {
  // crypto.randomUUID is available in Node 24, but keeping this isolated makes
  // the intent explicit and avoids importing the whole crypto namespace.
  return globalThis.crypto?.randomUUID?.() || fallbackUuid();
}

function fallbackUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, multiProfile: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Minegram server running on port ${PORT}`);
});
