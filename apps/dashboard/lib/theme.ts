export type ThemePreference = 'system' | 'light' | 'dark';

export const themePreferences: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Reads the `theme` cookie; anything else follows the operating system. */
export function initialTheme(cookieTheme?: string): ThemePreference {
  return cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'system';
}

/** The `data-theme` attribute for <html>; absent when following the system. */
export function themeAttribute(theme: ThemePreference): 'light' | 'dark' | undefined {
  return theme === 'system' ? undefined : theme;
}

/** Applies a choice on this device without a reload and keeps it for the next visit. */
export function applyTheme(theme: ThemePreference) {
  const attribute = themeAttribute(theme);
  if (attribute) document.documentElement.dataset.theme = attribute;
  else delete document.documentElement.dataset.theme;
  document.cookie = theme === 'system'
    ? 'theme=; Path=/; Max-Age=0; SameSite=Lax'
    : `theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function currentTheme(): ThemePreference {
  return initialTheme(document.documentElement.dataset.theme);
}
