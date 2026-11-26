/* ---------- Find anything: the command palette (Ctrl/Cmd+K or "/"), plain-language commands, help, tooltips ----------
   One box for every page, reel, network, project, footage search and help article. Typing a sentence
   ("post carstay on tiktok tomorrow 7pm", "明日TikTokに投稿") becomes a suggested action at the top that
   only opens the right place, already filled in; nothing goes public from here. Keyboard: the WAI-ARIA
   combobox pattern (focus stays in the input, aria-activedescendant follows the arrow keys). */
const HELP = [
  { id: "flow", icon: "list", go: () => goPage("reels"), kw: "how start overview flow 使い方 流れ はじめ",
    en: ["How the studio works", "Footage comes in (Footage), the studio makes reels from it (Reels › Make reels), you watch and approve each one, then post it on every network (Posting). Accounts says what can post by itself."],
    ja: ["スタジオの流れ", "素材を取り込み（素材）、そこからリールを作り（リール › リールを作る）、1本ずつ確認して承認し、各ネットワークに投稿します（投稿）。アカウント画面で自動投稿できる先を確認できます。"] },
  { id: "make", icon: "clapper", go: () => openMaker(), kw: "make create generate reels theme 作る 生成 テーマ",
    en: ["Make reels", "Reels › Make reels: tick the themes, press Make. Each reel takes a few minutes; the queue panel shows time left. More options: long explainer cut, faces, how far back to look."],
    ja: ["リールを作る", "リール › リールを作る：テーマを選んで「作る」。1本数分かかり、キューに残り時間が出ます。詳細設定：長尺の解説版、顔あり、素材の期間。"] },
  { id: "projects", icon: "folder", go: () => { location.hash = "#/projects"; }, kw: "projects all overview status progress every project プロジェクト 一覧 すべて 進み具合",
    en: ["All projects at once", "Every project on one page: what is rendering and how far, reels to review, the next post, long videos and what needs you. From the project menu (top left) or here."],
    ja: ["すべてのプロジェクト", "全プロジェクトを1ページで：書き出しの進み具合、確認待ちのリール、次の投稿、長い動画、対応が必要なこと。左上のプロジェクトメニューからも開けます。"] },
  { id: "review", icon: "check", go: () => reviewNext(), kw: "review approve reject consent 確認 承認 却下 同意",
    en: ["Review a reel", "Open a reel, watch it, then Approve (files go to Drive ready/) or Reject with a note. People on camera: press Consent OK. The arrows at the top go to the next reel waiting."],
    ja: ["リールを確認する", "リールを開いて再生し、承認（Driveのready/へ）または理由を書いて却下。人が映っている場合は「同意OK」。上部の矢印で次の未確認リールへ。"] },
  { id: "post", icon: "send", go: () => goPage("posting"), kw: "post publish upload share network 投稿 公開 アップロード",
    en: ["Post a reel", "Posting: each square is one network. Click it for that network's file and text. Connected networks have Post now / Schedule; the others have a one-click hand-off (text copied, file saved, upload page open). Then Mark posted."],
    ja: ["リールを投稿する", "投稿：各マスが1つのネットワーク。クリックするとファイルと文章が出ます。接続済みは「今すぐ投稿／予約」、それ以外は1クリック受け渡し（文章コピー・保存・投稿ページ）。最後に「投稿済みにする」。"] },
  { id: "plan", icon: "cal", go: () => { goPage("posting"); openPlanner(); }, kw: "plan week schedule calendar slots 計画 予定 一週間",
    en: ["Plan a week of posts", "Posting › Plan posts fills every network's free slots for 3–14 days with approved reels, one reel per slot. YouTube is a real schedule; the rest become reminders or studio posts."],
    ja: ["一週間の投稿を計画", "投稿 › 投稿を計画：承認済みリールで各ネットワークの空き枠を3〜14日分埋めます。YouTubeは本予約、他はリマインダーかスタジオ投稿になります。"] },
  { id: "time", icon: "clock", go: () => openAbout(), kw: "time zone jst timezone 時間 タイムゾーン 日本時間",
    en: ["Times and time zones", "Every time is shown in your audience's zone (STUDIO_TZ, e.g. Japan), even when this computer is abroad. Network schedulers may show your local time: the studio's hint under each time box says which."],
    ja: ["時刻とタイムゾーン", "時刻はすべて視聴者のタイムゾーン（STUDIO_TZ、例：日本）で表示します。PCが海外でも同じです。各サイトの予約画面はPCの時刻の場合があるので、時刻欄の下の表示を確認してください。"] },
  { id: "accounts", icon: "user", go: () => goPage("accounts"), kw: "connect account login bluesky facebook token password 接続 アカウント ログイン",
    en: ["Connect accounts", "Accounts: connect Bluesky (app password) or a Facebook Page (access token) once; the keys stay encrypted on this computer. Switch off networks this project does not use. The profile kit has each profile's name, bio and link to copy."],
    ja: ["アカウントをつなぐ", "アカウント：Bluesky（アプリパスワード）やFacebookページ（アクセストークン）を一度つなぐだけ。鍵はこのPCに暗号化保存。使わないネットワークはオフに。プロフィールキットで名前・自己紹介・リンクをコピー。"] },
  { id: "projects", icon: "folder", go: () => openProjects(), kw: "project workspace brand client switch プロジェクト ブランド 切り替え",
    en: ["Projects", "The coloured name beside the logo: each project (brand or client) has its own footage, reels, posts and accounts. New project, rename, colour, switch."],
    ja: ["プロジェクト", "ロゴ横の色付きの名前：プロジェクト（ブランドや取引先）ごとに素材・リール・投稿・アカウントが分かれます。新規作成・名前・色・切り替え。"] },
  { id: "footage", icon: "layers", go: () => goPage("footage"), kw: "footage folder import google photos tag search 素材 フォルダ 取り込み",
    en: ["Footage", "Footage lists every photo and video the studio can use, grouped by shoot, month or tag. Add a folder or Google Photos; new files are picked up every 30 minutes. Search by words such as drone, fire, snow."],
    ja: ["素材", "素材画面に使える写真と動画が撮影日・月・タグ別に並びます。フォルダやGoogleフォトを追加でき、新しいファイルは30分ごとに取り込まれます。「ドローン」「焚き火」などで検索できます。"] },
  { id: "edit", icon: "scissors", go: () => palOpen("keys"), kw: "edit editor cut trim keyboard shortcuts 編集 カット ショートカット",
    en: ["Edit a reel", "In a reel: Space plays, ← → step a frame (Shift: 10), Q / W trim the clip's start / end, Ctrl+B splits, Delete removes, Ctrl+Z undoes. Changes save as you go."],
    ja: ["リールを編集する", "リール内：スペースで再生、← →で1コマ（Shiftで10）、Q／Wでクリップの頭／尻を詰め、Ctrl+Bで分割、Deleteで削除、Ctrl+Zで元に戻す。変更は自動保存。"] },
  { id: "motion", icon: "wave", go: () => { location.hash = "#/keys/motion"; }, kw: "motion animation animate reduced still moving dead graphics 動き アニメーション 止まる グラフィック",
    en: ["Motion on the graphics", "Settings › Keys & AI › This studio: Auto follows your system's reduced-motion setting; On moves the maps, wires and dots anyway; Reduced keeps everything still."],
    ja: ["グラフィックの動き", "設定 › キーとAI › このスタジオ：「自動」はパソコンの設定に合わせ、「オン」はマップや配線や点をいつも動かし、「減らす」はすべて止めます。"] },
  { id: "trouble", icon: "alert", go: () => $("#sysBtn").click(), kw: "error failed slow problem broken help エラー 失敗 遅い 問題",
    en: ["When something fails", "System (top right) checks this computer. A failed render shows its reason and Try again in the queue panel; Log › Activity lists every job. A refused post stays in Posting with Facebook's or Bluesky's reason."],
    ja: ["うまくいかないとき", "右上の「システム」でPCを確認。失敗したレンダーはキューに理由と再試行が出ます。ログ › アクティビティに全ジョブ。拒否された投稿は理由付きで投稿画面に残ります。"] },
];
const KEYS = [["Ctrl K  /", "pal.k.open"], ["?", "pal.k.help"], ["↑ ↓  Enter", "pal.k.move"], ["Esc", "pal.k.close"],
  ["Space", "pal.k.play"], ["← →", "pal.k.step"], ["Q  W", "pal.k.trim"], ["Ctrl B", "pal.k.split"], ["Ctrl Z", "pal.k.undo"]];
const NET_WORDS = { youtube: ["youtube", "yt", "shorts", "ユーチューブ", "ショート"], tiktok: ["tiktok", "tt", "ティックトック"], instagram: ["instagram", "insta", "ig", "インスタ"],
  facebook: ["facebook", "fb", "フェイスブック"], threads: ["threads", "スレッズ"], x: ["twitter", "ツイッター", "エックス", "x"], linkedin: ["linkedin", "リンクトイン"],
  gbp: ["google maps", "gbp", "maps", "グーグルマップ", "マップ"], "line-voom": ["voom", "line voom"], "line-oa": ["line message", "line", "ライン"],
  pinterest: ["pinterest", "ピンタレスト"], bluesky: ["bluesky", "bsky", "ブルースカイ"], xiaohongshu: ["xiaohongshu", "rednote", "小红书"] };
