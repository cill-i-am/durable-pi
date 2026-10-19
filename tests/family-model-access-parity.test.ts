import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import { familyDirectory } from "../src/family/adapters/directory"
import { familyModelAccess } from "../src/family/adapters/model-access"
import { d1 } from "./d1"

it("single-query candidate matches live authority across roles, verification, removal, reinvitation and owner changes", async () => {
  const native = new DatabaseSync(":memory:")
  try {
    for (const directory of readdirSync("migrations/auth").sort())
      native.exec(
        readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8")
      )
    native.exec(`INSERT INTO organization(id,name,slug,createdAt) VALUES('family','Family','family',1),('other','Other','other',1);
      INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Owner','OWNER@example.com',0,1,1),('person','Person','person@example.com',1,1,1),('outsider','Outside','outside@example.com',1,1,1);
      INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('admin','family','owner','owner',1),('generation-one','family','person','member',2),('outside','other','outsider','member',1);`)
    const binding = d1(native),
      prepare = vi.spyOn(binding, "prepare"),
      directory = familyDirectory(binding, "owner@example.com")
    let comparisons = 0
    const compare = async () => {
      for (const id of [undefined, "owner", "person", "outsider", "missing"]) {
        const modelOwner = await directory.owner()
        const access = modelOwner
          ? await directory.access(id ?? modelOwner.id)
          : null
        const expected =
          access && modelOwner
            ? {
                owner: access.userId,
                modelOwner: modelOwner.id,
                joinedAt: access.joinedAt,
                membershipId: access.membershipId,
              }
            : null
        prepare.mockClear()
        expect(
          await Effect.runPromise(
            familyModelAccess(binding, "owner@example.com", id)
          )
        ).toEqual(expected)
        expect(prepare).toHaveBeenCalledTimes(1)
        comparisons++
      }
    }
    await compare()
    for (const change of [
      "UPDATE user SET emailVerified=0 WHERE id='person'",
      "UPDATE member SET role='admin' WHERE userId='person'",
      "UPDATE member SET role='owner' WHERE userId='person'",
      "UPDATE user SET emailVerified=1 WHERE id='person'",
      "DELETE FROM member WHERE userId='person'",
      "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('generation-two','family','person','member',3)",
      "UPDATE member SET role='member' WHERE id='admin'",
      "UPDATE member SET role='owner' WHERE id='admin'",
      "UPDATE user SET email='former@example.com' WHERE id='owner'",
      "UPDATE user SET email='OWNER@example.com' WHERE id='owner'",
      "DELETE FROM member WHERE id='admin'",
    ]) {
      native.exec(change)
      await compare()
    }
    expect(comparisons).toBe(60)
  } finally {
    native.close()
  }
})
