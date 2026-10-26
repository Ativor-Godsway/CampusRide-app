/**
 * A person's initials for an avatar, from their name as typed: letters only,
 * so "Kwame (test)" is "K" — not "K(" — and a word that doesn't start with a
 * letter is skipped. Any cased script counts (É, Ɛ, Ɔ), checked by case
 * rather than a Unicode regex so every JS engine agrees.
 */
export function initialsOf(name: string | null | undefined, max = 2): string {
  return (name ?? "")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .filter(isLetter)
    .slice(0, max)
    .join("")
    .toUpperCase();
}

function isLetter(char: string): boolean {
  return char !== "" && char.toLowerCase() !== char.toUpperCase();
}