let pal = null;  // { mode: "all" | "help" | "keys" | "start", q, items, i }
const RECENT_KEY = "studio.palRecent";
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
function remember(id) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 8))); } catch { /* private window */ } }
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase();

/* Navigation the palette and help share. */
function goPage(p, filter) {
  page = p; homeFilter = filter || "all";
  window.history.pushState(null, "", "#/" + p);
  route();
}
function openMaker(keys) {
  if (keys?.length) autoThemes = new Set(keys);
  showMaker = true; goPage("reels");
  setTimeout(() => $("#home")?.querySelector(".maker, #autoGo")?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
}
function reviewNext() { const r = needsReview()[0]; if (r) go(r.slug); else { goPage("reels"); toast(`${ico("check", "sm")} ${tr("pal.nothingtoreview")}`, 3000); } }
function openProjects() { wsPanel = true; wsNew = false; paintWs(); loadWorkspaces(); }

/* Plain-language commands, worked out on this computer: which network, which reel or theme, which verb,
   and a time ("tomorrow 7pm", "明日19時"). The result is one suggested action shown before it runs. */
function whenFrom(q) {
  const day = /tomorrow|明日|あした/.test(q) ? 1 : /day after|明後日|あさって/.test(q) ? 2 : /today|tonight|今日|今夜/.test(q) ? 0 : null;
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(q) || /(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/.exec(q) || /\b(\d{1,2}):(\d{2})\b/.exec(q);
  if (day === null && !m) return null;
  let h = m ? +m[1] : 19; const mi = m && m[2] ? +m[2] : 0;
  if (m && m[3] === "pm" && h < 12) h += 12; if (m && m[3] === "am" && h === 12) h = 0;
  if (/夜|tonight|evening/.test(q) && h < 12) h += 12;
  const base = wallOf(Date.now() + (day || 0) * 86400000).slice(0, 10);
  return `${base}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
function netFrom(q) {
  const words = q.split(/[\s、。,.!?！？]+/);
  for (const [net, al] of Object.entries(NET_WORDS)) {
    if (al.some((a) => a.length <= 2 ? words.includes(a) : q.includes(a))) return net === "youtube" ? "youtube" : net;
  }
  return null;
}
function reelFrom(q) {
  const R = overview.reels.filter((r) => !r.house);
  return R.find((r) => q.includes(r.slug)) || null;
}
function themesFrom(q) {
  if (!themes) return [];
  return Object.entries(themes).filter(([k, t]) => q.includes(k) || (t.title && q.includes(norm(t.title).slice(0, 4)))).map(([k]) => k);
}
function intent(raw) {
  const q = norm(raw).trim();
  if (q.length < 3) return null;
  const net = netFrom(q), reel = reelFrom(q), th = themesFrom(q), at = whenFrom(q);
  const netName = net ? NET_NAME[net] || net : "";
  if (/\b(make|create|generate|render)\b|作|生成|レンダー/.test(q)) {
    const n = /(\d+)\s*(reels?|本)/.exec(q)?.[1];
    return { icon: "clapper", label: th.length ? tr("pal.i.makeTh", { t: th.join(", ") }) : tr("pal.i.make"), sub: n ? tr("pal.i.makeN", { n }) : tr("pal.i.makeSub"), run: () => openMaker(th) };
  }
  if (/\b(post|publish|schedule|upload|share)\b|投稿|予約|公開|アップ/.test(q) && (net || reel)) {
    const target = net || "tiktok";
    const r = reel || openFor(target)[0];
    if (!r) return { icon: "send", label: tr("pal.i.nothingfor", { n: NET_NAME[target] || target }), sub: "", run: () => goPage("posting") };
    return { icon: "send", label: tr("pal.i.post", { s: r.slug, n: NET_NAME[target] || target }), sub: at ? tr("pal.i.at", { t: whenText(zonedIso(at)) }) : tr("pal.i.postSub"),
      run: async () => {
        goPage("posting"); await openDrawer(r.slug, target);
        if (at) for (const id of ["dPubAt", "dAt"]) { const el = $("#" + id); if (el) el.value = at; }
      } };
  }
  if (/review|approve|確認|承認|レビュー/.test(q)) return { icon: "check", label: tr("pal.i.review", { n: needsReview().length }), sub: "", run: reviewNext };
  if (/scheduled|upcoming|予約済|予定/.test(q)) return { icon: "cal", label: tr("pal.i.showSched"), sub: netName, run: () => goPage("posting", "scheduled") };
  if (/posted|went out|投稿済|公開済/.test(q)) return { icon: "check", label: tr("pal.i.showPosted"), sub: netName, run: () => goPage("posting", "posted") };
  if (/connect|login|sign in|接続|つなぐ|ログイン/.test(q)) return { icon: "link", label: tr("pal.i.connect", { n: netName || tr("nav.accounts") }), sub: "", run: () => goPage("accounts") };
  if (/project|workspace|brand|プロジェクト|ブランド/.test(q)) return { icon: "folder", label: tr("pal.i.projects"), sub: "", run: openProjects };
  if (/footage|clip|video of|photo|素材|動画|写真/.test(q)) {
    const words = raw.replace(/footage|clips?|videos? of|photos? of|show|find|search|素材|動画|写真|を|の|探す|見る|見せて/gi, " ").replace(/\s+/g, " ").trim();
    return { icon: "search", label: tr("pal.i.footage", { q: words || "…" }), sub: "", run: () => searchFootage(words) };
  }
  if (net && !reel) return { icon: "send", label: tr("pal.i.netnext", { n: netName }), sub: tr("pal.i.netnextSub", { k: openFor(net).length }),
    run: () => { const r = openFor(net)[0]; goPage("posting"); if (r) openDrawer(r.slug, net); } };
  return null;
}
function searchFootage(words) {
  goPage("footage"); foot.q = words || ""; foot.items = []; loadFootage();
  setTimeout(() => { const i = $("#footQ"); if (i) { i.value = foot.q; i.focus(); } }, 50);
}

/* Everything the palette can find, built fresh on each open (cheap: a few hundred entries). */
function palCatalog() {
  const out = [];
  const add = (group, id, icon, label, sub, run, kw = "", hint = "") => out.push({ group, id, icon, label, sub, run, kw: norm(`${label} ${sub} ${kw}`), hint });
  const L = lang === "ja" ? "ja" : "en";
  add("act", "a:make", "clapper", tr("act.make"), tr("pal.a.makeSub"), () => openMaker(), "make create new reels 作る");
  add("act", "a:review", "check", tr("pal.a.review", { n: needsReview().length }), "", reviewNext, "review approve 確認 承認");
  add("act", "a:plan", "cal", tr("pal.a.plan"), tr("pal.a.planSub"), () => { goPage("posting"); openPlanner(); }, "plan schedule week 計画");
  add("act", "a:refresh", "refresh", tr("pal.a.refresh"), "", () => $("#syncBtn").click(), "refresh sync reload 更新");
  add("help", "a:pop", "help", tr("pop.link"), "", () => POP.ask(), "90s popup pop-up tour tutorial help retro fun ポップアップ チュートリアル おまけ");
  add("act", "a:system", "shield", tr("pal.a.system"), "", () => $("#sysBtn").click(), "system check health システム");
  add("act", "a:projects", "folder", tr("ws.title"), wsView?.list?.find((x) => x.id === wsView.running)?.name || "", openProjects, "project switch workspace プロジェクト");
  add("act", "a:newproject", "plus", tr("ws.new"), "", () => { openProjects(); wsNew = true; paintWs(); }, "new project create 新しい");
  add("act", "a:lang", "globe", lang === "en" ? "日本語に切り替え" : "Switch to English", "", () => $("#lang").click(), "language english japanese 言語 英語 日本語");
  // The colours, from anywhere (the top bar's button switches Light ⇄ Dark; these also give Auto back).
  for (const [v, icon, key] of [["light", "sun", "fb_th.pl"], ["dark", "moon", "fb_th.pd"], ["auto", "refresh", "fb_th.pa"]])
    add("act", "a:theme-" + v, icon, tr(key), tr("fb_th.psub"), () => { themeApply(v); toast(`${ico(icon, "sm")} ${esc(tr("d_th.saved", { v: tr("d_th." + v) }))}`, 2500); },
      `colours colors theme ${v} dark light night mode system auto 画面 色 テーマ ライト ダーク 自動 夜`);
  add("act", "a:start", "list", tr("setup.title"), tr("pal.a.startSub"), () => palOpen("start"), "getting started onboarding setup はじめに");
  add("act", "a:keys", "list", tr("pal.keys"), "", () => palOpen("keys"), "keyboard shortcuts keys ショートカット");
  add("act", "a:about", "info", tr("foot.about"), "", () => openAbout(), "about version credits licence バージョン");
  // Every tool from the one list (FEATURES); in simple mode the full-mode ones still come up, marked More tools.
  // (Reply on Bluesky and two Results tabs have richer entries below.)
  for (const id of Object.keys(FEATURES).filter((x) => !["bluesky", "reswhere", "resposts"].includes(x))) add("page", "p:" + id, ftIcon(id), ftName(id), ftShown(id) ? tr("pal.page") : tr("mt.palsub"), () => { location.hash = ftHref(id); }, id + (FEATURES[id].help ? " " + tr(FEATURES[id].help) : ""));
  for (const f of ["topost", "scheduled", "posted", "making", "draft"]) add("page", "f:" + f, "list", `${tr("nav.posting")} › ${tr(STATE_KEY[f])}`, "", () => goPage("posting", f), "posting filter " + f);
  for (const t of ["overview", "reels", "activity", "posts"]) add("page", "l:" + t, "list", `${tr("nav.log")} › ${t}`, "", () => { location.hash = "#/log/" + t; }, "log " + t);
  for (const [id, icon, key, sub, run, kw] of RB_FIND) add("page", "rb:" + id, icon, tr(key), tr(sub), run, kw);  // Track B: Results sections, Act settings
  add("page", "bsr:reply", "chat", tr("bsr.title"), tr("bsr.palsub"), () => { location.hash = "#/ideas/bluesky"; },
    "reply replies bluesky bsky engage engagement follow followers comment niche 返信 ブルースカイ フォロー 交流 リプライ");  // BL-100
  for (const r of overview.reels.filter((x) => !x.house)) {
    const st = tr(STATE_KEY[reelState(r)] || "st.draft");
    add("reel", "r:" + r.slug, "film", r.title || r.slug, `${r.slug} · ${st}`, () => go(r.slug), `${r.theme || ""} ${r.status || ""}`);
  }
  for (const n of POST_NETS.filter((x) => chanOf(x) && !chanOf(x).off)) {
    const next = openFor(n)[0];
    add("net", "n:" + n, "send", NET_NAME[n] || n, tr("pal.netSub", { k: openFor(n).length }), () => { goPage("posting"); if (next) openDrawer(next.slug, n); }, (NET_WORDS[n] || []).join(" "));
  }
  for (const h of HELP) add("help", "h:" + h.id, h.icon, h[L][0], h[L][1].slice(0, 90) + "…", () => palOpen("help", h[L][0]), h.kw + " " + h[L][1]);
  return out;
}
function palScore(it, toks) {
  let s = 0;
  const lab = norm(it.label);
  for (const t of toks) {
    if (!it.kw.includes(t)) return -1;  // every word must appear somewhere
    const wordStart = lab.split(/[ ›·/-]+/).some((w) => w.startsWith(t));
    s += lab.startsWith(t) ? 6 : wordStart ? 4 : lab.includes(t) ? 2 : 1;
  }
  // The whole query is one of the item's own words (a reel's exact name): it comes first, not aerial-1108-2 for aerial-1108.
  if (toks.length === 1 && it.kw.split(/\s+/).includes(toks[0])) s += 10;
  return s;
}
const GROUP_ORDER = ["do", "recent", "act", "page", "reel", "net", "help", "find"];
/* Small words a question carries ("how do I…", "…するには") are dropped before matching. */
const STOP = new Set(["how", "do", "i", "to", "a", "an", "the", "can", "my", "is", "what", "where", "why", "when", "does", "of", "in", "on", "for", "with", "and", "or", "it", "me", "please", "どう", "どうやって", "方法", "には", "って", "とは", "の", "を", "に", "は", "が", "で", "する", "したい"]);
const isQuestion = (q) => /^(how|what|where|why|when|can i|help)\b|\?$|？$|どう|方法|には$|とは|って何|わからない|ヘルプ/.test(norm(q).trim());
function helpMatches(q) {
  const L = lang === "ja" ? "ja" : "en";
  const nq = norm(q);
  const toks = nq.split(/[\s、。?？]+/).filter((t) => t && !STOP.has(t));
  if (!toks.length) return HELP.map((h) => ({ h, s: 0 }));
  return HELP.map((h) => {
    const text = norm(`${h[L][0]} ${h.kw} ${h[L][1]}`);
    // Words of the question found in the article, plus the article's keywords found in the question
    // (Japanese has no spaces, so "どうやって投稿するの" is one token that contains 投稿).
    const fwd = toks.reduce((n, t) => n + (norm(h[L][0]).includes(t) ? 3 : norm(h.kw).includes(t) ? 2 : text.includes(t) ? 1 : 0), 0);
    const back = h.kw.split(/\s+/).filter((w) => w.length >= 2 && !/^[a-z]{2}$/.test(w) && nq.includes(norm(w))).length * 2;
    return { h, s: fwd + back };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
}
function palItems() {
  const q = pal.q.trim(), toks = norm(q).split(/\s+/).filter((t) => t && !(STOP.has(t) && norm(q).split(/\s+/).length > 1));
  if (pal.mode === "keys") return KEYS.map(([k, key], i) => ({ group: "keys", id: "k" + i, icon: "list", label: tr(key), hint: k, run: null }));
  if (pal.mode === "start") return startSteps().map((s, i) => ({ group: "start", id: "s" + i, icon: s.ok ? "check" : "clock", label: tr(s.key), sub: s.ok ? tr("pal.done") : "", done: s.ok, run: s.run }));
  if (pal.mode === "help") {
    const L = lang === "ja" ? "ja" : "en";
    const list = helpMatches(q).map((x) => x.h);
    return list.map((h) => ({ group: "help", id: "h:" + h.id, icon: h.icon, label: h[L][0], body: h[L][1], run: h.go, hint: tr("pal.open") }));
  }
  const cat = palCatalog();
  let items;
  if (!toks.length) {
    const rec = recent().map((id) => cat.find((c) => c.id === id)).filter(Boolean).map((c) => ({ ...c, group: "recent" }));
    items = [...rec, ...cat.filter((c) => c.group === "act").slice(0, 6), ...cat.filter((c) => c.group === "page"&& c.id.startsWith("p:"))];
  } else {
    items = cat.map((c) => ({ c, s: palScore(c, toks) + (recent().includes(c.id) ? 2 : 0) })).filter((x) => x.s > 0)
      .sort((a, b) => GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group) || b.s - a.s).map((x) => x.c);
    const groups = {}; items = items.filter((c) => (groups[c.group] = (groups[c.group] || 0) + 1) <= 8);
    // A question leads with the best help article; anything else with the action the sentence asks for.
    const best = isQuestion(q) ? helpMatches(q)[0] : null;
    const it = best ? null : intent(q);
    const L = lang === "ja" ? "ja" : "en";
    if (best) {
      items = items.filter((c) => c.id !== "h:" + best.h.id);
      items.unshift({ group: "do", id: "do", icon: best.h.icon, label: best.h[L][0], body: best.h[L][1], sub: "", hint: "Enter", run: best.h.go });
      for (const x of helpMatches(q).slice(1, 3)) if (!items.some((c) => c.id === "h:" + x.h.id)) items.push({ group: "help", id: "h:" + x.h.id, icon: x.h.icon, label: x.h[L][0], sub: x.h[L][1].slice(0, 90) + "…", run: () => palOpen("help", x.h[L][0]) });
    } else if (it) items.unshift({ group: "do", id: "do", ...it, hint: "Enter" });
    if (items[0]?.group === "do") items = [items[0], ...items.slice(1).filter((c) => c.label !== items[0].label)];
    if (!it && !best && q.split(/\s+/).length <= 3) items.push({ group: "find", id: "fq", icon: "search", label: tr("pal.footq", { q }), sub: tr("nav.footage"), run: () => searchFootage(q) });
  }
  return items;
}
/* The one setup list (BL-115). Every step the wizard walks and Ctrl K "Getting started" lists; the ones without
   `optional` are the essentials: Home's setup cards and the header chip count exactly those (essentialSteps), so the
   number reads the same everywhere. id/icon/href/make are what a Home card needs. */
function startSteps() {
  const lib = overview.library || {}, hasFootage = (lib.ranch || lib.total || 0) > 0;
  const booked = postsLog.some((p) => p.network !== "all" && ["scheduled", "queued", "posted"].includes(p.status));
  const system = { ok: !!(sys.health && sys.health.verdict !== "blocked"), key: "setup.system", optional: true, run: () => $("#sysBtn").click() };
  const footage = { id: "footage", icon: "layers", href: "#/footage/sources", ok: hasFootage, key: "setup.footage", run: () => goPage("footage") };
  // A trip made into long videos (and no short reels yet) has its own path: footage, the long videos, and YouTube.
  // The short-reel steps (time zone for posting, booking, posting accounts) only count once there are reels.
  if (vlogView?.parts?.length && !overview.reels.some((r) => !r.house)) {
    return [
      system, footage,
      { id: "vlogs", icon: "film", href: "#/videos", ok: vlogView.parts.some((p) => p.built), key: "setup.vlogs", run: () => goPage("videos") },
      { id: "ytvlog", icon: "play", href: "/api/youtube/connect", ok: !!yt.connected, key: "setup.ytvlog", run: () => { location.href = "/api/youtube/connect"; } },
    ];
  }
  // A first reel comes before any sign-in: footage → reel → review, then connect where it will go (as the user guide's
  // "Your first day" orders it). Signing in to networks first stood between a new person and the first thing they make.
  return [
    system, footage,
    { ok: !!AUD_TZ, key: "setup.tz", optional: true, run: () => openAbout() },
    { id: "reel", icon: "film", make: true, ok: overview.reels.some((r) => !r.house && r.rendered), key: "setup.reels", run: () => openMaker() },
    { ok: overview.reels.some((r) => !r.house && r.status === "approved"), key: "setup.review", optional: true, run: () => goPage("review") },
    { id: "network", icon: "link", href: "#/accounts", ok: Object.values(connections || {}).some((c) => c?.connected) || !!yt.connected || booked, key: "setup.connect", run: () => goPage("accounts") },
    { ok: !!yt.connected, key: "setup.youtube", optional: true, run: () => { location.href = "/api/youtube/connect"; } },
    { id: "book", icon: "cal", href: "#/posting", ok: booked, key: "setup.post", run: () => goPage("posting") },
  ];
}
/** The essentials of the one setup list: Home's cards and the header chip ("2/4" on both). */
function essentialSteps() { return startSteps().filter((s) => !s.optional); }
/* ---------- the setup wizard: one plain step per screen, built on the Getting started steps ---------- */
const TZ_CHOICES = [["Asia/Tokyo", "日本 Japan"], ["Asia/Singapore", "Singapore"], ["Asia/Seoul", "Korea"], ["Asia/Shanghai", "China"], ["Asia/Taipei", "Taiwan"], ["Asia/Bangkok", "Thailand"], ["Australia/Sydney", "Sydney"], ["Europe/London", "London"], ["Europe/Paris", "Paris / Berlin"], ["America/New_York", "New York"], ["America/Los_Angeles", "Los Angeles"]];
let wz = null;
function openWizard(at) {
  const steps = startSteps();
  const first = steps.findIndex((x) => !x.ok);
  wz = { i: typeof at === "number" ? at : (localStorage.getItem("lc.wz.lang") ? (first < 0 ? steps.length + 1 : first + 1) : 0), opener: document.activeElement };
  try { localStorage.setItem("lc.wz.seen", "1"); } catch { /* private window */ }
  paintWizard();
}
function closeWizard() {
  const back = wz?.opener; wz = null;
  const host = $("#wz"); if (host) host.innerHTML = "";
  if (back && document.contains(back)) back.focus?.({ preventScroll: true });
}
function paintWizard() {
  if (!wz) return;
  let host = $("#wz");
  if (!host) { host = document.createElement("div"); host.id = "wz"; document.body.appendChild(host); }
  const steps = startSteps(), n = steps.length, i = wz.i;
  let inner;
  if (i === 0) {
    inner = `<div class="kenjisay"><img src="/brand/kenji-wave.png" alt=""><p>${tr("kenji.hi")}</p></div><h2>${ico("type")} ${tr("wz.lang")}</h2>
      <div class="wzlang"><button class="${lang === "en" ? "primary" : ""} big" data-wzlang="en">English</button><button class="${lang === "ja" ? "primary" : ""} big" data-wzlang="ja">日本語</button></div>`;
  } else if (i > n) {
    inner = `<h2>${ico("check")} ${tr("wz.alldone")}</h2><div class="kenjisay"><img src="/brand/kenji-thumbs.png" alt=""><p>${tr("wz.allnote")}</p></div>
      <div class="row">${steps.some((x) => x.key === "setup.vlogs") ? `<button class="primary big" data-wzgo="videos">${ico("play", "sm")}${tr("wz.videos")}</button>`
        : `<button class="primary big" data-wzgo="make">${ico("clapper", "sm")}${tr("wz.make")}</button>`}<button data-wzx="1">${tr("wz.close")}</button></div>
      <p class="meta"><button class="linkbtn" data-pop="1">${tr("pop.link")}</button></p>`;
  } else {
    const st = steps[i - 1];
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzForm = st.key === "setup.tz" ? `<div class="row wztz"><select id="wzTz" aria-label="${esc(tr("setup.tz"))}">${[[here, tr("wz.tzhere", { z: here })], ...TZ_CHOICES.filter(([z]) => z !== here)].map(([z, l]) => `<option value="${esc(z)}" ${z === (AUD_TZ || "Asia/Tokyo") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <button class="primary big" data-wztz="1">${ico("check", "sm")}${tr("wz.tzsave")}</button></div>` : "";
    inner = `<p class="meta">${tr("wz.step", { i, n })}</p>
      <h2>${ico(st.ok ? "check" : "list")} ${tr(st.key)}</h2>
      <div class="kenjisay"><img src="/brand/kenji-bust.png" alt=""><p>${tr(st.key + ".why")}</p></div>
      ${st.ok ? `<p class="good">${ico("check", "sm")} ${tr("wz.doneok")}</p>` : tzForm || `<div class="row"><button class="primary big" data-wzdo="1">${ico("chev-r", "sm")}${tr("wz.do")}</button></div>`}`;
  }
  /* The window is a 1997 InstallShield wizard (the owner, 16 Nov: "fun and retro, like the 90s exe style ... dense
     information"): a title bar, every step listed down the left with its state, a block progress bar, and bevelled
     < Back / Next > buttons. Same steps and data-wz* hooks as before; only the frame changed. */
  const done = steps.filter((x) => x.ok).length, pct = Math.round(100 * done / Math.max(1, n));
  const side = [{ label: tr("wz.langstep"), ok: i > 0 || !!localStorage.getItem("lc.wz.lang"), k: 0 },
    ...steps.map((x, k) => ({ label: tr(x.key), ok: x.ok, k: k + 1 })), { label: tr("wz.finish"), ok: done === n, k: n + 1 }];
  host.innerHTML = `<div class="dscrim" data-wzx="1"></div><div class="wzbox w9x" role="dialog" aria-modal="true" aria-label="${esc(tr("wz.title"))}">
    <div class="w9title"><img src="/brand/icon-16.png" alt="" width="16" height="16"><b>${tr("wz.title")}</b><span class="grow"></span>
      <button class="w9btn w9x-close" data-wzx="1" aria-label="${esc(tr("wz.close"))}" title="${esc(tr("wz.close"))}">×</button></div>
    <div class="w9main">
      <aside class="w9side" aria-label="${esc(tr("wz.stepsof", { n: n + 2 }))}">
        <div class="w9logo"><b>LAZYCOW</b><b>STUDIO</b><small>${tr("wz.setup")}</small></div>
        <ol class="w9steps">${side.map((s) => `<li class="${s.k === i ? "on" : s.ok ? "ok" : ""}"${s.k === i ? ' aria-current="step"' : ""}><span aria-hidden="true">${s.k === i ? "&gt;" : s.ok ? "✓" : "·"}</span>${esc(s.label)}</li>`).join("")}</ol>
      </aside>
      <div class="w9body wzbody">${inner}</div>
    </div>
    <div class="w9prog"><span>${tr("wz.ready", { d: done, n })}</span>
      <div class="w9bar" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${done}" aria-label="${esc(tr("wz.ready", { d: done, n }))}"><i style="width:${pct}%"></i></div><b>${pct}%</b></div>
    <div class="w9foot wzfoot"><span class="w9ver">${esc(tr("wz.setup"))}${about?.version ? ` v${esc(about.version)}` : ""}</span><span class="grow"></span>
      <button class="w9btn" data-wzmove="-1" ${i > 0 ? "" : "disabled"}>&lt; ${tr("wz.back")}</button>
      ${i <= n ? `<button class="w9btn def" data-wzmove="1">${i === 0 || steps[i - 1]?.ok ? tr("wz.next") : tr("wz.skip")} &gt;</button>` : ""}
      <button class="w9btn" data-wzx="1">${tr(i > n ? "wz.close" : "wz.cancel")}</button></div></div>`;
  // The step's own action first, else the default button (Next >), as an InstallShield window does.
  (host.querySelector(".wzbody button") || host.querySelector(".wzfoot .def") || host.querySelector(".wzfoot button:not(:disabled)"))?.focus({ preventScroll: true });
}
async function wizardAct(e) {
  if (!wz) return false;
  const t = e.target;
  if (t.closest("[data-wzx]")) { closeWizard(); return true; }
  const mv = t.closest("[data-wzmove]"); if (mv) { wz.i = Math.max(0, wz.i + Number(mv.dataset.wzmove)); paintWizard(); return true; }
  const lg = t.closest("[data-wzlang]");
  if (lg) {
    setLang(lg.dataset.wzlang);
    try { localStorage.setItem("lc.wz.lang", "1"); } catch { /* private window */ }
    wz.i = 1; paintWizard(); return true;
  }
  if (t.closest("[data-wzgo]")) { const go = t.closest("[data-wzgo]").dataset.wzgo; closeWizard(); go === "videos" ? goPage("videos") : openMaker(); return true; }
  if (t.closest("[data-wzdo]")) { const st = startSteps()[wz.i - 1]; closeWizard(); st?.run(); return true; }
  if (t.closest("[data-wztz]")) {
    const z = $("#wzTz")?.value || "";
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: z }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast(`${ico("check", "sm")} ${j.note ? esc(j.note) : tr("wz.tzsaved")}`, 6000);
      if (j.restarting) { closeWizard(); setTimeout(() => location.reload(), 4000); }
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return true;
  }
  return false;
}
document.addEventListener("click", (e) => { if (wz) wizardAct(e); });
document.addEventListener("keydown", (e) => { if (wz && e.key === "Escape") { e.preventDefault(); closeWizard(); } });
let wizardTried = false;
/* The wizard opens by itself only on a clear page: never on top of the Projects panel, the palette, a post drawer or
   any other open dialog the person already chose (it tries again on the next visit). */
function otherDialogOpen() {
  return !!(wsPanel || pal || drawer || planner) || [...document.querySelectorAll("[role=dialog], [aria-modal=true]")].some((d) => !d.closest("#wz") && d.getClientRects().length > 0);
}
function paintStartChip() {
  const b = $("#startBtn"); if (!b || !overviewLoaded) return;
  const s = essentialSteps(), done = s.filter((x) => x.ok).length;  // the same count as Home's setup cards
  b.hidden = done === s.length;
  if (!wizardTried) { wizardTried = true; let seen = "1"; try { seen = localStorage.getItem("lc.wz.seen"); } catch { /* private window */ } if (!seen && done < 4) setTimeout(() => { if (!wz && !otherDialogOpen()) openWizard(); }, 600); }
  b.querySelector(".n").textContent = `${done}/${s.length}`;
  b.style.setProperty("--p", `${Math.round((100 * done) / s.length)}%`);
}
function palOpen(mode = "all", q = "") {
  const opener = document.activeElement;
  pal = { mode, q, i: 0, items: [], opener: pal?.opener || opener };
  let host = $("#pal");
  if (!host) { host = document.createElement("div"); host.id = "pal"; document.body.appendChild(host); }
  const title = mode === "help" ? tr("pal.helpTitle") : mode === "keys" ? tr("pal.keys") : mode === "start" ? tr("setup.title") : tr("pal.title");
  host.innerHTML = `<div class="dscrim" data-palx="1"></div><div class="palbox" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="palhead">${ico(mode === "help" ? "info" : "search")}<input id="palQ" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" autocomplete="off" spellcheck="false"
      placeholder="${esc(mode === "help" ? tr("pal.helpph") : tr("pal.ph"))}" value="${esc(q)}" aria-label="${esc(title)}"><kbd>Esc</kbd></div>
    <div class="paltabs" role="tablist">${[["all", "search", tr("pal.tab.all")], ["help", "info", tr("pal.tab.help")], ["start", "list", tr("setup.title")], ["keys", "list", tr("pal.keys")]].map(([m, i, l]) => `<button role="tab" aria-selected="${m === mode}" class="${m === mode ? "on" : ""}" data-palmode="${m}">${ico(i, "sm")}${esc(l)}</button>`).join("")}</div>
    <ul id="palList" role="listbox" aria-label="${esc(title)}"></ul>
    <div class="palfoot meta"><span><kbd>↑</kbd><kbd>↓</kbd> ${tr("pal.f.move")}</span><span><kbd>Enter</kbd> ${tr("pal.f.go")}</span><span><kbd>Ctrl</kbd><kbd>K</kbd> ${tr("pal.f.anywhere")}</span><span class="grow"></span><span>${tr("pal.f.tip")}</span></div></div>`;
  palPaint();
  const inp = $("#palQ"); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
}
function palClose() {
  const back = pal?.opener; pal = null;
  const host = $("#pal"); if (host) host.innerHTML = "";
  if (back && document.contains(back)) back.focus?.({ preventScroll: true });
}
const GROUP_LABEL = () => ({ do: tr("pal.g.do"), recent: tr("pal.g.recent"), act: tr("pal.g.act"), page: tr("pal.g.page"), reel: tr("nav.reels"), net: tr("pal.g.net"), help: tr("pal.tab.help"), find: tr("pal.g.find"), keys: tr("pal.keys"), start: tr("setup.title") });
function palPaint() {
  if (!pal) return;
  pal.items = palItems();
  pal.i = Math.min(pal.i, Math.max(0, pal.items.length - 1));
  const G = GROUP_LABEL();
  let last = "";
  const html = pal.items.map((it, i) => {
    const head = it.group !== last ? `<li class="palgroup" role="presentation">${esc(G[it.group] || it.group)}</li>` : "";
    last = it.group;
    return `${head}<li id="palo-${i}" role="option" aria-selected="${i === pal.i}" class="palopt ${i === pal.i ? "on" : ""} g-${it.group} ${it.done ? "done" : ""}" data-pali="${i}">
      <span class="palic">${ico(it.icon || "chev-r", "sm")}</span><span class="paltxt"><b>${esc(it.label)}</b>${it.sub ? `<span class="meta">${esc(it.sub)}</span>` : ""}${it.body && i === pal.i ? `<span class="palbody">${esc(it.body)}</span>` : ""}</span>
      ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</li>`;
  }).join("");
  $("#palList").innerHTML = html || `<li class="palempty" role="presentation">${ico("info", "sm")} ${esc(tr("pal.none"))}<span class="meta">${esc(tr("pal.noneSub"))}</span></li>`;
  $("#palQ").setAttribute("aria-activedescendant", pal.items.length ? `palo-${pal.i}` : "");
  $("#palo-" + pal.i)?.scrollIntoView({ block: "nearest" });
}
async function palRun(i) {
  const it = pal?.items[i]; if (!it) return;
  if (pal.mode === "help" && it.body && pal.i !== i) { pal.i = i; palPaint(); return; }
  if (!it.run) return;
  if (it.id && !["do", "fq"].includes(it.id) && pal.mode === "all") remember(it.id);
  const keepOpen = it.id === "a:start" || it.id === "a:keys" || it.group === "help" && pal.mode === "all";
  if (!keepOpen) palClose();
  try { await it.run(); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
}
/* Keys like a program: 1-7 open the seven sections (Home to More tools), [ and ] step through a section's tabs; on the review board J/K move,
   A approves, N draws new words, Space plays, Enter opens. Never while typing, never with a modifier. */
let revFocus = "";  // the slug of the outlined reel on To review
const revSlug = (row) => row?.querySelector("[data-revok]")?.dataset.revok || "";
function paintRevFocus() { for (const r of document.querySelectorAll(".rvrow")) r.classList.toggle("kfocus", !!revFocus && revSlug(r) === revFocus); }
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || pal || !atHome()) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable) return;
  if (document.querySelector(".lightbox, .modal.on, #wsModal .wsbox, .ctxmenu")) return;
  if (/^[1-7]$/.test(e.key)) { const sec = SECTIONS[+e.key - 1]; if (sec) { e.preventDefault(); location.hash = "#/" + sec[1][0]; } return; }
  if (e.key === "[" || e.key === "]") {
    // Every tab of the current section, sub-tabs included (Posting's three, Results' log tabs, Ideas' tools); in simple
    // mode only the tools it shows, and the one open now.
    const here = location.hash.replace(/^#\/?/, "").replace(/\/$/, "");
    const cyc = (TAB_CYCLE.find((c) => c.includes(here)) || TAB_CYCLE.find((c) => c.some((x) => x && here.startsWith(x.split("/")[0]))) || []).filter((x) => x === here || tabShown(x));
    if (!cyc || cyc.length < 2) return;
    const at = Math.max(0, cyc.indexOf(here));
    e.preventDefault(); location.hash = "#/" + cyc[(at + (e.key === "]" ? 1 : cyc.length - 1)) % cyc.length]; return;
  }
  if (page !== "review") return;
  const cur = document.querySelector(".rvrow.rvfocus"); if (!cur) return;
  const k = e.key.toLowerCase();
  const move = k === "j" || k === "k" || e.key === "ArrowDown" || e.key === "ArrowUp";
  if (!move && !["a", "n", "r", " ", "enter"].includes(k)) return;
  e.preventDefault();
  if (move) {
    // J/K walk the queue on the left; the reel on the right follows.
    const q = [...document.querySelectorAll("[data-rvq]")].map((b) => b.dataset.rvq); if (q.length < 2) return;
    const i = Math.max(0, Math.min(q.length - 1, q.indexOf(revFocus) + (k === "j" || e.key === "ArrowDown" ? 1 : -1)));
    if (q[i] !== revFocus) { revFocus = q[i]; revPlay = ""; renderHome(true); }
    return;
  }
  if (k === "a") cur.querySelector("[data-revok]")?.click();
  else if (k === "n") cur.querySelector("[data-reword]")?.click();
  else if (k === "r") cur.querySelector("[data-tdrej]")?.click();  // Track D: Reject with a reason
  else if (k === " ") { const v = cur.querySelector("video"); if (v) v.paused ? v.play().catch(() => {}) : v.pause(); else cur.querySelector("[data-revplay]")?.click(); }
  else { const a = cur.querySelector("a[href^='#/reel/']"); if (a) location.hash = a.getAttribute("href"); }
});
document.addEventListener("click", (e) => {
  const it = e.target.closest(".intro"); if (!it || e.target.closest("a, button")) return;
  it.classList.toggle("open");
  try { localStorage.setItem("lc.intro." + page, it.classList.contains("open") ? "1" : ""); } catch { /* private window */ }
});
/* Panels arrange like windows: drag a panel by its grip (or Alt+Up/Down on the grip) to move it on its page; double-
   click a title bar, or its fold button, to fold it to its title. Each page remembers its order and folds. */
