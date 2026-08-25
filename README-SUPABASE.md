# Minegram + Supabase

Bu sürüm Minegram'ı Supabase Auth + Postgres + Storage ile çalıştırır. Veriler artık yerel JSON dosyalarında tutulmaz.

## 1) Supabase projesi
1. Supabase'te yeni bir proje oluştur.
2. **Authentication → Providers → Email** bölümünde Email provider'ı açık bırak.
3. **Authentication → URL Configuration** bölümünde Local development için `http://localhost:3000` kullan.
4. SQL Editor'ı açıp `supabase-schema.sql` dosyasının tamamını çalıştır.

Supabase dokümanlarına göre Auth oturumları ve RLS birlikte çalışır; tablolar için RLS kullanmak gerekir.

## 2) Anahtarları ayarla
Proje kökünde `.env` oluştur:

```env
PORT=3000
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

**Service role key sadece Node.js sunucusunda kalmalı. `public/` içine veya tarayıcı JavaScript'ine koyma.**

## 3) Kurulum

```powershell
npm install
npm start
```

Sonra `http://localhost:3000` aç.

## 4) Kayıt
Kayıt ekranında kullanıcı adı + e-posta + şifre gir. Email confirmation açık ise Supabase doğrulama e-postası gönderir; doğrulama tamamlandıktan sonra giriş yapılır.

## Bağlanan özellikler
- Supabase Auth ile kayıt/giriş
- Kullanıcı profilleri
- Gönderiler
- Fotoğraf/video Storage
- Beğeniler
- Yorumlar
- Kaydedilenler
- Takip/takipten çıkma
- Bildirimler
- Arama
- Mesajlar
- Profil düzenleme
- Ayarlar
- Şifre sıfırlama

Bu paket `SUPABASE_SERVICE_ROLE_KEY` gerektirir çünkü kullanıcı adıyla girişte Supabase Auth kullanıcısının e-posta adresini sunucu tarafında çözmek ve bildirimleri güvenli biçimde oluşturmak için server-only admin API kullanılır. Bu anahtar asla istemciye gönderilmez.


## Kullanıcı adıyla giriş

Minegram giriş kutusu artık e-posta veya kullanıcı adı kabul eder. Kullanıcı adıyla girişte Supabase Auth kullanıcısının e-postasını sunucu tarafında çözmek için **Secret/Service Role Key** gerekir. Bu anahtar tarayıcıya gönderilmez.

`.env` içine kendi Supabase Dashboard > Project Settings > API bölümündeki **Secret key** (veya eski arayüzde service_role) değerini ekleyin:

```env
SUPABASE_SERVICE_ROLE_KEY=BURAYA_GIZLI_ANAHTAR
```

Ardından sunucuyu yeniden başlatın:

```powershell
npm start
```

E-posta ile giriş Secret/Service Role Key olmadan da çalışır. Supabase'te e-posta doğrulaması açıksa kayıt sonrası gelen doğrulama bağlantısı açılmalıdır.
