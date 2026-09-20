/* Minegram Site Maintenance Mode
   Add this script to the public site pages (after Firebase config is available).
   It reads settings/config and displays a full-screen maintenance notice when enabled.
*/
(() => {
  const config = {
    apiKey: "AIzaSyCabJgEl6jhE_ucVBhA69LLQSCJ9qUuwXo",
    authDomain: "mim-ea133.firebaseapp.com",
    projectId: "mim-ea133",
    storageBucket: "mim-ea133.firebasestorage.app",
    messagingSenderId: "303525353436",
    appId: "1:303525353436:web:082fc090b5025e19942119"
  };
  const load = async () => {
    try {
      const [{ initializeApp }, { getFirestore, doc, getDoc }] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js")
      ]);
      const app = initializeApp(config, "minegram-maintenance-" + Math.random().toString(36).slice(2));
      const db = getFirestore(app);
      const snap = await getDoc(doc(db, "settings", "config"));
      if (!snap.exists() || snap.data().maintenanceMode !== true) return;
      const data = snap.data() || {};
      const title = data.maintenanceTitle || "SİTEMİZ BAKIMDADIR";
      const message = data.maintenanceMessage || "Minegram kullanıcıları, size yaşattığımız sorun için özür dileriz.";
      const style = document.createElement("style");
      style.textContent = `
        #minegram-maintenance-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box;background:radial-gradient(circle at top,#25304a 0%,#0b1020 45%,#03050a 100%);color:#fff;font-family:Arial,Helvetica,sans-serif;text-align:center}
        #minegram-maintenance-overlay .maintenance-card{width:min(900px,94vw);padding:58px 34px;border:1px solid rgba(255,255,255,.15);border-radius:28px;background:rgba(15,20,35,.94);box-shadow:0 30px 100px rgba(0,0,0,.55);backdrop-filter:blur(10px)}
        #minegram-maintenance-overlay .maintenance-icon{font-size:72px;margin-bottom:18px}
        #minegram-maintenance-overlay h1{font-size:clamp(34px,6vw,68px);line-height:1.05;margin:0 0 24px;font-weight:900;letter-spacing:-1.5px}
        #minegram-maintenance-overlay p{font-size:clamp(18px,2.5vw,28px);line-height:1.55;margin:0 auto;max-width:760px;color:#e9edf7;font-weight:600}
        #minegram-maintenance-overlay .maintenance-brand{margin-top:30px;font-size:18px;color:#aeb8cc;font-weight:800;letter-spacing:2px}
      `;
      document.head.appendChild(style);
      const overlay = document.createElement("div");
      overlay.id = "minegram-maintenance-overlay";
      overlay.innerHTML = `<div class="maintenance-card"><div class="maintenance-icon">🛠️</div><h1></h1><p></p><div class="maintenance-brand">MINEGRAM</div></div>`;
      overlay.querySelector("h1").textContent = title;
      overlay.querySelector("p").textContent = message;
      document.body.appendChild(overlay);
      document.documentElement.style.overflow = "hidden";
    } catch (error) {
      console.warn("Minegram bakım modu kontrolü yapılamadı:", error);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true }); else load();
})();
