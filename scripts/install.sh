#!/bin/sh
# Installs the Arcwright Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://t3.codes/install.sh | sh
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `t3 service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="unn-corp/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nt3 install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       Arcwright Code' >&2
  printf '  %s%s     %sCLI installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to validate fork release metadata"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are fork-v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='fork-v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="fork-v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index"
  version="$(python3 - "$tmp_index" "$channel" <<'PYINDEX'
import json, re, sys
rows = json.load(open(sys.argv[1]))
channel = sys.argv[2]
pattern = r"fork-v(\d+\.\d+\.\d+)" if channel == "stable" else r"fork-v(\d+\.\d+\.\d+-" + re.escape(channel) + r"\.\d+\.\d+)"
for row in rows:
    assets = row.get("assets", [])
    names = [a.get("name") for a in assets]
    if row.get("draft", True) or not row.get("published_at") or re.search(r"^<!-- t3-fork-release:withdrawn\b", row.get("body") or "", re.M): continue
    match = re.fullmatch(pattern, row.get("tag_name", ""))
    if match and names.count("fork-release.json") == 1 and names.count("SHA256SUMS") == 1:
        print(match.group(1)); break
PYINDEX
)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
python3 - "$version" <<'PYVERSION' || fail "invalid fork version"
import re, sys
assert re.fullmatch(r"\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d+\.\d+)?", sys.argv[1])
PYVERSION
# Even a cached install requires a fresh normal-release eligibility check.
tmp_eligibility="$(mktemp)"
fetch "https://api.github.com/repos/${repo}/releases/tags/fork-v${version}" "$tmp_eligibility"
python3 - "$tmp_eligibility" "$version" <<'PYELIGIBLE' || fail "fork release is withdrawn, incomplete, or unavailable"
import json, re, sys
release = json.load(open(sys.argv[1]))
assert release.get("tag_name") == "fork-v" + sys.argv[2] and not release.get("draft", True) and release.get("published_at")
assert not re.search(r"^<!-- t3-fork-release:withdrawn\b", release.get("body") or "", re.M)
names = [asset.get("name") for asset in release.get("assets", [])]
assert names.count("fork-release.json") == 1 and names.count("SHA256SUMS") == 1
PYELIGIBLE
rm -f "$tmp_eligibility"
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "t3 ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s Arcwright Code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/fork-v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "this fork release has no verified archive for ${platform}-${arch}; use a supported fork installer"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  fetch "${base_url}/fork-v${version}/fork-release.json" "${staging}/fork-release.json"
  fetch "https://api.github.com/repos/${repo}/releases/tags/fork-v${version}" "${staging}/release.json"
  python3 - "$staging" "$version" "$archive" <<'PYVERIFY' || fail "fork release is incomplete, withdrawn, or ineligible"
import json, pathlib, re, sys
folder, version, archive = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
release = json.loads((folder / "release.json").read_text())
manifest = json.loads((folder / "fork-release.json").read_text())
assert release.get("tag_name") == "fork-v" + version and not release.get("draft", True) and release.get("published_at")
assert not re.search(r"^<!-- t3-fork-release:withdrawn\b", release.get("body") or "", re.M)
assert manifest.get("format") == 1 and manifest.get("repository") == "unn-corp/t3code" and manifest.get("version") == version
assert all(manifest.get("checks", {}).get(key) is True for key in ("build", "install", "update", "recovery"))
assets = manifest.get("assets", [])
names = [item["name"] for item in assets]
assert len(names) == len(set(names))
actual = {item["name"]: item["size"] for item in release["assets"]}
assert len(actual) == len(release["assets"])
assert all(actual.get(item["name"]) == item["bytes"] and item["bytes"] > 0 for item in assets)
selected = [item for item in assets if item["name"] == archive and item["kind"] == "server"]
assert len(selected) == 1 and re.fullmatch(r"[a-f0-9]{64}", selected[0]["sha256"])
checks = {}
for line in (folder / "SHA256SUMS").read_text().splitlines():
    match = re.fullmatch(r"([a-fA-F0-9]{64})\s+\*?(.*)", line)
    if match:
        assert match[2] not in checks
        checks[match[2]] = match[1].lower()
assert checks.get(archive) == selected[0]["sha256"]
PYVERIFY
  download "${base_url}/fork-v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting Arcwright Code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS" "${staging}/fork-release.json" "${staging}/release.json"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the t3 command..."
printf '%s\n' "Manual installation does not stop or coordinate running agents. Stop all fork work before restarting any runtime." >&2
mkdir -p "$bin_dir"
ln -sfn "${target_dir}/t3" "${bin_dir}/t3"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled Arcwright Code %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %st3%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac
