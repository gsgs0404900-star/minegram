app.post("/api/register", async (req, res) => {
  try {
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

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "Render Environment Variables içine SUPABASE_SERVICE_ROLE_KEY eklenmeli."
      });
    }

    const anon = client();
    const admin = await adminClient();

    // Kullanıcı adı benzersiz olmalı
    const { data: existingProfile, error: usernameError } =
      await admin
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();

    if (usernameError) {
      return res.status(500).json({
        error: usernameError.message
      });
    }

    if (existingProfile) {
      return res.status(409).json({
        error: "Bu kullanıcı adı zaten alınmış."
      });
    }

    // YENİ HESAP OLUŞTUR
    // email_confirm: true sayesinde doğrulama beklemeden giriş yapılabilir.
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        display_name: displayName
      }
    });

    // Aynı e-posta zaten kayıtlıysa yeni hesap açma.
    // Fakat başka e-posta adresleriyle sınırsız yeni hesap oluşturulabilir.
    if (error) {
      if (
        /already registered|already exists|user already registered|email_exists/i
          .test(error.message || "")
      ) {
        return res.status(409).json({
          error: "Bu e-posta adresi zaten kayıtlı. Farklı bir e-posta adresi kullan."
        });
      }

      return res.status(400).json({
        error: error.message
      });
    }

    if (!data?.user?.id) {
      return res.status(400).json({
        error: "Kullanıcı oluşturulamadı."
      });
    }

    // Profil oluştur
    const { error: profileError } = await admin
      .from("profiles")
      .insert({
        id: data.user.id,
        username,
        display_name: displayName,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      });

    if (profileError) {
      // Profil oluşturulamazsa Auth kullanıcısını da temizle.
      try {
        await admin.auth.admin.deleteUser(data.user.id);
      } catch {}

      return res.status(500).json({
        error: `Profil oluşturulamadı: ${profileError.message}`
      });
    }

    // Yeni hesapla otomatik giriş yap
    const loginResult = await anon.auth.signInWithPassword({
      email,
      password
    });

    if (loginResult.error || !loginResult.data?.session) {
      return res.status(500).json({
        error:
          loginResult.error?.message ||
          "Kayıt tamamlandı fakat oturum açılamadı."
      });
    }

    const {
      data: profile,
      error: profileReadError
    } = await admin
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    if (profileReadError || !profile) {
      return res.status(500).json({
        error: "Profil oluşturuldu fakat okunamadı."
      });
    }

    return res.json({
      ok: true,
      token: loginResult.data.session.access_token,
      needsConfirmation: false,
      message: "Kayıt başarılı.",
      user: safeUser(profile)
    });

  } catch (e) {
    console.error("REGISTER ERROR:", e);

    return res.status(500).json({
      error: e.message || "Kayıt başarısız"
    });
  }
});
