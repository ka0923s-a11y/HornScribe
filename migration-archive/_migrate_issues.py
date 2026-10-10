# -*- coding: utf-8 -*-
import json, re, subprocess, sys
from pathlib import Path

REPO = Path(r"C:\\Users\\ka092\\Desktop\\HornScribe")
GH_REPO = "aaw123m/horn"
BT = chr(96)
MAP_FILE = REPO / "_migrate_map.json"
LOG = REPO / "_migrate_issues.log"

def log(msg):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(msg + "\n")
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode("ascii"), flush=True)

def run(args):
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(REPO))
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()

def esc(t):
    return re.sub(r"#(\d+)", BT + r"#\1" + BT, t)

def readf(name):
    if not name:
        return None
    fp = REPO / name
    if not fp.exists() or fp.is_dir():
        return None
    return fp.read_text(encoding="utf-8", errors="replace").strip()

# ---------- issues from dumps ----------
issues = {}
for fname in ["_issues_all.txt", "_issues_closed.txt", "_issues_bug.txt", "_issues.txt"]:
    t = readf(fname) or ""
    for line in t.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0].strip().isdigit():
            num = int(parts[0])
            rec = issues.setdefault(num, {"num": num, "state": "", "title": "", "labels": []})
            st = parts[1].strip().upper()
            if st in ("OPEN", "CLOSED"):
                rec["state"] = st
            if parts[2].strip():
                rec["title"] = parts[2].strip()
            if len(parts) > 3:
                for l in parts[3].split(","):
                    l = l.strip()
                    if l and l not in rec["labels"]:
                        rec["labels"].append(l)

EXTRAS = {
 2: "docs: GitHub Actions を使わないローカルリリース手順/runbook の整備",
 44: "export: MusicXML コードシンボル (<harmony>) エクスポート",
 230: "perf: path-backed source が WebView IPC に全バイト転送する (probe/hash/peaks の native 化)",
 305: "fix(score): kind:file ドロップのスコアタイトルが staged 一時ファイル名になる",
 308: "docs(protocol): transcription params 表が実装と乖離 (vocalIsolation/displayName/texture:chords 欠落)",
 314: "feat(review): ミックス検出時の remedy にボーカル分離での再採譲提案がない",
 316: "feat(backend): vocalIsolation 済みの単音入力を pYIN バックエンドへ解決する",
 318: "feat(ui): キーボードショートカット一覧ヘルプオーバーレイ (F1)",
}
for n, t in EXTRAS.items():
    issues.setdefault(n, {"num": n, "state": "CLOSED", "title": t, "labels": []})

BODY_MAP = {
 141:"_issue_body_wv2.md",147:"_issue_body_retire020.md",149:"_issue_body_stackovf.md",
 153:"_issue_body_nopitch.md",155:"_issue_body_jobstart.md",156:"_issue_body_bb.md",
 148:"_issue_body_devseed.md",125:"_issue_body_renderloop.md",123:"_issue_body_collapse.md",
 127:"_issue_body_jpop.md",129:"_issue_body_mono_frag.md",130:"_issue_body_hard.md",
 131:"_issue_body_swing.md",137:"_issue_body_release.md",138:"_issue_body_plfix.md",
 143:"_issue_body_overlay.md",169:"_issue_body_stem.md",177:"_issue_body_close_bug.md",
 179:"_issue_body_engine_freeze.md",181:"_issue_body_vocal_quality.md",184:"_issue_body_eng1.md",
 185:"_issue_body_eng2.md",186:"_issue_body_eng3.md",189:"_issue_body_uxq.md",
 190:"_issue_body_demucs_addon.md",191:"_issue_body_lowsnr.md",192:"_issue_body_close.md",
 193:"_issue_body_nsis.md",199:"_issue_new.md",201:"_issue_tofu.md",202:"_issue_tempo.md",
 203:"_issue_split.md",210:"_issue_a.txt",211:"_issue_b.txt",212:"_issue_c.txt",
 213:"_issue_d.txt",218:"_issue_requant_poly.md",220:"_issue_marker_density.md",
 222:"_issue_body_222.md",227:"_issue_body_copy.md",229:"_issue_body_mdl.md",
 237:"_issue_marker.md",238:"_issue_leipzig.md",242:"_issue_body_tempo_fold.md",
 244:"_issue_body_accconf.md",245:"_issue_body_grand.md",247:"_issue_body_rtrest.md",
 249:"_issue_body_accomp_flags.md",252:"_issue_oct.md",254:"_issue_short.md",
 256:"_issue_stemev.md",264:"_issue_body_accuracy.md",
 305:".work/issue_body_305.md",308:".work/issue_body_308.md",314:".work/issue_body_314.md",
 316:".work/issue_body_316.md",318:".work/issue_body_318.md",
}

COMMENTS = {
 2:[".work/issue2_close.md"],
 21:[".work/new-issue-1.md",".work/new-issue-2.md",".work/new-issue-3.md",".work/issue21_close.md"],
 44:[".work/issue44_close.md"],
 100:["_issue100_comment.md"],
 130:["_issue130_comment.md"],
 137:["_issue137_close.md"],
 138:["_issue138_close.md"],
 147:["_issue147_close.md"],
 149:["_issue149_close.md"],
 165:["_issue165_update.md","_issue165_verify.md","_issue165_other.md","_issue165_close.md"],
 177:["_issue_177_resolve.md"],
 190:[".work/issue_new_3.md"],
 230:[".work/issue230_close.md"],
 264:["_issue264_comment.md"],
}

