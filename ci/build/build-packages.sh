#!/usr/bin/env bash
set -euo pipefail

# Given a release found in $RELEASE_PATH, generate one platform archive named
# after $ARCH and $OS and place it with its checksum in ./release-packages.

main() {
  cd "$(dirname "${0}")/../.."
  source ./ci/lib.sh

  VERSION=$(jq -r .version "$RELEASE_PATH/package.json")
  export VERSION

  mkdir -p release-packages
  release_archive
}

release_archive() {
  local release_name="code-server-$VERSION-$OS-$ARCH"
  local archive="release-packages/$release_name.tar.gz"
  if [[ $OS == "linux" || $OS == "windows" ]]; then
    tar -czf "$archive" --owner=0 --group=0 --transform "s/^$RELEASE_PATH/$release_name/" "$RELEASE_PATH"
  else
    tar -czf "$archive" -s "/^$RELEASE_PATH/$release_name/" "$RELEASE_PATH"
  fi

  node --input-type=module -e 'import { createHash } from "node:crypto"; import fs from "node:fs"; const file = process.argv[1]; fs.writeFileSync(`${file}.sha256`, `${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${file.split("/").pop()}\n`);' -- "$archive"
  echo "done (release-packages/$release_name)"
}

main "$@"
