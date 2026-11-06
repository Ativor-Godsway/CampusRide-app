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
   * The apps' store listings. While a link is "" nothing is shown for that
   * store (Apple and Google allow their badges only for apps people can
   * download). Paste a listing's address here and its official badge shows on
   * the home page, linked to it. The rider links are also where
   * https://campusride.app/get (the QR code on flyers) sends phones.
   */
  stores: {
    rider: {
      appStore: "https://apps.apple.com/app/id6827157564",
      googlePlay: "",
    },
    driver: {
      appStore: "",
      googlePlay: "",
    },
    /**
     * Apple's provider ID (App Store Connect, Analytics, "Campaigns": the
     * `pt=` in a campaign link it generates). Not secret. Once set, /get adds
     * it and the visit's ?src= (as `ct=`) to the App Store link, so App Store
     * Connect counts store visits and downloads per source. While "", the App
     * Store link goes out as it is.
     */
    appleProviderToken: "",
  },
};
