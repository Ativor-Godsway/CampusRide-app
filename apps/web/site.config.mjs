/**
 * Everything about the website that is a fact rather than page copy, in one
 * place. Fill in the `null`s before launch: until then each one shows on the
 * page as a highlighted [PLACEHOLDER], so a missing detail is visible rather
 * than silently blank.
 */
export const site = {
  /** The public address. Canonical links, Open Graph and the sitemap use it. */
  url: "https://campusride.app",
  name: "CampusRide",

  /** The person who runs CampusRide and is the data controller (no company yet). */
  operatorName: null, // e.g. "Ama Kwarteng Mensah", your full legal name
  operatorAddress: null, // a postal address where you can receive letters

  supportEmail: "support@campusride.app",
  supportPhone: null, // e.g. "+233 24 123 4567"

  /**
   * Pages marked DRAFT FOR LEGAL REVIEW. Remove a page from this list once a
   * lawyer has reviewed it and the banner disappears from that page.
   */
  draftPages: ["privacy", "terms"],

  /** How soon an emailed deletion request is completed. */
  emailDeletionDays: 30,
};
