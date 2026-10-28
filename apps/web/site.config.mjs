/**
 * Everything about the website that is a fact rather than page copy, in one
 * place. A detail set to `null` shows on the page as a highlighted
 * [PLACEHOLDER], so a missing one is visible rather than silently blank; the
 * tests fail while any is left.
 */
export const site = {
  /** The public address. Canonical links, Open Graph and the sitemap use it. */
  url: "https://campusride.app",
  name: "CampusRide",

  /** The person who runs CampusRide and is the data controller (no company yet). */
  operatorName: "Ativor Godsway Kwabla",
  /** A postal address where letters reach the operator (a GhanaPost digital address). */
  operatorAddress: "GA-382-5351",

  supportEmail: "support@campusride.app",
  supportPhone: "+233 54 860 8146",

  /**
   * Pages marked DRAFT FOR LEGAL REVIEW: add a page's slug to show the banner
   * on it. None at the moment (the owner turned them off on 2026-10-18).
   */
  draftPages: [],

  /** How soon an emailed deletion request is completed. */
  emailDeletionDays: 30,

  /**
   * The apps' store listings. While a link is "" the page says "Coming soon
   * to the App Store and Google Play" in plain text: Apple and Google allow
   * their badges only for apps people can download. Paste a listing's address
   * here and its official badge shows on the home page, linked to it.
   */
  stores: {
    rider: {
      appStore: "",
      googlePlay: "",
    },
    driver: {
      appStore: "",
      googlePlay: "",
    },
  },
};
