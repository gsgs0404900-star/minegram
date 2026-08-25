import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "media";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL ve SUPABASE_PUBLISHABLE_KEY/.ANON_KEY tanımlı değil. .env dosyanı oluştur.");
  process.exit(1);
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function client(token = null) {
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  if (token) options.global = { headers: { Authorization: `Bearer ${token}` } };
  return createClient(SUPABASE_URL, SUPABASE_KEY, options);
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function auth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) throw new Error("Oturum gerekli");
    const sb = client(token);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) throw error || new Error("Oturum gerekli");
    const { data: profile, error: pError } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (pError || !profile) throw pError || new Error("Profil bulunamadı");
    req.token = token;
    req.sb = sb;
    req.authUser = user;
    req.user = profile;
    next();
  } catch (e) {
    res.status(401).json({ error: "Oturum gerekli" });
  }
}

function safeUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name ?? u.displayName ?? u.username,
    bio: u.bio || "",
    avatar: u.avatar_url ?? u.avatar ?? null,
    verified: !!u.verified,
    settings: u.settings || {}
  };
}

function normalizeUsername(x) {
  return String(x || "").trim().replace(/^@/, "").toLowerCase();
}

async function findProfile(sb, username) {
  const q = normalizeUsername(username);
  const { data, error } = await sb.from("profiles").select("*").eq("username", q).maybeSingle();
  if (error) throw error;
  return data;
}

async function addNotification({ userId, type, fromUserId, postId = null, text }) {
  if (userId === fromUserId) return;
  if (!SUPABASE_SERVICE_ROLE_KEY) return;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await admin.from("notifications").insert({ user_id: userId, type, from_user_id: fromUserId, post_id: postId, text });
}

async function hydratePosts(sb, posts, userId) {
  if (!posts.length) return [];
  const userIds = [...new Set(posts.map(p => p.user_id))];
  const postIds = posts.map(p => p.id);
  const [{ data: profiles }, { data: likes }, { data: comments }, { data: saves }] = await Promise.all([
    sb.from("profiles").select("id,username,display_name,bio,avatar_url,verified").in("id", userIds),
    sb.from("post_likes").select("post_id,user_id").in("post_id", postIds),
    sb.from("comments").select("id,post_id,user_id,text,created_at,profiles(username,display_name)").in("post_id", postIds).order("created_at", { ascending: true }),
    sb.from("saves").select("post_id,user_id").eq("user_id", userId).in("post_id", postIds)
  ]);
  const pmap = new Map((profiles || []).map(p => [p.id, p]));
  const likeMap = new Map();
  for (const l of likes || []) likeMap.set(l.post_id, (likeMap.get(l.post_id) || 0) + 1);
  const liked = new Set((likes || []).filter(x => x.user_id === userId).map(x => x.post_id));
  const saved = new Set((saves || []).map(x => x.post_id));
  const commentsMap = new Map();
  for (const c of comments || []) {
    if (!commentsMap.has(c.post_id)) commentsMap.set(c.post_id, []);
    commentsMap.get(c.post_id).push({ id: c.id, userId: c.user_id, text: c.text, createdAt: c.created_at, username: c.profiles?.username || "" });
  }
  return posts.map(p => ({
    id: p.id, userId: p.user_id, caption: p.caption, media: p.media_url, mediaName: p.media_name, mediaType: p.media_type,
    createdAt: p.created_at, likes: Array(likeMap.get(p.id) || 0).fill(null), comments: commentsMap.get(p.id) || [],
    likedByMe: liked.has(p.id), savedByMe: saved.has(p.id), user: safeUser(pmap.get(p.user_id) || { id: p.user_id, username: "user" })
  }));
}

