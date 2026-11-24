/**
 * FILE: server/problems.mjs
 * PURPOSE: What went wrong, kept until it is fixed. The bell's notes pass by (a page that was closed never sees them);
 *          a problem stays in <STUDIO_HOME>/problems.json and in the page's Problems list until its cause is gone.
 * OVERVIEW: findProblems() looks at the studio's data as it is now (bookings, approvals, long videos, sign-ins) and
 *           returns what is wrong; it is pure and tested. readErrors() reads the numbers collector's own files for the
 *           last sign-in error of each network (no new request), for the "signed out" check. A store merges those with one-off events (a version that could not be
 *           used, a project switch), keeps first/last seen, drops a checked problem once its cause is gone, and lets a
 *           person dismiss what may be dismissed.
 * LEVELS: red = broken: something will not happen (a post, a render) until it is fixed, or is about to; amber = it
 *         will become a problem (a sign-in that ends in two weeks) or happens worse than it could; info = worth
 *         knowing. A red problem about the future cannot be dismissed, only fixed (a sign-in, red or amber, neither).
 * Found 13 Nov: a reel left unapproved by a failed "Use the new version", 13 long videos that repeated days, and a
 * project switch, all of which the studio never showed.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RANK = { red: 0, amber: 1, info: 2 };
const SENT = new Set(["scheduled", "queued", "planned"]);
const MISSED = new Set(["failed", "missed", "missing"]);  // "missing": booked, but not seen live hours later (py/studio/live.py)
const HOLDS = new Set(["scheduled", "queued", "posted"]);  // a booking made again after a miss that still stands (or went out)
const NET = { youtube: "YouTube", facebook: "Facebook", bluesky: "Bluesky", x: "X", tiktok: "TikTok", linkedin: "LinkedIn",
  gbp: "Google Maps", "line-oa": "LINE", pinterest: "Pinterest", threads: "Threads", instagram: "Instagram", "instagram-story": "Instagram Stories" };
const netName = (n) => NET[n] || n;
// Where a person checks a post with their own eyes, per network (the post's own link wins when the studio has one).
const LOOK = { gbp: "https://business.google.com/locations", x: "https://x.com/compose/post/unsent/scheduled",
  tiktok: "https://www.tiktok.com/tiktokstudio/content", linkedin: "https://www.linkedin.com/feed/", "line-oa": "https://manager.line.biz/",
  facebook: "https://business.facebook.com/latest/content_calendar", youtube: "https://studio.youtube.com/" };
// Where to see why a network shows nobody the posts.
const REACH = { tiktok: { label: "Open TikTok Studio", href: "https://www.tiktok.com/tiktokstudio" },
  facebook: { label: "Open Meta Business Suite insights", href: "https://business.facebook.com/latest/insights/" },
  bluesky: { label: "Open your Bluesky profile", href: "https://bsky.app/profile/me" },
  x: { label: "Open X analytics", href: "https://x.com/i/account_analytics" } };
const DAY = 86400e3;

const when = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : String(iso || "");
};
/* The same in Japanese: every problem carries `ja` {title, detail, fix, also} and the page shows it when it is in Japanese. */
const whenJa = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : String(iso || "");
};
const REACH_JA = { tiktok: "TikTok Studioを開く", facebook: "Meta Business Suiteのインサイトを開く", bluesky: "Blueskyのプロフィールを開く", x: "Xのアナリティクスを開く" };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const listNums = (ns) => (ns.length <= 1 ? String(ns[0] ?? "") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** A reel's review status, as approvalRefusal reads it: "story-<slug>" first, then the bare slug. */
function statusOf(reviews, slug) {
  const row = reviews.find((r) => r?.slug === `story-${slug}`) || reviews.find((r) => r?.slug === slug);
  return row ? row.status : null;
}

/**
 * The problems that are true now. posts: /api/posts rows; reviews: review-list rows; parts: /api/vlogs parts.
 * Returns [{ id, level, title, detail, fix: { label, href }, dismissable }].
 */
/* AI blocks by name (the same words as the Workflow page). */
const CAP = { voice: ["Voice-over", "ナレーション"], music: ["Music", "音楽"], sfx: ["Natural sound", "環境音"], upscale: ["Sharpen", "高画質化"],
  slowmo: ["Slow motion", "スローモーション"], img2video: ["Moving photo", "写真を動かす"], "bg-cut": ["Cut-out", "切り抜き"], llm: ["Writing help", "文章の手伝い"], vision: ["AI review", "AIチェック"] };
const capList = (caps, ja) => (caps || []).map((c) => (CAP[c] || [c, c])[ja ? 1 : 0]).join(ja ? "、" : ", ");
const nList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * An AI service that is out of credit or whose key is refused, from py/studio/fallback.py's health view (problems):
 * amber when every block that uses it has a backup that takes over, red when some have none. Fixed, not dismissed:
 * "Try X again" (fix.action) clears the mark; "Top up" (also) opens the service's billing page.
 */
export function aiHealthProblems(health) {
  const out = [];
  for (const p of health?.problems || []) {
    const credit = p.kind === "out_of_credit", name = p.name || p.provider, red = p.level === "red";
    const used = (p.switched || []).map((s) => `${s.n} job${s.n === 1 ? "" : "s"} used ${s.name}`), usedJa = (p.switched || []).map((s) => `${s.n}件を${s.name}で`);
    const backups = (health?.providers || []).filter((x) => (p.backups || []).includes(x.id)).map((x) => x.name);
    const what = credit ? "is out of credit" : "did not accept its key", whatJa = credit ? "のクレジットがなくなりました" : "のキーが受け付けられませんでした";
    const title = red ? `${name} ${what} and no other service is set up for ${capList(p.noBackup, false)}`
      : used.length ? `${name} ${what}, so ${nList(used)} instead` : `${name} ${what}: ${nList(backups) || "a backup service"} takes over`;
    const titleJa = red ? `${name}${whatJa}。${capList(p.noBackup, true)}にはほかのサービスがありません`
      : usedJa.length ? `${name}${whatJa}。代わりに${usedJa.join("、")}作りました` : `${name}${whatJa}。${backups.join("、") || "予備のサービス"}が代わりに動きます`;
    const until = credit && p.until ? new Date(p.until * 1000) : null;
    const hm = (L) => until.toLocaleTimeString(L, { hour: "2-digit", minute: "2-digit" });
    const detail = `${capList(p.caps, false)} ${p.caps?.length === 1 ? "uses" : "use"} ${name}. ${red ? `Until it is back, ${capList(p.noBackup, false)} will not run: choose another service for them, give one a key, or turn them off on Settings › AI blocks${(p.noBackup || []).includes("voice") ? " (Voice-over switches only when you turn it on, because another service changes the voice)" : ""}.` : "Every block that uses it goes straight to its backup."} ${credit ? `${name} is asked first again ${until ? `after ${hm("en-GB")}` : "later"}, or now with Try again.` : "Paste a fresh key on Settings › Keys & AI; the studio asks it again once the key changes."}`;
    const detailJa = `${capList(p.caps, true)}は${name}を使っています。${red ? `戻るまで${capList(p.noBackup, true)}は動きません。設定 › AIブロックで、ほかのサービスを選ぶ、キーを入れる、またはオフにしてください${(p.noBackup || []).includes("voice") ? "（ナレーションは声が変わるので、自分でオンにしたときだけ切り替わります）" : ""}。` : "使っているブロックはすべて、そのまま予備のサービスで動きます。"}${credit ? `${until ? `${hm("ja-JP")}以降は` : "しばらくしたら"}また${name}を先に使います。「もう一度試す」ですぐ戻すこともできます。` : "設定 › キーとAIで新しいキーを貼ってください。キーが変わると、また使います。"}`;
    // Red: some blocks have no other service, so "try again" leads nowhere. Send the person to AI blocks, where each
    // held-up block can be switched, given a key or turned off (21 Nov: fal ran dry and the strip only offered a retry).
    out.push({
      id: `ai:${p.provider}`, level: red ? "red" : "amber", title, detail,
      fix: red ? { label: "Choose another service", href: "#/keys/blocks" }
        : { label: `Try ${name} again`, href: "#/keys/blocks", action: { ai: "retry", provider: p.provider } },
      ...(p.billing ? { also: { label: credit ? "Top up" : `Open ${name}`, href: p.billing } } : {}),
      dismissable: false,
      ja: { title: titleJa, detail: detailJa, fix: red ? "ほかのサービスを選ぶ" : `${name}をもう一度試す`, ...(p.billing ? { also: credit ? "チャージする" : `${name}を開く` } : {}) },
    });
  }
  return out;
}

/**
 * Networks that show nobody the posts, by the planner's own rule (perf.reach `stalled`: 3+ measured posts, 2+ days out,
 * all at nothing, on the account in use now). One source, so Needs you and Plan posts never disagree (24 Nov: Needs you
 * said TikTok was unseen while planning kept booking it, and the 0s were on an account deleted that day).
 */
export function reachProblems(reach, { paused = true } = {}) {
  const out = [];
  for (const v of reach?.networks || []) {
    if (!v?.stalled) continue;
    const n = v.network, name = netName(n), m = Number(v.measured) || 0;
    const metric = v.hasViews === false ? "likes, reposts or replies" : "views", metricJa = v.hasViews === false ? "いいね・リポスト・返信" : "再生";
    const fresh = v.accountSince ? ` on the account in use since ${when(v.accountSince)}` : "", freshJa = v.accountSince ? `（${whenJa(v.accountSince)}からのアカウント）` : "";
    out.push({
      id: `reach:${n}`, level: "amber", group: "numbers",
      title: paused ? `${name} is not showing your posts: booking it is paused` : `${name} is not showing your posts`,
      detail: `All ${m} ${name} posts measured${fresh} have 0 ${metric}, the oldest ${Math.round((Number(v.oldestH) || 0) / 24)} days out. A new account, a restricted account or a missing profile often does this; so can a number the studio cannot read. ${paused ? `Plan posts books no new ${name} posts until one is seen (posts already booked stay). ` : ""}Check the account on ${name} and compare its own numbers.`,
      fix: { label: "See reach on Results", href: "#/results" }, ...(REACH[n] ? { also: REACH[n] } : {}), dismissable: true,
      ja: { title: paused ? `${name}が投稿を表示していません：予約を止めています` : `${name}が投稿を表示していません`,
        detail: `計測した${name}の投稿${m}件${freshJa}は、どれも${metricJa}が0です（いちばん古いものは${Math.round((Number(v.oldestH) || 0) / 24)}日前）。新しいアカウント、制限されたアカウント、プロフィールが未設定のときによく起きます。スタジオが数字を読めていない場合もあります。${paused ? `1件でも見られるまで、自動の予約は${name}に新しい投稿を入れません（予約済みはそのまま）。` : ""}${name}でアカウントを確かめ、そちらの数字と比べてください。`,
        fix: "結果で届き方を見る", ...(REACH_JA[n] ? { also: REACH_JA[n] } : {}) },
    });
  }
  return out;
}

/* Jobs that read numbers (views, likes): when one stops, nothing you made is affected and nothing fails to post;
   the numbers wait for the next read. Their own group ("Numbers") and fix, not "Making stopped" with a render fix
   (24 Nov: "Reading view numbers did not finish" said "Open the reel and press Save & render again"). */
export const isNumbersJob = (slug = "") => /^(helper-perf|perf)(-|$)/.test(String(slug));
/** The problem for a numbers job that ended in an error: amber (only numbers are late), see the log, check the Chrome link. */
export function numbersJobProblem(slug, { detail = "", detailJa = "" } = {}) {
  const chrome = slug === "helper-perf";
  return {
    id: `job:${slug}`, level: "amber", group: "numbers",
    title: chrome ? "Reading view numbers in your Chrome did not finish" : "Reading the numbers did not finish",
    detail: `${detail ? `${detail} ` : ""}Nothing you made or booked is affected: the numbers are read again next hour.${chrome ? " They are read in your Chrome, so keep it open with the helper linked (Settings › Accounts)." : ""}`.trim(),
    fix: { label: "See the log", href: "#/log/activity" },
    ...(chrome ? { also: { label: "Check the Chrome link", href: "#/accounts" } } : {}),
    dismissable: true,
    ja: { title: chrome ? "Chromeでの再生数の読み取りが終わりませんでした" : "数字の読み取りが終わりませんでした",
      detail: `${detailJa || detail ? `${detailJa || detail} ` : ""}作ったものや予約には影響ありません。数字は次の1時間でまた読みます。${chrome ? "読み取りはChromeで行うので、ヘルパーをつないだまま開いておいてください（設定 › アカウント）。" : ""}`.trim(),
      fix: "ログを見る", ...(chrome ? { also: "Chromeとのつながりを確かめる" } : {}) },
  };
}

export function findProblems({ posts = [], reviews = [], parts = [], connections = {}, perf = null, reach = null, aiHealth = null, readErrors = {}, now = Date.now() } = {}) {
  const out = [];
  // 1. Booked, but the reel is not approved: the studio posts and swaps only approved reels. Photo-post Stories are not
  //    reels and have no review: their gate is the face check at booking (py/studio/stills.py, BL-095), and they go out
  //    without an approval (24 Nov: every booked photo set showed as "booked but not approved").
  const ahead = posts.filter((p) => SENT.has(p.status) && Date.parse(p.at) > now && !/^vlog-/.test(p.slug || "") && p.network !== "photo-story");
  const bySlug = new Map();
  for (const p of ahead) (bySlug.get(p.slug) || bySlug.set(p.slug, []).get(p.slug)).push(p);
  for (const [slug, list] of bySlug) {
    const st = statusOf(reviews, slug);
    if (st === "approved") continue;
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = list[0];
    out.push({
      id: `unapproved:${slug}`, level: "red",
      title: `${slug} is booked but not approved`,
      detail: `${list.length} booked post${list.length === 1 ? "" : "s"}, the next on ${first.network} at ${when(first.at)}. The studio only posts and updates approved reels, so ${list.length === 1 ? "it waits" : "they wait"} until you approve it${st ? ` (now "${st}")` : ""}. If it shows people, press Consent OK first.`,
      fix: { label: "Open the reel", href: `#/reel/${slug}` }, dismissable: false,
      ja: { title: `${slug}は予約済みですが、まだ承認されていません`,
        detail: `予約済みの投稿${list.length}件、次は${first.network}で${whenJa(first.at)}。スタジオは承認済みのリールだけを投稿・更新するので、承認するまで待ちます${st ? `（今は「${st}」）` : ""}。人が映っている場合は、先に「同意OK」を押してください。`,
        fix: "リールを開く" },
    });
  }
  // 2. Posts that did not go out in the last two weeks, unless the same reel was booked again on the same network and
  //    that booking stands or went out (24 Nov: focus-1108-3 stayed red on Bluesky after it was booked again as row 343).
  for (const p of posts) {
    const t = Date.parse(p.at);
    if (!MISSED.has(p.status) || !(t > now - 14 * DAY) || t > now) continue;
    if (posts.some((o) => o !== p && o.slug === p.slug && o.network === p.network && HOLDS.has(o.status) && Date.parse(o.at) >= t)) continue;
    const missing = p.status === "missing", look = /^https?:\/\//.test(p.url || "") ? p.url : LOOK[p.network];
    out.push({
      id: `missed:${p.id ?? `${p.slug}:${p.network}:${p.at}`}`, level: "red",
      title: missing ? `${p.slug} may not be live on ${netName(p.network)}` : `${p.slug} did not go out on ${netName(p.network)}`,
      detail: missing
        ? `It was booked for ${when(p.at)}, and the studio has not found it live since${p.note ? ` (${String(p.note).slice(0, 140)})` : ""}. Look on ${netName(p.network)}: if it is there, press "It's out" on Posting; if not, book it again.`
        : `It was booked for ${when(p.at)}${p.note ? `: ${String(p.note).slice(0, 160)}` : ""}. Book it again, or post it by hand.`,
      fix: { label: "See Posting", href: "#/posting" },
      ...(missing && look ? { also: { label: `Look on ${netName(p.network)}`, href: look } } : {}),
      dismissable: true,
      ja: { title: missing ? `${p.slug}は${netName(p.network)}で公開されていないかもしれません` : `${p.slug}は${netName(p.network)}に投稿されませんでした`,
        detail: missing
          ? `${whenJa(p.at)}に予約していましたが、公開を確認できていません${p.note ? `（${String(p.note).slice(0, 140)}）` : ""}。${netName(p.network)}で確かめて、出ていれば「投稿」で「公開済み」を押し、出ていなければ予約し直してください。`
          : `${whenJa(p.at)}に予約していました${p.note ? `：${String(p.note).slice(0, 160)}` : ""}。予約し直すか、手動で投稿してください。`,
        fix: "投稿を見る", also: `${netName(p.network)}で見る` },
    });
  }
  // 3. Long videos that repeat the same days, or vary a lot in length: viewers see the same moments again, and a
  //    series reads as random (a travel series' parts, 13 Nov).
  const built = parts.filter((p) => Array.isArray(p.days) && p.days.length);
  if (built.length >= 2) {
    const seen = new Map();
    for (const p of built) for (const d of p.days) seen.set(d, [...(seen.get(d) || []), p.n]);
    const shared = [...new Set([...seen.values()].filter((ns) => ns.length > 1).flat())].sort((a, b) => a - b);
    const secs = built.map((p) => Number(p.built?.seconds) || 0).filter((s) => s > 0);
    const lo = Math.min(...secs), hi = Math.max(...secs);
    const uneven = secs.length >= 3 && lo > 0 && hi / lo >= 2;
    if (shared.length || uneven) {
      const why = [], whyJa = [];
      if (shared.length) { why.push(`parts ${listNums(shared)} show some of the same days`); whyJa.push(`パート${shared.join("・")}に同じ日が入っています`); }
      if (uneven) { why.push(`lengths run from ${mmss(lo)} to ${mmss(hi)}`); whyJa.push(`長さが${mmss(lo)}から${mmss(hi)}までばらばらです`); }
      out.push({
        id: "vlog-shape", level: "amber",
        title: "Your long videos do not read as one series",
        detail: `${why.join("; ").replace(/^./, (c) => c.toUpperCase())}. Plan them as a series: each day once, in order, about the same length.`,
        fix: { label: "Long videos", href: "#/videos" }, dismissable: true,
        ja: { title: "長い動画がひとつのシリーズになっていません", detail: `${whyJa.join("。")}。シリーズとして計画してください：各日を一度ずつ、順番に、同じくらいの長さで。`, fix: "長い動画" },
      });
    }
  }
  // 4. A sign-in that ends while posts are still booked after it: those posts would not go out (Bluesky's session
  //    lasts about two weeks; the studio's own check warned only a day ahead, with 29 posts queued past it, 13 Nov).
  for (const [n, c] of Object.entries(connections || {})) {
    const end = Date.parse(c?.until || "");
    if (!c?.connected || !Number.isFinite(end) || end - now > 14 * DAY) continue;
    const after = posts.filter((p) => p.network === n && SENT.has(p.status) && Date.parse(p.at) > end);
    const days = Math.max(0, Math.ceil((end - now) / DAY));
    if (!after.length && end - now > 3 * DAY) continue;
    out.push({
      // Red only once it is broken or about to be (signed out, or 3 days left with posts booked after it, or a day left):
      // two weeks ahead it is amber, a heads-up (owner, 17 Nov: "Bluesky signs out in 14 days" was red). Either way it
      // is about the future and cannot be dismissed, only fixed.
      id: `signin:${n}`, level: end <= now || end - now < DAY || (after.length && end - now <= 3 * DAY) ? "red" : "amber",
      title: end <= now ? `${netName(n)} is signed out` : `${netName(n)} signs out in ${days} day${days === 1 ? "" : "s"}`,
      detail: `${end <= now ? "The sign-in ended" : "The sign-in ends"} ${when(c.until)}.${after.length ? ` ${after.length} booked post${after.length === 1 ? "" : "s"} after that will not go out until you sign in again.` : ""} Sign in again on Settings › Accounts: it takes a minute.${n === "bluesky" ? " Signing in with an App password instead (Bluesky › Settings › Privacy and security › App passwords) does not run out." : ""}`,
      fix: { label: `Sign in to ${netName(n)} again`, href: "#/accounts" }, dismissable: false,
      ja: { title: end <= now ? `${netName(n)}のサインインが切れています` : `${netName(n)}のサインインはあと${days}日で切れます`,
        detail: `サインインは${whenJa(c.until)}に${end <= now ? "切れました" : "切れます"}。${after.length ? `それ以降の予約投稿${after.length}件は、サインインし直すまで投稿されません。` : ""}設定 › アカウントでサインインし直してください（1分ほどです）。${n === "bluesky" ? "代わりにアプリパスワード（Bluesky › 設定 › プライバシーとセキュリティ › アプリパスワード）でサインインすると、期限切れになりません。" : ""}`,
        fix: `${netName(n)}にもう一度サインイン` },
    });
  }
  // 5. A network where the posts measured so far reached nobody: worth a look on the network itself (a new or
  //    restricted account, or a number the studio cannot read). With `reach` (py/studio/perf.py reach(): the rule the
  //    planner skips a network by, counting only the account in use now) this says exactly what Plan posts does.
  if (reach?.networks) out.push(...reachProblems(reach, { paused: reach.paused !== false }));
  else for (const [n, v] of Object.entries(perf?.networks || {})) {
    // A median of 0 is not "nobody": the summary's `silent` says whether every measured post got nothing (17 Nov: one
    // Facebook reel at 100 views, six at 0-1, and this said all seven had 0 views).
    if (!(Number(v?.posts) >= 2) || Number(v?.median) !== 0 || v?.silent === false) continue;
    const metric = v.metric === "engagements" ? "likes, reposts or replies" : "views";
    out.push({
      id: `reach:${n}`, level: "amber",
      title: `Your ${netName(n)} posts are not being seen yet`,
      detail: `The ${v.posts} ${netName(n)} posts measured so far have 0 ${metric} about three days after they went out. A new account, a restricted account or a missing profile often does this; so can a number the studio cannot read. Check the account on ${netName(n)}, and compare its own numbers.`,
      fix: { label: "Results", href: "#/results" }, ...(REACH[n] ? { also: REACH[n] } : {}), dismissable: true,
      ja: { title: `${netName(n)}の投稿がまだ見られていません`,
        detail: `これまでに計測した${netName(n)}の投稿${v.posts}件は、公開から約3日たっても${v.metric === "engagements" ? "いいね・リポスト・返信" : "再生"}が0です。新しいアカウント、制限されたアカウント、プロフィールが未設定のときによく起きます。スタジオが数字を読めていない場合もあります。${netName(n)}でアカウントを確かめ、そちらの数字と比べてください。`,
        fix: "結果", ...(REACH_JA[n] ? { also: REACH_JA[n] } : {}) },
    });
  }
  // 6. An AI service that ran out of credit or refused its key (py/studio/fallback.py): which blocks switched, which
  //    have no backup (owner, 18 Nov: "if I run out of fal.ai auto switch to others for all workflow in the block").
  out.push(...aiHealthProblems(aiHealth));
  // 7. A connected account whose sign-in stopped working: nothing new goes out there and no numbers are read.
  //    24 Nov: YouTube's refresh token died (invalid_grant: the Google app was in Testing mode, 7-day sign-ins) and
  //    Results said so, but this list said nothing.
  out.push(...signedOut(connections, readErrors, posts, now).filter((x) => !out.some((o) => o.id === x.id)));
  return sort(out);
}

const AUTH_RX = /invalid_grant|expired|revoked/i;
/**
 * Networks whose sign-in no longer works: a connection that holds an account but says it is not connected and why
 * (connections: Facebook, Bluesky, Instagram Stories), or the numbers collector's last error there being a sign-in
 * error (readErrors, from readErrors(): YouTube's token refresh). Red, not dismissable: fixed by connecting again.
 */
export function signedOut(connections = {}, readErrors = {}, posts = [], now = Date.now()) {
  const dead = new Map();
  for (const [n, c] of Object.entries(connections || {})) if (c && !c.connected && c.account && c.error) dead.set(n, { error: String(c.error), at: null });
  for (const [n, e] of Object.entries(readErrors || {})) {
    if (e?.error && !dead.has(n) && (e.code === "auth" || AUTH_RX.test(e.error))) dead.set(n, { error: String(e.error), at: e.at || null });
  }
  if (dead.has("facebook")) dead.delete("instagram-story");  // Stories use the Facebook sign-in: one fix, one problem
  const out = [];
  for (const [n, e] of dead) {
    const yt = n === "youtube", name = netName(n), grant = /invalid_grant/i.test(e.error);
    const nets = n === "facebook" ? ["facebook", "instagram-story"] : [n];
    const ahead = posts.filter((p) => nets.includes(p.network) && Date.parse(p.at) > now);
    const onNet = ahead.filter((p) => p.status === "scheduled").length;  // already handed to the network's own scheduler
    const waiting = ahead.filter((p) => p.status === "queued").length;   // the studio sends these itself, at their time
    const err = e.error.replace(/\s+/g, " ").slice(0, 200);
    const thing = yt ? "Short" : "post", s = (k) => (k === 1 ? "" : "s");
    const detail = `The studio's ${name} sign-in stopped working${e.at ? ` (${when(e.at)})` : ""}: ${err}. `
      + (onNet ? `${onNet} ${thing}${s(onNet)} already booked on ${name} itself still ${onNet === 1 ? "publishes" : "publish"} at ${onNet === 1 ? "its" : "their"} time. `
        : yt ? "Shorts already booked on YouTube itself still publish at their time. " : "")
      + `${waiting ? `${waiting} booked ${thing}${s(waiting)} waiting to ${yt ? "upload" : "go out"} will not, ` : `Nothing new ${yt ? "uploads" : "goes out"}, `}and no numbers are read, until you connect ${name} again on Settings › Accounts.`
      + (n === "facebook" ? " Instagram Stories use the same sign-in, so they stop too." : "")
      + (grant && yt ? " The usual cause: the Google app is still in Testing mode, where Google ends every sign-in after 7 days. To stop it happening again, open Google Cloud › Google Auth Platform › Audience and press Publish app, then press Connect YouTube again." : "");
    const detailJa = `スタジオの${name}へのサインインが使えなくなりました${e.at ? `（${whenJa(e.at)}）` : ""}：${err}。`
      + (onNet ? `${name}側で予約済みの${onNet}件は、予定どおり公開されます。` : yt ? "YouTube側で予約済みのショートは、予定どおり公開されます。" : "")
      + `${waiting ? `${yt ? "アップロード" : "投稿"}を待っている予約${waiting}件は出ず、` : `新しい${yt ? "アップロード" : "投稿"}は出ず、`}数字も読めません。設定 › アカウントで${name}にもう一度接続してください。`
      + (n === "facebook" ? "Instagramストーリーズも同じサインインを使うので止まります。" : "")
      + (grant && yt ? "よくある原因：Googleアプリが「テスト」モードのままだと、サインインは7日で切れます。Google Cloud › Google Auth Platform › 対象 で「アプリを公開」を押してから、もう一度「YouTubeに接続」を押すと、切れなくなります。" : "");
    out.push({
      id: `signin:${n}`, level: "red",
      title: `${name} is signed out: nothing new ${yt ? "uploads" : "goes out"} and no numbers are read`,
      detail, fix: { label: yt ? "Connect YouTube again" : `Sign in to ${name} again`, href: "#/accounts" },
      ...(grant && yt ? { also: { label: "Open Google Auth Platform", href: "https://console.cloud.google.com/auth/audience" } } : {}),
      dismissable: false,
      ja: { title: `${name}のサインインが切れています：新しい${yt ? "アップロード" : "投稿"}は出ず、数字も読めません`, detail: detailJa,
        fix: yt ? "YouTubeにもう一度接続" : `${name}にもう一度サインイン`, ...(grant && yt ? { also: "Google Auth Platformを開く" } : {}) },
    });
  }
  return out;
}

/* Which token file under <data>/secrets holds each network's sign-in (py/studio/youtube.py, connectors/*.py). */
const TOKEN = { youtube: "youtube_token.bin", facebook: "facebook.bin", "instagram-story": "facebook.bin", bluesky: "bluesky.bin" };
/**
 * The last error each network's numbers read hit, from the collector's own files (py/studio/perf.py): perf/state.json
 * `problems` (kept until a read of that network works) and perf/channel.json (the YouTube channel read, per account).
 * No new request. An error is dropped when the network's token file is gone (disconnected on purpose) or newer than
 * the error (connected again since), and YouTube's when a later channel read worked. Returns { network: { error, code, at } }.
 */
export function readErrors(dataDir) {
  const json = (f) => { try { return JSON.parse(readFileSync(join(dataDir, "perf", f), "utf8")); } catch { return null; } };
  const out = { ...(json("state.json")?.problems || {}) };
  const ch = json("channel.json");
  if (ch?.at && Array.isArray(ch.channels) && ch.channels.length && !(Date.parse(out.youtube?.at) > Date.parse(ch.at))) {
    const bad = ch.channels.find((c) => c?.error);
    if (bad) out.youtube = { error: String(bad.error), code: AUTH_RX.test(String(bad.error)) ? "auth" : null, at: ch.at, account: bad.account };
    else delete out.youtube;
  }
  for (const [n, e] of Object.entries(out)) {
    if (!TOKEN[n]) continue;
    const file = n === "youtube" && e?.account && e.account !== "main" ? `youtube_token-${e.account}.bin` : TOKEN[n];
    let mtime;
    try { mtime = statSync(join(dataDir, "secrets", file)).mtimeMs; } catch { delete out[n]; continue; }
    if (mtime > Date.parse(e?.at || "")) delete out[n];
  }
  return out;
}

export function sort(items) {
  return [...items].sort((a, b) => (RANK[a.level] ?? 3) - (RANK[b.level] ?? 3) || String(a.title).localeCompare(String(b.title)));
}

/** The kept list: checks replaced every run, events kept until they expire or are dismissed.
    saveTo: keep the list in another file, starting from `file` (a look-only studio on the same data must not rewrite
    the running studio's list: STUDIO_QUIET, 24 Nov). */
export function createStore(file, { now = () => Date.now(), saveTo = null } = {}) {
  let state = { items: {} };
  const own = saveTo || file;
  try { state = JSON.parse(readFileSync(file, "utf8")); if (!state.items) state = { items: {} }; } catch { /* first run */ }
  const save = () => {
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(`${own}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${own}.tmp`, own);
  };
  const stamp = () => new Date(now()).toISOString();
  return {
    /** Replace every checked problem with what the checks found now. Returns true when the open list changed. */
    checked(found) {
      const before = JSON.stringify(this.open());
      const ids = new Set(found.map((f) => f.id));
      for (const [id, it] of Object.entries(state.items)) if (it.source === "check" && !ids.has(id)) delete state.items[id];
      for (const f of found) {
        const old = state.items[f.id];
        state.items[f.id] = { ...f, source: "check", first: old?.first || stamp(), last: stamp(), dismissed: old?.dismissed && old.detail === f.detail ? old.dismissed : null };
      }
      save();
      return JSON.stringify(this.open()) !== before;
    },
    /** A one-off problem (it has no check to clear it): kept for `days`, or until dismissed. */
    record(item, days = 7) {
      const old = state.items[item.id];
      state.items[item.id] = { dismissable: true, ...item, source: "event", first: old?.first || stamp(), last: stamp(), count: (old?.count || 0) + 1,
        expires: new Date(now() + days * DAY).toISOString(), dismissed: null };
      save();
    },
    /** An event that is over (the same job finished fine later): gone from the list. Returns whether it was there. */
    clear(id) {
      if (!state.items[id] || state.items[id].source !== "event") return false;
      delete state.items[id]; save();
      return true;
    },
    dismiss(id) {
      const it = state.items[id];
      if (!it) return "missing";
      if (!it.dismissable) return false;
      it.dismissed = stamp(); save();
      return true;
    },
    open() {
      const t = now();
      return sort(Object.values(state.items).filter((it) => !it.dismissed && !(it.expires && Date.parse(it.expires) < t)));
    },
  };
}
