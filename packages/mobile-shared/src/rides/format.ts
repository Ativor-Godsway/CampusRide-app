/**
 * Fares are formatted in ONE place, @rida/shared's formatCedis ("GH₵5"),
 * shared with the admin site. Re-exported here so app screens keep importing
 * their UI helpers from @rida/mobile-shared.
 */
export { formatCedis, spokenCedis } from "@rida/shared";
