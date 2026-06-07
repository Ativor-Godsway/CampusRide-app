import "dotenv/config";

export const APP_NAME = "CampusRide";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: process.env.JWT_SECRET ?? "",
  mnotify: {
    enabled: process.env.MNOTIFY_ENABLED === "true",
    apiKey: process.env.MNOTIFY_API_KEY ?? "",
    senderId: process.env.MNOTIFY_SENDER_ID ?? "CampusRide",
  },
} as const;