# .work/issues.json items (bolph-era, no numbers) -> closed archive entries
wjson = json.loads((REPO / ".work/issues.json").read_text(encoding="utf-8"))
for i, it in enumerate(wjson):
    issues["w" + str(i)] = {"num": None, "state": "CLOSED", "title": it["title"], "labels": [], "body": it["body"], "oldnum": None}

# unfilled drafts -> open, enhancement
issues["new_vocal_cache"] = {"num": None, "state": "OPEN", "title": "vocal 分離ステムキャッシュ (%TEMP%\\hornscribe-vocal-cache) に保持ポリシーがなく無制限に増える", "labels": ["enhancement"], "body_file": ".work/issue_new_0.md", "oldnum": None}
issues["new_dirty_indicator"] = {"num": None, "state": "OPEN", "title": "未保存状態の表示が TitleBar の * のみで気づかれにくい", "labels": ["enhancement"], "body_file": ".work/issue_new_1.md", "oldnum": None}

# labels
run(["gh", "label", "create", "migration", "-R", GH_REPO, "-d", "旧リポジトリからの移行復元", "-c", "BFD4F2"])

# ---------- mapping resume ----------
mapping = {}
if MAP_FILE.exists():
    mapping = json.loads(MAP_FILE.read_text(encoding="utf-8"))

def save_map():
    MAP_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=1), encoding="utf-8")

def issue_body(rec):
    n = rec["num"]
    if n is not None:
        banner = "> **移行復元 issue** — 旧リポジトリ ka0923s-a11y/HornScribe の " + BT + "#" + str(n) + BT + " から復元（旧リポジトリはアカウント停止で消失）。文中の " + BT + "#N" + BT + " 形式の参照はすべて旧リポジトリの番号です。新旧番号の対応表はピン留めの移行インデックスを参照。\n\n"
    else:
        banner = "> **移行復元 issue** — 旧リポジトリ (bolph71656-ai/HornScribe または ka0923s-a11y/HornScribe) のドラフトから復元。旧番号は不明。\n\n"
    body = rec.get("body") or readf(rec.get("body_file") or BODY_MAP.get(n, ""))
    if body:
        return banner + esc(body)
    return banner + "*(本文は旧リポジトリ消失のため復旧できませんでした。タイトル・状態・ラベルのみの復元です。)*"

TMP = REPO / "_migrate_tmp.md"
created_order = sorted([k for k in issues if isinstance(k, int)]) + [k for k in issues if not isinstance(k, int)]
for key in created_order:
    rec = issues[key]
    skey = str(key)
    if skey in mapping:
        log("SKIP " + skey + " -> " + str(mapping[skey]["new"]))
        continue
    body = issue_body(rec)
    TMP.write_text(body, encoding="utf-8")
    args = ["gh", "issue", "create", "-R", GH_REPO, "--title", rec["title"], "--body-file", str(TMP), "--label", "migration"]
    for l in rec["labels"]:
        args += ["--label", l]
    rc, out = run(args)
    if rc != 0:
        log("FAIL-CREATE " + skey + " : " + out[:300])
        continue
    m = re.search(r"/issues/(\d+)", out)
    newnum = int(m.group(1)) if m else None
    mapping[skey] = {"new": newnum, "title": rec["title"], "state": rec["state"], "old": rec["num"]}
    save_map()
    log("CREATE " + skey + " -> #" + str(newnum) + " " + rec["title"][:60])
    if rec["state"] == "CLOSED" and newnum:
        rc2, o2 = run(["gh", "issue", "close", "-R", GH_REPO, "-r", "completed", str(newnum)])
        log("  close rc=" + str(rc2))
    for cf in COMMENTS.get(key, []):
        cfpath = str(REPO / cf.replace("../", ""))
        fp = Path(cfpath)
        if not fp.exists():
            log("  comment-missing " + cf)
            continue
        cbody = "> 移行復元コメント（旧 issue " + BT + "#" + str(key) + BT + " へのコメントを再掲）\n\n" + esc(fp.read_text(encoding="utf-8", errors="replace"))
        TMP.write_text(cbody, encoding="utf-8")
        rc3, o3 = run(["gh", "issue", "comment", "-R", GH_REPO, "--body-file", str(TMP), str(newnum)])
        log("  comment " + cf + " rc=" + str(rc3))

# issue165 special: full view json with body + comments
v = json.loads((REPO / "_issue165_view.json").read_text(encoding="utf-8"))
key = 165
skey = "165"
if skey in mapping:
    newnum = mapping[skey]["new"]
    # patch body to the original
    banner = "> **移行復元 issue** — 旧 " + BT + "#165" + BT + " の本文・コメントを復元（旧リポジトリ消失）。\n\n"
    TMP.write_text(banner + esc(v["body"]), encoding="utf-8")
    rc, out = run(["gh", "issue", "edit", "-R", GH_REPO, str(newnum), "--body-file", str(TMP)])
    log("  165 body-edit rc=" + str(rc))
    for c in v.get("comments", []):
        cb = "> 移行復元コメント (by " + c.get("author", {}).get("login", "?") + ", " + c.get("createdAt", "") + ")\n\n" + esc(c.get("body", ""))
        TMP.write_text(cb, encoding="utf-8")
        rc3, o3 = run(["gh", "issue", "comment", "-R", GH_REPO, "--body-file", str(TMP), str(newnum)])
        log("  165 comment rc=" + str(rc3))

log("ALL-DONE")