app.post("/api/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || username).trim().slice(0, 80);
    if (!username || !email || password.length < 6) return res.status(400).json({ error: "Kullanıcı adı, e-posta ve en az 6 karakterlik şifre gerekli." });
    if (!/^[a-z0-9._]{3,30}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-30 karakter olmalı; harf, sayı, nokta ve alt çizgi kullan." });
    const anon = client();
    const { data: existing } = await anon.from("profiles").select("id").eq("username", username).maybeSingle();
    if (existing) return res.status(409).json({ error: "Bu kullanıcı adı zaten alınmış." });
    const { data, error } = await anon.auth.signUp({ email, password, options: { data: { username, display_name: displayName } } });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.user) return res.status(400).json({ error: "Kullanıcı oluşturulamadı." });

    // Profil oluşturmayı SQL trigger'ına bırakma; Service Role ile sunucu tarafında garanti et.
    if (SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { error: profileError } = await admin.from("profiles").upsert({
        id: data.user.id,
        username,
        display_name: displayName,
        bio: "",
        avatar_url: null,
        verified: false,
        settings: {}
      }, { onConflict: "id" });
      if (profileError) return res.status(500).json({ error: `Profil oluşturulamadı: ${profileError.message}` });
    }

    // E-posta doğrulaması açıksa Supabase session döndürmeyebilir.
    if (!data.session) {
      return res.json({
        needsConfirmation: true,
        message: "Kayıt tamamlandı. E-posta adresini doğrula, ardından giriş yap.",
        user: { id: data.user.id, email: data.user.email, username }
      });
    }

    const sb = client(data.session.access_token);
    let { data: profile, error: pError } = await sb.from("profiles").select("*").eq("id", data.user.id).single();

    if ((pError || !profile) && SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const result = await admin.from("profiles").select("*").eq("id", data.user.id).single();
      profile = result.data;
      pError = result.error;
    }
    if (pError || !profile) return res.status(500).json({ error: "Profil oluşturulamadı." });
    res.json({ token: data.session.access_token, user: safeUser(profile) });
  } catch (e) { res.status(500).json({ error: e.message || "Kayıt başarısız" }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!identifier || !password) return res.status(400).json({ error: "Kullanıcı adı/e-posta ve şifre gerekli." });
    const anon = client();
    let email = identifier.toLowerCase();
    if (!identifier.includes("@")) {
      const profile = await findProfile(anon, identifier);
      if (!profile) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
      if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Kullanıcı adıyla giriş için .env dosyasına SUPABASE_SERVICE_ROLE_KEY eklenmeli." });
      }
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: authUser, error: authError } = await admin.auth.admin.getUserById(profile.id);
      if (authError || !authUser?.user?.email) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
      email = authUser.user.email;
    }
    const { data, error } = await anon.auth.signInWithPassword({
      email: String(email).trim().toLowerCase(),
      password
    });

    if (error || !data?.session) {
      const msg = error?.message || "Giriş başarısız.";
      if (/email not confirmed/i.test(msg)) {
        return res.status(403).json({
          error: "E-posta adresin henüz doğrulanmamış. Supabase doğrulama e-postasındaki bağlantıyı aç."
        });
      }
      if (/invalid login credentials/i.test(msg)) {
        return res.status(401).json({
          error: "E-posta/kullanıcı adı veya şifre hatalı. Şifreni Reset Password ile yeniden belirleyebilirsin."
        });
      }
      return res.status(401).json({ error: msg });
    }
    const sb = client(data.session.access_token);
    const { data: profile, error: pError } = await sb.from("profiles").select("*").eq("id", data.user.id).single();
    if (pError) return res.status(500).json({ error: "Profil bulunamadı." });
    res.json({ token: data.session.access_token, user: safeUser(profile) });
  } catch (e) { res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." }); }
});

app.post("/api/forgot", async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim();
    const anon = client();
    let email = identifier;
    if (!identifier.includes("@")) {
      if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(200).json({ ok: true });
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const profile = await findProfile(anon, identifier);
      if (!profile) return res.status(200).json({ ok: true });
      const { data, error } = await admin.auth.admin.getUserById(profile.id);
      if (error || !data?.user?.email) return res.status(200).json({ ok: true });
      email = data.user.email;
    }
    const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo: `${req.protocol}://${req.get("host")}/` });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.get("/api/me", auth, (req, res) => res.json(safeUser(req.user)));

