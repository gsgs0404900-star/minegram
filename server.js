async function findUserByPhone(phone) {
  if (!SUPABASE_URL) {
    console.error("SUPABASE_URL EKSİK");
    return null;
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY EKSİK");
    return null;
  }

  const admin = createClient(
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

  const wanted = normalizeRecoveryPhone(phone);

  console.log("");
  console.log("======================================");
  console.log("MINEGRAM TELEFON HESAP ARAMA");
  console.log("Gelen telefon:", phone);
  console.log("Normalize telefon:", wanted);
  console.log("======================================");

  if (!wanted || wanted.length !== 10) {
    console.log("GEÇERSİZ TELEFON:", wanted);
    return null;
  }

  // =========================================================
  // 1) SUPABASE AUTH KULLANICILARINDA ARA
  // =========================================================

  try {
    for (let page = 1; page <= 20; page++) {
      const result = await admin.auth.admin.listUsers({
        page,
        perPage: 1000
      });

      const users = result?.data?.users || [];
      const error = result?.error;

      if (error) {
        console.error("AUTH KULLANICILARI ALINAMADI:", error);
        throw error;
      }

      console.log(`AUTH SAYFA ${page}: ${users.length} kullanıcı`);

      for (const user of users) {
        if (!user?.phone) continue;

        const normalizedUserPhone =
          normalizeRecoveryPhone(user.phone);

        console.log(
          "AUTH TELEFON KONTROL:",
          user.phone,
          "=>",
          normalizedUserPhone
        );

        if (normalizedUserPhone === wanted) {
          console.log("");
          console.log("######################################");
          console.log("TELEFON AUTH'TA BULUNDU!");
          console.log("AUTH ID:", user.id);
          console.log("EMAIL:", user.email);
          console.log("PHONE:", user.phone);
          console.log("######################################");
          console.log("");

          return user;
        }
      }

      if (users.length < 1000) {
        break;
      }
    }
  } catch (error) {
    console.error(
      "AUTH TELEFON ARAMA HATASI:",
      error?.message || error
    );
  }

  // =========================================================
  // 2) PROFILES TABLOSUNDA TELEFON ARA
  // =========================================================

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

  for (const column of possibleColumns) {
    try {
      const result = await admin
        .from("profiles")
        .select("*")
        .not(column, "is", null);

      const data = result?.data || [];
      const error = result?.error;

      if (error) {
        console.log(
          `PROFILES KOLONU KULLANILAMIYOR: ${column}`
        );
        continue;
      }

      console.log(
        `PROFILES ${column}: ${data.length} kayıt kontrol ediliyor`
      );

      for (const profile of data) {
        const profilePhone =
          normalizeRecoveryPhone(profile?.[column]);

        if (!profilePhone) continue;

        console.log(
          "PROFILE TELEFON:",
          profile[column],
          "=>",
          profilePhone
        );

        if (profilePhone !== wanted) continue;

        console.log("");
        console.log("######################################");
        console.log("TELEFON PROFILES'TA BULUNDU!");
        console.log("PROFILE ID:", profile.id);
        console.log(
          "AUTH USER ID:",
          profile.auth_user_id
        );
        console.log(
          "USERNAME:",
          profile.username
        );
        console.log(
          "PHONE COLUMN:",
          column
        );
        console.log(
          "PHONE:",
          profile[column]
        );
        console.log("######################################");
        console.log("");

        const possibleAuthIds = [
          profile.auth_user_id,
          profile.id
        ].filter(Boolean);

        for (const authId of possibleAuthIds) {
          try {
            const {
              data: authData,
              error: authError
            } = await admin.auth.admin.getUserById(authId);

            if (!authError && authData?.user) {
              console.log(
                "AUTH KULLANICISI BULUNDU:",
                authData.user.id
              );

              console.log(
                "AUTH EMAIL:",
                authData.user.email
              );

              return authData.user;
            }
          } catch (error) {
            console.log(
              "AUTH ID KONTROL HATASI:",
              authId,
              error?.message || error
            );
          }
        }
      }
    } catch (error) {
      console.log(
        `PROFILE TELEFON ARAMA HATASI [${column}]:`,
        error?.message || error
      );
    }
  }

  // =========================================================
  // 3) SONUÇ YOK
  // =========================================================

  console.log("");
  console.log("======================================");
  console.log("TELEFONLA HESAP BULUNAMADI");
  console.log("Gelen:", phone);
  console.log("Normalize:", wanted);
  console.log("======================================");
  console.log("");

  return null;
}

async function resolveRecoveryEmail(identifier, mode = "email") {
  const anon = client();
  const raw = String(identifier || "").trim();
  let email = raw;
  let profile = null;

  if (mode === "phone") {
    const authUser = await findUserByPhone(raw);

    if (!authUser?.email) {
      return null;
    }

    email = authUser.email;

    const { data } = await anon
      .from("profiles")
      .select("id,username,email,display_name")
      .eq("id", authUser.id)
      .maybeSingle();

    profile = data || null;

    return {
      email,
      profile,
      authUser
    };
  }

  if (!email.includes("@")) {
    profile = await findProfile(anon, email);

    if (!profile) {
      return null;
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return null;
    }

    const admin = createClient(
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

    const {
      data,
      error
    } = await admin.auth.admin.getUserById(profile.id);

    if (error || !data?.user?.email) {
      return null;
    }

    email = data.user.email;
  }

  if (!profile) {
    const { data } = await anon
      .from("profiles")
      .select("id,username,email,display_name")
      .eq("email", email)
      .maybeSingle();

    profile = data || null;
  }

  return {
    email,
    profile
  };
}
