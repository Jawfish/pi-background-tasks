#!/usr/bin/env bash
set -euo pipefail

: "${BUN:=bun}"
: "${NODE:=node}"
: "${NPM:=npm}"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "$script_dir/.." && pwd)
: "${PI:=$repository_root/node_modules/.bin/pi}"
: "${PROVIDER:=$repository_root/integration/fixtures/headless-provider.ts}"
temp_dir=

cleanup() {
	if [[ -n "$temp_dir" ]]; then
		rm -rf "$temp_dir"
	fi
}

main() {
	local archive
	local package_root
	local packed_output
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
		LC_ALL=C sort >"$temp_dir/bun-files"
	diff -u "$temp_dir/expected-files" "$temp_dir/bun-files"

	(
		cd "$repository_root"
		"$NPM" pack --dry-run --ignore-scripts --json >"$temp_dir/npm-pack.json"
	)
	"$NODE" -e \
		'const result = require(process.argv[1]); for (const file of result[0].files.map(({ path }) => path).sort()) console.log(file);' \
		"$temp_dir/npm-pack.json" >"$temp_dir/npm-files"
	diff -u "$temp_dir/expected-files" "$temp_dir/npm-files"

	mkdir "$temp_dir/unpacked" "$temp_dir/home"
	tar -xzf "$archive" -C "$temp_dir/unpacked"
	package_root="$temp_dir/unpacked/package"
	packed_output=$(
		HOME="$temp_dir/home" \
			PI_BG_HEADLESS_COMMAND="printf headless-output" \
			PI_OFFLINE=1 \
			PI_SKIP_VERSION_CHECK=1 \
			"$PI" \
			--print \
			--offline \
			--no-session \
			--no-extensions \
			--no-skills \
			--no-prompt-templates \
			--no-themes \
			--no-context-files \
			--extension "$PROVIDER" \
			--extension "$package_root" \
			--provider pi-background-tasks-headless-test \
			--model faux-1 \
			--thinking off \
			--tools background_task \
			"Run the packed background task" \
			2>"$temp_dir/pi-stderr"
	)
	if [[ "$packed_output" != "Headless completion handled" ]]; then
		printf 'unexpected packed Pi output: %s\n' "$packed_output" >&2
		return 1
	fi
	if [[ -s "$temp_dir/pi-stderr" ]]; then
		cat "$temp_dir/pi-stderr" >&2
		return 1
	fi

	printf 'verified packed package: %s\n' "$archive"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
