#!/bin/zsh
# Double-click in Finder to create a verified local backup (macOS).
# Doble clic en Finder para crear una copia de seguridad verificada (macOS).
# The backup command checks integrity before reporting success. It never stops the app.

cd "${0:A:h}" || exit 1

# Finder starts a minimal shell: load the usual Node version managers if present.
[[ -d /opt/homebrew/bin ]] && export PATH="/opt/homebrew/bin:$PATH"
[[ -d /usr/local/bin ]] && export PATH="/usr/local/bin:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd --shell zsh 2>/dev/null)"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null 2>&1 || true
elif [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  # nvm reads .nvmrc, not .node-version: ask for the pinned version explicitly.
  nvm use "$(<.node-version)" >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1 || true
fi

# Messages follow the macOS language (Spanish first if the system is in Spanish).
if [[ -z "$CAREER_LANG" ]]; then
  export CAREER_LANG="$(defaults read -g AppleLanguages 2>/dev/null | tr -d ' \n"()' | cut -d, -f1)"
fi

# Note: `status` is a read-only special variable in zsh, so the exit code is kept in `exit_code`.
exit_code=0
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" != 24 ]]; then
  echo "✗ Se necesita Node.js 24 (encontrado: $(node -v 2>/dev/null || echo ninguno)). Instálalo con fnm (fnm install 24) o desde https://nodejs.org y vuelve a abrir este archivo."
  echo "  Node.js 24 is required (found: $(node -v 2>/dev/null || echo none)). Install it with fnm (fnm install 24) or from https://nodejs.org and open this file again."
  exit_code=1
else
  node scripts/backup.mjs "$@"
  exit_code=$?
fi

echo
read -r "?Pulsa Enter para cerrar · Press Enter to close " || true
exit $exit_code
