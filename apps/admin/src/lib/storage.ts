/**
 * Small per-browser preferences (the last period chosen on each page).
 * Storage can be blocked (private mode); then nothing is remembered and the
 * site works the same.
 */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`campusride.admin.pref.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`campusride.admin.pref.${key}`, value);
  } catch {
    // Private mode / blocked storage: not remembered.
  }
}
