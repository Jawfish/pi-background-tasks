#!/usr/bin/env bash
set -euo pipefail

: "${BUN:=bun}"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "$script_dir/.." && pwd)
: "${PI:=$repository_root/node_modules/.bin/pi}"
temp_dir=

cleanup() {
	if [[ -n "$temp_dir" ]]; then
		rm -rf "$temp_dir"
	fi
}

main() {
	local archive
	local package_root
	local -a expected_files=(
		LICENSE
		README.md
		core.ts
		index.ts
		package.json
		service.ts
		tui.ts
	)

	temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-background-package.XXXXXX")
	trap cleanup EXIT

	archive=$(
		cd "$repository_root"
		"$BUN" pm pack --destination "$temp_dir" --quiet | awk 'NF { line = $0 } END { print line }'
	)
	if [[ ! -f "$archive" ]]; then
		printf 'packed archive not found: %s\n' "$archive" >&2
		return 1
	fi

	printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort >"$temp_dir/expected-files"
	tar -tzf "$archive" |
		sed -e 's#^package/##' -e '/\/$/d' |
		LC_ALL=C sort >"$temp_dir/actual-files"
	diff -u "$temp_dir/expected-files" "$temp_dir/actual-files"

	mkdir "$temp_dir/unpacked" "$temp_dir/home"
	tar -xzf "$archive" -C "$temp_dir/unpacked"
	package_root="$temp_dir/unpacked/package"
	HOME="$temp_dir/home" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
		"$PI" --no-extensions --extension "$package_root" --list-models >/dev/null

	printf 'verified packed package: %s\n' "$archive"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
