#!/bin/bash

set -euo pipefail

# Install Node.js + pnpm via corepack. Cloud envs may already have node;
# if not, fall back to nvm or apt. Adjust to your provisioning system.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found; install Node.js (>=20) before running this script." >&2
  exit 1
fi
corepack enable
corepack prepare pnpm@latest --activate

workdir="benchmark"
mkdir -p "$workdir"

shopt -s nullglob
zip_files=(../*.zip ./*.zip)
if [ "${#zip_files[@]}" -eq 0 ]; then
  echo "No zip package found in current directory or parent directory." >&2
  exit 1
fi

package_zip="${zip_files[0]}"
cp "$package_zip" "$workdir/"

cd "$workdir"
package_name="$(basename "$package_zip")"
unzip -o "$package_name"

run_all_path="$(find . -path '*/prior-v2/run-all.sh' | head -n 1)"
if [ -z "$run_all_path" ]; then
  echo "Cannot find prior-v2/run-all.sh in extracted package." >&2
  exit 1
fi

package_dir="$(dirname "$(dirname "$run_all_path")")"
project_root="$(dirname "$(dirname "$package_dir")")"
run_all_from_root="${run_all_path#./}"

cd "$project_root"

pnpm install
chmod +x "./$run_all_from_root"
"./$run_all_from_root"
