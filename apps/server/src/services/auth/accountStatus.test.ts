import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { createTestUser } from "../ride/testFixtures";
import { ACCOUNT_CACHE_TTL_MS, forgetAccount, loadActiveAccount } from "./accountStatus";
import { deleteAccount } from "./deleteAccount";

const userIds: string[] = [];
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function user() {
  const created = await createTestUser("RIDER");
  userIds.push(created.id);
  return created;
}

describe("loadActiveAccount", () => {
  it("answers with the database role, not anything the caller claims", async () => {
    const u = await user();
    expect(await loadActiveAccount(prisma, u.id)).toEqual({ userId: u.id, role: "RIDER", phone: u.phone });
  });

  it("is null for an account that doesn't exist or has been deleted", async () => {
    expect(await loadActiveAccount(prisma, "c-no-such-user")).toBeNull();
    const u = await user();
    await loadActiveAccount(prisma, u.id); // cached as open
    await deleteAccount(prisma, u.id); // which forgets it
    expect(await loadActiveAccount(prisma, u.id)).toBeNull();
  });

  it("re-reads a changed role once the cache runs out, or at once after forgetAccount", async () => {
    const u = await user();
    const t0 = Date.now();
    await loadActiveAccount(prisma, u.id, t0);
    await prisma.user.update({ where: { id: u.id }, data: { role: "ADMIN" } });

    expect((await loadActiveAccount(prisma, u.id, t0 + 1_000))!.role).toBe("RIDER");
    expect((await loadActiveAccount(prisma, u.id, t0 + ACCOUNT_CACHE_TTL_MS + 1))!.role).toBe(
      "ADMIN",
    );

    await prisma.user.update({ where: { id: u.id }, data: { role: "RIDER" } });
    forgetAccount(u.id);
    expect((await loadActiveAccount(prisma, u.id))!.role).toBe("RIDER");
  });
});
