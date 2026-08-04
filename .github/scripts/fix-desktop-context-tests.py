from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)

identity = ROOT / "packages/database/tests/claims-identity-presentation.test.js"
text = identity.read_text()
text = replace_once(
    text,
    '''  member_first_name: "Sbusiso",
  member_last_name: "Mdingi",
  provider_practice_name: "Dlamini Family Practice",''',
    '''  member_first_name: "Sbusiso",
  member_last_name: "Mdingi",
  member_date_of_birth: "1995-05-20",
  member_gender: "M",
  member_home_region: "Free State",
  member_join_date: "2021-01-10",
  provider_practice_name: "Dlamini Family Practice",''',
    "identity fixture member fields",
)
text = replace_once(
    text,
    '''  provider_specialty: Buffer.from("General Practitioner"),
  provider_region: "Bloemfontein",''',
    '''  provider_specialty: Buffer.from("General Practitioner"),
  provider_kind: "PRACTICE",
  provider_category: "GENERAL_PRACTITIONER",
  provider_region: "Bloemfontein",''',
    "identity fixture provider fields",
)
text = replace_once(
    text,
    '''  assert.deepEqual(claim.member, { displayName: "S. Mdingi" });
  assert.deepEqual(claim.provider, {
    displayName: "Dlamini Family Practice",
    practiceNumber: "1001",
    specialty: "General Practitioner",
    region: "Bloemfontein",
  });''',
    '''  assert.deepEqual(claim.member, {
    displayName: "Sbusiso Mdingi",
    dateOfBirth: "1995-05-20",
    gender: "M",
    homeRegion: "Free State",
    joinDate: "2021-01-10",
  });
  assert.deepEqual(claim.provider, {
    displayName: "Dlamini Family Practice",
    practiceNumber: "1001",
    specialty: "General Practitioner",
    kind: "PRACTICE",
    category: "GENERAL_PRACTITIONER",
    region: "Bloemfontein",
  });''',
    "identity expected projection",
)
identity.write_text(text)

repository = ROOT / "packages/database/tests/claims-read-repository.test.js"
text = repository.read_text()
text = replace_once(
    text,
    '''test("desktop claim changes are bounded, stable, and exclude unnecessary personal identifiers", async () => {''',
    '''test("desktop claim changes are bounded, stable, and retain operational reference identifiers", async () => {''',
    "desktop claim test name",
)
text = replace_once(
    text,
    '''  assert.equal(Object.hasOwn(result.changes[0].record, "memberId"), false);
  assert.equal(Object.hasOwn(result.changes[0].record, "providerId"), false);''',
    '''  assert.equal(result.changes[0].record.memberId, "member-3");
  assert.equal(result.changes[0].record.providerId, "provider-3");''',
    "desktop operational identifiers",
)
repository.write_text(text)

desktop_app = ROOT / "apps/desktop/src/DesktopApp.test.jsx"
text = desktop_app.read_text()
text = replace_once(
    text,
    '''    expect(screen.getByText("Showing 1 of 2 cached claims")).toBeInTheDocument();''',
    '''    expect(screen.getByText("Showing 1 of 1 matching claims · 2 cached")).toBeInTheDocument();''',
    "claims count label",
)
desktop_app.write_text(text)

context_test = ROOT / "apps/desktop/src/DesktopClaimContext.test.jsx"
text = context_test.read_text()
text = replace_once(
    text,
    '''import { render, screen, within } from "@testing-library/react";''',
    '''import { cleanup, render, screen, within } from "@testing-library/react";''',
    "desktop context cleanup import",
)
text = replace_once(
    text,
    '''import { describe, expect, it, vi } from "vitest";''',
    '''import { afterEach, describe, expect, it, vi } from "vitest";''',
    "desktop context afterEach import",
)
text = replace_once(
    text,
    '''describe("desktop claim investigation context", () => {''',
    '''afterEach(() => cleanup());

describe("desktop claim investigation context", () => {''',
    "desktop context cleanup hook",
)
context_test.write_text(text)

Path(__file__).unlink(missing_ok=True)