const BLOCK_SEL = ":scope > :is(.panel, .sheet, .twocol, .lead, .predsheet)";
function blockId(el) {
  const h = el.querySelector(":scope > h2, :scope > h3, :scope > summary h3, :scope > summary b, :scope > .fh-head h3, :scope > .sheet > h2, :scope h2, :scope h3");
  const words = (h?.dataset.k || h?.textContent || "").replace(/[0-9０-９/·・()（）%×+*-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (h && !h.dataset.k) h.dataset.k = words;
  return [...el.classList].filter((c) => !["focal", "folded", "dragging", "dropbefore", "dropafter"].includes(c)).sort().join(".") + "|" + words;
}
const arrangeKey = (k) => `studio.${k}.${page}`;
function arrangeRead(k) { try { return JSON.parse(localStorage.getItem(arrangeKey(k)) || "[]"); } catch { return []; } }
function arrangeWrite(k, v) { try { localStorage.setItem(arrangeKey(k), JSON.stringify(v)); } catch { /* private window */ } }
function blocks() { return [...document.getElementById("home").querySelectorAll(BLOCK_SEL)]; }
function arrange() {
  const bs = blocks(); if (bs.length < 2) return;
  const order = arrangeRead("order"), folds = new Set(arrangeRead("folds"));
  const keyed = bs.map((el, i) => ({ el, id: blockId(el), i }));
  for (const k of keyed) {
    const pair = k.el.classList.contains("twocol");  // two panels side by side move together (no fold: it has no title of its own)
    k.el.classList.toggle("folded", !pair && folds.has(k.id));
    const head = pair ? k.el.querySelector(":scope > .sheet > h2, :scope > .sheet > h3") : k.el.querySelector(":scope > h2, :scope > h3, :scope > .fh-head, :scope > summary");
    if (head && !head.querySelector(".grip")) {
      head.insertAdjacentHTML("afterbegin", `<button type="button" class="grip" draggable="false" title="${esc(tr("ar.grip"))}" aria-label="${esc(tr("ar.grip"))}">⠿</button>`);
      if (!pair && k.el.tagName !== "DETAILS") head.insertAdjacentHTML("beforeend", `<button type="button" class="foldbtn" title="${esc(tr("ar.fold"))}" aria-label="${esc(tr("ar.fold"))}" aria-expanded="${!folds.has(k.id)}">▾</button>`);
    }
  }
  if (!order.length) return;
  const rank = (k) => { const r = order.indexOf(k.id); return r < 0 ? 1000 + k.i : r; };
  const want = [...keyed].sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  if (want.every((k, i) => k.el === bs[i])) return;  // already in order: nothing to move (and no new mutation)
  const slots = bs.map((el) => { const m = document.createComment("slot"); el.replaceWith(m); return m; });
  slots.forEach((m, i) => m.replaceWith(want[i].el));
}
function saveOrder() { arrangeWrite("order", blocks().map(blockId)); }
function flip(move) {
  const bs = blocks(), before = new Map(bs.map((el) => [el, el.getBoundingClientRect().top]));
  move();
  if (moCalm()) return;
  for (const el of blocks()) {
    const dy = (before.get(el) ?? el.getBoundingClientRect().top) - el.getBoundingClientRect().top;
    if (!dy) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
let arr = null;
document.addEventListener("pointerdown", (e) => {
  const g = e.target.closest("#home .grip"); if (!g || e.button !== 0) return;
  const el = blocks().find((x) => x.contains(g)); if (!el) return;
  e.preventDefault();
  arr = { el, y: e.clientY, target: null, after: false };
  el.classList.add("dragging"); g.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove", (e) => {
  if (!arr) return;
  arr.el.style.transform = `translateY(${e.clientY - arr.y}px)`;
  const others = blocks().filter((x) => x !== arr.el);
  let hit = null, after = false;
  for (const o of others) { const r = o.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom) { hit = o; after = e.clientY > r.top + r.height / 2; break; } }
  others.forEach((o) => o.classList.remove("dropbefore", "dropafter"));
  if (hit) hit.classList.add(after ? "dropafter" : "dropbefore");
  arr.target = hit; arr.after = after;
  if (e.clientY < 80) scrollBy(0, -12); else if (e.clientY > innerHeight - 60) scrollBy(0, 12);
});
function endArrange() {
  if (!arr) return;
  const { el, target, after } = arr; arr = null;
  el.classList.remove("dragging"); el.style.transform = "";
  blocks().forEach((o) => o.classList.remove("dropbefore", "dropafter"));
  if (!target) return;
  flip(() => { if (after) target.after(el); else target.before(el); });
  saveOrder(); toast(`${ico("check", "sm")} ${esc(tr("ar.saved"))}`, 2200);
}
document.addEventListener("pointerup", endArrange);
document.addEventListener("pointercancel", endArrange);
document.addEventListener("keydown", (e) => {
  const g = e.target.closest?.("#home .grip"); if (!g || !e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const bs = blocks(), el = bs.find((x) => x.contains(g)), i = bs.indexOf(el), j = i + (e.key === "ArrowUp" ? -1 : 1);
  if (!el || j < 0 || j >= bs.length) return;
  flip(() => { if (j < i) bs[j].before(el); else bs[j].after(el); });
  saveOrder(); g.focus();
});
function toggleFold(el) {
  if (el.classList.contains("twocol")) return;  // a pair of panels has no title of its own to fold to
  const id = blockId(el), folds = new Set(arrangeRead("folds"));
  if (folds.has(id)) folds.delete(id); else folds.add(id);
  arrangeWrite("folds", [...folds]);
  el.classList.toggle("folded", folds.has(id));
  el.querySelector(".foldbtn")?.setAttribute("aria-expanded", String(!folds.has(id)));
}
document.addEventListener("click", (e) => {
  const f = e.target.closest("#home .foldbtn"); if (!f) return;
  e.preventDefault(); e.stopPropagation();
  const el = blocks().find((x) => x.contains(f)); if (el) toggleFold(el);
}, true);
document.addEventListener("dblclick", (e) => {
  const head = e.target.closest("#home :is(.panel, .sheet, .predsheet) > :is(h2, h3, .fh-head)"); if (!head || e.target.closest("button, a, input, select")) return;
  const el = blocks().find((x) => x.contains(head)); if (el) { getSelection()?.removeAllRanges(); toggleFold(el); }
});
new MutationObserver(() => {
  arrange();
  const home = document.getElementById("home");
  const all = [...home.querySelectorAll(":scope :is(.panel, .sheet)")].filter((x) => !x.closest(".panel .panel, .sheet .sheet"));
  all.forEach((x, i) => x.classList.toggle("focal", i === 0));
  let on = false; try { on = localStorage.getItem("lc.intro." + page) === "1"; } catch { /* private window */ }
  if (on) for (const it of document.querySelectorAll("#home .intro:not(.open)")) it.classList.add("open");
}).observe(document.getElementById("home"), { childList: true });
/* Right-click on a reel: the same actions as its buttons, like a desktop program's context menu. */
function closeCtx() { document.querySelector(".ctxmenu")?.remove(); }
/* Drag photos and videos from this computer onto the studio (any page except the reel editor, where the timeline
   takes drops). On Footage with the Add area in view, that area is the target: it lights up and says how many files
   will be added; elsewhere a full-page overlay says where they go. Each file uploads with its own bar
   (POST /api/footage/upload, the same types and 8 GB limit as the drop box: `collect.types` from /api/intake), the
   files fly into the "Dropped on this page" branch of the source map, and Footage catalogues them about 20 s after
   the last one lands. "Choose files" is the keyboard way to do the same. */
const DROP_TYPES_DEFAULT = [".jpg", ".jpeg", ".heic", ".heif", ".avif", ".tif", ".tiff", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf", ".orf", ".rw2", ".mp4", ".mov", ".m4v", ".3gp", ".mts", ".m2ts", ".mxf", ".mkv", ".webm", ".avi", ".mpg", ".mpeg", ".insv", ".insp", ".360"];
const DROP_MAX = 8 * 1024 ** 3;
const dropTypes = () => (Array.isArray(collect?.types) && collect.types.length ? collect.types : DROP_TYPES_DEFAULT);
const dropOk = (name) => { const m = /\.[^.\\/]+$/.exec(String(name || "")); return !!m && dropTypes().includes(m[0].toLowerCase()); };
let dropDepth = 0;
const fileDrag = (e) => [...(e.dataTransfer?.types || [])].includes("Files") && atHome();
const dragCount = (e) => [...(e.dataTransfer?.items || [])].filter((i) => i.kind === "file").length;
/* The Add area takes the drop when it is on screen; otherwise the overlay does. */
function addZone() {
  const z = page === "footage" ? document.getElementById("addhub") : null;
  if (!z) return null;
  const r = z.getBoundingClientRect();
  return r.bottom > 60 && r.top < innerHeight - 60 ? z : null;
}
function dropOverlay(on, n = 0) {
  const z = on ? addZone() : null;
  document.getElementById("addhub")?.classList.toggle("dragging", !!z);
  if (z) { const t = z.querySelector(".ah-dropmsg b"); if (t) t.textContent = n ? tr(n === 1 ? "ah.dropn1" : "ah.dropn", { n }) : tr("dz.title"); }
  let o = document.getElementById("dropzone");
  if (!on || z) { o?.classList.remove("on"); return; }
  if (!o) { o = document.createElement("div"); o.id = "dropzone"; o.innerHTML = `<div class="dz-box"><b></b><span>${tr("dz.where")}</span></div>`; document.body.append(o); }
  o.querySelector("b").textContent = n ? tr(n === 1 ? "ah.dropn1" : "ah.dropn", { n }) : tr("dz.title");
  o.querySelector("span").textContent = tr("dz.where");
  o.classList.add("on");
}
document.addEventListener("dragenter", (e) => { if (!fileDrag(e)) return; e.preventDefault(); dropDepth++; dropOverlay(true, dragCount(e)); });
document.addEventListener("dragover", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  document.getElementById("addhub")?.classList.toggle("hot", !!e.target.closest?.("#addhub"));
});
document.addEventListener("dragleave", (e) => { if (!fileDrag(e)) return; if (--dropDepth <= 0) { dropDepth = 0; dropOverlay(false); document.getElementById("addhub")?.classList.remove("hot"); } });
document.addEventListener("drop", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault(); dropDepth = 0; dropOverlay(false); document.getElementById("addhub")?.classList.remove("hot");
  takeFiles([...(e.dataTransfer.files || [])], { x: e.clientX, y: e.clientY });
});
/* The keyboard way in: one file input kept outside #home, so a repaint while the system dialog is open loses nothing. */
function chooseFiles() {
  let inp = document.getElementById("pickFiles");
  if (!inp) {
    inp = document.createElement("input"); inp.type = "file"; inp.id = "pickFiles"; inp.multiple = true; inp.hidden = true;
    inp.accept = ["image/*", "video/*", ...dropTypes()].join(",");
    inp.addEventListener("change", () => { const fs = [...(inp.files || [])]; inp.value = ""; if (fs.length) takeFiles(fs, null); });
    document.body.append(inp);
  }
  inp.click();
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-choosefiles]")) { e.preventDefault(); chooseFiles(); } });
/* Sort what came in: photos and videos up to 8 GB go up; anything else is named in one friendly message. */
function takeFiles(files, from) {
  const other = files.filter((f) => !dropOk(f.name)), big = files.filter((f) => dropOk(f.name) && f.size > DROP_MAX);
  const ok = files.filter((f) => dropOk(f.name) && f.size <= DROP_MAX);
  const names = (l) => l.slice(0, 3).map((f) => f.name).join(", ") + (l.length > 3 ? ` +${l.length - 3}` : "");
  const pics = other.filter((f) => /\.(png|webp)$/i.test(f.name)), odd = other.filter((f) => !pics.includes(f));
  if (pics.length) toast(`${ico("alert", "sm")} ${esc(tr("dz.pngnames", { f: names(pics) }))}`, 9000);  // the library treats PNG/WebP as screenshots
  if (odd.length) toast(`${ico("alert", "sm")} ${esc(tr("dz.skipnames", { f: names(odd) }))}`, 7000);
  if (big.length) toast(`${ico("alert", "sm")} ${esc(tr("ah.toobig", { f: names(big) }))}`, 7000);
  if (other.length || big.length) upLive(tr(other.length ? "dz.skipnames" : "ah.toobig", { f: names(other.length ? other : big) }));
  if (ok.length) { flyFiles(ok.length, from); uploadFiles(ok); }
}
/* Dropped files fly into their branch: a few small chips travel from the pointer to the "Dropped on this page" node
   (transform and opacity only, 240 ms); the node then gives one small pulse. Nothing moves with reduced motion. */
function flyFiles(n, from) {
  const target = document.querySelector('#home .snode[data-snode="uploads"]') || document.querySelector("#home .ah-drop");
  if (!target || moCalm()) return;
  const t = target.getBoundingClientRect();
  if (t.bottom < 0 || t.top > innerHeight) return;
  const start = from || (() => { const d = document.querySelector("#home .ah-drop")?.getBoundingClientRect(); return d ? { x: d.left + d.width / 2, y: d.top + d.height / 2 } : null; })();
  if (!start) return;
  const tx = t.left + Math.min(t.width / 2, 24), ty = t.top + t.height / 2;
  for (let i = 0; i < Math.min(n, 6); i++) {
    const c = document.createElement("i"); c.className = "flychip"; c.setAttribute("aria-hidden", "true");
    c.style.left = start.x + "px"; c.style.top = start.y + "px";
    document.body.append(c);
    // A short arc (up, then down into the branch), each chip a little apart, shrinking as it lands.
    const dx = tx - start.x, dy = ty - start.y, lift = Math.min(60, 20 + Math.abs(dx) * .12) + i * 4;
    c.animate([{ transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      { transform: `translate(calc(${dx * .5}px - 50%), calc(${dy * .5 - lift}px - 50%)) scale(.8)`, opacity: .9, offset: .45 },
      { transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(.4)`, opacity: .3 }],
      { duration: 380, delay: i * 40, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "both" }).finished.then(() => c.remove(), () => c.remove());
  }
  // The branch rings once as they land (CSS .snode.got).
  setTimeout(() => { const nd = document.querySelector('#home .snode[data-snode="uploads"]'); if (!nd) return; nd.classList.remove("got"); void nd.offsetWidth; nd.classList.add("got"); }, 380 + Math.min(n, 6) * 40);
}
/* One polite live region for upload news (start, finish, refusals), never for each percent. */
function upLive(text) {
  let r = document.getElementById("upLive");
  if (!r) { r = document.createElement("p"); r.id = "upLive"; r.className = "sr-only"; r.setAttribute("role", "status"); r.setAttribute("aria-live", "polite"); document.body.append(r); }
  r.textContent = ""; setTimeout(() => { r.textContent = text; }, 50);
}
const uploads = [];
let upSeq = 0, upNote = "";
/* The bars live in the Add area when it is on the page, else in a small box in the corner. Rows are made once and
   then only their width and words change, so each bar slides instead of jumping. */
function paintUploads() {
  const inZone = document.getElementById("addUploads");
  let box = document.getElementById("uploads");
  if (!inZone && !box) { box = document.createElement("div"); box.id = "uploads"; document.body.append(box); }
  if (box) box.hidden = !!inZone || !uploads.length;
  for (const host of [inZone, inZone ? null : box].filter(Boolean)) {
    let list = host.querySelector(".uplist");
    if (!list) { list = document.createElement("div"); list.className = "uplist"; host.append(list); }
    list.hidden = !uploads.length;
    const keep = new Set(uploads.map((u) => String(u.id)));
    for (const row of [...list.children]) if (!keep.has(row.dataset.up)) row.remove();
    for (const u of uploads) {
      let row = list.querySelector(`[data-up="${u.id}"]`);
      if (!row) {
        row = document.createElement("div"); row.dataset.up = u.id;
        row.innerHTML = `<span class="nm"></span><span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></span><span class="st"></span>`;
        row.querySelector(".nm").textContent = u.name; row.querySelector(".bar").setAttribute("aria-label", u.name);
        list.append(row);
      }
      row.className = "up " + u.state;
      const pct = Math.round(u.pct * 100);
      row.querySelector(".bar i").style.transform = `scaleX(${u.pct.toFixed(3)})`;
      row.querySelector(".bar").setAttribute("aria-valuenow", pct);
      row.querySelector(".st").textContent = u.state === "done" ? "✓" : u.state === "error" ? u.err : u.state === "wait" ? "…" : pct + "%";
      row.querySelector(".st").title = u.state === "error" ? u.err : "";
    }
    let note = host.querySelector(".upnote");
    if (!note) { note = document.createElement("p"); note.className = "upnote"; host.append(note); }
    note.hidden = !upNote; note.innerHTML = upNote;
  }
}
async function uploadFiles(files) {
  if (foot.drawer !== "add" || page !== "footage") footTabGo("add");
  for (const f of files) uploads.push({ id: ++upSeq, name: f.name, file: f, pct: 0, state: "wait", err: "" });
  upNote = `${ico("clock", "sm")} ${esc(tr("ah.upstart", { n: files.length }))}`;
  upLive(tr("ah.upstart", { n: files.length }));
  paintUploads();
  for (const u of uploads.filter((x) => x.state === "wait")) {
    u.state = "up"; paintUploads();
    await new Promise((done) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/footage/upload?name=" + encodeURIComponent(u.name));
      x.upload.onprogress = (ev) => { if (ev.lengthComputable) { u.pct = ev.loaded / ev.total; paintUploads(); } };
      x.onload = () => { if (x.status === 200) { u.state = "done"; u.pct = 1; } else { u.state = "error"; try { u.err = JSON.parse(x.responseText).error; } catch { u.err = String(x.status); } } paintUploads(); done(); };
      x.onerror = () => { u.state = "error"; u.err = tr("dz.failed"); paintUploads(); done(); };
      x.send(u.file);
    });
  }
  if (uploads.some((u) => u.state === "wait" || u.state === "up")) return;  // another drop is still going: it reports for both
  const n = uploads.filter((u) => u.state === "done").length, bad = uploads.filter((u) => u.state === "error").length;
  const msg = [n ? tr("ah.updone", { n }) : "", bad ? tr("ah.upfail", { n: bad }) : ""].filter(Boolean).join(" ");
  upNote = `${ico(bad ? "alert" : "check", "sm")} ${esc(msg)}`;
  upLive(msg);
  if (n) toast(`${ico("check", "sm")} ${esc(tr("dz.done", { n }))}`, 7000);
  paintUploads();
  // The catalog runs about 20 s after the last file; the map's counts are read again once it has had time.
  if (n) setTimeout(() => { foot.mapLib = null; loadSources(); }, 30e3);
  setTimeout(() => {
    if (uploads.some((u) => u.state === "wait" || u.state === "up")) return;
    for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].state === "done") uploads.splice(i, 1);
    if (!uploads.length) upNote = "";
    paintUploads();
  }, 12000);
}
function hashFor(el) {
  if (!el) return "";
  if (el.matches(".rcard[data-open]")) return "#/reel/" + el.dataset.open;
  if (el.dataset.page) return "#/" + el.dataset.page;
  if (el.dataset.goto) return "#/" + el.dataset.goto;
  return "";
}
const NEWTAB_SEL = ".rcard[data-open], [data-page], [data-goto]";
function openTab(hash) { window.open(location.pathname + hash, "_blank", "noopener"); }
document.addEventListener("click", (e) => {
  if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
  const el = e.target.closest(NEWTAB_SEL), h = hashFor(el);
  if (!h || e.target.closest("button:not([data-page]):not([data-goto]), a, input, select, label") && !e.target.closest("[data-page], [data-goto]")) return;
  e.preventDefault(); e.stopImmediatePropagation(); openTab(h);
}, true);
document.addEventListener("mousedown", (e) => { if (e.button === 1 && hashFor(e.target.closest(NEWTAB_SEL))) e.preventDefault(); });  // no autoscroll
document.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const h = hashFor(e.target.closest(NEWTAB_SEL)); if (!h) return;
  e.preventDefault(); openTab(h);
});
document.addEventListener("contextmenu", (e) => {
  const tab = e.target.closest(".topnav [data-page], .appfoot [data-goto]");
  if (!tab || e.shiftKey) return;
  e.preventDefault(); closeCtx();
  const m = document.createElement("div"); m.className = "ctxmenu"; m.setAttribute("role", "menu");
  m.innerHTML = `<button role="menuitem">${ico("link", "sm")}${tr("ctx.newtab")}<kbd>Ctrl+click</kbd></button>`;
  m.firstChild.onclick = () => { closeCtx(); openTab(hashFor(tab)); };
  m.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); closeCtx(); tab.focus(); } });
  document.body.append(m);
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  m.firstChild.focus();
});
document.addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".rcard[data-open], .rvrow");
  if (!card || e.shiftKey) { if (!e.defaultPrevented) closeCtx(); return; }  // Shift + right-click keeps the browser's own menu; a page tab's menu stays
  const slug = card.dataset.open || card.querySelector("[data-revok]")?.dataset.revok; if (!slug) return;
  const r = overview.reels.find((x) => x.slug === slug); if (!r) return;
  e.preventDefault(); closeCtx();
  const items = [
    [ico("film", "sm") + tr("rv.open"), "Enter", () => { location.hash = "#/reel/" + slug; }],
    [ico("link", "sm") + tr("ctx.newtab"), "Ctrl+click", () => openTab("#/reel/" + slug)],
    ...(r.status === "rendered" && !r.house ? [[ico("check", "sm") + tr("rv.approve"), "A", () => document.querySelector(`[data-revok="${CSS.escape(slug)}"]`)?.click() || (location.hash = "#/review")]] : []),
    ...(r.theme && !r.house ? [[ico("type", "sm") + tr("w.reword"), "N", () => post("/api/words/reword", { slug }).then(() => { toast(`${ico("type", "sm")} ${tr("w.done", { s: esc(slug), h: "" })}`); loadOverview(); }).catch((err) => toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000))]] : []),
    null,
    [ico("send", "sm") + tr("ctx.posts"), "", () => { location.hash = "#/posting/reels"; }],
    [ico("copy", "sm") + tr("ctx.copy"), "", () => navigator.clipboard?.writeText(slug).then(() => toast(`${ico("check", "sm")} ${esc(slug)}`, 1500))],
  ];
  const m = document.createElement("div"); m.className = "ctxmenu"; m.setAttribute("role", "menu");
  m.innerHTML = items.map((x, i) => x ? `<button role="menuitem" data-ctx="${i}">${x[0]}${x[1] ? `<kbd>${x[1]}</kbd>` : ""}</button>` : "<hr>").join("");
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(e.clientX, innerWidth - w - 6) + "px"; m.style.top = Math.min(e.clientY, innerHeight - h - 6) + "px";
  m.querySelector("button")?.focus();
  m.addEventListener("click", (ev) => { const b = ev.target.closest("[data-ctx]"); if (!b) return; closeCtx(); items[+b.dataset.ctx][2](); });
  m.addEventListener("keydown", (ev) => {
    const bs = [...m.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    else if (ev.key === "Escape") { ev.preventDefault(); closeCtx(); }
  });
});
document.addEventListener("click", (e) => { if (!e.target.closest(".ctxmenu")) closeCtx(); });
window.addEventListener("blur", closeCtx);
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (pal) palClose(); else palOpen(); return; }
  if (!pal && !typing && e.key === "/") { e.preventDefault(); palOpen(); return; }
  if (!pal && !typing && e.key === "?") { e.preventDefault(); palOpen("help"); return; }
  if (!pal) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); palClose(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); pal.i = Math.min(pal.items.length - 1, pal.i + 1); palPaint(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pal.i = Math.max(0, pal.i - 1); palPaint(); }
  else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); pal.i = 0; palPaint(); }
  else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); pal.i = pal.items.length - 1; palPaint(); }
  else if (e.key === "Enter") { e.preventDefault(); palRun(pal.i); }
  else if (e.key === "Tab" && e.target.id === "palQ" && !e.shiftKey) {
    e.preventDefault(); const m = ["all", "help", "start", "keys"]; palOpen(m[(m.indexOf(pal.mode) + 1) % m.length], pal.q);
  }
}, true);
document.addEventListener("input", (e) => { if (e.target.id === "palQ" && pal) { pal.q = e.target.value; pal.i = 0; palPaint(); } });
document.addEventListener("click", (e) => {
  if (e.target.closest("#palBtn")) { palOpen(); return; }
  if (e.target.closest("#helpBtn")) { palOpen("help"); return; }
  if (e.target.closest("#startBtn")) { openWizard(); return; }
  if (!pal) return;
  if (e.target.closest("[data-palx]")) { palClose(); return; }
  const m = e.target.closest("[data-palmode]"); if (m) { palOpen(m.dataset.palmode, pal.mode === "keys" || pal.mode === "start" ? "" : pal.q); return; }
  const o = e.target.closest("[data-pali]"); if (o) palRun(+o.dataset.pali);
});
document.addEventListener("mousemove", (e) => {
  const o = pal && e.target.closest?.("[data-pali]");
  if (o && +o.dataset.pali !== pal.i && pal.mode !== "help") { pal.i = +o.dataset.pali; for (const el of document.querySelectorAll(".palopt")) { const on = +el.dataset.pali === pal.i; el.classList.toggle("on", on); el.setAttribute("aria-selected", on); } $("#palQ")?.setAttribute("aria-activedescendant", "palo-" + pal.i); }
});

/* Tooltips that meet WCAG 1.4.13: every title="" in the studio shows as a styled tip on hover and on
   keyboard focus, stays while the pointer moves onto it, and Esc hides it. The native tooltip is
   suppressed (the text moves to data-tip) so it is not shown twice. */
const tipEl = document.createElement("div");
tipEl.id = "tip"; tipEl.setAttribute("role", "tooltip"); tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipFor = null, tipShowT = 0, tipHideT = 0;
function tipText(el) {
  if (el.hasAttribute("title")) { const t = el.getAttribute("title"); el.removeAttribute("title"); if (t) el.dataset.tip = t; }
  return el.dataset.tip || "";
}
function tipShow(el) {
  // A live re-render (a job's progress) can replace the button between hover and show: a detached element measures
  // 0,0 and the tip would stick in the top-left corner over the project chip, taking its clicks.
  if (!el.isConnected) return;
  const text = tipText(el); if (!text) return;
  clearTimeout(tipHideT);
  tipFor = el; tipEl.textContent = text; tipEl.hidden = false;
  const name = (el.getAttribute("aria-label") || el.textContent || "").trim();
  if (norm(name) !== norm(text)) el.setAttribute("aria-describedby", "tip");
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const below = r.bottom + 8 + h < innerHeight;
  tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  tipEl.style.top = (below ? r.bottom + 8 : r.top - h - 8) + "px";
  tipEl.classList.toggle("up", !below);
}
function tipHide(now) {
  clearTimeout(tipShowT);
  const done = () => { tipEl.hidden = true; tipFor?.removeAttribute("aria-describedby"); tipFor = null; };
  if (now) done(); else { clearTimeout(tipHideT); tipHideT = setTimeout(done, 150); }
}
document.addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch") return;
  if (tipFor && !tipFor.isConnected) tipHide(true);  // its button was re-drawn away: the tip goes with it
  if (e.target === tipEl) { clearTimeout(tipHideT); return; }
  const el = e.target.closest?.("[title], [data-tip]");
  if (!el || el === tipFor) return;
  tipText(el);
  clearTimeout(tipShowT); tipShowT = setTimeout(() => tipShow(el), tipEl.hidden ? 450 : 60);
});
document.addEventListener("pointerout", (e) => {
  const to = e.relatedTarget;
  if (to && (to === tipEl || tipFor?.contains(to))) return;
  if (e.target === tipEl || tipFor?.contains(e.target) || e.target.closest?.("[data-tip]")) tipHide(false);
});
document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[title], [data-tip]"); if (el && el.matches(":focus-visible")) { clearTimeout(tipShowT); tipShowT = setTimeout(() => tipShow(el), 300); } });
document.addEventListener("focusout", () => tipHide(true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !tipEl.hidden) tipHide(true); });
document.addEventListener("pointerdown", () => tipHide(true));