app.get("/api/feed", auth, async (req, res) => {
  try {
    const { data, error } = await req.sb.from("posts").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json(await hydratePosts(req.sb, data || [], req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/posts", auth, upload.single("media"), async (req, res) => {
  try {
    let mediaUrl = null;
    let mediaName = null;
    let mediaType = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
      const objectPath = `${req.user.id}/${crypto.randomUUID()}${ext}`;
      const { error: uploadError } = await req.sb.storage.from(BUCKET).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) throw uploadError;
      const { data: publicData } = req.sb.storage.from(BUCKET).getPublicUrl(objectPath);
      mediaUrl = publicData.publicUrl;
      mediaName = req.file.originalname;
      mediaType = req.file.mimetype;
    }
    const { data, error } = await req.sb.from("posts").insert({ user_id: req.user.id, caption: req.body?.caption || "", media_url: mediaUrl, media_name: mediaName, media_type: mediaType }).select("*").single();
    if (error) throw error;
    res.json({ ...data, id: data.id, userId: data.user_id, media: data.media_url, mediaName: data.media_name, createdAt: data.created_at });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/posts/:id/like", auth, async (req, res) => {
  try {
    const { data: existing } = await req.sb.from("post_likes").select("post_id").eq("post_id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (existing) {
      await req.sb.from("post_likes").delete().eq("post_id", req.params.id).eq("user_id", req.user.id);
      return res.json({ liked: false });
    }
    const { error } = await req.sb.from("post_likes").insert({ post_id: req.params.id, user_id: req.user.id });
    if (error) throw error;
    const { data: post } = await req.sb.from("posts").select("user_id").eq("id", req.params.id).single();
    if (post) await addNotification({ userId: post.user_id, fromUserId: req.user.id, type: "like", postId: req.params.id, text: `@${req.user.username} beğendi` });
    res.json({ liked: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/posts/:id/comments", auth, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Yorum boş olamaz" });
    const { data, error } = await req.sb.from("comments").insert({ post_id: req.params.id, user_id: req.user.id, text }).select("*").single();
    if (error) throw error;
    const { data: post } = await req.sb.from("posts").select("user_id").eq("id", req.params.id).single();
    if (post) await addNotification({ userId: post.user_id, fromUserId: req.user.id, type: "comment", postId: req.params.id, text: `@${req.user.username} yorum yaptı` });
    res.json({ id: data.id, userId: data.user_id, text: data.text, createdAt: data.created_at, username: req.user.username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/posts/:id/save", auth, async (req, res) => {
  try {
    const { data: existing } = await req.sb.from("saves").select("post_id").eq("post_id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (existing) { await req.sb.from("saves").delete().eq("post_id", req.params.id).eq("user_id", req.user.id); return res.json({ saved: false }); }
    const { error } = await req.sb.from("saves").insert({ post_id: req.params.id, user_id: req.user.id });
    if (error) throw error;
    res.json({ saved: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/saved", auth, async (req, res) => {
  try {
    const { data: saves, error } = await req.sb.from("saves").select("post_id,created_at").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    const ids = (saves || []).map(x => x.post_id);
    if (!ids.length) return res.json([]);
    const { data: posts, error: pError } = await req.sb.from("posts").select("*").in("id", ids);
    if (pError) throw pError;
    const hydrated = await hydratePosts(req.sb, posts || [], req.user.id);
    res.json(hydrated.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/notifications", auth, async (req, res) => {
  try {
    const { data, error } = await req.sb.from("notifications").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data || []).map(n => ({ id:n.id, type:n.type, text:n.text, read:n.read, createdAt:n.created_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/notifications/read", auth, async (req, res) => {
  try { await req.sb.from("notifications").update({ read:true }).eq("user_id", req.user.id); res.json({ok:true}); }
  catch(e){ res.status(400).json({error:e.message}); }
});

app.post("/api/users/:username/follow", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    if (target.id === req.user.id) return res.status(400).json({ error: "Kendini takip edemezsin" });
    const { data: existing } = await req.sb.from("follows").select("follower_id,following_id").eq("follower_id", req.user.id).eq("following_id", target.id).maybeSingle();
    if (existing) { await req.sb.from("follows").delete().eq("follower_id", req.user.id).eq("following_id", target.id); return res.json({ following:false }); }
    const { error } = await req.sb.from("follows").insert({ follower_id:req.user.id, following_id:target.id });
    if (error) throw error;
    await addNotification({ userId:target.id, fromUserId:req.user.id, type:"follow", text:`@${req.user.username} seni takip etti` });
    res.json({ following:true });
  } catch(e){ res.status(400).json({error:e.message}); }
});

app.get("/api/users/:username/posts", auth, async (req, res) => {
  try {
    const target = await findProfile(req.sb, req.params.username);
    if (!target) return res.status(404).json({error:"Kullanıcı bulunamadı"});
    const { data, error } = await req.sb.from("posts").select("*").eq("user_id", target.id).order("created_at", { ascending:false });
    if(error) throw error;
    res.json(await hydratePosts(req.sb, data || [], req.user.id));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/users/:username", auth, async (req,res)=>{
  try{
    const target = await findProfile(req.sb, req.params.username);
    if(!target) return res.status(404).json({error:"Kullanıcı bulunamadı"});
    const [{ count:postCount }, { count:followers }, { count:following }, { data:followingByMe }] = await Promise.all([
      req.sb.from("posts").select("id", {count:"exact", head:true}).eq("user_id", target.id),
      req.sb.from("follows").select("follower_id", {count:"exact", head:true}).eq("following_id", target.id),
      req.sb.from("follows").select("following_id", {count:"exact", head:true}).eq("follower_id", target.id),
      req.sb.from("follows").select("follower_id").eq("follower_id", req.user.id).eq("following_id", target.id).maybeSingle()
    ]);
    res.json({...safeUser(target), postCount:postCount||0, followers:followers||0, following:following||0, followingByMe:!!followingByMe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/search", auth, async (req,res)=>{
  try{
    const q=String(req.query.q||"").trim().toLowerCase();
    if(!q) return res.json([]);
    const {data,error}=await req.sb.from("profiles").select("id,username,display_name,bio,avatar_url,verified").or(`username.ilike.%${q}%,display_name.ilike.%${q}%`).limit(20);
    if(error) throw error; res.json((data||[]).map(safeUser));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/messages", auth, async (req,res)=>{
  try{
    const {data,error}=await req.sb.from("messages").select("*,profiles:sender_id(username,display_name)").or(`sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`).order("created_at",{ascending:true});
    if(error) throw error;
    res.json((data||[]).map(m=>({id:m.id,from:m.sender_id,to:m.recipient_id,text:m.text,createdAt:m.created_at,username:m.profiles?.username||""})));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/messages", auth, async (req,res)=>{
  try{
    const target=await findProfile(req.sb,req.body?.to);
    const text=String(req.body?.text||"").trim();
    if(!target)return res.status(404).json({error:"Kullanıcı bulunamadı"});
    if(!text)return res.status(400).json({error:"Mesaj boş olamaz"});
    const {data,error}=await req.sb.from("messages").insert({sender_id:req.user.id,recipient_id:target.id,text}).select("*").single();
    if(error) throw error;
    res.json({id:data.id,from:data.sender_id,to:data.recipient_id,text:data.text,createdAt:data.created_at});
  }catch(e){res.status(400).json({error:e.message});}
});

app.patch("/api/me", auth, async (req,res)=>{
  try{
    const patch={};
    if(req.body?.displayName!==undefined) patch.display_name=String(req.body.displayName).slice(0,80);
    if(req.body?.bio!==undefined) patch.bio=String(req.body.bio).slice(0,300);
    if(Object.keys(patch).length){ const {error}=await req.sb.from("profiles").update(patch).eq("id",req.user.id); if(error) throw error; }
    const {data,error}=await req.sb.from("profiles").select("*").eq("id",req.user.id).single(); if(error) throw error;
    res.json(safeUser(data));
  }catch(e){res.status(400).json({error:e.message});}
});

app.patch("/api/settings", auth, async (req,res)=>{
  try{
    const next={...(req.user.settings||{}),...(req.body||{})};
    const {error}=await req.sb.from("profiles").update({settings:next}).eq("id",req.user.id); if(error) throw error;
    res.json(next);
  }catch(e){res.status(400).json({error:e.message});}
});

app.use((req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Minegram: http://localhost:${PORT}`));
