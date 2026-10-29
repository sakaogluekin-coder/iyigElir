const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_KEY || "";
const FILE = path.join(__dirname, "data.json");
const PAGE = path.join(__dirname, "index.html");

const BAD = new Set(["amk", "aq", "orospu", "piç", "pic", "siktir", "sikerim", "yarrak", "amına", "amina", "ananı", "anasını", "oç", "göt", "götveren", "gavat", "puşt", "ibne", "sürtük"]);
const HELP = /intihar|ölmek istiyorum|kendimi öldür|yaşamak istemiyorum|kendime zarar|bitirmek istiyorum/;

process.on("uncaughtException", e => console.error("Hata:", e.message));
process.on("unhandledRejection", e => console.error("Hata:", e && e.message));

let db = { posts: [], tips: [], likes: [] };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}

let page = "<p>Sayfa yükleniyor, birkaç saniye sonra yenileyin.</p>";
try { page = fs.readFileSync(PAGE, "utf8"); } catch (e) {}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(db), () => {}), 300);
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now);
  hits.set(ip, a);
  return a.length > 30;
}

function readBody(req) {
  return new Promise((ok, no) => {
    let s = "";
    req.on("data", c => {
      s += c;
      if (s.length > 10000) { no(new Error("big")); req.destroy(); }
    });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { no(e); } });
    req.on("error", no);
  });
}

const newId = () => crypto.randomBytes(6).toString("hex");
const clean = (s, n) => String(s || "").trim().slice(0, n);
const low = s => String(s || "").toLocaleLowerCase("tr");
const bad = s => low(s).split(/[^a-zçğıöşü0-9]+/).some(w => BAD.has(w));

function send(res, code, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function isAdmin(req) {
  return ADMIN !== "" && req.headers["x-admin"] === ADMIN;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ip = req.socket.remoteAddress;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "http";
  try {
    if (u.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: " + proto + "://" + host + "/sitemap.xml\n");
    }

    if (u.pathname === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + proto + "://" + host + "/</loc></url></urlset>\n");
    }

    if (req.method === "GET" && u.pathname === "/api/data") {
      const me = clean(u.searchParams.get("u"), 40);
      const adm = isAdmin(req);
      const posts = db.posts.map(p => ({
        id: p.id, mood: p.mood, text: p.text, ts: p.ts,
        nick: p.anon ? "" : p.nick, anon: p.anon,
        own: adm || (me !== "" && p.uid === me)
      }));
      const tips = db.tips.map(t => ({
        id: t.id, postId: t.postId, mood: t.mood, cat: t.cat, text: t.text,
        nick: t.nick, ts: t.ts,
        likes: db.likes.filter(l => l.tipId === t.id).length,
        liked: db.likes.some(l => l.tipId === t.id && l.uid === me),
        own: adm || (me !== "" && t.uid === me)
      }));
      return send(res, 200, { posts, tips });
    }

    if (req.method === "POST" && u.pathname.startsWith("/api/")) {
      if (limited(ip)) return send(res, 429, { error: "Çok hızlı gidiyorsun, biraz bekle." });
      const b = await readBody(req);
      const me = clean(b.u, 40);
      if (me.length < 8) return send(res, 400, { error: "Kimlik yok, sayfayı yenile." });

      if (u.pathname === "/api/post") {
        const text = clean(b.text, 500);
        const mood = clean(b.mood, 20);
        if (!mood || !text) return send(res, 400, { error: "Duygu seç ve bir şeyler yaz." });
        if (bad(text) || bad(b.nick)) return send(res, 400, { error: "Lütfen kibar bir dil kullan." });
        if (db.posts.length > 5000) return send(res, 507, { error: "Site şu an dolu." });
        db.posts.push({ id: newId(), mood, text, nick: clean(b.nick, 20), anon: !!b.anon, uid: me, ts: Date.now() });
        save();
        return send(res, 200, { ok: true, help: HELP.test(low(text)) });
      }

      if (u.pathname === "/api/tip") {
        const post = db.posts.find(p => p.id === b.postId);
        const text = clean(b.text, 200);
        if (!post) return send(res, 400, { error: "Paylaşım bulunamadı." });
        if (!text) return send(res, 400, { error: "Bir öneri yaz." });
        if (bad(text) || bad(b.nick)) return send(res, 400, { error: "Lütfen kibar bir dil kullan." });
        db.tips.push({ id: newId(), postId: post.id, mood: post.mood, cat: clean(b.cat, 8) || "💬", text, nick: clean(b.nick, 20), uid: me, ts: Date.now() });
        save();
        return send(res, 200, { ok: true });
      }

      if (u.pathname === "/api/like") {
        const t = db.tips.find(x => x.id === b.tipId);
        if (!t) return send(res, 404, { error: "Öneri bulunamadı." });
        const i = db.likes.findIndex(l => l.tipId === t.id && l.uid === me);
        if (i >= 0) db.likes.splice(i, 1);
        else db.likes.push({ tipId: t.id, uid: me });
        save();
        return send(res, 200, { ok: true });
      }

      if (u.pathname === "/api/delete") {
        const adm = isAdmin(req);
        if (b.kind === "post") {
          const p = db.posts.find(x => x.id === b.id);
          if (!p || !(adm || p.uid === me)) return send(res, 403, { error: "İzin yok." });
          const gone = db.tips.filter(t => t.postId === p.id).map(t => t.id);
          db.posts = db.posts.filter(x => x.id !== p.id);
          db.tips = db.tips.filter(t => t.postId !== p.id);
          db.likes = db.likes.filter(l => !gone.includes(l.tipId));
        } else {
          const t = db.tips.find(x => x.id === b.id);
          if (!t || !(adm || t.uid === me)) return send(res, 403, { error: "İzin yok." });
          db.tips = db.tips.filter(x => x.id !== t.id);
          db.likes = db.likes.filter(l => l.tipId !== t.id);
        }
        save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "Yok" });
    }

    if (u.pathname !== "/") {
      res.writeHead(404);
      return res.end();
    }
    try { page = fs.readFileSync(PAGE, "utf8"); } catch (e) {}
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  } catch (e) {
    console.error("Hata:", e.message);
    send(res, 400, { error: "Bir hata oldu." });
  }
}).listen(PORT, () => console.log("IyiGelir http://localhost:" + PORT));
