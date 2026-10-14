import { randomUUID } from "node:crypto";
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";
import type { PushTransport } from "./pushService";

/** Records what would have gone to Expo; tickets and receipts are scripted per test. */
export function fakeTransport() {
  const sent: ExpoPushMessage[] = [];
  const receiptsById: Record<string, ExpoPushReceipt> = {};
  let ticketFor: (m: ExpoPushMessage, i: number) => ExpoPushTicket = (_m, i) => ({
    status: "ok",
    id: `rcpt-${sent.length}-${i}`,
  });
  let failSend = false;
  const transport: PushTransport = {
    async send(messages) {
      if (failSend) throw new Error("Expo is down");
      const tickets = messages.map((m, i) => ticketFor(m, i));
      sent.push(...messages);
      return tickets;
    },
    async receipts(ids) {
      return Object.fromEntries(
        ids.filter((id) => receiptsById[id]).map((id) => [id, receiptsById[id]!]),
      );
    },
  };
  return {
    transport,
    sent,
    receiptsById,
    setTickets(fn: typeof ticketFor) {
      ticketFor = fn;
    },
    failSends() {
      failSend = true;
    },
  };
}

export const newToken = () => `ExponentPushToken[test-${randomUUID()}]`;
