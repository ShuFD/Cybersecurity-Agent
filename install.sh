#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
user_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
user_home="${user_home:-${HOME:-$repo_root}}"
install_bin="${SECHEUR_INSTALL_BIN:-$user_home/.local/bin}"
node_version="${SECHEUR_NODE_VERSION:-22.19.0}"

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

node_is_supported() {
	command -v node >/dev/null 2>&1 || return 1
	node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
	if node_is_supported; then
		return
	fi

	command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "Node.js >= 22.19.0 is required; install curl or wget to bootstrap it"
	local node_arch
	case "$(uname -m)" in
		x86_64) node_arch="x64" ;;
		aarch64|arm64) node_arch="arm64" ;;
		armv7l) node_arch="armv7l" ;;
		*) die "unsupported CPU architecture: $(uname -m)" ;;
	esac
	local node_root="$user_home/.local/share/secheur/node-v${node_version}-linux-${node_arch}"
	if [ ! -x "$node_root/bin/node" ]; then
		local parent_dir="$user_home/.local/share/secheur"
		local temp_dir
		temp_dir="$(mktemp -d)"
		trap 'rm -rf "$temp_dir"' RETURN
		local archive="$temp_dir/node.tar.gz"
		local url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.gz"
		printf 'Node.js >= 22.19.0 was not found; downloading %s\n' "$url"
		mkdir -p "$parent_dir"
		if command -v curl >/dev/null 2>&1; then
			curl --fail --location --silent --show-error "$url" --output "$archive"
		else
			wget --quiet --show-progress "$url" --output-document "$archive"
		fi
		tar -xzf "$archive" -C "$parent_dir"
		[ -x "$node_root/bin/node" ] || die "Node.js bootstrap completed but the binary was not found"
		trap - RETURN
		rm -rf "$temp_dir"
	fi
	export PATH="$node_root/bin:$PATH"
}

ensure_node
command -v npm >/dev/null 2>&1 || die "npm is not available with the selected Node.js installation"
command -v git >/dev/null 2>&1 || die "git is required"

cd "$repo_root"
printf 'Using Node.js %s\n' "$(node --version)"
npm ci --ignore-scripts
npm run build:offline

install -d "$install_bin"
ln -sfn "$repo_root/packages/secheur-agent/dist/cli.js" "$install_bin/secheur"
ln -sfn "$repo_root/packages/secheur-agent/dist/bridge-cli.js" "$install_bin/secheur-bridge"
ln -sfn "$repo_root/packages/secheur-agent/dist/protocol-cli.js" "$install_bin/secheur-server"

printf '\nSecHeur Agent installed from %s\n' "$repo_root"
printf 'Commands: %s, %s, %s\n' "$install_bin/secheur" "$install_bin/secheur-bridge" "$install_bin/secheur-server"
case ":${PATH}:" in
	*":${install_bin}:"*) ;;
	*) printf 'Add this directory to PATH: export PATH="%s:$PATH"\n' "$install_bin" ;;
esac
printf 'Run `secheur self-test` for an offline runtime check.\n'
