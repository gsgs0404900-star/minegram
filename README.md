# Minegram — çalışan full-stack sürüm

## Özellikler
- Gerçek kayıt ve giriş
- JWT oturumu
- Şifrelerin bcrypt ile hashlenmesi
- SQLite yerine taşınabilir JSON veri deposu
- Fotoğraf/video yükleme
- Gönderi oluşturma
- Feed
- Beğeni
- Yorum
- Kullanıcı arama
- Profil ve profil düzenleme
- Mesaj gönderme
- Ayarlar/menü
- Minegram ekran görüntülerine yakın siyah/mavi arayüz

## Kurulum

Node.js 18+ gerekir.

```bash
npm install
npm start
```

Sonra:
http://localhost:3000

## Önemli
Bu sürüm gerçek çalışan bir web uygulaması/prototipidir ancak üretime çıkmadan önce:
- PostgreSQL/Supabase gibi gerçek veritabanı
- S3/Supabase Storage gibi medya depolama
- HTTPS
- güçlü JWT secret
- rate limiting
- e-posta/telefon doğrulama
- içerik moderasyonu
- CSRF/CORS politikaları
- gerçek şifre sıfırlama e-postası
eklenmelidir.

Veriler `data/`, yüklenen medya `uploads/` altında tutulur.
