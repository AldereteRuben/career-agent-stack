#!/bin/zsh
# Double-click in Finder to start Career Agent Stack locally (macOS).
# Doble clic en Finder para iniciar Career Agent Stack en este equipo (macOS).
# It reuses services that are already running, starts what is missing, waits until it answers and
# opens the browser. It never deletes data, seeds demo data or prints secrets.
# Stop what it started with: pnpm run stop

cd "${0:A:h}" || exit 1

# Finder starts a minimal shell: load the usual Node version managers if present.
[[ -d /opt/homebrew/bin ]] && export PATH="/opt/homebrew/bin:$PATH"
[[ -d /usr/local/bin ]] && export PATH="/usr/local/bin:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd --shell zsh 2>/dev/null)"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null 2>&1 || true
elif [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

# Messages follow the macOS language (Spanish first if the system is in Spanish).
if [[ -z "$CAREER_LANG" ]]; then
  export CAREER_LANG="$(defaults read -g AppleLanguages 2>/dev/null | tr -d ' \n"()' | cut -d, -f1)"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ No se encontró Node.js 24. Instálalo desde https://nodejs.org (o con fnm/nvm) y vuelve a abrir este archivo."
  echo "  Node.js 24 was not found. Install it from https://nodejs.org (or with fnm/nvm) and open this file again."
  status=1
else
  # --copy-token puts the pending single-use sign-in token on the clipboard (never shown, cleared after 2 min).
  node scripts/launch.mjs --copy-token "$@"
  status=$?
fi

if [[ $status -ne 0 ]]; then
  echo
  read -r "?Pulsa Enter para cerrar · Press Enter to close "
fi
exit $status
