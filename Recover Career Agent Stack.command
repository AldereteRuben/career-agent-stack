#!/bin/zsh
# Create a new sign-in code locally and copy it using the normal launcher.
# Existing sessions and workspace data are preserved.
cd "${0:A:h}" || exit 1
exec /bin/zsh "./Start Career Agent Stack.command" --recover-session "$@"
