#!/usr/bin/env bash
set -euo pipefail

# ── Logging ──────────────────────────────────────────────────────────────────
log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# ── Configuration ────────────────────────────────────────────────────────────
ZIP_URL="https://github.com/jenkins-infra/metadata-plugin-modernizer/archive/refs/heads/main.zip"
TMP_DIR=".tmp"
ZIP_FILE="metadata-plugin-modernizer.zip"
ETAG_FILE="${TMP_DIR}/.etag"
RAW_DIR="${TMP_DIR}/raw"
EXTRACTED_DIR="${TMP_DIR}/metadata-plugin-modernizer-main"

# ── Dependency check ────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || { log "ERROR: 'curl' is required but not installed."; exit 1; }
command -v unzip >/dev/null 2>&1 || { log "ERROR: 'unzip' is required but not installed."; exit 1; }

# ── Cleanup trap: always remove ZIP and raw extraction dir on exit ───────────
trap 'rm -f "${ZIP_FILE}"; rm -rf "${RAW_DIR}"' EXIT

# ── Prepare temp directory ──────────────────────────────────────────────────
mkdir -p "${TMP_DIR}"

# ── ETag-based incremental download ────────────────────────────────────────
log "Checking for upstream data changes..."

CURL_ARGS=(--silent --location --fail --output "${ZIP_FILE}" --dump-header "${TMP_DIR}/.response-headers")

if [ -f "${ETAG_FILE}" ]; then
    STORED_ETAG=$(cat "${ETAG_FILE}")
    log "Found cached ETag: ${STORED_ETAG}"
    CURL_ARGS+=(--header "If-None-Match: ${STORED_ETAG}")
fi

HTTP_CODE=$(curl --write-out "%{http_code}" "${CURL_ARGS[@]}" "${ZIP_URL}" 2>/dev/null || true)

if [ "${HTTP_CODE}" = "304" ]; then
    log "Data unchanged (HTTP 304), skipping download."
    # Validate the existing extracted data is still present
    if [ -d "${EXTRACTED_DIR}" ]; then
        log "Existing extracted data verified at ${EXTRACTED_DIR}."
        rm -f "${TMP_DIR}/.response-headers"
        exit 0
    else
        log "WARN: HTTP 304 but extracted data missing. Re-downloading..."
        # Remove stale ETag so we get a fresh download
        rm -f "${ETAG_FILE}"
        HTTP_CODE=$(curl --write-out "%{http_code}" --silent --location --fail \
            --output "${ZIP_FILE}" --dump-header "${TMP_DIR}/.response-headers" \
            "${ZIP_URL}" 2>/dev/null || true)
    fi
fi

if [ "${HTTP_CODE}" = "200" ]; then
    log "Downloaded fresh data (HTTP 200)."

    # Save ETag from response headers for next time
    NEW_ETAG=$(grep -i '^etag:' "${TMP_DIR}/.response-headers" 2>/dev/null | sed 's/^[eE][tT][aA][gG]: *//;s/\r$//' | head -1)
    if [ -n "${NEW_ETAG}" ]; then
        echo "${NEW_ETAG}" > "${ETAG_FILE}"
        log "Saved ETag: ${NEW_ETAG}"
    else
        log "WARN: No ETag in response headers. Incremental caching will not work for next run."
    fi

    # Remove old extracted data
    rm -rf "${EXTRACTED_DIR}"

    # Unzip — GitHub ZIP contains a top-level directory; strip it via mv
    log "Extracting archive..."
    mkdir -p "${RAW_DIR}"
    unzip -q "${ZIP_FILE}" -d "${RAW_DIR}"
    mv "${RAW_DIR}/metadata-plugin-modernizer-main" "${EXTRACTED_DIR}"
    log "Extracted to ${EXTRACTED_DIR}"

    # Remove unnecessary files from extracted content
    log "Cleaning up non-essential files..."
    rm -rf "${EXTRACTED_DIR}/.github"
    rm -f "${EXTRACTED_DIR}/.gitignore"
    rm -f "${EXTRACTED_DIR}/README.md"
    rm -f "${EXTRACTED_DIR}/requirements.txt"
    rm -f "${EXTRACTED_DIR}/CONTRIBUTING.md"
    rm -f "${EXTRACTED_DIR}/CODE_OF_CONDUCT.md"
    rm -f "${EXTRACTED_DIR}/SECURITY.md"
    log "Cleaned up unnecessary files."

    # Clean up response headers temp file
    rm -f "${TMP_DIR}/.response-headers"
else
    log "ERROR: Failed to download data. HTTP code: ${HTTP_CODE}"
    rm -f "${TMP_DIR}/.response-headers"
    exit 1
fi

# ── Validate extracted content ──────────────────────────────────────────────
log "Validating extracted data..."

REQUIRED_PATHS=(
    "${EXTRACTED_DIR}/reports/summary.md"
    "${EXTRACTED_DIR}/reports/recipes"
)
for rpath in "${REQUIRED_PATHS[@]}"; do
    if [ ! -e "${rpath}" ]; then
        log "ERROR: Required path missing after extraction: ${rpath}"
        exit 1
    fi
done

# Count plugin directories (exclude known non-plugin dirs)
PLUGIN_COUNT=$(find "${EXTRACTED_DIR}" -maxdepth 1 -mindepth 1 -type d \
    ! -name 'reports' ! -name '.github' ! -name '.git' ! -name 'CustomHistory' | wc -l)

if [ "${PLUGIN_COUNT}" -lt 10 ]; then
    log "ERROR: Expected at least 10 plugin directories, found ${PLUGIN_COUNT}"
    exit 1
fi

log "Validation passed: ${PLUGIN_COUNT} plugin directories found."
log "Data ready in ${EXTRACTED_DIR}"
