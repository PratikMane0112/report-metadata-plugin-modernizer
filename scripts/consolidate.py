#!/usr/bin/env python3
import csv as csv_module
import hashlib, json, os, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

INPUT_BASE     = Path(os.environ.get("INPUT_DIR",  ".")).resolve()
OUTPUT_BASE    = Path(os.environ.get("OUTPUT_DIR", "/tmp/plugin-modernizer-stats")).resolve()
MAX_ERROR_RATE = float(os.environ.get("MAX_ERROR_RATE", "0.02"))

SUMMARY_JSON = INPUT_BASE / "reports" / "summary.json"
RECIPES_SRC  = INPUT_BASE / "reports" / "recipes"

EXCLUDED_DIRS = frozenset([".github", "reports", ".git", "scripts"])

error_count        = 0
plugin_error_count = 0


class ParseError(Exception):
    pass


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}")


def warn(msg, is_plugin_error=False):
    global error_count, plugin_error_count
    print(f"[WARN] {msg}", file=sys.stderr)
    error_count += 1
    if is_plugin_error:
        plugin_error_count += 1


def parse_timestamp(raw):
    for fmt in (
        "%Y-%m-%d %H:%M:%S %Z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
    ):
        try:
            dt = datetime.strptime(raw.strip(), fmt)
            return dt.replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw.strip().replace("Z", "+00:00")).isoformat()
    except ValueError:
        raise ParseError(f"Cannot parse timestamp: {raw!r}")


# ── Parse summary.json ────────────────────────────────────────────────────────

def parse_summary_json(sha256):
    """
    Read reports/summary.json and map its fields to the report.json structure.
    All summary-level data comes directly from the upstream file — no derivation.
    """
    try:
        raw = json.loads(SUMMARY_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise ParseError(f"Cannot read/parse {SUMMARY_JSON}: {e}")

    # ── Validate required fields ──────────────────────────────────────────────
    required = ["generatedOn", "totalMigrations", "failedMigrations",
                "successRate", "pullRequestStats"]
    missing = [f for f in required if f not in raw]
    if missing:
        raise ParseError(f"Missing required fields in summary.json: {missing}")

    ps = raw["pullRequestStats"]
    for k in ("total", "open", "closed", "merged", "mergeRate"):
        if k not in ps:
            raise ParseError(f"Missing pullRequestStats.{k} in summary.json")

    generated_at = parse_timestamp(raw["generatedOn"])
    total = int(raw["totalMigrations"])
    failed = int(raw["failedMigrations"])
    rate = float(raw["successRate"])

    if failed > total:
        raise ParseError(
            f"failedMigrations ({failed}) > totalMigrations ({total})"
        )
    if not (0.0 <= rate <= 100.0):
        raise ParseError(f"successRate {rate} not in [0, 100]")

    return {
        "schemaVersion": "1.0",
        "generatedAt":   generated_at,
        "dataSource":    "https://github.com/jenkins-infra/metadata-plugin-modernizer",
        "meta": {
            "source_sha256": sha256,
            "parsed_at":     datetime.now(timezone.utc).isoformat(),
        },
        "overview": {
            "totalPlugins":         int(raw.get("totalPlugins", 0)),
            "totalMigrations":      total,
            "successfulMigrations": int(raw.get("successfulMigrations", total - failed)),
            "failedMigrations":     failed,
            "pendingMigrations":    int(raw.get("pendingMigrations", 0)),
            "successRate":          rate,
        },
        "pullRequests": {
            "totalPRs":  int(ps["total"]),
            "openPRs":   int(ps["open"]),
            "closedPRs": int(ps["closed"]),
            "mergedPRs": int(ps["merged"]),
            "mergeRate": float(ps["mergeRate"]),
        },
        "failuresByRecipe":            raw.get("failuresByRecipe", []),
        "pluginsWithFailedMigrations": sorted(raw.get("pluginsWithFailures", [])),
        "timeline":                    raw.get("timeline", []),
        "tags":                        raw.get("tags", []),
    }


# ── Build recipes dict ────────────────────────────────────────────────────────

def build_recipes() -> dict:
    """
    Read every *.json from reports/recipes/ and return a dict keyed by recipeId.

    Each entry embeds the full upstream JSON plus a derived ``pending`` count
    so that both the summary widgets (total/success/fail/pending) and the
    RecipeDetail page (totalApplications, successRate, plugins[]) work from the
    same in-memory object.

    Output shape per recipe (example):
    {
      "recipeId":          "AddPluginsBom",
      "totalApplications": 420,
      "successCount":      378,
      "failureCount":      38,
      "successRate":       90.0,
      "plugins":           [ ... ],   // upstream per-plugin application rows
      "pending":           4          // derived: max(0, total - success - fail)
    }
    """
    recipes = {}
    if not RECIPES_SRC.exists():
        warn("reports/recipes/ not found — recipe data unavailable.")
        return recipes

    for f in sorted(RECIPES_SRC.glob("*.json")):
        try:
            data    = json.loads(f.read_text(encoding="utf-8"))
            rid     = str(data.get("recipeId", f.stem))
            total   = int(data.get("totalApplications", 0))
            success = int(data.get("successCount",      0))
            fail    = int(data.get("failureCount",       0))
            if "successRate" not in data:
                data["successRate"] = round(success / total * 100, 2) if total else 0.0
            recipes[rid] = {
                **data,
                "recipeId": rid,
                "pending":  max(0, total - success - fail),
            }
        except (json.JSONDecodeError, OSError) as e:
            warn(f"Skipping recipe {f.name}: {e}")

    log(f"Built {len(recipes)} recipe entries.")
    return recipes


# ── Read failed_migrations.csv -> list of dicts ───────────────────────────────

def read_failed_migrations_csv(csv_path: Path) -> list:
    """
    Convert failed_migrations.csv to a list of dicts so the frontend
    never needs a CSV parser — everything in report.json is pure JSON.
    """
    rows = []
    try:
        with csv_path.open(encoding="utf-8", newline="") as f:
            for row in csv_module.DictReader(f):
                rows.append(dict(row))
    except OSError as e:
        warn(f"Could not read {csv_path}: {e}")
    return rows


# ── Build plugins dict ────────────────────────────────────────────────────────

def build_plugins() -> tuple:
    """
    Read every plugin directory and return:
      - plugins dict  keyed by pluginId
      - sorted list of plugin names

    Output shape per plugin:
    {
      "sourceUrls": {
        "aggregatedMigrations": "https://github.com/.../blob/main/<plugin>/reports/aggregated_migrations.json",
        "failedMigrations":     "https://github.com/.../blob/main/<plugin>/reports/failed_migrations.csv"
      },
      "aggregatedMigrations":  { ... },   // reports/aggregated_migrations.json
      "failedMigrations":      [ ... ],   // reports/failed_migrations.csv -> JSON
      "modernizationMetadata": [ ... ]    // modernization-metadata/*.json
    }
    """
    UPSTREAM_REPO = "https://github.com/jenkins-infra/metadata-plugin-modernizer"
    UPSTREAM_BRANCH = "main"

    plugins      = {}
    plugin_names = []

    entries = sorted(
        e for e in INPUT_BASE.iterdir()
        if e.is_dir() and e.name not in EXCLUDED_DIRS
    )

    for i, entry in enumerate(entries):
        plugin_id = entry.name
        try:
            plugin_data = {}

            # 1. aggregated_migrations.json
            agg_path = entry / "reports" / "aggregated_migrations.json"
            if agg_path.exists():
                try:
                    plugin_data["aggregatedMigrations"] = json.loads(
                        agg_path.read_text(encoding="utf-8")
                    )
                except json.JSONDecodeError as e:
                    warn(
                        f"Invalid JSON in {agg_path}: {e}",
                        is_plugin_error=True,
                    )

            # 2. failed_migrations.csv -> JSON
            csv_path = entry / "reports" / "failed_migrations.csv"
            plugin_data["failedMigrations"] = (
                read_failed_migrations_csv(csv_path)
                if csv_path.exists() else []
            )

            # GitHub source URLs — only include links for files that exist
            base_url = f"{UPSTREAM_REPO}/blob/{UPSTREAM_BRANCH}/{plugin_id}"
            source_urls = {}
            if agg_path.exists():
                source_urls["aggregatedMigrations"] = f"{base_url}/reports/aggregated_migrations.json"
            if csv_path.exists():
                source_urls["failedMigrations"] = f"{base_url}/reports/failed_migrations.csv"
            if source_urls:
                plugin_data["sourceUrls"] = source_urls

            # 3. modernization-metadata/*.json
            meta_dir = entry / "modernization-metadata"
            if meta_dir.exists():
                meta_records = []
                for mf in sorted(meta_dir.glob("*.json")):
                    try:
                        meta_records.append(
                            json.loads(mf.read_text(encoding="utf-8"))
                        )
                    except json.JSONDecodeError as e:
                        warn(f"Invalid JSON in {mf}: {e}")
                plugin_data["modernizationMetadata"] = meta_records
            else:
                plugin_data["modernizationMetadata"] = []

            # Only include plugin if it has recognisable content
            if plugin_data.get("aggregatedMigrations") or plugin_data["failedMigrations"]:
                plugins[plugin_id]  = plugin_data
                plugin_names.append(plugin_id)
            else:
                warn(
                    f"Plugin '{plugin_id}' had no recognisable content — skipped.",
                    is_plugin_error=True,
                )

        except OSError as e:
            warn(f"Failed to process '{plugin_id}': {e}", is_plugin_error=True)

        if (i + 1) % 50 == 0:
            log(f"  Processed {i + 1}/{len(entries)} plugins…")

    log(f"Built {len(plugin_names)} plugin entries.")
    return plugins, sorted(plugin_names)


# ── Fallback: derive timeline and tags from plugin data ───────────────────────
# Used only when upstream summary.json does not yet include these fields.
# Once generate_reports.py is updated upstream, these will come from summary.json
# directly and this fallback will be skipped.

def build_timeline_and_tags(plugins: dict) -> tuple:
    """
    Derive global migration timeline and tag frequency from the
    in-memory plugins dict.
    """
    months:  dict = {}
    tag_map: dict = {}

    for plugin_data in plugins.values():
        agg = plugin_data.get("aggregatedMigrations") or {}
        for m in agg.get("migrations", []):
            month = str(m.get("timestamp", ""))[:7]
            if len(month) == 7 and month[4] == "-":
                bucket = months.setdefault(month, {"success": 0, "fail": 0})
                if m.get("migrationStatus") == "success":
                    bucket["success"] += 1
                else:
                    bucket["fail"] += 1
            for tag in (m.get("tags") or []):
                tag_map[str(tag)] = tag_map.get(str(tag), 0) + 1

    timeline = [
        {
            "month":   mo,
            "success": int(v["success"]),
            "fail":    int(v["fail"]),
            "total":   int(v["success"] + v["fail"]),
        }
        for mo, v in sorted(months.items())
    ]
    tags = [
        {"tag": t, "count": int(c)}
        for t, c in sorted(tag_map.items(), key=lambda x: (-x[1], x[0]))
    ]
    return timeline, tags


# ── Write single JSON ─────────────────────────────────────────────────────────

def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise RuntimeError(f"Post-write validation failed for {path.name}: {e}")


# ── Validate output ───────────────────────────────────────────────────────────

def validate(report: dict, plugin_names: list):
    failures = []

    def check(label, cond):
        if not cond:
            failures.append(label)
            print(f"FAIL: {label}", file=sys.stderr)

    check("schemaVersion present",   "schemaVersion" in report)
    check("generatedAt present",     "generatedAt"   in report)
    check("overview present",        "overview"      in report)
    check("pullRequests present",    "pullRequests"  in report)
    check("recipes is dict",         isinstance(report.get("recipes"), dict))
    check("plugins is dict",         isinstance(report.get("plugins"), dict))
    check("At least 1 plugin",       len(plugin_names) >= 1)
    check("plugin count matches",
          len(report.get("plugins", {})) == len(plugin_names))

    ov = report.get("overview", {})
    check("totalMigrations is int",  isinstance(ov.get("totalMigrations"),  int))
    check("failedMigrations is int", isinstance(ov.get("failedMigrations"), int))
    check("successRate is float",    isinstance(ov.get("successRate"),      float))
    check("totalPRs is int",
          isinstance(report.get("pullRequests", {}).get("totalPRs"), int))

    if failures:
        sys.exit(1)

    if plugin_names:
        rate = plugin_error_count / len(plugin_names)
        if rate > MAX_ERROR_RATE:
            print(
                f"FAIL: plugin error rate {rate * 100:.1f}% "
                f"> threshold {MAX_ERROR_RATE * 100:.1f}%",
                file=sys.stderr,
            )
            sys.exit(1)

    log("All validations passed.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not INPUT_BASE.exists():
        print(
            f"ERROR: Input directory not found: {INPUT_BASE}\n"
            "Expected INPUT_DIR to be the metadata-plugin-modernizer workspace root.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Clean output directory so stale files are never published
    if OUTPUT_BASE.exists():
        shutil.rmtree(OUTPUT_BASE)
    OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

    # 1. Parse summary.json -> base summary object
    try:
        json_bytes = SUMMARY_JSON.read_bytes()
        summary = parse_summary_json(
            hashlib.sha256(json_bytes).hexdigest(),
        )
    except (ParseError, OSError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # 2. Build recipes dict (keyed by recipeId)
    recipes = build_recipes()

    # 3. Build plugins dict (keyed by pluginId)
    plugins, plugin_names = build_plugins()

    # 4. Fallbacks: fill fields that upstream summary.json may not yet provide
    if summary["overview"]["totalPlugins"] == 0:
        summary["overview"]["totalPlugins"] = len(plugin_names)

    if not summary.get("timeline") or not summary.get("tags"):
        log("timeline/tags not in summary.json — deriving from plugin data.")
        timeline, tags = build_timeline_and_tags(plugins)
        if not summary.get("timeline"):
            summary["timeline"] = timeline
        if not summary.get("tags"):
            summary["tags"] = tags

    if summary["overview"]["pendingMigrations"] == 0 and recipes:
        pending = int(sum(r["pending"] for r in recipes.values()))
        if pending > 0:
            summary["overview"]["pendingMigrations"] = pending

    # 5. Assemble single report.json — everything in one structured object
    report = {
        **summary,
        "recipes":  recipes,
        "plugins":  plugins,
    }

    # 6. Write single output file
    report_path = OUTPUT_BASE / "report.json"
    write_json(report_path, report)
    timeline_count = len(summary.get("timeline", []))
    log(
        f"Wrote report.json — "
        f"{len(plugin_names)} plugins, {len(recipes)} recipes, "
        f"{timeline_count} timeline months."
    )

    # 7. Validate
    validate(report, plugin_names)

    print(
        f"\nDone — {len(plugin_names)} plugins, {len(recipes)} recipes, "
        f"{error_count} warning(s) ({plugin_error_count} plugin-copy error(s)).\n"
        f"Output: {report_path}"
    )


if __name__ == "__main__":
    main()
