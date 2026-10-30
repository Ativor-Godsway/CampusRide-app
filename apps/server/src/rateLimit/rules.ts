import { config } from "../config";

/**
 * Every rate limit in the server, by name. Each counts hits against ONE kind
 * of subject — who or what is being limited:
 *
 *   phone   a canonical +233 number (before anyone is signed in)
 *   user    an account id (signed-in routes, sockets)
 *   session a refresh-token rotation chain (one login on one phone)
 *   ip      the client's real address — only as a backstop where nobody is signed in
 *   link    an SOS tracking token
 *   sos     one rider's SOS on one ride
 *   msisdn  a USSD subscriber
 *
 * Numbers come from config.rateLimit (env-overridable), multiplied outside
 * production. docs/security/rate-limits.md lists them.
 */
export type LimitSubject = "phone" | "user" | "session" | "ip" | "link" | "sos" | "msisdn";

export interface LimitRule {
  /** Stable id, part of every counter key. */
  name: string;
  /** What an admin sees next to it. */
  label: string;
  subject: LimitSubject;
  max: number;
  windowMs: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function buildRules(c: typeof config.rateLimit) {
  const rule = (
    name: string,
    label: string,
    subject: LimitSubject,
    max: number,
    windowMs: number,
  ): LimitRule => ({
    name,
    label,
    subject,
    max: Math.max(1, Math.round(max * c.multiplier)),
    windowMs,
  });

  return {
    otpCooldown: rule(
      "otp.cooldown",
      "One code per cooldown",
      "phone",
      1,
      c.otpCooldownSeconds * SECOND,
    ),
    otpSend15m: rule(
      "otp.send.15m",
      "Codes sent, 15 minutes",
      "phone",
      c.otpSendPer15Min,
      15 * MINUTE,
    ),
    otpSend24h: rule("otp.send.24h", "Codes sent, 24 hours", "phone", c.otpSendPer24h, 24 * HOUR),
    otpVerify15m: rule(
      "otp.verify.15m",
      "Code checks, 15 minutes",
      "phone",
      c.otpVerifyPer15Min,
      15 * MINUTE,
    ),
    adminOtpSend15m: rule(
      "otp.admin.send.15m",
      "Admin codes sent, 15 minutes",
      "phone",
      c.adminOtpSendPer15Min,
      15 * MINUTE,
    ),
    adminOtpSend24h: rule(
      "otp.admin.send.24h",
      "Admin codes sent, 24 hours",
      "phone",
      c.adminOtpSendPer24h,
      24 * HOUR,
    ),
    adminOtpVerify15m: rule(
      "otp.admin.verify.15m",
      "Admin code checks, 15 minutes",
      "phone",
      c.adminOtpVerifyPer15Min,
      15 * MINUTE,
    ),
    login15m: rule(
      "login.15m",
      "Log-ins and sign-ups, 15 minutes",
      "phone",
      c.loginPer15Min,
      15 * MINUTE,
    ),

    refreshSession: rule(
      "refresh.session.15m",
      "Token refreshes per login",
      "session",
      c.refreshPerSession15Min,
      15 * MINUTE,
    ),
    refreshUser: rule(
      "refresh.user.15m",
      "Token refreshes, 15 minutes",
      "user",
      c.refreshPerUser15Min,
      15 * MINUTE,
    ),

    userDefault: rule("user.default", "Requests, per minute", "user", c.userPerMinute, MINUTE),
    rideCreate: rule("ride.create", "Rides booked, per hour", "user", c.rideCreatePerHour, HOUR),
    rideCancel: rule("ride.cancel", "Rides cancelled, per hour", "user", c.rideCancelPerHour, HOUR),
    rideSwitch: rule(
      "ride.switch",
      "Ride type switches, 15 minutes",
      "user",
      c.rideSwitchPer15Min,
      15 * MINUTE,
    ),
    driverAccept: rule(
      "driver.accept",
      "Rides accepted, 15 minutes",
      "user",
      c.driverAcceptPer15Min,
      15 * MINUTE,
    ),
    driverDecline: rule(
      "driver.decline",
      "Ride offers declined, 15 minutes",
      "user",
      c.driverDeclinePer15Min,
      15 * MINUTE,
    ),
    rating: rule("rating", "Ratings, per hour", "user", c.ratingPerHour, HOUR),
    nearbyCars: rule(
      "ride.nearby",
      "Home map cars, 5 seconds",
      "user",
      c.nearbyCarsPer5Sec,
      5 * SECOND,
    ),
    profile: rule("profile", "Profile changes, per hour", "user", c.profilePerHour, HOUR),
    pushToken: rule(
      "push.token",
      "Notification sign-ups, 15 minutes",
      "user",
      c.pushTokenPer15Min,
      15 * MINUTE,
    ),
    upload: rule("upload", "Photo uploads, per hour", "user", c.uploadPerHour, HOUR),
    accountDelete: rule(
      "account.delete",
      "Account deletion attempts, per hour",
      "user",
      c.accountDeletePerHour,
      HOUR,
    ),
    routeLegs: rule(
      "route.legs",
      "Route drawings, 15 minutes",
      "user",
      c.routeLegsPer15Min,
      15 * MINUTE,
    ),
    paymentInit: rule(
      "payment.init",
      "Payment attempts, 15 minutes",
      "user",
      c.paymentInitPer15Min,
      15 * MINUTE,
    ),
    socketSubscribe: rule(
      "socket.subscribe",
      "Live ride subscriptions, per minute",
      "user",
      c.socketSubscribePerMinute,
      MINUTE,
    ),
    // One relayed position per window, per driver: never multiplied, so dev sees real throttling.
    driverLocation: {
      name: "socket.location",
      label: "Driver positions",
      subject: "user",
      max: 1,
      windowMs: c.driverLocationSeconds * SECOND,
    } satisfies LimitRule,
    // The same for an idle driver's position (Home map cars), counted apart
    // so it can never hold back a trip's relayed position.
    driverPosition: {
      name: "socket.position",
      label: "Driver positions (no trip)",
      subject: "user",
      max: 1,
      windowMs: c.driverLocationSeconds * SECOND,
    } satisfies LimitRule,

    trackLink: rule(
      "track.link",
      "Tracking page views, 15 minutes",
      "link",
      c.trackPerLinkPer15Min,
      15 * MINUTE,
    ),
    // Never multiplied either: it decides whether an SOS texts people again.
    sosRepeatSms: {
      name: "sos.sms",
      label: "SOS texts",
      subject: "sos",
      max: 1,
      windowMs: c.sosRepeatSmsMinutes * MINUTE,
    } satisfies LimitRule,
    ussd: rule(
      "ussd",
      "USSD keypresses, per minute",
      "msisdn",
      c.ussdPerSubscriberPerMinute,
      MINUTE,
    ),

    ipPublic: rule(
      "ip.public",
      "Requests from one IP, 15 minutes",
      "ip",
      c.ipPublicPer15Min,
      15 * MINUTE,
    ),
    ipOtpSend: rule(
      "ip.otp.send",
      "Codes requested from one IP, 15 minutes",
      "ip",
      c.ipOtpSendPer15Min,
      15 * MINUTE,
    ),
  };
}

export const RULES = buildRules(config.rateLimit);
export type RuleName = keyof typeof RULES;

/** Every rule counted against a phone number or an account — what an admin can look up and clear. */
export const PERSON_RULES: readonly LimitRule[] = Object.values(RULES).filter(
  (r) => r.subject === "phone" || r.subject === "user",
);
