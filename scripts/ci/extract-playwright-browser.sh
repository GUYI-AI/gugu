#!/usr/bin/env bash
set -euo pipefail

# Keep the exact browser already used by this job, while building Go with the hosted C toolchain.
# The hosted Chrome installation supplies its system libraries; no package installation is needed.
docker pull "$PLAYWRIGHT_IMAGE"
container=$(docker create "$PLAYWRIGHT_IMAGE" /bin/true)
trap 'docker rm "$container" >/dev/null' EXIT
destination="$RUNNER_TEMP/gugu-media-browser"
mkdir -p "$destination"
docker cp "$container:/ms-playwright/." "$destination"
chromium=$(find "$destination" -type f -path '*/chrome-linux64/chrome' -print)
test -x "$chromium"
libraries=$(ldd "$chromium")
printf '%s\n' "$libraries"
if [[ "$libraries" == *'not found'* ]]; then exit 1; fi
# The previous root container also used --no-sandbox. Keep that isolated fixture setting on the
# host, where Ubuntu's AppArmor profile does not allow user namespaces for this temporary binary.
launcher="$destination/chromium-ci"
printf '#!/usr/bin/env bash\nexec %q --no-sandbox "$@"\n' "$chromium" > "$launcher"
chmod +x "$launcher"
echo "GUGU_TEST_CHROMIUM=$launcher" >> "$GITHUB_ENV"
